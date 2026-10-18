// Private "Check in with…" list — OWNED BY p4-leader-check-ins-coaching.
// Stub from p1: renders nothing. Mounted (inside ErrorBoundaries) in the leader's team card with insights.team.checkIns,
// and in CompanySection (admin) with insights.company.checkIns and showTeam. Contract:
//   people === null / undefined → render nothing (not entitled, loading, or LM_SMART=0);
//   people === []               → the empty state 'Nobody needs a check-in this week'.
// Title 'Check in with…', subtitle 'Private to you — conversation starters, not verdicts'. Never 'at risk'.
import type { CheckInPerson } from '@lm/shared';

export interface CheckInListProps {
  people: CheckInPerson[] | null | undefined;
  /** Admin view: show each person's team next to their name. */
  showTeam?: boolean;
  className?: string;
}

export function CheckInList(_props: CheckInListProps) {
  return null;
}
