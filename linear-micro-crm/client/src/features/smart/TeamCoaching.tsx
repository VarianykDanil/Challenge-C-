// Team coaching sentences on the leader's team card — OWNED BY p4-leader-check-ins-coaching.
// Stub from p1: renders nothing. Mounted in the dashboard team card (leader only), after the mini leaderboard, inside
// an ErrorBoundary. Fed from the dashboard's own team totals/ratios (no extra request); p4 renders
// coachingInsights(totals, ratios, BENCHMARK_RATIOS, 'team').
import type { FunnelRatios, GaugeTotals } from '@lm/shared';

export interface TeamCoachingProps {
  totals: GaugeTotals;
  ratios: FunnelRatios;
  className?: string;
}

export function TeamCoaching(_props: TeamCoachingProps) {
  return null;
}
