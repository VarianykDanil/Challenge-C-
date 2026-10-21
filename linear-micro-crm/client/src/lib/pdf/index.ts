// Release 1.3 — PDF exports — OWNED BY P4 pdf-everywhere (laid down by r3-foundation as a stub; the API is STABLE).
//
//  - exportTablePdf(options): a table PDF (brand header, title, filters, generated time, page x of y, repeated header
//    rows, an optional totals row, A4 portrait or landscape by width; money and dates as on screen; text that cannot
//    run as a formula). Used by ExportButton's "PDF" item and by P8's venue report.
//  - pdfDocument(options): building blocks for page PDFs — P2's invoice (header, two address blocks, line table,
//    totals, signature block, footer), P7's candidate profile and interview sheet, P9's audit view.
//  - PDF_EXPORTS_READY: false until P4 lands. A page adds a PDF button where an empty slot would leave a gap (a
//    PageHeader's actions) only when it is true; ExportButton offers "PDF" only when it is true.
// jsPDF and jspdf-autotable (P4 adds them to the client, exact versions) load in their own lazy chunk on the first
// export, so the main chunk does not grow. Each export reports itself to the audit trail (api/auditEvents.ts).
import type { PdfDoc, PdfDocumentOptions, TablePdfOptions } from './types';

export type { PdfAddress, PdfDoc, PdfDocumentOptions, PdfLineColumn, PdfLineRow, PdfOrientation, PdfSignature, TablePdfOptions } from './types';

export const PDF_EXPORTS_READY = false;

/** Thrown by the stubs (and by P4 when the PDF chunk cannot load, e.g. offline). */
export class PdfUnavailableError extends Error {
  constructor(message = 'PDF export is not available yet') {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

/** STUB (P4): download a table as a PDF. */
export async function exportTablePdf<T extends object>(options: TablePdfOptions<T>): Promise<void> {
  void options;
  throw new PdfUnavailableError();
}

/** STUB (P4): start a page PDF. */
export async function pdfDocument(options: PdfDocumentOptions = {}): Promise<PdfDoc> {
  void options;
  throw new PdfUnavailableError();
}
