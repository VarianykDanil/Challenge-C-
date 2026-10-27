/**
 * `npm run setup-code -- <email>`: a one-time setup code for someone, from the server itself.
 *
 * For anyone who cannot sign in because they have not finished setting up (no two-step verification yet, or an
 * administrator reset their PIN) and has no working code: the only administrator, someone whose code ran out, an
 * account from before setup codes existed. The code is printed once, works once and for 7 days; any older unused code
 * stops working. It does not sign anyone out and writes an audit row (never the code).
 *
 * Works while Linear Hub is running (it waits up to five seconds for the server). DB_PATH is honoured, like npm start.
 * Exit codes: 0 done, or no code needed; 1 no email given, no database, no one with that email, or they have left.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setupCodeExpiryText } from '@lm/shared';
import { get, openDb, type Db } from './db/connection.ts';
import { createSchema } from './db/schema.ts';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { recordAudit } from './lib/audit.ts';
import { issueSetupCode, needsSetupCode } from './lib/setupCodes.ts';
import { isTwoFactorEnabled } from './lib/twofactor.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const email = process.argv.slice(2).find((a) => !a.startsWith('-'))?.trim();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!email) {
  console.log('Usage: npm run setup-code -- <email>\n');
  console.log('Prints a one-time setup code for that person: with their email and employee ID it lets them sign in once');
  console.log('to finish setting up (two-step verification, and a PIN when one is required). For example:');
  console.log('  npm run setup-code -- jo.bloggs@example.com');
  process.exit(1);
}
if (!existsSync(dbPath)) fail(`There is no database at ${dbPath}. Run this where Linear Hub runs, with DB_PATH set the same way.`);

let db: Db | undefined;
try {
  db = openDb(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  if (!get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`)) {
    db.close();
    fail(`${dbPath} is not a Linear Hub database (it has no people in it). Check DB_PATH.`);
  }
} catch {
  try {
    db?.close();
  } catch {
    // nothing more to do
  }
  fail(`${dbPath} is not a Linear Hub database (it could not be opened as SQLite). Check DB_PATH.`);
}
createSchema(db); // the setup-code table, as the next start would add it; never the demo-account steps

const person = get<{ id: number; name: string; email: string; employeeId: string; status: string }>(
  db,
  `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email, employee_id AS employeeId, status FROM users WHERE lower(email) = lower(?)`,
  [email],
);
if (!person) {
  db.close();
  fail(`No one in ${dbPath} has the email ${email}. Check the spelling: it is the email they sign in with.`);
}
if (person.status === 'left') {
  db.close();
  fail(`${person.name} (${person.email}) has left, so they cannot sign in. Make them active again in Team first.`);
}
const twoFactorOn = isTwoFactorEnabled(db, person.id);
if (!needsSetupCode(db, person.id, { twoFactorEnabled: twoFactorOn, demoSignIn: false })) {
  db.close();
  console.log(`${person.name} (${person.email}) already has two-step verification on, so they sign in without a setup code.`);
  console.log(`If they lost their phone and their recovery codes: npm run 2fa:reset -- ${person.email}`);
  process.exit(0);
}

const issued = issueSetupCode(db, person.id, { createdBy: null, reason: 'command' });
recordAudit(db, {
  userId: null,
  action: 'npm run setup-code',
  entity: 'user',
  entityId: person.id,
  summary: `Gave a setup code from the server command: ${person.name}`,
  after: { setupCode: 'issued' },
});
db.close();

console.log(`One-time setup code for ${person.name} (${person.email}): ${issued.code}`);
console.log(`It works once, until ${setupCodeExpiryText(issued.expiresAt).replace(/^Valid until /, '')}. Any older code for them no longer works.`);
console.log(`They sign in with their email, their employee ID (${person.employeeId}) and this code, then finish setting up.`);
