/**
 * Release 1.2 — OWNED BY U5 office-tools (laid down by r2-foundation; the bodies are stubs). Pure: payroll runs →
 * export rows → CSV for Xero Payroll or Sage, with formula-injection guarding like the existing CSV export.
 */
import type { PayrollRunWithUser } from '../types.ts';
import type { PayExportFormat, PayExportRow } from '../types/search.ts';

/** STUB (U5): one row per run, in the order given. */
export function payExportRows(runs: readonly PayrollRunWithUser[]): PayExportRow[] {
  void runs;
  return [];
}

/** STUB (U5): the CSV text for `format` (header row first, CRLF line ends). */
export function payExportCsv(rows: readonly PayExportRow[], format: PayExportFormat): string {
  void rows;
  void format;
  return '';
}
