import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
/** Values accepted by the helpers below; booleans and undefined are normalised for SQLite. */
export type Param = SQLInputValue | boolean | undefined;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
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

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Build `col IN (?, ?, …)` placeholders. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
