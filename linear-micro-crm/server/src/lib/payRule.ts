/**
 * Release 1.3 — the pay rule on the server — OWNED BY P1 pay-rule (laid down by r3-foundation; every export below is
 * STABLE: other packages call them). P1 replaces the stub bodies, and also owns lib/pay.ts, db/maintenance.ts,
 * routes/finance.ts, db/queries.ts (payroll section) and the pay sections of db/seed.ts / seed-data.ts in 1.3.
 *
 *  - payRuleSettings(db): day rate (meta `ext:pay:day_rate`, default £63.50) and PAY_RULE_FROM (meta
 *    `ext:pay:rule_from`; until P1 writes it, the Monday of today).
 *  - weekPayBreakdown(db, userId, weekStart): the week under the 1.3 rule, with every line (P2 builds invoice lines from
 *    it; GET /pay/breakdown answers it). Stub: null.
 *  - applyConfirmedSales(db, rows, opts): P3 calls it when a statement is applied (opts.dryRun for the preview).
 *    Recomputes unpaid weeks; a paid week's difference becomes a pay_adjustments row on the person's next unpaid run;
 *    idempotent per statement. Stub: applies nothing.
 *  - campaignRateOn(db, campaignId, date) / listCampaignRates(db, campaignId): the campaign_rates history.
 *  - addCampaignRate(db, input, actorId): P6 calls it when Matt approves a client's commission change (unpaid weeks
 *    from that date recalculate). Stub: 501.
 *  - recordCampaignRateChange(db, campaignId, before, after, actorId): called by routes/campaigns.ts after an admin
 *    creates a campaign or edits its rates, so the history follows the Campaigns form. Stub: does nothing.
 */
import {
  PAY_DAY_RATE_DEFAULT,
  type ApplyConfirmedSalesOptions,
  type ApplyResult,
  type Campaign,
  type CampaignRate,
  type CampaignRateInput,
  type ConfirmedSalesRow,
  type PayRuleSettings,
  type WeekPayBreakdown,
} from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import { mondayOf, todayISO } from './dates.ts';
import { HttpError } from './errors.ts';

const metaValue = (db: Db, key: string): string | null => get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null;

/** The pay rule's settings (Settings → Pay). */
export function payRuleSettings(db: Db): PayRuleSettings {
  const rate = Number(metaValue(db, 'ext:pay:day_rate'));
  return {
    dayRate: Number.isFinite(rate) && rate > 0 ? rate : PAY_DAY_RATE_DEFAULT,
    ruleFrom: metaValue(db, 'ext:pay:rule_from') ?? mondayOf(todayISO()),
  };
}

/** STUB (P1): one person's pay week under the 1.3 rule. */
export function weekPayBreakdown(db: Db, userId: number, weekStart: string): WeekPayBreakdown | null {
  void db;
  void userId;
  void weekStart;
  return null;
}

/** STUB (P1): apply a statement's confirmed subs to pay (or preview it with dryRun). */
export function applyConfirmedSales(db: Db, rows: readonly ConfirmedSalesRow[], opts: ApplyConfirmedSalesOptions): ApplyResult {
  void db;
  void rows;
  return { statementId: opts.statementId, dryRun: Boolean(opts.dryRun), applied: false, people: [], totalDifference: 0 };
}

/** STUB (P1): the rate in effect for a campaign on a date (latest effective_from ≤ date). */
export function campaignRateOn(db: Db, campaignId: number, date: string): CampaignRate | null {
  void db;
  void campaignId;
  void date;
  return null;
}

/** STUB (P1): a campaign's rate history, newest first. */
export function listCampaignRates(db: Db, campaignId: number): CampaignRate[] {
  void db;
  void campaignId;
  return [];
}

/** STUB (P1): add a rate row (admin entry, or a client's commission change Matt approved). */
export function addCampaignRate(db: Db, input: CampaignRateInput, actorId: number | null): CampaignRate {
  void db;
  void input;
  void actorId;
  throw new HttpError(501, 'Campaign rate history is not available yet');
}

/** STUB (P1): routes/campaigns.ts calls this after POST /campaigns (before = null) and PATCH /campaigns/:id. */
export function recordCampaignRateChange(db: Db, campaignId: number, before: Campaign | null, after: Campaign, actorId: number | null): void {
  void db;
  void campaignId;
  void before;
  void after;
  void actorId;
}
