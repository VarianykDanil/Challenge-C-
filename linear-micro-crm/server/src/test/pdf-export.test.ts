/**
 * Release 1.3 — P4 pdf-everywhere: the real client PDF renderer (client/src/lib/pdf/render.ts with the real CSV column
 * code, client/src/lib/csv.ts) run under Node with jsPDF + jspdf-autotable, and the files it writes checked byte by
 * byte: a valid PDF (header, every xref offset lands on its object, trailer, %%EOF), the page count and size, and the
 * text on each page (content streams inflated and their text operators read back): the brand header, money and dates
 * as on screen, the header row repeated on every page, the totals row once, "Page x of y", the formula guard, and
 * WinAnsi text only (no 16-bit strings the built-in font would print as gibberish).
 *
 * Plus the one server contract the exports rely on: POST /audit/events takes every export event the client sends
 * (204 for each staff role), refuses a client portal session (403) and anonymous callers (401).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import type { ClientAuditEventInput, LearningVideo } from '@lm/shared';
import { buildTablePdf, createPdfDoc, prepareTable, tableFontSize, type PdfEngine } from '../../../client/src/lib/pdf/render.ts';
import { csvDate, csvDateTime, csvFilename, csvLabel, csvMoney, csvPct, type CsvColumn } from '../../../client/src/lib/csv.ts';
import { ownRequiredVideos, teamRequiredVideos, videoRequiredOf, type TeamVideoView } from '../../../client/src/features/pdf/progressVideos.ts';
import { auditCoverageLine, auditPdfWho } from '../../../client/src/features/pdf/auditPdfText.ts';
import { startTestServer, type TestServer } from './helpers.ts';

const engine: PdfEngine = { JsPDF: jsPDF, autoTable };
// Thu 22 Oct 2026, 15:04 on the device clock
const NOW = new Date(2026, 9, 22, 15, 4);

// ───────────────────────────── A small PDF reader (bytes, xref, pages, text) ─────────────────────────────

interface ParsedPdf {
  pages: number;
  /** [width, height] in points of each page. */
  mediaBoxes: [number, number][];
  /** The text shown on each page, one string per text-show operator, in drawing order. */
  text: string[][];
  /** Each page's content stream, inflated. */
  contents: string[];
  raw: string;
}

/** Undo PDF literal-string escapes: \( \) \\ \n \r \t \b \f and \ddd octal. */
function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, e: string) => {
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return map[e] ?? String.fromCharCode(parseInt(e, 8));
  });
}

/** Every literal string shown by Tj / TJ / ' / " in a content stream. */
function textOps(content: string): string[] {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ/g;
  for (const m of content.matchAll(re)) {
    const piece = m[0];
    const strings = [...piece.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => unescapePdfString(x[1]!));
    out.push(strings.join(''));
  }
  return out;
}

/** Map WinAnsi bytes 0x80–0x9F back to the marks they stand for (only the ones the app uses). */
const WINANSI_BACK: Record<number, string> = { 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x80: '€' };
const fromWinAnsi = (s: string) => [...s].map((c) => WINANSI_BACK[c.charCodeAt(0)] ?? c).join('');

function parsePdf(bytes: Uint8Array): ParsedPdf {
  const raw = Buffer.from(bytes).toString('latin1');
  assert.ok(raw.startsWith('%PDF-1.'), 'starts with a %PDF-1.x header');
  assert.match(raw.trimEnd(), /%%EOF$/, 'ends with %%EOF');
  // the cross-reference table: every in-use offset must land exactly on "n 0 obj"
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw);
  assert.ok(sx, 'has startxref');
  const xrefAt = Number(sx![1]);
  assert.equal(raw.slice(xrefAt, xrefAt + 4), 'xref', 'startxref points at the xref table');
  const head = /^xref\s+(\d+)\s+(\d+)\s+/.exec(raw.slice(xrefAt));
  assert.ok(head, 'xref subsection header');
  const first = Number(head![1]);
  const count = Number(head![2]);
  const entries = raw.slice(xrefAt + head![0].length).split(/\r?\n|\r/).slice(0, count);
  assert.equal(entries.length, count);
  const objects = new Map<number, string>();
  entries.forEach((line, i) => {
    const m = /^(\d{10}) (\d{5}) ([nf])/.exec(line.trim().padEnd(18));
    assert.ok(m, `xref entry ${i}: ${JSON.stringify(line)}`);
    if (m![3] !== 'n') return;
    const offset = Number(m![1]);
    const num = first + i;
    assert.ok(raw.startsWith(`${num} 0 obj`, offset), `object ${num} starts at offset ${offset}`);
    const end = raw.indexOf('endobj', offset);
    assert.ok(end > offset, `object ${num} has endobj`);
    objects.set(num, raw.slice(offset, end));
  });
  const trailer = /trailer\s*<<([\s\S]*?)>>/.exec(raw);
  assert.ok(trailer && /\/Size\s+\d+/.test(trailer[1]!) && /\/Root\s+\d+ 0 R/.test(trailer[1]!), 'trailer with /Size and /Root');

  const pageObjs = [...objects.values()].filter((o) => /\/Type\s*\/Page\b(?!s)/.test(o));
  const mediaBoxes = pageObjs.map((o) => {
    const mb = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(o);
    assert.ok(mb, 'page has a MediaBox');
    return [Number(mb![3]) - Number(mb![1]), Number(mb![4]) - Number(mb![2])] as [number, number];
  });
  const contents = pageObjs.map((o) => {
    const ref = /\/Contents\s+(\d+) 0 R/.exec(o);
    assert.ok(ref, 'page has contents');
    const obj = objects.get(Number(ref![1]))!;
    const sm = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(obj);
    assert.ok(sm, 'content stream');
    const data = Buffer.from(sm![1]!, 'latin1');
    return /\/FlateDecode/.test(obj) ? inflateSync(data).toString('latin1') : data.toString('latin1');
  });
  const text = contents.map((c) => textOps(c).map(fromWinAnsi));
  return { pages: pageObjs.length, mediaBoxes, text, contents, raw };
}

const A4_PORTRAIT: [number, number] = [595.28, 841.89];
const near = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;

// ───────────────────────────── Fixtures ─────────────────────────────

interface PayRow {
  weekStart: string;
  userName: string;
  position: 'field_rep' | 'team_leader';
  sales: number;
  gross: number;
  conversion: number;
  paidAt: string | null;
}

const COLUMNS: CsvColumn<PayRow>[] = [
  { key: 'weekStart', header: 'Week start', format: csvDate },
  { key: 'userName', header: 'Person' },
  { key: 'position', header: 'Position', format: csvLabel({ field_rep: 'Field Representative', team_leader: 'Team Leader' }) },
  { key: 'sales', header: 'Sales' },
  { key: 'gross', header: 'Gross', format: csvMoney },
  { key: 'conversion', header: 'Conversion', format: csvPct(1) },
];

function payRows(n: number): PayRow[] {
  return Array.from({ length: n }, (_, i) => ({
    weekStart: '2026-10-19',
    userName: `Person ${String(i + 1).padStart(3, '0')}`,
    position: i % 2 ? 'team_leader' : 'field_rep',
    sales: 1000 + i,
    gross: 1234.5 + i,
    conversion: 0.0412,
    paidAt: null,
  }));
}

test('prepareTable: the CSV text written as on screen, numeric columns right-aligned', () => {
  const rows: PayRow[] = [
    { weekStart: '2026-10-19', userName: 'Jordan Lee', position: 'field_rep', sales: 1240, gross: 1234.5, conversion: 0.0412, paidAt: null },
    { weekStart: '2026-10-12', userName: '=HYPERLINK("http://evil","x")', position: 'team_leader', sales: 3, gross: -12.5, conversion: 0, paidAt: null },
  ];
  const t = prepareTable(COLUMNS, rows, { userName: '2 people', gross: '£1,222.00' });
  assert.deepEqual(t.head, ['Week start', 'Person', 'Position', 'Sales', 'Gross', 'Conversion']);
  // 19 Oct 2026 is a Monday; 1234.5 → £1,234.50; 1240 → 1,240; 0.0412 → 4.1%
  assert.deepEqual(t.body[0], ['Mon 19 Oct 2026', 'Jordan Lee', 'Field Representative', '1,240', '£1,234.50', '4.1%']);
  assert.deepEqual(t.body[1], ['Mon 12 Oct 2026', `'=HYPERLINK("http://evil","x")`, 'Team Leader', '3', '-£12.50', '0.0%']);
  assert.deepEqual(t.align, ['left', 'left', 'left', 'right', 'right', 'right']);
  assert.deepEqual(t.kinds, ['date', 'text', 'text', 'number', 'money', 'percent']);
  assert.deepEqual(t.foot, ['Total', '2 people', '', '', '£1,222.00', '']);
  // a column can say its kind; a datetime formatter is recognised
  const t2 = prepareTable<{ at: string; amount: string }>(
    [
      { key: 'at', header: 'When', format: csvDateTime },
      { key: 'amount', header: 'Amount', kind: 'money' },
    ],
    [{ at: '2026-10-21T08:30:00', amount: '945' }],
  );
  assert.deepEqual(t2.body[0], ['21 Oct 2026, 08:30', '£945.00']);
  assert.deepEqual(t2.align, ['left', 'right']);
  // over twelve columns, dates drop the weekday so a cell fits one line
  const dense: CsvColumn<PayRow>[] = [...COLUMNS, ...Array.from({ length: 7 }, (_, i): CsvColumn<PayRow> => ({ key: `x${i}`, header: `X${i}` }))];
  assert.equal(prepareTable(dense, rows).body[0]![0], '19 Oct 2026');
  assert.equal(prepareTable(COLUMNS, rows).body[0]![0], 'Mon 19 Oct 2026');
});

test('table font size shrinks with the column count', () => {
  assert.equal(tableFontSize(6), 9);
  assert.equal(tableFontSize(7), 8.5);
  assert.equal(tableFontSize(12), 7.5);
  assert.equal(tableFontSize(19), 6.5);
});

test('a table PDF: valid file, brand header, cells as on screen, header row on every page, totals once, Page x of y', () => {
  const rows = payRows(130);
  const doc = buildTablePdf(engine, {
    title: 'Team pay',
    subtitle: 'Finance',
    filters: ['Team: Deansgate', '1 – 21 Oct 2026'],
    columns: COLUMNS,
    rows,
    totals: { userName: '130 people', gross: '£169,227.50' },
    filename: 'linear-hub-team-pay-2026-10-01_2026-10-21.csv',
    generatedBy: 'Danil Varianyk',
    now: NOW,
  });
  const pdf = parsePdf(doc.bytes());
  assert.ok(pdf.pages >= 3, `130 rows run over several pages (got ${pdf.pages})`);
  for (const mb of pdf.mediaBoxes) assert.ok(near(mb, A4_PORTRAIT), `six columns: A4 portrait (${mb})`);
  const all = pdf.text.flat();
  const page1 = pdf.text[0]!;
  // brand band, title, subtitle, filters with the row count, generated line
  for (const s of ['Linear', 'Hub', 'Linear MCR Limited', 'Generated Thu 22 Oct 2026, 15:04 by Danil Varianyk', 'Team pay', 'Finance']) {
    assert.ok(page1.includes(s), `page 1 shows ${JSON.stringify(s)}`);
  }
  assert.ok(page1.some((s) => s.includes('Team: Deansgate') && s.includes('1 – 21 Oct 2026') && s.includes('130 rows')), 'filter line with the row count');
  // cells as on screen
  for (const s of ['Mon 19 Oct 2026', 'Person 001', 'Field Representative', '1,000', '£1,234.50', '4.1%']) assert.ok(page1.includes(s), `cell ${s}`);
  assert.ok(all.includes('Person 130') && all.includes('£1,363.50'), 'the last row is there');
  // the header row on every page, the totals row on the last page only, the footer on every page
  pdf.text.forEach((t, i) => {
    assert.ok(t.includes('Week start') && t.includes('Conversion'), `header row on page ${i + 1}`);
    assert.ok(t.includes(`Page ${i + 1} of ${pdf.pages}`), `"Page ${i + 1} of ${pdf.pages}"`);
    assert.ok(t.includes('Linear Hub · Team pay'), `footer on page ${i + 1}`);
    if (i > 0) assert.ok(t.includes('Team pay'), `running header on page ${i + 1}`);
  });
  assert.equal(all.filter((s) => s === '£169,227.50').length, 1, 'the totals row is printed once');
  assert.ok(pdf.text[pdf.pages - 1]!.includes('£169,227.50'), 'on the last page');
  assert.equal(all.filter((s) => s === 'Generated Thu 22 Oct 2026, 15:04 by Danil Varianyk').length, 1, 'the brand band only on page 1');
  // only single-byte strings: jsPDF writes a string with any character above U+00FF as 16-bit gibberish
  assert.ok(!pdf.contents.some((c) => c.includes('\u0000')) && !all.some((s) => s.includes('\u0000')), 'no 16-bit strings');
  // metadata
  assert.match(pdf.raw, /\/Title \(Team pay\)/);
  assert.match(pdf.raw, /\/Creator \(Linear Hub\)/);
});

test('wide tables go landscape; unusual characters are folded, formulas guarded; an empty table says so', () => {
  const wide: CsvColumn<Record<string, string>>[] = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, header: `Column ${i + 1}` }));
  const doc = buildTablePdf(engine, {
    title: 'Gauges by person',
    columns: wide,
    rows: [{ c0: 'Łukasz Dąbrowski', c1: 'sales 3 → 4', c2: '+cmd|calc', c3: '−£12.00', c4: 'Great day 🎉', c5: 'a — b', c6: '+44 7700 900123', c7: '2026-10-21', c8: '' }],
    filename: 'linear-hub-gauges-by-user-2026-10-01_2026-10-21.csv',
    now: NOW,
  });
  const pdf = parsePdf(doc.bytes());
  assert.equal(pdf.pages, 1);
  assert.ok(near(pdf.mediaBoxes[0]!, [A4_PORTRAIT[1], A4_PORTRAIT[0]]), 'nine columns: A4 landscape');
  const t = pdf.text[0]!;
  for (const s of ['Lukasz Dabrowski', 'sales 3 -> 4', "'+cmd|calc", '-£12.00', 'Great day ?', 'a — b', '+44 7700 900123', 'Wed 21 Oct 2026', '1 row']) {
    assert.ok(t.some((x) => x.includes(s)), `shows ${JSON.stringify(s)}`);
  }
  assert.ok(!pdf.contents.some((c) => c.includes('\u0000')), 'no 16-bit strings');

  const empty = parsePdf(buildTablePdf(engine, { title: 'Expenses', columns: COLUMNS, rows: [], filename: 'x.csv', now: NOW }).bytes());
  assert.equal(empty.pages, 1);
  assert.ok(empty.text[0]!.includes('Nothing to show') && empty.text[0]!.some((s) => s.includes('0 rows')));
});

test('orientation can be forced', () => {
  const doc = buildTablePdf(engine, { title: 'Leaderboard', columns: COLUMNS.slice(0, 2), rows: payRows(2), filename: 'l.csv', orientation: 'landscape', now: NOW });
  assert.ok(near(parsePdf(doc.bytes()).mediaBoxes[0]!, [A4_PORTRAIT[1], A4_PORTRAIT[0]]));
});

// 1 × 1 transparent PNG
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('pdfDocument: the invoice building blocks (P2) make a valid A4 document, footers drawn once', () => {
  const doc = createPdfDoc(engine, { title: 'Self-billed invoice LM-SB-2026-000123', now: NOW })
    .header({ title: 'Self-billed invoice', subtitle: 'Week of Mon 12 – Sun 18 Oct 2026', meta: [['Invoice', 'LM-SB-2026-000123'], ['Issued', 'Mon 19 Oct 2026'], ['Due', 'Fri 23 Oct 2026']] })
    .addressBlocks(
      { heading: 'Supplier', name: 'Jordan Lee', lines: ['12 Example Street', 'Salford', 'M5 4AA'], extra: ['UTR 12345 67890', 'Not VAT registered'] },
      { heading: 'Customer', name: 'Linear MCR Limited', lines: ['1 North Parade, Parsonage Gardens', 'Manchester'], extra: ['Company number 12345678'] },
    )
    .heading('Lines')
    .lineTable(
      [
        { key: 'what', header: 'Description', width: 4 },
        { key: 'qty', header: 'Qty', align: 'right' },
        { key: 'rate', header: 'Rate', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', width: 1.4 },
      ],
      [
        { what: 'Commission · BCN · 16 subs paid (18 logged, 2 cancelled)', qty: '16', rate: '£10.00', amount: '£160.00', muted: true },
        { what: 'Base · 4 days × £63.50', qty: '4', rate: '£63.50', amount: '£254.00' },
        { what: 'Correction from w/c 5 Oct', qty: '', rate: '', amount: '-£20.00' },
      ],
    )
    .totals([
      { label: 'Subtotal', value: '£234.00' },
      { label: 'VAT', value: 'Not VAT registered' },
      { label: 'Total due', value: '£234.00', strong: true },
    ])
    .paragraph('Self-billed invoice issued by Linear MCR Limited on behalf of the supplier under a self-billing agreement.', { muted: true, size: 8.5 })
    .keyValues([['Payday', 'Fri 23 Oct 2026'], ['Reference', 'LM-SB-2026-000123']])
    .signatureBlock(
      { label: 'For Linear MCR Limited', name: 'Danil Varianyk', imageDataUrl: PNG_1PX },
      { label: 'Accepted by the supplier', name: 'Jordan Lee', note: 'Accepted electronically by Jordan Lee on Thu 22 Oct 2026, 14:05' },
    )
    .footer('Linear MCR Limited · Self-billed invoice LM-SB-2026-000123');
  const first = doc.bytes();
  const second = doc.bytes();
  assert.deepEqual(second, first, 'saving twice draws nothing twice and writes the same file');
  const pdf = parsePdf(first);
  assert.equal(pdf.pages, 1);
  assert.ok(near(pdf.mediaBoxes[0]!, A4_PORTRAIT));
  const t = pdf.text[0]!;
  for (const s of [
    'Self-billed invoice', 'Invoice', 'LM-SB-2026-000123', 'SUPPLIER', 'CUSTOMER', 'Jordan Lee', 'Linear MCR Limited', 'Not VAT registered',
    'Description', 'Base · 4 days × £63.50', '-£20.00', 'Total due', '£234.00', 'For Linear MCR Limited',
    'Accepted electronically by Jordan Lee on Thu 22 Oct 2026, 14:05', 'Page 1 of 1', 'Linear MCR Limited · Self-billed invoice LM-SB-2026-000123',
  ]) {
    assert.ok(t.some((x) => x === s || x.includes(s)), `shows ${JSON.stringify(s)}`);
  }
  assert.equal(t.filter((s) => s === 'Page 1 of 1').length, 1, 'one footer');
  assert.match(pdf.raw, /\/Subtype \/Image/, 'the signature image is embedded');
});

test('pdfDocument: long content flows onto new pages with the running header; a bad image is skipped', () => {
  const doc = createPdfDoc(engine, { title: 'Learning progress', now: NOW }).header({ title: 'Learning progress', subtitle: 'Jordan Lee' });
  for (let i = 0; i < 70; i++) doc.paragraph(`Paragraph ${i + 1}: every stop counts, and the law of averages says the stops come first.`);
  doc.pageBreak().heading('After the break').signatureBlock({ label: 'Signed', name: 'A', imageDataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' });
  const pdf = parsePdf(doc.bytes());
  assert.ok(pdf.pages >= 3, `${pdf.pages} pages`);
  pdf.text.forEach((t, i) => {
    assert.ok(t.includes(`Page ${i + 1} of ${pdf.pages}`));
    if (i > 0) assert.ok(t.includes('Learning progress'), 'running header');
  });
  assert.ok(pdf.text[pdf.pages - 1]!.includes('After the break'));
  assert.ok(pdf.text.flat().includes('Paragraph 70: every stop counts, and the law of averages says the stops come first.'));

  // needs(mm): a new page only when that much room is not left
  const kept = createPdfDoc(engine, { title: 'Kept', now: NOW }).header({ title: 'Kept' }).paragraph('First page.').needs(40).heading('Still page one').needs(260).heading('On page two');
  const k = parsePdf(kept.bytes());
  assert.equal(k.pages, 2);
  assert.ok(k.text[0]!.includes('Still page one') && k.text[1]!.includes('On page two'));
});

// ───────────────────────────── Review fixes (r3 P4) ─────────────────────────────

/** A document property as a reader shows it: a literal string, UTF-16BE when it starts with the byte-order mark. */
function infoString(raw: string, key: string): string | null {
  const m = new RegExp(`/${key} \\(((?:\\\\.|[^\\\\)])*)\\)`).exec(raw);
  if (!m) return null;
  const bytes = unescapePdfString(m[1]!);
  if (!bytes.startsWith('\xfe\xff')) return bytes;
  let out = '';
  for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return out;
}

test('a title with typographic marks: the footer keeps them, the document properties show the real characters', () => {
  const title = 'St Ann’s Square – events';
  const pdf = parsePdf(buildTablePdf(engine, { title, columns: COLUMNS, rows: payRows(3), filename: 'linear-hub-venue-st-ann-s-2026-10-21.csv', now: NOW }).bytes());
  const t = pdf.text[0]!;
  assert.ok(t.includes(title), 'the heading');
  assert.ok(t.includes(`Linear Hub · ${title}`), `the footer keeps ’ and – (got ${JSON.stringify(t.filter((x) => x.startsWith('Linear Hub ·')))})`);
  assert.equal(infoString(pdf.raw, 'Title'), title, 'the viewer title bar');
  assert.equal(infoString(pdf.raw, 'Subject'), title);

  // a page PDF without footer(): the same default footer; a name typed on an iPhone (’) and other alphabets
  const name = 'Łukasz O’Brien–Ștefan';
  const doc = parsePdf(createPdfDoc(engine, { title: `Learning progress · ${name}`, now: NOW }).header({ title: 'Learning progress', subtitle: name }).bytes());
  assert.ok(doc.text[0]!.includes('Linear Hub · Learning progress · Lukasz O’Brien–Stefan'), JSON.stringify(doc.text[0]));
  assert.equal(infoString(doc.raw, 'Title'), `Learning progress · ${name}`);
  // a plain Latin-1 title stays a plain string
  assert.match(parsePdf(buildTablePdf(engine, { title: 'Team pay', columns: COLUMNS, rows: [], filename: 'x.csv', now: NOW }).bytes()).raw, /\/Title \(Team pay\)/);
});

test('the printed PDF never starts a cell with a hidden formula: zero-width characters, BOM, minus signs', () => {
  const cols: CsvColumn<Record<string, string>>[] = [
    { key: 'a', header: 'A' },
    { key: 'b', header: 'B' },
    { key: 'c', header: 'C' },
    { key: 'd', header: 'D' },
  ];
  const rows = [{ a: '​=HYPERLINK("http://evil.example","click")', b: '﻿=1+1', c: '−2+3+cmd|calc', d: '−£12.50' }];
  const doc = buildTablePdf(engine, { title: 'Team directory', columns: cols, rows, filename: 'linear-hub-team-directory-all-2026-10-22.csv', now: NOW });
  const t = parsePdf(doc.bytes()).text.flat();
  for (const s of [`'=HYPERLINK("http://evil.example","click")`, `'=1+1`, `'-2+3+cmd|calc`, '-£12.50']) assert.ok(t.includes(s), `shows ${JSON.stringify(s)}`);
  assert.ok(!t.some((s) => /^[=+@]/.test(s) || /^-\d+\+/.test(s)), 'no cell starts with a formula');

  // the page blocks P2 / P7 / P8 use go through the same guard
  const page = createPdfDoc(engine, { title: 'Candidate profile', now: NOW })
    .header({ title: 'Candidate profile' })
    .keyValues([['Name', '⁠@SUM(A1:A9)']])
    .lineTable([{ key: 'q', header: 'Question' }, { key: 'a', header: 'Answer' }], [{ q: 'Why sales?', a: '­+cmd|x' }])
    .totals([{ label: 'Total', value: '​-1+cmd|x' }]);
  const pt = parsePdf(page.bytes()).text.flat();
  for (const s of [`'@SUM(A1:A9)`, `'+cmd|x`, `'-1+cmd|x`]) assert.ok(pt.includes(s), `shows ${JSON.stringify(s)}`);
});

// ───────────────────────────── Fix round (r3 I3): every drawn line is guarded ─────────────────────────────

/**
 * An independent check on what a page shows: a drawn line (one text-show operator) that a spreadsheet would run as a
 * formula if it were copied out — "=" or "@" first (after any spaces), or "+" / "-" followed by more than a plain
 * number, money or a phone number (those keep their sign).
 */
const runsAsFormula = (line: string) => {
  const t = line.replace(/^[\s\xa0]+/, '');
  return /^[=@]/.test(t) || (/^[+-]/.test(t) && !/^[+-][£$€]?[\d\s(),.%:/-]*$/.test(t));
};
function formulaLines(pdf: ParsedPdf): string[] {
  return pdf.text.flat().filter(runsAsFormula);
}

/** Text a person typed (notes, answers, names, addresses): a harmless first line, then a formula on the next one. */
const EVIL = [
  'Call back Monday\n=HYPERLINK("http://evil.example","Open CV")',
  "Worked at Tesco\n+cmd|' /C calc'!A0",
  'Fine\n@SUM(1+1)*cmd|x',
  'Shift notes\r\n-2+3+cmd|x',
  'Line\r\u200b=1+1',
  'Tab\n\t=cmd|x',
];
const FIRST = ['=HYPERLINK("http://evil.example","x")', '+cmd|calc', '@SUM(A1:A9)', '-1+cmd|x', '\u2212 2+cmd|x', '\uff1dSUM(A1)', '  =1+1'];
/** Many short formulas in a row: wherever the text wraps, the next line starts with one. */
const WRAPS = Array.from({ length: 40 }, () => '=1+1').join(' ');

test('every page block guards every line it draws: multi-line text, later lines, wrapped lines', () => {
  const doc = createPdfDoc(engine, { title: '=HYPERLINK("http://evil.example","title")', now: NOW })
    .header({
      title: FIRST[0]!,
      subtitle: EVIL[0]!,
      meta: [[FIRST[1]!, EVIL[1]!], ['Ref', FIRST[2]!]],
      filters: [FIRST[3]!, EVIL[2]!],
    })
    .addressBlocks(
      { heading: FIRST[4]!, name: EVIL[3]!, lines: [FIRST[5]!, EVIL[4]!], extra: [EVIL[5]!] },
      { heading: 'Customer', name: FIRST[6]!, lines: [EVIL[0]!], extra: [FIRST[0]!] },
    )
    .heading(FIRST[1]!)
    .heading(EVIL[1]!)
    .paragraph(FIRST[2]!)
    .paragraph(EVIL[2]!)
    .paragraph(WRAPS)
    .keyValues([[FIRST[3]!, EVIL[3]!], [EVIL[4]!, FIRST[4]!], ['Long', WRAPS]])
    .lineTable(
      [{ key: 'a', header: FIRST[5]!, width: 1 }, { key: 'b', header: 'Answer', width: 1 }, { key: 'c', header: 'Amount', align: 'right', width: 1 }],
      [
        { a: EVIL[5]!, b: EVIL[0]!, c: '-£20.00' },
        { a: FIRST[6]!, b: WRAPS, c: EVIL[1]! },
      ],
    )
    .table<{ x: string; y: string }>([{ key: 'x', header: FIRST[0]! }, { key: 'y', header: 'Y' }], [{ x: EVIL[2]!, y: WRAPS }, { x: FIRST[1]!, y: EVIL[3]! }])
    .totals([{ label: FIRST[2]!, value: EVIL[4]! }, { label: EVIL[5]!, value: FIRST[3]!, strong: true }])
    .signatureBlock({ label: FIRST[4]!, name: EVIL[0]!, note: EVIL[1]! }, { label: EVIL[2]!, name: FIRST[5]!, note: WRAPS })
    .pageBreak()
    .paragraph('Page two, under the running header.')
    .footer(FIRST[6]!);
  const pdf = parsePdf(doc.bytes());
  assert.ok(pdf.pages >= 2);
  assert.deepEqual(formulaLines(pdf), [], 'no drawn line runs as a formula');
  const all = pdf.text.flat();
  // the guard is an apostrophe in front, as the CSV does; the text is otherwise kept
  for (const s of [
    `'=HYPERLINK("http://evil.example","Open CV")`,
    "'+cmd|' /C calc'!A0",
    "'@SUM(1+1)*cmd|x",
    "'-2+3+cmd|x",
    "'=1+1",
    `'=HYPERLINK("http://evil.example","x")`,
    "'-1+cmd|x",
    "'=SUM(A1)",
    'Call back Monday',
    '-£20.00',
  ]) {
    assert.ok(all.some((t) => t === s || t.startsWith(s)), `shows ${JSON.stringify(s)}`);
  }
  // the wrapped runs: several lines, every one of them guarded
  assert.ok(all.filter((t) => t.startsWith("'=1+1 =1+1")).length >= 4, 'wrapped continuation lines carry the apostrophe');
});

test('a table PDF guards every line too: title, subtitle, filters, headers, multi-line and wrapped cells, totals', () => {
  const cols: CsvColumn<Record<string, string>>[] = [
    { key: 'a', header: FIRST[0]! },
    { key: 'b', header: 'Notes' },
    { key: 'c', header: 'Next action' },
  ];
  const rows = [
    { a: 'Jordan Lee', b: EVIL[0]!, c: EVIL[1]! },
    { a: EVIL[2]!, b: WRAPS, c: EVIL[3]! },
    { a: EVIL[4]!, b: EVIL[5]!, c: FIRST[4]! },
  ];
  const doc = buildTablePdf(engine, {
    title: FIRST[1]!,
    subtitle: EVIL[2]!,
    filters: [FIRST[2]!, EVIL[3]!],
    columns: cols,
    rows,
    totals: { b: EVIL[4]!, c: FIRST[3]! },
    filename: 'linear-hub-candidates-open-2026-10-22.csv',
    now: NOW,
  });
  const pdf = parsePdf(doc.bytes());
  assert.deepEqual(formulaLines(pdf), [], 'no drawn line runs as a formula');
  const all = pdf.text.flat();
  // (the narrow column wraps "+cmd|' /C calc'!A0" after "/C")
  for (const s of [`'=HYPERLINK("http://evil.example","Open CV")`, "'+cmd|' /C", "'@SUM(1+1)*cmd|x", "'-2+3+cmd|x", "' =cmd|x", "'+cmd|calc"]) {
    assert.ok(all.some((t) => t === s || t.startsWith(s)), `shows ${JSON.stringify(s)}`);
  }
  assert.ok(all.filter((t) => t.startsWith("'=1+1")).length >= 3, 'the wrapped cell: every line guarded');
  // a right-aligned guarded cell still ends at the column's right edge (the apostrophe is measured, not overhanging)
  assert.ok(all.includes('Call back Monday'));
});

test('audit PDF: who a row names, as the Audit page says it; how much of the trail the file holds', () => {
  type Who = Parameters<typeof auditPdfWho>[0];
  const row = (r: Partial<Who>): Who => ({ userName: null, kind: 'change', action: 'PATCH /users/:id', after: null, ...r }) as Who;
  assert.equal(auditPdfWho(row({ userName: 'Danil Varianyk' })), 'Danil Varianyk');
  // a failed try on the sign-in page is filed under the account, but whoever typed it may not be that person
  assert.equal(auditPdfWho(row({ userName: 'Jordan Lee', kind: 'sign_in', action: 'POST /auth/login', after: { reason: 'wrong_employee_id' } })), "Attempt on Jordan Lee's account");
  assert.equal(auditPdfWho(row({ kind: 'sign_in', action: 'POST /auth/login', after: { reason: 'unknown_email' } })), 'Unknown person');
  // a wrong current PIN in Settings is the signed-in person's own; an automatic step names Linear Hub
  assert.equal(auditPdfWho(row({ userName: 'Jordan Lee', kind: 'sign_in', action: 'POST /auth/pin/change', after: { reason: 'wrong_current_pin' } })), 'Jordan Lee');
  assert.equal(auditPdfWho(row({ kind: 'automatic', action: 'SYSTEM statement-fetched' })), 'Linear Hub');
  // coverage: everything (no line), the newest of many, the page on screen of a known total, and — without the
  // total — the page on screen, saying more may match
  assert.equal(auditCoverageLine(12, 12, false), null);
  assert.equal(auditCoverageLine(2000, 3400, true), 'The newest 2,000 of 3,400 matching entries');
  assert.equal(auditCoverageLine(50, 1234, false), 'The 50 entries on screen, of 1,234 that match');
  assert.equal(auditCoverageLine(50, undefined, false), 'The 50 entries on screen (more may match the filters)');
  assert.equal(auditCoverageLine(1, undefined, false), 'The 1 entry on screen (more may match the filters)');
  assert.equal(auditCoverageLine(0, undefined, false), null);
});

test('Cyrillic and Greek names print in Latin letters, not "?"', () => {
  const doc = parsePdf(
    buildTablePdf(engine, { title: 'Team directory', columns: COLUMNS.slice(0, 2), rows: [{ ...payRows(1)[0]!, userName: 'Иван Петров' }, { ...payRows(1)[0]!, userName: 'Γιώργος Παπαδόπουλος' }], filename: 'x.csv', now: NOW }).bytes(),
  );
  const t = doc.text.flat();
  assert.ok(t.includes('Ivan Petrov') && t.includes('Giorgos Papadopoulos'), JSON.stringify(t));
  // file names keep the letters too (lib/csv.ts slugify)
  assert.equal(csvFilename('learning-progress-Łukasz O’Brien–Ștefan 😀', '2026-10-21'), 'linear-hub-learning-progress-lukasz-o-brien-stefan-2026-10-21.csv');
  assert.equal(csvFilename('gauges-Иван Петров-entries', { from: '2026-10-01', to: '2026-10-21' }), 'linear-hub-gauges-ivan-petrov-entries-2026-10-01_2026-10-21.csv');
  assert.equal(csvFilename('team-directory-Straße', '2026-10-21'), 'linear-hub-team-directory-strasse-2026-10-21.csv');
});

test('progress PDF: required videos count only those that apply to the person (P5 shapes)', () => {
  // GET /videos/team as P5 serves it: three required videos, one of them for leaders only
  // (cast through unknown: the same fixture type-checks against today's types and P5's fuller ones)
  const view = {
    required: 3,
    videos: [
      { id: 3, title: 'Leading a morning huddle' },
      { id: 2, title: 'Handling “I already give”' },
      { id: 1, title: 'The first ten seconds' },
    ],
    rows: [
      { userId: 10, userName: 'Jordan Lee', watchedRequired: 2, watched: 4, requiredTotal: 2, cells: [{ videoId: 2, watchedS: 300, completedAt: '2026-10-19T10:00:00.000Z' }, { videoId: 1, watchedS: 200, completedAt: '2026-10-12T10:00:00.000Z' }] },
      { userId: 11, userName: 'Sam Reed', watchedRequired: 0, watched: 0, requiredTotal: 0, cells: [] },
      { userId: 2, userName: 'Amelia Hart', watchedRequired: 1, watched: 1, requiredTotal: 3, cells: [{ videoId: 3, watchedS: 0, completedAt: null }, { videoId: 2, watchedS: 90, completedAt: '2026-10-20T09:00:00.000Z' }, { videoId: 1, watchedS: 0, completedAt: null }] },
    ],
  } as unknown as TeamVideoView;
  const rep = teamRequiredVideos(view, 10)!;
  assert.deepEqual([rep.watched, rep.total], [2, 2], 'a rep: 2 of 2, not 2 of 3');
  assert.deepEqual(rep.lines.map((l) => l.title), ['Handling “I already give”', 'The first ten seconds']);
  assert.equal(teamRequiredVideos(view, 11), null, 'none apply: no section');
  assert.equal(teamRequiredVideos(view, 99), null, 'not in the view');
  assert.deepEqual([teamRequiredVideos(view, 2)!.watched, teamRequiredVideos(view, 2)!.total, teamRequiredVideos(view, 2)!.lines.length], [1, 3, 3]);
  // an older answer without requiredTotal or cells: the body's count, no lines
  const older = { required: 4, rows: [{ userId: 10, userName: 'Jordan Lee', watchedRequired: 1, watched: 1 }] } as unknown as TeamVideoView;
  assert.deepEqual(teamRequiredVideos(older, 10), { watched: 1, total: 4, lines: [] });

  // the own view (GET /videos): a leader sees the reps' videos too, but only what is required of them is listed
  const video = (id: number, audience: 'everyone' | 'leaders' | 'reps', required: boolean, done: string | null) =>
    ({ id, title: `Video ${id}`, required, audience, my: done ? { videoId: id, watchedS: 1, positionS: 0, completedAt: done, lastAt: done } : null }) as unknown as LearningVideo;
  const list = [video(1, 'everyone', true, '2026-10-12'), video(2, 'reps', true, null), video(3, 'leaders', true, null), video(4, 'everyone', false, null)];
  assert.deepEqual(ownRequiredVideos(list, 'leader')!.lines.map((l) => l.title), ['Video 1', 'Video 3']);
  assert.deepEqual(ownRequiredVideos(list, 'rep')!.lines.map((l) => l.title), ['Video 1', 'Video 2']);
  assert.deepEqual(ownRequiredVideos(list, 'recruiter')!.lines.map((l) => l.title), ['Video 1']);
  assert.deepEqual(ownRequiredVideos(list, 'admin')!.lines.map((l) => l.title), ['Video 1'], 'P5: leaders-only and reps-only videos are not required of the admin');
  assert.equal(ownRequiredVideos([video(4, 'everyone', false, null)], 'rep'), null);
  assert.equal(videoRequiredOf({ required: true, audience: 'everyone' }, 'client'), false);
});

// ───────────────────────────── The audit contract the exports rely on ─────────────────────────────

let srv: TestServer;
before(async () => {
  srv = await startTestServer();
});
after(async () => {
  await srv.close();
});

/** Exactly what ExportButton, AuditPdfButton and ProgressPdfButton send (client/src/features/pdf/report.ts). */
const EXPORT_EVENTS: ClientAuditEventInput[] = [
  { kind: 'export', format: 'csv', what: 'gauges-by-team', rows: 12, filename: 'linear-hub-gauges-by-team-2026-10-01_2026-10-21.csv' },
  { kind: 'export', format: 'pdf', what: 'gauges-by-team', rows: 12, filename: 'linear-hub-gauges-by-team-2026-10-01_2026-10-21.pdf' },
  { kind: 'export', format: 'pdf', what: 'audit-trail', rows: 50, filename: 'linear-hub-audit-trail-2026-10-22.pdf' },
  { kind: 'export', format: 'pdf', what: 'learning-progress', rows: 21, filename: 'linear-hub-learning-progress-jordan-lee-2026-10-22.pdf' },
];

test('POST /audit/events: every staff role may report an export (204); a client session 403; anonymous 401', async () => {
  for (const role of ['admin', 'leader', 'recruiter', 'rep'] as const) {
    const c = await srv.login(role);
    for (const ev of EXPORT_EVENTS) {
      const r = await c.post('/audit/events', ev);
      assert.equal(r.status, 204, `${role} ${ev.format} ${ev.what}: ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  const client = await srv.login('client');
  const denied = await client.post('/audit/events', EXPORT_EVENTS[0]);
  assert.equal(denied.status, 403);
  assert.equal(denied.json?.clientPortalOnly, true);
  const anon = await srv.anon().post('/audit/events', EXPORT_EVENTS[0]);
  assert.equal(anon.status, 401);
});
