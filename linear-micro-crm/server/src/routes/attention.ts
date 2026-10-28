/**
 * GET /me/attention → AttentionFeed — OWNED BY p5-needs-attention-feed.
 *
 * The role-scoped "Needs attention" feed behind the bell, the toasts, the tab-title badge and the dashboard card. No
 * table: the feed is derived on every (cached) request from rows the caller may already see, and the shared, pure
 * `attentionItems()` turns them into deterministic items.
 *
 * Scoping lives HERE (the shared rules only ever narrow):
 *  - rep        own gauge rows, own team's events, own pay — never anyone else's rows, runs or candidates;
 *  - leader     the same for themself, plus their own team's rows / members, and candidates they own;
 *  - recruiter  own pay, open candidates they own or nobody owns, interviews they run or own;
 *  - admin      every team, every candidate, own pay plus every pending run in the to-pay window and every failed one.
 *
 * Inputs come from at most 8 statements after `ensurePayrollMaterialised` (the same guard the finance routes use;
 * admin 6, leader 8, recruiter 4, rep 5), plus, for leaders and admins with an event live today, those events'
 * forecasts from the GET /events builder (≤ 2 grouped queries, memoised per data version): pay plan, events dated
 * `from` … tomorrow, gauge rows dated `from` … today (`from` = attentionLookbackFrom: today − 3, or this week's Monday
 * when earlier, so the own-gauge rule sees the whole pay week), active members, runs (unpaid or paid in the last 7
 * days; admin: the Runs to pay card's set), open candidates with a due follow-up (and, for recruiters, the whole
 * pipeline's overdue count: the "Overdue actions" tile), pending interviews of open candidates from
 * `outcomeLookbackFrom(now)` (56 days back: the shared outcome rule's look-back, recruitment.ts) to 2 days ahead, and
 * the caller's usual attendance (pay-cost wording) with, in the same statement, the events they checked in at today.
 * Date-bounded where the table is large: events, gauge rows, runs and the attendance count use their indexes. Open
 * candidates, interviews and the admin's member list are small full scans (no index on interviews.scheduled_at or on
 * candidates' open stages; the seed has ~160 interviews, 120 candidates, 34 users). An index on
 * interviews(scheduled_at) belongs in db/schema.ts, which this package does not own.
 * Cached per user through CACHED_PATHS (20 s, cleared by any write). LM_SMART=0 → `{ items: [], disabled: true }`.
 */
import { Router } from 'express';
import {
  ATTENTION_RULES,
  attentionItems,
  attentionLookbackFrom,
  attentionPayrollWindow,
  outcomeLookbackFrom,
  type AttentionAttendance,
  type AttentionFeed,
  type AttentionInput,
  type AttentionInterview,
  type AttentionNow,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, type Db, type Param } from '../db/connection.ts';
import { ensurePayrollMaterialised } from '../db/maintenance.ts';
import { getPayPlan, listCandidates, listEvents, listPayroll } from '../db/queries.ts';
import { addDays, nowHHMM, nowISO, todayISO } from '../lib/dates.ts';
import { eventForecasts } from '../lib/smart/eventForecast.ts';
import { countOverdueActions } from './recruitment.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { providerAttentionItems, withProviderItems } from '../lib/attention/index.ts';
import { currentUser } from '../middleware/auth.ts';

const DAY_MS = 86_400_000;
const TERMINAL_SQL = `('hired', 'rejected', 'withdrawn')`;

/** The business clock right now (Europe/London when TZ is pinned, as the server scripts do). */
export function attentionNow(): AttentionNow {
  return { today: todayISO(), nowHHMM: nowHHMM(), nowISO: nowISO() };
}

type Entry = AttentionInput['entries'][number];
type Member = AttentionInput['members'][number];

const MEMBER_SELECT = `SELECT id, first_name AS firstName, last_name AS lastName, role, team_id AS teamId, start_date AS startDate, status FROM users`;

/** Gathers the scoped inputs for `me` (one statement per input; none at all for parts the role never sees). Plans: see the header. */
export function attentionInput(db: Db, me: UserWithTeam, now: AttentionNow): AttentionInput {
  const { today } = now;
  const fieldRole = me.role === 'rep' || me.role === 'leader';
  // today − 3, or this week's Monday when earlier: the own-gauge rule asks for any unlogged day of this pay week
  const from = attentionLookbackFrom(today);
  const self: Member = { id: me.id, firstName: me.firstName, lastName: me.lastName, role: me.role, teamId: me.teamId, startDate: me.startDate, status: me.status };

  // (1) the caller's own plan — only the field roles' rows ever mention money for a day
  const plan = fieldRole ? (getPayPlan(db, me.payPlanId) ?? null) : null;

  // (2) events dated `from` … tomorrow: rep / leader their own team, admin all, recruiter none
  const eventsVisible = me.role === 'admin' || (fieldRole && me.teamId !== null);
  const listed = eventsVisible
    ? listEvents(
        db,
        me.role === 'admin' ? 'WHERE e.date BETWEEN ? AND ?' : 'WHERE e.date BETWEEN ? AND ? AND e.team_id = ?',
        me.role === 'admin' ? [from, addDays(today, 1)] : [from, addDays(today, 1), me.teamId],
        'e.date ASC, e.start_time ASC, e.id ASC',
        { from, to: addDays(today, 1) },
      )
    : [];
  // (2b) leader / admin: the forecast of each event live today, so events:behind follows the same rule as the row's
  //      "Behind target" pill. eventForecasts is the GET /events builder (≤ 2 grouped queries, memoised per data version)
  const live = me.role === 'admin' || me.role === 'leader' ? listed.filter((e) => e.status === 'live' && e.date === today) : [];
  const forecasts = live.length ? eventForecasts(db, live, today, now.nowHHMM) : null;
  const events = forecasts?.size ? listed.map((e) => (forecasts.has(e.id) ? { ...e, forecast: forecasts.get(e.id)! } : e)) : listed;

  // (3) gauge rows dated `from` … today: rep own, leader own team's members, admin all
  const ENTRY_SELECT = `SELECT g.id, g.event_id AS eventId, g.user_id AS userId, g.date, g.stops, g.table_count AS "table", g.sales, g.submitted_at AS submittedAt FROM gauge_entries g`;
  let entries: Entry[] = [];
  if (me.role === 'admin') entries = all<Entry>(db, `${ENTRY_SELECT} WHERE g.date BETWEEN ? AND ? ORDER BY g.id`, [from, today]);
  else if (me.role === 'leader' && me.teamId !== null)
    entries = all<Entry>(db, `${ENTRY_SELECT} JOIN users u ON u.id = g.user_id WHERE g.date BETWEEN ? AND ? AND u.team_id = ? ORDER BY g.id`, [from, today, me.teamId]);
  else if (fieldRole) entries = all<Entry>(db, `${ENTRY_SELECT} WHERE g.user_id = ? AND g.date BETWEEN ? AND ? ORDER BY g.id`, [me.id, from, today]);

  // (4) active members in scope: leader own team, admin everyone, rep / recruiter only themself (no query)
  let members: Member[] = [self];
  // (release 1.3: client portal accounts are not members of anything)
  if (me.role === 'admin') members = all<Member>(db, `${MEMBER_SELECT} WHERE status = 'active' AND role <> 'client' ORDER BY id`);
  else if (me.role === 'leader' && me.teamId !== null) members = all<Member>(db, `${MEMBER_SELECT} WHERE team_id = ? AND status = 'active' ORDER BY id`, [me.teamId]);

  // (5) runs: own unpaid (≤ 52 weeks) or paid in the last 7 days; admin also every pending run in the to-pay window and
  //     every failed one whatever its age (GET /finance/payroll?status=pending,failed, the Runs to pay card)
  const ownSince = addDays(today, -7 * ATTENTION_RULES.ownRunsWeeks);
  const paidSince = addDays(today, -ATTENTION_RULES.paidRecentDays);
  const ownClause = `(p.user_id = ? AND p.week_start >= ? AND (p.status IN ('pending', 'failed') OR p.paid_date >= ?))`;
  const ownParams: Param[] = [me.id, ownSince, paidSince];
  const win = attentionPayrollWindow(today);
  const runs =
    me.role === 'admin'
      ? listPayroll(db, `WHERE ${ownClause} OR (p.status = 'pending' AND p.week_start BETWEEN ? AND ?) OR p.status = 'failed'`, [...ownParams, win.from, win.to], 'p.week_start DESC, p.id ASC')
      : listPayroll(db, `WHERE ${ownClause}`, ownParams, 'p.week_start DESC, p.id ASC');

  // (6) open candidates with a follow-up already due: recruiter own + unowned, leader own, admin all
  // (7) pending interviews that involve the caller (admin: all), joined to the candidate's name: from the outcome rule's
  //     56-day look-back (shared needsOutcome decides which still ask) to 2 days ahead (the next-24-hours summary)
  const recruitmentRole = me.role === 'recruiter' || me.role === 'leader' || me.role === 'admin';
  let candidates: AttentionInput['candidates'] = [];
  let interviews: AttentionInterview[] = [];
  let pipelineOverdue: number | null = null;
  if (recruitmentRole) {
    const owner = me.role === 'recruiter' ? ' AND (c.owner_id = ? OR c.owner_id IS NULL)' : me.role === 'leader' ? ' AND c.owner_id = ?' : '';
    candidates = listCandidates(
      db,
      `WHERE c.stage NOT IN ${TERMINAL_SQL} AND c.next_action_at IS NOT NULL AND c.next_action_at <= ?${owner}`,
      me.role === 'admin' ? [now.nowISO] : [now.nowISO, me.id],
      'c.next_action_at ASC, c.id ASC',
    );
    // (6b) recruiter: the whole pipeline's figure (the "Overdue actions" tile), so the item can say how its own count relates
    if (me.role === 'recruiter') pipelineOverdue = countOverdueActions(db, new Date(now.nowISO));
    const nowMs = Date.parse(now.nowISO);
    const lo = outcomeLookbackFrom(now.nowISO);
    const hi = new Date(nowMs + 2 * DAY_MS).toISOString();
    interviews = all<AttentionInterview>(
      db,
      `SELECT i.id, i.candidate_id AS candidateId, i.type, i.scheduled_at AS scheduledAt, i.interviewer_id AS interviewerId,
              NULL AS interviewerName, i.outcome, NULL AS notes,
              TRIM(c.first_name || ' ' || c.last_name) AS candidateName, c.first_name AS candidateFirstName,
              c.owner_id AS candidateOwnerId, c.stage AS candidateStage
       FROM interviews i JOIN candidates c ON c.id = i.candidate_id
       WHERE i.outcome = 'pending' AND i.scheduled_at BETWEEN ? AND ? AND c.stage NOT IN ${TERMINAL_SQL}
       ${me.role === 'admin' ? '' : 'AND (i.interviewer_id = ? OR c.owner_id = ?)'}
       ORDER BY i.scheduled_at ASC, i.id ASC`,
      me.role === 'admin' ? [lo, hi] : [lo, hi, me.id, me.id],
    );
  }

  // (8) how often the caller logged on their team's completed event days in the 4 weeks before the window, and (same
  //     statement, so the feed's budget holds) the events they have checked in at today, for the "Check in at …" item
  let attendance: AttentionAttendance | null = null;
  let checkedInToday: number[] | null = null;
  if (fieldRole && me.teamId !== null) {
    const lastDay = addDays(from, -1);
    const firstDay = addDays(lastDay, -(ATTENTION_RULES.usualAttendanceDays - 1));
    const row = get<{ teamDays: number; workedDays: number; checkedIn: string | null }>(
      db,
      `SELECT COUNT(DISTINCT e.date) AS teamDays,
              COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = ? AND g.date = e.date) THEN e.date END) AS workedDays,
              (SELECT GROUP_CONCAT(k.event_id) FROM check_ins k WHERE k.user_id = ? AND k.date = ?) AS checkedIn
       FROM events e WHERE e.team_id = ? AND e.status = 'completed' AND e.date BETWEEN ? AND ? AND e.date >= ?`,
      [me.id, me.id, today, me.teamId, firstDay, lastDay, me.startDate],
    );
    attendance = { teamDays: Number(row?.teamDays ?? 0), workedDays: Number(row?.workedDays ?? 0) };
    checkedInToday = row?.checkedIn ? row.checkedIn.split(',').map(Number).filter(Number.isSafeInteger) : [];
  }

  return {
    me: { id: me.id, role: me.role, teamId: me.teamId, firstName: me.firstName, twoFactorEnabled: Boolean(me.twoFactorEnabled), startDate: me.startDate },
    plan,
    events,
    entries,
    members,
    runs,
    candidates,
    interviews,
    attendance,
    pipelineOverdue,
    checkedInToday,
  };
}

/** The whole feed for `me` (empty and flagged `disabled` with LM_SMART=0). */
export function buildAttentionFeed(db: Db, me: UserWithTeam, now: AttentionNow = attentionNow()): AttentionFeed {
  if (!smartEnabled()) return { items: [], generatedAt: now.nowISO, disabled: true };
  // Release 1.3 (r3-foundation): the packages' providers (invoices P2, statements P3, client posts P6) join the 1.1 items,
  // sorted and capped by the same rules; with none the feed is exactly the 1.1 feed (lib/attention/index.ts).
  const core = attentionItems(attentionInput(db, me, now), now);
  return { items: withProviderItems(core, providerAttentionItems(db, me, now)), generatedAt: now.nowISO };
}

export function attentionRouter(db: Db): Router {
  const router = Router();
  router.get('/attention', (req, res) => {
    const me = currentUser(req);
    if (!smartEnabled()) return res.json(buildAttentionFeed(db, me));
    const now = attentionNow();
    ensurePayrollMaterialised(db, now.today); // like the finance routes: last week's runs exist before we count them
    res.json(buildAttentionFeed(db, me, now));
  });
  return router;
}
