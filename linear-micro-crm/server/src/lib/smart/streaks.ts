/**
 * Sales streaks — OWNED BY p2-personal-pace-streaks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p2 replaces the bodies.
 *
 * personalStreaks: one GROUP BY date over the caller's rows before today (live events excluded); null when none.
 * streaksForUsers: one GROUP BY user_id, date over the last 180 days → Map userId → current streak (capped by the
 *   window). GET /leaderboard attaches `row.streak` for every user id present in the Map.
 * boardStreaks: streaks ≥ 5 for the board the caller sees — P1 scoping rule, which p2 must keep:
 *   rep / leader → their own team (u.team_id = me.teamId; [] without a team); admin → every active rep and leader;
 *   recruiter → [].
 */
import type { BoardStreak, Streaks, UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { smartEnabled } from './enabled.ts';

/** Days of history streaksForUsers reads (a longer streak is reported as this window's length at most). */
export const STREAK_WINDOW_DAYS = 180;
/** boardStreaks lists only streaks at or above this. */
export const BOARD_STREAK_MIN = 5;

export function personalStreaks(db: Db, me: UserWithTeam, today: string): Streaks | null {
  void db;
  void me;
  void today;
  if (!smartEnabled()) return null;
  return null;
}

export function streaksForUsers(db: Db, userIds: readonly number[], today: string): Map<number, number> {
  void db;
  void userIds;
  void today;
  if (!smartEnabled()) return new Map();
  return new Map();
}

export function boardStreaks(db: Db, me: UserWithTeam, today: string): BoardStreak[] {
  void db;
  void me;
  void today;
  if (!smartEnabled()) return [];
  return [];
}
