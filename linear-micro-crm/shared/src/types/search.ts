/**
 * Release 1.2 — U5 office-tools contracts (laid down by r2-foundation; OWNED BY U5, which may add fields and types):
 * the command palette's search and the payroll export.
 *
 *  - GET /search?q= → SearchResponse (cached per user, 20 s; role-scoped: a rep finds only what they may open)
 *  - GET /finance/payroll/export?weekStart=YYYY-MM-DD&format=xero|sage[&runs=unpaid|all] → text/csv attachment (admin
 *    only; cells that start with = + - @ are neutralised like the existing CSV export; X-Total-Count = rows)
 */

export type SearchResultKind = 'person' | 'event' | 'candidate' | 'campaign';

export interface SearchResult {
  kind: SearchResultKind;
  id: number;
  title: string;
  subtitle: string | null;
  /** In-app link, e.g. /team/12, /events/40, /recruitment/7, /campaigns. */
  href: string;
  /** Avatar / campaign colour when there is one. */
  color?: string | null;
  /**
   * U5: how well the title answers the query — 0 it starts with the whole query (a campaign also when its code does),
   * 1 a word of it does, 2 it only contains the words somewhere. Results of one kind come sorted by it.
   */
  rank?: 0 | 1 | 2;
}

export interface SearchResponse {
  q: string;
  results: SearchResult[];
}

/** `format=` of GET /finance/payroll/export: 'csv'; 'xero' and 'sage' from older links give the same file. */
export type PayExportFormat = 'csv' | 'xero' | 'sage';

/**
 * Which runs of the week GET /finance/payroll/export includes (`runs=` query): 'unpaid' (default) — pending runs and
 * failed transfers, what is still to pay — or 'all', every run of the week whatever its status.
 */
export type PayExportScope = 'unpaid' | 'all';

/** Whose runs (`people=`): everyone (default), the self-employed self-billed field people, or the office staff. */
export type PayExportPeople = 'all' | 'self_billed' | 'office';

/** One exported line (the CSV columns, in this order). Money is GBP. */
export interface PayExportRow {
  employeeName: string;
  employeeId: string;
  /** "Self-employed (self-billed)" or "Office staff". */
  worker: string;
  periodStart: string;
  periodEnd: string;
  base: number;
  commission: number;
  bonus: number;
  overrides: number;
  deductions: number;
  /** Corrections from earlier weeks included in the gross. */
  adjustments: number;
  gross: number;
  /** VAT on the self-billed invoice (0 when none is charged). */
  vat: number;
  /** gross + VAT: what the person is paid. */
  totalToPay: number;
  invoiceNumber: string;
  reference: string;
}
