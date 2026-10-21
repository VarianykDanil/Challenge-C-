/**
 * Release 1.3 — OWNED BY P2 invoices (laid down by r3-foundation). Pure rules for self-billing invoices: the number
 * format and the "deemed accepted" moment (12:00 the day before payday). Both are STABLE (P1's pay views and P9's
 * audit summaries may show them); P2 adds the rest (statuses, line building from P1's breakdown).
 */
import { INVOICE_NUMBER_PREFIX } from '../types/invoices.ts';
import { addDays, isValidISODate } from './dates.ts';

/** "LM-SB-2026-000123". */
export function formatInvoiceNumber(year: number, seq: number): string {
  return `${INVOICE_NUMBER_PREFIX}-${year}-${String(Math.max(0, Math.floor(seq))).padStart(6, '0')}`;
}

/**
 * The moment an invoice not disputed by then counts as accepted: 12:00 (business time, Europe/London wall clock, no
 * zone) on the day before payday — "YYYY-MM-DDT12:00:00". Null for an invalid date.
 */
export function deemedAcceptedAt(payday: string): string | null {
  if (!isValidISODate(payday)) return null;
  return `${addDays(payday, -1)}T12:00:00`;
}
