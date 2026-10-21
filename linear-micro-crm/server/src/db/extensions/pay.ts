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
 * Rules: ./types.ts. Paid runs never change; corrections go to the next unpaid week as adjustment lines.
 */
import type { DbExtension } from './types.ts';
import { addColumnIfMissing } from './types.ts';

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
`;

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
    ].filter((name): name is string => name !== null);
  },
};
