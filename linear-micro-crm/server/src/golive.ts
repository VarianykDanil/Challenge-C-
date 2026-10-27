/**
 * `npm run golive`: end the trial. Run it on the computer that runs Linear Hub, with Linear Hub stopped.
 *
 * It refuses while the database is open (Linear Hub running on any port, or as a background service), shows what goes
 * and what stays, asks for the first owner's details when no administrator of the office's own would be left, and asks
 * you to type GO LIVE. Then it backs the database up (and checks the backup) before removing the demo company
 * (lib/goLive.ts), switches trial mode off for good and prints the owner's one-time setup code. Running it again on a
 * live database changes nothing.
 *
 * Flags (for scripts; in a terminal it asks instead): --confirm "GO LIVE", --owner-email, --owner-first-name,
 * --owner-last-name. DB_PATH, PORT, LM_BACKUP_DIR and LM_APP_SECRET_FILE are read as npm start reads them.
 * Exit codes: 0 live (now or already); 1 refused or cancelled, nothing changed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setupCodeExpiryText } from '@lm/shared';
import { get, openDb, type Db } from './db/connection.ts';
import { createSchema } from './db/schema.ts';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { backupDirFor, backupNow, inspectDatabase } from './lib/backup.ts';
import { findPortHolder } from './lib/boot.ts';
import { ask, flagValue, runningRefusal, stopHint, typedConfirmation } from './lib/commandLine.ts';
import { goLive, ownerProblem, planGoLive, type GoLiveOwnerInput } from './lib/goLive.ts';
import { isTrialMode } from './lib/trialMode.ts';
import { installedServiceFile } from './service.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const port = Number(process.env.PORT ?? 4000);
const args = process.argv.slice(2);
const WORDS = 'GO LIVE';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run golive [-- --confirm "GO LIVE" --owner-email you@example.com --owner-first-name Sam --owner-last-name Smith]\n');
  console.log('Removes the demo company, keeps your settings and your own people, and ends the trial for good.');
  console.log('Stop Linear Hub first. It backs the database up before it changes anything.');
  process.exit(0);
}
if (!existsSync(dbPath)) fail(`There is no database at ${dbPath}. Run this where Linear Hub runs, with DB_PATH set the same way.`);

const busy = await runningRefusal(dbPath, port);
if (busy) fail(busy);

let db: Db;
try {
  db = openDb(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  if (!get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`)) {
    db.close();
    fail(`${dbPath} is not a Linear Hub database (it has no people in it). Check DB_PATH.`);
  }
} catch {
  fail(`${dbPath} is not a Linear Hub database (it could not be opened as SQLite). Check DB_PATH.`);
}
createSchema(db); // the columns, as the next start would add them; never the demo-account steps

if (!isTrialMode(db)) {
  db.close();
  console.log('Linear Hub is already live: there is no demo company to remove. Nothing was changed.');
  console.log('To help someone sign in: npm run setup-code -- <their email>.');
  process.exit(0);
}

// ── what goes and what stays ──
const plan = planGoLive(db);
const list = (people: { name: string; employeeId: string; role: string }[], max = 10) => {
  const shown = people.slice(0, max).map((p) => `    ${p.name || '(no name)'} (${p.employeeId}, ${p.role})`);
  return people.length > max ? [...shown, `    … and ${people.length - max} more`] : shown;
};
const records = Object.entries(plan.removeRecords)
  .map(([t, n]) => `${n} ${t.replace('_', ' ')}`)
  .join(', ');
console.log(`Going live changes ${dbPath}.\n`);
console.log(`It removes the demo company: ${plan.removePeople.length} demo people and their history${records ? `, and ${records}` : ''}.`);
console.log('The one-tap demo accounts go even if you renamed them: anyone on your network could open them.');
for (const line of list(plan.removePeople, 6)) console.log(line);
console.log('\nIt keeps your settings (pay plans, payment connections, security settings), your own people and everything made');
console.log('in the app since the demo was set up.');
if (plan.keepPeople.length) {
  console.log(`  ${plan.keepPeople.length} of your own:`);
  for (const line of list(plan.keepPeople)) console.log(line);
} else {
  console.log('  No people of your own yet.');
}
console.log('');

// ── the first owner, when no administrator of the office's own would be left ──
let owner: GoLiveOwnerInput | undefined;
if (plan.ownerNeeded) {
  const flags = { email: flagValue(args, 'owner-email'), firstName: flagValue(args, 'owner-first-name'), lastName: flagValue(args, 'owner-last-name') };
  if (flags.email && flags.firstName) {
    owner = { email: flags.email, firstName: flags.firstName, lastName: flags.lastName ?? '' };
  } else if (process.stdin.isTTY) {
    console.log('No administrator of your own would be left, so this makes the first owner (you).');
    owner = {
      firstName: (await ask('  Owner’s first name: ')) ?? '',
      lastName: (await ask('  Owner’s last name: ')) ?? '',
      email: (await ask('  Owner’s sign-in email: ')) ?? '',
    };
  } else {
    db.close();
    fail(
      'Nothing was changed: no administrator of your own would be left, so going live makes the first owner. Add their details:\n' +
        '  --owner-email you@example.com --owner-first-name Sam --owner-last-name Smith',
    );
  }
  const problem = ownerProblem(db, owner, plan);
  if (problem) {
    db.close();
    fail(`Nothing was changed: ${problem}`);
  }
}

const refused = await typedConfirmation(args, WORDS, 'This cannot be undone in the app (a backup is made first).');
if (refused) {
  db.close();
  fail(refused);
}

// ── backup first, checked ──
const people = Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users`)!.n);
const secretFile = process.env.LM_APP_SECRET ? null : process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
let backupPath: string;
try {
  const backup = await backupNow(db, { dir: backupDirFor(dbPath), secretFile, rotate: false });
  const check = inspectDatabase(backup.path);
  if (!check.ok || check.summary?.users !== people) throw new Error(check.problems.join(' ') || 'it does not hold the same people');
  backupPath = backup.path;
} catch (err) {
  db.close();
  fail(`Nothing was changed: the backup failed its check (${err instanceof Error ? err.message : String(err)}).`);
}
console.log(`Backed up to ${backupPath} (checked).`);

// someone may have started Linear Hub while the question was on screen (this command holds the file open itself now)
if (await findPortHolder(port)) {
  db.close();
  fail(`Something started listening on port ${port} meanwhile, so nothing was changed (the backup above is kept).\n${stopHint()}`);
}

const result = goLive(db, { owner });
db.close();

const removed = Object.values(result.removedRecords).reduce((a, b) => a + (b ?? 0), 0);
console.log(`\nLinear Hub is live. Removed ${result.removedPeople} demo people and ${removed} demo records. The one-tap demo sign-ins are gone for good.`);
if (result.owner) {
  const o = result.owner;
  console.log(`\nThe first owner: ${o.name} (${o.email}), employee ID: ${o.employeeId}`);
  console.log(`Their one-time setup code: ${o.setupCode} (it works once; ${setupCodeExpiryText(o.expiresAt).replace(/^Valid/, 'valid')}).`);
  console.log('Sign in with that email, the employee ID and the setup code, then set up two-step verification.');
  console.log('The code is shown only here: keep it to yourself.');
}
if (result.notSetUp.length) {
  const n = result.notSetUp.length;
  console.log(`\n${n} ${n === 1 ? 'person has' : 'people have'} not finished setting up. Give each a setup code: Team → the person → Sign-in details,`);
  console.log('or on this computer: npm run setup-code -- <their email>.');
}
console.log(installedServiceFile() ? '\nStart it again: npm run service:install' : '\nStart it again: npm start');
