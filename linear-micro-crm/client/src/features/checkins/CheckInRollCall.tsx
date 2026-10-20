// Release 1.2 slot — OWNED BY U4 check-ins (laid down by r2-foundation; renders nothing until U4 fills it).
// The event page's roll call: who of the event's team has checked in, and when (leader of the team / admin; a rep
// sees only their own). Mounted in pages/EventDetail.tsx under the "Not logged yet" card, in an ErrorBoundary with
// fallback={null}. `canManage` mirrors the page's own rule (admin, or the leader of the event's team).
import type { SalesEventWithMeta } from '@lm/shared';

export interface CheckInRollCallProps {
  event: SalesEventWithMeta;
  canManage: boolean;
  className?: string;
}

export function CheckInRollCall(_props: CheckInRollCallProps) {
  return null;
}
