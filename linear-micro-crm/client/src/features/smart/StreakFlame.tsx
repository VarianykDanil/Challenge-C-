// Leaderboard streak flame — OWNED BY p2-personal-pace-streaks. Used by MiniLeaderboard (dashboard) and the
// Leaderboard page; import it by file path (it is not in the features/smart barrel, which p1 owns).
// A lucide Flame named '12-day sales streak' plus the number, for streaks of 5 or more; nothing below that, so
// there is never a "lost streak" state on anyone's row.
import { Flame } from 'lucide-react';
import clsx from 'clsx';

/** Flames from this many selling days in a row (matches the server's BOARD_STREAK_MIN). */
const STREAK_FLAME_MIN = 5;

export function StreakFlame({ streak, className }: { streak: number | null | undefined; className?: string }) {
  if (typeof streak !== 'number' || !(streak >= STREAK_FLAME_MIN)) return null;
  const label = `${streak}-day sales streak`;
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums text-accent', className)} title={label}>
      <Flame className="h-3.5 w-3.5" role="img" aria-label={label} />
      <span aria-hidden>{streak}</span>
    </span>
  );
}
