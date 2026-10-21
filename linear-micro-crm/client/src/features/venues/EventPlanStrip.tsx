// Release 1.3 slot — OWNED BY P8 venue-insights (laid down by r3-foundation; renders nothing until P8 venue-insights fills it).
// The booked person's plan for an event in one line ("Aim: 120 stops → 42 → 21 → 9 → 6 taps for 5 sales"). Mounted,
// each in an ErrorBoundary with fallback={null}: features/events/EventRow.tsx under the progress bar (variant 'row'),
// features/dashboard/UpcomingEvents.tsx under each event's details (variant 'upcoming'), pages/QuickGauges.tsx right
// under the header (variant 'quick', the thin "Aim" strip). Data: api/venues.ts useEventPlan — fetch only for events the
// caller is booked on (event.bookings?.me).
import type { SalesEventWithMeta } from '@lm/shared';

export interface EventPlanStripProps {
  event: SalesEventWithMeta;
  variant: 'row' | 'upcoming' | 'quick';
  className?: string;
}

export function EventPlanStrip(_props: EventPlanStripProps) {
  return null;
}
