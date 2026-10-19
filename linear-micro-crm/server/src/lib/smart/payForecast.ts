/**
 * This week's pay estimate — OWNED BY p3-money-forecast-payroll-checks.
 *
 * weekPayForecast: null unless the role is rep or leader and the user has a team. soFar from weekPayFor(monday,
 * today); remaining team event days to Sunday; trailing 8 completed weeks for λ and the ratios. An estimate only:
 * never written to payroll_runs and never changes nextPayAmount. Used by GET /finance/me (`forecast`) and
 * GET /me/insights (`personal.payForecast`).
 *
 * Queries (none per row): the plan, weekPayFor (2–3), one scalar statement (remaining days, team rate) and one grouped
 * statement for the person's worked days in the window. Read-only: nothing here inserts or updates a row.
 */
import { funnelRatios, payForecastFrom, PAY_FORECAST_RULES, type PayForecast } from '@lm/shared';
import { all, get, type Db } from '../../db/connection.ts';
import { getPayPlan } from '../../db/queries.ts';
import { addDays, diffDays, mondayOf, sundayOf } from '../dates.ts';
import type { PayUser } from '../pay.ts';
import { weekPayFor } from '../pay.ts';
import { smartEnabled } from './enabled.ts';

interface DayRow {
  date: string;
  stops: number;
  table: number;
  presentations: number;
  closes: number;
  taps: number;
  sales: number;
}

interface ScalarRow {
  remaining: number;
  teamSales: number;
  teamDays: number;
}

/**
 * remaining  distinct dates of the team's scheduled / live events after today up to Sunday, plus today when a team
 *            event today is scheduled or live and the person has no gauge row today yet;
 * teamSales  the team's sales excluding the person in the trailing window (live events excluded);
 * teamDays   distinct dates of the team's completed events in the same window.
 * Params: teamId, today, sunday, today, userId, today, teamId, userId, from, monday, teamId, from, monday.
 */
const SCALARS_SQL = `
  SELECT
    (SELECT COUNT(DISTINCT e.date) FROM events e
      WHERE e.team_id = ? AND e.status IN ('scheduled', 'live') AND e.date >= ? AND e.date <= ?
        AND (e.date > ? OR NOT EXISTS (SELECT 1 FROM gauge_entries g WHERE g.user_id = ? AND g.date = ?))) AS remaining,
    (SELECT COALESCE(SUM(g.sales), 0) FROM gauge_entries g JOIN users u ON u.id = g.user_id JOIN events e ON e.id = g.event_id
      WHERE u.team_id = ? AND g.user_id <> ? AND g.date >= ? AND g.date < ? AND e.status <> 'live') AS teamSales,
    (SELECT COUNT(DISTINCT e.date) FROM events e
      WHERE e.team_id = ? AND e.status = 'completed' AND e.date >= ? AND e.date < ?) AS teamDays`;

/** The person's worked dates in [from, monday), live events excluded: one row per date. Params: userId, from, monday. */
const DAYS_SQL = `
  SELECT g.date AS date, COALESCE(SUM(g.stops), 0) AS stops, COALESCE(SUM(g.table_count), 0) AS "table",
         COALESCE(SUM(g.presentations), 0) AS presentations, COALESCE(SUM(g.closes), 0) AS closes,
         COALESCE(SUM(g.taps), 0) AS taps, COALESCE(SUM(g.sales), 0) AS sales
  FROM gauge_entries g JOIN events e ON e.id = g.event_id
  WHERE g.user_id = ? AND g.date >= ? AND g.date < ? AND e.status <> 'live'
  GROUP BY g.date ORDER BY g.date`;

export function weekPayForecast(db: Db, user: PayUser, today: string): PayForecast | null {
  if (!smartEnabled()) return null;
  if ((user.role !== 'rep' && user.role !== 'leader') || user.teamId === null) return null;
  const plan = getPayPlan(db, user.payPlanId);
  if (!plan) return null;

  const monday = mondayOf(today);
  const sunday = sundayOf(monday);
  const from = addDays(monday, -7 * PAY_FORECAST_RULES.windowWeeks);
  const week = weekPayFor(db, user, monday, today);
  const soFar = { days: week?.daysWorked ?? 0, sales: week?.sales ?? 0, teamSales: week?.teamSales ?? 0 };

  const s = get<ScalarRow>(db, SCALARS_SQL, [
    user.teamId, today, sunday, today, user.id, today,
    user.teamId, user.id, from, monday,
    user.teamId, from, monday,
  ])!;
  const days = all<DayRow>(db, DAYS_SQL, [user.id, from, monday]).map((d) => ({
    date: d.date,
    stops: Number(d.stops),
    table: Number(d.table),
    presentations: Number(d.presentations),
    closes: Number(d.closes),
    taps: Number(d.taps),
    sales: Number(d.sales),
  }));
  const totals = days.reduce(
    (a, d) => ({ stops: a.stops + d.stops, table: a.table + d.table, presentations: a.presentations + d.presentations, closes: a.closes + d.closes, taps: a.taps + d.taps, sales: a.sales + d.sales }),
    { stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 },
  );
  // Weeks the history covers: from the first worked week in the window up to last week (8 for anyone who has been
  // here all window; fewer for a new starter), so "over the last N weeks" is true.
  const historyWeeks = days.length ? Math.max(1, Math.round(diffDays(mondayOf(days[0]!.date), monday) / 7)) : 0;
  const teamDays = Number(s.teamDays);

  return payForecastFrom({
    plan,
    weekStart: monday,
    soFar,
    remainingDays: Number(s.remaining),
    dailySales: days.map((d) => d.sales),
    ratios: funnelRatios(totals),
    trailingStops: totals.stops,
    teamSalesPerDay: plan.overridePerTeamSale > 0 && teamDays > 0 ? Number(s.teamSales) / teamDays : 0,
    historyWeeks,
  });
}
