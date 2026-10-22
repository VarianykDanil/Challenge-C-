/**
 * Release 1.3 — OWNED BY P1 pay-rule. This package's audit specs, in the shape of lib/auditSpecs.ts (AuditRouteSpec:
 * method, pattern, before, after → AuditDraft[]), registered through ./registry.ts (P9 owns the registry). Every write
 * route of routes/pay.ts has one: PUT /pay/settings, POST /pay/rates, POST /pay/bonuses, POST /pay/adjustments,
 * DELETE /pay/adjustments/:id. A bonus or adjustment also records the pay run it moved (recalculated or created), so a
 * payslip's history explains its figures; a settings change or a new rate records one summary row for the unpaid runs
 * it recalculated ("Recalculated 37 unpaid pay runs after the pay settings change: £X → £Y in all"). The automatic
 * takeover of a dated rate is recorded by db/maintenance.ts (recordSystemEvent). Snapshots hold no PIN, password,
 * secret, token or code.
 */
import { auditMoney, auditWeekLabel, type PayAdjustment } from '@lm/shared';
import { all, get, type Db } from '../../db/connection.ts';
import { payrollSnapshot, type AuditDraft, type AuditRouteSpec } from '../auditSpecs.ts';
import { mondayOf } from '../dates.ts';
import { payRuleSettings } from '../payWeek.ts';

type Snap = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const isoDay = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const signed = (n: number) => (n < 0 ? `−${auditMoney(-n)}` : auditMoney(n));

/** The person's name for a summary. */
function personName(db: Db, userId: number | null): string {
  if (!userId) return 'Someone';
  const u = get<{ name: string }>(db, `SELECT first_name || ' ' || last_name AS name FROM users WHERE id = ?`, [userId]);
  return u?.name ?? 'Someone';
}

/** The run for (user, week), if any: the pay run a bonus or adjustment moves. */
function runFor(db: Db, userId: number | null, week: string | null): Snap | null {
  if (!userId || !week) return null;
  const r = get<{ id: number }>(db, `SELECT id FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, mondayOf(week)]);
  return r ? payrollSnapshot(db, Number(r.id)) : null;
}

const adjustmentSnap = (a: PayAdjustment | Snap | null): Snap | null => {
  if (!a) return null;
  const { id, userId, targetWeekStart, sourceWeekStart, kind, amount, note, campaignId, statementId, invoiceId, createdBy } = a as Snap;
  return { id, userId, targetWeekStart, sourceWeekStart, kind, amount, note, campaignId, statementId, invoiceId, createdBy };
};

const ADJ_SNAP = `
  SELECT a.id, a.user_id AS userId, a.target_week_start AS targetWeekStart, a.source_week_start AS sourceWeekStart, a.kind,
         a.amount, a.note, a.campaign_id AS campaignId, a.statement_id AS statementId, a.invoice_id AS invoiceId, a.created_by AS createdBy
  FROM pay_adjustments a WHERE a.id = ?`;

/** The run a write moved, when its figures changed (created, recalculated or removed). */
function runDraft(db: Db, before: Snap | null, userId: number | null, week: string | null, why: string): AuditDraft[] {
  const after = runFor(db, userId, week);
  if (!before && !after) return [];
  if (before && after && before.gross === after.gross && before.bonus === after.bonus) return [];
  const run = (after ?? before)!;
  const who = `${String(run.userName ?? 'Someone')} ${auditWeekLabel(String(run.weekStart))}`;
  const summary = !before
    ? `Pay run created ${why}: ${who}, ${auditMoney(Number(run.gross))}`
    : !after
      ? `Pay run removed ${why}: ${who} (was ${auditMoney(Number(before.gross))})`
      : `Recalculated ${why}: ${who}, ${auditMoney(Number(before.gross))} → ${auditMoney(Number(after.gross))}`;
  return [{ entity: 'payroll_run', entityId: toId(run.id), summary, before, after }];
}

/** Every unpaid run's gross by id: what a recalculation is measured against. */
function unpaidRuns(db: Db): Map<number, number> {
  return new Map(all<{ id: number; gross: number }>(db, `SELECT id, gross FROM payroll_runs WHERE status IN ('pending', 'failed')`).map((r) => [Number(r.id), Number(r.gross)]));
}

/** One summary row for the unpaid runs a write recalculated (none when nothing moved). */
function recalculatedDraft(db: Db, before: Map<number, number> | undefined, why: string): AuditDraft[] {
  if (!before) return [];
  const after = unpaidRuns(db);
  let count = 0;
  let from = 0;
  let to = 0;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) === after.get(id)) continue;
    count++;
    from += before.get(id) ?? 0;
    to += after.get(id) ?? 0;
  }
  if (!count) return [];
  const round = (n: number) => Math.round(n * 100) / 100;
  return [{
    entity: 'payroll_run',
    entityId: null,
    summary: `Recalculated ${count} unpaid pay run${count === 1 ? '' : 's'} after ${why}: ${auditMoney(round(from))} → ${auditMoney(round(to))} in all`,
    before: { runs: count, total: round(from) },
    after: { runs: count, total: round(to) },
  }];
}

interface SettingsState {
  settings: Snap;
  runs: Map<number, number>;
}

interface AdjustState {
  run: Snap | null;
  userId: number | null;
  week: string | null;
}

function adjustmentAdded(label: (a: Snap, who: string) => string, weekKey: 'weekStart' | 'targetWeekStart'): AuditRouteSpec<AdjustState> {
  return {
    method: 'POST',
    pattern: weekKey === 'weekStart' ? '/pay/bonuses' : '/pay/adjustments',
    before(db, call) {
      const body = isRecord(call.body) ? call.body : {};
      const userId = toId(body.userId);
      const week = isoDay(body[weekKey]);
      return { run: runFor(db, userId, week), userId, week };
    },
    after(db, done, state) {
      const a = isRecord(done.response) ? done.response : null;
      if (!a) return [];
      const userId = toId(a.userId);
      const who = personName(db, userId);
      const drafts: AuditDraft[] = [{ entity: 'pay_adjustment', entityId: toId(a.id), summary: label(a, who), before: null, after: adjustmentSnap(a) }];
      return [...drafts, ...runDraft(db, state?.run ?? null, userId, String(a.targetWeekStart ?? state?.week ?? ''), a.kind === 'bonus' ? 'after a bonus' : 'after an adjustment')];
    },
  };
}

interface RemoveState {
  adjustment: Snap | null;
  run: Snap | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  {
    method: 'PUT',
    pattern: '/pay/settings',
    before: (db): SettingsState => ({ settings: { ...payRuleSettings(db) } as Snap, runs: unpaidRuns(db) }),
    after(db, _done, state: SettingsState | undefined) {
      const before = state?.settings;
      const after = { ...payRuleSettings(db) } as Snap;
      if (!before || (before.dayRate === after.dayRate && before.ruleFrom === after.ruleFrom)) return [];
      const parts: string[] = [];
      if (before.dayRate !== after.dayRate) parts.push(`day rate ${auditMoney(Number(before.dayRate))} → ${auditMoney(Number(after.dayRate))}`);
      if (before.ruleFrom !== after.ruleFrom) parts.push(`base-or-commission rule from ${auditWeekLabel(String(before.ruleFrom))} → ${auditWeekLabel(String(after.ruleFrom))}`);
      return [
        { entity: 'settings', entityId: null, summary: `Changed pay settings: ${parts.join('; ')}`, before, after },
        ...recalculatedDraft(db, state?.runs, 'the pay settings change'),
      ];
    },
  } satisfies AuditRouteSpec<SettingsState>,
  {
    method: 'POST',
    pattern: '/pay/rates',
    before: (db): Map<number, number> => unpaidRuns(db),
    after(db, done, runs: Map<number, number> | undefined) {
      const r = isRecord(done.response) ? done.response : null;
      if (!r) return [];
      const c = get<{ code: string }>(db, `SELECT code FROM campaigns WHERE id = ?`, [toId(r.campaignId)]);
      const summary = `Added a rate for ${c?.code ?? 'a campaign'}: ${auditMoney(Number(r.repRate))} a sub to the rep, ${auditMoney(Number(r.payoutRate))} payout, from ${String(r.effectiveFrom)}`;
      return [{ entity: 'campaign_rate', entityId: toId(r.id), summary, before: null, after: r }, ...recalculatedDraft(db, runs, 'the rate change')];
    },
  } satisfies AuditRouteSpec<Map<number, number>>,
  adjustmentAdded((a, who) => `Added a bonus: ${who} ${auditWeekLabel(String(a.targetWeekStart))}, ${auditMoney(Number(a.amount))}${a.note ? ` — ${String(a.note)}` : ''}`, 'weekStart'),
  adjustmentAdded((a, who) => `Added an adjustment: ${who} ${auditWeekLabel(String(a.targetWeekStart))}, ${signed(Number(a.amount))}${a.note ? ` — ${String(a.note)}` : ''}`, 'targetWeekStart'),
  {
    method: 'DELETE',
    pattern: '/pay/adjustments/:id',
    before(db, call): RemoveState {
      const a = get<Snap>(db, ADJ_SNAP, [toId(call.params.id)]) ?? null;
      return { adjustment: a, run: a ? runFor(db, toId(a.userId), isoDay(a.targetWeekStart)) : null };
    },
    after(db, _done, state: RemoveState | undefined) {
      const a = state?.adjustment;
      if (!a) return [];
      const userId = toId(a.userId);
      const what = a.kind === 'bonus' ? 'a bonus' : 'an adjustment';
      const summary = `Removed ${what}: ${personName(db, userId)} ${auditWeekLabel(String(a.targetWeekStart))}, ${signed(Number(a.amount))}${a.note ? ` — ${String(a.note)}` : ''}`;
      return [
        { entity: 'pay_adjustment', entityId: toId(a.id), summary, before: a, after: null },
        ...runDraft(db, state?.run ?? null, userId, isoDay(a.targetWeekStart), `after ${what} was removed`),
      ];
    },
  } satisfies AuditRouteSpec<RemoveState>,
];
