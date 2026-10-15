// Owned by the Frontend Developer. Date range presets (Monday-start weeks) → `{ from, to }` ISO dates.
import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import type { DashboardRange } from '@lm/shared';

export interface DateRange { from: string; to: string }

export type RangePreset =
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'quarter'
  | 'last_4_weeks'
  | 'last_12_weeks'
  | 'next_3_weeks';

export const WEEK_OPTS = { weekStartsOn: 1 as const };

export function toISODate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}
export function todayISO(): string {
  return toISODate(new Date());
}

/**
 * Compute an inclusive `{from,to}` range for a preset. Weeks start on Monday.
 * With `clampToToday`, current periods (this week/month) end today rather than at the period end,
 * so performance charts do not trail off into days that have not happened yet.
 */
export function presetRange(preset: RangePreset, now: Date = new Date(), clampToToday = false): DateRange {
  const r = rawPresetRange(preset, now);
  const today = toISODate(now);
  return clampToToday && r.to > today && r.from <= today ? { from: r.from, to: today } : r;
}

function rawPresetRange(preset: RangePreset, now: Date): DateRange {
  switch (preset) {
    case 'this_week':
      return { from: toISODate(startOfWeek(now, WEEK_OPTS)), to: toISODate(endOfWeek(now, WEEK_OPTS)) };
    case 'last_week': {
      const lw = subWeeks(now, 1);
      return { from: toISODate(startOfWeek(lw, WEEK_OPTS)), to: toISODate(endOfWeek(lw, WEEK_OPTS)) };
    }
    case 'this_month':
      return { from: toISODate(startOfMonth(now)), to: toISODate(endOfMonth(now)) };
    case 'last_month': {
      const lm = subMonths(now, 1);
      return { from: toISODate(startOfMonth(lm)), to: toISODate(endOfMonth(lm)) };
    }
    case 'quarter':
      return { from: toISODate(startOfQuarter(now)), to: toISODate(now) };
    case 'last_4_weeks':
      return { from: toISODate(startOfWeek(subWeeks(now, 3), WEEK_OPTS)), to: toISODate(now) };
    case 'last_12_weeks':
      return { from: toISODate(startOfWeek(subWeeks(now, 11), WEEK_OPTS)), to: toISODate(now) };
    case 'next_3_weeks':
      return { from: toISODate(subDays(now, 7)), to: toISODate(addDays(now, 21)) };
  }
}

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  quarter: 'This quarter',
  last_4_weeks: 'Last 4 weeks',
  last_12_weeks: 'Last 12 weeks',
  next_3_weeks: 'Upcoming',
};

/** The standard set used by performance pages. */
export const PERFORMANCE_PRESETS: RangePreset[] = ['this_week', 'last_week', 'this_month', 'last_month', 'quarter'];

/** Map a dashboard range (`week|month|quarter`) to a preset. */
export function dashboardRangePreset(range: DashboardRange): RangePreset {
  return range === 'week' ? 'this_week' : range === 'month' ? 'this_month' : 'quarter';
}

/** True when `date` (YYYY-MM-DD) is today in local time. */
export function isTodayISO(date: string): boolean {
  return date === todayISO();
}

/** Monday of the week containing `date`. */
export function weekStartISO(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00`) : date;
  return toISODate(startOfWeek(d, WEEK_OPTS));
}

/** Local "now" as an ISO timestamp suitable for `datetime-local` inputs ("YYYY-MM-DDTHH:mm"). */
export function nowLocalInput(): string {
  return format(new Date(), "yyyy-MM-dd'T'HH:mm");
}
/** Convert a `datetime-local` value to a full ISO timestamp (or null when empty). */
export function localInputToISO(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** Convert an ISO timestamp to a `datetime-local` value. */
export function isoToLocalInput(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : format(d, "yyyy-MM-dd'T'HH:mm");
}
