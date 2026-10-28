import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { BoardStreak, LeaderboardRow } from '@lm/shared';
import { Avatar, EmptyState } from '@/components/ui';
import { StreakFlame } from '@/features/smart/StreakFlame';
import { formatNumber, formatPct } from '@/lib/format';

export interface MiniLeaderboardProps {
  rows: LeaderboardRow[];
  highlightUserId?: number;
  limit?: number;
  /** Smart release 1.1 (p2): insights.boardStreaks — a Flame on rows whose streak is ≥ 5 (row.streak also counts). */
  streaks?: readonly BoardStreak[];
}

export function MiniLeaderboard({ rows, highlightUserId, limit = 5, streaks }: MiniLeaderboardProps) {
  // The streaks prop (insights.boardStreaks) wins; rows from GET /leaderboard carry their own row.streak.
  const streakOf = useMemo(() => {
    const byUser = new Map((streaks ?? []).map((s) => [s.userId, s.streak]));
    return (r: LeaderboardRow) => byUser.get(r.userId) ?? r.streak;
  }, [streaks]);
  const top = rows.slice(0, limit);
  if (!top.length) return <EmptyState title="No sales yet this period" size="sm" className="border-0" />;
  return (
    <ol className="divide-y divide-border">
      {top.map((r) => {
        const me = r.userId === highlightUserId;
        return (
          <li key={r.userId} className={`flex items-center gap-3 py-2 ${me ? 'rounded-md bg-primary/5 px-2' : ''}`}>
            <span className="w-5 text-right text-xs font-semibold tabular-nums text-muted">{r.rank}</span>
            <Avatar name={r.userName} color={r.avatarColor} size="sm" />
            {/* -my-3 py-3: a 44 px tall tap target on the name, the row's height unchanged */}
            <Link to={`/team/${r.userId}`} className="-my-3 min-w-0 flex-1 truncate py-3 text-sm font-medium text-fg hover:underline">
              {r.userName}{me && <span className="ml-1 text-xs text-primary">(you)</span>}
            </Link>
            <StreakFlame streak={streakOf(r)} />
            <span className="text-sm font-semibold tabular-nums text-fg">{formatNumber(r.sales)}</span>
            <span className="w-12 text-right text-xs tabular-nums text-muted">{formatPct(r.conversion, 1)}</span>
          </li>
        );
      })}
    </ol>
  );
}
