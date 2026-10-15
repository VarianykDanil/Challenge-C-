/**
 * Aggregations over gauge entries shared by the dashboard, leaderboard, summaries and performance pages.
 * Team scoping always uses the *user's* team (u.team_id) so that leaderboards, payroll overrides and
 * team dashboards agree with each other.
 */
import {
  funnelRatios,
  movement,
  punctualityRate,
  rankRows,
  sumGauges,
  type FunnelRatios,
  type GaugeSummaryRow,
  type GaugeTotals,
  type LeaderboardRow,
  type TrendPoint,
} from '@lm/shared';
import { all, type Db } from '../db/connection.ts';
import { Where } from '../db/queries.ts';
import { eachDay, eachMonday, formatShort, formatWeek, mondayOf } from './dates.ts';

/** Gauge entries joined to users, events and campaigns: filter on g.*, u.*, e.*, c.*, t.* */
export const GAUGE_FROM = `
  FROM gauge_entries g
  JOIN users u ON u.id = g.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  JOIN events e ON e.id = g.event_id
  JOIN campaigns c ON c.id = e.campaign_id`;

const SUMS = `COALESCE(SUM(g.stops), 0) AS stops, COALESCE(SUM(g.table_count), 0) AS "table",
  COALESCE(SUM(g.presentations), 0) AS presentations, COALESCE(SUM(g.closes), 0) AS closes,
  COALESCE(SUM(g.taps), 0) AS taps, COALESCE(SUM(g.sales), 0) AS sales`;

/** SQL expression for the Monday of g.date (SQLite %w: 0 = Sunday). */
export const MONDAY_SQL = `date(g.date, '-' || ((CAST(strftime('%w', g.date) AS INTEGER) + 6) % 7) || ' days')`;

export interface TotalsWithDays extends GaugeTotals {
  /** distinct rep-days (user × date) */
  days: number;
}

export function totalsFor(db: Db, where: Where): TotalsWithDays {
  const row = all<TotalsWithDays>(
    db,
    `SELECT ${SUMS}, COUNT(DISTINCT g.user_id || '/' || g.date) AS days ${GAUGE_FROM} ${where}`,
    where.params,
  )[0]!;
  return { ...sumGauges([row]), days: Number(row.days) };
}

export function salesPerDay(totals: GaugeTotals, days: number): number {
  return days > 0 ? Math.round((totals.sales / days) * 100) / 100 : 0;
}

/** Relative change vs the previous period; null when the previous value is 0. */
export function relativeDelta(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 10_000;
}

export function conversionOf(t: GaugeTotals): number {
  return t.stops > 0 ? t.sales / t.stops : 0;
}

/** Daily (or weekly) trend across the whole range, zero-filled so charts have a continuous axis. */
export function trendFor(db: Db, where: Where, from: string, to: string, granularity: 'day' | 'week'): TrendPoint[] {
  const rows = all<{ date: string; sales: number; stops: number; presentations: number }>(
    db,
    `SELECT g.date, SUM(g.sales) AS sales, SUM(g.stops) AS stops, SUM(g.presentations) AS presentations
     ${GAUGE_FROM} ${where} GROUP BY g.date`,
    where.params,
  );
  const byKey = new Map<string, TrendPoint>();
  const keys = granularity === 'week' ? eachMonday(from, to) : eachDay(from, to);
  for (const k of keys) byKey.set(k, { date: k, sales: 0, stops: 0, presentations: 0 });
  for (const r of rows) {
    const k = granularity === 'week' ? mondayOf(r.date) : r.date;
    const p = byKey.get(k);
    if (!p) continue;
    p.sales += Number(r.sales);
    p.stops += Number(r.stops);
    p.presentations += Number(r.presentations);
  }
  return [...byKey.values()];
}

/** Share of recorded check-ins that were on time (null when nothing was recorded). */
export function punctualityFor(db: Db, where: Where): number | null {
  const rows = all<{ eventDate: string; startTime: string; checkedInAt: string | null }>(
    db,
    `SELECT e.date AS eventDate, e.start_time AS startTime, g.checked_in_at AS checkedInAt ${GAUGE_FROM} ${where} AND g.checked_in_at IS NOT NULL`,
    where.params,
  );
  const rate = punctualityRate(rows);
  return rate === null ? null : Math.round(rate * 10_000) / 10_000;
}

export type LeaderboardMetric = 'sales' | 'conversion';

type RankRow = Omit<LeaderboardRow, 'rank' | 'movement'>;

function fetchRows(db: Db, from: string, to: string, teamId: number | null | undefined, metric: LeaderboardMetric): RankRow[] {
  void metric;
  const where = new Where().add('g.date BETWEEN ? AND ?', from, to);
  if (teamId) where.add('u.team_id = ?', teamId);
  const rows = all<RankRow>(
    db,
    `SELECT u.id AS userId, u.first_name || ' ' || u.last_name AS userName, u.position, u.avatar_color AS avatarColor,
            u.team_id AS teamId, t.name AS teamName, t.color AS teamColor,
            SUM(g.sales) AS sales, SUM(g.stops) AS stops, COUNT(DISTINCT g.date) AS days
     ${GAUGE_FROM} ${where} GROUP BY u.id`,
    where.params,
  ).map((r) => ({ ...r, conversion: r.stops > 0 ? Math.round((r.sales / r.stops) * 10_000) / 10_000 : 0 }));
  rows.sort((a, b) => a.userName.localeCompare(b.userName)); // stable input order for ties
  return rows;
}

export interface LeaderboardOptions {
  from: string;
  to: string;
  previous: { from: string; to: string };
  teamId?: number | null;
  metric?: LeaderboardMetric;
  limit?: number;
}

/**
 * Ranked rows (shared competition ranking: ties share a rank) with movement vs the previous period
 * (previousRank − currentRank; null when the person was not ranked last period).
 */
export function leaderboard(db: Db, opts: LeaderboardOptions): LeaderboardRow[] {
  const metric = opts.metric ?? 'sales';
  const tieBreak: LeaderboardMetric = metric === 'conversion' ? 'sales' : 'conversion';
  const current = rankRows(fetchRows(db, opts.from, opts.to, opts.teamId, metric), metric, { tieBreak });
  const previous = rankRows(fetchRows(db, opts.previous.from, opts.previous.to, opts.teamId, metric), metric, { tieBreak });
  const prevRank = new Map(previous.map((r) => [r.userId, r.rank]));
  const rows = current.map((r) => ({ ...r, movement: movement(prevRank.get(r.userId), r.rank) }));
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

export type SummaryGroup = 'user' | 'team' | 'campaign' | 'day' | 'week';

export function summaryRows(db: Db, groupBy: SummaryGroup, where: Where): GaugeSummaryRow[] {
  const keyExpr: Record<SummaryGroup, { key: string; label: string; color: string; group: string; order: string }> = {
    user: { key: 'u.id', label: `u.first_name || ' ' || u.last_name`, color: 'u.avatar_color', group: 'u.id', order: 'sales DESC, label ASC' },
    team: { key: `COALESCE(u.team_id, 0)`, label: `COALESCE(t.name, 'No team')`, color: 't.color', group: 'u.team_id', order: 'sales DESC, label ASC' },
    campaign: { key: 'c.id', label: 'c.name', color: 'c.color', group: 'c.id', order: 'sales DESC, label ASC' },
    day: { key: 'g.date', label: 'g.date', color: 'NULL', group: 'g.date', order: 'key ASC' },
    week: { key: MONDAY_SQL, label: MONDAY_SQL, color: 'NULL', group: MONDAY_SQL, order: 'key ASC' },
  };
  const k = keyExpr[groupBy];
  const rows = all<GaugeTotals & { key: string | number; label: string; color: string | null; days: number }>(
    db,
    `SELECT ${k.key} AS key, ${k.label} AS label, ${k.color} AS color, ${SUMS},
            COUNT(DISTINCT g.user_id || '/' || g.date) AS days
     ${GAUGE_FROM} ${where} GROUP BY ${k.group} ORDER BY ${k.order}`,
    where.params,
  );
  return rows.map((r) => {
    const totals = sumGauges([r]);
    const key = String(r.key);
    const label = groupBy === 'day' ? formatShort(key) : groupBy === 'week' ? formatWeek(key) : String(r.label);
    return { key, label, color: r.color ?? null, days: Number(r.days), ...totals, ratios: funnelRatios(totals), salesPerDay: salesPerDay(totals, Number(r.days)) };
  });
}

export function ratiosOf(t: GaugeTotals): FunnelRatios {
  return funnelRatios(t);
}
