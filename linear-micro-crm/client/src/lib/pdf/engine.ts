// Release 1.3 — the PDF engine chunk — OWNED BY P4 pdf-everywhere.
// Loaded on demand by lib/pdf/index.ts (dynamic import), so jsPDF and jspdf-autotable (about 400 kB) never sit in the
// main chunk: the first export downloads them once, every later export reuses them.
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import type { PdfDoc, PdfDocumentOptions, TablePdfOptions } from './types';
import { buildTablePdf, createPdfDoc, type PdfEngine } from './render';

const engine: PdfEngine = { JsPDF: jsPDF, autoTable };

export function tablePdf<T extends object>(options: TablePdfOptions<T>): PdfDoc {
  return buildTablePdf(engine, options);
}

export function documentPdf(options: PdfDocumentOptions = {}): PdfDoc {
  return createPdfDoc(engine, options);
}
