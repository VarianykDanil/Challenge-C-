/**
 * Release 1.3 — OWNED BY P4 pdf-everywhere (laid down by r3-foundation). Pure helpers shared by the CSV and PDF exports
 * (unit-tested in exportFormat.test.ts; the PDF drawing itself is client/src/lib/pdf).
 *
 *  - Orientation: A4 portrait up to PDF_PORTRAIT_MAX_COLUMNS columns, landscape above.
 *  - Cells: a PDF shows exactly what the CSV holds, written the way the screen writes it — money "£1,234.50", dates
 *    "Wed 21 Oct 2026", times "21 Oct 2026, 09:30", counts "1,240" — and never text a spreadsheet would run as a
 *    formula if someone copies a table out of the PDF (the CSV rule: an apostrophe in front).
 *  - Text the standard PDF fonts can draw: jsPDF's built-in Helvetica speaks WinAnsi (Latin-1 plus a few typographic
 *    marks). Anything else would print the whole line as gibberish, so it is folded to the nearest letter first.
 *  - Titles: a PDF made from an existing CSV button gets its title and filter lines from the CSV file name.
 */
import { DASHBOARD_RANGE_LABELS } from '../constants.ts';
import { COMBINING, PDF_FOLDS, SPACE_LIKE, TRANSLIT, ZERO_WIDTH, bareLetter, greekOu } from './textFold.ts';

export { asciiFold } from './textFold.ts';

/** Tables wider than this many columns are laid out on A4 landscape. */
export const PDF_PORTRAIT_MAX_COLUMNS = 6;

export type PdfOrientation = 'portrait' | 'landscape';

/** A4 portrait up to PDF_PORTRAIT_MAX_COLUMNS columns, landscape above. */
export function pdfOrientationFor(columnCount: number): PdfOrientation {
  return columnCount > PDF_PORTRAIT_MAX_COLUMNS ? 'landscape' : 'portrait';
}

/**
 * How a PDF cell is written. 'text' (default) also turns a bare ISO date ("2026-10-21") or CSV timestamp
 * ("2026-10-21 09:30") into the screen's wording, so date columns read right without being declared.
 */
export type PdfCellKind = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'percent';

// ───────────────────────────── Characters the standard PDF fonts can draw ─────────────────────────────

/**
 * Unicode marks the WinAnsi encoding of the standard fonts holds in bytes 0x80–0x9F (en and em dash, ellipsis, curly
 * quotes, bullet, euro…). jsPDF writes a string byte for byte, so these are passed as those bytes.
 */
export const PDF_WINANSI_EXTRAS: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

/** One code point as WinAnsi text: kept, mapped to its 0x80–0x9F byte, folded, stripped of accents, spelled in Latin, or "?". */
function winAnsiChar(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code === 0x0a) return '\n';
  if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return ''; // control characters
  if (code <= 0xff) return ch;
  const byte = PDF_WINANSI_EXTRAS[code];
  if (byte !== undefined) return String.fromCharCode(byte);
  const fold = PDF_FOLDS[ch] ?? TRANSLIT[ch];
  if (fold !== undefined) return [...fold].map(winAnsiChar).join('');
  const bare = bareLetter(ch, (c) => c <= 0xff || PDF_WINANSI_EXTRAS[c] !== undefined);
  if (bare) return [...bare].map(winAnsiChar).join('');
  const translit = TRANSLIT[ch.normalize('NFKD').replace(COMBINING, '')];
  return translit !== undefined ? translit : '?';
}

/**
 * Text the standard PDF fonts can draw: Latin-1 as it is, the WinAnsi typographic marks as their bytes, other letters
 * without their accents ("Łukasz" → "Lukasz", "Ș" → "S"), Cyrillic and Greek spelled in Latin ("Иван" → "Ivan"),
 * symbols folded ("→" → "->", "−" → "-"), unusual spaces as a space, zero-width and control characters dropped, tabs
 * as a space, CR/LF as "\n", and anything else as "?".
 */
export function toPdfText(text: string): string {
  const flat = greekOu(String(text ?? '').normalize('NFC'))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(SPACE_LIKE, ' ')
    .replace(ZERO_WIDTH, '');
  let out = '';
  for (const ch of flat) out += winAnsiChar(ch);
  return out;
}

/**
 * A document property (the PDF's title and subject, shown in the viewer's title bar and tab): the real characters
 * — jsPDF writes any text above Latin-1 as UTF-16 with a byte-order mark, which every reader shows correctly —
 * without control or zero-width characters, and with every run of spaces (a no-break space included: it would read
 * as "€" in PDFDocEncoding) as one space. The page text itself goes through toPdfText.
 */
export function pdfInfoText(text: string): string {
  return String(text ?? '')
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First characters a spreadsheet treats as the start of a formula (as lib/csv.ts csvEscape). */
const FORMULA_START = /^[=+\-@\t\r]/;
/**
 * Text made only of digits, signs, currency, separators and spaces ("+44 7700 900123", "-£12.50", "-3", "12:30")
 * cannot call anything, so it keeps its sign; a formula needs letters or symbols beyond these.
 */
const INERT_NUMBERISH = /^[+\-]?[£$€]?[\d\s(),.%:/\-]*\d[\d\s(),.%:/\-]*$/;

/** Text a spreadsheet would run as a formula: a formula character first, and more than a plain number after it. */
const looksLikeFormula = (t: string) => FORMULA_START.test(t) && !INERT_NUMBERISH.test(t);

/**
 * A cell's text, safe and drawable: toPdfText first, then a value a spreadsheet would run as a formula
 * ("=HYPERLINK(…)", "+cmd|…", "@SUM(…)", "-2+3+cmd|…") gets an apostrophe in front, exactly as the CSV does.
 * The guard looks at the text as PRINTED (and with leading spaces taken off), so a zero-width character, a BOM or a
 * soft hyphen in front, a minus sign "−" or a full-width "＝" cannot carry a formula past it. Numbers, money and phone
 * numbers keep their sign, whichever minus they were written with.
 */
export function pdfSafeText(text: string): string {
  const raw = String(text ?? '');
  const printed = toPdfText(raw);
  const guard = looksLikeFormula(raw) || looksLikeFormula(printed) || looksLikeFormula(printed.replace(/^[\s\u00a0]+/, ''));
  return guard ? `'${printed}` : printed;
}

// ───────────────────────────── Numbers, money and dates as on screen ─────────────────────────────

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 20 });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A wall-clock moment as the CSV writes it ("2026-10-21 09:30") or as stored without a zone ("2026-10-21T09:30:00"). */
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Money as on screen: "£1,234.50", "-£12.50"; '' when not a number. */
export function pdfMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const v = Math.round(value * 100) / 100;
  return GBP.format(v === 0 ? 0 : v);
}

/** A count as on screen: "1,240"; decimals kept as given ("2.50" stays "2.50"); '' when not a number. */
export function pdfNumber(value: number | string | null | undefined): string {
  if (typeof value === 'number') return Number.isFinite(value) ? COUNT.format(value) : '';
  if (typeof value !== 'string' || !PLAIN_NUMBER.test(value)) return typeof value === 'string' ? value : '';
  const neg = value.startsWith('-');
  const [whole, frac] = (neg ? value.slice(1) : value).split('.');
  return `${neg ? '-' : ''}${COUNT.format(Number(whole))}${frac !== undefined ? `.${frac}` : ''}`;
}

function parseIsoDate(iso: string): { y: number; m: number; d: number; dow: number } | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return { y, m: mo, d, dow: back.getUTCDay() };
}

/** A date as on screen: "Wed 21 Oct 2026" (formatDate); '' when not a YYYY-MM-DD date. */
export function pdfDate(iso: string | null | undefined): string {
  const p = typeof iso === 'string' ? parseIsoDate(iso.slice(0, 10)) : null;
  return p && (iso!.length === 10 || iso![10] === 'T' || iso![10] === ' ') ? `${DOW[p.dow]} ${p.d} ${MON[p.m - 1]} ${p.y}` : '';
}

/** "21 Oct 2026" — the date without the weekday (dense tables, ranges). */
export function pdfDateShort(iso: string | null | undefined): string {
  const p = typeof iso === 'string' ? parseIsoDate(iso.slice(0, 10)) : null;
  return p ? `${p.d} ${MON[p.m - 1]} ${p.y}` : '';
}

/**
 * A wall-clock moment as on screen (formatDateTime): "21 Oct 2026, 09:30" from "2026-10-21 09:30" (the CSV's local
 * time) or "2026-10-21T09:30:00". A zoned timestamp is the caller's to convert to local time first. '' otherwise.
 */
export function pdfDateTime(value: string | null | undefined): string {
  const m = typeof value === 'string' ? WALL_CLOCK.exec(value) : null;
  if (!m) return '';
  const day = pdfDateShort(m[1]!);
  return day ? `${day}, ${m[2]}:${m[3]}` : '';
}

/** A range as on screen (formatRangeLabel): "1 – 21 Oct 2026", "28 Sep – 4 Oct 2026", "28 Dec 2026 – 3 Jan 2027". */
export function pdfDateRange(from: string, to: string): string {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) return `${from} – ${to}`;
  if (from === to) return pdfDate(from);
  if (a.y !== b.y) return `${a.d} ${MON[a.m - 1]} ${a.y} – ${b.d} ${MON[b.m - 1]} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${MON[a.m - 1]} – ${b.d} ${MON[b.m - 1]} ${b.y}`;
  return `${a.d} – ${b.d} ${MON[b.m - 1]} ${b.y}`;
}

/** "Page 2 of 5". */
export function pdfPageLabel(page: number, pages: number): string {
  return `Page ${page} of ${pages}`;
}

/**
 * One CSV cell (the text the CSV holds) written the way the screen writes it, safe and drawable:
 * money "1234.50" → "£1,234.50"; number "1240" → "1,240"; date "2026-10-21" → "Wed 21 Oct 2026"; datetime
 * "2026-10-21 09:30" → "21 Oct 2026, 09:30"; percent as it is. Text that is a bare ISO date or CSV timestamp is
 * written as one too; everything else goes through pdfSafeText. Empty stays empty.
 */
export function pdfCellText(csvText: string, kind: PdfCellKind = 'text'): string {
  const s = String(csvText ?? '');
  if (s === '') return '';
  switch (kind) {
    case 'money':
      return PLAIN_NUMBER.test(s) ? pdfMoney(Number(s)) : pdfSafeText(s);
    case 'number':
      return PLAIN_NUMBER.test(s) ? pdfNumber(s) : pdfSafeText(s);
    case 'date':
      return pdfDate(s) || pdfDateTime(s) || pdfSafeText(s);
    case 'datetime':
      return pdfDateTime(s) || pdfDate(s) || pdfSafeText(s);
    case 'percent':
      return pdfSafeText(s);
    default:
      if (ISO_DATE.test(s)) return pdfDate(s) || pdfSafeText(s);
      if (WALL_CLOCK.test(s)) return pdfDateTime(s) || pdfSafeText(s);
      return pdfSafeText(s);
  }
}

/** A cell that reads as a number on screen ("1,240", "£945.00", "-£12.50", "12.3%", "2.5"): right-aligned. */
const NUMERIC_CELL = /^[+\-]?[£$€]?\d[\d,]*(\.\d+)?%?$/;
export function isNumericCell(text: string): boolean {
  return NUMERIC_CELL.test(String(text ?? '').trim());
}

/**
 * Right-align a column when every cell with a value reads as a number (and at least one does). "—" and empty
 * cells do not count either way.
 */
export function isNumericColumn(cells: readonly string[]): boolean {
  let seen = false;
  for (const raw of cells) {
    const c = String(raw ?? '').trim();
    if (c === '' || c === '—' || c === '\x97') continue;
    if (!isNumericCell(c)) return false;
    seen = true;
  }
  return seen;
}

// ───────────────────────────── Titles from the CSV file name ─────────────────────────────

const STAMP = /-(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?$/;
const PRODUCT_PREFIX = 'linear-hub-';

/** "linear-hub-gauges-by-team-2026-10-01_2026-10-21.csv" → { section: 'gauges-by-team', from, to }. */
export function parseExportFilename(filename: string): { section: string; from: string | null; to: string | null } {
  let base = String(filename ?? '').split(/[\\/]/).pop() ?? '';
  base = base.replace(/\.(csv|pdf)$/i, '');
  if (base.startsWith(PRODUCT_PREFIX)) base = base.slice(PRODUCT_PREFIX.length);
  const m = STAMP.exec(base);
  if (!m) return { section: base, from: null, to: null };
  return { section: base.slice(0, m.index), from: m[1]!, to: m[2] ?? m[1]! };
}

/** The PDF file name for a CSV file name: the same name ending in ".pdf". */
export function pdfFilenameFor(filename: string): string {
  const base = String(filename ?? '').replace(/\.(csv|pdf)$/i, '');
  return `${base || 'linear-hub-export'}.pdf`;
}

/**
 * What the audit trail calls an export (ClientAuditEventInput.what): the file name's section, e.g.
 * "gauges-by-team-deansgate" for "linear-hub-gauges-by-team-deansgate-2026-10-01_2026-10-21.csv"; at most 80
 * characters of a–z, 0–9 and hyphens.
 */
export function exportWhatFor(filename: string): string {
  const slug = parseExportFilename(filename).section.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (slug || 'export').slice(0, 80).replace(/-$/, '');
}

/** "deansgate-north" → "Deansgate North" (names come through the file name in lower case). */
function nameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** "weekly-money-flow" → "Weekly money flow". */
function sentenceFromSlug(slug: string): string {
  const s = slug.split('-').filter(Boolean).join(' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

const GROUP_TITLES: Record<string, string> = { user: 'person', team: 'team', campaign: 'campaign', day: 'day', week: 'week' };
const FIXED_TITLES: Record<string, string> = {
  payslips: 'Payslips',
  'team-pay': 'Team pay',
  'weekly-money-flow': 'Weekly money flow',
  'finance-by-campaign': 'Finance by campaign',
  'runs-to-pay': 'Runs to pay',
  expenses: 'Expenses',
  hired: 'Hired candidates',
  'audit-trail': 'Audit trail',
  'learning-progress': 'Learning progress',
};

interface TitleParts {
  title: string;
  /** [label, value] — the value is compared with the page heading so a name is not printed twice. */
  filters: [label: string | null, value: string][];
}

function titlePartsFor(section: string): TitleParts {
  const fixed = FIXED_TITLES[section];
  if (fixed) return { title: fixed, filters: [] };
  let m = /^leaderboard-(week|month|quarter)-(sales|conversion)$/.exec(section);
  if (m) return { title: 'Leaderboard', filters: [[null, DASHBOARD_RANGE_LABELS[m[1] as 'week']], [null, `Ranked by ${m[2]}`]] };
  m = /^gauges-by-(user|team|campaign|day|week)(?:-(.+))?$/.exec(section);
  if (m) return { title: `Gauges by ${GROUP_TITLES[m[1]!]}`, filters: m[2] ? [['Team', nameFromSlug(m[2])]] : [] };
  m = /^gauges-(.+)-(entries|by-campaign)$/.exec(section);
  if (m) {
    const person: TitleParts['filters'] = m[1] === 'me' ? [] : [['Person', nameFromSlug(m[1]!)]];
    return { title: m[2] === 'entries' ? 'Gauge entries' : 'Gauges by campaign', filters: person };
  }
  m = /^team-directory-(.+)$/.exec(section);
  if (m) return { title: 'Team directory', filters: m[1] === 'all' ? [[null, 'Everyone']] : [['Status', sentenceFromSlug(m[1]!)]] };
  m = /^campaigns-(all|active|inactive)$/.exec(section);
  if (m) return { title: 'Campaigns', filters: m[1] === 'all' ? [[null, 'All campaigns']] : [['Status', sentenceFromSlug(m[1]!)]] };
  m = /^candidates-(open|all)$/.exec(section);
  if (m) return { title: 'Candidates', filters: [[null, m[1] === 'open' ? 'Open candidates' : 'All candidates, closed included']] };
  m = /^event-(.+)$/.exec(section);
  if (m) return { title: 'Event gauges', filters: [['Event', nameFromSlug(m[1]!)]] };
  return { title: sentenceFromSlug(section) || 'Export', filters: [] };
}

const slugKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(COMBINING, '').replace(/[^a-z0-9]+/g, '');

/** "Team: Deansgate" → "Team"; null for a line without a label ("Everyone", a date range). */
function filterLabel(line: string): string | null {
  return /^([^:]{1,40}):\s/.exec(line)?.[1]?.trim().toLowerCase() ?? null;
}

/**
 * The heading of a table PDF made from a CSV button: the title from the file name's section, the page heading as the
 * subtitle (exactly as on screen, e.g. "Jordan Lee" or "Finance", left out when the title already says it), and filter
 * lines (a name the subtitle already shows is not repeated; the date range as on screen; a single date that is just
 * today's file stamp is left out — "Generated" shows it).
 *
 * `screenFilters` are the filters set on screen beside the button ("Team: Deansgate North", "Search: “jo”"): they are
 * printed too, and a line from the file name with the same label ("Team: St Ann S", from a slug) gives way to the
 * screen's exact wording. The date range stays last; the same line is printed once.
 */
export function pdfHeadingFor(input: { filename: string; pageHeading?: string | null; today?: string; screenFilters?: readonly string[] }): { title: string; subtitle?: string; filters: string[] } {
  const { section, from, to } = parseExportFilename(input.filename);
  const parts = titlePartsFor(section);
  const heading = (input.pageHeading ?? '').replace(/\s+/g, ' ').trim();
  const titleKey = slugKey(parts.title);
  const headingKey = slugKey(heading);
  // "Gauges" over "Gauge entries", "Team" over "Team directory": the page name the title already says
  const stem = (s: string) => slugKey(s.split(' ')[0] ?? '').replace(/s$/, '');
  const saysIt = titleKey.startsWith(headingKey) || (!heading.includes(' ') && stem(heading) === stem(parts.title));
  const subtitle = heading && headingKey && !saysIt ? heading : undefined;
  const screen = (input.screenFilters ?? []).map((l) => String(l ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const screenLabels = new Set(screen.map(filterLabel).filter((l): l is string => l !== null));
  const fromFile = parts.filters
    .filter(([, value]) => !subtitle || slugKey(value) !== headingKey)
    .filter(([label]) => !label || !screenLabels.has(label.toLowerCase()))
    .map(([label, value]) => (label ? `${label}: ${value}` : value));
  const filters = [...new Set([...fromFile, ...screen])];
  if (from && to && !(from === to && from === input.today)) filters.push(pdfDateRange(from, to));
  return subtitle ? { title: parts.title, subtitle, filters } : { title: parts.title, filters };
}

/** "Generated Thu 22 Oct 2026, 15:04" from the device's local clock (an export is stamped when it is made). */
export function pdfGeneratedLine(now: Date, by?: string | null): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${DOW[now.getDay()]} ${now.getDate()} ${MON[now.getMonth()]} ${now.getFullYear()}, ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return by ? `Generated ${stamp} by ${by}` : `Generated ${stamp}`;
}
