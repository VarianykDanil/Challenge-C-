// Bulk "Mark paid" for admin Runs to pay — OWNED BY p3-money-forecast-payroll-checks (Smart release 1.1).
//
// The always-loaded half: useBulkMarkPaid pays the runs ONE AFTER ANOTHER through the existing POST
// /finance/payroll/:id/pay, keeps a progress toast up throughout, invalidates ['finance'] and ['dashboard'] once at the
// end, then shows the summary "22 marked paid · 1 skipped (already paid) · 0 failed" (409 = already paid = skipped);
// the pure helpers; FlaggedRunsList (the confirm dialogs' body); and LazyBulkPayBar. The sticky bar itself
// (BulkPayBar.tsx) is admin-only, so it is loaded on demand the first time runs are selected (lead decision on the
// bundle): a rep opening My pay never downloads it.
import { Suspense, lazy, useCallback, useRef, useState, type ComponentProps } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PayrollRunWithUser } from '@lm/shared';
import { Skeleton, useToast } from '@/components/ui';
import { api, ApiError } from '@/api/client';
import { errorMessage } from '@/features/common';
import { formatDate, formatGBP, formatNumber, formatRangeLabel } from '@/lib/format';
import type { BulkPayBar } from './BulkPayBar';
import { PayrollChecksList, warningFlags } from './PayslipModal';

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** Money owed on a run: pending runs and failed transfers can be marked paid. */
export const isUnpaidRun = (r: Pick<PayrollRunWithUser, 'status'>): boolean => r.status === 'pending' || r.status === 'failed';

/** The latest week end among the runs (the earliest allowed paid date), or null for none. */
export function latestWeekEnd(runs: ReadonlyArray<Pick<PayrollRunWithUser, 'weekEnd'>>): string | null {
  return runs.reduce<string | null>((m, r) => (m === null || r.weekEnd > m ? r.weekEnd : m), null);
}

/** Why a paid date cannot be used, or null when it is fine: required, ≥ the latest selected week end, ≤ today. */
export function paidDateProblem(date: string, minDate: string | null, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick the date the money went';
  if (date > today) return 'The paid date cannot be in the future';
  if (minDate && date < minDate) return `Pick ${formatDate(minDate)} or later — the latest selected week ends then`;
  return null;
}

export interface BulkPayOutcome {
  paid: PayrollRunWithUser[];
  /** Already paid elsewhere (409). */
  skipped: PayrollRunWithUser[];
  failed: { run: PayrollRunWithUser; message: string }[];
}

/** "22 marked paid · 1 skipped (already paid) · 0 failed" */
export function bulkPaySummary(o: { paid: number; skipped: number; failed: number }): string {
  return `${formatNumber(o.paid)} marked paid · ${formatNumber(o.skipped)} skipped (already paid) · ${formatNumber(o.failed)} failed`;
}

export interface BulkPayProgress {
  done: number;
  total: number;
}

/**
 * Pays runs one after another (never in parallel: the transfers are checked one by one and a slow phone connection
 * stays responsive). Advisory flags never block; a 409 (already paid) counts as skipped; anything else as failed.
 * A 401/403 stops the batch (the rest are reported as failed, not attempted).
 */
export function useBulkMarkPaid() {
  const qc = useQueryClient();
  const toast = useToast();
  const [progress, setProgress] = useState<BulkPayProgress | null>(null);
  const running = useRef(false);

  const markPaid = useCallback(async (runs: PayrollRunWithUser[], paidDate?: string): Promise<BulkPayOutcome> => {
    const outcome: BulkPayOutcome = { paid: [], skipped: [], failed: [] };
    if (running.current || !runs.length) return outcome;
    running.current = true;
    const total = runs.length;
    setProgress({ done: 0, total });
    const progressToast = toast.toast({
      tone: 'info',
      title: `Marking ${plural(total, 'run')} paid…`,
      description: `One at a time${paidDate ? `, paid on ${formatDate(paidDate)}` : ''}. Keep this page open until the summary appears.`,
      duration: 0,
    });
    let stopped: string | null = null;
    try {
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i]!;
        if (stopped) {
          outcome.failed.push({ run: r, message: stopped });
        } else {
          try {
            const res = await api<PayrollRunWithUser>(`/finance/payroll/${r.id}/pay`, { method: 'POST', json: paidDate ? { paidDate } : {} });
            outcome.paid.push(res ?? r);
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) outcome.skipped.push(r);
            else {
              const message = errorMessage(e);
              outcome.failed.push({ run: r, message });
              if (e instanceof ApiError && (e.status === 401 || e.status === 403)) stopped = `Not attempted: ${message}`;
            }
          }
        }
        setProgress({ done: i + 1, total });
      }
    } finally {
      toast.dismiss(progressToast);
      // One invalidation for the whole batch (not one per run).
      await Promise.all([qc.invalidateQueries({ queryKey: ['finance'] }), qc.invalidateQueries({ queryKey: ['dashboard'] })]);
      const title = bulkPaySummary({ paid: outcome.paid.length, skipped: outcome.skipped.length, failed: outcome.failed.length });
      const paidTotal = outcome.paid.reduce((a, r) => a + r.gross, 0);
      if (outcome.failed.length) {
        const first = outcome.failed[0]!;
        toast.toast({ tone: 'warning', title, description: `${first.run.userName}: ${first.message}${outcome.failed.length > 1 ? ` (and ${plural(outcome.failed.length - 1, 'other')})` : ''}. The runs that did not go through stay selected.`, duration: 10000 });
      } else {
        toast.toast({ tone: 'success', title, description: outcome.paid.length ? `${formatGBP(paidTotal, { cents: true })} recorded as paid${paidDate ? ` on ${formatDate(paidDate)}` : ''}` : undefined, duration: 6000 });
      }
      setProgress(null);
      running.current = false;
    }
    return outcome;
  }, [qc, toast]);

  return { markPaid, progress, busy: progress !== null };
}

/** The reasons shown before paying flagged runs (ConfirmDialog body): each run with its warning-level checks. */
export function FlaggedRunsList({ runs, hideHeading }: { runs: PayrollRunWithUser[]; hideHeading?: boolean }) {
  return (
    <ul className="max-h-[45vh] space-y-3 overflow-y-auto pr-1" data-flagged-runs="">
      {runs.map((r) => (
        <li key={r.id} className="rounded-lg border border-warning/40 bg-warning/5 p-3">
          {!hideHeading && (
            <p className="mb-1.5 text-sm font-medium text-fg">
              {r.userName} <span className="font-normal text-muted">· week {formatRangeLabel(r.weekStart, r.weekEnd)} · {formatGBP(r.gross, { cents: true })}</span>
            </p>
          )}
          <PayrollChecksList flags={warningFlags(r)} compact />
        </li>
      ))}
    </ul>
  );
}

const BulkPayBarChunk = lazy(() => import('./BulkPayBar').then((m) => ({ default: m.BulkPayBar })));

/** The sticky bulk-pay bar, fetched the first time runs are selected; a quiet bar-shaped placeholder meanwhile. */
export function LazyBulkPayBar(props: ComponentProps<typeof BulkPayBar>) {
  if (!props.runs.length && !props.progress) return null;
  return (
    <Suspense
      fallback={
        <div aria-hidden className="sticky bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 sm:px-5">
          <Skeleton className="h-10 w-full" />
        </div>
      }
    >
      <BulkPayBarChunk {...props} />
    </Suspense>
  );
}
