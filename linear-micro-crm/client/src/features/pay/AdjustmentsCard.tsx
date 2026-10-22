// Release 1.3 — OWNED BY P1 pay-rule. Finance → Company → "Bonuses and corrections" (administrators): Matt's bonuses,
// manual lines and the corrections the clients' statements made, on the recent weeks' pay, with Add a bonus / Add an
// adjustment and Remove (a bonus or a manual line, while its week is unpaid). GET /pay/adjustments.
import { useMemo, useState } from 'react';
import { Gift, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { PayAdjustment, PayAdjustmentKind } from '@lm/shared';
import { paySignedMoney, payWeekLabel } from '@lm/shared';
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton, useToast } from '@/components/ui';
import { usePayAdjustments, useRemoveAdjustment } from '@/api/pay';
import { ConfirmDialog, ErrorState, errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { AdjustmentModal, mondayOfISO } from './AdjustmentModal';

const KIND_LABEL: Record<PayAdjustmentKind, string> = {
  bonus: 'Bonus',
  cancellation: 'Statement',
  statement: 'Statement',
  dispute: 'Dispute',
  manual: 'Adjustment',
};
const KIND_TONE = { bonus: 'accent', cancellation: 'info', statement: 'info', dispute: 'warning', manual: 'neutral' } as const;
/** Weeks back the card lists (the week each line lands on). */
const WEEKS_BACK = 6;
const SHOW = 12;

export function AdjustmentsCard({ className }: { className?: string }) {
  const q = usePayAdjustments();
  const toast = useToast();
  const remove = useRemoveAdjustment();
  const [adding, setAdding] = useState<'bonus' | 'manual' | null>(null);
  const [removing, setRemoving] = useState<PayAdjustment | null>(null);
  const [all, setAll] = useState(false);
  const recent = useMemo(() => {
    const d = new Date(`${mondayOfISO(todayISO())}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * WEEKS_BACK);
    const from = d.toISOString().slice(0, 10);
    return (q.data ?? []).filter((a) => a.targetWeekStart >= from);
  }, [q.data]);
  const shown = all ? recent : recent.slice(0, SHOW);
  const total = recent.reduce((a, x) => a + x.amount, 0);

  return (
    <Card padded={false} className={clsx('min-w-0 overflow-hidden', className)} data-adjustments-card="">
      {/* the buttons go under the title on phones (beside it the description wraps one word a line) */}
      <div className="flex flex-col gap-3 p-5 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader
          title="Bonuses and corrections"
          description={q.data ? `On the pay of the last ${WEEKS_BACK} weeks · ${recent.length} line${recent.length === 1 ? '' : 's'}, ${paySignedMoney(Math.round(total * 100) / 100)} in all` : 'On the pay of the last few weeks'}
          className="mb-0 min-w-0"
        />
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" className="h-10 sm:h-8" leftIcon={<Gift className="h-4 w-4" aria-hidden />} onClick={() => setAdding('bonus')}>Add a bonus</Button>
          <Button size="sm" variant="outline" className="h-10 sm:h-8" leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding('manual')}>Add an adjustment</Button>
        </div>
      </div>
      <div className="border-t border-border">
        {q.isLoading ? (
          <div className="space-y-2 p-5"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} className="m-5" />
        ) : !recent.length ? (
          <EmptyState title="Nothing added recently" description="Bonuses you add and the corrections from clients' statements show here." size="sm" className="border-0" />
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((a) => {
              const removable = (a.kind === 'bonus' || a.kind === 'manual') && !a.targetPaid;
              return (
                <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-fg">{a.userName ?? 'Someone'}</span>
                      <Badge tone={KIND_TONE[a.kind]} size="sm">{KIND_LABEL[a.kind]}</Badge>
                      <span className="text-xs text-muted">
                        {payWeekLabel(a.targetWeekStart)}{a.sourceWeekStart ? ` · for ${payWeekLabel(a.sourceWeekStart)}` : ''}{a.targetPaid ? ' · paid' : ''}
                      </span>
                    </div>
                    {a.note && <p className="mt-0.5 text-xs text-muted">{a.note[0]!.toUpperCase() + a.note.slice(1)}</p>}
                  </div>
                  <span className={clsx('shrink-0 font-medium tabular-nums', a.amount < 0 ? 'text-danger' : 'text-fg')}>{paySignedMoney(a.amount)}</span>
                  {removable ? (
                    <Button size="icon" variant="ghost" className="-my-1.5 shrink-0 text-muted hover:text-danger sm:h-8 sm:w-8" aria-label={`Remove ${KIND_LABEL[a.kind].toLowerCase()} for ${a.userName ?? 'this person'}, ${payWeekLabel(a.targetWeekStart)}`} onClick={() => setRemoving(a)}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : <span className="h-8 w-10 shrink-0 sm:w-8" aria-hidden />}
                </li>
              );
            })}
          </ul>
        )}
        {recent.length > SHOW && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted">
            <span>{all ? `All ${recent.length} lines` : `Showing ${SHOW} of ${recent.length}`}</span>
            <Button size="sm" variant="outline" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${recent.length}`}</Button>
          </div>
        )}
      </div>
      {adding && <AdjustmentModal open kind={adding} onClose={() => setAdding(null)} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing?.kind === 'bonus' ? 'Remove this bonus?' : 'Remove this adjustment?'}
        description={removing ? `${removing.userName ?? 'Someone'} · ${payWeekLabel(removing.targetWeekStart)} · ${paySignedMoney(removing.amount)}. That week's pay is recalculated straight away.` : undefined}
        confirmLabel="Remove"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => { toast.success(removing.kind === 'bonus' ? 'Bonus removed' : 'Adjustment removed'); setRemoving(null); },
            onError: (e) => toast.error('Could not remove it', errorMessage(e)),
          });
        }}
      />
    </Card>
  );
}
