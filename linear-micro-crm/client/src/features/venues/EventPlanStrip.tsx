// Release 1.3 slot — OWNED BY P8 venue-insights. The booked person's plan for an event in one line ("Aim: 120 stops →
// 42 → 21 → 9 → 6 taps for 5 sales"). Mounted, each in an ErrorBoundary with fallback={null}:
// features/events/EventRow.tsx under the forecast chip (variant 'row'), features/dashboard/UpcomingEvents.tsx under
// each event's details (variant 'upcoming'), and pages/QuickGauges.tsx under the header in the help line's place
// (variant 'quick', the thin "Aim" strip: ONE line that truncates, target first — "Aim 5 sales · 120 stops → … 6 taps" —
// so the six tiles keep their height; the page shortens its help line to one sentence while the Aim shows).
// Data: the caller's own aim travels on the event (SalesEventWithMeta.bookings.aim, attached by GET /events and
// GET /events/:id for the events they are booked on, the same numbers as GET /events/:id/plan), so a list makes no
// request per row. Rows and the dashboard put the strip inside a link, so it holds no interactive element. Nothing
// renders without an aim (not booked, a finished event, nothing to plan from, or LM_SMART=0).
import clsx from 'clsx';
import { Target } from 'lucide-react';
import { planAimText, planStepText, type SalesEventWithMeta } from '@lm/shared';
import { formatNumber } from '@/lib/format';
import { bookingsOpen, salesText } from './venueCopy';

export interface EventPlanStripProps {
  event: SalesEventWithMeta;
  variant: 'row' | 'upcoming' | 'quick';
  className?: string;
}

export function EventPlanStrip({ event, variant, className }: EventPlanStripProps) {
  const aim = event.bookings?.me && bookingsOpen(event) ? event.bookings.aim : undefined;
  if (!aim || !aim.steps.length) return null;
  const text = planAimText(aim.targetSales, aim.steps);
  if (variant === 'quick') {
    // the target first, so a line cut short on a small phone still says what the numbers are for
    const chain = aim.steps.map((s, i) => (i === 0 || i === aim.steps.length - 1 ? planStepText(s) : formatNumber(s.need))).join(' → ');
    return (
      <p className={clsx('flex min-w-0 items-center gap-1.5 text-fg', className)} data-plan-strip="quick" title={`Aim: ${text}`}>
        <Target className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 truncate" data-plan-aim>
          <span className="font-semibold">Aim {salesText(aim.targetSales)}</span>
          <span className="text-muted"> · </span>
          {chain}
        </span>
      </p>
    );
  }
  return (
    <span className={clsx('flex min-w-0 items-start gap-1 text-xs leading-snug text-muted', className)} data-plan-strip={variant}>
      <Target className="mt-[0.2em] h-3 w-3 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium text-fg">Aim:</span> {text}
      </span>
    </span>
  );
}
