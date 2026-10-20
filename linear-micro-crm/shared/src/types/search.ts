/**
 * Release 1.2 — U5 office-tools contracts (laid down by r2-foundation; OWNED BY U5, which may add fields and types):
 * the command palette's search and the payroll export.
 *
 *  - GET /search?q= → SearchResponse (cached per user, 20 s; role-scoped: a rep finds only what they may open)
 *  - GET /finance/payroll/export?weekStart=YYYY-MM-DD&format=xero|sage → text/csv attachment (admin only; cells that
 *    start with = + - @ are neutralised like the existing CSV export)
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
}

export interface SearchResponse {
  q: string;
  results: SearchResult[];
}

export type PayExportFormat = 'xero' | 'sage';

/** One exported line (the CSV columns, in this order). Money is GBP gross. */
export interface PayExportRow {
  employeeName: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  gross: number;
  base: number;
  commission: number;
  bonus: number;
  overrides: number;
  deductions: number;
  reference: string;
}
