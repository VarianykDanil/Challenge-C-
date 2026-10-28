/**
 * Release 1.3 — OWNED BY P1 pay-rule (laid down by r3-foundation: the tables and columns below are the contract other
 * packages build on; P1 adds its data steps, seed rows and any further column, always with addColumnIfMissing).
 *
 *  - campaign_rates: each campaign's rate history (decision 3: the client sets its own rate per sub). The rep rate in
 *    effect on a sale's date is the row with the latest effective_from ≤ that date. P1 seeds one 'seed' row per campaign
 *    from campaigns.rep_commission_per_sale / payout_per_sale (upgrade for an existing database, seed for a fresh one).
 *    P6's approval of a client's commission change adds a 'client' row through lib/payRule.ts addCampaignRate.
 *  - pay_adjustments: money added to or taken off a person's run for an UNPAID week (target_week_start): manual bonuses
 *    (kind 'bonus'), corrections of paid weeks after a statement (kind 'cancellation' / 'statement', P3 via
 *    applyConfirmedSales), dispute settlements (kind 'dispute', P2) and manual lines (kind 'manual').
 *  - sale_confirmations: the subs a client's statement confirmed per (person, campaign, pay week); one row per key,
 *    the latest statement wins (statement_id). Until a row exists the week uses the logged sales.
 *  - payroll_runs columns: paid_as ('base' | 'commission'), sales_logged, sales_confirmed, sales_cancelled,
 *    adjustments_total — NULL on runs calculated by the 1.2 plan rules (queries.ts leaves them out of the payload).
 *  - meta: `ext:pay:rule_from` (PAY_RULE_FROM, the Monday of the week the upgrade first runs; a fresh demo seed uses the
 *    new rule for all history) and `ext:pay:day_rate` (default 63.5) — written by P1.
 *  - Which days count for pay:
 *    · pay_day_checks (MON-1, lib/payDays.ts): a leader's or the office's decision on a day logged with gauges —
 *      'confirmed' (a base day) or 'not_worked' — with who, when and why; source 'leader' / 'office' (by hand),
 *      'logged' (a leader or the office logged the gauges for the person) or 'before' (the day already had gauges when
 *      the check started: kept as it was). meta `ext:pay:day_checks` = 'on' once the check applies (set by the upgrade
 *      of an existing database, the end of a fresh demo seed, or the first gauge write).
 *    · staff_absences (MON-8, lib/staffDays.ts): weekdays an office person was away (holiday, sick, unpaid, other);
 *      users.leaving_date: their last working day. Neither is ever paid.
 * Rules: ./types.ts. Paid runs never change; corrections go to the next unpaid week as adjustment lines.
 */
import { mondayOf, nowISO, todayISO } from '../../lib/dates.ts';
import { PAY_DAY_CHECKS_SQL, ensureDayChecks } from '../../lib/payDays.ts';
import type { Db } from '../connection.ts';
import type { DbExtension } from './types.ts';
import { addColumnIfMissing } from './types.ts';

/** MON-8: the weekdays an office person was away (lib/staffDays.ts; never paid). */
const STAFF_ABSENCES_SQL = `
CREATE TABLE IF NOT EXISTS staff_absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('holiday', 'sick', 'unpaid', 'other')),
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_staff_absences_user ON staff_absences(user_id, date);`;

const SQL = `
CREATE TABLE IF NOT EXISTS campaign_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  rep_rate REAL NOT NULL,
  payout_rate REAL NOT NULL,
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  approved_by INTEGER,
  client_post_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_rates_campaign ON campaign_rates(campaign_id, effective_from);

CREATE TABLE IF NOT EXISTS pay_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_week_start TEXT NOT NULL,
  source_week_start TEXT,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  campaign_id INTEGER,
  statement_id INTEGER,
  invoice_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_adjustments_target ON pay_adjustments(user_id, target_week_start);
CREATE INDEX IF NOT EXISTS idx_pay_adjustments_statement ON pay_adjustments(statement_id);

CREATE TABLE IF NOT EXISTS sale_confirmations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  confirmed INTEGER NOT NULL,
  statement_id INTEGER,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, campaign_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_sale_confirmations_week ON sale_confirmations(week_start);
CREATE INDEX IF NOT EXISTS idx_pay_adjustments_source ON pay_adjustments(user_id, source_week_start);
${PAY_DAY_CHECKS_SQL}
${STAFF_ABSENCES_SQL}
`;

/** meta keys (lib/payWeek.ts reads them). */
export const PAY_RULE_FROM_KEY = 'ext:pay:rule_from';
export const PAY_DAY_RATE_KEY = 'ext:pay:day_rate';

/**
 * P1's data steps for an EXISTING database (each guarded; nothing on an empty one — the demo seed writes its own):
 *  - PAY_RULE_FROM = the Monday of the week the upgrade first runs (`ext:pay:rule_from`), so every week already worked
 *    keeps the 1.2 plan rules and the new rule starts with the week in progress;
 *  - one 'seed' rate row per campaign that has none, from its current rep commission and payout per sale, effective
 *    from its start date (so the history covers every sale it already has).
 * Payroll runs are never touched here: the first week under the new rule has no run yet.
 */
function dataSteps(db: Db): string[] {
  const changed: string[] = [];
  if (!db.prepare(`SELECT 1 FROM users LIMIT 1`).get()) return changed; // a fresh install: the demo seed sets both
  // A setting, recorded like an extension flag (not reported as a changed row): GET /pay/settings shows it.
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`).run(PAY_RULE_FROM_KEY, mondayOf(todayISO()));
  const rates = db.prepare(
    `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at)
     SELECT c.id, c.rep_commission_per_sale, c.payout_per_sale, c.start_date, 'seed', NULL, NULL, ?
     FROM campaigns c WHERE NOT EXISTS (SELECT 1 FROM campaign_rates r WHERE r.campaign_id = c.id)`,
  ).run(nowISO());
  if (Number(rates.changes) > 0) changed.push('campaign_rates.seed');
  // MON-1: base days need evidence from now on; every day that already has gauges keeps counting. Like PAY_RULE_FROM
  // above, switching a rule on is not reported as a changed row (the kept days are bookkeeping, nothing is recalculated)
  ensureDayChecks(db);
  return changed;
}

export const extension: DbExtension = {
  name: 'pay',
  sql: SQL,
  upgrade(db) {
    return [
      addColumnIfMissing(db, 'payroll_runs', 'paid_as', 'TEXT'),
      addColumnIfMissing(db, 'payroll_runs', 'sales_logged', 'INTEGER'),
      addColumnIfMissing(db, 'payroll_runs', 'sales_confirmed', 'INTEGER'),
      addColumnIfMissing(db, 'payroll_runs', 'sales_cancelled', 'INTEGER'),
      addColumnIfMissing(db, 'payroll_runs', 'adjustments_total', 'REAL'),
      // P1: the week as it was calculated (lines, per campaign, paid as) — a paid run keeps it as paid
      addColumnIfMissing(db, 'payroll_runs', 'breakdown_json', 'TEXT'),
      // MON-8: an office person's last working day (days after it are never paid)
      addColumnIfMissing(db, 'users', 'leaving_date', 'TEXT'),
      ...dataSteps(db),
    ].filter((name): name is string => name !== null);
  },
  seed(db, ctx) {
    // MON-1: the demo's history counts as it was seeded; days logged from now on need evidence
    ensureDayChecks(db, [], ctx.nowIso);
  },
};
