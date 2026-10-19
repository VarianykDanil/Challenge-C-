// The dashboard's team card: the person's team (or company top performers without a team). Split out of
// pages/Dashboard.tsx by p1 with identical output; leaders get the p4 TeamCoaching and CheckInList slots. Every
// component another package edits (MiniLeaderboard: p2; TeamCoaching, CheckInList: p4) sits in its own ErrorBoundary.
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { BoardStreak, CheckInPerson, Dashboard, LeaderboardRow, Role } from '@lm/shared';
import { Card, CardHeader, EmptyState, Skeleton } from '@/components/ui';
import { ErrorBoundary } from '@/features/common';
import { LazyCheckInList, LazyTeamCoaching } from '@/features/smart';
import { formatNumber, formatPct } from '@/lib/format';
import { MiniLeaderboard } from './MiniLeaderboard';

export interface TeamCardProps {
  dashboard: Dashboard | undefined;
  meId: number;
  role: Role;
  /** Company-wide board for people without a team (useLeaderboard({ period, metric: 'sales' })). */
  companyBoard: { data?: LeaderboardRow[]; isError: boolean };
  /** insights.boardStreaks (p2 flames). */
  streaks?: readonly BoardStreak[];
  /** insights.team?.checkIns — leaders only (p4). */
  checkIns?: CheckInPerson[] | null;
}

const ListSkeleton = () => <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>;

export function TeamCard({ dashboard: d, meId, role, companyBoard, streaks, checkIns }: TeamCardProps) {
  return (
    <Card className="min-w-0">
      <CardHeader title={d?.team ? d.team.teamName : 'Top performers'} description={d?.team ? `${formatNumber(d.team.members)} members · ${formatNumber(d.team.totals.sales)} sales` : d ? 'Across every team this period' : undefined} actions={<Link to="/leaderboard" className="flex items-center gap-1 text-xs text-primary hover:underline">Leaderboard <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
      {!d ? (
        <ListSkeleton />
      ) : !d.team ? (
        companyBoard.data ? <ErrorBoundary name="mini-leaderboard"><MiniLeaderboard rows={companyBoard.data} highlightUserId={meId} streaks={streaks} /></ErrorBoundary> : companyBoard.isError ? <EmptyState title="Leaderboard unavailable" size="sm" className="border-0" /> : <ListSkeleton />
      ) : (
        <>
          <dl className="mb-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-surface-2 p-2"><dt className="text-[11px] text-muted">Stops</dt><dd className="text-sm font-semibold tabular-nums text-fg">{formatNumber(d.team.totals.stops)}</dd></div>
            <div className="rounded-lg bg-surface-2 p-2"><dt className="text-[11px] text-muted">Sales</dt><dd className="text-sm font-semibold tabular-nums text-fg">{formatNumber(d.team.totals.sales)}</dd></div>
            <div className="rounded-lg bg-surface-2 p-2"><dt className="text-[11px] text-muted">Conv.</dt><dd className="text-sm font-semibold tabular-nums text-fg">{formatPct(d.team.ratios.overallConversion, 1)}</dd></div>
          </dl>
          {/* MiniLeaderboard is p2's file (streak flames): its own boundary keeps the card's header and totals. */}
          <ErrorBoundary name="mini-leaderboard"><MiniLeaderboard rows={d.team.leaderboard} highlightUserId={meId} streaks={streaks} /></ErrorBoundary>
          {role === 'leader' && (
            <>
              <ErrorBoundary name="team-coaching" className="mt-4"><LazyTeamCoaching totals={d.team.totals} ratios={d.team.ratios} className="mt-4" /></ErrorBoundary>
              <ErrorBoundary name="team-check-ins" className="mt-4"><LazyCheckInList people={checkIns} className="mt-4" /></ErrorBoundary>
            </>
          )}
        </>
      )}
    </Card>
  );
}
