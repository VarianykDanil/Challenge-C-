// Team coaching sentences on the leader's team card — OWNED BY p4-leader-check-ins-coaching.
// Mounted in the dashboard team card (leader only), after the mini leaderboard, inside an ErrorBoundary. Fed from the
// dashboard's own team totals/ratios for the selected period (no extra request): the shared coaching rules worded
// about the team ("The team's stop-to-table rate is …") with tips a leader can run at the huddle.
import { useId } from 'react';
import clsx from 'clsx';
import type { FunnelRatios, GaugeTotals } from '@lm/shared';
import { CoachingInsights } from '@/features/gauges/CoachingInsights';

export interface TeamCoachingProps {
  totals: GaugeTotals;
  ratios: FunnelRatios;
  className?: string;
}

export function TeamCoaching({ totals, ratios, className }: TeamCoachingProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={clsx('min-w-0', className)}>
      <h4 id={headingId} className="eyebrow mb-2 text-muted">Team coaching</h4>
      <CoachingInsights totals={totals} ratios={ratios} subject="team" />
    </section>
  );
}
