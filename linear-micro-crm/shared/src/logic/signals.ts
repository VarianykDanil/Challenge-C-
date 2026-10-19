/**
 * "Check in with…" signals for leaders and the owner — OWNED BY p4-leader-check-ins-coaching.
 *
 * Pure and deterministic: the server (lib/smart/checkIns.ts) gathers one PersonSignalInput per person with a fixed
 * number of grouped queries and hands it here. Each signal compares the person with their OWN usual weeks (or with
 * their team's calendar), never with colleagues' results, and is written out as a conversation starter.
 * Reasons are conversation starters, not verdicts: never "at risk", "underperforming", "failing" or "struggling".
 * See docs/LOGIC.md §14.4 (and docs/API.md, "Check-ins (p4)").
 */
import { BENCHMARK_RATIOS, LATE_GRACE_MINUTES, MIN_STOPS_FOR_INSIGHTS, RATIO_KEYS, RATIO_LABELS } from '../constants.ts';
import type { CheckInPerson, CheckInReason, CheckInReasonCode, GaugeTotals, Position } from '../types.ts';
import { GAUGE_KEYS } from '../types.ts';
import { addDays, daysBetween, startOfWeekISO } from './dates.ts';
import { funnelRatios } from './gauges.ts';
import { binomialZ, conversionTrend, weekSeriesStats, zScore, type WeekStat } from './stats.ts';

export const CHECK_IN_RULES: {
  maxPeople: number;
  minScore: number;
  weights: Readonly<Record<CheckInReasonCode, number>>;
} = {
  maxPeople: 5,
  minScore: 2,
  weights: {
    sustained_decline: 3,
    conversion_drop: 3,
    stops_drop: 2,
    attendance_drop: 2,
    zero_week: 2,
    earnings_drop: 2,
    trainee_slow: 2,
    late_often: 1,
  },
};

/** The gates behind each signal (documented in LOGIC §14.4; tests sit just either side of them). */
export const CHECK_IN_GATES = {
  /** (a) stops_drop: ≥ 4 worked weeks in the last 8, a usual ≥ 20 stops a day, ≥ 2 days this week, z ≤ −1.5. */
  stops: { weeks: 8, minWorkedWeeks: 4, minMean: 20, minCurrentDays: 2, z: -1.5 },
  /** (b) conversion_drop: the last 2 weeks have ≥ 150 stops; p0 from the 8 weeks before them (≥ 4 worked); z ≤ −2. */
  conversion: { recentWeeks: 2, baseWeeks: 8, minWorkedWeeks: 4, minStops: 150, z: -2 },
  /** (c) sustained_decline: conversionTrend over 16 weeks (8 v 8, ≥ 400 stops each half, z ≤ −2). */
  trend: { minStops: 400, z: 2 },
  /** (d) late_often: ≥ 3 of the last 10 check-ins late, and a late share above 2 × the team's. */
  late: { lastN: 10, minLate: 3, teamMultiple: 2 },
  /** (e) attendance_drop: ≥ 4 team event days in the last 14 days, a usual share ≥ 0.5, now under half of it. */
  attendance: { minRecentTeamDays: 4, minPriorShare: 0.5, dropFactor: 0.5 },
  /** (f) zero_week: no gauge days last week while the team had ≥ 3 event days. */
  zeroWeek: { minTeamDays: 3 },
  /** (g) earnings_drop: last 4 weeks ≤ 0.7 × the 4 before, and the 4 before ≥ £400. */
  earnings: { ratio: 0.7, minPrior: 400 },
  /** (h) trainee_slow: ≥ 42 days in, ≥ MIN_STOPS_FOR_INSIGHTS stops in 4 weeks, mean actual ÷ benchmark < 0.6. */
  trainee: { minDays: 42, minStops: MIN_STOPS_FOR_INSIGHTS, maxIndex: 0.6 },
} as const;

export interface PersonSignalInput {
  /** The business date (YYYY-MM-DD); every window ends the day before it. */
  today: string;
  position: Position;
  startDate: string;
  /** 16 completed Mon–Sun weeks before this Monday, oldest first, zero-filled (server weeklyHistory). */
  weeks16: ReadonlyArray<WeekStat>;
  /** This week so far (Monday up to yesterday). */
  current: WeekStat;
  /** Minutes late of the person's recorded check-ins in the last 8 weeks, newest first (≤ 0 = on time). */
  lateMinutes: ReadonlyArray<number>;
  /**
   * The rest of the team's share of late check-ins over the same 8 weeks (0..1): every check-in at the team's events
   * except the person's own; null when nobody else recorded one.
   */
  teamLateShare: number | null;
  /** The person's gauge dates and the team's completed event dates: last 14 days, and the 8 weeks before that. */
  attendance: { recentWorked: number; recentTeamDays: number; priorWorked: number; priorTeamDays: number };
  /** Gauge days in the last completed week and the team's event dates in it. */
  lastWeek: { workedDays: number; teamEventDays: number };
  /** Payroll gross for the last 8 completed weeks, oldest first (a week without a run = 0). */
  weeklyGross: ReadonlyArray<number>;
  /** Totals over the last 4 completed weeks (trainee_slow). */
  last4Weeks: GaugeTotals;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Oct" from YYYY-MM-DD (no time zone involved). */
function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`;
}

/** Conversion with one decimal place: 0.025 → "2.5%". */
function pct1(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

/** Whole-pound GBP, en-GB: 1640 → "£1,640". */
const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 0 });
function pounds(n: number): string {
  return GBP.format(Math.round(n));
}

const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0);

/** Σ of each gauge over a run of weeks (the server uses it for `last4Weeks`). */
export function checkInWeekTotals(weeks: ReadonlyArray<WeekStat>): GaugeTotals {
  const t: GaugeTotals = { stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 };
  for (const w of weeks) for (const k of GAUGE_KEYS) t[k] += w[k];
  return t;
}

const reason = (code: CheckInReasonCode, text: string): CheckInReason => ({ code, weight: CHECK_IN_RULES.weights[code], text });

/** (a) This week's stops per day well under the person's own usual (8 weeks). */
function stopsDrop(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.stops;
  const base = weekSeriesStats(input.weeks16.slice(-g.weeks));
  if (base.weeks < g.minWorkedWeeks || base.stopsPerDayMean < g.minMean) return null;
  if (input.current.days < g.minCurrentDays) return null;
  const perDay = input.current.stops / input.current.days;
  const z = zScore(perDay, base.stopsPerDayMean, base.stopsPerDaySd);
  if (z === null || z > g.z) return null;
  return reason('stops_drop', `Averaging ${Math.round(perDay)} stops a day this week against a usual ${Math.round(base.stopsPerDayMean)}`);
}

/** (b) The last two weeks' conversion well under the 8 weeks before them (one-sample binomial test). */
function conversionDrop(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.conversion;
  const weeks = input.weeks16;
  const recent = weeks.slice(-g.recentWeeks);
  const base = weekSeriesStats(weeks.slice(-(g.recentWeeks + g.baseWeeks), -g.recentWeeks));
  const stops = sum(recent.map((w) => w.stops));
  const sales = sum(recent.map((w) => w.sales));
  if (stops < g.minStops || base.weeks < g.minWorkedWeeks) return null;
  const z = binomialZ(sales, stops, base.pooledConversion);
  if (z === null || z > g.z) return null;
  return reason('conversion_drop', `Conversion ${pct1(sales / stops)} over the last two weeks against a usual ${pct1(base.pooledConversion)}`);
}

/** (c) Conversion has been lower for 8 weeks than in the 8 before (two-proportion test, shared conversionTrend). */
function sustainedDecline(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.trend;
  const trend = conversionTrend(input.weeks16, { minStops: g.minStops, z: g.z });
  if (!trend || trend.label !== 'declining') return null;
  return reason('sustained_decline', `Conversion ${pct1(trend.recentConversion)} over the last 8 weeks, down from ${pct1(trend.earlierConversion)} in the 8 before`);
}

/** "1 in 7" for a share (0 → "none"). */
function oneIn(share: number): string {
  if (!(share > 0)) return 'none';
  return `1 in ${Math.max(1, Math.round(1 / share))}`;
}

/** (d) Late for several of the last 10 check-ins, and clearly more often than the team. */
function lateOften(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.late;
  const lastN = input.lateMinutes.slice(0, g.lastN);
  if (!lastN.length) return null;
  const late = lastN.filter((m) => m > LATE_GRACE_MINUTES).length;
  if (late < g.minLate) return null;
  const share = late / lastN.length;
  const team = input.teamLateShare ?? 0;
  if (!(share > g.teamMultiple * team)) return null;
  return reason('late_often', `Late for ${late} of the last ${lastN.length} check-ins (team: ${oneIn(team)})`);
}

/** (e) Worked far fewer of the team's event days this fortnight than usual. */
function attendanceDrop(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.attendance;
  const a = input.attendance;
  if (a.recentTeamDays < g.minRecentTeamDays || !(a.priorTeamDays > 0)) return null;
  const prior = a.priorWorked / a.priorTeamDays;
  const recent = a.recentWorked / a.recentTeamDays;
  if (prior < g.minPriorShare || !(recent < g.dropFactor * prior)) return null;
  const usual = Math.round(prior * a.recentTeamDays);
  return reason('attendance_drop', `Worked ${a.recentWorked} of the team's ${a.recentTeamDays} event days this fortnight — usually ${usual} in ${a.recentTeamDays}`);
}

/** (f) No gauges at all last week while the team was out. */
function zeroWeek(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.zeroWeek;
  const lastMonday = addDays(startOfWeekISO(input.today), -7);
  if (input.lastWeek.workedDays > 0 || input.lastWeek.teamEventDays < g.minTeamDays) return null;
  if (!(input.startDate < lastMonday)) return null;
  return reason('zero_week', `No gauges logged last week (w/c ${dayMonth(lastMonday)}) while the team worked ${input.lastWeek.teamEventDays} event days`);
}

/** (g) Gross pay over the last four weeks well under the four before. */
function earningsDrop(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.earnings;
  const gross = input.weeklyGross.slice(-8);
  if (gross.length < 8) return null;
  const prior = sum(gross.slice(0, 4));
  const last = sum(gross.slice(4));
  if (prior < g.minPrior || last > g.ratio * prior) return null;
  return reason('earnings_drop', `Earnings ${pounds(prior)} → ${pounds(last)} over the last four weeks`);
}

/** (h) A trainee six weeks or more in whose funnel is still well under benchmark; names the stage to practise. */
function traineeSlow(input: PersonSignalInput): CheckInReason | null {
  const g = CHECK_IN_GATES.trainee;
  if (input.position !== 'trainee') return null;
  const days = daysBetween(input.startDate, input.today);
  if (days < g.minDays) return null;
  const t = input.last4Weeks;
  if (t.stops < g.minStops) return null;
  const ratios = funnelRatios(t);
  // Stages reached only (a stage nobody has reached yet has no rate); ties go to the earliest stage.
  const reached = RATIO_KEYS.filter((_, i) => t[GAUGE_KEYS[i]!] > 0).map((key) => ({ key, index: ratios[key] / BENCHMARK_RATIOS[key] }));
  if (!reached.length) return null;
  const meanIndex = sum(reached.map((r) => r.index)) / reached.length;
  if (!(meanIndex < g.maxIndex)) return null;
  const w = reached.reduce((lo, r) => (r.index < lo.index ? r : lo));
  const weeksIn = Math.floor(days / 7);
  return reason(
    'trainee_slow',
    `${weeksIn} weeks in and still finding the rhythm — ${RATIO_LABELS[w.key].toLowerCase()} is ${Math.round(ratios[w.key] * 100)}% against the ${Math.round(BENCHMARK_RATIOS[w.key] * 100)}% benchmark, a good one to practise together`,
  );
}

/** Reasons in this order within a person: heaviest first, then a fixed order (deterministic). */
const REASON_ORDER: readonly CheckInReasonCode[] = ['sustained_decline', 'conversion_drop', 'stops_drop', 'zero_week', 'attendance_drop', 'earnings_drop', 'trainee_slow', 'late_often'];

/** Every reason that fires for one person (with the suppressions: sustained_decline drops conversion_drop, zero_week drops attendance_drop). */
export function personSignals(input: PersonSignalInput): CheckInReason[] {
  const sustained = sustainedDecline(input);
  const zero = zeroWeek(input);
  const found = [
    sustained,
    sustained ? null : conversionDrop(input),
    stopsDrop(input),
    zero,
    zero ? null : attendanceDrop(input),
    earningsDrop(input),
    traineeSlow(input),
    lateOften(input),
  ].filter((r): r is CheckInReason => r !== null);
  return found.sort((a, b) => b.weight - a.weight || REASON_ORDER.indexOf(a.code) - REASON_ORDER.indexOf(b.code));
}

/** Drops scores < CHECK_IN_RULES.minScore, sorts by score desc then name, keeps the top CHECK_IN_RULES.maxPeople. */
export function rankCheckIns(people: ReadonlyArray<CheckInPerson>): CheckInPerson[] {
  return people
    .filter((p) => p.score >= CHECK_IN_RULES.minScore)
    .slice()
    .sort((a, b) => b.score - a.score || a.userName.localeCompare(b.userName, 'en-GB') || a.userId - b.userId)
    .slice(0, CHECK_IN_RULES.maxPeople);
}
