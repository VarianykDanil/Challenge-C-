/**
 * Coaching insights: 1–3 short, specific, encouraging messages derived from a funnel.
 * British English; percentages are whole numbers.
 *
 * `subject` says whose funnel it is (smart release 1.1, p4):
 *  - 'you'      a person's own funnel (dashboard, Gauges): second person. The default; its wording is unchanged.
 *  - 'team'     a leader's team (dashboard team card): "The team's stop-to-table rate is …" with huddle-sized tips.
 *  - 'company'  every team (the company section): "Linear MCR's stop-to-table rate is …" with tips for the leaders.
 * The rules (which stages, how many messages, in what order) are the same for every subject; only the words change.
 */
import type { FunnelRatios, GaugeTotals } from '../types.ts';
import { BENCHMARK_RATIOS, MIN_STOPS_FOR_INSIGHTS, type RatioKey } from '../constants.ts';
import { compareToBenchmark, ratioKeys, type BenchmarkComparison, type Benchmarks } from './gauges.ts';

export type InsightTone = 'positive' | 'neutral' | 'warning';

/** Whose funnel the insights describe. */
export type InsightSubject = 'you' | 'team' | 'company';

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

/** What a leader can run with the team when a stage is below benchmark (one lever each, huddle-sized). */
export const TEAM_COACHING_TIPS: Record<RatioKey, string> = {
  stopToTable: 'Run a five-minute opener drill at the huddle — pair people up to practise a warm first line and open posture.',
  tableToPresentation: 'Role-play the bridge at the huddle — pairs practise moving from small talk into the pitch so people stay at the table.',
  presentationToClose: 'Practise the close together at the huddle — everyone finishes a mock pitch by asking for the sale.',
  closeToTap: 'Rehearse the three most common objections at the huddle, and check every tablet is charged before the doors open.',
  tapToSale: 'Spend five minutes at the huddle on the sign-up form — names, addresses and bank details checked twice so every tap confirms.',
};

/** What the owner can ask of the leaders when a stage is below benchmark across the company. */
export const COMPANY_COACHING_TIPS: Record<RatioKey, string> = {
  stopToTable: "Make the opener the theme of this week's leaders' catch-up, so every team runs the same five-minute drill at its huddle.",
  tableToPresentation: 'Ask every leader to role-play the bridge into the pitch at their huddles this week.',
  presentationToClose: 'Ask every leader to practise asking for the sale at their huddles this week.',
  closeToTap: 'Check every team has charged tablets and a short objection crib sheet, and ask the leaders to rehearse the common objections.',
  tapToSale: 'Ask the leaders to spot-check sign-up forms this week — clean names, addresses and bank details turn taps into sales.',
};

/** What is going well when a stage is above benchmark. */
const STRENGTH_PRAISE: Record<RatioKey, string> = {
  stopToTable: 'Your opener is landing — people want to hear what you have to say.',
  tableToPresentation: 'You hold attention well — most people who stop stay for the full pitch.',
  presentationToClose: 'You ask for the sale — that confidence is exactly what the funnel needs.',
  closeToTap: 'You turn a yes into a signature — your objection handling is working.',
  tapToSale: 'Your paperwork is clean — sign-ups are confirming as sales.',
};

const TEAM_STRENGTH_PRAISE: Record<RatioKey, string> = {
  stopToTable: "The team's openers are landing — people want to hear what they have to say.",
  tableToPresentation: 'The team holds attention well — most people who stop stay for the full pitch.',
  presentationToClose: 'The team asks for the sale — that confidence is exactly what the funnel needs.',
  closeToTap: 'The team turns a yes into a signature — the objection handling is working.',
  tapToSale: "The team's paperwork is clean — sign-ups are confirming as sales.",
};

const COMPANY_STRENGTH_PRAISE: Record<RatioKey, string> = {
  stopToTable: 'Openers are landing across the teams — people want to hear what the reps have to say.',
  tableToPresentation: 'The teams hold attention well — most people who stop stay for the full pitch.',
  presentationToClose: 'The teams ask for the sale — that confidence is exactly what the funnel needs.',
  closeToTap: 'The teams turn a yes into a signature — the objection handling is working.',
  tapToSale: 'Paperwork is clean across the teams — sign-ups are confirming as sales.',
};

type Message = Pick<Insight, 'title' | 'body'>;

/** Every subject-dependent word in one place, so the rules below are shared. */
interface Voice {
  /** Whose rate it is, at the start of a sentence: "Your", "The team's", "Linear MCR's". */
  possessive: string;
  tips: Record<RatioKey, string>;
  praise: Record<RatioKey, string>;
  focusTitle: (label: string) => string;
  strengthTitle: (label: string) => string;
  nextTitle: (label: string) => string;
  noGauges: Message;
  earlyDays: (stops: number) => Message;
  allOnTrack: Message;
  onTrackSoFar: Message;
  volume: (perSale: number) => Message;
  noSaleYet: (stops: number) => Message;
}

const VOICES: Record<InsightSubject, Voice> = {
  you: {
    possessive: 'Your',
    tips: COACHING_TIPS,
    praise: STRENGTH_PRAISE,
    focusTitle: (label) => `Focus on ${label}`,
    strengthTitle: (label) => `Strong ${label}`,
    nextTitle: (label) => `Next up: ${label}`,
    noGauges: {
      title: 'No gauges yet',
      body: 'Log your stops, tables, presentations, closes, taps and sales after each shift and your coaching will appear here.',
    },
    earlyDays: (stops) => ({
      title: 'Early days',
      body: `With ${stops} stops logged the ratios will still swing a lot — aim for ${MIN_STOPS_FOR_INSIGHTS}+ stops before reading too much into them.`,
    }),
    allOnTrack: {
      title: 'Every stage on track',
      body: 'All five ratios are within 10% of benchmark — a textbook funnel. Keep doing what you are doing.',
    },
    onTrackSoFar: {
      title: 'On track so far',
      body: 'Every stage you have reached is within 10% of benchmark — keep the momentum going to the sale.',
    },
    volume: (perSale) => ({
      title: 'Volume is your lever',
      body: `At your current conversion it takes about ${perSale} stops per sale, so every extra ${perSale} stops is another sale in the bag.`,
    }),
    noSaleYet: (stops) => ({
      title: 'Keep the stops up',
      body: `You have ${stops} stops logged and no confirmed sale yet — stay consistent, the law of averages pays out to those who keep stopping.`,
    }),
  },
  team: {
    possessive: "The team's",
    tips: TEAM_COACHING_TIPS,
    praise: TEAM_STRENGTH_PRAISE,
    focusTitle: (label) => `Team focus: ${label}`,
    strengthTitle: (label) => `Team strength: ${label}`,
    nextTitle: (label) => `Next for the team: ${label}`,
    noGauges: {
      title: 'No team gauges yet',
      body: 'Once the team logs its stops, tables, presentations, closes, taps and sales, team coaching will appear here.',
    },
    earlyDays: (stops) => ({
      title: 'Early days for the team',
      body: `With ${stops} stops logged the team's ratios will still swing a lot — aim for ${MIN_STOPS_FOR_INSIGHTS}+ stops before reading too much into them.`,
    }),
    allOnTrack: {
      title: 'Every team stage on track',
      body: "All five of the team's ratios are within 10% of benchmark — a textbook funnel. Keep the huddles doing what they are doing.",
    },
    onTrackSoFar: {
      title: 'The team is on track so far',
      body: 'Every stage the team has reached is within 10% of benchmark — keep the momentum going to the sale.',
    },
    volume: (perSale) => ({
      title: "Volume is the team's lever",
      body: `At the team's current conversion it takes about ${perSale} stops per sale, so every extra ${perSale} stops across the team is another sale.`,
    }),
    noSaleYet: (stops) => ({
      title: 'Keep the team stopping',
      body: `The team has ${stops} stops logged and no confirmed sale yet — keep the huddles upbeat, the law of averages pays out to teams who keep stopping.`,
    }),
  },
  company: {
    possessive: "Linear MCR's",
    tips: COMPANY_COACHING_TIPS,
    praise: COMPANY_STRENGTH_PRAISE,
    focusTitle: (label) => `Company focus: ${label}`,
    strengthTitle: (label) => `Company strength: ${label}`,
    nextTitle: (label) => `Next for the company: ${label}`,
    noGauges: {
      title: 'No company gauges yet',
      body: 'Once the teams log their stops, tables, presentations, closes, taps and sales, company coaching will appear here.',
    },
    earlyDays: (stops) => ({
      title: 'Early days for the company',
      body: `With ${stops} stops logged across Linear MCR the ratios will still swing a lot — aim for ${MIN_STOPS_FOR_INSIGHTS}+ stops before reading too much into them.`,
    }),
    allOnTrack: {
      title: 'Every company stage on track',
      body: "All five of Linear MCR's ratios are within 10% of benchmark — a textbook funnel across the teams.",
    },
    onTrackSoFar: {
      title: 'The company is on track so far',
      body: 'Every stage Linear MCR has reached is within 10% of benchmark — keep the momentum going to the sale.',
    },
    volume: (perSale) => ({
      title: "Volume is the company's lever",
      body: `At Linear MCR's current conversion it takes about ${perSale} stops per sale, so every extra ${perSale} stops across the teams is another sale.`,
    }),
    noSaleYet: (stops) => ({
      title: 'Keep the teams stopping',
      body: `Linear MCR has ${stops} stops logged and no confirmed sale yet — keep the teams consistent, the law of averages pays out to those who keep stopping.`,
    }),
  },
};

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function describe(v: Voice, c: BenchmarkComparison): string {
  return `${v.possessive} ${RATIO_PHRASE[c.key]} is ${pct(c.actual)} vs the ${pct(c.benchmark)} benchmark`;
}

function warningFor(v: Voice, c: BenchmarkComparison): Insight {
  return {
    tone: 'warning',
    key: c.key,
    title: v.focusTitle(c.label.toLowerCase()),
    body: `${describe(v, c)}. ${v.tips[c.key]}`,
  };
}

function positiveFor(v: Voice, c: BenchmarkComparison): Insight {
  return {
    tone: 'positive',
    key: c.key,
    title: v.strengthTitle(c.label.toLowerCase()),
    body: `${describe(v, c)}. ${v.praise[c.key]}`,
  };
}

function volumeTip(v: Voice, totals: GaugeTotals, ratios: FunnelRatios): Insight {
  if (ratios.stopsPerSale !== null && Number.isFinite(ratios.stopsPerSale) && ratios.stopsPerSale > 0) {
    return { tone: 'neutral', ...v.volume(Math.ceil(ratios.stopsPerSale)) };
  }
  return { tone: 'neutral', ...v.noSaleYet(totals.stops) };
}

/**
 * Build 1–3 coaching insights from a funnel's totals and ratios:
 *  - no stops yet → one neutral prompt to log gauges
 *  - a small sample → a neutral caveat plus the single weakest stage
 *  - otherwise → a strength (if any), the weakest stage below benchmark (if any) and a tip for the
 *    next-weakest stage or on volume
 * `subject` changes the wording only ('you', the default, is a person's own funnel).
 */
export function coachingInsights(
  totals: GaugeTotals,
  ratios: FunnelRatios,
  benchmarks: Benchmarks = BENCHMARK_RATIOS,
  subject: InsightSubject = 'you',
): Insight[] {
  const v = VOICES[subject] ?? VOICES.you;
  if (!(totals.stops > 0)) {
    return [{ tone: 'neutral', ...v.noGauges }];
  }

  // A stage nobody has reached yet (e.g. no taps) has an undefined ratio, not a poor one — skip it.
  const reached = new Set(ratioKeys.filter((step) => totals[step.from] > 0).map((step) => step.key));
  const rows = compareToBenchmark(ratios, benchmarks).filter((r) => reached.has(r.key));
  const allReached = rows.length === ratioKeys.length;
  const below = rows.filter((r) => r.status === 'below').sort((a, b) => a.relativeDelta - b.relativeDelta);
  const above = rows.filter((r) => r.status === 'above').sort((a, b) => b.relativeDelta - a.relativeDelta);
  const out: Insight[] = [];

  if (totals.stops < MIN_STOPS_FOR_INSIGHTS) {
    out.push({ tone: 'neutral', ...v.earlyDays(totals.stops) });
    if (below[0]) out.push(warningFor(v, below[0]));
    else if (above[0]) out.push(positiveFor(v, above[0]));
    return out;
  }

  if (above[0]) out.push(positiveFor(v, above[0]));
  else if (below.length === 0) {
    out.push({ tone: 'positive', ...(allReached ? v.allOnTrack : v.onTrackSoFar) });
  }

  if (below[0]) out.push(warningFor(v, below[0]));

  if (below[1]) {
    const c = below[1];
    out.push({
      tone: 'neutral',
      key: c.key,
      title: v.nextTitle(c.label.toLowerCase()),
      body: `${describe(v, c)}. ${v.tips[c.key]}`,
    });
  } else {
    out.push(volumeTip(v, totals, ratios));
  }

  return out.slice(0, 3);
}
