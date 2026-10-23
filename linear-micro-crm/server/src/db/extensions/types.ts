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
 *  - ORDER ON A FRESH INSTALL: index.ts and resetAndSeed both call createSchema(db) BEFORE seed(db), so on a new
 *    database every `upgrade()` runs on EMPTY core tables (no users, campaigns or events yet), and `seed()` runs after.
 *    A data step in `upgrade` therefore must:
 *      (a) skip, WITHOUT setting its meta flag, when the rows it needs are missing (e.g. no BCN campaign yet); set the
 *          flag only after the step has run against those rows;
 *      (b) write with `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` on a unique key, so the step and `seed()` never
 *          conflict and a later start that runs the step on a freshly seeded database inserts nothing;
 *      (c) report a name only when it actually inserted or changed rows (`.run().changes > 0`), so the first restart
 *          after a fresh seed still returns [] (r2-contracts.test.ts checks this).
 *    Rows that both an existing and a fresh database need go in BOTH `upgrade` (existing) and `seed` (fresh).
 *  - `seed(db, ctx)`: demo rows for a FRESH seed only (an existing database never runs it). Use `ctx.rng(salt)` for
 *    randomness — never the core seed's generator, so the core demo data stays byte-for-byte the same: never insert,
 *    update or delete a row of a core table (r2-contracts.test.ts hashes every core table, seeded with and without the
 *    extension seeds; your own `ext:%` keys in `meta` are allowed). Never insert a gauge_entries or payroll_runs row
 *    (a stray gauge row pays a day's base). Read business time from ctx.today / ctx.nowIso, never `new Date()`.
 *  - Never import db/schema.ts or db/seed.ts from an extension (import cycle); the helpers below cover column checks.
 *
 * Release 1.3 (r3-foundation) adds seven extensions (pay P1, invoices P2, statements P3, videos P5, client P6,
 * recruitment P7, venues P8) and two rules:
 *  - The foundation laid down each 1.3 extension's tables and columns (its `sql` and `upgrade`); they are the contract
 *    other packages build on. The owner may ADD columns (addColumnIfMissing in `upgrade`, so a database created at the
 *    foundation commit upgrades too) and tables, but never renames or drops what the foundation created.
 *  - `seed` may UPDATE the columns ITS OWN extension added to a core table, on core rows (e.g. client.ts filling
 *    campaigns.long_description, invoices.ts filling users.address_line1 for the demo people). Every other rule above
 *    stands: no inserts or deletes of core rows, no change to a core column. r2/r3-contracts.test.ts hash the core
 *    columns only (the columns SCHEMA_SQL and the core column upgrades create), so such a seed passes.
 *  - The one core-row insert the plan asks for: client.ts (P6) may insert `announcements` rows AUTHORED BY a client
 *    account (ctx.clients) for its published demo posts; the contract tests leave those rows out of the hash.
 *  - Core demo rows the plan asks for are written by the CORE seed (db/seed.ts), never by an extension's `seed`: the demo
 *    client account (foundation) and the 1.3 pay plans, payroll runs, bonuses and cancellations (P1, who owns
 *    db/seed.ts's pay sections and seed-data.ts PAY_PLANS in 1.3). Two 1.3.1 `upgrade` steps add demo accounts to an
 *    OLDER demo database with the seed's own functions (sapiens.ts: lib/demoTeams.ts addDemoTeams; client.ts:
 *    lib/client.ts insertDemoClientAccounts), only while lib/demoTeams.ts demoStepAllowed says it is still the demo.
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

/** Release 1.3: a client portal account of the demo seed (role 'client'); never in `users`. */
export interface SeedClientRef {
  id: number;
  /** The access code, e.g. "CL-0001". */
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  campaignId: number;
}

/** What `seed` passes to every extension: the rows it just created and the business clock it used. */
export interface SeedContext {
  /** The business date the demo was built around (YYYY-MM-DD). */
  today: string;
  /** The business clock at seed time (ISO timestamp). */
  nowIso: string;
  /** The staff (every role but `client`), as before 1.3. */
  users: readonly SeedUserRef[];
  /** Release 1.3: the demo client accounts (P6 seeds their posts). */
  clients: readonly SeedClientRef[];
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
