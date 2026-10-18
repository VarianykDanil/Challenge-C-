/**
 * Weekly gauge history per person (p1 foundation for p2 pace, p4 check-ins and anything else that compares a person
 * with their own usual weeks).
 *
 * `weeks`   — the N completed Mon–Sun weeks before mondayOf(today), oldest first, zero-filled (a week off is a row of
 *             zeros with days = 0, never a missing entry).
 * `current` — this week so far: mondayOf(today) ≤ date < today.
 * Completed means: rows dated today or later never count, and neither do rows on an event whose status is still
 * 'live'. Rows on cancelled events still count (the work was done and paid).
 *
 * ONE grouped SQL statement per call, whatever the scope. Visibility is the caller's job: this function never decides
 * who may see whose history.
 */
import { GAUGE_KEYS, type WeekStat } from '@lm/shared';
import { all, placeholders, type Db, type Param } from '../db/connection.ts';
import { addDays, mondayOf } from './dates.ts';
import { MONDAY_SQL } from './metrics.ts';

/** Whose history to read: explicit people, everyone currently on a team (u.team_id), or everyone. */
export type HistoryScope = { userIds: readonly number[] } | { teamId: number } | { all: true };

export interface UserHistory {
  /** N completed weeks, oldest first, zero-filled. */
  weeks: WeekStat[];
  /** This week so far (Monday up to yesterday); zeros on a Monday. */
  current: WeekStat;
}

interface Row {
  userId: number;
  weekStart: string;
  days: number;
  stops: number;
  table: number;
  presentations: number;
  closes: number;
  taps: number;
  sales: number;
}

const emptyWeek = (weekStart: string): WeekStat => ({ weekStart, days: 0, stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 });

/**
 * Map of userId → { weeks, current }. With `{ userIds }` every requested id is present (zero-filled when they have no
 * rows); with `{ teamId }` or `{ all: true }` only people with at least one counted row in the window appear.
 * Keys are in ascending user id order (or the order of `userIds`).
 */
export function weeklyHistory(db: Db, scope: HistoryScope, weeks: number, today: string): Map<number, UserHistory> {
  const n = Math.max(0, Math.floor(weeks));
  const thisMonday = mondayOf(today);
  const from = addDays(thisMonday, -7 * n);
  const mondays = Array.from({ length: n }, (_, i) => addDays(from, 7 * i));
  const out = new Map<number, UserHistory>();
  const ensure = (userId: number): UserHistory => {
    let h = out.get(userId);
    if (!h) {
      h = { weeks: mondays.map(emptyWeek), current: emptyWeek(thisMonday) };
      out.set(userId, h);
    }
    return h;
  };

  const where = ['g.date >= ?', 'g.date < ?', `e.status <> 'live'`];
  const params: Param[] = [from, today];
  if ('userIds' in scope) {
    const ids = [...new Set(scope.userIds)];
    if (!ids.length) return out;
    for (const id of ids) ensure(id);
    where.push(`g.user_id IN (${placeholders(ids.length)})`);
    params.push(...ids);
  } else if ('teamId' in scope) {
    where.push('u.team_id = ?');
    params.push(scope.teamId);
  }

  const rows = all<Row>(
    db,
    `SELECT g.user_id AS userId, ${MONDAY_SQL} AS weekStart, COUNT(DISTINCT g.date) AS days,
            COALESCE(SUM(g.stops), 0) AS stops, COALESCE(SUM(g.table_count), 0) AS "table",
            COALESCE(SUM(g.presentations), 0) AS presentations, COALESCE(SUM(g.closes), 0) AS closes,
            COALESCE(SUM(g.taps), 0) AS taps, COALESCE(SUM(g.sales), 0) AS sales
     FROM gauge_entries g
     JOIN events e ON e.id = g.event_id
     JOIN users u ON u.id = g.user_id
     WHERE ${where.join(' AND ')}
     GROUP BY g.user_id, weekStart
     ORDER BY g.user_id, weekStart`,
    params,
  );

  const index = new Map(mondays.map((m, i) => [m, i]));
  for (const r of rows) {
    const h = ensure(Number(r.userId));
    const i = index.get(r.weekStart);
    const target = r.weekStart === thisMonday ? h.current : i === undefined ? null : h.weeks[i]!;
    if (!target) continue;
    target.days = Number(r.days);
    for (const k of GAUGE_KEYS) target[k] = Number(r[k]);
  }
  return out;
}
