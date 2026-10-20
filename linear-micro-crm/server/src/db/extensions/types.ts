/**
 * Release 1.2 (r2-foundation): the contract for database extensions. Each 1.2 package that needs tables or columns owns
 * one file in this folder (learning.ts L1, pitches.ts L2, pin.ts U1, audit.ts U3, checkins.ts U4) exporting
 *
 *   export const extension: DbExtension = { name, sql, upgrade, seed? };
 *
 * and nothing else in the database layer changes: `createSchema` (db/schema.ts) runs every extension's `sql` and then
 * its `upgrade` after the core schema, on every start; `seed` (db/seed.ts) calls every extension's `seed` at the end of a
 * fresh demo seed, inside the seed's transaction. The list and its order live in ./index.ts (foundation-owned).
 *
 * Rules for extension authors
 *  - `sql`: `CREATE TABLE IF NOT EXISTS …` / `CREATE INDEX IF NOT EXISTS …` statements only; idempotent, safe on every
 *    start. Never alter or drop a core table here.
 *  - `upgrade(db)`: columns added to EXISTING tables (core or your own) with `addColumnIfMissing`, plus one-off data
 *    steps an existing (already seeded) database needs, guarded so they run once (e.g. a `meta` key
 *    `ext:<name>:<step>`). Returns the names of what it changed (e.g. `users.pin_hash`); createSchema reports them as
 *    `<extension name>:<name>`. A second run must return []. Every added column is nullable or has a default.
 *  - `seed(db, ctx)`: demo rows for a FRESH seed only (an existing database never runs it). Use `ctx.rng(salt)` for
 *    randomness — never the core seed's generator, so the core demo data stays byte-for-byte the same. Never insert a
 *    gauge_entries or payroll_runs row (a stray gauge row pays a day's base). Read business time from ctx.today /
 *    ctx.nowIso, never `new Date()`.
 *  - Never import db/schema.ts or db/seed.ts from an extension (import cycle); the helpers below cover column checks.
 */
import type { EventStatus, EventType, Position, Role, UserStatus } from '@lm/shared';
import type { Db } from '../connection.ts';
import { Rng } from '../../lib/prng.ts';

/** One person of the demo seed (only the fields extensions need). */
export interface SeedUserRef {
  id: number;
  employeeId: string;
  firstName: string;
  lastName: string;
  role: Role;
  position: Position;
  teamId: number | null;
  status: UserStatus;
  startDate: string;
}

export interface SeedTeamRef {
  id: number;
  name: string;
  leaderId: number | null;
}

export interface SeedCampaignRef {
  id: number;
  /** e.g. "BCN" (Breast Cancer Now). */
  code: string;
  name: string;
}

export interface SeedEventRef {
  id: number;
  teamId: number;
  campaignId: number;
  type: EventType;
  date: string;
  startTime: string;
  endTime: string;
  status: EventStatus;
}

/** What `seed` passes to every extension: the rows it just created and the business clock it used. */
export interface SeedContext {
  /** The business date the demo was built around (YYYY-MM-DD). */
  today: string;
  /** The business clock at seed time (ISO timestamp). */
  nowIso: string;
  users: readonly SeedUserRef[];
  teams: readonly SeedTeamRef[];
  campaigns: readonly SeedCampaignRef[];
  events: readonly SeedEventRef[];
  /** A deterministic random stream of the extension's own (mulberry32 seeded with `salt`): same seed, same rows. */
  rng(salt: number): Rng;
}

export interface DbExtension {
  /** Short, unique, stable: 'learning', 'pitches', 'pin', 'audit', 'checkins'. */
  name: string;
  /** CREATE … IF NOT EXISTS statements ('' when the extension has no tables yet). */
  sql: string;
  /** Idempotent upgrades of existing databases; returns what changed (see the rules above). */
  upgrade(db: Db): string[];
  /** Demo rows for a fresh seed (optional). */
  seed?(db: Db, ctx: SeedContext): void;
}

/** The column names of `table` ([] when the table does not exist). */
export function columnsOf(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/**
 * `ALTER TABLE … ADD COLUMN` when the column is missing (SQLite has no ADD COLUMN IF NOT EXISTS). `ddl` is the type and
 * constraint, e.g. 'TEXT' or "INTEGER NOT NULL DEFAULT 0". Returns `table.column` when it was added, else null.
 */
export function addColumnIfMissing(db: Db, table: string, column: string, ddl: string): string | null {
  if (columnsOf(db, table).includes(column)) return null;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return `${table}.${column}`;
}

/** True once `key` is in `meta` (for one-off upgrade steps). */
export function metaFlag(db: Db, key: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM meta WHERE key = ?`).get(key));
}

/** Records `key` in `meta` with the given value (default: '1'). */
export function setMetaFlag(db: Db, key: string, value = '1'): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** A per-extension random stream for `SeedContext.rng`. */
export function extensionRng(salt: number): Rng {
  return new Rng((20240227 ^ Math.imul(salt | 0, 2654435761)) >>> 0);
}
