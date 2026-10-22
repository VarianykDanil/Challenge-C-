// Release 1.3 — the PDF renderer — OWNED BY P4 pdf-everywhere.
//
// Draws every PDF Linear Hub makes: the table PDFs behind each "Export ▾ PDF" (exportTablePdf) and the page PDFs
// (pdfDocument: P2's invoice, P7's candidate profile, P8's venue report, P4's audit and learning-progress PDFs).
//  - A4 in millimetres; portrait, or landscape for tables over six columns (shared pdfOrientationFor).
//  - The brand band on page 1 (the mark, "Linear Hub", "Linear MCR Limited", "Generated Thu 22 Oct 2026, 15:04"),
//    a slim running header on every later page, and "Linear Hub · <title>" with "Page x of y" at the foot of every page.
//  - Tables repeat their header row on every page and print the totals row once, at the end.
//  - Every string goes through the shared toPdfText / pdfSafeText (WinAnsi text the built-in Helvetica can draw; a
//    cell a spreadsheet would run as a formula gets an apostrophe), and table cells through pdfCellText (money, dates,
//    counts as on screen).
// It is handed jsPDF and jspdf-autotable (engine.ts in the browser, in their own lazy chunk; the server's Node test
// imports them itself), so this file has no DOM work at import time and only relative imports with extensions.
import type { jsPDF } from 'jspdf';
import type { CellHookData, RowInput, UserOptions } from 'jspdf-autotable';
import {
  BRAND,
  PDF_WINANSI_EXTRAS,
  isNumericColumn,
  pdfCellText,
  pdfFilenameFor,
  pdfGeneratedLine,
  pdfInfoText,
  pdfOrientationFor,
  pdfPageLabel,
  pdfSafeText,
  toPdfText,
  type PdfCellKind,
} from '@lm/shared';
import { csvCellText, csvColumnKind, downloadBlob, type CsvColumn } from '../csv.ts';
import type { PdfAddress, PdfDoc, PdfDocumentOptions, PdfLineColumn, PdfLineRow, PdfSignature, TablePdfOptions } from './types.ts';

/** What the renderer needs from the two libraries. */
export interface PdfEngine {
  JsPDF: typeof jsPDF;
  autoTable: (doc: jsPDF, options: UserOptions) => void;
}

type Rgb = [number, number, number];
/** The brand's ink, muted text, "Linear Violet", hairlines and table fills (DESIGN.md, light theme). */
export const PDF_COLOURS = {
  ink: [15, 21, 38] as Rgb,
  muted: [94, 102, 120] as Rgb,
  violet: [75, 63, 217] as Rgb,
  border: [222, 225, 234] as Rgb,
  headFill: [238, 237, 252] as Rgb,
  zebra: [248, 248, 251] as Rgb,
  footFill: [243, 243, 248] as Rgb,
} as const;
const { ink: INK, muted: MUTED, violet: VIOLET, border: BORDER, headFill: HEAD_FILL, zebra: ZEBRA, footFill: FOOT_FILL } = PDF_COLOURS;

/** Table body font size (pt) by column count: 9 up to six columns, down to 6.5 for the widest (19-column) tables. */
export function tableFontSize(columns: number): number {
  return columns <= 6 ? 9 : columns <= 9 ? 8.5 : columns <= 13 ? 7.5 : columns <= 16 ? 7 : 6.5;
}

/** A table ready to draw: header texts, cells as on screen, right alignment for numeric columns, the totals row. */
export interface PreparedTable {
  head: string[];
  body: string[][];
  align: ('left' | 'right')[];
  kinds: PdfCellKind[];
  foot?: string[];
}

/** The CSV columns and rows as PDF cells: exactly the CSV's text, written the way the screen writes it. */
/** Tables wider than this many columns write dates without the weekday ("12 Oct 2026"), so a cell fits one line. */
export const PDF_DENSE_COLUMNS = 12;

export function prepareTable<T extends object>(columns: CsvColumn<T>[], rows: T[], totals?: Partial<Record<string, string>>): PreparedTable {
  const sample = (key: string): unknown => {
    for (const r of rows) {
      const v = (r as Record<string, unknown>)[key];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return undefined;
  };
  const kinds = columns.map((c) => csvColumnKind(c, sample(c.key)));
  const dense = columns.length > PDF_DENSE_COLUMNS;
  const cell = (text: string, kind: PdfCellKind | undefined): string => {
    const out = pdfCellText(text, kind);
    // "Mon 12 Oct 2026" → "12 Oct 2026" in a dense table (only text pdfCellText wrote as a date)
    return dense && /^\d{4}-\d{2}-\d{2}/.test(text) && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /.test(out) ? out.slice(4) : out;
  };
  const body = rows.map((row) => columns.map((c, i) => cell(csvCellText(row, c), kinds[i])));
  const align = columns.map((_, i): 'left' | 'right' => {
    const k = kinds[i];
    return k === 'money' || k === 'number' || k === 'percent' || isNumericColumn(body.map((r) => r[i] ?? '')) ? 'right' : 'left';
  });
  const head = columns.map((c) => toPdfText(c.header));
  const foot = totals
    ? columns.map((c, i) => {
        const v = totals[c.key];
        return v != null && v !== '' ? pdfSafeText(v) : i === 0 ? 'Total' : '';
      })
    : undefined;
  return foot ? { head, body, align, kinds, foot } : { head, body, align, kinds };
}

/** jsPDF's internals this file reaches into (font metrics, page size). */
interface DocInternals {
  getFont(name?: string, style?: string): { metadata?: { Unicode?: { widths?: Record<number, number> & { fof?: number } } } } | undefined;
}

/**
 * jsPDF measures the standard fonts by Unicode code point, but the WinAnsi bytes 0x80–0x9F (en dash, ellipsis, curly
 * quotes…) arrive as those bytes: give each byte its character's width so wrapping and right alignment stay true.
 */
function patchWinAnsiWidths(doc: jsPDF): void {
  const internal = doc.internal as unknown as DocInternals;
  for (const style of ['normal', 'bold', 'italic', 'bolditalic']) {
    let widths: (Record<number, number> & { fof?: number }) | undefined;
    try {
      widths = internal.getFont('helvetica', style)?.metadata?.Unicode?.widths;
    } catch {
      widths = undefined;
    }
    if (!widths) continue;
    const em = widths.fof ?? 1;
    for (const [unicode, byte] of Object.entries(PDF_WINANSI_EXTRAS)) {
      if (widths[byte] === undefined) widths[byte] = widths[Number(unicode)] ?? 0.556 * em;
    }
  }
}

const PT = 0.3528; // mm per point
const lh = (size: number) => size * PT * 1.28;
const DATA_IMAGE = /^data:image\/(png|jpe?g);base64,[a-z0-9+/=\s]+$/i;

interface Internals {
  doc: jsPDF;
  drawTable(t: PreparedTable, opts?: { fontSize?: number; widths?: number[]; muted?: boolean[]; emptyText?: string }): void;
}

function makeDoc(engine: PdfEngine, opts: PdfDocumentOptions): { api: PdfDoc; internals: Internals } {
  const orientation = opts.orientation ?? 'portrait';
  const doc = new engine.JsPDF({ orientation, unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true });
  patchWinAnsiWidths(doc);
  const rawTitle = opts.title?.trim() || BRAND.product;
  const title = toPdfText(rawTitle);
  // The document properties keep the real characters (jsPDF writes them as UTF-16 when needed); the WinAnsi bytes of
  // `title` would read as other marks there (’ as ™, – as Œ).
  const info = pdfInfoText(rawTitle);
  doc.setProperties({ title: info, subject: info, author: BRAND.legalName, creator: BRAND.product });
  try {
    doc.setLanguage('en-GB');
  } catch {
    // older readers ignore the language; nothing to do
  }
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = orientation === 'landscape' ? 12 : 14;
  /** Later pages start below the running header. */
  const TOP2 = M + 9;
  /** Clear of the footer rule. */
  const BOTTOM = 17;
  const CW = W - 2 * M;
  const generated = toPdfText(pdfGeneratedLine(opts.now ?? new Date(), opts.generatedBy));
  let y = M;
  // `title` is WinAnsi text already: folding it again would drop its 0x80–0x9F marks (’ – … “ ”)
  let footerText = `${toPdfText(BRAND.product)} · ${title}`;
  let finalised = false;

  const font = (size: number, style: 'normal' | 'bold' = 'normal', color: Rgb = INK) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
  };
  const split = (text: string, width: number): string[] => (text ? (doc.splitTextToSize(text, Math.max(4, width)) as string[]) : []);
  const room = (h: number) => {
    if (y + h > H - BOTTOM) {
      doc.addPage();
      y = TOP2;
    }
  };
  const write = (text: string, x: number, at: number, o: { align?: 'left' | 'right' | 'center' } = {}) => {
    doc.text(text, x, at, { baseline: 'top', align: o.align ?? 'left' });
  };

  const drawMark = (x: number, top: number, size: number) => {
    doc.setFillColor(VIOLET[0], VIOLET[1], VIOLET[2]);
    doc.roundedRect(x, top, size, size, size * 0.25, size * 0.25, 'F');
    // the three strokes of the mark, skewed 14° like the SVG (client/public/brand/mark.svg)
    const u = size / 32;
    const k = Math.tan((14 * Math.PI) / 180);
    doc.setDrawColor(255, 255, 255);
    doc.setLineWidth(3.2 * u);
    doc.setLineCap('round');
    for (const [x1, x2, yy] of [[10, 16, 10], [10, 20, 16], [10, 24, 22]] as const) {
      const dx = -k * (yy - 16);
      doc.line(x + (x1 + dx) * u, top + yy * u, x + (x2 + dx) * u, top + yy * u);
    }
    doc.setLineCap('butt');
  };
  const wordmark = (x: number, top: number, size: number) => {
    const [first, ...rest] = BRAND.product.split(' ');
    font(size, 'bold', INK);
    write(first ?? BRAND.product, x, top);
    if (rest.length) {
      const w = doc.getTextWidth(`${first} `);
      font(size, 'bold', VIOLET);
      write(rest.join(' '), x + w, top);
    }
  };
  const rule = (at: number, color: Rgb = BORDER, width = 0.3, x1 = M, x2 = W - M) => {
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(width);
    doc.line(x1, at, x2, at);
  };

  /**
   * The file, written once: jsPDF re-encodes images on every output (and then leaves the page uncompressed), so a
   * second save or blob returns these same bytes instead.
   */
  let written: ArrayBuffer | null = null;
  const output = (): ArrayBuffer => {
    finalise();
    written ??= doc.output('arraybuffer');
    return written;
  };

  const finalise = () => {
    if (finalised) return;
    finalised = true;
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      if (p > 1) {
        drawMark(M, M - 1.2, 4.6);
        wordmark(M + 6.3, M - 0.6, 8);
        font(8, 'normal', MUTED);
        const after = M + 6.3 + doc.getTextWidth(`${BRAND.product}  `) + 1;
        write(split(title, W - M - after)[0] ?? '', after, M - 0.6);
      }
      rule(H - 12, BORDER, 0.2);
      font(7.5, 'normal', MUTED);
      write(split(footerText, CW - 32)[0] ?? '', M, H - 10);
      write(pdfPageLabel(p, pages), W - M, H - 10, { align: 'right' });
    }
  };

  const drawTable: Internals['drawTable'] = (t, o = {}) => {
    if (finalised) return;
    const n = t.head.length;
    const fontSize = o.fontSize ?? tableFontSize(n);
    const body: RowInput[] = t.body.length
      ? t.body
      : [[{ content: toPdfText(o.emptyText ?? 'Nothing to show'), colSpan: Math.max(1, n), styles: { halign: 'center', textColor: MUTED } }]];
    const columnStyles: UserOptions['columnStyles'] = {};
    t.align.forEach((a, i) => {
      columnStyles[i] = o.widths?.[i] != null ? { halign: a, cellWidth: o.widths[i] } : { halign: a };
    });
    // a short table stays on one page (it moves whole to the next one); a long one starts with at least two rows
    const rowH = lh(fontSize) + 3.2;
    const whole = (t.body.length + 1 + (t.foot ? 1 : 0)) * rowH + 2;
    room(whole <= (H - BOTTOM - TOP2) * 0.4 ? whole : rowH * 3 + 2);
    engine.autoTable(doc, {
      startY: y,
      margin: { top: TOP2, right: M, bottom: BOTTOM, left: M },
      head: [t.head],
      body,
      foot: t.foot ? [t.foot] : undefined,
      theme: 'plain',
      showHead: 'everyPage',
      showFoot: 'lastPage',
      rowPageBreak: 'avoid',
      tableWidth: 'auto',
      styles: {
        font: 'helvetica',
        fontSize,
        textColor: INK,
        cellPadding: { top: 1.5, bottom: 1.5, left: 1.6, right: 1.6 },
        overflow: 'linebreak',
        valign: 'top',
        lineColor: BORDER,
        lineWidth: 0,
      },
      headStyles: { fillColor: HEAD_FILL, textColor: INK, fontStyle: 'bold', valign: 'bottom', lineColor: VIOLET, lineWidth: { bottom: 0.35 } },
      footStyles: { fillColor: FOOT_FILL, textColor: INK, fontStyle: 'bold', lineColor: INK, lineWidth: { top: 0.35 } },
      alternateRowStyles: { fillColor: ZEBRA },
      columnStyles,
      didParseCell: (d: CellHookData) => {
        if (!t.body.length && d.section === 'body') return;
        d.cell.styles.halign = t.align[d.column.index] ?? 'left';
        if (d.section === 'body' && o.muted?.[d.row.index]) d.cell.styles.textColor = MUTED;
      },
    });
    const last = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable;
    y = (last?.finalY ?? y) + 5;
  };

  const api: PdfDoc = {
    header({ title: heading, subtitle, meta, filters }) {
      if (finalised) return api;
      const top = y;
      drawMark(M, top, 7.5);
      wordmark(M + 10, top + 1.3, 12.5);
      font(7.5, 'normal', MUTED);
      write(toPdfText(BRAND.legalName), W - M, top + 0.6, { align: 'right' });
      write(generated, W - M, top + 4.2, { align: 'right' });
      y = top + 13;
      const metaRows = (meta ?? []).map(([l, v]) => [toPdfText(l), toPdfText(v)] as const);
      const metaW = metaRows.length ? 74 : 0;
      const leftW = CW - (metaW ? metaW + 8 : 0);
      let ly = y;
      font(17, 'bold', INK);
      for (const line of split(toPdfText(heading), leftW)) {
        write(line, M, ly);
        ly += lh(17);
      }
      if (subtitle) {
        ly += 0.6;
        font(10.5, 'normal', MUTED);
        for (const line of split(toPdfText(subtitle), leftW)) {
          write(line, M, ly);
          ly += lh(10.5);
        }
      }
      const lines = (filters ?? []).map((f) => toPdfText(f)).filter(Boolean);
      if (lines.length) {
        ly += 0.8;
        font(8.5, 'normal', MUTED);
        for (const line of split(lines.join('   ·   '), leftW)) {
          write(line, M, ly);
          ly += lh(8.5);
        }
      }
      let ry = y + 0.6;
      for (const [label, value] of metaRows) {
        font(8, 'normal', MUTED);
        write(label, W - M - metaW, ry + 0.4);
        font(9.5, 'bold', INK);
        const vl = split(value, metaW - 26);
        vl.forEach((line, i) => write(line, W - M, ry + i * lh(9.5), { align: 'right' }));
        ry += Math.max(1, vl.length) * lh(9.5) + 1.2;
      }
      y = Math.max(ly, ry) + 3;
      rule(y);
      y += 5;
      return api;
    },

    addressBlocks(left: PdfAddress, right: PdfAddress) {
      if (finalised) return api;
      const colW = (CW - 10) / 2;
      const block = (a: PdfAddress, x: number, draw: boolean): number => {
        let by = y;
        const put = (text: string, size: number, style: 'normal' | 'bold', color: Rgb) => {
          font(size, style, color);
          for (const line of split(toPdfText(text), colW)) {
            if (draw) write(line, x, by);
            by += lh(size);
          }
        };
        put(a.heading.toUpperCase(), 7.5, 'bold', MUTED);
        by += 0.6;
        put(a.name, 10.5, 'bold', INK);
        for (const l of a.lines) put(l, 9, 'normal', INK);
        for (const l of a.extra ?? []) put(l, 8.5, 'normal', MUTED);
        return by;
      };
      room(Math.max(block(left, M, false), block(right, M + colW + 10, false)) - y);
      y = Math.max(block(left, M, true), block(right, M + colW + 10, true)) + 6;
      return api;
    },

    heading(text: string) {
      if (finalised) return api;
      room(lh(12) + 30); // keep a heading with the first lines (or rows) under it
      y += 1.5;
      font(12, 'bold', INK);
      for (const line of split(toPdfText(text), CW)) {
        write(line, M, y);
        y += lh(12);
      }
      y += 1.6;
      return api;
    },

    paragraph(text: string, o: { muted?: boolean; size?: number } = {}) {
      if (finalised) return api;
      const size = o.size ?? 9.5;
      font(size, 'normal', o.muted ? MUTED : INK);
      for (const line of split(toPdfText(text), CW)) {
        room(lh(size));
        font(size, 'normal', o.muted ? MUTED : INK);
        write(line, M, y);
        y += lh(size);
      }
      y += 1.8;
      return api;
    },

    keyValues(rows: [label: string, value: string][]) {
      if (finalised) return api;
      const labelW = Math.min(62, CW * 0.36);
      for (const [label, value] of rows) {
        font(9, 'normal', MUTED);
        const ll = split(toPdfText(label), labelW - 4);
        font(9.5, 'bold', INK);
        const vl = split(pdfSafeText(value), CW - labelW);
        const h = Math.max(ll.length * lh(9), vl.length * lh(9.5), lh(9.5)) + 1.4;
        room(h);
        font(9, 'normal', MUTED);
        ll.forEach((line, i) => write(line, M, y + 0.3 + i * lh(9)));
        font(9.5, 'bold', INK);
        vl.forEach((line, i) => write(line, M + labelW, y + i * lh(9.5)));
        y += h;
      }
      y += 2.2;
      return api;
    },

    lineTable(columns: PdfLineColumn[], rows: PdfLineRow[]) {
      if (finalised) return api;
      const total = columns.reduce((s, c) => s + (c.width ?? 1), 0) || 1;
      drawTable(
        {
          head: columns.map((c) => toPdfText(c.header)),
          body: rows.map((r) => columns.map((c) => {
            const v = c.key === 'muted' ? undefined : r[c.key];
            return typeof v === 'string' ? pdfSafeText(v) : '';
          })),
          align: columns.map((c) => (c.align === 'right' ? 'right' : 'left')),
          kinds: columns.map(() => 'text'),
        },
        { fontSize: 9, widths: columns.map((c) => (CW * (c.width ?? 1)) / total), muted: rows.map((r) => r.muted === true) },
      );
      return api;
    },

    table<T extends object>(columns: CsvColumn<T>[], rows: T[]) {
      if (finalised) return api;
      drawTable(prepareTable(columns, rows));
      return api;
    },

    totals(rows: { label: string; value: string; strong?: boolean }[]) {
      if (finalised) return api;
      const bw = Math.min(92, CW * 0.55);
      const x0 = W - M - bw;
      for (const r of rows) {
        const size = r.strong ? 10.5 : 9.5;
        room(lh(size) + 4);
        if (r.strong) {
          rule(y, INK, 0.35, x0, W - M);
          y += 1.8;
        }
        font(size, r.strong ? 'bold' : 'normal', r.strong ? INK : MUTED);
        write(split(toPdfText(r.label), bw - 34)[0] ?? '', x0, y);
        font(size, 'bold', INK);
        write(pdfSafeText(r.value), W - M, y, { align: 'right' });
        y += lh(size) + 1.4;
      }
      y += 3;
      return api;
    },

    signatureBlock(left: PdfSignature, right?: PdfSignature) {
      if (finalised) return api;
      const colW = right ? (CW - 12) / 2 : Math.min(CW, 92);
      const IMG_H = 14;
      const block = (s: PdfSignature, x: number, draw: boolean): number => {
        let by = y;
        font(8, 'normal', MUTED);
        if (draw) write(split(toPdfText(s.label), colW)[0] ?? '', x, by);
        by += lh(8) + 1;
        if (draw && s.imageDataUrl && DATA_IMAGE.test(s.imageDataUrl)) {
          try {
            const props = doc.getImageProperties(s.imageDataUrl);
            const ratio = props.width > 0 && props.height > 0 ? props.width / props.height : 3;
            const h = Math.min(IMG_H, (colW * 0.7) / ratio);
            doc.addImage(s.imageDataUrl, /jpe?g/i.test(s.imageDataUrl.slice(11, 16)) ? 'JPEG' : 'PNG', x, by + (IMG_H - h), h * ratio, h);
          } catch {
            // an unreadable image leaves the line blank to sign by hand
          }
        }
        by += IMG_H + 1;
        if (draw) rule(by, MUTED, 0.3, x, x + colW);
        by += 1.8;
        font(9.5, 'bold', INK);
        for (const line of split(toPdfText(s.name), colW)) {
          if (draw) write(line, x, by);
          by += lh(9.5);
        }
        if (s.note) {
          font(8, 'normal', MUTED);
          for (const line of split(toPdfText(s.note), colW)) {
            if (draw) write(line, x, by);
            by += lh(8);
          }
        }
        return by;
      };
      const h = Math.max(block(left, M, false), right ? block(right, M + colW + 12, false) : 0) - y;
      room(h);
      const a = block(left, M, true);
      const b = right ? block(right, M + colW + 12, true) : a;
      y = Math.max(a, b) + 6;
      return api;
    },

    footer(text: string) {
      footerText = toPdfText(text);
      return api;
    },

    space(mm = 4) {
      if (!finalised) y += Math.max(0, mm);
      return api;
    },

    pageBreak() {
      if (!finalised) {
        doc.addPage();
        y = TOP2;
      }
      return api;
    },

    needs(mm: number) {
      if (!finalised) room(Math.min(Math.max(0, mm), H - BOTTOM - TOP2));
      return api;
    },

    save(filename: string) {
      downloadBlob(pdfFilenameFor(filename), api.blob());
    },

    blob() {
      return new Blob([output()], { type: 'application/pdf' });
    },

    bytes() {
      return new Uint8Array(output());
    },
  };

  return { api, internals: { doc, drawTable } };
}

/** pdfDocument(): an empty A4 page PDF to build with the chainable blocks. */
export function createPdfDoc(engine: PdfEngine, opts: PdfDocumentOptions = {}): PdfDoc {
  return makeDoc(engine, opts).api;
}

/**
 * exportTablePdf(): the brand header, the title, the page heading as subtitle, the filters and the row count, then the
 * table (header row on every page, the totals row at the end), "Page x of y" on every page. Returns the document;
 * the caller saves it.
 */
export function buildTablePdf<T extends object>(engine: PdfEngine, options: TablePdfOptions<T>): PdfDoc {
  const orientation = options.orientation && options.orientation !== 'auto' ? options.orientation : pdfOrientationFor(options.columns.length);
  const { api, internals } = makeDoc(engine, { orientation, title: options.title, generatedBy: options.generatedBy, now: options.now });
  const count = `${new Intl.NumberFormat('en-GB').format(options.rows.length)} ${options.rows.length === 1 ? 'row' : 'rows'}`;
  api.header({ title: options.title, subtitle: options.subtitle, filters: [...(options.filters ?? []), count] });
  internals.drawTable(prepareTable(options.columns, options.rows, options.totals));
  return api;
}
