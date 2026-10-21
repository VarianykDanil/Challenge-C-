import { Router } from 'express';
import { z } from 'zod';
import { periodDeltas, type Dashboard, type GaugeTotals } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { Where, countAnnouncements, listAnnouncements, listEvents } from '../db/queries.ts';
import { addDays, previousToDateRange, rangeForPeriod, todayISO } from '../lib/dates.ts';
import { GAUGE_FROM, GAUGE_PAYOUT_SQL, leaderboard, punctualityFor, ratiosOf, salesPerDay, totalsFor, trendFor } from '../lib/metrics.ts';
import { earningsForRange, nextPay } from '../lib/pay.ts';
import { currentUser } from '../middleware/auth.ts';

const rangeParam = z.enum(['week', 'month', 'quarter']).default('week');
/** The dashboard lists the latest five announcements; "Older announcements" (GET /announcements?offset=5) the rest. */
export const DASHBOARD_ANNOUNCEMENTS = 5;

export function dashboardRouter(db: Db): Router {
  const router = Router();

  router.get('/dashboard', (req, res) => {
    const me = currentUser(req);
    const range = rangeParam.parse(req.query.range);
    const today = todayISO();
    const { from, to } = rangeForPeriod(range, today);
    // deltas and movement compare with the same to-date span of the previous week / month / quarter
    const prev = previousToDateRange(range, { from, to });
    const granularity = range === 'quarter' ? 'week' : 'day';

    // ── personal ──
    const own = new Where().add('g.user_id = ?', me.id).add('g.date BETWEEN ? AND ?', from, to);
    const ownPrev = new Where().add('g.user_id = ?', me.id).add('g.date BETWEEN ? AND ?', prev.from, prev.to);
    const totals = totalsFor(db, own);
    const prevTotals = totalsFor(db, ownPrev);
    // reps are ranked against their own team (the board GET /leaderboard shows them); leaders and admins company-wide
    const board = me.role === 'rep'
      ? (me.teamId === null ? [] : leaderboard(db, { from, to, previous: prev, teamId: me.teamId }))
      : leaderboard(db, { from, to, previous: prev });
    const myRow = board.find((r) => r.userId === me.id);
    const pay = nextPay(db, me, today);

    const personal: Dashboard['personal'] = {
      totals: stripDays(totals),
      ratios: ratiosOf(totals),
      days: totals.days,
      salesPerDay: salesPerDay(totals, totals.days),
      deltas: periodDeltas(totals, prevTotals),
      rank: myRow?.rank ?? null,
      rankOutOf: board.length,
      earningsToDate: earningsForRange(db, me, from, to),
      nextPayday: pay.nextPayday,
      nextPayAmount: pay.nextPayAmount,
      punctualityRate: punctualityFor(db, own),
      trend: trendFor(db, own, from, to, granularity),
    };

    // ── team ──
    let team: Dashboard['team'] = null;
    if (me.teamId !== null && me.teamName) {
      const tw = new Where().add('u.team_id = ?', me.teamId).add('g.date BETWEEN ? AND ?', from, to);
      const t = totalsFor(db, tw);
      const members = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE team_id = ? AND status = 'active'`, [me.teamId])!.n;
      team = {
        teamId: me.teamId,
        teamName: me.teamName,
        totals: stripDays(t),
        ratios: ratiosOf(t),
        members: Number(members),
        trend: trendFor(db, tw, from, to, granularity),
        leaderboard: leaderboard(db, { from, to, previous: prev, teamId: me.teamId, limit: 10 }),
      };
    }

    // ── company (admin & leader) ──
    let company: Dashboard['company'] = null;
    if (me.role === 'admin' || me.role === 'leader') {
      const cw = new Where().add('g.date BETWEEN ? AND ?', from, to);
      const c = totalsFor(db, cw);
      // revenue at the payout captured when each day was logged (a later rate change does not restate the past)
      const revenue = get<{ r: number }>(db, `SELECT COALESCE(SUM(g.sales * ${GAUGE_PAYOUT_SQL}), 0) AS r ${GAUGE_FROM} ${cw}`, cw.params)!.r;
      const activeReps = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND role IN ('rep', 'leader')`)!.n;
      // Settled runs due in the range; when nothing was due yet (Mon–Thu of a week) fall back to the runs due in the
      // last 12 weeks up to today, and say so via payrollOnTimeWindow.
      const settledSql = `SELECT COALESCE(SUM(status = 'paid'), 0) AS paid, COUNT(*) AS total FROM payroll_runs WHERE status IN ('paid', 'late') AND due_date BETWEEN ? AND ?`;
      let payrollOnTimeWindow: 'range' | 'last12Weeks' = 'range';
      let settled = get<{ paid: number; total: number }>(db, settledSql, [from, to])!;
      if (!settled.total) {
        payrollOnTimeWindow = 'last12Weeks';
        settled = get<{ paid: number; total: number }>(db, settledSql, [addDays(today, -84), today])!;
      }
      const openCandidates = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM candidates WHERE stage NOT IN ('hired', 'rejected', 'withdrawn')`)!.n;
      const hires = get<{ n: number }>(
        db,
        `SELECT COUNT(DISTINCT candidate_id) AS n FROM stage_changes WHERE to_stage = 'hired' AND substr(changed_at, 1, 10) BETWEEN ? AND ?`,
        [from, to],
      )!.n;
      // one grouped pass over the range instead of a correlated subquery per campaign
      const byCampaign = all<{ campaignId: number; name: string; color: string; sales: number }>(
        db,
        `SELECT c.id AS campaignId, c.name, c.color, COALESCE(s.sales, 0) AS sales
         FROM campaigns c
         LEFT JOIN (
           SELECT e.campaign_id, SUM(g.sales) AS sales FROM gauge_entries g JOIN events e ON e.id = g.event_id
           WHERE g.date BETWEEN ? AND ? GROUP BY e.campaign_id
         ) s ON s.campaign_id = c.id
         WHERE c.active = 1 ORDER BY sales DESC, c.name`,
        [from, to],
      );
      company = {
        totals: stripDays(c),
        ratios: ratiosOf(c),
        activeReps: Number(activeReps),
        revenue: Math.round(Number(revenue) * 100) / 100,
        payrollOnTimeRate: settled.total ? Math.round((Number(settled.paid) / Number(settled.total)) * 10_000) / 10_000 : 0,
        payrollOnTimeWindow,
        openCandidates: Number(openCandidates),
        hiresThisPeriod: Number(hires),
        trend: trendFor(db, cw, from, to, granularity),
        byCampaign,
      };
    }

    // ── upcoming events & announcements ──
    const ew = new Where().add('e.date >= ?', today).add(`e.status IN ('scheduled', 'live')`);
    if (me.role !== 'admin' && me.teamId !== null) ew.add('e.team_id = ?', me.teamId);
    const upcomingEvents = listEvents(db, `${ew}`, ew.params, 'e.date ASC, e.start_time ASC LIMIT 5');

    const dashboard: Dashboard = {
      range,
      from,
      to,
      previous: prev,
      user: me,
      personal,
      team,
      company,
      upcomingEvents,
      announcements: listAnnouncements(db, DASHBOARD_ANNOUNCEMENTS),
      olderAnnouncements: Math.max(0, countAnnouncements(db) - DASHBOARD_ANNOUNCEMENTS),
    };
    res.json(dashboard);
  });

  return router;
}

function stripDays(t: GaugeTotals & { days?: number }): GaugeTotals {
  const { stops, table, presentations, closes, taps, sales } = t;
  return { stops, table, presentations, closes, taps, sales };
}
