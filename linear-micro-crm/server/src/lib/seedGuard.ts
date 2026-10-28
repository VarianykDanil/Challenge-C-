/**
 * `npm run seed` deletes the database and builds the demo again, so it only does that to a database with nothing of
 * the office's own in it:
 *  - never one that has gone live (trial mode off) or was never the demo;
 *  - never one that holds people of the office's own (anyone but the demo company and the starter team the seed
 *    makes again; a starter account of the office's own file counts as theirs once it has been used);
 *  - never while Linear Hub has it open;
 *  - and only after START AGAIN is typed (or --confirm "START AGAIN") and a backup of it has passed its check.
 * A missing database is simply seeded. The server itself never makes a new demo database where backups show there was
 * one (missingDatabaseRefusal): a wrong DB_PATH must not quietly start a new demo company.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { all, get, openDb, type Db } from '../db/connection.ts';
import { resetAndSeed, type SeedStats } from '../db/seed.ts';
import { backupDirFor, backupNow, foldersOutsideBackup, inspectDatabase, listBackups } from './backup.ts';
import { backupVideos } from './backupFiles.ts';
import { runningRefusal, typedConfirmation } from './commandLine.ts';
import { demoTeamMarkers } from './demoTeams.ts';
import { demoPeopleIds, isTrialMode } from './trialMode.ts';

export const SEED_CONFIRM_WORDS = 'START AGAIN';

/** Why this database must not be seeded again, or null when it may (after the confirmation and the backup). */
export function seedRefusal(db: Db, file: string): string | null {
  if (!get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`)) {
    return 'It is not a Linear Hub database (it has no people table), so npm run seed did not touch it. Check DB_PATH.';
  }
  if (!get(db, `SELECT 1 FROM users LIMIT 1`)) return null;
  if (!isTrialMode(db)) {
    return 'This database has gone live (or never was the demo): npm run seed would delete everything in it, so nothing was changed.\n' +
      `To try the demo, use another database: DB_PATH=${path.join(path.dirname(path.resolve(file)), 'demo.sqlite')} npm run seed`;
  }
  // the demo company, and the starter accounts the seed makes again; an account of the office's own starter file
  // (not one of the demo company) that has signed in or changed anything has real history, so it counts as theirs
  const demo = new Set(demoPeopleIds(db));
  const demoCompany = new Set(demo);
  for (const m of demoTeamMarkers(db)) for (const a of m.accounts) demo.add(a.id);
  const used = get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'`)
    ? new Set(all<{ id: number }>(db, `SELECT DISTINCT user_id AS id FROM audit_log WHERE user_id IS NOT NULL`).map((r) => r.id))
    : new Set<number>();
  for (const id of [...demo]) if (!demoCompany.has(id) && used.has(id)) demo.delete(id);
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
    const refusal = seedRefusal(db, file);
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
      // a whole backup, like the nightly one: the database and the uploaded files
      const files = { folders: foldersOutsideBackup(file), includeVideos: backupVideos() };
      const backup = await backupNow(db, { dir: backupDirFor(file), secretFile, files, rotate: false });
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

/**
 * Why the server must not make a new demo database at `dbPath`, or null. There is no file there, but the backups folder
 * it would use holds a backup with people in it: DB_PATH is probably wrong, or the database was moved or deleted. A new
 * demo company there would look like the office's data had vanished (or take real work by mistake), so the server
 * stops and says how to restore. `npm run seed` still makes a demo database on purpose.
 */
export function missingDatabaseRefusal(dbPath: string): string | null {
  if (existsSync(dbPath)) return null;
  const dir = backupDirFor(dbPath);
  for (const b of listBackups(dir).slice(0, 3)) {
    const people = inspectDatabase(b.path).summary?.users ?? 0;
    if (!people) continue;
    return [
      `There is no database at ${dbPath}, but ${dir} holds backups of one (the newest, ${b.name}, has ${people} people).`,
      'DB_PATH may be wrong, or the database file was moved or deleted, so Linear Hub did not make a new demo company there.',
      '  - Check DB_PATH (and LM_BACKUP_DIR), then start again.',
      `  - To put the newest backup back: npm run restore -- ${b.name}`,
      '  - To make a new demo database here on purpose: npm run seed',
    ].join('\n');
  }
  return null;
}
