// Release 1.3 — the PDF API's types — OWNED BY P4 pdf-everywhere (laid down by r3-foundation; STABLE: P2's invoice,
// P7's candidate profile and interview sheet, P8's venue report and P9's audit view build on them).
import type { PdfOrientation } from '@lm/shared';
import type { CsvColumn } from '@/lib/csv';

export type { PdfOrientation } from '@lm/shared';

/** exportTablePdf: a table PDF with the brand header, the filters, the generated time and "Page x of y". */
export interface TablePdfOptions<T extends object> {
  /** e.g. "Gauges by team". */
  title: string;
  subtitle?: string;
  /** Lines under the title: the filters on screen, e.g. ["Team: Deansgate", "1 Oct – 21 Oct 2026"]. */
  filters?: string[];
  /** The same columns as the CSV export (key, header, format), so a PDF shows exactly what the CSV holds. */
  columns: CsvColumn<T>[];
  /** Exactly the rows on screen, in order. */
  rows: T[];
  /** A totals row printed last, keyed by column key (already formatted). */
  totals?: Partial<Record<string, string>>;
  /** Ends with ".pdf". */
  filename: string;
  /** 'auto' (default): portrait up to six columns, landscape above (shared pdfOrientationFor). */
  orientation?: PdfOrientation | 'auto';
}

/** An address block: the supplier (the person) or the customer (Linear MCR Limited) on an invoice. */
export interface PdfAddress {
  /** Small caps heading above it, e.g. "Supplier", "Customer". */
  heading: string;
  name: string;
  lines: string[];
  /** Extra lines in a lighter colour (UTR, VAT, company number). */
  extra?: string[];
}

export interface PdfLineColumn {
  key: string;
  header: string;
  align?: 'left' | 'right';
  /** Relative width (default 1). */
  width?: number;
}

/** One cell value per column key; `muted` rows are drawn in the lighter colour (e.g. "not paid" lines). */
export type PdfLineRow = Record<string, string> & { muted?: boolean };

export interface PdfSignature {
  /** e.g. "For Linear MCR Limited", "Accepted by the supplier". */
  label: string;
  name: string;
  /** data:image/png;base64,… */
  imageDataUrl?: string | null;
  /** e.g. "Accepted electronically by Jordan Lee on Thu 22 Oct 2026, 14:05". */
  note?: string;
}

/** pdfDocument(): building blocks for page PDFs (P2's invoice; P7, P8, P9 pages). Calls chain; nothing is drawn twice. */
export interface PdfDoc {
  header(opts: { title: string; subtitle?: string; meta?: [label: string, value: string][] }): PdfDoc;
  addressBlocks(left: PdfAddress, right: PdfAddress): PdfDoc;
  heading(text: string): PdfDoc;
  paragraph(text: string, opts?: { muted?: boolean; size?: number }): PdfDoc;
  keyValues(rows: [label: string, value: string][]): PdfDoc;
  lineTable(columns: PdfLineColumn[], rows: PdfLineRow[]): PdfDoc;
  table<T extends object>(columns: CsvColumn<T>[], rows: T[]): PdfDoc;
  totals(rows: { label: string; value: string; strong?: boolean }[]): PdfDoc;
  signatureBlock(left: PdfSignature, right?: PdfSignature): PdfDoc;
  /** Printed at the bottom of every page with "Page x of y". */
  footer(text: string): PdfDoc;
  /** Downloads the file. */
  save(filename: string): void;
  blob(): Blob;
}

export interface PdfDocumentOptions {
  orientation?: PdfOrientation;
  /** The PDF's document title (metadata). */
  title?: string;
}
