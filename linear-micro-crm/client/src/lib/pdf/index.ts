// Release 1.3 — PDF exports — OWNED BY P4 pdf-everywhere (laid down by r3-foundation; the API is STABLE).
//
//  - exportTablePdf(options): a table PDF (brand header, title, filters, generated time, page x of y, repeated header
//    rows, an optional totals row, A4 portrait or landscape by width; money and dates as on screen; text that cannot
//    run as a formula). Used by ExportButton's "PDF" item and by P8's venue report.
//  - pdfDocument(options): building blocks for page PDFs — P2's invoice (header, two address blocks, line table,
//    totals, signature block, footer), P7's candidate profile and interview sheet, P9's audit view.
//  - PDF_EXPORTS_READY: true from 1.3. Pages add a PDF button in a PageHeader's actions only when it is true;
//    ExportButton offers "PDF" only when it is true.
// This file is tiny and safe in any chunk: jsPDF and jspdf-autotable (exact versions in client/package.json) load in
// their own lazy chunk (engine.ts) on the first export. Callers report each export to the audit trail
// (api/auditEvents.ts); ExportButton, AuditPdfButton and ProgressPdfButton already do.
import type { PdfDoc, PdfDocumentOptions, TablePdfOptions } from './types';

export type { PdfAddress, PdfDoc, PdfDocumentOptions, PdfLineColumn, PdfLineRow, PdfOrientation, PdfSignature, TablePdfOptions } from './types';

export const PDF_EXPORTS_READY = true;

/** Thrown by the stubs (and by P4 when the PDF chunk cannot load, e.g. offline). */
export class PdfUnavailableError extends Error {
  constructor(message = 'PDF export is not available yet') {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

type Engine = typeof import('./engine');
let loading: Promise<Engine> | null = null;

/** The engine chunk, loaded once; a failed load (offline, a new deploy) is retried on the next export. */
function loadEngine(): Promise<Engine> {
  loading ??= import('./engine').catch((e: unknown) => {
    loading = null;
    throw new PdfUnavailableError(
      typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'You are offline. Connect and try the PDF again — the CSV works offline.'
        : `Could not load the PDF maker${e instanceof Error && e.message ? ` (${e.message})` : ''}. Reload the page and try again.`,
    );
  });
  return loading;
}

/** Start loading the PDF chunk early (e.g. when the Export menu opens), so the PDF item answers at once. */
export function preloadPdf(): void {
  void loadEngine().catch(() => undefined);
}

/** Download a table as a PDF (the file name ends in ".pdf"). */
export async function exportTablePdf<T extends object>(options: TablePdfOptions<T>): Promise<void> {
  const engine = await loadEngine();
  engine.tablePdf(options).save(options.filename);
}

/** Start a page PDF; chain the blocks, then `save(filename)` or `blob()`. */
export async function pdfDocument(options: PdfDocumentOptions = {}): Promise<PdfDoc> {
  const engine = await loadEngine();
  return engine.documentPdf(options);
}
