/**
 * Release 1.3 — OWNED BY P3 statements (laid down by r3-foundation). Pure statement-parsing rules: find the table's
 * columns from its header keywords (name / fundraiser / ID / sign-ups / subs / successful / cancelled / paid / amount /
 * period / date), turn rows into per-fundraiser confirmations, and match names. P3 fills the stubs; the PDF text
 * extraction (pdfjs-dist) and the mail source (imapflow, mailparser) stay on the server.
 */
import type { StatementColumnMapping } from '../types/statements.ts';

/** Header words P3's detector looks for (lower case). */
export const STATEMENT_HEADER_KEYWORDS = ['name', 'fundraiser', 'id', 'sign-ups', 'signups', 'subs', 'successful', 'cancelled', 'paid', 'amount', 'period', 'date'] as const;

/** STUB (P3): which column holds what, from the header cells. */
export function detectStatementColumns(headers: readonly string[]): StatementColumnMapping {
  void headers;
  return {};
}

/** A name compared for matching: lower case, single spaces, no punctuation ("O'Brien,  Sam" → "obrien sam"). */
export function normalisePersonName(name: string): string {
  return name.toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
