/**
 * Release 1.2 — OWNED BY U5 office-tools (laid down by r2-foundation). Pure: payroll runs → export rows → CSV for Xero
 * Payroll or Sage, with formula-injection guarding like the existing CSV export (client/src/lib/csv.ts csvEscape).
 *
 * Both files carry the same eleven columns in the same order (PayExportRow); they differ in the header names each
 * product's import wizard expects. Dates are UK style (DD/MM/YYYY), money a plain number with two decimals (1234.50,
 * no £, no thousands separator), UTF-8 without a byte-order mark (an importer would read it into the first header),
 * CRLF line ends and one line per run. There is never a totals line: an importer would read it as an employee.
 */
import type { PayrollRunWithUser } from '../types.ts';
import type { PayExportFormat, PayExportRow, PayExportScope } from '../types/search.ts';
import { round2 } from './finance.ts';

export const PAY_EXPORT_FORMATS: readonly PayExportFormat[] = ['xero', 'sage'];
export const PAY_EXPORT_SCOPES: readonly PayExportScope[] = ['unpaid', 'all'];

export const PAY_EXPORT_FORMAT_LABELS: Readonly<Record<PayExportFormat, string>> = { xero: 'Xero Payroll', sage: 'Sage Payroll' };

/** The header row of each format, one name per PayExportRow field in PAY_EXPORT_COLUMNS order. */
export const PAY_EXPORT_HEADERS: Readonly<Record<PayExportFormat, readonly string[]>> = {
  xero: ['Employee Name', 'Employee ID', 'Period Start Date', 'Period End Date', 'Gross Pay', 'Base Pay', 'Commission', 'Bonus', 'Overrides', 'Deductions', 'Reference'],
  sage: ['Employee Name', 'Employee Reference', 'Period Start', 'Period End', 'Gross Pay', 'Basic Pay', 'Commission', 'Bonus', 'Overrides', 'Deductions', 'Payment Reference'],
};

/** The CSV column order (the PayExportRow fields). */
export const PAY_EXPORT_COLUMNS: readonly (keyof PayExportRow)[] = [
  'employeeName', 'employeeId', 'periodStart', 'periodEnd', 'gross', 'base', 'commission', 'bonus', 'overrides', 'deductions', 'reference',
];

const MONEY_FIELDS = new Set<keyof PayExportRow>(['gross', 'base', 'commission', 'bonus', 'overrides', 'deductions']);
const DATE_FIELDS = new Set<keyof PayExportRow>(['periodStart', 'periodEnd']);

export function isPayExportFormat(value: unknown): value is PayExportFormat {
  return typeof value === 'string' && (PAY_EXPORT_FORMATS as readonly string[]).includes(value);
}

/** One row per run, in the order given. Money is rounded to pennies; nothing is recalculated (the run is the record). */
export function payExportRows(runs: readonly PayrollRunWithUser[]): PayExportRow[] {
  return runs.map((r) => ({
    employeeName: r.userName,
    employeeId: r.employeeId,
    periodStart: r.weekStart,
    periodEnd: r.weekEnd,
    gross: round2(r.gross),
    base: round2(r.basePay),
    commission: round2(r.commission),
    bonus: round2(r.bonus),
    overrides: round2(r.overrides),
    deductions: round2(r.deductions),
    reference: r.reference,
  }));
}

/** A plain numeric literal (`-12.50`, `3`): never a formula, so it keeps its sign. */
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;
/** First characters a spreadsheet treats as the start of a formula (or that splice a cell): `=`, `+`, `-`, `@`, TAB, CR. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV field: text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe so a
 * spreadsheet never runs it as a formula (the same guard as the app's "Export CSV"); then it is quoted when it holds
 * a comma, a quote, a line break or leading/trailing spaces, with quotes doubled. Plain numbers are left alone.
 */
export function payExportCell(field: string): string {
  const safe = FORMULA_START.test(field) && !NUMERIC_LITERAL.test(field) ? `'${field}` : field;
  return /[",\r\n]/.test(safe) || /^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 2026-10-12 → 12/10/2026 (anything that is not YYYY-MM-DD is passed through). */
export function ukDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** 1234.5 → "1234.50"; a non-finite value → "0.00". */
export function payExportMoney(n: number): string {
  return Number.isFinite(n) ? round2(n).toFixed(2) : '0.00';
}

/** The CSV text for `format`: header row first, CRLF line ends, a final CRLF. */
export function payExportCsv(rows: readonly PayExportRow[], format: PayExportFormat): string {
  const header = PAY_EXPORT_HEADERS[format].map(payExportCell).join(',');
  const lines = rows.map((row) =>
    PAY_EXPORT_COLUMNS.map((key) => {
      const v = row[key];
      if (MONEY_FIELDS.has(key)) return payExportCell(payExportMoney(Number(v)));
      if (DATE_FIELDS.has(key)) return payExportCell(ukDate(String(v)));
      return payExportCell(String(v ?? ''));
    }).join(','),
  );
  return `${[header, ...lines].join('\r\n')}\r\n`;
}

/** linear-hub-payroll-xero-2026-10-12.csv */
export function payExportFilename(weekStart: string, format: PayExportFormat): string {
  return `linear-hub-payroll-${format}-${weekStart}.csv`;
}
