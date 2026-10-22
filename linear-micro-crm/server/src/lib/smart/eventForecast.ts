/**
 * Event forecasts — OWNED BY p6-event-forecasts-roster (signatures laid down by p1).
 *
 * eventForecasts(db, events, today): scheduled / live events only (completed and cancelled get none); at most 2
 * grouped queries per call whatever the number of events (none when no event qualifies or both results are memoised);
 * returns eventId → forecast. GET /events and GET /events/:id attach `forecast` for every event id present in the Map.
 * forecastFor(db, params, today): backs GET /events/forecast (route, validation and role check wired by P1).
 *
 * Attendance is the team's own habit: expectedReps = the mean number of distinct reps over the team's completed events
 * with at least one entry in the last 8 weeks (null below 5 such events). Release 1.3 (P8, owner of this file in 1.3):
 * BOOKINGS FEED FORECASTS — for every caller (GET /events, the Needs-attention "behind target" item, the digest), because
 * the bookings are read here, in the same grouped query as the habit (never from an attached `bookings` key):
 * expectedReps = shared expectedHeadcount — the people booked once a leader or the office has booked anyone; the larger
 * of the self-bookings and the habit while only self-bookings exist; and on a live event with bookings, at least the
 * people who have logged it (walk-ups). People who have left are not counted. Nobody booked → the habit, as in 1.1. The
 * chip then reads "· 4 booked" instead of "· 5 reps usually". The rate
 * is sales per rep-day over 12 weeks of completed events, from the first bucket with ≥ 5 events in the chain
 * team (same campaign + type) → company (campaign + type) → campaign alone. The maths is shared/logic/eventForecast.ts.
 * eventRosters(db, events, today): "4 / 7 logged" for completed / live events dated today − 2 … today (one grouped
 * query): the team's active members who had started by the event date, and how many of them have an entry.
 *
 * Throughput: GET /events is not response-cached, so the grouped results are memoised per database, data version,
 * business day and id set (see `remember`). Every write bumps the data version, so a saved gauge is visible on the very
 * next read; only the cheap per-event maths (including the live flag, which moves with the clock) runs per request.
 * Read-only: nothing here writes a row (never a gauge, never payroll).
 */
import { EVENT_FORECAST_RULES, eventForecastFrom, expectedHeadcount, inRosterWindow, pickRate, type EventForecast, type EventRosterCount, type EventStatus, type EventType, type RateBucket, type SalesEventWithMeta } from '@lm/shared';
import { all, placeholders, type Db } from '../../db/connection.ts';
import { CACHE_TTL_MS, currentDataVersion } from '../cache.ts';
import { addDays, nowHHMM } from '../dates.ts';
import { smartEnabled } from './enabled.ts';

interface MemoSlot {
  version: number;
  today: string;
  born: number;
  entries: Map<string, unknown>;
}

/** Grouped query results per database. A slot lives for one data version and one business day (and the cache TTL). */
const memo = new WeakMap<Db, MemoSlot>();
/** Distinct id sets remembered per slot (admin, each leader's team, each rep's team, the dashboard's dates…). */
const MEMO_MAX_ENTRIES = 64;

/**
 * The memoised result of `build` for `key`. Stale the moment the data version moves (every mutating API request and
 * every maintenance job bumps it, as for the response cache), the business day changes, or CACHE_TTL_MS passes (a
 * guard against a write that skipped the bump). Values are shared between requests and must be treated as read-only.
 */
function remember<T>(db: Db, today: string, key: string, build: () => T): T {
  const version = currentDataVersion();
  const now = Date.now();
  let slot = memo.get(db);
  if (!slot || slot.version !== version || slot.today !== today || now - slot.born > CACHE_TTL_MS) {
    slot = { version, today, born: now, entries: new Map() };
    memo.set(db, slot);
  }
  if (slot.entries.has(key)) return slot.entries.get(key) as T;
  const value = build();
  if (slot.entries.size >= MEMO_MAX_ENTRIES) {
    const oldest = slot.entries.keys().next().value;
    if (oldest !== undefined) slot.entries.delete(oldest);
  }
  slot.entries.set(key, value);
  return value;
}

const idKey = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(',');

export interface ForecastParams {
  campaignId: number;
  teamId: number;
  type: EventType;
  /** The target being considered (repsNeeded / flag); omitted → no target yet. */
  targetSales?: number;
}

/** What the builder needs to know about one event (a listed event, or the one being planned). */
interface ForecastTarget {
  id: number;
  campaignId: number;
  teamId: number;
  type: EventType;
  targetSales: number;
  status: EventStatus;
  startTime: string;
  endTime: string;
  salesSoFar: number;
  /** Release 1.3 (P8): distinct people who have logged the event so far (walk-ups on a live day). */
  logged: number;
}

/** Query 1's rows: 'a' = one completed event's distinct reps (id = its team); 'b' = one event's bookings (id = the event). */
interface PeopleRow {
  kind: 'a' | 'b';
  id: number;
  n: number;
  managed: number;
}

interface RateRow {
  teamId: number;
  campaignId: number;
  type: EventType;
  sales: number;
  repDays: number;
}

interface Acc {
  events: number;
  sales: number;
  repDays: number;
}

const add = (map: Map<string, Acc>, key: string, sales: number, repDays: number) => {
  const acc = map.get(key);
  if (acc) {
    acc.events += 1;
    acc.sales += sales;
    acc.repDays += repDays;
  } else map.set(key, { events: 1, sales, repDays });
};

const toBucket = (basis: RateBucket['basis'], acc: Acc | undefined): RateBucket | null => (acc ? { basis, ...acc } : null);

interface Attendance {
  events: number;
  total: number;
}

/** Release 1.3 (P8): active people booked on an event, and whether a leader or the office booked any of them. */
interface Booked {
  booked: number;
  managed: boolean;
}

interface People {
  attendance: Map<number, Attendance>;
  bookings: Map<number, Booked>;
}

/** Release 1.3 (P8): who an event is expected to have — exported for the plans (lib/venueInsights.ts). */
export interface EventHeadcount {
  /** expectedHeadcount (may be a mean); null when nobody is booked and the team has too little history. */
  people: number | null;
  booked: number;
  managed: boolean;
  habit: number | null;
}

interface Rates {
  byCampaign: Map<string, Acc>;
  byCompany: Map<string, Acc>;
  byTeam: Map<string, Acc>;
  /** Per-event sales of each team + campaign + type, for the suggested target's percentile. */
  teamSales: Map<string, number[]>;
}

/**
 * Query 1 — who is expected, in ONE statement:
 *  - attendance ('a'): distinct reps per completed event of these teams over the last 8 weeks (today excluded), folded
 *    into a per-team mean. COUNT(*) is the distinct rep count: UNIQUE(event_id, user_id, date) and an entry's date is its
 *    event's date. The (team_id, date) index bounds the read to the window.
 *  - bookings ('b', release 1.3, P8): active people booked per event (event_roster's primary key), and whether any of
 *    them was booked by a leader or the office (source 'leader'). Read here rather than from an attached `bookings`
 *    key, so every caller of eventForecasts sees the same numbers.
 */
function peopleFor(db: Db, teamIds: readonly number[], eventIds: readonly number[], today: string): People {
  return remember(db, today, `people|${idKey(teamIds)}|${idKey(eventIds)}`, () => {
    let sql = `SELECT 'a' AS kind, e.team_id AS id, COUNT(*) AS n, 0 AS managed
       FROM events e JOIN gauge_entries g ON g.event_id = e.id
       WHERE e.team_id IN (${placeholders(teamIds.length)}) AND e.status = 'completed' AND e.date >= ? AND e.date < ?
       GROUP BY e.id`;
    const params: (number | string)[] = [...teamIds, addDays(today, -7 * EVENT_FORECAST_RULES.attendanceWeeks), today];
    if (eventIds.length) {
      sql += `
       UNION ALL
       SELECT 'b' AS kind, r.event_id AS id, COUNT(*) AS n, MAX(r.source = 'leader') AS managed
       FROM event_roster r JOIN users u ON u.id = r.user_id AND u.status = 'active'
       WHERE r.event_id IN (${placeholders(eventIds.length)})
       GROUP BY r.event_id`;
      params.push(...eventIds);
    }
    const out: People = { attendance: new Map(), bookings: new Map() };
    for (const r of all<PeopleRow>(db, sql, params)) {
      const id = Number(r.id);
      if (r.kind === 'b') {
        out.bookings.set(id, { booked: Number(r.n), managed: Number(r.managed) === 1 });
        continue;
      }
      const acc = out.attendance.get(id) ?? { events: 0, total: 0 };
      acc.events += 1;
      acc.total += Number(r.n);
      out.attendance.set(id, acc);
    }
    return out;
  });
}

/** The headcount of one target from query 1 (shared expectedHeadcount). */
function headcountOf(t: ForecastTarget, people: People): EventHeadcount {
  const att = people.attendance.get(t.teamId);
  const habit = att && att.events >= EVENT_FORECAST_RULES.minBasisDays ? att.total / att.events : null;
  const b = people.bookings.get(t.id) ?? { booked: 0, managed: false };
  return { people: expectedHeadcount({ habit, booked: b.booked, managed: b.managed, live: t.status === 'live', logged: t.logged }), booked: b.booked, managed: b.managed, habit };
}

const peopleOf = (db: Db, targets: readonly ForecastTarget[], today: string) =>
  peopleFor(db, [...new Set(targets.map((t) => t.teamId))], targets.map((t) => t.id).filter((id) => id > 0), today);

/**
 * Query 2 — rates: sales and rep-days per completed event of these campaigns over the last 12 weeks (today excluded),
 * folded into the three buckets of the fallback chain. The date index is pinned so the read stays bounded by the
 * 12-week window as history grows (the campaign index alone would read every day the campaigns ever ran).
 */
function ratesFor(db: Db, campaignIds: readonly number[], today: string): Rates {
  return remember(db, today, `rates|${idKey(campaignIds)}`, () => {
    const rows = all<RateRow>(
      db,
      `SELECT e.team_id AS teamId, e.campaign_id AS campaignId, e.type AS type, SUM(g.sales) AS sales, COUNT(*) AS repDays
       FROM events e INDEXED BY idx_events_date JOIN gauge_entries g ON g.event_id = e.id
       WHERE e.date >= ? AND e.date < ? AND e.status = 'completed' AND e.campaign_id IN (${placeholders(campaignIds.length)})
       GROUP BY e.id
       ORDER BY e.id`,
      [addDays(today, -7 * EVENT_FORECAST_RULES.rateWeeks), today, ...campaignIds],
    );
    const rates: Rates = { byCampaign: new Map(), byCompany: new Map(), byTeam: new Map(), teamSales: new Map() };
    for (const r of rows) {
      const sales = Number(r.sales);
      const repDays = Number(r.repDays);
      const company = `${r.campaignId}|${r.type}`;
      const team = `${company}|${r.teamId}`;
      add(rates.byCampaign, String(r.campaignId), sales, repDays);
      add(rates.byCompany, company, sales, repDays);
      add(rates.byTeam, team, sales, repDays);
      const list = rates.teamSales.get(team);
      if (list) list.push(sales);
      else rates.teamSales.set(team, [sales]);
    }
    return rates;
  });
}

/**
 * The two grouped queries (memoised), then pure per-event maths. Every completed event in a window counts once, with
 * its distinct reps (query 1) or its sales and rep-days (query 2); a completed event nobody logged is not a comparable
 * day.
 */
function buildForecasts(db: Db, targets: readonly ForecastTarget[], today: string, now: string): Map<number, EventForecast> {
  const out = new Map<number, EventForecast>();
  if (!targets.length) return out;
  const people = peopleOf(db, targets, today);
  const { byCampaign, byCompany, byTeam, teamSales } = ratesFor(db, [...new Set(targets.map((t) => t.campaignId))], today);

  for (const t of targets) {
    // Release 1.3 (P8): who is expected — the bookings, the habit and (live) the people who have logged
    const expectedReps = headcountOf(t, people).people;
    const company = `${t.campaignId}|${t.type}`;
    const team = `${company}|${t.teamId}`;
    const bucket = pickRate({
      team: toBucket('team', byTeam.get(team)),
      company: toBucket('company', byCompany.get(company)),
      campaign: toBucket('campaign', byCampaign.get(String(t.campaignId))),
    });
    const forecast = eventForecastFrom({
      expectedReps,
      bucket,
      targetSales: t.targetSales,
      status: t.status,
      startTime: t.startTime,
      endTime: t.endTime,
      nowHHMM: now,
      salesSoFar: t.salesSoFar,
      teamEventSales: teamSales.get(team) ?? [],
    });
    if (forecast) out.set(t.id, forecast);
  }
  return out;
}

/** The scheduled and live events of a list, as forecast targets (the same list → the same memoised query 1). */
function targetsOf(events: readonly SalesEventWithMeta[]): ForecastTarget[] {
  const targets: ForecastTarget[] = [];
  for (const e of events) {
    if (e.status !== 'scheduled' && e.status !== 'live') continue;
    targets.push({
      id: e.id,
      campaignId: e.campaignId,
      teamId: e.teamId,
      type: e.type,
      targetSales: e.targetSales,
      status: e.status,
      startTime: e.startTime,
      endTime: e.endTime,
      salesSoFar: e.totals.sales,
      logged: e.repCount,
    });
  }
  return targets;
}

/** Forecasts for the scheduled and live events in `events`; `now` ("HH:MM", business clock) drives the live flag. */
export function eventForecasts(db: Db, events: readonly SalesEventWithMeta[], today: string, now: string = nowHHMM()): Map<number, EventForecast> {
  if (!smartEnabled()) return new Map();
  return buildForecasts(db, targetsOf(events), today, now);
}

/**
 * Release 1.3 (P8): who each scheduled or live event in `events` is expected to have — the forecast's own headcount
 * (query 1, memoised: passing the list GET /events forecast costs no statement), for the plans' event share.
 */
export function eventHeadcounts(db: Db, events: readonly SalesEventWithMeta[], today: string): Map<number, EventHeadcount> {
  const targets = targetsOf(events);
  const out = new Map<number, EventHeadcount>();
  if (!targets.length) return out;
  const people = peopleOf(db, targets, today);
  for (const t of targets) out.set(t.id, headcountOf(t, people));
  return out;
}

/** A new (scheduled) event for this team, campaign and type; without targetSales, repsNeeded and flag are null. */
export function forecastFor(db: Db, params: ForecastParams, today: string): EventForecast | null {
  if (!smartEnabled()) return null;
  const hasTarget = params.targetSales !== undefined;
  const target: ForecastTarget = {
    id: 0,
    campaignId: params.campaignId,
    teamId: params.teamId,
    type: params.type,
    targetSales: params.targetSales ?? 0,
    status: 'scheduled',
    startTime: '00:00',
    endTime: '23:59',
    salesSoFar: 0,
    logged: 0,
  };
  const forecast = buildForecasts(db, [target], today, '00:00').get(0) ?? null;
  if (!forecast || hasTarget) return forecast;
  return { ...forecast, repsNeeded: null, flag: null };
}

interface RosterRow {
  eventId: number;
  members: number;
  logged: number;
}

/**
 * "4 / 7 logged" for the completed and live events in `events` dated today − 2 … today, in one grouped query (none when
 * no event qualifies). members = the event team's active members who had started by the event date; logged = how many
 * of them have an entry. Admins and other teams' people who logged there are left out, so logged ≤ members, and the
 * numbers match the event page's "Not logged yet" list (same people, same rule).
 */
export function eventRosters(db: Db, events: readonly SalesEventWithMeta[], today: string): Map<number, EventRosterCount> {
  const out = new Map<number, EventRosterCount>();
  if (!smartEnabled()) return out;
  const ids = events.filter((e) => inRosterWindow(e, today)).map((e) => e.id);
  if (!ids.length) return out;
  const rows = remember(db, today, `roster|${idKey(ids)}`, () =>
    all<RosterRow>(
      db,
      `SELECT e.id AS eventId, COUNT(DISTINCT u.id) AS members, COUNT(DISTINCT g.user_id) AS logged
       FROM events e
       JOIN users u ON u.team_id = e.team_id AND u.status = 'active' AND u.start_date <= e.date
       LEFT JOIN gauge_entries g ON g.event_id = e.id AND g.user_id = u.id
       WHERE e.id IN (${placeholders(ids.length)})
       GROUP BY e.id`,
      ids,
    ),
  );
  const byId = new Map(rows.map((r) => [Number(r.eventId), r]));
  for (const id of ids) {
    const r = byId.get(id);
    out.set(id, { members: Number(r?.members ?? 0), logged: Number(r?.logged ?? 0) });
  }
  return out;
}
