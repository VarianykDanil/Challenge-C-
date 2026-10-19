// Wording for this week's pay estimate — OWNED BY p3-money-forecast-payroll-checks.
// Used by the dashboard WeekPayStrip and the Finance → My pay "This week so far" card, so both say the same thing.
// Copy rules (LOGIC.md §14.0): always "estimate" or "about" plus a range; British English; specific numbers; kind.
import type { PayForecast } from '@lm/shared';
import { formatDecimal, formatGBP, formatNumber } from '@/lib/format';

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** True when low and high differ (enough history and days left, and the recent days were not all the same). */
export function hasRange(f: PayForecast): boolean {
  return f.high > f.low;
}

/** "£930–£1,140" (en dash, no spaces). A single figure when low = high, e.g. "£1,050–£1,050". */
export function forecastRange(f: PayForecast): string {
  return `${formatGBP(f.low)}–${formatGBP(f.high)}`;
}

/**
 * Why there is no range, or null when there is one. With no team event days left the figure is what is already
 * logged; with under 5 worked days in the last 8 weeks there is not enough history to estimate a spread. Otherwise
 * the estimate always has a range, even a single-figure one (for example when every recent day had the same sales):
 * it is shown as "£1,050–£1,050", never left out.
 */
export function forecastNoRangeReason(f: PayForecast, short = false): string | null {
  if (hasRange(f)) return null;
  if (f.remainingDays === 0) return short ? 'no days left' : 'no team event days left';
  if (f.basis.weeks === 0) return short ? 'no range yet' : 'not enough history for a range';
  return null;
}

/** What follows the amount: the range, or why there is none (never empty). */
export function forecastRangeNote(f: PayForecast): string {
  return forecastNoRangeReason(f) ?? forecastRange(f);
}

/** The phone version of the range note (the strip keeps to 2 lines at 360 px). */
export function forecastRangeNoteShort(f: PayForecast): string {
  return forecastNoRangeReason(f, true) ?? forecastRange(f);
}

/** "This week (estimate): about £1,050 · £930–£1,140". */
export function forecastHeadline(f: PayForecast): string {
  return `This week (estimate): about ${formatGBP(f.likely)} · ${forecastRangeNote(f)}`;
}

const LIKELIHOOD_LABEL = { likely: 'likely', possible: 'possible', unlikely: 'a stretch' } as const;

/**
 * One line about the bonus, or null when the plan has none:
 *  reached   "Bonus unlocked — 12 sales this week"
 *  gap 1     "One more sale unlocks your £75 bonus — about 23 stops at your rate"
 *  gap > 1   "3 more sales unlock your £75 bonus — about 80 stops (possible)"
 *  no days   "3 more sales would unlock your £75 bonus — no team event days left this week"
 */
export function bonusLine(f: PayForecast): string | null {
  if (f.bonusLikelihood === 'none') return null;
  if (f.bonusLikelihood === 'reached') return `Bonus unlocked — ${plural(f.soFar.sales, 'sale')} this week`;
  const bonus = formatGBP(f.bonusAmount);
  if (f.remainingDays === 0) {
    return `${f.bonusGap === 1 ? 'One more sale' : `${formatNumber(f.bonusGap)} more sales`} would unlock your ${bonus} bonus — no team event days left this week`;
  }
  const stops = f.stopsForBonus != null ? ` — about ${plural(f.stopsForBonus, 'stop')}` : '';
  if (f.bonusGap === 1) return `One more sale unlocks your ${bonus} bonus${stops}${stops ? ' at your rate' : ''}`;
  return `${formatNumber(f.bonusGap)} more sales unlock your ${bonus} bonus${stops} (${LIKELIHOOD_LABEL[f.bonusLikelihood]})`;
}

/**
 * The phone version of the bonus line: the same facts — the gap, the bonus, the stops it takes and how likely it is —
 * in the shortest wording, so it fits one line at 360 px ("~" stands for "about"; the full sentence is on Finance →
 * My pay and in the strip's accessible name):
 *  reached   "Bonus unlocked — 12 sales this week"
 *  gap 1     "£75 bonus: one more sale · ~23 stops"
 *  gap > 1   "£75 bonus: 3 more sales · ~80 stops (possible)"
 *  no days   "3 more sales would unlock your £75 bonus" (the headline already says there are no days left)
 * Without a stops figure (too few stops logged, or none converted) the "· ~N stops" part is left out.
 */
export function bonusLineShort(f: PayForecast): string | null {
  if (f.bonusLikelihood === 'none') return null;
  if (f.bonusLikelihood === 'reached') return `Bonus unlocked — ${plural(f.soFar.sales, 'sale')} this week`;
  const bonus = formatGBP(f.bonusAmount);
  if (f.remainingDays === 0) return `${f.bonusGap === 1 ? 'One more sale' : `${formatNumber(f.bonusGap)} more sales`} would unlock your ${bonus} bonus`;
  const stops = f.stopsForBonus != null ? ` · ~${plural(f.stopsForBonus, 'stop')}` : '';
  if (f.bonusGap === 1) return `${bonus} bonus: one more sale${stops}`;
  return `${bonus} bonus: ${formatNumber(f.bonusGap)} more sales${stops} (${LIKELIHOOD_LABEL[f.bonusLikelihood]})`;
}

/** "your 2.1 sales a day over the last 8 weeks, for the 2 team event days left" (the method, for the tooltip). */
export function forecastMethod(f: PayForecast): string {
  const days = f.remainingDays === 0 ? 'with no team event days left this week' : `for the ${plural(f.remainingDays, 'team event day')} left`;
  if (f.basis.weeks === 0) {
    const worked = f.basis.workedDays === 0 ? 'no worked days' : `only ${plural(f.basis.workedDays, 'worked day')}`;
    return `${worked} in the last 8 weeks, so not enough history for a range yet: what you have logged plus base pay ${days}`;
  }
  return `your ${formatDecimal(f.basis.salesPerDay)} sales a day over the last ${plural(f.basis.weeks, 'week')}, ${days}`;
}

export const FORECAST_LABEL = "Estimate — Friday's payslip is the official figure";
