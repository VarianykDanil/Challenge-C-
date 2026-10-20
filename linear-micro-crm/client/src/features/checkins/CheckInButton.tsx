// Release 1.2 slot — OWNED BY U4 check-ins (laid down by r2-foundation; renders nothing until U4 fills it).
// One-tap "Check in" for the caller at `event` (business time; "Checked in 09:24 · on time" / "· 6 min late"; undo
// within 2 minutes). Offline: when POST /checkins throws a NetworkError, enqueue the tap in U4's own outbox
// (features/checkins/outbox.ts, key 'lm-checkin-outbox:<userId>') and show "Saved on this phone"; the shell-level
// features/checkins/CheckInOutboxReplay.tsx replays it from any page. Mounted, each in an ErrorBoundary with fallback={null}:
//  - pages/QuickGauges.tsx header (variant 'compact'), for the selected event;
//  - features/dashboard/UpcomingEvents.tsx, under every row dated today (variant 'row').
// The component decides whether it applies (rep / leader of the event's team, not cancelled, today).
import type { SalesEventWithMeta } from '@lm/shared';

export interface CheckInButtonProps {
  event: SalesEventWithMeta;
  variant?: 'compact' | 'row';
  className?: string;
}

export function CheckInButton(_props: CheckInButtonProps) {
  return null;
}
