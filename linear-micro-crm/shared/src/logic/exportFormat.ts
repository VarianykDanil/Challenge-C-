/**
 * Release 1.3 — OWNED BY P4 pdf-everywhere (laid down by r3-foundation). Pure helpers shared by the CSV and PDF exports
 * (unit-tested here; the PDF drawing itself is client/src/lib/pdf). P4 fills and extends.
 */

/** Tables wider than this many columns are laid out on A4 landscape. */
export const PDF_PORTRAIT_MAX_COLUMNS = 6;

export type PdfOrientation = 'portrait' | 'landscape';

/** A4 portrait up to PDF_PORTRAIT_MAX_COLUMNS columns, landscape above. */
export function pdfOrientationFor(columnCount: number): PdfOrientation {
  return columnCount > PDF_PORTRAIT_MAX_COLUMNS ? 'landscape' : 'portrait';
}
