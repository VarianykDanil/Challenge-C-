// Bulk "Mark paid" bar for admin Runs to pay — OWNED BY p3-money-forecast-payroll-checks (Smart release 1.1).
//
// The sticky bar under the Runs to pay table while runs are selected: "Mark 23 selected paid · £4,310.00" with an
// optional paid date (defaults to today; between the latest selected week end and today — the server checks again).
// Loaded on demand through LazyBulkPayBar (bulkPay.tsx, with useBulkMarkPaid and the helpers); never import it directly
// from a page, or it moves back into that page's chunk.
import { useId } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import clsx from 'clsx';
import type { PayrollRunWithUser } from '@lm/shared';
import { Button, Input, ProgressBar } from '@/components/ui';
import { formatGBP, formatNumber } from '@/lib/format';
import { latestWeekEnd, paidDateProblem, type BulkPayProgress } from './bulkPay';

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

export interface BulkPayBarProps {
  /** The selected runs (all unpaid). */
  runs: PayrollRunWithUser[];
  /** How many of them carry a warning-level check. */
  flagged: number;
  paidDate: string;
  onPaidDateChange: (date: string) => void;
  /** Today (the latest allowed paid date). */
  today: string;
  progress: BulkPayProgress | null;
  onPay: () => void;
  onClear: () => void;
  className?: string;
}

/** Sticky bar: sits at the bottom of the viewport while the Runs to pay card is on screen and runs are selected. */
export function BulkPayBar({ runs, flagged, paidDate, onPaidDateChange, today, progress, onPay, onClear, className }: BulkPayBarProps) {
  const uid = useId();
  if (!runs.length && !progress) return null;
  const total = runs.reduce((a, r) => a + r.gross, 0);
  const minDate = latestWeekEnd(runs);
  const problem = paidDateProblem(paidDate, minDate, today);
  const busy = progress !== null;
  // One format for the total everywhere (pence, as in the table, the confirm dialog and the summary toast).
  const totalText = formatGBP(total, { cents: true });
  const label = `Mark ${formatNumber(runs.length)} selected paid · ${totalText}`;
  return (
    <div
      role="region"
      aria-label="Bulk mark paid"
      data-bulk-pay-bar=""
      className={clsx(
        'sticky bottom-0 z-20 border-t border-border bg-surface/95 px-4 pt-3 shadow-pop backdrop-blur-md sm:px-5',
        'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      {busy ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4" aria-live="polite">
          <p className="text-sm font-medium text-fg">Marking paid… {formatNumber(progress.done)} of {formatNumber(progress.total)}</p>
          <ProgressBar value={progress.done} max={progress.total} size="sm" className="min-w-0 flex-1" />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* The button already carries the count and total, so phones show only the note about checks here. */}
          <div className={clsx('min-w-0 flex-1 basis-full text-sm sm:basis-auto', !flagged && 'hidden sm:block')}>
            <p className="hidden font-medium text-fg sm:block">
              {plural(runs.length, 'run')} selected · <span className="tabular-nums">{totalText}</span>
            </p>
            {flagged > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-warning sm:mt-0.5">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{plural(flagged, 'run')} to look at first<span className="hidden sm:inline"> — you will see why before anything is paid</span></span>
              </p>
            )}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
            <label htmlFor={`${uid}-date`} className="shrink-0 text-xs font-medium text-muted">Paid on</label>
            <Input
              id={`${uid}-date`}
              type="date"
              value={paidDate}
              min={minDate ?? undefined}
              max={today}
              onChange={(e) => onPaidDateChange(e.target.value)}
              invalid={!!problem}
              aria-describedby={problem ? `${uid}-err` : undefined}
              className="min-w-0 sm:w-40"
            />
          </div>
          <Button variant="ghost" onClick={onClear} leftIcon={<X className="h-4 w-4" aria-hidden />} className="h-10 shrink-0" aria-label="Clear the selection">Clear</Button>
          <Button onClick={onPay} disabled={!!problem || !runs.length} className="h-10 w-full sm:w-auto">{label}</Button>
          {problem && <p id={`${uid}-err`} className="basis-full text-xs text-danger" role="alert">{problem}</p>}
        </div>
      )}
    </div>
  );
}
