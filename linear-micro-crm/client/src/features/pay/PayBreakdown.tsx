// Release 1.3 slot — OWNED BY P1 pay-rule. The week's pay under the 1.3 rule: days × £63.50 against the commission per
// campaign (logged, cancelled, paid × rate), which one applies and why (shared payExplanation), Matt's bonuses, the
// corrections from earlier weeks, the total; "Not yet confirmed by BCN" chips while a statement is awaited. Mounted in
// features/finance/PayslipModal.tsx (P2's) under the payslip's pay table, inside an ErrorBoundary with fallback={null};
// P2's invoice view keeps it mounted. Data: api/pay.ts usePayBreakdown(run.userId, run.weekStart). An administrator can
// add a bonus or an adjustment to an unpaid week from here, and remove a bonus or a manual line.
import { useState } from 'react';
import { CheckCircle2, CircleDashed, Clock, Gift, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { PayLine, PayrollRunWithUser, WeekPayBreakdown } from '@lm/shared';
import { payMoney, paySignedMoney, payWeekLabel } from '@lm/shared';
import { Badge, Button, Skeleton, useToast } from '@/components/ui';
import { usePayBreakdown, useRemoveAdjustment } from '@/api/pay';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ConfirmDialog, errorMessage } from '@/features/common';
import { formatNumber } from '@/lib/format';
import { AdjustmentModal } from './AdjustmentModal';
import { awaitedCampaigns } from './payCopy';

export interface PayBreakdownProps {
  run: PayrollRunWithUser;
  className?: string;
}

export function PayBreakdown({ run, className }: PayBreakdownProps) {
  const q = usePayBreakdown(run.userId, run.weekStart);
  if (q.isLoading) {
    return (
      <div className={clsx('space-y-2 rounded-lg border border-border p-4', className)} aria-busy>
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      </div>
    );
  }
  if (!q.data) return null; // 404 or an error: the payslip above still has every figure
  return <BreakdownBody b={q.data} className={className} />;
}

/** The breakdown itself (also used by the Finance → My pay week view). */
export function BreakdownBody({ b, className }: { b: WeekPayBreakdown; className?: string }) {
  const me = useCurrentUser();
  const toast = useToast();
  const remove = useRemoveAdjustment();
  const [adding, setAdding] = useState<'bonus' | 'manual' | null>(null);
  const [removing, setRemoving] = useState<PayLine | null>(null);
  const unpaid = b.status === 'pending' || b.status === 'failed' || b.status === 'estimate';
  // money not sent yet (a pending run, a failed transfer): the choice "applies"; only a paid or late run "paid"
  const phase: ChoicePhase = b.status === 'estimate' ? 'estimate' : unpaid ? 'unpaid' : 'paid';
  const canEdit = me.role === 'admin' && unpaid && !b.salaried;
  const awaited = awaitedCampaigns(b);
  const commissionLines = b.lines.filter((l) => l.kind === 'commission');
  const extras = b.lines.filter((l) => l.kind === 'bonus' || l.kind === 'adjustment' || l.kind === 'deduction' || l.kind === 'override');
  const removable = (l: PayLine) => canEdit && l.adjustmentId != null && (l.kind === 'bonus' || b.adjustments.some((a) => a.id === l.adjustmentId && a.kind === 'manual'));
  const titleId = `pay-breakdown-${b.userId}-${b.weekStart}`;

  return (
    <section aria-labelledby={titleId} className={clsx('rounded-lg border border-border p-4', className)} data-pay-breakdown="" data-print-keep>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 id={titleId} className="mr-auto text-xs font-semibold uppercase tracking-wide text-muted">How this week is worked out</h4>
        {b.status === 'estimate' && <Badge tone="info" size="sm">Estimate</Badge>}
        {b.rule === 'base-or-commission' && !b.salaried && (
          <Badge tone={b.paidAs === 'commission' ? 'success' : 'primary'} size="sm">
            {phase === 'estimate'
              ? b.paidAs === 'commission' ? 'Commission ahead so far' : 'Base ahead so far'
              : phase === 'unpaid'
                ? b.paidAs === 'commission' ? 'Pays the commission' : 'Pays the base'
                : b.paidAs === 'commission' ? 'Paid the commission' : 'Paid the base'}
          </Badge>
        )}
        {awaited.map((code) => (
          <Badge key={code} tone="warning" size="sm" title={`${code} has not sent its statement for this week yet, so the logged subs are used`}>
            <Clock aria-hidden /> Not yet confirmed by {code}
          </Badge>
        ))}
      </div>

      {b.salaried ? (
        <p className="text-sm text-muted">{b.explanation[0]}</p>
      ) : (
        <>
          {b.rule === 'base-or-commission' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Choice
                title="Base"
                detail={`${formatNumber(b.daysWorked)} day${b.daysWorked === 1 ? '' : 's'} × ${payMoney(b.dayRate)}`}
                amount={b.baseAmount}
                chosen={b.paidAs === 'base'}
                phase={phase}
              />
              <Choice
                title="Commission"
                detail={`${formatNumber(b.salesConfirmed)} sub${b.salesConfirmed === 1 ? '' : 's'} at the campaign rates${b.salesCancelled > 0 ? ` · ${formatNumber(b.salesCancelled)} cancelled` : ''}`}
                amount={b.commissionAmount}
                chosen={b.paidAs === 'commission'}
                phase={phase}
              />
            </div>
          ) : (
            <p className="mb-1 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">{b.explanation[0]}</p>
          )}

          {commissionLines.length > 0 && (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border" aria-label="Commission per campaign">
              {commissionLines.map((l, i) => (
                <li key={`${l.campaignId}-${i}`} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block text-fg">{l.label}</span>
                    {l.note && <span className="block text-xs text-muted">{sentenceCase(l.note)}</span>}
                  </span>
                  <span className={clsx('shrink-0 tabular-nums', l.paid ? 'font-medium text-fg' : 'text-muted line-through decoration-muted/60')}>{payMoney(l.amount)}</span>
                </li>
              ))}
            </ul>
          )}

          {(extras.length > 0 || canEdit) && (
            <ul className="mt-3 space-y-1.5" aria-label="Bonuses, corrections and deductions">
              {extras.map((l, i) => (
                <li key={`${l.kind}-${l.adjustmentId ?? i}`} className="flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-fg">
                      {l.kind === 'bonus' && <Gift className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
                      {l.label}
                    </span>
                    {l.note && l.kind !== 'bonus' && <span className="block text-xs text-muted">{sentenceCase(l.note)}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className={clsx('tabular-nums', l.amount < 0 ? 'text-danger' : 'text-fg')}>{l.kind === 'deduction' ? payMoney(l.amount) : paySignedMoney(l.amount)}</span>
                    {removable(l) && (
                      <Button size="icon" variant="ghost" className="-my-1 text-muted hover:text-danger sm:h-8 sm:w-8 print:hidden" aria-label={`Remove ${l.label}`} onClick={() => setRemoving(l)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
              {canEdit && (
                <li className="flex flex-wrap gap-2 pt-1 print:hidden">
                  <Button size="sm" variant="outline" className="h-10 sm:h-8" leftIcon={<Gift className="h-4 w-4" aria-hidden />} onClick={() => setAdding('bonus')}>Add a bonus</Button>
                  <Button size="sm" variant="ghost" className="h-10 sm:h-8" leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding('manual')}>Add an adjustment</Button>
                </li>
              )}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm font-semibold text-fg">{b.status === 'estimate' ? 'Total so far' : 'Total'}</span>
            <span className="text-base font-semibold tabular-nums text-fg">{payMoney(b.gross)}</span>
          </div>

          <ul className="mt-3 space-y-1 text-xs leading-relaxed text-muted" aria-label="Why">
            {(b.rule === 'plan' ? b.explanation.slice(1) : b.explanation).map((s, i) => <li key={i}>{s}</li>)}
          </ul>

          {(b.corrections?.length ?? 0) > 0 && (
            <div className="mt-3 rounded-md border border-info/30 bg-info-soft/60 px-3 py-2 text-xs text-fg" role="note">
              <p className="font-medium">Corrected after payment</p>
              <ul className="mt-1 space-y-0.5">
                {b.corrections!.map((c) => (
                  <li key={c.id}>
                    <span className={clsx('tabular-nums', c.amount < 0 ? 'text-danger' : 'text-success')}>{paySignedMoney(c.amount)}</span> on the pay for {payWeekLabel(c.targetWeekStart)}{c.note ? ` — ${sentenceCase(c.note)}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {adding && (
        <AdjustmentModal open kind={adding} onClose={() => setAdding(null)} userId={b.userId} userName={b.userName} weekStart={b.weekStart} />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing?.kind === 'bonus' ? 'Remove this bonus?' : 'Remove this adjustment?'}
        description={removing ? `${removing.label} · ${paySignedMoney(removing.amount)}. The week is recalculated straight away.` : undefined}
        confirmLabel="Remove"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing?.adjustmentId) return;
          remove.mutate(removing.adjustmentId, {
            onSuccess: () => { toast.success(removing.kind === 'bonus' ? 'Bonus removed' : 'Adjustment removed'); setRemoving(null); },
            onError: (e) => toast.error('Could not remove it', errorMessage(e)),
          });
        }}
      />
    </section>
  );
}

type ChoicePhase = 'estimate' | 'unpaid' | 'paid';

const CHOICE_WORDS: Record<ChoicePhase, [chosen: string, other: string]> = {
  estimate: ['Ahead', 'Behind'],
  unpaid: ['Applies', 'Does not apply'],
  paid: ['Paid', 'Not paid'],
};

/**
 * One side of the base-or-commission choice: on a paid week the one that applied is marked "Paid", the other "Not
 * paid"; on a week not paid yet "Applies" / "Does not apply"; while the week is still going "Ahead" / "Behind".
 */
function Choice({ title, detail, amount, chosen, phase }: { title: string; detail: string; amount: number; chosen: boolean; phase: ChoicePhase }) {
  const [yes, no] = CHOICE_WORDS[phase];
  return (
    <div className={clsx('rounded-lg border p-3', chosen ? 'border-success/40 bg-success-soft/50' : 'border-border bg-surface-2/50')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</span>
        {chosen ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {yes}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted"><CircleDashed className="h-3.5 w-3.5" aria-hidden /> {no}</span>
        )}
      </div>
      <p className={clsx('kpi-number mt-1 text-xl font-semibold tabular-nums', chosen ? 'text-fg' : 'text-muted')}>{payMoney(amount)}</p>
      <p className="text-xs text-muted">{detail}</p>
    </div>
  );
}

const sentenceCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
