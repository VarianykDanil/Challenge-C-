/**
 * Which gauge days pay a base day (MON-1). A day with gauges pays the day rate only when there is evidence the
 * person worked it:
 *  - on one of that day's entries something was logged (any count above 0) AND the person was booked on that event
 *    (event_roster) or checked in to it (check_ins, the one-tap check-in, sent on the day); or
 *  - a leader or the office confirmed the day (pay_day_checks 'confirmed'): by hand on the Days to confirm list, or by
 *    logging the gauges for the person (a leader for their team, the office for anyone).
 * A day a leader or the office marked 'not_worked' is never a base day. Any other day "waits": it is listed for the
 * person's team leader and the office, and it is paid once someone confirms it (while the week is unpaid).
 *
 * Days that already had gauges when the check started (an existing database's upgrade, the end of a fresh demo seed,
 * or the first gauge written on a new install) are recorded as confirmed (source 'before'), so no existing pay changes.
 * Until the meta flag is set, every gauge day counts as before (the core demo seed calculates its runs that way).
 * Sales are never affected: commission is paid on the subs logged (and confirmed by the clients' statements).
 */
import type { PayDayCheck, PayDayDecision, PayDayToCheck, UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { mondayOf, nowISO } from './dates.ts';

/** meta: 'on' once the check applies on this database. */
export const PAY_DAY_CHECKS_KEY = 'ext:pay:day_checks';

export const PAY_DAY_CHECKS_SQL = `
CREATE TABLE IF NOT EXISTS pay_day_checks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'not_worked')),
  source TEXT NOT NULL DEFAULT 'leader',
  decided_by INTEGER,
  decided_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (user_id, date)
);`;

/** True once the check applies on this database. */
export function dayChecksOn(db: Db): boolean {
  return get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [PAY_DAY_CHECKS_KEY])?.value === 'on';
}

/**
 * Switches the check on (once): every (person, day) that has gauges now counts as confirmed ('before'), except `except`
 * (the entries being written that very moment, which are checked like any new one). Does nothing on a database without
 * people yet (a fresh install before its seed). Returns false when it did nothing, else how many days it kept.
 */
export function ensureDayChecks(db: Db, except: readonly { userId: number; date: string }[] = [], at: string = nowISO()): number | false {
  if (dayChecksOn(db)) return false;
  if (!get(db, `SELECT 1 FROM users LIMIT 1`)) return false;
  let kept = 0;
  // all or nothing, inside the caller's transaction or on its own
  db.exec('SAVEPOINT pay_day_checks_on');
  try {
    kept = run(
      db,
      `INSERT OR IGNORE INTO pay_day_checks (user_id, date, decision, source, decided_by, decided_at, note)
       SELECT DISTINCT user_id, date, 'confirmed', 'before', NULL, ?, NULL FROM gauge_entries`,
      [at],
    ).changes;
    for (const e of except) run(db, `DELETE FROM pay_day_checks WHERE user_id = ? AND date = ? AND source = 'before'`, [e.userId, e.date]);
    run(db, `INSERT INTO meta (key, value) VALUES (?, 'on') ON CONFLICT(key) DO UPDATE SET value = 'on'`, [PAY_DAY_CHECKS_KEY]);
    db.exec('RELEASE pay_day_checks_on');
  } catch (err) {
    db.exec('ROLLBACK TO pay_day_checks_on');
    db.exec('RELEASE pay_day_checks_on');
    throw err;
  }
  return kept;
}

/** Whether the person writing gauges for `targetId` confirms the day by doing so: the office, or a leader for someone else. */
export function writerConfirmsDay(me: Pick<UserWithTeam, 'id' | 'role'>, targetId: number): boolean {
  return me.role === 'admin' || (me.role === 'leader' && targetId !== me.id);
}

/**
 * Called by the gauge routes inside their transaction, before the pay is brought up to date: switches the check on
 * when needed (the entries being written are not counted as "before"), and records the day as confirmed when the writer
 * confirms by logging (writerConfirmsDay). An existing decision is kept (a "not worked" stays until someone changes it).
 */
export function noteGaugeWrite(db: Db, me: Pick<UserWithTeam, 'id' | 'role'>, entries: readonly { userId: number; date: string }[]): void {
  ensureDayChecks(db, entries.filter((e) => !writerConfirmsDay(me, e.userId)));
  const at = nowISO();
  for (const e of entries) {
    if (!writerConfirmsDay(me, e.userId)) continue;
    run(
      db,
      `INSERT OR IGNORE INTO pay_day_checks (user_id, date, decision, source, decided_by, decided_at, note) VALUES (?, ?, 'confirmed', 'logged', ?, ?, NULL)`,
      [e.userId, e.date, me.id, at],
    );
  }
}

/** One day of a person's week: whether it pays a base day, and if not why. */
export interface DayStatus {
  date: string;
  counted: boolean;
  /** No decision and no evidence: waiting for a leader or the office. */
  waiting: boolean;
  decision: PayDayDecision | null;
}

/** The evidence for each gauge day of (user, monday..sunday). Params: userId, monday, sunday. */
export const DAY_EVIDENCE_SQL = `
  SELECT g.date AS date,
         MAX((g.stops + g.table_count + g.presentations + g.closes + g.taps + g.sales) > 0
             AND (EXISTS (SELECT 1 FROM event_roster r WHERE r.event_id = g.event_id AND r.user_id = g.user_id)
                  OR EXISTS (SELECT 1 FROM check_ins ci WHERE ci.user_id = g.user_id AND ci.event_id = g.event_id AND ci.date = g.date))) AS evidence,
         (SELECT d.decision FROM pay_day_checks d WHERE d.user_id = g.user_id AND d.date = g.date) AS decision
  FROM gauge_entries g
  WHERE g.user_id = ? AND g.date BETWEEN ? AND ?
  GROUP BY g.date
  ORDER BY g.date`;

/** Each gauge day's status from DAY_EVIDENCE_SQL rows; `on` false: every day counts (the check is not on yet). */
export function dayStatuses(rows: readonly { date: string; evidence: number; decision: string | null }[], on: boolean): DayStatus[] {
  return rows.map((r) => {
    const decision = r.decision === 'confirmed' || r.decision === 'not_worked' ? r.decision : null;
    if (!on) return { date: r.date, counted: true, waiting: false, decision };
    const counted = decision === 'confirmed' || (decision === null && Number(r.evidence) === 1);
    return { date: r.date, counted, waiting: decision === null && !counted, decision };
  });
}

// ───────────────────────────── the Days to confirm list ─────────────────────────────

interface WaitingRow {
  userId: number;
  userName: string;
  teamId: number | null;
  teamName: string | null;
  date: string;
  eventId: number;
  eventName: string;
  stops: number;
  sales: number;
  activity: number;
  booked: number;
  checkedIn: number;
}

/** How far back the list looks: unpaid weeks of the last five weeks. */
export const DAY_CHECK_LOOKBACK_DAYS = 35;

/**
 * Days waiting for a decision, oldest first, for `me`: a leader sees their own team (their own days are the office's to
 * decide, shown as officeOnly), the office everyone. Only weeks still unpaid and not in a payment on its way.
 */
export function daysToCheck(db: Db, me: UserWithTeam, today: string): PayDayToCheck[] {
  if (!dayChecksOn(db)) return [];
  if (me.role !== 'admin' && !(me.role === 'leader' && me.teamId !== null)) return [];
  const since = mondayOf(new Date(Date.parse(`${today}T12:00:00Z`) - DAY_CHECK_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10));
  const scope = me.role === 'admin' ? '' : 'AND u.team_id = ?';
  const rows = all<WaitingRow>(
    db,
    `SELECT g.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, u.team_id AS teamId, t.name AS teamName, g.date,
            g.event_id AS eventId, e.name AS eventName, g.stops, g.sales,
            (g.stops + g.table_count + g.presentations + g.closes + g.taps + g.sales) > 0 AS activity,
            EXISTS (SELECT 1 FROM event_roster r WHERE r.event_id = g.event_id AND r.user_id = g.user_id) AS booked,
            EXISTS (SELECT 1 FROM check_ins ci WHERE ci.user_id = g.user_id AND ci.event_id = g.event_id AND ci.date = g.date) AS checkedIn
     FROM gauge_entries g
     JOIN users u ON u.id = g.user_id
     JOIN events e ON e.id = g.event_id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE g.date >= ? AND g.date < ? ${scope}
       AND u.role <> 'client'
       AND NOT EXISTS (SELECT 1 FROM pay_day_checks d WHERE d.user_id = g.user_id AND d.date = g.date)
       AND NOT EXISTS (SELECT 1 FROM payroll_runs p WHERE p.user_id = g.user_id AND p.week_start = date(g.date, '-6 days', 'weekday 1')
                         AND p.status IN ('paid', 'late'))
     ORDER BY g.date, u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, g.user_id, g.event_id`,
    me.role === 'admin' ? [since, today] : [since, today, me.teamId],
  );
  const byDay = new Map<string, WaitingRow[]>();
  for (const r of rows) {
    const key = `${r.userId}|${r.date}`;
    byDay.set(key, [...(byDay.get(key) ?? []), r]);
  }
  const out: PayDayToCheck[] = [];
  for (const entries of byDay.values()) {
    // a day with evidence on any entry is paid already
    if (entries.some((e) => Number(e.activity) === 1 && (Number(e.booked) === 1 || Number(e.checkedIn) === 1))) continue;
    const first = entries[0]!;
    const anything = entries.some((e) => Number(e.activity) === 1);
    out.push({
      userId: Number(first.userId),
      userName: first.userName,
      teamId: first.teamId === null ? null : Number(first.teamId),
      teamName: first.teamName,
      date: first.date,
      weekStart: mondayOf(first.date),
      reason: anything ? 'not_booked' : 'nothing_logged',
      events: entries.map((e) => ({ eventId: Number(e.eventId), eventName: e.eventName, stops: Number(e.stops), sales: Number(e.sales), booked: Number(e.booked) === 1, checkedIn: Number(e.checkedIn) === 1 })),
      ...(me.role !== 'admin' && Number(first.userId) === me.id ? { officeOnly: true } : {}),
    });
  }
  return out;
}

/** The stored decision for (user, date), with who made it. */
export function dayCheck(db: Db, userId: number, date: string): PayDayCheck | null {
  const r = get<{ userId: number; date: string; decision: PayDayDecision; by: number | null; byName: string | null; at: string; note: string | null }>(
    db,
    `SELECT d.user_id AS userId, d.date, d.decision, d.decided_by AS by,
            CASE WHEN u.id IS NULL THEN NULL ELSE TRIM(u.first_name || ' ' || u.last_name) END AS byName, d.decided_at AS at, d.note
     FROM pay_day_checks d LEFT JOIN users u ON u.id = d.decided_by WHERE d.user_id = ? AND d.date = ?`,
    [userId, date],
  );
  return r ? { ...r, userId: Number(r.userId), by: r.by === null ? null : Number(r.by) } : null;
}

/** Records a leader's or the office's decision (replacing an earlier one). The caller checks who and the week. */
export function saveDayCheck(db: Db, me: UserWithTeam, input: { userId: number; date: string; decision: PayDayDecision; note: string | null }): void {
  run(
    db,
    `INSERT INTO pay_day_checks (user_id, date, decision, source, decided_by, decided_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET decision = excluded.decision, source = excluded.source, decided_by = excluded.decided_by,
       decided_at = excluded.decided_at, note = excluded.note`,
    [input.userId, input.date, input.decision, me.role === 'admin' ? 'office' : 'leader', me.id, nowISO(), input.note],
  );
}

/** The person's waiting and "not worked" days in the week starting `monday` (for the pay breakdown). */
export function weekDayStatus(db: Db, userId: number, monday: string, sunday: string): { waiting: string[]; notWorked: string[] } {
  const days = dayStatuses(all<{ date: string; evidence: number; decision: string | null }>(db, DAY_EVIDENCE_SQL, [userId, monday, sunday]), dayChecksOn(db));
  return { waiting: days.filter((d) => d.waiting).map((d) => d.date), notWorked: days.filter((d) => d.decision === 'not_worked').map((d) => d.date) };
}
