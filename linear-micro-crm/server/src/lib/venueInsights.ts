/**
 * Release 1.3 — OWNED BY P8 venue-insights: every venue's numbers (GET /venues, GET /venues/:key) and each booked
 * person's plan for an event (GET /events/:id/plan). The maths is shared/src/logic/venues.ts (pure, unit-tested); this
 * file gathers the counts.
 *
 * What counts: a SHIFT is one gauge entry (one person at one event on its day). Only finished days count — entries on
 * events dated before today (business clock) that are not live — so a half-logged day never drags an average down. A
 * VISIT is an event at the venue with at least one counted shift. Venues are grouped by the shared venueKey(venue, city)
 * (the same place however it was typed); the name shown is the one on the venue's latest event. Every finished shift
 * ever logged at a venue counts (venues repeat across months; that is the point).
 *
 * Cost: the venue index is ONE grouped query over events and their gauge totals; a venue's shifts are one more query
 * (its events only). Plans, for any number of events and people (GET /events/:id/plan, and the caller's own aim on every
 * booked row of GET /events), add at most two: the people's last 8 weeks, and — only for someone with fewer than 5 own
 * shifts — every counted shift's sales at those venues; the headcount comes from the forecast's own memoised query
 * (lib/smart/eventForecast.ts eventHeadcounts). Results are memoised per database, data version and business day
 * (every mutating request bumps the version, so a saved gauge or booking shows on the very next read), and the venue
 * routes sit behind the response cache. Read-only: nothing here writes a row.
 *
 * Privacy (owner's rule): reps see aggregated numbers only — points are anonymous person-days (stops, sales, date), and
 * `people` (named rows) goes to the admin (everyone) and a leader (their own team and themself) only. A plan uses a
 * person's own numbers only for the person themself, the admin, and the leader of the person's own team; for anyone
 * else (a leader reading the plan of someone the office booked from another team) it is built from the venue's
 * numbers alone and marked `limited`.
 */
import {
  EMPTY_TOTALS,
  GAUGE_KEYS,
  RATIO_KEYS,
  VENUE_RULES,
  blendPlanRatios,
  fittedSalesPerStop,
  funnelRatios,
  isoWeekday,
  lawOfAveragesSentence,
  pearson,
  perShiftOf,
  planSentence,
  planSteps,
  planTarget,
  ratioStability,
  salesPerShiftOf,
  stopBands,
  venueKey,
  type CampaignSector,
  type EventPlan,
  type VenueGroupFigures,
  type EventStatus,
  type EventType,
  type GaugeTotals,
  type SalesEventWithMeta,
  type UserWithTeam,
  type VenuePerson,
  type VenueProfile,
  type VenueStability,
  type VenueStabilityKey,
  type VenueSummary,
} from '@lm/shared';
import { all, placeholders, type Db } from '../db/connection.ts';
import { CACHE_TTL_MS, currentDataVersion } from './cache.ts';
import { addDays } from './dates.ts';
import { eventHeadcounts, type EventHeadcount } from './smart/eventForecast.ts';

// ───────────────────────────── memo ─────────────────────────────

interface MemoSlot {
  version: number;
  today: string;
  born: number;
  entries: Map<string, unknown>;
}

const memo = new WeakMap<Db, MemoSlot>();
const MEMO_MAX_ENTRIES = 48;

/** `build()` once per database, data version, business day and key (and at most CACHE_TTL_MS). Values are read-only. */
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

// ───────────────────────────── the venue index ─────────────────────────────

interface IndexRow extends GaugeTotals {
  id: number;
  name: string;
  venue: string;
  city: string;
  date: string;
  status: EventStatus;
  type: EventType;
  teamId: number;
  teamName: string;
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  campaignColor: string;
  sector: CampaignSector;
  shifts: number;
}

export interface IndexEvent {
  id: number;
  name: string;
  venue: string;
  city: string;
  date: string;
  status: EventStatus;
  type: EventType;
  teamId: number;
  teamName: string;
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  campaignColor: string;
  sector: CampaignSector;
  /** Every gauge entry logged on the event (today's live ones too). */
  shifts: number;
  totals: GaugeTotals;
  /** Whether the event's shifts count towards the venue's figures (finished: before today and not live). */
  counted: boolean;
}

export interface VenueGroup {
  key: string;
  venue: string;
  city: string;
  /** Newest first (date, then id). */
  events: IndexEvent[];
  /** Counted shifts and their totals. */
  shifts: number;
  totals: GaugeTotals;
  visits: number;
  lastVisit: string | null;
  nextVisit: string | null;
  campaigns: string[];
}

interface Basis {
  totals: GaugeTotals;
  shifts: number;
}

export interface VenueIndex {
  byKey: Map<string, VenueGroup>;
  /** Every counted shift in the company (the comparison). */
  company: Basis;
  /** Release 1.3 (P8): the company's counted shifts per campaign id, and per ISO weekday (the groups' comparison). */
  companyByCampaign: Map<number, Basis>;
  companyByWeekday: Map<number, Basis>;
}

const addTotals = (into: GaugeTotals, t: GaugeTotals) => {
  for (const k of GAUGE_KEYS) into[k] += t[k];
};

const addTo = <K>(map: Map<K, Basis>, key: K, totals: GaugeTotals, shifts: number) => {
  const b = map.get(key) ?? { totals: { ...EMPTY_TOTALS }, shifts: 0 };
  addTotals(b.totals, totals);
  b.shifts += shifts;
  map.set(key, b);
};

/** A group's figures per shift (a campaign or a weekday, here or company-wide). */
const figuresOf = (b: Basis): VenueGroupFigures => ({
  shifts: b.shifts,
  perShift: perShiftOf(b.totals, b.shifts),
  ratios: funnelRatios(b.totals),
  salesPerShift: salesPerShiftOf(b.totals.sales, b.shifts),
});

/** Every event with its gauge totals, grouped by venue key: one grouped query (memoised). */
export function venueIndex(db: Db, today: string): VenueIndex {
  return remember(db, today, 'index', () => {
    const rows = all<IndexRow>(
      db,
      `SELECT e.id, e.name, e.venue, e.city, e.date, e.status, e.type, e.team_id AS teamId, t.name AS teamName,
              e.campaign_id AS campaignId, c.code AS campaignCode, c.name AS campaignName, c.color AS campaignColor, c.sector AS sector,
              COALESCE(g.shifts, 0) AS shifts, COALESCE(g.stops, 0) AS stops, COALESCE(g.table_count, 0) AS "table",
              COALESCE(g.presentations, 0) AS presentations, COALESCE(g.closes, 0) AS closes, COALESCE(g.taps, 0) AS taps,
              COALESCE(g.sales, 0) AS sales
       FROM events e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN teams t ON t.id = e.team_id
       LEFT JOIN (
         SELECT event_id, COUNT(*) AS shifts, SUM(stops) AS stops, SUM(table_count) AS table_count, SUM(presentations) AS presentations,
                SUM(closes) AS closes, SUM(taps) AS taps, SUM(sales) AS sales
         FROM gauge_entries GROUP BY event_id
       ) g ON g.event_id = e.id
       ORDER BY e.date DESC, e.id DESC`,
    );
    const byKey = new Map<string, VenueGroup>();
    const company = { totals: { ...EMPTY_TOTALS }, shifts: 0 };
    const companyByCampaign = new Map<number, Basis>();
    const companyByWeekday = new Map<number, Basis>();
    const campaignShifts = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const totals: GaugeTotals = { stops: Number(r.stops), table: Number(r.table), presentations: Number(r.presentations), closes: Number(r.closes), taps: Number(r.taps), sales: Number(r.sales) };
      // an entry's date is its event's date (gauge integrity rules), so the event's date decides for all its entries
      const counted = r.status !== 'live' && r.date < today;
      const ev: IndexEvent = { ...r, shifts: Number(r.shifts), totals, counted };
      const key = venueKey(r.venue, r.city);
      let g = byKey.get(key);
      if (!g) {
        g = { key, venue: r.venue, city: r.city, events: [], shifts: 0, totals: { ...EMPTY_TOTALS }, visits: 0, lastVisit: null, nextVisit: null, campaigns: [] };
        byKey.set(key, g);
        campaignShifts.set(key, new Map());
      }
      g.events.push(ev);
      const camp = campaignShifts.get(key)!;
      if (counted && ev.shifts > 0) {
        g.shifts += ev.shifts;
        addTotals(g.totals, totals);
        g.visits += 1;
        if (!g.lastVisit || ev.date > g.lastVisit) g.lastVisit = ev.date;
        company.shifts += ev.shifts;
        addTotals(company.totals, totals);
        addTo(companyByCampaign, r.campaignId, totals, ev.shifts);
        addTo(companyByWeekday, isoWeekday(r.date), totals, ev.shifts);
        camp.set(r.campaignCode, (camp.get(r.campaignCode) ?? 0) + ev.shifts);
      } else if (!camp.has(r.campaignCode)) camp.set(r.campaignCode, 0);
      if ((r.status === 'scheduled' || r.status === 'live') && r.date >= today && (!g.nextVisit || r.date < g.nextVisit)) g.nextVisit = r.date;
    }
    for (const [key, g] of byKey) {
      const camp = campaignShifts.get(key)!;
      g.campaigns = [...camp.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);
    }
    return { byKey, company, companyByCampaign, companyByWeekday };
  });
}

/** The list: every venue with a counted shift or an upcoming event (venues only ever cancelled are left out). */
export function venueSummaries(db: Db, today: string): VenueSummary[] {
  const out: VenueSummary[] = [];
  for (const g of venueIndex(db, today).byKey.values()) {
    if (!g.shifts && !g.nextVisit) continue;
    out.push(summaryOf(g));
  }
  return out;
}

function summaryOf(g: VenueGroup): VenueSummary {
  return {
    key: g.key,
    venue: g.venue,
    city: g.city,
    eventCount: g.visits,
    shifts: g.shifts,
    sales: g.totals.sales,
    salesPerShift: salesPerShiftOf(g.totals.sales, g.shifts),
    lastVisit: g.lastVisit,
    campaigns: g.campaigns,
    nextVisit: g.nextVisit,
    stops: g.totals.stops,
  };
}

// ───────────────────────────── a venue's shifts ─────────────────────────────

export interface ShiftRow extends GaugeTotals {
  eventId: number;
  userId: number;
  date: string;
  userName: string;
  avatarColor: string;
  /** The person's current team (for a leader's named rows). */
  teamId: number | null;
}

/** Every counted shift at the venue, newest first (one query over the venue's counted events; memoised). */
export function venueShifts(db: Db, today: string, key: string): ShiftRow[] {
  return remember(db, today, `shifts|${key}`, () => {
    const g = venueIndex(db, today).byKey.get(key);
    const ids = g ? g.events.filter((e) => e.counted && e.shifts > 0).map((e) => e.id) : [];
    if (!ids.length) return [];
    return all<ShiftRow>(
      db,
      `SELECT g.event_id AS eventId, g.user_id AS userId, g.date, g.stops, g.table_count AS "table", g.presentations, g.closes, g.taps, g.sales,
              TRIM(u.first_name || ' ' || u.last_name) AS userName, u.avatar_color AS avatarColor, u.team_id AS teamId
       FROM gauge_entries g JOIN users u ON u.id = g.user_id
       WHERE g.event_id IN (${placeholders(ids.length)})
       ORDER BY g.date DESC, g.id DESC`,
      ids,
    );
  });
}

/** People booked per upcoming event at the venue, not those who have left (one query; for the profile's events list). */
function bookedCounts(db: Db, eventIds: readonly number[]): Map<number, number> {
  if (!eventIds.length) return new Map();
  const rows = all<{ eventId: number; n: number }>(
    db,
    `SELECT r.event_id AS eventId, COUNT(*) AS n FROM event_roster r JOIN users u ON u.id = r.user_id AND u.status <> 'left'
     WHERE r.event_id IN (${placeholders(eventIds.length)}) GROUP BY r.event_id`,
    [...eventIds],
  );
  return new Map(rows.map((r) => [Number(r.eventId), Number(r.n)]));
}

const sumOf = (rows: readonly GaugeTotals[]): GaugeTotals => {
  const t = { ...EMPTY_TOTALS };
  for (const r of rows) addTotals(t, r);
  return t;
};

/** In the named rows, people with fewer shifts than this at the venue are listed after the rest. */
const PEOPLE_RANK_MIN_SHIFTS = 3;

/** Who may see named rows at a venue: the admin everyone; a leader their own team and themself; nobody else. */
function canSeePerson(me: UserWithTeam, row: Pick<ShiftRow, 'userId' | 'teamId'>): boolean {
  if (me.role === 'admin') return true;
  if (me.role !== 'leader') return false;
  return row.userId === me.id || (me.teamId != null && row.teamId === me.teamId);
}

/** GET /venues/:key — null when no event was ever held at the venue. */
export function venueProfile(db: Db, key: string, me: UserWithTeam, today: string): VenueProfile | null {
  const index = venueIndex(db, today);
  const g = index.byKey.get(key);
  if (!g) return null;
  const shifts = venueShifts(db, today, key);
  const company = index.company;

  // by campaign: the counted events' totals
  const camp = new Map<number, { ev: IndexEvent; shifts: number; totals: GaugeTotals }>();
  for (const e of g.events) {
    if (!e.counted || !e.shifts) continue;
    const c = camp.get(e.campaignId) ?? { ev: e, shifts: 0, totals: { ...EMPTY_TOTALS } };
    c.shifts += e.shifts;
    addTotals(c.totals, e.totals);
    camp.set(e.campaignId, c);
  }
  const byCampaign = [...camp.values()]
    .sort((a, b) => b.shifts - a.shifts || a.ev.campaignCode.localeCompare(b.ev.campaignCode))
    .map((c) => ({
      campaignId: c.ev.campaignId,
      code: c.ev.campaignCode,
      sector: c.ev.sector,
      name: c.ev.campaignName,
      color: c.ev.campaignColor,
      shifts: c.shifts,
      perShift: perShiftOf(c.totals, c.shifts),
      salesPerShift: salesPerShiftOf(c.totals.sales, c.shifts),
      ratios: funnelRatios(c.totals),
      // the same campaign everywhere in the company (this venue included)
      ...(index.companyByCampaign.has(c.ev.campaignId) ? { company: figuresOf(index.companyByCampaign.get(c.ev.campaignId)!) } : {}),
    }));

  // by weekday (ISO 1 = Monday): the six gauges from the venue's shifts, against the same weekday company-wide
  const days = new Map<number, Basis>();
  for (const s of shifts) addTo(days, isoWeekday(s.date), s, 1);
  const byWeekday = [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekday, d]) => ({
      weekday,
      shifts: d.shifts,
      salesPerShift: salesPerShiftOf(d.totals.sales, d.shifts),
      stopsPerShift: Math.round((d.totals.stops / d.shifts) * 10) / 10,
      perShift: perShiftOf(d.totals, d.shifts),
      ratios: funnelRatios(d.totals),
      ...(index.companyByWeekday.has(weekday) ? { company: figuresOf(index.companyByWeekday.get(weekday)!) } : {}),
    }));

  // every event, newest first; upcoming ones carry who is booked
  const upcomingIds = g.events.filter((e) => (e.status === 'scheduled' || e.status === 'live') && e.date >= today).map((e) => e.id);
  const booked = bookedCounts(db, upcomingIds);
  const events = g.events.map((e) => ({
    id: e.id,
    name: e.name,
    date: e.date,
    type: e.type,
    status: e.status,
    teamName: e.teamName,
    campaignCode: e.campaignCode,
    campaignColor: e.campaignColor,
    sales: e.totals.sales,
    people: e.shifts,
    ...(booked.has(e.id) ? { booked: booked.get(e.id) } : {}),
  }));

  // the law of averages
  const visits = g.events.filter((e) => e.counted && e.shifts > 0).map((e) => e.totals);
  const stability = ratioStability(visits);
  const cv: Partial<Record<VenueStabilityKey, number>> = {};
  const chanceCv: Partial<Record<VenueStabilityKey, number>> = {};
  const steadiness: Partial<Record<VenueStabilityKey, VenueStability>> = {};
  for (const [k, s] of Object.entries(stability) as [VenueStabilityKey, NonNullable<(typeof stability)[VenueStabilityKey]>][]) {
    cv[k] = s.cv;
    chanceCv[k] = s.chanceCv;
    steadiness[k] = s.label;
  }
  const allPoints = shifts.map((s) => ({ stops: s.stops, sales: s.sales, date: s.date }));
  const points = allPoints.slice(0, VENUE_RULES.maxPoints);
  const sales = g.totals.sales;
  const lawOfAverages = {
    points,
    pointsCapped: allPoints.length > points.length,
    fittedRate: Math.round(fittedSalesPerStop(allPoints) * 1e5) / 1e5,
    stopsPerSale: sales > 0 ? Math.round((g.totals.stops / sales) * 10) / 10 : null,
    correlation: (() => {
      const r = pearson(allPoints.map((p) => p.stops), allPoints.map((p) => p.sales));
      return r == null ? null : Math.round(r * 1000) / 1000;
    })(),
    bands: stopBands(allPoints),
    visits: g.visits,
    sentence: lawOfAveragesSentence({ venue: g.venue, shifts: g.shifts, stops: g.totals.stops, sales, visits: g.visits, steadiness: stability.overallConversion?.label }),
    stability: cv,
    steadiness,
    chanceCv,
  };

  // the caller's own numbers, and named rows for those who may see them
  const mine = shifts.filter((s) => s.userId === me.id);
  const you = mine.length
    ? (() => {
        const t = sumOf(mine);
        return { shifts: mine.length, sales: t.sales, salesPerShift: salesPerShiftOf(t.sales, mine.length), perShift: perShiftOf(t, mine.length), ratios: funnelRatios(t) };
      })()
    : undefined;
  let people: VenuePerson[] | undefined;
  if (me.role === 'admin' || me.role === 'leader') {
    const byPerson = new Map<number, { row: ShiftRow; shifts: number; sales: number; stops: number; last: string }>();
    for (const s of shifts) {
      if (!canSeePerson(me, s)) continue;
      const p = byPerson.get(s.userId) ?? { row: s, shifts: 0, sales: 0, stops: 0, last: s.date };
      p.shifts += 1;
      p.sales += s.sales;
      p.stops += s.stops;
      if (s.date > p.last) p.last = s.date;
      byPerson.set(s.userId, p);
    }
    people = [...byPerson.values()]
      .map((p) => ({
        userId: p.row.userId,
        name: p.row.userName,
        avatarColor: p.row.avatarColor,
        shifts: p.shifts,
        sales: p.sales,
        salesPerShift: salesPerShiftOf(p.sales, p.shifts),
        stopsPerSale: p.sales > 0 ? Math.round((p.stops / p.sales) * 10) / 10 : null,
        lastVisit: p.last,
      }))
      // by sales per shift, people with fewer than 3 shifts here after the rest (one lucky day is not a pattern)
      .sort((a, b) => Number(a.shifts < PEOPLE_RANK_MIN_SHIFTS) - Number(b.shifts < PEOPLE_RANK_MIN_SHIFTS) || b.salesPerShift - a.salesPerShift || b.shifts - a.shifts || a.name.localeCompare(b.name, 'en-GB'));
  }

  return {
    ...summaryOf(g),
    perShift: perShiftOf(g.totals, g.shifts),
    ratios: funnelRatios(g.totals),
    company: {
      perShift: perShiftOf(company.totals, company.shifts),
      ratios: funnelRatios(company.totals),
      shifts: company.shifts,
      salesPerShift: salesPerShiftOf(company.totals.sales, company.shifts),
    },
    byCampaign,
    byWeekday,
    events,
    lawOfAverages,
    ...(you ? { you } : {}),
    ...(people ? { people } : {}),
  };
}

// ───────────────────────────── event plans ─────────────────────────────

interface OwnRow extends GaugeTotals {
  userId: number;
}

/** A person a plan is for. `teamId` decides whether a leader sees a plan from the person's own numbers. */
export interface PlanPerson {
  userId: number;
  userName: string;
  avatarColor?: string;
  teamId?: number | null;
}

export interface PlanRequest {
  event: SalesEventWithMeta;
  people: readonly PlanPerson[];
}

/**
 * Whether `viewer` may see a plan built from `p`'s own numbers (their last 8 weeks and their good day): the person
 * themself, the admin, and the leader of the person's own team. Anyone else gets the venue-only plan (`limited`).
 */
function seesOwnNumbers(viewer: UserWithTeam, p: PlanPerson): boolean {
  if (viewer.role === 'admin' || p.userId === viewer.id) return true;
  return viewer.role === 'leader' && viewer.teamId != null && p.teamId === viewer.teamId;
}

/** The people's finished shifts anywhere in the last 8 weeks, by person (one query; memoised per id set). */
function ownShifts(db: Db, today: string, ids: readonly number[]): Map<number, OwnRow[]> {
  if (!ids.length) return new Map();
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return remember(db, today, `own|${sorted.join(',')}`, () => {
    const rows = all<OwnRow>(
      db,
      `SELECT g.user_id AS userId, g.stops, g.table_count AS "table", g.presentations, g.closes, g.taps, g.sales
       FROM gauge_entries g JOIN events e ON e.id = g.event_id
       WHERE g.user_id IN (${placeholders(sorted.length)}) AND g.date >= ? AND g.date < ? AND e.status <> 'live'`,
      [...sorted, addDays(today, -7 * VENUE_RULES.ownWeeks), today],
    );
    const own = new Map<number, OwnRow[]>();
    for (const r of rows) {
      const list = own.get(Number(r.userId));
      if (list) list.push(r);
      else own.set(Number(r.userId), [r]);
    }
    return own;
  });
}

/** Every counted shift's sales at each of these venues (one query over their counted events; memoised per key set). */
function venueShiftSales(db: Db, today: string, keys: readonly string[]): Map<string, number[]> {
  if (!keys.length) return new Map();
  const sorted = [...new Set(keys)].sort();
  return remember(db, today, `venue-sales|${sorted.join('|')}`, () => {
    const index = venueIndex(db, today);
    const keyOf = new Map<number, string>();
    for (const key of sorted) for (const e of index.byKey.get(key)?.events ?? []) if (e.counted && e.shifts > 0) keyOf.set(e.id, key);
    const out = new Map<string, number[]>(sorted.map((k) => [k, []]));
    if (!keyOf.size) return out;
    const rows = all<{ eventId: number; sales: number }>(db, `SELECT event_id AS eventId, sales FROM gauge_entries WHERE event_id IN (${placeholders(keyOf.size)})`, [...keyOf.keys()]);
    for (const r of rows) out.get(keyOf.get(Number(r.eventId))!)!.push(Number(r.sales));
    return out;
  });
}

/**
 * Plans for every request (each event's booked `people`, as `viewer` may see them), by event id, in the people's order.
 * The event's share divides its target among the people it is expected to have — the forecast's own headcount (pass
 * `headcounts` from eventHeadcounts on the list already forecast to share its memoised query). At most two queries
 * whatever the number of events: the people's own shifts (only those `viewer` may see) and, for anyone with fewer than
 * 5 of them, the venues' shift sales (a good day there).
 */
export function eventPlans(db: Db, requests: readonly PlanRequest[], viewer: UserWithTeam, today: string, headcounts?: Map<number, EventHeadcount>): Map<number, EventPlan[]> {
  const out = new Map<number, EventPlan[]>();
  const wanted = requests.filter((r) => r.people.length);
  if (!wanted.length) return out;
  const index = venueIndex(db, today);
  const heads = headcounts ?? eventHeadcounts(db, wanted.map((r) => r.event), today);
  const own = ownShifts(db, today, wanted.flatMap((r) => r.people.filter((p) => seesOwnNumbers(viewer, p)).map((p) => p.userId)));
  const mineOf = (p: PlanPerson) => (seesOwnNumbers(viewer, p) ? own.get(p.userId) ?? [] : []);
  // a newcomer (or a venue-only plan) compares with a good day at the venue: one query for every venue that needs it
  const thinKeys = wanted.filter((r) => r.people.some((p) => mineOf(p).length < VENUE_RULES.minShifts)).map((r) => venueKey(r.event.venue, r.event.city));
  const venueSales = venueShiftSales(db, today, thinKeys);

  for (const { event, people } of wanted) {
    const key = venueKey(event.venue, event.city);
    const g = index.byKey.get(key);
    const venue = { shifts: g?.shifts ?? 0, totals: g ? g.totals : { ...EMPTY_TOTALS } };
    const head = heads.get(event.id);
    // the people expected (at least one: a plan only exists for someone booked)
    const expected = Math.max(head?.people ?? 0, head?.booked ?? 0, 1);
    out.set(
      event.id,
      people.map((p) => {
        const limited = !seesOwnNumbers(viewer, p);
        const mine = mineOf(p);
        const blend = blendPlanRatios({ shifts: mine.length, totals: sumOf(mine) }, venue, index.company.totals);
        const target = planTarget({
          eventTarget: event.targetSales,
          people: expected,
          ownShiftSales: mine.map((r) => r.sales),
          venueShiftSales: mine.length < VENUE_RULES.minShifts ? venueSales.get(key) ?? [] : [],
        });
        const steps = blend.ratios ? planSteps(target.targetSales, blend.ratios) : [];
        const ratios = blend.ratios
          ? (Object.fromEntries(RATIO_KEYS.map((k) => [k, Math.round(blend.ratios![k] * 1e4) / 1e4])) as NonNullable<EventPlan['ratios']>)
          : undefined;
        return {
          eventId: event.id,
          userId: p.userId,
          userName: p.userName,
          ...(p.avatarColor ? { avatarColor: p.avatarColor } : {}),
          targetSales: target.targetSales,
          targetSource: target.targetSource,
          eventShare: target.eventShare,
          sharedAmong: target.sharedAmong,
          goodDay: target.goodDay,
          ...(target.shareAboveGoodDay ? { shareAboveGoodDay: true } : {}),
          ...(limited ? { limited: true } : {}),
          steps,
          sentence: planSentence(target.targetSales, event.venue, steps),
          venueWeight: Math.round(blend.venueWeight * 100) / 100,
          basis: { ownShifts: mine.length, venueShifts: venue.shifts },
          venueName: event.venue,
          ...(ratios ? { ratios } : {}),
        };
      }),
    );
  }
  return out;
}

/** One event's plans (GET /events/:id/plan): eventPlans for a single request. */
export function eventPlansFor(db: Db, event: SalesEventWithMeta, people: readonly PlanPerson[], viewer: UserWithTeam, today: string): EventPlan[] {
  return eventPlans(db, [{ event, people }], viewer, today).get(event.id) ?? [];
}
