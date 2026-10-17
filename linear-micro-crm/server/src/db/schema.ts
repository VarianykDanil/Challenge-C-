import { GAUGE_MAX_PER_DAY } from '@lm/shared';
import type { Db } from './connection.ts';

/** One gauge column: a whole number between 0 and the daily plausibility ceiling (CHECK constraints on new databases). */
const gaugeCol = (name: string) => `${name} INTEGER NOT NULL DEFAULT 0 CHECK (${name} >= 0 AND ${name} <= ${GAUGE_MAX_PER_DAY})`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  leader_id INTEGER,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  base_per_day REAL NOT NULL DEFAULT 0,
  commission_per_sale REAL NOT NULL DEFAULT 0,
  bonus_threshold INTEGER NOT NULL DEFAULT 0,
  bonus_amount REAL NOT NULL DEFAULT 0,
  override_per_team_sale REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL,
  position TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  pay_plan_id INTEGER NOT NULL REFERENCES pay_plans(id),
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  phone TEXT,
  avatar_color TEXT NOT NULL,
  city TEXT,
  totp_secret_enc TEXT,
  totp_pending_enc TEXT,
  totp_enabled_at TEXT,
  totp_last_counter INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sector TEXT NOT NULL,
  type TEXT NOT NULL,
  payout_per_sale REAL NOT NULL,
  rep_commission_per_sale REAL NOT NULL,
  color TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  city TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  target_sales INTEGER NOT NULL DEFAULT 10,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_team_date ON events(team_id, date);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id);

CREATE TABLE IF NOT EXISTS gauge_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  ${gaugeCol('stops')},
  ${gaugeCol('table_count')},
  ${gaugeCol('presentations')},
  ${gaugeCol('closes')},
  ${gaugeCol('taps')},
  ${gaugeCol('sales')},
  checked_in_at TEXT,
  notes TEXT,
  submitted_at TEXT NOT NULL,
  payout_per_sale REAL,
  commission_per_sale REAL,
  UNIQUE(event_id, user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_gauges_user_date ON gauge_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_gauges_date ON gauge_entries(date);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  days_worked INTEGER NOT NULL DEFAULT 0,
  sales INTEGER NOT NULL DEFAULT 0,
  team_sales INTEGER NOT NULL DEFAULT 0,
  base_pay REAL NOT NULL DEFAULT 0,
  commission REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  overrides REAL NOT NULL DEFAULT 0,
  deductions REAL NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL,
  paid_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reference TEXT NOT NULL UNIQUE,
  adjusted_at TEXT,
  UNIQUE(user_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_payroll_week ON payroll_runs(week_start);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  source TEXT NOT NULL DEFAULT 'other',
  stage TEXT NOT NULL DEFAULT 'applied',
  position_applied TEXT NOT NULL DEFAULT 'trainee',
  applied_at TEXT NOT NULL,
  stage_updated_at TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referred_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER,
  notes TEXT,
  next_action TEXT,
  next_action_at TEXT,
  hired_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates(stage);

CREATE TABLE IF NOT EXISTS stage_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage_changes_candidate ON stage_changes(candidate_id);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  interviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_interviews_candidate ON interviews(candidate_id);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS two_factor_challenges (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Fills the money-rate snapshot on gauge rows that have none (rows seeded or written before the columns existed) from
 * the campaign payout and the person's current pay plan — the best available approximation of "the rate when the
 * sale was logged". Rows written by the API carry the real snapshot. Returns the number of rows filled.
 */
export const BACKFILL_GAUGE_RATES_SQL = `
  UPDATE gauge_entries SET
    payout_per_sale = COALESCE(payout_per_sale, (SELECT c.payout_per_sale FROM events e JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = gauge_entries.event_id)),
    commission_per_sale = COALESCE(commission_per_sale, (SELECT pp.commission_per_sale FROM users u JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.id = gauge_entries.user_id))
  WHERE payout_per_sale IS NULL OR commission_per_sale IS NULL`;

export function backfillGaugeRates(db: Db): number {
  return Number(db.prepare(BACKFILL_GAUGE_RATES_SQL).run().changes);
}

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a database
 * created before the column existed is upgraded here with a guarded `ALTER TABLE … ADD COLUMN` (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`) followed by the column's `backfill` statement when it has one. Every entry must be
 * nullable or carry a default so existing rows stay valid. CHECK constraints cannot be added to an existing table,
 * so the gauge ceilings are also enforced in code (`lib/validate.ts`, `validateGaugeFunnel`).
 */
const COLUMN_UPGRADES: { table: string; column: string; ddl: string; backfill?: string }[] = [
  { table: 'users', column: 'totp_secret_enc', ddl: 'TEXT' },
  { table: 'users', column: 'totp_pending_enc', ddl: 'TEXT' },
  { table: 'users', column: 'totp_enabled_at', ddl: 'TEXT' },
  { table: 'users', column: 'totp_last_counter', ddl: 'INTEGER' },
  { table: 'gauge_entries', column: 'payout_per_sale', ddl: 'REAL', backfill: BACKFILL_GAUGE_RATES_SQL },
  { table: 'gauge_entries', column: 'commission_per_sale', ddl: 'REAL', backfill: BACKFILL_GAUGE_RATES_SQL },
  { table: 'payroll_runs', column: 'adjusted_at', ddl: 'TEXT' },
];

export function tableColumns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Adds the missing columns from `COLUMN_UPGRADES` (and runs their backfills); returns their names. Idempotent. */
export function upgradeSchema(db: Db): string[] {
  const added: string[] = [];
  const known = new Map<string, Set<string>>();
  const backfills = new Set<string>();
  for (const u of COLUMN_UPGRADES) {
    if (!known.has(u.table)) known.set(u.table, new Set(tableColumns(db, u.table)));
    const cols = known.get(u.table)!;
    if (cols.has(u.column)) continue;
    db.exec(`ALTER TABLE ${u.table} ADD COLUMN ${u.column} ${u.ddl}`);
    cols.add(u.column);
    added.push(`${u.table}.${u.column}`);
    if (u.backfill) backfills.add(u.backfill);
  }
  for (const sql of backfills) db.prepare(sql).run();
  return added;
}

/** Creates every table and index that is missing, then brings older tables up to date. Safe to run on every start. */
export function createSchema(db: Db): string[] {
  db.exec(SCHEMA_SQL);
  return upgradeSchema(db);
}

export function isSeeded(db: Db): boolean {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'seeded_at'`).get() as { value: string } | undefined;
  return Boolean(row?.value);
}
