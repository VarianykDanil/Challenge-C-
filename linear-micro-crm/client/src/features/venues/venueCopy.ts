// Release 1.3 — P8 venue-insights: the words around venue figures and event plans (British English, numbers with units,
// estimates called estimates, kind about people — docs/r3/P8-venue-insights.md). Pure helpers, no React.
import { VENUE_RULES, type EventPlan, type GaugeKey, type SalesEventWithMeta, type VenueStability, type VenueStabilityKey } from '@lm/shared';
import { formatNumber, pluralise } from '@/lib/format';
import { todayISO } from '@/lib/dates';

/** ISO weekday (1 = Monday) → "Mon". */
export const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAY_LONG = ['', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'] as const;

/** How a plan step reads after its number ("42 to table"). */
export const STEP_LABELS: Record<GaugeKey, [string, string]> = {
  stops: ['stop', 'stops'],
  table: ['to table', 'to table'],
  presentations: ['presentation', 'presentations'],
  closes: ['close', 'closes'],
  taps: ['tap', 'taps'],
  sales: ['sale', 'sales'],
};

export function stepLabel(key: GaugeKey, n: number): string {
  const [one, many] = STEP_LABELS[key];
  return n === 1 ? one : many;
}

export const STABILITY_TEXT: Record<VenueStability, string> = {
  steady: 'Steady',
  fairly_steady: 'Fairly steady',
  varies: 'Varies',
};

export const STABILITY_TONE: Record<VenueStability, 'success' | 'primary' | 'warning'> = {
  steady: 'success',
  fairly_steady: 'primary',
  varies: 'warning',
};

export const STABILITY_LABELS: Record<VenueStabilityKey, string> = {
  stopToTable: 'Stop → table',
  tableToPresentation: 'Table → presentation',
  presentationToClose: 'Presentation → close',
  closeToTap: 'Close → tap',
  tapToSale: 'Tap → sale',
  overallConversion: 'Stop → sale',
};

/** Bookings are open while the event is scheduled or live and dated today or later (the server's rule). */
export function bookingsOpen(e: Pick<SalesEventWithMeta, 'status' | 'date'>, today = todayISO()): boolean {
  return (e.status === 'scheduled' || e.status === 'live') && e.date >= today;
}

/** "5 sales" */
export const salesText = (n: number) => `${formatNumber(n)} ${n === 1 ? 'sale' : 'sales'}`;

/**
 * Who the event's target is shared among, in a few words: "the 6 booked", or — while the roster is still filling up,
 * or on a live day with walk-ups — "the 6 expected (4 booked so far)".
 */
function amongText(plan: EventPlan, booked: number): string {
  const among = plan.sharedAmong ?? booked;
  if (among === booked) return `the ${formatNumber(among)} booked`;
  return `the ${formatNumber(among)} expected (${formatNumber(booked)} booked so far)`;
}

/**
 * Where the target came from, for the person themself ("you") or for a leader reading someone else's plan (a name):
 * "Your good day: 5 sales (the event needs 3 each from the 6 booked)." When the event's share is far above a good day
 * (more than 1.5 × and 2 sales or more), the plan aims for the good day and says what the share is, kindly.
 */
export function planTargetText(plan: EventPlan, booked: number, who: 'you' | string = 'you'): string {
  const share = plan.eventShare;
  const among = amongText(plan, booked);
  // inside brackets already: "(the event needs 4 each from the 6 expected; 2 are booked so far)", never brackets in
  // brackets (re-review copy fix)
  const expected = plan.sharedAmong ?? booked;
  const amongFlat = expected === booked ? among : `the ${formatNumber(expected)} expected; ${formatNumber(booked)} ${booked === 1 ? 'is' : 'are'} booked so far`;
  const needs = share != null ? ` (the event needs ${formatNumber(share)} each from ${amongFlat})` : '';
  const yours = who === 'you' ? 'Your' : `${who}'s`;
  if (plan.shareAboveGoodDay && share != null) {
    const good = plan.targetSource === 'good-day' ? `${yours} good day` : 'A good day here';
    return `${good}: ${salesText(plan.targetSales)}. The event's target works out at ${salesText(share)} each for ${among}, well above a good day, so the plan aims for a good day.`;
  }
  if (plan.targetSource === 'good-day') return `${yours} good day: ${salesText(plan.targetSales)}${needs}.`;
  if (plan.targetSource === 'venue-good-day') {
    const few = plan.limited ? `this plan uses the venue's numbers` : who === 'you' ? 'you have few shifts so far' : `${who} has few shifts so far`;
    return `A good day here: ${salesText(plan.targetSales)}, as ${few}${needs}.`;
  }
  if (share == null) return `Aim for ${salesText(plan.targetSales)}.`;
  const good = plan.goodDay != null && !plan.limited ? ` ${yours} good day is ${salesText(plan.goodDay)}.` : '';
  return `The event's target shared by ${among}: ${salesText(share)} each.${good}`;
}

/** "From your last 8 weeks (30 shifts) and everyone's 94 shifts at Golden Square, the venue counting for 25%." */
export function planBasisText(plan: EventPlan, who: 'you' | string = 'you'): string {
  const venue = plan.venueName ?? 'this venue';
  const own = plan.basis.ownShifts;
  const there = plan.basis.venueShifts;
  const weeks = `${VENUE_RULES.ownWeeks} weeks`;
  const everyone = there > 0 ? `everyone's ${pluralise(there, 'shift')} at ${venue}` : `the company's numbers (no shifts logged at ${venue} yet)`;
  // a leader reading the plan of someone the office booked from another team (never the person's own plan)
  if (plan.limited) return `From ${everyone} only: ${who === 'you' ? 'this person' : who} is on another team, so their own numbers are not used here.`;
  if (own === 0) return `${who === 'you' ? 'You have' : `${who} has`} no shifts in the last ${weeks}, so this uses ${everyone}.`;
  const whose = who === 'you' ? 'your' : `${who}'s`;
  return `From ${whose} last ${weeks} (${pluralise(own, 'shift')}) and ${everyone}, the venue counting for ${Math.round(plan.venueWeight * 100)}%.`;
}

/** "Most days 77–187 stops: luck evens out over many shifts, not in one." (the stops step's range) */
export function planRangeText(plan: EventPlan): string | null {
  const stops = plan.steps.find((s) => s.key === 'stops');
  if (!stops || stops.high <= stops.low) return null;
  return `Most days that takes ${formatNumber(stops.low)}–${formatNumber(stops.high)} stops: luck evens out over many shifts, not in one.`;
}
