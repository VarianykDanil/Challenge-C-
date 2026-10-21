// Owned by the Frontend Developer. Number, money and date formatting helpers (British English, GBP).
import { BRAND } from '@lm/shared';
import {
  differenceInCalendarDays,
  format,
  formatDistanceStrict,
  isToday,
  isTomorrow,
  isValid,
  isYesterday,
  parseISO,
  startOfDay,
} from 'date-fns';

const gbp = new Intl.NumberFormat(BRAND.locale, { style: 'currency', currency: BRAND.currency, maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat(BRAND.locale, { style: 'currency', currency: BRAND.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat(BRAND.locale);
const num1 = new Intl.NumberFormat(BRAND.locale, { maximumFractionDigits: 1 });

export function formatGBP(n: number, opts: { cents?: boolean } = {}): string {
  const v = Number.isFinite(n) ? n : 0;
  // `-0` (e.g. a negated zero deduction) would otherwise print as "-£0.00".
  return (opts.cents ? gbp2 : gbp).format(v === 0 ? 0 : v);
}
export function formatNumber(n: number): string {
  return Number.isFinite(n) ? num.format(n) : '—';
}
/** One decimal place, e.g. average sales per day. */
export function formatDecimal(n: number): string {
  return Number.isFinite(n) ? num1.format(n) : '—';
}
export function formatPct(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Parse `YYYY-MM-DD` or a full ISO timestamp into a Date (local time). */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = parseISO(value);
  return isValid(d) ? d : null;
}

/** e.g. "Mon 14 Oct 2026" */
export function formatDate(value: string | Date | null | undefined): string {
  const d = typeof value === 'string' ? parseDate(value) : value ?? null;
  return d ? format(d, 'EEE d MMM yyyy') : '—';
}
/** e.g. "14 Oct" */
export function formatDateShort(value: string | Date | null | undefined): string {
  const d = typeof value === 'string' ? parseDate(value) : value ?? null;
  return d ? format(d, 'd MMM') : '—';
}
/** e.g. "Monday 14 October" — used for day group headings. */
export function formatDayHeading(value: string | Date | null | undefined): string {
  const d = typeof value === 'string' ? parseDate(value) : value ?? null;
  if (!d) return '—';
  if (isToday(d)) return `Today · ${format(d, 'EEEE d MMMM')}`;
  if (isTomorrow(d)) return `Tomorrow · ${format(d, 'EEEE d MMMM')}`;
  if (isYesterday(d)) return `Yesterday · ${format(d, 'EEEE d MMMM')}`;
  return format(d, 'EEEE d MMMM');
}
/** Accepts "HH:MM" or an ISO timestamp; returns "HH:mm". */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  const d = parseDate(value);
  return d ? format(d, 'HH:mm') : '—';
}
/** e.g. "14 Oct, 09:30" */
export function formatDateTime(value: string | null | undefined): string {
  const d = parseDate(value);
  return d ? format(d, 'd MMM yyyy, HH:mm') : '—';
}
/**
 * e.g. "3 days ago", "in 2 hours", "today". A date-only value ("2026-10-23") is a day, not a moment: it counts calendar
 * days from today ("in 4 days" on Monday afternoon for Friday, never 3, which measuring from now to Friday's midnight
 * and rounding down gave), with months and years from today's midnight beyond 30 days. Timestamps keep the distance
 * from now ("in 2 hours").
 */
export function formatRelative(value: string | null | undefined, now: Date = new Date(), opts: { past?: boolean } = {}): string {
  const d = parseDate(value);
  if (!d) return '—';
  // `past`: the moment has happened (sent, saved, signed off). A phone whose clock runs a few minutes behind the
  // server would otherwise say "in 9 minutes"; up to 15 minutes ahead reads "just now".
  if (opts.past && d.getTime() > now.getTime() && d.getTime() - now.getTime() <= 15 * 60_000) return 'just now';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    const days = differenceInCalendarDays(d, now);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (Math.abs(days) < 30) return days > 0 ? `in ${days} days` : `${-days} days ago`;
    return formatDistanceStrict(d, startOfDay(now), { addSuffix: true });
  }
  return formatDistanceStrict(d, now, { addSuffix: true });
}
/** "+12%" / "−8%" for fractional deltas; "—" when null. */
export function formatDelta(fraction: number | null | undefined, digits = 0): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  const sign = fraction > 0 ? '+' : fraction < 0 ? '−' : '';
  return `${sign}${Math.abs(fraction * 100).toFixed(digits)}%`;
}
/** "x stops per sale" helper that handles Infinity. */
export function formatStopsPerSale(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? formatDecimal(n) : '—';
}
/** "Mon 14 – Sun 20 Oct" */
export function formatRangeLabel(from: string, to: string): string {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return `${from} – ${to}`;
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  return sameMonth ? `${format(a, 'd')} – ${format(b, 'd MMM yyyy')}` : `${format(a, 'd MMM')} – ${format(b, 'd MMM yyyy')}`;
}
export function fullName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`.trim();
}
/** Plural helper: pluralise(3, 'rep') → "3 reps" */
export function pluralise(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : plural}`;
}
