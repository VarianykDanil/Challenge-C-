// Release 1.3 slot — OWNED BY P8 venue-insights (laid down by r3-foundation; renders nothing until P8 venue-insights fills it).
// EventDetail → "Who's working": the leader books team members; a rep taps "I'm working this". Mounted in
// pages/EventDetail.tsx after the check-in roll call, in an ErrorBoundary with fallback={null}. Render a whole Card.
import type { SalesEventWithMeta } from '@lm/shared';

export interface EventRosterCardProps {
  event: SalesEventWithMeta;
  /** The page's own rule: the admin, or the leader of the event's team. */
  canManage: boolean;
  className?: string;
}

export function EventRosterCard(_props: EventRosterCardProps) {
  return null;
}
