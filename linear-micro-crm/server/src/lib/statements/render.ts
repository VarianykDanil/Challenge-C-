/**
 * Release 1.3 — OWNED BY P3 statements. Draws a client's commission statement as a PDF with jsPDF (the same version P4
 * uses on the client): the demo statements of a fresh seed (made the first time someone opens them) and the tests'
 * fixtures. A4 portrait, the client's name and colour, the period and reference lines, then the table with its header
 * repeated on every page, a total line and "Page x of y". jsPDF is imported on first use only. The same spec always
 * gives the same bytes (fixed creation date and file ID).
 */
import { createHash } from 'node:crypto';

export interface StatementPdfSpec {
  /** The client, e.g. "Breast Cancer Now". */
  title: string;
  subtitle: string;
  /** Lines under the title: agency, period, statement number, issue date. */
  lines: string[];
  headers: string[];
  rows: string[][];
  totals?: string[] | null;
  /** Small print after the table. */
  notes?: string[];
  /** Column widths in points (they are scaled to the page width); default: equal. */
  widths?: number[];
  /** Right-aligned columns (counts and money). */
  right?: boolean[];
  /** ISO timestamp written as the PDF's creation date. */
  createdAt: string;
  /** "#EC4899": the header band's colour. */
  color?: string;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const ROW_H = 15;
const BOTTOM = PAGE_H - 60;

/** Only characters the standard PDF fonts can draw (WinAnsi); others become "?". */
const winAnsi = (s: string) => s.replace(/[^\x20-\x7E -ÿ£€–—‘’“”•…]/g, '?');

const rgb = (hex: string | undefined): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [79, 70, 229];
};

type JsPdfModule = typeof import('jspdf');
let jspdf: Promise<JsPdfModule> | null = null;

export async function renderStatementPdf(spec: StatementPdfSpec): Promise<Buffer> {
  jspdf ??= import('jspdf');
  const { jsPDF } = await jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  doc.setCreationDate(new Date(spec.createdAt));
  doc.setFileId(createHash('md5').update(JSON.stringify(spec)).digest('hex').toUpperCase());
  doc.setProperties({ title: `${spec.title} — ${spec.subtitle}`, creator: spec.title });

  const n = spec.headers.length;
  const raw = spec.widths?.length === n ? spec.widths : spec.headers.map(() => 1);
  const scale = (PAGE_W - 2 * MARGIN) / Math.max(1, raw.reduce((s, w) => s + w, 0));
  const widths = raw.map((w) => w * scale);
  const lefts = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((s, w) => s + w, 0));
  const [r, g, b] = rgb(spec.color);

  const cellX = (i: number) => (spec.right?.[i] ? lefts[i]! + widths[i]! - 6 : lefts[i]! + 4);
  const drawCells = (cells: readonly string[], y: number) => {
    cells.forEach((c, i) => {
      if (i >= n || !c) return;
      doc.text(winAnsi(c), cellX(i), y, spec.right?.[i] ? { align: 'right' } : undefined);
    });
  };
  const drawHeader = (y: number) => {
    doc.setFillColor(r, g, b);
    doc.rect(MARGIN, y - 11, PAGE_W - 2 * MARGIN, 17, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    drawCells(spec.headers, y);
    doc.setTextColor(33, 33, 33);
    doc.setFont('helvetica', 'normal');
    return y + 19;
  };

  // Title block
  doc.setFillColor(r, g, b);
  doc.rect(0, 0, PAGE_W, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(33, 33, 33);
  doc.text(winAnsi(spec.title), MARGIN, 52);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(winAnsi(spec.subtitle), MARGIN, 70);
  doc.setFontSize(9);
  let y = 92;
  for (const line of spec.lines) {
    doc.text(winAnsi(line), MARGIN, y);
    y += 13;
  }
  y += 16;
  if (n) y = drawHeader(y);
  doc.setFontSize(9);
  spec.rows.forEach((row, i) => {
    if (y > BOTTOM) {
      doc.addPage();
      y = drawHeader(60);
      doc.setFontSize(9);
    }
    if (i % 2 === 1) {
      doc.setFillColor(245, 245, 247);
      doc.rect(MARGIN, y - 10.5, PAGE_W - 2 * MARGIN, ROW_H, 'F');
    }
    drawCells(row, y);
    y += ROW_H;
  });
  if (spec.totals) {
    if (y > BOTTOM) {
      doc.addPage();
      y = drawHeader(60);
    }
    doc.setDrawColor(120, 120, 120);
    doc.line(MARGIN, y - 10, PAGE_W - MARGIN, y - 10);
    doc.setFont('helvetica', 'bold');
    drawCells(spec.totals, y + 2);
    doc.setFont('helvetica', 'normal');
    y += ROW_H + 4;
  }
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 90);
  y += 4;
  for (const note of spec.notes ?? []) {
    for (const line of doc.splitTextToSize(winAnsi(note), PAGE_W - 2 * MARGIN) as string[]) {
      y += 11;
      if (y > PAGE_H - 50) {
        doc.addPage();
        y = 60;
      }
      doc.text(line, MARGIN, y);
    }
    y += 3;
  }
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 28, { align: 'right' });
    doc.text(winAnsi(spec.title), MARGIN, PAGE_H - 28);
  }
  return Buffer.from(doc.output('arraybuffer'));
}
