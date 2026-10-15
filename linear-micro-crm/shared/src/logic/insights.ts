/**
 * Coaching insights: 1–3 short, specific, encouraging messages derived from a rep's funnel.
 * British English; percentages are whole numbers.
 */
import type { FunnelRatios, GaugeTotals } from '../types.ts';
import { BENCHMARK_RATIOS, MIN_STOPS_FOR_INSIGHTS, type RatioKey } from '../constants.ts';
import { compareToBenchmark, ratioKeys, type BenchmarkComparison, type Benchmarks } from './gauges.ts';

export type InsightTone = 'positive' | 'neutral' | 'warning';

export interface Insight {
  tone: InsightTone;
  title: string;
  body: string;
  /** The ratio this insight is about, when it is about one. */
  key?: RatioKey;
}

/** Plain-English name of each ratio as it reads in a sentence. */
const RATIO_PHRASE: Record<RatioKey, string> = {
  stopToTable: 'stop-to-table rate',
  tableToPresentation: 'table-to-presentation rate',
  presentationToClose: 'presentation-to-close rate',
  closeToTap: 'close-to-tap rate',
  tapToSale: 'tap-to-sale rate',
};

/** What to practise when a stage is below benchmark. */
export const COACHING_TIPS: Record<RatioKey, string> = {
  stopToTable: 'Work on the opener — a warm smile, open posture and a confident first line bring more people to the table.',
  tableToPresentation: 'Practise the bridge into the pitch — move smoothly from small talk into the presentation so people stay with you.',
  presentationToClose: 'Ask for the sale every time — finish each presentation with a clear, confident close rather than waiting to be asked.',
  closeToTap: 'Make saying yes easy — have the tablet ready, handle the common objections calmly and guide the card to the reader.',
  tapToSale: 'Slow down at the tap — double-check names, addresses and bank details so every sign-up confirms as a sale.',
};

/** What is going well when a stage is above benchmark. */
const STRENGTH_PRAISE: Record<RatioKey, string> = {
  stopToTable: 'Your opener is landing — people want to hear what you have to say.',
  tableToPresentation: 'You hold attention well — most people who stop stay for the full pitch.',
  presentationToClose: 'You ask for the sale — that confidence is exactly what the funnel needs.',
  closeToTap: 'You turn a yes into a signature — your objection handling is working.',
  tapToSale: 'Your paperwork is clean — sign-ups are confirming as sales.',
};

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function describe(c: BenchmarkComparison): string {
  return `Your ${RATIO_PHRASE[c.key]} is ${pct(c.actual)} vs the ${pct(c.benchmark)} benchmark`;
}

function warningFor(c: BenchmarkComparison): Insight {
  return {
    tone: 'warning',
    key: c.key,
    title: `Focus on ${c.label.toLowerCase()}`,
    body: `${describe(c)}. ${COACHING_TIPS[c.key]}`,
  };
}

function positiveFor(c: BenchmarkComparison): Insight {
  return {
    tone: 'positive',
    key: c.key,
    title: `Strong ${c.label.toLowerCase()}`,
    body: `${describe(c)}. ${STRENGTH_PRAISE[c.key]}`,
  };
}

function volumeTip(totals: GaugeTotals, ratios: FunnelRatios): Insight {
  if (Number.isFinite(ratios.stopsPerSale) && ratios.stopsPerSale > 0) {
    const perSale = Math.ceil(ratios.stopsPerSale);
    return {
      tone: 'neutral',
      title: 'Volume is your lever',
      body: `At your current conversion it takes about ${perSale} stops per sale, so every extra ${perSale} stops is another sale in the bag.`,
    };
  }
  return {
    tone: 'neutral',
    title: 'Keep the stops up',
    body: `You have ${totals.stops} stops logged and no confirmed sale yet — stay consistent, the law of averages pays out to those who keep stopping.`,
  };
}

/**
 * Build 1–3 coaching insights from a rep's totals and ratios:
 *  - no stops yet → one neutral prompt to log gauges
 *  - a small sample → a neutral caveat plus the single weakest stage
 *  - otherwise → a strength (if any), the weakest stage below benchmark (if any) and a tip for the
 *    next-weakest stage or on volume
 */
export function coachingInsights(
  totals: GaugeTotals,
  ratios: FunnelRatios,
  benchmarks: Benchmarks = BENCHMARK_RATIOS,
): Insight[] {
  if (!(totals.stops > 0)) {
    return [
      {
        tone: 'neutral',
        title: 'No gauges yet',
        body: 'Log your stops, tables, presentations, closes, taps and sales after each shift and your coaching will appear here.',
      },
    ];
  }

  // A stage nobody has reached yet (e.g. no taps) has an undefined ratio, not a poor one — skip it.
  const reached = new Set(ratioKeys.filter((step) => totals[step.from] > 0).map((step) => step.key));
  const rows = compareToBenchmark(ratios, benchmarks).filter((r) => reached.has(r.key));
  const allReached = rows.length === ratioKeys.length;
  const below = rows.filter((r) => r.status === 'below').sort((a, b) => a.relativeDelta - b.relativeDelta);
  const above = rows.filter((r) => r.status === 'above').sort((a, b) => b.relativeDelta - a.relativeDelta);
  const out: Insight[] = [];

  if (totals.stops < MIN_STOPS_FOR_INSIGHTS) {
    out.push({
      tone: 'neutral',
      title: 'Early days',
      body: `With ${totals.stops} stops logged the ratios will still swing a lot — aim for ${MIN_STOPS_FOR_INSIGHTS}+ stops before reading too much into them.`,
    });
    if (below[0]) out.push(warningFor(below[0]));
    else if (above[0]) out.push(positiveFor(above[0]));
    return out;
  }

  if (above[0]) out.push(positiveFor(above[0]));
  else if (below.length === 0) {
    out.push(
      allReached
        ? {
            tone: 'positive',
            title: 'Every stage on track',
            body: 'All five ratios are within 10% of benchmark — a textbook funnel. Keep doing what you are doing.',
          }
        : {
            tone: 'positive',
            title: 'On track so far',
            body: 'Every stage you have reached is within 10% of benchmark — keep the momentum going to the sale.',
          },
    );
  }

  if (below[0]) out.push(warningFor(below[0]));

  if (below[1]) {
    const c = below[1];
    out.push({
      tone: 'neutral',
      key: c.key,
      title: `Next up: ${c.label.toLowerCase()}`,
      body: `${describe(c)}. ${COACHING_TIPS[c.key]}`,
    });
  } else {
    out.push(volumeTip(totals, ratios));
  }

  return out.slice(0, 3);
}
