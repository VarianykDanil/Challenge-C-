/**
 * ISO date helpers. All functions work on `YYYY-MM-DD` strings and do their arithmetic in UTC so
 * that DST changes never shift a calendar day. "Today" uses the server's local calendar date.
 */
const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const d = parseDate(value);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Local calendar date of a Date instance. */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The business clock: what "today" and "now" mean for events, gauges, pay weeks and the demo seed. It is real time
 * unless pinned, by a test (`setBusinessClock`) or by `LM_BUSINESS_NOW` for screenshots and demos at night; a pinned
 * clock keeps ticking from the pinned instant. Security clocks (sessions, rate limits, two-step codes) never use it.
 */
let businessOffsetMs = 0;

export function businessNow(): Date {
  return new Date(Date.now() + businessOffsetMs);
}

/** Pin the business clock to `at` (it keeps ticking from there); `null` returns it to real time. */
export function setBusinessClock(at: Date | null): void {
  businessOffsetMs = at ? at.getTime() - Date.now() : 0;
}

export function businessClockPinned(): boolean {
  return businessOffsetMs !== 0;
}

if (process.env.LM_BUSINESS_NOW) {
  const at = new Date(process.env.LM_BUSINESS_NOW);
  if (Number.isNaN(at.getTime())) throw new Error(`LM_BUSINESS_NOW is not a date: ${process.env.LM_BUSINESS_NOW}`);
  setBusinessClock(at);
}

export function todayISO(): string {
  return toISODate(businessNow());
}

export function nowISO(): string {
  return businessNow().toISOString();
}

/** Local wall-clock `HH:MM` (the business zone when TZ is pinned). */
export function nowHHMM(d = businessNow()): string {
  return toLocalISO(d).slice(11, 16);
}

/** Parse `YYYY-MM-DD` as UTC midnight. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is after a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(s: string): number {
  return parseDate(s).getUTCDay();
}

export function mondayOf(s: string): string {
  const dow = dayOfWeek(s);
  return addDays(s, dow === 0 ? -6 : 1 - dow);
}

export function sundayOf(s: string): string {
  return addDays(mondayOf(s), 6);
}

export function startOfMonth(s: string): string {
  return `${s.slice(0, 8)}01`;
}

export function startOfQuarter(s: string): string {
  const month = Number(s.slice(5, 7));
  const qm = Math.floor((month - 1) / 3) * 3 + 1;
  return `${s.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`;
}

export function isoWeek(s: string): { year: number; week: number } {
  const d = parseDate(s);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** Every date from `from` to `to` inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday of every week that overlaps [from, to]. */
export function eachMonday(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = mondayOf(from); d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 15 Oct" */
export function formatShort(s: string): string {
  const d = parseDate(s);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** "w/c 12 Oct" */
export function formatWeek(monday: string): string {
  const d = parseDate(monday);
  return `w/c ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export type Period = 'week' | 'month' | 'quarter';

/** Current week / month / quarter up to today (inclusive). */
export function rangeForPeriod(period: Period, today = todayISO()): { from: string; to: string } {
  if (period === 'month') return { from: startOfMonth(today), to: today };
  if (period === 'quarter') return { from: startOfQuarter(today), to: today };
  return { from: mondayOf(today), to: today };
}

/**
 * The comparison window for a to-date range: the same to-date span of the *previous* period, not the preceding N
 * calendar days. Week Mon 12 – Thu 15 Oct → Mon 5 – Thu 8 Oct; month 1–15 Oct → 1–15 Sep; quarter 1–15 Oct → 1–15 Jul.
 * The end is clamped to the previous period's last day for shorter months (1–31 Mar → 1–28 Feb).
 */
export function previousToDateRange(period: Period, r: { from: string; to: string }): { from: string; to: string } {
  if (period === 'week') return { from: addDays(r.from, -7), to: addDays(r.to, -7) };
  const prevEnd = addDays(r.from, -1); // last day of the previous month / quarter
  const prevStart = period === 'month' ? startOfMonth(prevEnd) : startOfQuarter(prevEnd);
  const to = addDays(prevStart, diffDays(r.from, r.to)); // same day-offset into the previous period
  return { from: prevStart, to: to < prevEnd ? to : prevEnd };
}

/** Clamp a time (ms since epoch) into an ISO date string in local calendar terms. */
export function dateOfTimestamp(ts: string): string {
  return toISODate(new Date(ts));
}

/** Naive local timestamp `YYYY-MM-DDTHH:MM:SS` (no zone suffix) from a Date's local components. */
export function toLocalISO(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${toISODate(d)}T${hh}:${mm}:${ss}`;
}

const NAIVE_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** The business runs in one zone; event start times and check-ins are wall-clock times in it. */
export const BUSINESS_TZ = 'Europe/London';

const BUSINESS_TZ_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Naive `YYYY-MM-DDTHH:MM:SS` wall-clock time in Europe/London for an instant, whatever the process zone is. */
export function toBusinessISO(d: Date): string {
  const parts: Record<string, string> = {};
  for (const p of BUSINESS_TZ_FORMAT.formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * Check-in timestamps are stored as naive wall-clock time (`2026-10-15T10:03:00`) so that
 * `isCheckInOnTime` compares like with like against the event's start time. A naive value is kept verbatim
 * (seconds padded); a zoned value from a client (`…Z` / `±hh:mm`) is converted to Europe/London wall-clock time,
 * not to the server's process zone, so a container running in UTC never shifts BST check-ins by an hour.
 */
export function normaliseCheckIn(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const m = NAIVE_TS_RE.exec(value);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return toBusinessISO(d);
}
