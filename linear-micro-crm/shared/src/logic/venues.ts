/**
 * Release 1.3 — OWNED BY P8 venue-insights (laid down by r3-foundation). Venues repeat across events, so every per-venue
 * figure is keyed by venueKey(venue, city) — STABLE (the URL /venues/:key and the server's grouping use it).
 *
 * P8 adds, pure and unit-tested (venues.test.ts):
 *  - the law of averages at a venue: the fitted rate (sales per stop), the plain sentence, the stability of each ratio
 *    from visit to visit against what luck alone would give, and the shifts in three groups by stops;
 *  - the event plan: a blend of the person's own ratios (last 8 weeks) and the venue's (with the company's filling in
 *    for a venue with few shifts), the target (the event's share or a good day, the higher), the five steps with a range,
 *    and its sentence.
 * The server (lib/venueInsights.ts) gathers the counts with grouped queries and hands them here. docs/r3/P8-venue-insights.md.
 */
import { RATIO_KEYS, type RatioKey } from '../constants.ts';
import { GAUGE_KEYS, type FunnelRatios, type GaugeKey, type GaugeTotals } from '../types.ts';
import type {
  EventPlanStep,
  EventPlanTargetSource,
  VenuePoint,
  VenueStability,
  VenueStabilityKey,
  VenueStopBand,
  VenueSummary,
} from '../types/venues.ts';
import { quantile, mean, sampleSd } from './stats.ts';

/** "St Peter's Square" → "st-peters-square": lower case, & → and, apostrophes dropped, anything else → "-". */
export function venueSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The venue's key: the venue and the city slugs joined by "--" ("Golden Square", "Manchester" →
 * "golden-square--manchester"), so the same place is one venue however it was typed (case, spacing, punctuation).
 */
export function venueKey(venue: string, city: string): string {
  return `${venueSlug(venue)}--${venueSlug(city)}`;
}

/** True for a string venueKey could have produced. */
export function isVenueKey(key: string): boolean {
  return key.length <= 240 && /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?--(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(key);
}

// ───────────────────────────── rules ─────────────────────────────

export const VENUE_RULES = {
  /** The person's own ratios come from their finished shifts in the last 8 weeks. */
  ownWeeks: 8,
  /** venueWeight = ownCredibility ÷ (own shifts + ownCredibility): 1 with no own shifts, 0.5 at 10, 0.24 at 32. */
  ownCredibility: 10,
  /** The venue's share against the company's = venue shifts ÷ (venue shifts + venueCredibility): 0.5 at 10 shifts. */
  venueCredibility: 10,
  /** A good day = this quantile (type 7) of sales per shift, from at least `minShifts` shifts. */
  goodDayQuantile: 0.75,
  minShifts: 5,
  /** Stability needs this many visits with the stage. */
  minVisits: 3,
  /** "steady" when the visit-to-visit CV is at most 1.5 × the CV luck alone gives; "fairly steady" up to 2.5 ×. */
  steadyWithin: 1.5,
  fairlySteadyWithin: 2.5,
  /** A CV this small is steady whatever luck would give (a ratio at 100% has no luck to compare with). */
  stabilityFloor: 0.05,
  /** The plan's range: the target sits one standard deviation of luck (Poisson) away — about two days in three. */
  planZ: 1,
  /** The scatter carries at most this many shifts (the most recent); every figure uses them all. */
  maxPoints: 400,
  /** Three groups by stops need at least this many shifts. */
  bandsMinShifts: 9,
  /** Sorted by sales per shift, a venue with fewer shifts than this is listed after the rest: too few to rank. */
  rankMinShifts: 10,
  /**
   * A plan aims for the event's share unless it is more than this × the person's good day AND at least
   * `shareStretchMinGap` sales above it: then it aims for the good day and says why (shareAboveGoodDay). The gap keeps
   * small numbers sensible: a share of 2 against a good day of 1 is still the aim.
   */
  shareStretch: 1.5,
  shareStretchMinGap: 2,
} as const;

export interface HeadcountInput {
  /** The team's usual turnout (mean people per completed event, last 8 weeks); null with too little history. */
  habit: number | null;
  /** Active people booked on the event. */
  booked: number;
  /** True once a leader or the office has booked anyone (a 'leader' booking); self-bookings alone are not a crew. */
  managed: boolean;
  live: boolean;
  /** People who have logged the event so far (live events). */
  logged: number;
}

/**
 * How many people an event is expected to have (the forecast's expectedReps, and the people a plan shares the target
 * among):
 *  - nobody booked → the team's usual turnout (the 1.1 rule; null with too little history);
 *  - booked by a leader or the office → the people booked (the leader has done the roster);
 *  - only self-bookings so far → the larger of those booked and the usual turnout (a roster still filling up is a
 *    floor, not the crew);
 *  - a live event with bookings → at least the people who have logged it (walk-ups and unfinished rosters count).
 */
export function expectedHeadcount(i: HeadcountInput): number | null {
  if (i.booked <= 0) return i.habit;
  let people = i.managed || i.habit == null ? i.booked : Math.max(i.booked, i.habit);
  if (i.live) people = Math.max(people, i.logged);
  return people;
}

/** The five plan stages, stops → taps (each converts to the next one through RATIO_KEYS[i]). */
export const PLAN_STAGES: readonly GaugeKey[] = ['stops', 'table', 'presentations', 'closes', 'taps'];

export type StageRatios = Record<RatioKey, number>;

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
// created on first use: a top-level `new Intl.NumberFormat` would keep this module in every bundle that imports @lm/shared
let int: Intl.NumberFormat | null = null;
const fmt = (n: number) => (int ??= new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })).format(n);

/** Average per shift of each gauge, to 1 dp (all zero without shifts). */
export function perShiftOf(totals: GaugeTotals, shifts: number): GaugeTotals {
  const out = {} as GaugeTotals;
  for (const k of GAUGE_KEYS) out[k] = shifts > 0 ? round(totals[k] / shifts, 1) : 0;
  return out;
}

/** Sales per shift to 2 dp (0 without shifts). */
export function salesPerShiftOf(sales: number, shifts: number): number {
  return shifts > 0 ? round(sales / shifts, 2) : 0;
}

/** Each stage ratio of a set of totals, or null where the stage before it is 0 (no data, not a poor ratio). */
export function stageRatiosOf(t: GaugeTotals): Record<RatioKey, number | null> {
  const out = {} as Record<RatioKey, number | null>;
  RATIO_KEYS.forEach((k, i) => {
    const from = t[GAUGE_KEYS[i]!];
    const to = t[GAUGE_KEYS[i + 1]!];
    out[k] = from > 0 ? to / from : null;
  });
  return out;
}

// ───────────────────────────── the law of averages ─────────────────────────────

/** Sales per stop of the line through the origin fitted by weighted least squares (variance ∝ stops): Σ sales ÷ Σ stops. */
export function fittedSalesPerStop(points: ReadonlyArray<Pick<VenuePoint, 'stops' | 'sales'>>): number {
  let stops = 0;
  let sales = 0;
  for (const p of points) {
    stops += p.stops;
    sales += p.sales;
  }
  return stops > 0 ? sales / stops : 0;
}

/** Pearson correlation; null below 3 points or when either series has no spread. */
export function pearson(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * The shifts in three groups of (nearly) equal size by stops, fewest first: cut at round(n/3) and round(2n/3) of the
 * shifts sorted by stops (ties keep date order, so a group's range may touch the next one's). Empty below 9 shifts.
 */
export function stopBands(points: ReadonlyArray<VenuePoint>): VenueStopBand[] {
  const n = points.length;
  if (n < VENUE_RULES.bandsMinShifts) return [];
  const sorted = [...points].sort((a, b) => a.stops - b.stops || a.date.localeCompare(b.date) || a.sales - b.sales);
  const cuts = [0, Math.round(n / 3), Math.round((2 * n) / 3), n];
  const names: VenueStopBand['band'][] = ['fewest', 'middle', 'most'];
  return names.map((band, i) => {
    const slice = sorted.slice(cuts[i], cuts[i + 1]);
    const stops = slice.reduce((s, p) => s + p.stops, 0);
    const sales = slice.reduce((s, p) => s + p.sales, 0);
    return {
      band,
      minStops: slice[0]!.stops,
      maxStops: slice[slice.length - 1]!.stops,
      shifts: slice.length,
      avgStops: round(stops / slice.length, 1),
      salesPerShift: salesPerShiftOf(sales, slice.length),
    };
  });
}

/** The stage each stability key converts from and to. */
const STABILITY_STAGES: Record<VenueStabilityKey, [GaugeKey, GaugeKey]> = {
  stopToTable: ['stops', 'table'],
  tableToPresentation: ['table', 'presentations'],
  presentationToClose: ['presentations', 'closes'],
  closeToTap: ['closes', 'taps'],
  tapToSale: ['taps', 'sales'],
  overallConversion: ['stops', 'sales'],
};
export const VENUE_STABILITY_KEYS: readonly VenueStabilityKey[] = ['stopToTable', 'tableToPresentation', 'presentationToClose', 'closeToTap', 'tapToSale', 'overallConversion'];

export interface RatioStability {
  /** Sample SD ÷ mean of the ratio per visit. */
  cv: number;
  /** The CV luck alone would give: √(mean over visits of p(1 − p) ÷ n_visit) ÷ p, p the pooled ratio. */
  chanceCv: number;
  label: VenueStability;
  visits: number;
}

/**
 * How steady each ratio is from visit to visit (each visit's totals, all its shifts together): over the visits that
 * reached the stage (≥ 3), CV = sample SD ÷ mean of the visits' ratios; chance CV = what binomial luck alone gives at
 * the pooled ratio with each visit's own numbers. steady: CV ≤ max(1.5 × chance, 0.05); fairly steady: ≤ max(2.5 ×
 * chance, 0.10); otherwise it varies. A ratio no visit converted (pooled 0) has no entry.
 */
export function ratioStability(visits: ReadonlyArray<GaugeTotals>): Partial<Record<VenueStabilityKey, RatioStability>> {
  const out: Partial<Record<VenueStabilityKey, RatioStability>> = {};
  for (const key of VENUE_STABILITY_KEYS) {
    const [from, to] = STABILITY_STAGES[key];
    const used = visits.filter((v) => v[from] > 0);
    if (used.length < VENUE_RULES.minVisits) continue;
    const a = used.reduce((s, v) => s + v[from], 0);
    const b = used.reduce((s, v) => s + v[to], 0);
    const p = b / a;
    if (!(p > 0)) continue;
    const rates = used.map((v) => v[to] / v[from]);
    const m = mean(rates);
    if (!(m > 0)) continue;
    const cv = sampleSd(rates) / m;
    const chanceCv = Math.sqrt(mean(used.map((v) => (p * (1 - p)) / v[from]))) / p;
    const eps = 1e-9;
    const label: VenueStability =
      cv <= Math.max(VENUE_RULES.steadyWithin * chanceCv, VENUE_RULES.stabilityFloor) + eps
        ? 'steady'
        : cv <= Math.max(VENUE_RULES.fairlySteadyWithin * chanceCv, 2 * VENUE_RULES.stabilityFloor) + eps
          ? 'fairly_steady'
          : 'varies';
    out[key] = { cv: round(cv, 3), chanceCv: round(chanceCv, 3), label, visits: used.length };
  }
  return out;
}

export const VENUE_STABILITY_LABELS: Record<VenueStability, string> = {
  steady: 'Steady',
  fairly_steady: 'Fairly steady',
  varies: 'Varies',
};

export interface LawOfAveragesInput {
  venue: string;
  shifts: number;
  stops: number;
  sales: number;
  /** Visits the stability was measured over (for the sentence; 0 when unknown). */
  visits: number;
  /** The overall conversion's steadiness (undefined below 3 visits). */
  steadiness?: VenueStability;
}

/**
 * "At Golden Square, every 24 stops made a sale on average, steady across 41 shifts." N = round(stops ÷ sales). Below 5
 * shifts it says the shifts are too few to call it a pattern; without sales or shifts it says so plainly.
 */
export function lawOfAveragesSentence(i: LawOfAveragesInput): string {
  const shifts = `${fmt(i.shifts)} ${i.shifts === 1 ? 'shift' : 'shifts'}`;
  if (i.shifts <= 0) return `No shifts logged at ${i.venue} yet.`;
  if (i.sales <= 0) return `No sales at ${i.venue} yet across ${shifts} (${fmt(i.stops)} stops).`;
  const n = Math.max(1, Math.round(i.stops / i.sales));
  const every = `every ${fmt(n)} ${n === 1 ? 'stop' : 'stops'} made a sale`;
  if (i.shifts < VENUE_RULES.minShifts) return `At ${i.venue}, ${every} so far, but ${shifts} are too few to call it a pattern yet.`;
  if (i.steadiness === 'steady') return `At ${i.venue}, ${every} on average, steady across ${shifts}.`;
  if (i.steadiness === 'fairly_steady') return `At ${i.venue}, ${every} on average, fairly steady across ${shifts}.`;
  if (i.steadiness === 'varies') return `At ${i.venue}, ${every} on average across ${shifts}, though it varied from visit to visit.`;
  return `At ${i.venue}, ${every} on average across ${shifts}.`;
}

// ───────────────────────────── the event plan ─────────────────────────────

export interface PlanBasis {
  totals: GaugeTotals;
  shifts: number;
}

export interface BlendedRatios {
  /** Null when a stage has no conversion anywhere (nothing to plan from). */
  ratios: StageRatios | null;
  /** The venue's weight against the person's own ratios: ownCredibility ÷ (own shifts + ownCredibility). */
  venueWeight: number;
  /** The venue's own share against the company's inside the venue part: venue shifts ÷ (venue shifts + venueCredibility). */
  locationWeight: number;
}

/**
 * The plan's ratios, stage by stage:
 *   location = w_v × venue + (1 − w_v) × company,   w_v = venue shifts ÷ (venue shifts + 10)
 *   ratio    = (1 − w) × own + w × location,         w   = 10 ÷ (own shifts + 10)   (venueWeight)
 * A stage with no data on one side (its stage before is 0) takes the other side alone. A stage with no conversion
 * anywhere (ratio 0 or no data at all) makes the plan impossible: ratios null.
 */
export function blendPlanRatios(own: PlanBasis, venue: PlanBasis, company: GaugeTotals): BlendedRatios {
  const venueWeight = VENUE_RULES.ownCredibility / (Math.max(0, own.shifts) + VENUE_RULES.ownCredibility);
  const locationWeight = Math.max(0, venue.shifts) / (Math.max(0, venue.shifts) + VENUE_RULES.venueCredibility);
  const o = own.shifts > 0 ? stageRatiosOf(own.totals) : null;
  const v = venue.shifts > 0 ? stageRatiosOf(venue.totals) : null;
  const c = stageRatiosOf(company);
  const ratios = {} as StageRatios;
  for (const k of RATIO_KEYS) {
    const vk = v?.[k] ?? null;
    const ck = c[k];
    const loc = vk == null ? ck : ck == null ? vk : locationWeight * vk + (1 - locationWeight) * ck;
    const ok = o?.[k] ?? null;
    const r = ok == null ? loc : loc == null ? ok : (1 - venueWeight) * ok + venueWeight * loc;
    if (r == null || !(r > 0)) return { ratios: null, venueWeight, locationWeight };
    ratios[k] = Math.min(1, r);
  }
  return { ratios, venueWeight, locationWeight };
}

/** λ with λ − z√λ = target (high) and λ + z√λ = target (low): the expected sales a slow or a lucky day still lands T on. */
export function poissonBand(target: number, z: number = VENUE_RULES.planZ): { low: number; high: number } {
  const t = Math.max(0, target);
  const s = Math.sqrt(z * z + 4 * t);
  return { low: ((s - z) / 2) ** 2, high: ((s + z) / 2) ** 2 };
}

/**
 * The five steps for `targetSales`: conv_s = the product of the ratios from stage s down to a sale; need = ⌈T ÷ conv_s⌉
 * (an epsilon keeps exact multiples exact); low = round(λ_low ÷ conv_s) but never under T; high = round(λ_high ÷
 * conv_s) but never under need (poissonBand).
 */
export function planSteps(targetSales: number, ratios: StageRatios): EventPlanStep[] {
  const t = Math.max(0, Math.round(targetSales));
  const band = poissonBand(t);
  const conv: number[] = new Array(PLAN_STAGES.length).fill(1);
  let c = 1;
  for (let i = PLAN_STAGES.length - 1; i >= 0; i--) {
    c *= ratios[RATIO_KEYS[i]!];
    conv[i] = c;
  }
  return PLAN_STAGES.map((key, i) => {
    const cv = conv[i]!;
    const need = Math.max(t, Math.ceil(t / cv - 1e-9));
    return {
      key,
      need,
      low: Math.min(need, Math.max(t, Math.round(band.low / cv))),
      high: Math.max(need, Math.round(band.high / cv)),
    };
  });
}

/** A good day: round(75th percentile) of sales per shift, at least 1; null below 5 shifts. */
export function goodDayFrom(salesPerShift: ReadonlyArray<number>): number | null {
  if (salesPerShift.length < VENUE_RULES.minShifts) return null;
  return Math.max(1, Math.round(quantile(salesPerShift, VENUE_RULES.goodDayQuantile)));
}

export interface PlanTargetInput {
  /** The event's sales target (0 = none). */
  eventTarget: number;
  /** The people expected to work the event (expectedHeadcount; may be a mean); null or 0 = unknown. */
  people: number | null;
  /** The person's sales per shift over the last 8 weeks. */
  ownShiftSales: ReadonlyArray<number>;
  /** Everyone's sales per shift at the venue (a newcomer's good day). */
  venueShiftSales: ReadonlyArray<number>;
}

export interface PlanTarget {
  targetSales: number;
  targetSource: EventPlanTargetSource;
  eventShare: number | null;
  /** The whole number of people the share divides by (round(people), at least 1); null when unknown. */
  sharedAmong: number | null;
  goodDay: number | null;
  /** The share is more than 1.5 × the good day, so the plan aims for the good day instead. */
  shareAboveGoodDay: boolean;
}

/**
 * The plan's target from the event's share (⌈target ÷ people⌉, people = round(expected headcount)) and a good day (the
 * person's own with ≥ 5 shifts, else the venue's):
 *  - a good day above the share → the good day (aim for a good day, never below the team's need);
 *  - a share up to 1.5 × the good day, or less than 2 sales above it → the share (a tie, or no good day, is the share);
 *  - a share above 1.5 × the good day and at least 2 sales above it → the good day, flagged shareAboveGoodDay (an aim
 *    nobody reaches helps nobody; the page says what the event's share is);
 *  - with neither, 1 sale.
 */
export function planTarget(i: PlanTargetInput): PlanTarget {
  const sharedAmong = i.people != null && i.people > 0 ? Math.max(1, Math.round(i.people)) : null;
  const eventShare = i.eventTarget > 0 && sharedAmong != null ? Math.ceil(i.eventTarget / sharedAmong) : null;
  const own = goodDayFrom(i.ownShiftSales);
  const goodDay = own ?? goodDayFrom(i.venueShiftSales);
  const goodSource: EventPlanTargetSource = own != null ? 'good-day' : 'venue-good-day';
  const base = { eventShare, sharedAmong, goodDay };
  if (goodDay != null && eventShare != null && eventShare > VENUE_RULES.shareStretch * goodDay && eventShare - goodDay >= VENUE_RULES.shareStretchMinGap) {
    return { ...base, targetSales: goodDay, targetSource: goodSource, shareAboveGoodDay: true };
  }
  if (goodDay != null && goodDay > (eventShare ?? 0)) return { ...base, targetSales: goodDay, targetSource: goodSource, shareAboveGoodDay: false };
  return { ...base, targetSales: Math.max(1, eventShare ?? 1), targetSource: 'event', shareAboveGoodDay: false };
}

const STEP_WORDS: Record<GaugeKey, [string, string]> = {
  stops: ['stop', 'stops'],
  table: ['to table', 'to table'],
  presentations: ['presentation', 'presentations'],
  closes: ['close', 'closes'],
  taps: ['tap', 'taps'],
  sales: ['sale', 'sales'],
};

/** "120 stops", "1 close". */
export function planStepText(step: Pick<EventPlanStep, 'key' | 'need'>): string {
  const [one, many] = STEP_WORDS[step.key];
  return `${fmt(step.need)} ${step.need === 1 ? one : many}`;
}

/** "To make 5 sales at Golden Square you need about 120 stops → 42 to table → 21 presentations → 9 closes → 6 taps." */
export function planSentence(targetSales: number, venue: string, steps: ReadonlyArray<EventPlanStep>): string {
  if (!steps.length) return `There are not enough gauges yet to plan a day at ${venue}.`;
  const sales = `${fmt(targetSales)} ${targetSales === 1 ? 'sale' : 'sales'}`;
  return `To make ${sales} at ${venue} you need about ${steps.map(planStepText).join(' → ')}.`;
}

/** The one-line "Aim" ("120 stops → 42 → 21 → 9 → 6 taps for 5 sales"): the first and last stage named, numbers between. */
export function planAimText(targetSales: number, steps: ReadonlyArray<EventPlanStep>): string {
  if (!steps.length) return '';
  const parts = steps.map((s, i) => (i === 0 || i === steps.length - 1 ? planStepText(s) : fmt(s.need)));
  return `${parts.join(' → ')} for ${fmt(targetSales)} ${targetSales === 1 ? 'sale' : 'sales'}`;
}

/** The ratios a plan was built from, as a FunnelRatios-shaped record (the two derived figures from the product). */
export function planFunnelRatios(r: StageRatios): FunnelRatios {
  const overall = RATIO_KEYS.reduce((acc, k) => acc * r[k], 1);
  return { ...r, overallConversion: overall, stopsPerSale: overall > 0 ? 1 / overall : null };
}

// ───────────────────────────── the venue list ─────────────────────────────

export type VenueSortKey = 'sales_per_shift' | 'shifts' | 'last_visit';
export const VENUE_SORTS: readonly VenueSortKey[] = ['sales_per_shift', 'shifts', 'last_visit'];

/**
 * Venues in the chosen order: sales per shift (highest first; venues with fewer than 10 shifts after the rest — a handful
 * of shifts is too few to rank — and venues without a shift last), shifts (most first) or last visit (latest first;
 * never visited last). Ties: more shifts, then the venue's name, then the key.
 */
export function sortVenues<T extends Pick<VenueSummary, 'key' | 'venue' | 'shifts' | 'salesPerShift' | 'lastVisit'>>(list: readonly T[], sort: VenueSortKey = 'sales_per_shift'): T[] {
  const byName = (a: T, b: T) => a.venue.localeCompare(b.venue, 'en-GB') || a.key.localeCompare(b.key);
  return [...list].sort((a, b) => {
    if (sort === 'shifts') return b.shifts - a.shifts || byName(a, b);
    if (sort === 'last_visit') {
      const la = a.lastVisit ?? '';
      const lb = b.lastVisit ?? '';
      return lb.localeCompare(la) || b.shifts - a.shifts || byName(a, b);
    }
    const group = (v: T) => (v.shifts >= VENUE_RULES.rankMinShifts ? 0 : v.shifts > 0 ? 1 : 2);
    const ea = group(a);
    const eb = group(b);
    return ea - eb || b.salesPerShift - a.salesPerShift || b.shifts - a.shifts || byName(a, b);
  });
}
