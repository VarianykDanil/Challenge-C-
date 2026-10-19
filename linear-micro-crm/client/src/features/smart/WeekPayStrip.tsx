// "This week (estimate)" pay strip — OWNED BY p3-money-forecast-payroll-checks.
// Mounted directly under the dashboard KPI tiles for reps and leaders only, inside an ErrorBoundary. Hidden when the
// forecast is null/undefined (recruiters, admins, LM_SMART=0, still loading). At most 2 lines at 360 px: the amount
// line, then one bonus line. Phones get the same facts in tighter wording ("~" for "about"; the bonus line keeps the
// stops figure, the one lever) so each fits one line at 360 px. Tapping it opens Finance → My pay, where the
// "This week so far" card explains the method.
import { Link } from 'react-router-dom';
import { ChevronRight, Wallet } from 'lucide-react';
import clsx from 'clsx';
import type { PayForecast } from '@lm/shared';
import { formatGBP } from '@/lib/format';
import { actionHref } from '@/lib/useActionParam';
import { FORECAST_LABEL, bonusLine, bonusLineShort, forecastHeadline, forecastMethod, forecastRangeNote, forecastRangeNoteShort } from './weekPayCopy';

export interface WeekPayStripProps {
  /** insights.personal.payForecast — undefined while /me/insights loads. */
  forecast: PayForecast | null | undefined;
  className?: string;
}

export function WeekPayStrip({ forecast: f, className }: WeekPayStripProps) {
  if (!f) return null;
  const note = forecastRangeNote(f);
  const noteShort = forecastRangeNoteShort(f);
  const bonus = bonusLine(f);
  const bonusShort = bonusLineShort(f);
  const reached = f.bonusLikelihood === 'reached';
  // The full sentences are the link's accessible name; on phones the visible lines use the short copy (2 lines max).
  const name = [forecastHeadline(f), bonus, `${FORECAST_LABEL}. Based on ${forecastMethod(f)}.`].filter(Boolean).join('. ').replace(/\.\. /g, '. ');
  return (
    <Link
      to={actionHref.finance('me')}
      title={`${FORECAST_LABEL}. Based on ${forecastMethod(f)}.`}
      aria-label={name}
      data-week-pay-strip=""
      className={clsx(
        'focus-ring group mt-3 flex min-h-10 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 shadow-card transition-colors hover:border-border-strong hover:bg-surface-2/60 sm:px-4',
        className,
      )}
    >
      <Wallet className="hidden h-4 w-4 shrink-0 text-primary sm:block" aria-hidden />
      <span className="min-w-0 flex-1 leading-5" aria-hidden>
        {/* Phone: short copy, one line each (truncate is only a safety net for very large amounts). */}
        <span className="block truncate text-[13px] sm:hidden">
          <span className="text-muted">This week (estimate):</span>{' '}
          <span className="font-semibold tabular-nums text-fg">~{formatGBP(f.likely)}</span>
          <span className="tabular-nums text-muted"> · {noteShort}</span>
        </span>
        {bonusShort && <span className={clsx('block truncate text-xs sm:hidden', reached ? 'font-medium text-success' : 'text-muted')}>{bonusShort}</span>}
        {/* Tablet and desktop: the full sentences. */}
        <span className="hidden text-sm sm:block">
          <span className="text-muted">This week (estimate):</span>{' '}
          <span className="font-semibold tabular-nums text-fg">about {formatGBP(f.likely)}</span>
          <span className="tabular-nums text-muted"> · {note}</span>
        </span>
        {bonus && <span className={clsx('hidden text-sm sm:block', reached ? 'font-medium text-success' : 'text-muted')}>{bonus}</span>}
      </span>
      <ChevronRight className="hidden h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 min-[400px]:block" aria-hidden />
    </Link>
  );
}
