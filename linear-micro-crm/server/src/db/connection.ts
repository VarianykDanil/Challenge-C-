import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
/** Values accepted by the helpers below; booleans and undefined are normalised for SQLite. */
export type Param = SQLInputValue | boolean | undefined;

/** How long a write waits for another connection's lock (a backup, a command-line tool) before it gives up. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens the database with the settings every connection needs:
 *  - WAL, so readers never wait for the writer;
 *  - busy_timeout, so a save waits for another process's short write lock instead of failing at once;
 *  - synchronous=FULL, so a commit is on the disk before it is acknowledged (with NORMAL a power cut on the laptop
 *    could roll back the last saves).
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  return db;
}

function normalise(params: Param[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export function all<T>(db: Db, sql: string, params: Param[] = []): T[] {
  return db.prepare(sql).all(...normalise(params)) as unknown as T[];
}

export function get<T>(db: Db, sql: string, params: Param[] = []): T | undefined {
  return db.prepare(sql).get(...normalise(params)) as unknown as T | undefined;
}

export function run(db: Db, sql: string, params: Param[] = []): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...normalise(params));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

const savepointDepth = new WeakMap<Db, number>();

/**
 * Runs `fn` as one unit: everything it writes is kept, or none of it. Safe to nest: inside a transaction that is
 * already open (an outer transaction() or a caller's own BEGIN) it uses a SAVEPOINT, so the inner block never commits
 * or ends the outer one, and a throw undoes only the inner block's writes.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (!db.isTransaction) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  const depth = (savepointDepth.get(db) ?? 0) + 1;
  savepointDepth.set(db, depth);
  const name = `lm_sp_${depth}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    // undo this block's writes and drop the savepoint; the outer transaction stays open
    if (db.isTransaction) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    }
    throw err;
  } finally {
    savepointDepth.set(db, depth - 1);
  }
}

/** Build `col IN (?, ?, …)` placeholders. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
