// Release 1.3 slot — OWNED BY P8 venue-insights (laid down by r3-foundation; renders nothing until P8 venue-insights fills it).
// The event page's plan: yours, or (the event's leader, admins) every booked person's, with the venue's numbers and a
// link to the venue profile. Mounted in pages/EventDetail.tsx after the forecast, in an ErrorBoundary with
// fallback={null}. Render a whole Card (the page spaces its cards).
import type { SalesEventWithMeta } from '@lm/shared';

export interface EventPlanCardProps {
  event: SalesEventWithMeta;
  /** The page's own rule: the admin, or the leader of the event's team. */
  canManage: boolean;
  className?: string;
}

export function EventPlanCard(_props: EventPlanCardProps) {
  return null;
}
