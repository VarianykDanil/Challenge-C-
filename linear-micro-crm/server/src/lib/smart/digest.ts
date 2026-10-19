/**
 * "Your week in review" builder — OWNED BY p9-week-in-review-digest.
 *
 * weekDigest(db, me, monday, today): the caller's digest for the completed Mon–Sun week starting `monday` (the route
 * has already validated and normalised it). This file only GATHERS facts, from the same functions as the tiles, so a
 * digest can never contradict them; the wording is shared and pure (shared/src/logic/digest.ts):
 *   - totalsFor + periodDeltas: the week vs the week before (rep: own rows; leader: own team; admin: everyone);
 *   - rankedBoard({ from: monday, to: sunday, previous, teamId }): the team board the person already sees;
 *   - the stored payroll run for the week, or weekPayFor when there is none yet (rep's bonus and private pay line);
 *   - coachingInsights on the week's funnel (first warning = the weakest stage);
 *   - recruitmentSummary(db, monday, sunday) (admin's hires and applications; the recruiter's week and the one before);
 *   - Σ g.sales × GAUGE_PAYOUT_SQL (the finance summary's revenue); eventForecasts for the team's events next week;
 *   - checkInList(...).length (leader, private, a count only — names never leave this file).
 * Role scoping: every query is limited to what the caller may already see (own rows, own team, or admin everything);
 * a recruiter's digest never reads gauges. Reads only, apart from ensurePayrollMaterialised — the finance routes' guard,
 * which creates last week's payroll runs if the daily job has not yet (never a gauge row).
 * With LM_SMART=0 bullets are [] and text is ''.
 */
import {
  BRAND,
  attentionPayrollWindow,
  buildDigest,
  coachingInsights,
  digestText,
  digestTitle,
  nextWeekStart,
  outcomeLookbackFrom,
  outcomesToRecord,
  paydayForWeek,
  periodDeltas,
  punctualitySummary,
  type AdminDigestFacts,
  type CandidateStage,
  type DigestBoardRow,
  type DigestBullet,
  type DigestFunnel,
  type DigestNextWeek,
  type DigestPay,
  type Insight,
  type LeaderDigestFacts,
  type PayrollStatus,
  type RecruiterDigestFacts,
  type RepDigestFacts,
  type SlaStage,
  type UserWithTeam,
  type WeekDigest,
} from '@lm/shared';
import { all, get, type Db } from '../../db/connection.ts';
import { ensurePayrollMaterialised } from '../../db/maintenance.ts';
import { Where, getPayPlan, listEvents } from '../../db/queries.ts';
import { recruitmentSummary } from '../../routes/recruitment.ts';
import { addDays, nowISO } from '../dates.ts';
import { GAUGE_FROM, GAUGE_PAYOUT_SQL, rankedBoard, ratiosOf, totalsFor, type TotalsWithDays } from '../metrics.ts';
import { weekPayFor } from '../pay.ts';
import { checkInList } from './checkIns.ts';
import { smartEnabled } from './enabled.ts';
import { eventForecasts } from './eventForecast.ts';

/** The empty digest for a week: the title only, no bullets (also the LM_SMART=0 answer). */
export function emptyDigest(me: Pick<UserWithTeam, 'role'>, monday: string): WeekDigest {
  return { weekStart: monday, weekEnd: addDays(monday, 6), role: me.role, title: digestTitle(monday), bullets: [], text: '' };
}

interface Week {
  monday: string;
  sunday: string;
  prevMonday: string;
  prevSunday: string;
}

const OPEN_STAGES: readonly SlaStage[] = ['applied', 'screening', 'interview', 'observation', 'offer'];

/** totalsFor the week and the week before on the same scope, plus periodDeltas' conversion change. */
function funnelFor(db: Db, w: Week, scope: (where: Where) => Where): { funnel: DigestFunnel; totals: TotalsWithDays } {
  const cur = totalsFor(db, scope(new Where()).add('g.date BETWEEN ? AND ?', w.monday, w.sunday));
  const prev = totalsFor(db, scope(new Where()).add('g.date BETWEEN ? AND ?', w.prevMonday, w.prevSunday));
  const deltas = periodDeltas(cur, prev);
  return {
    totals: cur,
    funnel: {
      current: { stops: cur.stops, sales: cur.sales },
      previous: prev.stops > 0 || prev.sales > 0 ? { stops: prev.stops, sales: prev.sales } : null,
      conversionChange: deltas.conversion,
    },
  };
}

/** The ranked board for the week (movement vs the week before) on one team, as the leaderboard shows it. */
function boardFor(db: Db, w: Week, teamId: number): DigestBoardRow[] {
  return rankedBoard(db, { from: w.monday, to: w.sunday, previous: { from: w.prevMonday, to: w.prevSunday }, teamId }).rows.map((r) => ({
    userId: r.userId,
    userName: r.userName,
    rank: r.rank,
    movement: r.movement,
    sales: r.sales,
  }));
}

/** The weakest-stage tip: coachingInsights' first warning, else its next tip, else whatever it leads with. */
function tipFrom(insights: Insight[]): string | null {
  const pick = insights.find((i) => i.tone === 'warning') ?? insights.find((i) => i.tone === 'neutral') ?? insights[0];
  return pick ? pick.body : null;
}

interface StoredRun {
  gross: number;
  status: PayrollStatus;
  dueDate: string;
  paidDate: string | null;
  sales: number;
  bonus: number;
}

function repFacts(db: Db, me: UserWithTeam, w: Week, today: string): RepDigestFacts {
  const { funnel, totals } = funnelFor(db, w, (where) => where.add('g.user_id = ?', me.id));
  const board = me.teamId !== null ? { teamName: me.teamName ?? 'your team', rows: boardFor(db, w, me.teamId), meId: me.id } : null;

  const plan = getPayPlan(db, me.payPlanId);
  const run = get<StoredRun>(
    db,
    `SELECT gross, status, due_date AS dueDate, paid_date AS paidDate, sales, bonus FROM payroll_runs WHERE user_id = ? AND week_start = ?`,
    [me.id, w.monday],
  );
  let pay: DigestPay | null = null;
  if (run) pay = { gross: Number(run.gross), payday: run.dueDate, status: run.status, paidDate: run.paidDate };
  else {
    const estimate = weekPayFor(db, me, w.monday, today);
    if (estimate && estimate.pay.gross > 0) pay = { gross: estimate.pay.gross, payday: paydayForWeek(w.monday), status: 'estimate', paidDate: null };
  }
  const sales = run ? Number(run.sales) : totals.sales;
  const bonus = plan && plan.bonusThreshold > 0 && plan.bonusAmount > 0
    ? { threshold: plan.bonusThreshold, amount: plan.bonusAmount, sales, reached: run ? Number(run.bonus) > 0 : sales >= plan.bonusThreshold }
    : null;

  return { funnel, board, bonus, tip: tipFrom(coachingInsights(totals, ratiosOf(totals))), pay };
}

/** The team's events in the week after the digest week: forecasts for those still to come, actuals for completed ones. */
function nextWeekFor(db: Db, teamId: number, w: Week, today: string): DigestNextWeek {
  const weekStart = nextWeekStart(w.monday);
  const events = listEvents(db, `WHERE e.team_id = ? AND e.date BETWEEN ? AND ? AND e.status <> 'cancelled'`, [teamId, weekStart, addDays(weekStart, 6)]);
  const upcoming = events.filter((e) => (e.status === 'scheduled' || e.status === 'live') && e.date >= today);
  const completed = events.filter((e) => e.status === 'completed');
  const forecasts = eventForecasts(db, upcoming, today);
  const forecasted = upcoming.filter((e) => forecasts.has(e.id));
  return {
    weekStart,
    upcoming: upcoming.length,
    forecasted: forecasted.length,
    expectedSales: forecasted.reduce((a, e) => a + forecasts.get(e.id)!.expectedSales, 0),
    targetSales: (forecasted.length ? forecasted : upcoming).reduce((a, e) => a + e.targetSales, 0),
    completed: completed.length,
    completedSales: completed.reduce((a, e) => a + e.totals.sales, 0),
    completedTarget: completed.reduce((a, e) => a + e.targetSales, 0),
  };
}

function leaderFacts(db: Db, me: UserWithTeam, teamId: number, w: Week, today: string): LeaderDigestFacts {
  const { funnel } = funnelFor(db, w, (where) => where.add('u.team_id = ?', teamId));
  const checkedIn = all<{ eventDate: string; startTime: string; checkedInAt: string }>(
    db,
    `SELECT e.date AS eventDate, e.start_time AS startTime, g.checked_in_at AS checkedInAt ${GAUGE_FROM}
     WHERE u.team_id = ? AND g.date BETWEEN ? AND ? AND g.checked_in_at IS NOT NULL`,
    [teamId, w.monday, w.sunday],
  );
  const punctuality = punctualitySummary(checkedIn);
  const people = checkInList(db, { teamId, excludeUserId: me.id }, today);
  return {
    teamName: me.teamName ?? 'Your team',
    funnel,
    board: boardFor(db, w, teamId),
    late: { late: punctuality.late, recorded: punctuality.recorded },
    nextWeek: nextWeekFor(db, teamId, w, today),
    checkIns: { count: people.length, userIds: people.map((p) => p.userId) },
  };
}

function adminFacts(db: Db, w: Week, today: string): AdminDigestFacts {
  const { funnel } = funnelFor(db, w, (where) => where);
  // revenue at the payout captured when each day was logged — exactly the finance summary's figure for the week
  const revenue = get<{ cur: number; prev: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN g.date >= ? THEN g.sales * ${GAUGE_PAYOUT_SQL} END), 0) AS cur,
            COALESCE(SUM(CASE WHEN g.date < ? THEN g.sales * ${GAUGE_PAYOUT_SQL} END), 0) AS prev
     ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ?`,
    [w.monday, w.monday, w.prevMonday, w.sunday],
  )!;
  const campaigns = all<{ name: string; current: number; previous: number }>(
    db,
    `SELECT c.name, COALESCE(SUM(CASE WHEN g.date >= ? THEN g.sales END), 0) AS current,
            COALESCE(SUM(CASE WHEN g.date < ? THEN g.sales END), 0) AS previous
     FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN campaigns c ON c.id = e.campaign_id
     WHERE g.date BETWEEN ? AND ? GROUP BY c.id ORDER BY c.name`,
    [w.monday, w.monday, w.prevMonday, w.sunday],
  ).map((c) => ({ name: c.name, current: Number(c.current), previous: Number(c.previous) }));
  const recruitment = recruitmentSummary(db, w.monday, w.sunday);
  // failed transfers: the same to-pay window as the Runs to pay card and the bell (week_start in the last 12 weeks)
  const toPay = attentionPayrollWindow(today);
  const payroll = get<{ runs: number; gross: number; unpaidRuns: number; unpaidGross: number; failedRuns: number; failedGross: number }>(
    db,
    `SELECT COALESCE(SUM(week_start = ?), 0) AS runs,
            COALESCE(SUM(CASE WHEN week_start = ? THEN gross END), 0) AS gross,
            COALESCE(SUM(week_start = ? AND status IN ('pending', 'failed')), 0) AS unpaidRuns,
            COALESCE(SUM(CASE WHEN week_start = ? AND status IN ('pending', 'failed') THEN gross END), 0) AS unpaidGross,
            COALESCE(SUM(status = 'failed' AND week_start BETWEEN ? AND ?), 0) AS failedRuns,
            COALESCE(SUM(CASE WHEN status = 'failed' AND week_start BETWEEN ? AND ? THEN gross END), 0) AS failedGross
     FROM payroll_runs`,
    [w.monday, w.monday, w.monday, w.monday, toPay.from, toPay.to, toPay.from, toPay.to],
  )!;
  const round2 = (n: number) => Math.round(Number(n) * 100) / 100;
  const payday = paydayForWeek(w.monday);
  return {
    companyName: BRAND.name,
    funnel,
    revenue: { current: round2(revenue.cur), previous: round2(revenue.prev) },
    campaigns,
    recruitment: { applied: recruitment.applied, hired: recruitment.hired },
    payroll: {
      payday,
      paydayPassed: payday < today,
      runs: Number(payroll.runs),
      gross: round2(payroll.gross),
      unpaidRuns: Number(payroll.unpaidRuns),
      unpaidGross: round2(payroll.unpaidGross),
      failedRuns: Number(payroll.failedRuns),
      failedGross: round2(payroll.failedGross),
    },
  };
}

function recruiterFacts(db: Db, me: UserWithTeam, w: Week): RecruiterDigestFacts {
  const cur = recruitmentSummary(db, w.monday, w.sunday);
  const prev = recruitmentSummary(db, w.prevMonday, w.prevSunday);
  const interviewsIn = (s: typeof cur) => s.weekly.reduce((a, x) => a + x.interviews, 0);
  // the shared interview-outcome rule (needsOutcome + open candidate + interviewer or owner), as the bell applies it
  const now = nowISO();
  const pending = all<{ id: number; candidateId: number; interviewerId: number | null; outcome: 'pending'; scheduledAt: string; candidateStage: CandidateStage; ownerId: number | null }>(
    db,
    `SELECT i.id, i.candidate_id AS candidateId, i.interviewer_id AS interviewerId, i.outcome, i.scheduled_at AS scheduledAt,
            c.stage AS candidateStage, c.owner_id AS ownerId
     FROM interviews i JOIN candidates c ON c.id = i.candidate_id
     WHERE i.outcome = 'pending' AND i.scheduled_at BETWEEN ? AND ? AND (i.interviewer_id = ? OR c.owner_id = ?)`,
    [outcomeLookbackFrom(now), now, me.id, me.id],
  );
  const owners = new Map(pending.map((p) => [p.candidateId, p.ownerId]));
  return {
    applied: { current: cur.applied, previous: prev.applied },
    interviews: { current: interviewsIn(cur), previous: interviewsIn(prev) },
    hired: { current: cur.hired, previous: prev.hired },
    overdueActions: cur.overdueActions,
    outcomesToRecord: outcomesToRecord(pending, me, (id) => owners.get(id), now).length,
    openPipeline: OPEN_STAGES.reduce((a, s) => a + (cur.openByStage[s] ?? 0), 0),
  };
}

export function weekDigest(db: Db, me: UserWithTeam, monday: string, today: string): WeekDigest {
  if (!smartEnabled()) return emptyDigest(me, monday);
  const w: Week = { monday, sunday: addDays(monday, 6), prevMonday: addDays(monday, -7), prevSunday: addDays(monday, -1) };
  const facts = { weekStart: w.monday, weekEnd: w.sunday };
  let bullets: DigestBullet[] = [];
  if (me.role === 'recruiter') {
    bullets = buildDigest('recruiter', { ...facts, recruiter: recruiterFacts(db, me, w) });
  } else {
    // like the finance routes: last week's runs exist before the pay and payroll lines read them
    ensurePayrollMaterialised(db, today);
    if (me.role === 'admin') bullets = buildDigest('admin', { ...facts, admin: adminFacts(db, w, today) });
    else if (me.role === 'leader' && me.teamId !== null) bullets = buildDigest('leader', { ...facts, leader: leaderFacts(db, me, me.teamId, w, today) });
    // reps, and a leader without a team (their own week, like a rep's)
    else bullets = buildDigest('rep', { ...facts, rep: repFacts(db, me, w, today) });
  }
  const title = digestTitle(monday);
  return { weekStart: w.monday, weekEnd: w.sunday, role: me.role, title, bullets, text: digestText({ title, bullets }) };
}
