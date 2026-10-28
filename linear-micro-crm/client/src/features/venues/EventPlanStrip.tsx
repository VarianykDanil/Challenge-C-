// Release 1.3 slot — OWNED BY P8 venue-insights. The booked person's plan for an event, in plain words ("Your aim: 5
// sales. That usually takes about 120 stops, 42 at the table, 21 presentations, 9 closes and 6 taps."), never the
// "120 stops → 42 → 21 → 9 → 6 taps" shorthand. Mounted, each in an ErrorBoundary with fallback={null}:
// features/events/EventRow.tsx under the forecast chip (variant 'row'), features/dashboard/UpcomingEvents.tsx under
// each event's details (variant 'upcoming'), and pages/QuickGauges.tsx under the header in the help line's place
// (variant 'quick', the thin "Aim" strip: ONE line that truncates, target first — "Aim 5 sales: about 120 stops, 42 at
// the table, …" — so the six tiles keep their height; the page shortens its help line to one sentence while it shows).
// Data: the caller's own aim travels on the event (SalesEventWithMeta.bookings.aim, attached by GET /events and
// GET /events/:id for the events they are booked on, the same numbers as GET /events/:id/plan), so a list makes no
// request per row. Rows and the dashboard put the strip inside a link, so it holds no interactive element. Nothing
// renders without an aim (not booked, a finished event, nothing to plan from, or LM_SMART=0).
import clsx from 'clsx';
import { Target } from 'lucide-react';
import { planStepText, type SalesEventWithMeta } from '@lm/shared';
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
  const steps = plainSteps(aim.steps);
  if (variant === 'quick') {
    // the target first, so a line cut short on a small phone still says what the numbers are for
    const full = `Your aim: ${salesText(aim.targetSales)}. That usually takes ${steps}.`;
    return (
      <p className={clsx('flex min-w-0 items-center gap-1.5 text-fg', className)} data-plan-strip="quick" title={full}>
        <Target className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 truncate" data-plan-aim>
          <span className="font-semibold">Aim {salesText(aim.targetSales)}:</span> {steps}
        </span>
      </p>
    );
  }
  // the dashboard and the Events rows, read between stops: a sentence
  return (
    <span className={clsx('flex min-w-0 items-start gap-1 text-xs leading-snug text-muted', className)} data-plan-strip={variant}>
      <Target className="mt-[0.2em] h-3 w-3 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium text-fg">Your aim: {salesText(aim.targetSales)}.</span> That usually takes {steps}.
      </span>
    </span>
  );
}

/** "about 120 stops, 42 at the table, 21 presentations, 9 closes and 6 taps" (the steps before the sales). */
function plainSteps(steps: ReadonlyArray<{ key: string; need: number }>): string {
  const words = steps
    .filter((st) => st.key !== 'sales')
    .map((st) => (st.key === 'table' ? `${formatNumber(st.need)} at the table` : planStepText(st as Parameters<typeof planStepText>[0])));
  if (!words.length) return 'a good day';
  return `about ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]}`;
}
