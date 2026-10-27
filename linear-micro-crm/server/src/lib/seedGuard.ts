/**
 * `npm run seed` deletes the database and builds the demo again, so it only does that to a database with nothing of
 * the office's own in it:
 *  - never one that has gone live (trial mode off) or was never the demo;
 *  - never one that holds people of the office's own (anyone but the demo company and the starter team the seed
 *    makes again);
 *  - never while Linear Hub has it open;
 *  - and only after START AGAIN is typed (or --confirm "START AGAIN") and a backup of it has passed its check.
 * A missing database is simply seeded.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { all, get, openDb, type Db } from '../db/connection.ts';
import { resetAndSeed, type SeedStats } from '../db/seed.ts';
import { backupDirFor, backupNow, inspectDatabase } from './backup.ts';
import { runningRefusal, typedConfirmation } from './commandLine.ts';
import { demoTeamMarkers } from './demoTeams.ts';
import { demoPeopleIds, isTrialMode } from './trialMode.ts';

export const SEED_CONFIRM_WORDS = 'START AGAIN';

/** Why this database must not be seeded again, or null when it may (after the confirmation and the backup). */
export function seedRefusal(db: Db): string | null {
  if (!get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`)) {
    return 'It is not a Linear Hub database (it has no people table), so npm run seed did not touch it. Check DB_PATH.';
  }
  if (!get(db, `SELECT 1 FROM users LIMIT 1`)) return null;
  if (!isTrialMode(db)) {
    return 'This database has gone live (or never was the demo): npm run seed would delete everything in it, so nothing was changed.\n' +
      'To try the demo, use another database: DB_PATH=server/data/demo.sqlite npm run seed';
  }
  const demo = new Set(demoPeopleIds(db));
  for (const m of demoTeamMarkers(db)) for (const a of m.accounts) demo.add(a.id);
  const own = all<{ id: number; name: string }>(db, `SELECT id, TRIM(first_name || ' ' || last_name) AS name FROM users ORDER BY id`).filter((p) => !demo.has(p.id));
  if (own.length) {
    const names = own.slice(0, 5).map((p) => p.name || '(no name)').join(', ') + (own.length > 5 ? ` and ${own.length - 5} more` : '');
    return `This trial database holds people of your own (${names}): npm run seed would delete them, so nothing was changed.\n` +
      'Go live with npm run golive instead (it keeps them), or move the database file away yourself if you really mean to start again.';
  }
  return null;
}

/** The seed command: refuses, or backs up and seeds. Returns the exit code. */
export async function runSeedCommand(file: string, args: readonly string[], port: number, log = console.log, warn = console.error): Promise<number> {
  const started = performance.now();
  const done = (stats: SeedStats) => {
    log(`Seeded ${file} in ${Math.round(performance.now() - started)}ms`);
    console.table(stats);
    return 0;
  };
  if (!existsSync(file)) return done(resetAndSeed(file));

  const busy = await runningRefusal(file, port);
  if (busy) {
    warn(busy);
    return 1;
  }
  let db: Db;
  try {
    db = openDb(file);
  } catch {
    warn(`${file} is not a Linear Hub database (it could not be opened as SQLite), so npm run seed did not touch it. Check DB_PATH.`);
    return 1;
  }
  try {
    const refusal = seedRefusal(db);
    if (refusal) {
      warn(refusal);
      return 1;
    }
    const people = Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users`)?.n ?? 0);
    if (people > 0) {
      const refused = await typedConfirmation(args, SEED_CONFIRM_WORDS, `npm run seed deletes ${file} and builds the demo again (a backup is made first).`);
      if (refused) {
        warn(refused);
        return 1;
      }
      const secretFile = process.env.LM_APP_SECRET ? null : process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(file), 'app-secret');
      const backup = await backupNow(db, { dir: backupDirFor(file), secretFile, rotate: false });
      const check = inspectDatabase(backup.path);
      if (!check.ok || check.summary?.users !== people) {
        warn(`Nothing was changed: the backup failed its check (${check.problems.join(' ') || 'it does not hold the same people'}).`);
        return 1;
      }
      log(`Backed up to ${backup.path} (checked).`);
    }
  } finally {
    db.close();
  }
  return done(resetAndSeed(file));
}
