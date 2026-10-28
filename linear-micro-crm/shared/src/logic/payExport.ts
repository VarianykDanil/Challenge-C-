/**
 * Pure: payroll runs → export rows → the payroll spreadsheet (CSV), with formula-injection guarding like the app's CSV
 * export (client/src/lib/csv.ts csvEscape).
 *
 * One honest file (MON-4, CLM-10): a spreadsheet for the accountant or for payroll software to map, not a file in Xero's
 * or Sage's own import layout (neither was checked against their importers, and Xero Payroll UK has no CSV import of
 * pay runs). `format=xero` / `sage` from older links give the same file. Every row adds up: base + commission + bonus +
 * overrides − deductions + adjustments (corrections from earlier weeks) = gross pay; gross pay + VAT (from the
 * self-billed invoice, MON-7) = total to pay. "Worker" tells the self-employed, self-billed field people from the office
 * staff, so they can be handled apart (or exported apart with `people=`).
 *
 * Dates are UK style (DD/MM/YYYY), money a plain number with two decimals (1234.50, no £, no thousands separator),
 * UTF-8 without a byte-order mark, CRLF line ends and one line per run. There is never a totals line: software would
 * read it as a person.
 */
import type { PayrollRunWithUser, Role } from '../types.ts';
import type { PayExportFormat, PayExportPeople, PayExportRow, PayExportScope } from '../types/search.ts';
import { round2 } from './finance.ts';
import { isInvoicedRole } from './invoices.ts';
import { amountToPayPence } from './moneyChecks.ts';
import { penceToPounds } from './payments.ts';

/** Accepted values of `format=`: 'csv', and 'xero' / 'sage' from older links (the same file). */
export const PAY_EXPORT_FORMATS: readonly PayExportFormat[] = ['csv', 'xero', 'sage'];
export const PAY_EXPORT_SCOPES: readonly PayExportScope[] = ['unpaid', 'all'];
export const PAY_EXPORT_PEOPLE: readonly PayExportPeople[] = ['all', 'self_billed', 'office'];

/** What the file is, in the app and in the audit trail. */
export const PAY_EXPORT_LABEL = 'Payroll spreadsheet (CSV) for your accountant or payroll software';
export const PAY_EXPORT_FORMAT_LABELS: Readonly<Record<PayExportFormat, string>> = { csv: PAY_EXPORT_LABEL, xero: PAY_EXPORT_LABEL, sage: PAY_EXPORT_LABEL };
export const PAY_EXPORT_PEOPLE_LABELS: Readonly<Record<PayExportPeople, string>> = {
  all: 'Everyone',
  self_billed: 'Self-employed (self-billed) only',
  office: 'Office staff only',
};

/** The "Worker" column. */
export const PAY_EXPORT_WORKER = { selfBilled: 'Self-employed (self-billed)', office: 'Office staff' } as const;

/** The header row, one name per PayExportRow field in PAY_EXPORT_COLUMNS order. */
export const PAY_EXPORT_HEADER: readonly string[] = [
  'Name', 'Employee ID', 'Worker', 'Period start', 'Period end', 'Base pay', 'Commission', 'Bonus', 'Overrides', 'Deductions',
  'Adjustments', 'Gross pay', 'VAT', 'Total to pay', 'Invoice number', 'Payment reference',
];

/** The CSV column order (the PayExportRow fields). */
export const PAY_EXPORT_COLUMNS: readonly (keyof PayExportRow)[] = [
  'employeeName', 'employeeId', 'worker', 'periodStart', 'periodEnd', 'base', 'commission', 'bonus', 'overrides', 'deductions',
  'adjustments', 'gross', 'vat', 'totalToPay', 'invoiceNumber', 'reference',
];

const MONEY_FIELDS = new Set<keyof PayExportRow>(['base', 'commission', 'bonus', 'overrides', 'deductions', 'adjustments', 'gross', 'vat', 'totalToPay']);
const DATE_FIELDS = new Set<keyof PayExportRow>(['periodStart', 'periodEnd']);

export function isPayExportFormat(value: unknown): value is PayExportFormat {
  return typeof value === 'string' && (PAY_EXPORT_FORMATS as readonly string[]).includes(value);
}

export function isPayExportPeople(value: unknown): value is PayExportPeople {
  return typeof value === 'string' && (PAY_EXPORT_PEOPLE as readonly string[]).includes(value);
}

/** A run to export: the payroll row and the person's role (who is self-billed). */
export type PayExportRun = PayrollRunWithUser & { role: Role };

/** Whether the person is in `people`. */
export function inPayExportPeople(role: Role, people: PayExportPeople): boolean {
  if (people === 'all') return true;
  return people === 'self_billed' ? isInvoicedRole(role) : !isInvoicedRole(role);
}

/** One row per run, in the order given. Money is rounded to pennies; nothing is recalculated (the run is the record). */
export function payExportRows(runs: readonly PayExportRun[]): PayExportRow[] {
  return runs.map((r) => {
    const vat = round2(r.invoice?.vatAmount ?? 0);
    return {
      employeeName: r.userName,
      employeeId: r.employeeId,
      worker: isInvoicedRole(r.role) ? PAY_EXPORT_WORKER.selfBilled : PAY_EXPORT_WORKER.office,
      periodStart: r.weekStart,
      periodEnd: r.weekEnd,
      base: round2(r.basePay),
      commission: round2(r.commission),
      bonus: round2(r.bonus),
      overrides: round2(r.overrides),
      deductions: round2(r.deductions),
      adjustments: round2(r.adjustmentsTotal ?? 0),
      gross: round2(r.gross),
      vat,
      totalToPay: penceToPounds(amountToPayPence(round2(r.gross), r.invoice)),
      invoiceNumber: r.invoice?.number ?? '',
      reference: r.reference,
    };
  });
}

/** The row's columns add up: the parts to the gross pay (within half a penny), and gross + VAT to the total to pay. */
export function payExportRowAddsUp(row: PayExportRow): boolean {
  const parts = row.base + row.commission + row.bonus + row.overrides - row.deductions + row.adjustments;
  return Math.abs(parts - row.gross) < 0.005 && Math.abs(row.gross + row.vat - row.totalToPay) < 0.005;
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

/** The CSV text: header row first, CRLF line ends, a final CRLF. */
export function payExportCsv(rows: readonly PayExportRow[]): string {
  const header = PAY_EXPORT_HEADER.map(payExportCell).join(',');
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

/** linear-hub-payroll-2026-10-12.csv, …-self-billed.csv, …-office.csv */
export function payExportFilename(weekStart: string, people: PayExportPeople = 'all'): string {
  return `linear-hub-payroll-${weekStart}${people === 'all' ? '' : `-${people.replace('_', '-')}`}.csv`;
}
