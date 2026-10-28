/**
 * Release 1.4 (package S): `npm run 2fa:reset -- <email>` — switch one person's two-step verification off from the
 * server itself, like `npm run pin:reset` for the PIN.
 *
 * Two-step verification is now required for every account (the demo sign-in accounts aside), so this is the way back
 * in when nobody can do it in the app: the only administrator lost their phone and their recovery codes, or the app
 * secret was lost (the authenticator secrets are encrypted with it, so no code matches any more; recovery codes still
 * work). It clears the secret, any setup half done, the recovery codes and open sign-in challenges, signs the person out
 * on every device and writes an audit row ("Linear Hub", action `npm run 2fa:reset`; the snapshot says only
 * `twoFactor: false`, never a secret). They then sign in with their email, employee ID and the one-time setup code this
 * prints (and PIN) and set two-step up again before they can carry on. The PIN is left as it is.
 *
 * Works while Linear Hub is running (SQLite allows the one small write; it waits up to five seconds for the server).
 * DB_PATH is honoured, like npm start (default server/data/linear.sqlite). Exit codes: 0 done, or nothing to reset;
 * 1 no email given, no database (or a file that is not a Linear Hub database), or no one with that email.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { get, openDb, run, type Db } from './db/connection.ts';
import { createSchema } from './db/schema.ts';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { recordAudit } from './lib/audit.ts';
import { userSnapshot } from './lib/auditSpecs.ts';
import { setupCodeExpiryText } from '@lm/shared';
import { issueSetupCode } from './lib/setupCodes.ts';
import { clearTwoFactor } from './lib/twofactor.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const email = process.argv.slice(2).find((a) => !a.startsWith('-'))?.trim();

if (!email) {
  console.log('Usage: npm run 2fa:reset -- <email>\n');
  console.log('Switches off that person’s two-step verification and signs them out on every device. They then sign in');
  console.log('with their email and employee ID and set it up again with a new code. For example:');
  console.log('  npm run 2fa:reset -- someone@example.test');
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`There is no database at ${dbPath}. Run this where Linear Hub runs, with DB_PATH set the same way.`);
  process.exit(1);
}

let db: Db | undefined;
let isLinearHub: boolean;
try {
  db = openDb(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  isLinearHub = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'`)!.n > 0;
} catch {
  // not SQLite at all (a random file, a folder, a copy cut short): say so plainly rather than print a stack trace
  try {
    db?.close();
  } catch {
    // nothing more to do
  }
  console.error(`${dbPath} is not a Linear Hub database (it could not be opened as SQLite). Check DB_PATH.`);
  process.exit(1);
}
if (!isLinearHub) {
  db.close();
  console.error(`${dbPath} is not a Linear Hub database (it has no people in it). Check DB_PATH.`);
  process.exit(1);
}
createSchema(db); // the columns, as the next start of the server would add them; never the demo-account steps

const person = get<{ id: number; name: string; email: string; on: number; pending: number }>(
  db,
  `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email, (totp_enabled_at IS NOT NULL) AS "on", (totp_pending_enc IS NOT NULL) AS pending
   FROM users WHERE lower(email) = lower(?)`,
  [email],
);
if (!person) {
  db.close();
  console.error(`No one in ${dbPath} has the email ${email}. Check the spelling: it is the email they sign in with.`);
  process.exit(1);
}
if (!person.on && !person.pending) {
  db.close();
  console.log(`${person.name} (${person.email}) has no two-step verification, so there was nothing to reset.`);
  process.exit(0);
}

const before = userSnapshot(db, person.id);
clearTwoFactor(db, person.id);
const signedOut = run(db, `DELETE FROM sessions WHERE user_id = ?`, [person.id]).changes;
// their email and employee ID alone no longer start an account: the one-time setup code printed below does
const issued = issueSetupCode(db, person.id, { createdBy: null, reason: 'reset_2fa' });
recordAudit(db, {
  userId: null,
  action: 'npm run 2fa:reset',
  entity: 'user',
  entityId: person.id,
  summary: `Reset two-step verification from the server command: ${person.name}`,
  before,
  after: userSnapshot(db, person.id),
});
db.close();

const devices = `${signedOut} device${signedOut === 1 ? '' : 's'}`;
console.log(`Reset the two-step verification of ${person.name} (${person.email}) and signed them out on ${devices}.`);
console.log(`Their one-time setup code: ${issued.code} (it works once; ${setupCodeExpiryText(issued.expiresAt).replace(/^Valid/, 'valid')}).`);
console.log('They sign in with their email, employee ID and this code (and PIN), then set it up again with a new authenticator code.');
