// Release 1.2 slot — OWNED BY U4 check-ins (laid down by r2-foundation; renders nothing until U4 fills it).
// Replays check-ins tapped without signal, from ANY page: the gauge outbox (features/gauges/outbox.ts, replayed by p7's
// OutboxBanner) handles GaugeUpsertInput only, so U4 keeps its own queue:
//  - features/checkins/outbox.ts (U4, new), one localStorage key per signed-in person: 'lm-checkin-outbox:<userId>',
//    every storage call wrapped (a failed write keeps the error path; nothing is dropped silently);
//  - each item is a ShiftCheckInInput with `checkedInAt` = the time it was tapped and `source: 'offline'`; POST
//    /checkins is idempotent on (user, event, date), so a repeated send is harmless;
//  - this component replays the signed-in person's queue on mount, on the window 'online' event and when api/client.ts
//    announces the server is reachable again (NETWORK_EVENT with detail.online === true), single-flight. It may render
//    a one-line "1 check-in waiting to send" note (it sits in the sticky banner row under the topbar), or nothing.
// CheckInButton (Quick gauges, dashboard) enqueues when POST /checkins throws a NetworkError.
// Mounted once in components/layout/AppShell.tsx, after the OutboxBanner, in an ErrorBoundary with fallback={null}.
import type { UserWithTeam } from '@lm/shared';

export interface CheckInOutboxReplayProps {
  user: UserWithTeam;
}

export function CheckInOutboxReplay(_props: CheckInOutboxReplayProps) {
  return null;
}
