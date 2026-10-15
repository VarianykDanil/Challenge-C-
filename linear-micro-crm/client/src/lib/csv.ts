// Owned by the Frontend Developer. RFC 4180 CSV export helpers behind every "Export CSV" button.
//
// Conventions (so every file opens the same way in Excel):
//  - UTF-8 with a BOM, CRLF line ends, fields quoted only when they need it.
//  - Dates as `YYYY-MM-DD`, timestamps as `YYYY-MM-DD HH:mm` (local time).
//  - Money as a plain number with two decimals (`1234.50`), ratios as percent strings (`12.3%`).
//  - Booleans as Yes / No, unknown as `—`.
import { format, isValid, parseISO } from 'date-fns';
import { BRAND } from '@lm/shared';

export interface CsvColumn<T = Record<string, unknown>> {
  /** Property read from the row (`row[key]`). Purely derived columns may use any unique key and ignore the value. */
  key: string;
  header: string;
  /** Turn the raw value (and/or the row) into the exact cell text. Defaults to `csvCell`. */
  format?: (value: unknown, row: T) => string;
}

const BOM = '﻿';
const EOL = '\r\n';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Quote a field when it holds a comma, quote, CR/LF or leading/trailing whitespace; double any quotes.
 * Text starting with `=` or `@` is prefixed with an apostrophe so a spreadsheet never runs it as a formula
 * (`+`/`-` are left alone: phone numbers and negative amounts start with them).
 */
export function csvEscape(field: string): string {
  const safe = /^[=@]/.test(field) ? `'${field}` : field;
  return /[",\r\n]/.test(safe) || /^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Default cell text: '' for null/undefined/non-finite numbers, Yes/No for booleans, ISO date for Date objects. */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return isValid(value) ? format(value, 'yyyy-MM-dd') : '';
  return JSON.stringify(value);
}

/** Build the whole file (BOM + header row + one line per row). */
export function toCsv<T extends object>(rows: T[], columns: CsvColumn<T>[]): string {
  const read = (row: T, key: string): unknown => (row as Record<string, unknown>)[key];
  const header = columns.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(c.format ? c.format(read(row, c.key), row) : csvCell(read(row, c.key)))).join(','));
  return `${BOM}${[header, ...lines].join(EOL)}${EOL}`;
}

/** Trigger a browser download of `csv` as `filename` (Blob → object URL → anchor click, URL revoked after). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a later tick: Safari aborts a download whose URL disappears synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ───────────────────────────── Cell formatters ─────────────────────────────

/** `YYYY-MM-DD` from a date string, ISO timestamp (local calendar date) or Date; '' when empty/invalid. */
export function csvDate(value: unknown): string {
  if (value instanceof Date) return isValid(value) ? format(value, 'yyyy-MM-dd') : '';
  if (typeof value !== 'string' || !value) return '';
  if (ISO_DATE.test(value)) return value;
  const d = parseISO(value);
  return isValid(d) ? format(d, 'yyyy-MM-dd') : '';
}

/** `YYYY-MM-DD HH:mm` (local time) from an ISO timestamp; '' when empty/invalid. */
export function csvDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const d = parseISO(value);
  return isValid(d) ? format(d, 'yyyy-MM-dd HH:mm') : '';
}

/** Money as a plain number with two decimals and no symbol or thousands separators, e.g. `1234.50`. */
export function csvMoney(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const s = value.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/** A 0..1 ratio as a percent string with `digits` decimals, e.g. `12.3%`; '' when not finite. */
export function csvPct(digits = 1): (value: unknown) => string {
  return (value) => (typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '');
}

/** A number with a fixed number of decimals; '' when not finite (e.g. stops-per-sale with no sales). */
export function csvDecimal(digits = 1): (value: unknown) => string {
  return (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '');
}

/** Yes / No / — for a boolean that may be unknown (null). */
export function csvYesNo(value: unknown): string {
  return value === true ? 'Yes' : value === false ? 'No' : '—';
}

/** Look a code up in a label map (`POSITION_LABELS` etc.), falling back to the raw code. */
export function csvLabel<K extends string>(labels: Record<K, string>): (value: unknown) => string {
  return (value) => (typeof value === 'string' ? labels[value as K] ?? value : '');
}

// ───────────────────────────── File names & ordering ─────────────────────────────

const slugify = (s: string): string =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const PREFIX = slugify(BRAND.product); // "linear-hub"

/**
 * `linear-hub-<section>-<from>_<to>.csv` for a date range, `linear-hub-<section>-<date>.csv` for a single
 * day (or today, when no range applies). `section` is slugified, so names and labels are safe to pass in.
 */
export function csvFilename(section: string, range?: { from: string; to: string } | string): string {
  const stamp = !range ? format(new Date(), 'yyyy-MM-dd') : typeof range === 'string' ? range : range.from === range.to ? range.from : `${range.from}_${range.to}`;
  return `${PREFIX}-${slugify(section)}-${stamp}.csv`;
}

/** Copy of `rows` in a DataTable's default order (stable; nulls last) so the file reads like the screen. */
export function sortRows<T>(rows: T[], value: (row: T) => string | number | null | undefined, dir: 'asc' | 'desc' = 'asc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const compare = (a: string | number | null | undefined, b: string | number | null | undefined): number => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  };
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => compare(a.v, b.v) * sign || a.i - b.i)
    .map((x) => x.row);
}
