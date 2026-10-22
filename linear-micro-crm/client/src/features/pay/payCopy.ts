// Release 1.3 — OWNED BY P1 pay-rule. Small wording helpers for the pay screens (the sentences themselves come from
// shared payExplanation on the server, so every screen says the same thing).
import type { PaidAs, PayrollRun, WeekPayBreakdown } from '@lm/shared';

/** Campaign codes still waiting for their statement for this week ("Not yet confirmed by BCN"). */
export function awaitedCampaigns(b: Pick<WeekPayBreakdown, 'awaiting' | 'perCampaign'>): string[] {
  if (b.awaiting) return b.awaiting;
  return b.perCampaign.filter((c) => !c.statementConfirmed && c.awaitsStatement !== false && c.logged > 0).map((c) => c.code);
}

export const PAID_AS_LABELS: Record<PaidAs, string> = { base: 'Base', commission: 'Commission' };

/** "Base" / "Commission" for a run paid by the 1.3 rule; "Plan" for a run of the 1.2 pay plans. */
export function paidAsLabel(run: Pick<PayrollRun, 'paidAs'>): string {
  return run.paidAs ? PAID_AS_LABELS[run.paidAs] : 'Plan';
}

/** The amount the week paid for its work (the base or the commission; both for a 1.2 run). */
export function paidAmount(run: Pick<PayrollRun, 'paidAs' | 'basePay' | 'commission'>): number {
  if (run.paidAs === 'base') return run.basePay;
  if (run.paidAs === 'commission') return run.commission;
  return run.basePay + run.commission;
}

/** "4 of 12 weeks" — how many 1.3 runs paid the commission (null when none of the runs is a 1.3 run). */
export function commissionWeeks(runs: readonly Pick<PayrollRun, 'paidAs'>[]): { commission: number; rule: number } | null {
  const rule = runs.filter((r) => r.paidAs === 'base' || r.paidAs === 'commission');
  if (!rule.length) return null;
  return { commission: rule.filter((r) => r.paidAs === 'commission').length, rule: rule.length };
}
