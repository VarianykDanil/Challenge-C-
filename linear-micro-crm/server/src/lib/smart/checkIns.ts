/**
 * The private "Check in with…" list — OWNED BY p4-leader-check-ins-coaching.
 *
 * checkInList(db, { teamId, excludeUserId }, today): people with status 'active' and role rep / leader — one team, or
 * every team when teamId is null — minus excludeUserId; ranked by shared rankCheckIns (≤ 5 people, score ≥ 2).
 * Called ONLY from GET /me/insights: team (a leader's own team) and company (admin). Reps and recruiters never receive
 * it (P1 guarantees this in routes/insights.ts).
 *
 * 7 SQL statements whatever the team size (none with LM_SMART=0, 1 when nobody is in scope):
 *   1. the people (users ⨝ teams)
 *   2. weeklyHistory: 16 completed weeks + this week, one grouped statement
 *   3. recorded check-ins over 8 weeks (the people's own, and every check-in at their teams' events); since 1.2 a
 *      day's one-tap shift check-in (check_ins, U4) stands in for the gauge entry's own time when there is one
 *   4. the teams' completed event dates over 10 weeks
 *   5. the people's gauge dates over 10 weeks
 *   6. ensurePayrollMaterialised: MAX(week_start) of payroll_runs — the finance routes' guard. Only when last
 *      completed week has no runs yet (a server left running over the weekend, before the daily job) does it create
 *      them first, exactly as start-up, the daily job and /finance would; otherwise a week not yet materialised
 *      would read as £0 and show a false earnings_drop.
 *   7. payroll_runs gross over the last 8 completed weeks
 * Everything else is in memory; the rules and the wording are shared (logic/signals.ts). Apart from that payroll
 * guard it never writes.
 */
import {
  LATE_GRACE_MINUTES,
  checkInWeekTotals,
  minutesLate,
  personSignals,
  rankCheckIns,
  type CheckInPerson,
  type Position,
} from '@lm/shared';
import { all, placeholders, type Db, type Param } from '../../db/connection.ts';
import { ensurePayrollMaterialised } from '../../db/maintenance.ts';
import { addDays, mondayOf } from '../dates.ts';
import { weeklyHistory } from '../history.ts';
import { CHECKED_IN_AT_SQL, SHIFT_CHECK_IN_JOIN } from '../shiftCheckIns.ts';
import { smartEnabled } from './enabled.ts';

export interface CheckInScope {
  /** One team, or null for every team (admin). */
  teamId: number | null;
  /** The caller: never on their own list. */
  excludeUserId: number;
}

interface PersonRow {
  userId: number;
  userName: string;
  position: Position;
  avatarColor: string;
  teamId: number | null;
  teamName: string | null;
  startDate: string;
}

interface LateTally {
  late: number;
  recorded: number;
}

interface CheckInRow {
  userId: number;
  teamId: number;
  date: string;
  startTime: string;
  checkedInAt: string;
}

/** Windows, in days / weeks before today (every window ends the day before today). */
const HISTORY_WEEKS = 16;
const LATE_WINDOW_DAYS = 56;
const RECENT_DAYS = 14;
const ATTENDANCE_WINDOW_DAYS = RECENT_DAYS + 56;
const PAY_WEEKS = 8;

/** How many of the dates fall in [from, to). */
function countIn(dates: Iterable<string>, from: string, to: string): number {
  let n = 0;
  for (const d of dates) if (d >= from && d < to) n++;
  return n;
}

export function checkInList(db: Db, scope: CheckInScope, today: string): CheckInPerson[] {
  if (!smartEnabled()) return [];

  // 1. People: active reps and leaders in scope, never the caller.
  const peopleWhere = [`u.status = 'active'`, `u.role IN ('rep', 'leader')`, 'u.id <> ?'];
  const peopleParams: Param[] = [scope.excludeUserId];
  if (scope.teamId !== null) {
    peopleWhere.push('u.team_id = ?');
    peopleParams.push(scope.teamId);
  }
  const people = all<PersonRow>(
    db,
    `SELECT u.id AS userId, u.first_name || ' ' || u.last_name AS userName, u.position, u.avatar_color AS avatarColor,
            u.team_id AS teamId, t.name AS teamName, u.start_date AS startDate
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE ${peopleWhere.join(' AND ')}
     ORDER BY u.id`,
    peopleParams,
  );
  if (!people.length) return [];
  const ids = people.map((p) => Number(p.userId));
  const idList = placeholders(ids.length);
  const teamIds = [...new Set(people.map((p) => p.teamId).filter((t): t is number => t !== null).map(Number))];

  const thisMonday = mondayOf(today);
  const lastMonday = addDays(thisMonday, -7);
  const lateFrom = addDays(today, -LATE_WINDOW_DAYS);
  const recentFrom = addDays(today, -RECENT_DAYS);
  const attendanceFrom = addDays(today, -ATTENDANCE_WINDOW_DAYS);
  const payFrom = addDays(thisMonday, -7 * PAY_WEEKS);

  // 2. Weekly history (16 completed weeks + this week so far), one grouped statement.
  const history = weeklyHistory(db, { userIds: ids }, HISTORY_WEEKS, today);

  // 3. Recorded check-ins over 8 weeks: the people's own (wherever they worked) and every check-in at their teams'
  //    events (the team's late share). Newest first, so each person's first 10 are their last 10.
  const whose = teamIds.length ? `(e.team_id IN (${placeholders(teamIds.length)}) OR g.user_id IN (${idList}))` : `g.user_id IN (${idList})`;
  const checkIns = all<CheckInRow>(
    db,
    // Release 1.2 (U4): the one-tap check-in when there is one, else the gauge entry's own time.
    `SELECT g.user_id AS userId, e.team_id AS teamId, g.date, e.start_time AS startTime, ${CHECKED_IN_AT_SQL} AS checkedInAt
     FROM gauge_entries g JOIN events e ON e.id = g.event_id ${SHIFT_CHECK_IN_JOIN}
     WHERE g.date >= ? AND g.date < ? AND ${CHECKED_IN_AT_SQL} IS NOT NULL AND ${whose}
     ORDER BY g.date DESC, ${CHECKED_IN_AT_SQL} DESC, g.id DESC`,
    [lateFrom, today, ...teamIds, ...ids],
  );

  // 4. The teams' completed event dates over 10 weeks (a cancelled or still-scheduled day is not a day to work).
  const teamDates = new Map<number, Set<string>>();
  if (teamIds.length) {
    const rows = all<{ teamId: number; date: string }>(
      db,
      `SELECT team_id AS teamId, date FROM events
       WHERE status = 'completed' AND date >= ? AND date < ? AND team_id IN (${placeholders(teamIds.length)})
       GROUP BY team_id, date`,
      [attendanceFrom, today, ...teamIds],
    );
    for (const r of rows) {
      const set = teamDates.get(Number(r.teamId)) ?? new Set<string>();
      set.add(r.date);
      teamDates.set(Number(r.teamId), set);
    }
  }

  // 5. The people's gauge dates over 10 weeks (rows on a live event are not finished yet, as in weeklyHistory).
  const workedDates = new Map<number, Set<string>>();
  for (const r of all<{ userId: number; date: string }>(
    db,
    `SELECT g.user_id AS userId, g.date FROM gauge_entries g JOIN events e ON e.id = g.event_id
     WHERE g.date >= ? AND g.date < ? AND e.status <> 'live' AND g.user_id IN (${idList})
     GROUP BY g.user_id, g.date`,
    [attendanceFrom, today, ...ids],
  )) {
    const set = workedDates.get(Number(r.userId)) ?? new Set<string>();
    set.add(r.date);
    workedDates.set(Number(r.userId), set);
  }

  // 6. Last completed week's runs must exist before its gross is read (a no-op MAX query once they do).
  ensurePayrollMaterialised(db, today);

  // 7. Payroll gross over the last 8 completed weeks (every status: it is what the week earned).
  const gross = new Map<string, number>();
  for (const r of all<{ userId: number; weekStart: string; gross: number }>(
    db,
    `SELECT user_id AS userId, week_start AS weekStart, gross FROM payroll_runs
     WHERE week_start >= ? AND week_start < ? AND user_id IN (${idList})`,
    [payFrom, thisMonday, ...ids],
  )) {
    gross.set(`${r.userId}|${r.weekStart}`, Number(r.gross));
  }
  const payMondays = Array.from({ length: PAY_WEEKS }, (_, i) => addDays(payFrom, 7 * i));

  // Late minutes per person (newest first); late / recorded per team, and each person's own share of their team's
  // tally, so the person is compared with the rest of the team rather than with a figure that includes them.
  const lateByUser = new Map<number, number[]>();
  const teamLate = new Map<number, LateTally>();
  const ownLate = new Map<string, LateTally>();
  const tally = <K>(map: Map<K, LateTally>, key: K, late: boolean) => {
    const t = map.get(key) ?? { late: 0, recorded: 0 };
    t.recorded += 1;
    if (late) t.late += 1;
    map.set(key, t);
  };
  for (const r of checkIns) {
    const mins = minutesLate(r.date, r.startTime, r.checkedInAt);
    if (mins === null) continue;
    const userId = Number(r.userId);
    const list = lateByUser.get(userId) ?? [];
    list.push(mins);
    lateByUser.set(userId, list);
    const late = mins > LATE_GRACE_MINUTES;
    tally(teamLate, Number(r.teamId), late);
    tally(ownLate, `${userId}|${Number(r.teamId)}`, late);
  }
  /** The late share of everyone else's check-ins at the team's events (null when nobody else recorded one). */
  const restOfTeamLateShare = (userId: number, teamId: number | null): number | null => {
    if (teamId === null) return null;
    const team = teamLate.get(teamId) ?? { late: 0, recorded: 0 };
    const own = ownLate.get(`${userId}|${teamId}`) ?? { late: 0, recorded: 0 };
    const recorded = team.recorded - own.recorded;
    return recorded > 0 ? (team.late - own.late) / recorded : null;
  };

  const ranked: CheckInPerson[] = [];
  for (const p of people) {
    const userId = Number(p.userId);
    const teamId = p.teamId === null ? null : Number(p.teamId);
    const h = history.get(userId);
    if (!h) continue;
    const dates = teamId === null ? new Set<string>() : teamDates.get(teamId) ?? new Set<string>();
    const mine = workedDates.get(userId) ?? new Set<string>();
    // Only the team's days since the person started count towards their share.
    const since = (from: string) => (p.startDate > from ? p.startDate : from);
    const teamDaysIn = (from: string, to: string) => [...dates].filter((d) => d >= since(from) && d < to);
    const recentTeam = teamDaysIn(recentFrom, today);
    const priorTeam = teamDaysIn(attendanceFrom, recentFrom);
    const reasons = personSignals({
      today,
      position: p.position,
      startDate: p.startDate,
      weeks16: h.weeks,
      current: h.current,
      lateMinutes: lateByUser.get(userId) ?? [],
      teamLateShare: restOfTeamLateShare(userId, teamId),
      attendance: {
        recentWorked: recentTeam.filter((d) => mine.has(d)).length,
        recentTeamDays: recentTeam.length,
        priorWorked: priorTeam.filter((d) => mine.has(d)).length,
        priorTeamDays: priorTeam.length,
      },
      lastWeek: { workedDays: h.weeks[h.weeks.length - 1]?.days ?? 0, teamEventDays: countIn(dates, lastMonday, thisMonday) },
      weeklyGross: payMondays.map((m) => gross.get(`${userId}|${m}`) ?? 0),
      last4Weeks: checkInWeekTotals(h.weeks.slice(-4)),
    });
    if (!reasons.length) continue;
    ranked.push({
      userId,
      userName: p.userName,
      position: p.position,
      avatarColor: p.avatarColor,
      teamId,
      teamName: p.teamName ?? null,
      score: reasons.reduce((s, r) => s + r.weight, 0),
      reasons,
    });
  }
  return rankCheckIns(ranked);
}
