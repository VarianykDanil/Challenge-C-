/**
 * Sales streaks — OWNED BY p2-personal-pace-streaks (stub and signatures laid down by p1).
 *
 * personalStreaks: one GROUP BY date over the caller's rows before today (live events excluded); null when none.
 * streaksForUsers: one GROUP BY user_id, date over the last 180 days → Map userId → current streak (capped by the
 *   window). Every requested id is in the Map (0 without a selling run), so GET /leaderboard gives every row a numeric
 *   `streak`.
 * boardStreaks: streaks ≥ 5 for the board the caller sees — P1 scoping rule, kept here:
 *   rep / leader → their own team (u.team_id = me.teamId; [] without a team); admin → every active rep and leader;
 *   recruiter → [].
 * Rows on cancelled events count (the work was done); rows on live events and rows dated today or later never do.
 * Nothing here writes to the database.
 */
import { PERSONAL_BEST_MIN_DAYS, personalBestWeek, salesStreaks, type BoardStreak, type SalesDay, type Streaks, type UserWithTeam } from '@lm/shared';
import { all, placeholders, type Db, type Param } from '../../db/connection.ts';
import { addDays, mondayOf } from '../dates.ts';
import { smartEnabled } from './enabled.ts';

/** Days of history streaksForUsers reads (a longer streak is reported as this window's length at most). */
export const STREAK_WINDOW_DAYS = 180;
/** boardStreaks lists only streaks at or above this. */
export const BOARD_STREAK_MIN = 5;

interface UserDayRow {
  userId: number;
  date: string;
  sales: number;
}

/**
 * ONE grouped statement: per person and worked date, the sales logged, over [from, today), live events excluded.
 * `scope` adds the WHERE terms that pick whose rows; the result is grouped by person, dates ascending.
 */
function salesDaysByUser(db: Db, scope: { sql: string; params: Param[]; joinUsers?: boolean }, from: string | null, today: string): Map<number, SalesDay[]> {
  const where = [scope.sql, 'g.date < ?', `e.status <> 'live'`];
  const params: Param[] = [...scope.params, today];
  if (from) {
    where.push('g.date >= ?');
    params.push(from);
  }
  const rows = all<UserDayRow>(
    db,
    `SELECT g.user_id AS userId, g.date AS date, COALESCE(SUM(g.sales), 0) AS sales
     FROM gauge_entries g
     JOIN events e ON e.id = g.event_id
     ${scope.joinUsers ? 'JOIN users u ON u.id = g.user_id' : ''}
     WHERE ${where.join(' AND ')}
     GROUP BY g.user_id, g.date
     ORDER BY g.user_id, g.date`,
    params,
  );
  const out = new Map<number, SalesDay[]>();
  for (const r of rows) {
    const id = Number(r.userId);
    let list = out.get(id);
    if (!list) out.set(id, (list = []));
    list.push({ date: r.date, sales: Number(r.sales) });
  }
  return out;
}

export function personalStreaks(db: Db, me: UserWithTeam, today: string): Streaks | null {
  if (!smartEnabled()) return null;
  if (me.role === 'recruiter') return null;
  const days = salesDaysByUser(db, { sql: 'g.user_id = ?', params: [me.id] }, null, today).get(me.id);
  if (!days?.length) return null;

  const { current, best } = salesStreaks(days, today);
  const thisMonday = mondayOf(today);
  const weeks = new Map<string, { sales: number; days: number }>();
  let weekSales = 0;
  for (const d of days) {
    if (d.date >= thisMonday) {
      weekSales += d.sales;
      continue;
    }
    const monday = mondayOf(d.date);
    const w = weeks.get(monday) ?? { sales: 0, days: 0 };
    w.sales += d.sales;
    w.days += 1;
    weeks.set(monday, w);
  }
  const previous = [...weeks.values()];
  const bestPreviousWeekSales = previous.reduce((m, w) => (w.days >= PERSONAL_BEST_MIN_DAYS && w.sales > m ? w.sales : m), 0);
  return {
    current,
    best,
    personalBestWeek: personalBestWeek(previous, { sales: weekSales }),
    weekSales,
    bestPreviousWeekSales,
  };
}

export function streaksForUsers(db: Db, userIds: readonly number[], today: string): Map<number, number> {
  if (!smartEnabled()) return new Map();
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const byUser = salesDaysByUser(db, { sql: `g.user_id IN (${placeholders(ids.length)})`, params: ids }, addDays(today, -STREAK_WINDOW_DAYS), today);
  return new Map(ids.map((id) => [id, salesStreaks(byUser.get(id) ?? [], today).current]));
}

export function boardStreaks(db: Db, me: UserWithTeam, today: string): BoardStreak[] {
  if (!smartEnabled()) return [];
  let scope: { sql: string; params: Param[]; joinUsers: true };
  if (me.role === 'admin') scope = { sql: `u.status = 'active' AND u.role IN ('rep', 'leader')`, params: [], joinUsers: true };
  else if ((me.role === 'rep' || me.role === 'leader') && me.teamId !== null) scope = { sql: 'u.team_id = ?', params: [me.teamId], joinUsers: true };
  else return [];
  const byUser = salesDaysByUser(db, scope, addDays(today, -STREAK_WINDOW_DAYS), today);
  const out: BoardStreak[] = [];
  for (const [userId, days] of byUser) {
    const streak = salesStreaks(days, today).current;
    if (streak >= BOARD_STREAK_MIN) out.push({ userId, streak });
  }
  return out.sort((a, b) => b.streak - a.streak || a.userId - b.userId);
}
