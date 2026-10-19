/**
 * Personal pace baseline — OWNED BY p2-personal-pace-streaks (stub and signatures laid down by p1).
 *
 * Compares this week so far with the person's OWN last 8 completed weeks (never with anyone else):
 *  - stops per day: z = (this week's stops ÷ days − μ) ÷ σ, where μ and σ are the mean and sample SD of each worked
 *    week's stops ÷ days (weekSeriesStats). Needs ≥ 2 worked days this week and σ > 0. z ≤ −1.5 warning, ≥ +1.5 positive.
 *  - conversion: z = binomialZ(sales, stops, p0) with p0 the pooled conversion of the 8 weeks. Needs ≥ 100 stops this
 *    week. z ≤ −2 warning, ≥ +2 positive.
 * Null when fewer than 4 of the 8 weeks were worked, or μ < 20 stops a day (new starters, recruiters, part-timers).
 *
 * Copy (LOGIC.md §14.0): British English, specific numbers (stops per day whole, conversion to 1 dp), one lever per
 * warning, positive alerts praise only and project nothing, deterministic. Both warnings → ONE combined alert that
 * leads with conversion. At most 2 alerts: warnings first, conversion before stops.
 * A stops warning says the conversion is "holding" (and gives the stops-per-sale figure) only when this week's
 * conversion was tested (≥ 100 stops) and is within 10% of the usual rate or better; otherwise it names volume as the
 * lever without a figure, so it never contradicts the Conversion tile or the coaching card's own figure.
 */
import type { BaselineAlert, GaugeTotals, PersonalBaseline } from '../types.ts';
import { BENCHMARK_TOLERANCE, RATIO_LABELS } from '../constants.ts';
import { compareToBenchmark, funnelRatios, weakestStage } from './gauges.ts';
import { binomialZ, weekSeriesStats, zScore, type WeekStat } from './stats.ts';

export const BASELINE_RULES = {
  windowWeeks: 8,
  minWeeks: 4,
  minStopsPerDay: 20,
  stopsZ: 1.5,
  minCurrentDays: 2,
  convZ: 2,
  minCurrentStops: 100,
  /** A stops warning calls the conversion "holding" when this week's rate is at least (1 − this) × the usual rate. */
  holdingWithin: 0.1,
} as const;

type Tone = BaselineAlert['tone'];

/** Whole stops per day, as the copy shows them. */
const wholeStops = (x: number): number => Math.round(x);
/** Conversion (0..1) as a percentage with one decimal place: 0.0394 → "3.9%". */
const pct1 = (x: number): string => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
/** 1240 → "1,240" (en-GB grouping without relying on the runtime's locale data). */
const count = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const round2 = (x: number): number => Math.round(x * 100) / 100;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The one lever of a conversion warning: the funnel stage with the lowest ratio against its benchmark this week.
 *  - more than the tolerance (10%) under → "<Stage> is furthest below benchmark";
 *  - under, but within the tolerance (benchmarkStatus 'on_track') → "No stage is more than 10% under benchmark, …";
 *  - every stage at benchmark or better (the person's usual is simply higher) → the stage closest to slipping under.
 */
function stageSentence(current: GaugeTotals): string {
  const ratios = funnelRatios(current);
  const stage = weakestStage(ratios) ?? compareToBenchmark(ratios)[0]!;
  const label = RATIO_LABELS[stage.key];
  if (stage.status === 'below') return `${label} is furthest below benchmark — start there.`;
  if (stage.delta < 0) {
    return `No stage is more than ${Math.round(BENCHMARK_TOLERANCE * 100)}% under benchmark, and ${lowerFirst(label)} is the furthest under it — start there.`;
  }
  return `Every stage is at benchmark or better, and ${lowerFirst(label)} is the closest to slipping under — start there.`;
}

/** personalBaselineFrom(last 8 completed weeks, this week so far) → PersonalBaseline | null. */
export function personalBaselineFrom(weeks8: ReadonlyArray<WeekStat>, current: WeekStat): PersonalBaseline | null {
  const usualWeeks = weeks8.slice(-BASELINE_RULES.windowWeeks);
  const s = weekSeriesStats(usualWeeks);
  if (s.weeks < BASELINE_RULES.minWeeks) return null;
  if (!(s.stopsPerDayMean >= BASELINE_RULES.minStopsPerDay)) return null;
  const mu = s.stopsPerDayMean;
  const sd = s.stopsPerDaySd;
  const p0 = s.pooledConversion;

  const days = Math.max(0, current.days);
  const stopsPerDay = days > 0 ? current.stops / days : 0;
  const conversion = current.stops > 0 ? current.sales / current.stops : 0;

  // Stops per day against the usual spread. The whole-number figures must differ, so the copy never reads
  // "41 against your usual 41".
  let stopsTone: Tone | null = null;
  let stopsZ: number | null = null;
  if (days >= BASELINE_RULES.minCurrentDays) {
    stopsZ = zScore(stopsPerDay, mu, sd);
    if (stopsZ !== null) {
      if (stopsZ <= -BASELINE_RULES.stopsZ && wholeStops(stopsPerDay) < wholeStops(mu)) stopsTone = 'warning';
      else if (stopsZ >= BASELINE_RULES.stopsZ && wholeStops(stopsPerDay) > wholeStops(mu)) stopsTone = 'positive';
    }
  }

  // Conversion against the pooled usual rate (binomial test; null when p0 is 0 or 1).
  const convTested = current.stops >= BASELINE_RULES.minCurrentStops;
  let convTone: Tone | null = null;
  let convZ: number | null = null;
  if (convTested) {
    convZ = binomialZ(current.sales, current.stops, p0);
    if (convZ !== null) {
      if (convZ <= -BASELINE_RULES.convZ && pct1(conversion) !== pct1(p0)) convTone = 'warning';
      else if (convZ >= BASELINE_RULES.convZ && pct1(conversion) !== pct1(p0)) convTone = 'positive';
    }
  }

  const a = wholeStops(stopsPerDay);
  const u = wholeStops(mu);
  const convClause = `Your conversion is ${pct1(conversion)} this week against your usual ${pct1(p0)} (${count(current.stops)} stops)`;
  const alerts: BaselineAlert[] = [];
  const stopsAlert = (tone: Tone, title: string, body: string): BaselineAlert => ({ metric: 'stopsPerDay', tone, z: round2(stopsZ ?? 0), current: stopsPerDay, usual: mu, title, body });
  const convAlert = (tone: Tone, title: string, body: string): BaselineAlert => ({ metric: 'conversion', tone, z: round2(convZ ?? 0), current: conversion, usual: p0, title, body });

  if (convTone === 'warning' && stopsTone === 'warning') {
    // One combined alert, led by conversion; its one lever is the weakest stage.
    alerts.push(convAlert('warning', 'Below your usual this week', `${convClause}, and you are averaging ${a} stops a day against your usual ${u}. ${stageSentence(current)}`));
  } else {
    if (convTone === 'warning') alerts.push(convAlert('warning', 'Conversion below your usual', `${convClause}. ${stageSentence(current)}`));
    if (stopsTone === 'warning') {
      // One lever: volume. Only a tested conversion that really is about usual (within 10%, or better) is "holding"
      // and earns the stops-per-sale figure. Untested (< 100 stops) or lower but not a warning → no figure: the
      // coaching card beside this note works from this period's own rate, and two different figures would clash.
      const holding = convTested && convZ !== null && conversion >= p0 * (1 - BASELINE_RULES.holdingWithin) - 1e-12;
      const lever = holding
        ? `Your conversion is holding, so volume is the lever: every extra ${Math.ceil(1 / p0 - 1e-9)} stops is about one sale.`
        : 'More stops mean more chances to sell, so volume is the lever.';
      alerts.push(stopsAlert('warning', 'Off your usual pace', `You are averaging ${a} stops a day this week against your usual ${u} — a slow site or a short day? ${lever}`));
    }
    if (convTone === 'positive') alerts.push(convAlert('positive', 'Converting above your usual', `${convClause}. Lovely work — whatever you are doing, keep doing it.`));
    if (stopsTone === 'positive') alerts.push(stopsAlert('positive', 'Ahead of your usual pace', `You are averaging ${a} stops a day this week, up on your usual ${u}. Great energy — keep it going.`));
  }

  return {
    weeks: s.weeks,
    stopsPerDayMean: mu,
    stopsPerDaySd: sd,
    conversion: p0,
    current: { days, stops: current.stops, sales: current.sales, stopsPerDay, conversion },
    alerts: alerts.slice(0, 2),
  };
}
