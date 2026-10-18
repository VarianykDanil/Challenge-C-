// Live tally counter for a shift — OWNED BY p7-signal-proof-logging (lead's addition).
// Stub from p1: all three components render nothing. Mount points (p1's files, each inside its own ErrorBoundary):
// - TallyButton: Gauges page header actions, before "Log gauges" (compact fallback if it throws).
// - TallyMode: Gauges page, right under the page header (card fallback if it throws).
// - TodayTallyLink: the dashboard's "Upcoming events" card, above the list, for GAUGE_ROLES only. This is the
//   "reachable from the dashboard's today event" entry point, so p7 never needs to edit UpcomingEvents.tsx (p6's file).
// The deep link /gauges?tally=1[&eventId=<id>] (lib/useActionParam actionHref.tally) sets `request`. p7 keeps the
// counts in localStorage per (userId, eventId, date), and "Finish shift" opens LogGaugesModal prefilled — rendered by
// TallyMode itself.
import type { SalesEventWithMeta } from '@lm/shared';

/** What opened the tally: the header button (eventId null) or a deep link. */
export interface TallyRequest {
  eventId: number | null;
}

export interface TallyButtonProps {
  onOpen: () => void;
}

export function TallyButton(_props: TallyButtonProps) {
  return null;
}

export interface TallyModeProps {
  /** Non-null while the tally should be open. */
  request: TallyRequest | null;
  onClose: () => void;
}

export function TallyMode(_props: TallyModeProps) {
  return null;
}

export interface TodayTallyLinkProps {
  /**
   * The dashboard's upcomingEvents (already role-scoped by /me/dashboard; an admin's list spans every team). p7 picks
   * today's own-team scheduled or live event (date === todayISO()) and renders a ≥ 40 px link to
   * actionHref.tally({ eventId }); null when there is none (e.g. Sundays, when the seed has no events).
   */
  events: SalesEventWithMeta[];
}

export function TodayTallyLink(_props: TodayTallyLinkProps) {
  return null;
}
