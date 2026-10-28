/**
 * `npm run pin:reset -- <email>`: clear one person's sign-in PIN and its lock, from the server itself.
 *
 * For when nobody can do it in the app: the only administrator's own PIN is locked or forgotten (an administrator
 * cannot reset their own PIN in the app), or the app secret was lost, so no PIN matches any more (PINs are peppered
 * with it). It clears the PIN, the wrong-PIN count and the lock, signs the person out on every device and writes an
 * audit row ("Linear Hub", action `npm run pin:reset`). They then sign in with their email and employee ID and choose
 * a new PIN. Two-step verification is left as it is. As after a reset in the app, their next sign-in needs the one-time
 * setup code this prints (7 days, single use).
 *
 * Works while Linear Hub is running (SQLite allows the one small write; it waits up to five seconds for the server).
 * DB_PATH is honoured, like npm start (default server/data/linear.sqlite). Exit codes: 0 done, or nothing to reset;
 * 1 no email given, no database (or a file that is not a Linear Hub database), or no one with that email.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { get, openDb, type Db } from './db/connection.ts';
import { createSchema } from './db/schema.ts';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { recordAudit } from './lib/audit.ts';
import { userSnapshot } from './lib/auditSpecs.ts';
import { setupCodeExpiryText } from '@lm/shared';
import { pinRow, readSecuritySettings, resetPinAndSignOut } from './lib/pin.ts';
import { issueSetupCode, requireSetupCodeAtNextSignIn } from './lib/setupCodes.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const email = process.argv.slice(2).find((a) => !a.startsWith('-'))?.trim();

if (!email) {
  console.log('Usage: npm run pin:reset -- <email>\n');
  console.log('Clears that person’s sign-in PIN and its lock and signs them out on every device. They then sign in');
  console.log('with their email and employee ID and choose a new PIN. For example:');
  console.log('  npm run pin:reset -- jo.bloggs@example.com');
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
createSchema(db); // the PIN columns, as the next start of the server would add them; never the demo-account steps (UpgradeOptions)

const person = get<{ id: number; name: string; email: string }>(
  db,
  `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email FROM users WHERE lower(email) = lower(?)`,
  [email],
);
if (!person) {
  db.close();
  console.error(`No one in ${dbPath} has the email ${email}. Check the spelling: it is the email they sign in with.`);
  process.exit(1);
}

const row = pinRow(db, person.id);
if (!row?.hash && !row?.failures && !row?.lockedUntil) {
  db.close();
  console.log(`${person.name} (${person.email}) has no PIN, so there was nothing to reset. They sign in with their email and employee ID.`);
  process.exit(0);
}

const before = userSnapshot(db, person.id);
const signedOut = resetPinAndSignOut(db, person.id);
// as after a reset in the app: their next sign-in needs a one-time setup code, printed below
requireSetupCodeAtNextSignIn(db, person.id);
const issued = issueSetupCode(db, person.id, { createdBy: null, reason: 'reset_pin' });
recordAudit(db, {
  userId: null,
  action: 'npm run pin:reset',
  entity: 'user',
  entityId: person.id,
  summary: `Reset PIN from the server command: ${person.name}`,
  before,
  after: userSnapshot(db, person.id),
});
const required = readSecuritySettings(db).requirePin;
db.close();

const devices = `${signedOut} device${signedOut === 1 ? '' : 's'}`;
console.log(`Reset the sign-in PIN of ${person.name} (${person.email}) and signed them out on ${devices}.`);
console.log(`Their one-time setup code: ${issued.code} (it works once; ${setupCodeExpiryText(issued.expiresAt).replace(/^Valid/, 'valid')}).`);
console.log(
  `They sign in with their email, employee ID and this code, then ${required ? 'create a new PIN straight away (a PIN is required for everyone)' : 'can set a new PIN in Settings → Security'}.`,
);
