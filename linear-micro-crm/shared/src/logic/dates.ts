/**
 * Date helpers on plain `YYYY-MM-DD` strings.
 *
 * All arithmetic goes through `Date.UTC`, so adding days or finding the start of a week is
 * immune to daylight-saving changes (Europe/London switches twice a year) and to the
 * timezone of the machine running the code. Only `toISODate(Date)` and `todayISO()` read the
 * local clock — that is deliberate: "today" means the user's calendar day.
 */
import type { DashboardRange } from '../types.ts';

export const DAY_MS = 86_400_000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateRange {
  from: string;
  to: string;
}

export interface ISOWeek {
  /** ISO week-numbering year (can differ from the calendar year around New Year). */
  year: number;
  /** 1..53 */
  week: number;
}

/** True when `iso` is a real calendar date written as `YYYY-MM-DD`. */
export function isValidISODate(iso: string): boolean {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function assertISO(iso: string): void {
  if (!isValidISODate(iso)) throw new RangeError(`Invalid ISO date: "${iso}" (expected YYYY-MM-DD)`);
}

/** Milliseconds since epoch for UTC midnight of the given date. */
export function isoToUTC(iso: string): number {
  assertISO(iso);
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function utcToISO(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Local calendar date of a `Date` as `YYYY-MM-DD` (what "today" means to the user). */
export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** UTC calendar date of a `Date` as `YYYY-MM-DD` (for timestamps stored in UTC). */
export function toISODateUTC(date: Date): string {
  return utcToISO(date.getTime());
}

/** Today's local date; pass `now` to make it deterministic in tests. */
export function todayISO(now: Date = new Date()): string {
  return toISODate(now);
}

/** A `Date` at UTC midnight for the given ISO date. */
export function fromISODate(iso: string): Date {
  return new Date(isoToUTC(iso));
}

/**
 * Takes the `YYYY-MM-DD` part of a date or timestamp string. Timestamps keep their own calendar
 * day (no timezone conversion) — use `toISODateUTC(new Date(ts))` when you need that.
 */
export function dateOnly(value: string): string {
  return value.slice(0, 10);
}

/** Add (or subtract) whole days. */
export function addDays(iso: string, n: number): string {
  return utcToISO(isoToUTC(iso) + Math.trunc(n) * DAY_MS);
}

/** Add calendar months, clamping the day to the end of the target month (31 Jan + 1 → 28/29 Feb). */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const mo = Number(iso.slice(5, 7)) - 1;
  const d = Number(iso.slice(8, 10));
  assertISO(iso);
  const target = new Date(Date.UTC(y, mo + Math.trunc(n), 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  return `${ty}-${pad2(tm)}-${pad2(Math.min(d, daysInMonth(ty, tm)))}`;
}

/** Signed whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((isoToUTC(to) - isoToUTC(from)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday (JavaScript convention). */
export function dayOfWeek(iso: string): number {
  return new Date(isoToUTC(iso)).getUTCDay();
}

/** 1 = Monday … 7 = Sunday (ISO-8601 convention). */
export function isoWeekday(iso: string): number {
  return dayOfWeek(iso) || 7;
}

/** Monday of the week containing `iso`. */
export function startOfWeekISO(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso));
}

/** Sunday of the week containing `iso`. */
export function endOfWeekISO(iso: string): string {
  return addDays(startOfWeekISO(iso), 6);
}

export function startOfMonthISO(iso: string): string {
  assertISO(iso);
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonthISO(iso: string): string {
  assertISO(iso);
  const y = Number(iso.slice(0, 4));
  const mo = Number(iso.slice(5, 7));
  return `${iso.slice(0, 7)}-${pad2(daysInMonth(y, mo))}`;
}

/** 1..4 */
export function quarterOf(iso: string): number {
  assertISO(iso);
  return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
}

export function startOfQuarterISO(iso: string): string {
  const q = quarterOf(iso);
  return `${iso.slice(0, 4)}-${pad2((q - 1) * 3 + 1)}-01`;
}

export function endOfQuarterISO(iso: string): string {
  const q = quarterOf(iso);
  return endOfMonthISO(`${iso.slice(0, 4)}-${pad2(q * 3)}-01`);
}

/**
 * The calendar period a dashboard range covers:
 *  - `week`    → Monday–Sunday of the week containing `todayISO`
 *  - `month`   → the calendar month
 *  - `quarter` → the calendar quarter
 * `to` may be in the future (the period has not finished yet); data queries simply find nothing there.
 */
export function rangeFor(range: DashboardRange, todayISO: string): DateRange {
  switch (range) {
    case 'week':
      return { from: startOfWeekISO(todayISO), to: endOfWeekISO(todayISO) };
    case 'month':
      return { from: startOfMonthISO(todayISO), to: endOfMonthISO(todayISO) };
    case 'quarter':
      return { from: startOfQuarterISO(todayISO), to: endOfQuarterISO(todayISO) };
  }
}

function isWholeMonths(r: DateRange): boolean {
  return r.from === startOfMonthISO(r.from) && r.to === endOfMonthISO(r.to) && r.from <= r.to;
}

/**
 * The period immediately before `range`, for "vs previous period" deltas.
 * Whole-month ranges shift by whole months (Oct → Sep, Q4 → Q3) so month lengths don't drift;
 * any other range shifts back by its own length in days (Mon–Sun → the previous Mon–Sun).
 */
export function previousRange(range: DateRange): DateRange {
  if (isWholeMonths(range)) {
    const months =
      (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
      (Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7))) +
      1;
    const from = addMonths(range.from, -months);
    return { from, to: addDays(range.from, -1) };
  }
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/** Every date from `from` to `to` inclusive; empty when `from` is after `to`. */
export function eachDay(from: string, to: string): string[] {
  const start = isoToUTC(from);
  const end = isoToUTC(to);
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(utcToISO(t));
  return out;
}

/** The Monday of every week that overlaps `from`..`to`, in order; empty when `from` is after `to`. */
export function eachWeek(from: string, to: string): string[] {
  if (isoToUTC(from) > isoToUTC(to)) return [];
  const out: string[] = [];
  for (let d = startOfWeekISO(from); d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

/** ISO-8601 week number and week-numbering year (weeks start Monday; week 1 holds 4 January). */
export function isoWeek(iso: string): ISOWeek {
  const d = new Date(isoToUTC(iso));
  const weekday = d.getUTCDay() || 7;
  // Move to the Thursday of this week; its year is the ISO week-numbering year.
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return { year, week };
}

/** "W42" style label for the ISO week containing `iso`. */
export function isoWeekLabel(iso: string): string {
  return `W${isoWeek(iso).week}`;
}

/** `YYYY-MM` for grouping by month. */
export function monthKey(iso: string): string {
  assertISO(iso);
  return iso.slice(0, 7);
}

/** True when `from <= iso <= to`. */
export function isWithin(iso: string, from: string, to: string): boolean {
  return iso >= from && iso <= to;
}

/** Clamp a date into `[min, max]`. */
export function clampISO(iso: string, min: string, max: string): string {
  if (iso < min) return min;
  if (iso > max) return max;
  return iso;
}

/** Earlier of two dates. */
export function minISO(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Later of two dates. */
export function maxISO(a: string, b: string): string {
  return a >= b ? a : b;
}
