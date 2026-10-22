/**
 * Release 1.3 — OWNED BY P3 statements (laid down by r3-foundation). Pure statement-reading rules, shared by the server
 * (which reads the PDFs) and the client (labels, the column picker):
 *
 *  1. statementLines(items): the PDF's positioned text (pdfjs items: string, x, y, width, height, page) → lines of cells,
 *     top to bottom. Items on the same baseline form a line; a gap wider than about half the font size starts a new cell.
 *  2. findStatementTable(lines): the header line is the first line with the most header words (at least a name or ID
 *     column and a count, date, status or amount column); a header split over two lines is joined; each later line is
 *     cut into the header's columns (by horizontal overlap); repeated headers on later pages re-anchor the columns; a
 *     "Total" line ends the table and is kept to check the sum.
 *  3. detectStatementColumns(headers, sample?): which column holds the fundraiser ID, name, sign-ups, confirmed (paid)
 *     subs, cancelled, amount, date, status, period — from the header words (and, given sample rows, a "Paid" column
 *     whose cells are money is the amount, not a count).
 *  4. statementRowsFromTable(table, mapping): rows → per-fundraiser drafts. Totals layout (a row per fundraiser):
 *     confirmed = the paid count, else sign-ups − cancelled. Per-sub layout (a row per sign-up with its date and status):
 *     confirmed 1 unless the status reads as cancelled.
 *  5. parseStatementPeriod(texts): "Period: 05/10/2026 to 11/10/2026", "Week ending 11 October 2026", "w/c 5 Oct 2026",
 *     "1–31 October 2026", "Statement for October 2026"…
 *  6. allocateConfirmedToWeeks(weeks, confirmed): a period total spread over its pay weeks — every week keeps what was
 *     logged, cancellations come off the LATEST week first (then the one before), extra confirmed subs go on the latest.
 *  7. matchPersonByName(name, people): the exact full name ("Lee, Jordan" too), only when exactly one person has it.
 * The PDF text extraction (pdfjs-dist) and the mail source (imapflow, mailparser) stay on the server.
 */
import type { StatementColumnMapping, StatementLayout, StatementRowMatch, StatementStatus } from '../types/statements.ts';
import { STATEMENT_MAX_PERIOD_DAYS } from '../types/statements.ts';
import { addDays, daysBetween, endOfMonthISO, isValidISODate, startOfWeekISO } from './dates.ts';

/** Header words P3's detector looks for (lower case). */
export const STATEMENT_HEADER_KEYWORDS = ['name', 'fundraiser', 'id', 'sign-ups', 'signups', 'subs', 'successful', 'cancelled', 'paid', 'amount', 'period', 'date'] as const;

export type StatementField = keyof StatementColumnMapping;

/** Every field of a column mapping, in the order the column picker shows them. */
export const STATEMENT_FIELDS: readonly StatementField[] = ['ref', 'name', 'gross', 'confirmed', 'cancelled', 'amount', 'date', 'status', 'period'];

export const STATEMENT_FIELD_LABELS: Record<StatementField, string> = {
  ref: 'Fundraiser ID',
  name: 'Fundraiser name',
  gross: 'Sign-ups (before cancellations)',
  confirmed: 'Confirmed (paid) subs',
  cancelled: 'Cancelled',
  amount: 'Amount (£)',
  date: 'Sign-up date',
  status: 'Status',
  period: 'Period',
};

export const STATEMENT_STATUS_LABELS: Record<StatementStatus, string> = {
  parsed: 'Ready to apply',
  needs_review: 'Needs review',
  applied: 'Applied',
  failed: "Couldn't read",
};

export const STATEMENT_ROW_MATCH_LABELS: Record<StatementRowMatch, string> = {
  auto: 'Matched',
  manual: 'Picked',
  none: 'Not matched',
};

/** A name compared for matching: lower case, single spaces, no punctuation ("O'Brien,  Sam" → "obrien sam"). */
export function normalisePersonName(name: string): string {
  return name.toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The keys a statement's name may match: "Jordan Lee" → ["jordan lee"]; "Lee, Jordan" → ["lee jordan", "jordan lee"]. */
export function personNameKeys(name: string): string[] {
  const keys = [normalisePersonName(name)];
  const comma = name.indexOf(',');
  if (comma > 0) {
    const swapped = normalisePersonName(`${name.slice(comma + 1)} ${name.slice(0, comma)}`);
    if (swapped && !keys.includes(swapped)) keys.push(swapped);
  }
  return keys.filter(Boolean);
}

export interface NamedPerson {
  id: number;
  firstName: string;
  lastName: string;
}

/** The one person whose full name is exactly this name (case and punctuation aside); null when none or several. */
export function matchPersonByName(name: string | null | undefined, people: readonly NamedPerson[]): number | null {
  if (!name) return null;
  const keys = new Set(personNameKeys(name));
  if (!keys.size) return null;
  const hits = people.filter((p) => keys.has(normalisePersonName(`${p.firstName} ${p.lastName}`)));
  const ids = [...new Set(hits.map((p) => p.id))];
  return ids.length === 1 ? ids[0]! : null;
}

// ───────────────────────────── positioned text → lines ─────────────────────────────

/** One positioned piece of text from the PDF (pdfjs getTextContent; y grows upwards, as in PDF space). */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface StatementCell {
  text: string;
  x0: number;
  x1: number;
}

export interface StatementLine {
  page: number;
  /** Baseline (PDF space: larger is higher on the page). */
  y: number;
  /** Font size of the line's tallest item. */
  height: number;
  cells: StatementCell[];
  /** The cells joined with two spaces. */
  text: string;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Positioned items → lines (top to bottom, page by page), each cut into cells at the wide gaps. */
export function statementLines(items: readonly PdfTextItem[]): StatementLine[] {
  const usable = items
    .filter((i) => i.str.trim() !== '' && Number.isFinite(i.x) && Number.isFinite(i.y))
    .map((i) => ({ ...i, height: i.height > 0 ? i.height : 10, width: Math.max(0, i.width) }))
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const groups: (typeof usable)[] = [];
  for (const item of usable) {
    const g = groups[groups.length - 1];
    const first = g?.[0];
    if (g && first && first.page === item.page && Math.abs(first.y - item.y) <= Math.max(1.5, 0.35 * Math.max(first.height, item.height))) g.push(item);
    else groups.push([item]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const height = Math.max(...g.map((i) => i.height));
    const cells: StatementCell[] = [];
    let cur: { parts: string[]; x0: number; x1: number } | null = null;
    for (const item of g) {
      const text = item.str.replace(/\s+/g, ' ');
      const x1 = item.x + item.width;
      if (cur && item.x - cur.x1 <= Math.max(2.5, 0.5 * item.height)) {
        const gap = item.x - cur.x1;
        cur.parts.push(gap > 0.15 * item.height && !/\s$/.test(cur.parts[cur.parts.length - 1] ?? '') && !/^\s/.test(text) ? ` ${text}` : text);
        cur.x1 = Math.max(cur.x1, x1);
      } else {
        if (cur) cells.push({ text: tidy(cur.parts.join('')), x0: cur.x0, x1: cur.x1 });
        cur = { parts: [text], x0: item.x, x1 };
      }
    }
    if (cur) cells.push({ text: tidy(cur.parts.join('')), x0: cur.x0, x1: cur.x1 });
    const kept = cells.filter((c) => c.text);
    return { page: g[0]!.page, y: g[0]!.y, height, cells: kept, text: kept.map((c) => c.text).join('  ') };
  });
}

// ───────────────────────────── header words → fields ─────────────────────────────

const headerText = (s: string) => s.toLowerCase().replace(/[‐‑–—]/g, '-').replace(/[^a-z0-9£/%\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
const PERSON_WORD = /\b(fundraisers?|agents?|reps?|representatives?|collectors?|staff|employees?|recruiters?|canvassers?|fr)\b/;
const NOT_OURS_WORD = /\b(donors?|supporters?|subscribers?|members?|customers?|campaigns?|clients?|charity|transactions?|sales?|sub|subs|sign-?ups?|signups?|mandates?|pledges?|ddi|accounts?|policy|contracts?)\b/;

/** What one header cell is about (null: a column the statement reader does not need). */
export function statementHeaderField(text: string): StatementField | null {
  const t = headerText(text);
  if (!t) return null;
  if (/\b(period|week ending|week ended|week commencing|week beginning|w\/c|w\/e|month|statement week)\b/.test(t)) return 'period';
  if (/\b(date|dated|signed up on|sign-?up day|joined|day)\b/.test(t)) return 'date';
  if (/\b(status|outcome|result|state)\b/.test(t)) return 'status';
  const cancelWord = /\b(cancel+ed|cancel+ations?|cancels|lapsed|lapses|attrition|refunded|refunds?|declined|failed|reversed|reversals?|clawbacks?|chargebacks?|not paid|unpaid|rejected|voided?|withdrawn)\b/.test(t);
  if (/£|\b(amount|commission|value|payments?|payable £|fees?|earnings|total due|due|gbp)\b/.test(t)) return cancelWord ? null : 'amount';
  if (cancelWord) return 'cancelled';
  if (/\b(paid|successful|success|confirmed|valid|approved|accepted|net|qualifying|eligible|active|retained|live)\b/.test(t)) return 'confirmed';
  if (/\b(ref|reference|id|no|number|code|badge|payroll|employee no)\b/.test(t)) {
    if (PERSON_WORD.test(t)) return 'ref';
    if (NOT_OURS_WORD.test(t)) return null;
    return /^(id|ref|reference|no|number|code|badge|badge no|payroll no)$/.test(t) ? 'ref' : null;
  }
  if (/\bname\b/.test(t)) return /\b(donors?|supporters?|campaigns?|clients?|charity|customers?|company|venue|site|location)\b/.test(t) ? null : 'name';
  if (/^(fundraisers?|agents?|reps?|collectors?|staff|staff member|canvassers?|recruiters?)$/.test(t)) return 'name';
  if (/\b(sign-?ups?|signups?|subs|sales|donors|recruits|registrations|gross|submitted|acquisitions|new donors|pledges)\b/.test(t)) return 'gross';
  return null;
}

const looksLikeMoney = (s: string) => /£/.test(s) || /^-?\(?\s*\d{1,3}(,\d{3})*\.\d{2}\)?$/.test(s.trim());

/**
 * Which column holds what, from the header cells (the first column wins for each field). With sample body rows, a
 * count column whose cells are money ("£160.00") is taken as the amount instead.
 */
export function detectStatementColumns(headers: readonly string[], sample?: readonly (readonly string[])[]): StatementColumnMapping {
  const out: StatementColumnMapping = {};
  headers.forEach((h, i) => {
    let field = statementHeaderField(h);
    if (field && (field === 'confirmed' || field === 'gross') && sample?.length) {
      const cells = sample.map((r) => (r[i] ?? '').trim()).filter(Boolean);
      if (cells.length && cells.filter(looksLikeMoney).length > cells.length / 2) field = 'amount';
    }
    if (field && out[field] === undefined) out[field] = i;
  });
  return out;
}

/** How many header fields a line holds (distinct), and whether it reads as a table header. */
function headerScore(line: StatementLine): { score: number; header: boolean; fields: (StatementField | null)[] } {
  const fields = line.cells.map((c) => statementHeaderField(c.text));
  const set = new Set(fields.filter((f): f is StatementField => f !== null));
  const who = set.has('name') || set.has('ref');
  const what = set.has('gross') || set.has('confirmed') || set.has('cancelled') || set.has('date') || set.has('status') || set.has('amount');
  const numbers = line.cells.filter((c) => /^\(?-?[£\d][\d,.]*\)?$/.test(c.text)).length;
  return { score: set.size, header: who && what && set.size >= 2 && numbers === 0, fields };
}

// ───────────────────────────── lines → table ─────────────────────────────

export interface StatementTableRead {
  headers: string[];
  rows: string[][];
  /** The "Total" line's cells in the header's columns, when the statement has one. */
  totals: string[] | null;
  /** Every line's text before the table (titles, the period, the client's name). */
  preamble: string[];
}

interface Column {
  x0: number;
  x1: number;
}

/** Column ranges from the header cells: each column reaches halfway into the gap to its neighbours. */
function columnRanges(cells: readonly StatementCell[]): Column[] {
  return cells.map((c, i) => {
    const prev = cells[i - 1];
    const next = cells[i + 1];
    return { x0: prev ? (prev.x1 + c.x0) / 2 : -Infinity, x1: next ? (c.x1 + next.x0) / 2 : Infinity };
  });
}

/** A line's cells placed in the columns (by the widest horizontal overlap); two cells in one column are joined. */
function placeCells(line: StatementLine, cols: readonly Column[]): string[] {
  const out: string[] = cols.map(() => '');
  for (const cell of line.cells) {
    let best = -1;
    let bestOverlap = -Infinity;
    cols.forEach((col, i) => {
      const overlap = Math.min(cell.x1, col.x1) - Math.max(cell.x0, col.x0);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    });
    if (best >= 0) out[best] = out[best] ? `${out[best]} ${cell.text}` : cell.text;
  }
  return out;
}

/** Joins a header split over two lines ("Successful" above "sign-ups") into one header row. */
function mergedHeader(lines: readonly StatementLine[], at: number): { cells: StatementCell[]; next: number } {
  const head = lines[at]!;
  let cells = head.cells.map((c) => ({ ...c }));
  let next = at + 1;
  const below = lines[next];
  if (below && below.page === head.page && head.y - below.y <= 1.8 * head.height && !below.cells.some((c) => /\d/.test(c.text))) {
    const cols = columnRanges(cells);
    const placed = placeCells(below, cols);
    const fits = below.cells.every((c) => cols.some((col) => c.x0 < col.x1 && c.x1 > col.x0));
    if (fits && placed.some(Boolean)) {
      cells = cells.map((c, i) => (placed[i] ? { ...c, text: `${c.text} ${placed[i]}` } : c));
      next++;
    }
  }
  return { cells, next };
}

const PAGE_FOOTER = /^(page\s+)?\d+\s*(of|\/)\s*\d+$|^page\s+\d+$/i;

const isTotalLine = (cells: readonly string[]) => {
  const first = cells.find((c) => c.trim());
  return Boolean(first && /^(grand\s+)?totals?\b/i.test(first.trim()));
};

/** The statement's table: the header, the body rows (as cells in the header's columns) and the "Total" line. */
export function findStatementTable(lines: readonly StatementLine[]): StatementTableRead | null {
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const s = headerScore(line);
    if (s.header && s.score > bestScore) {
      best = i;
      bestScore = s.score;
    }
  });
  if (best < 0) return null;
  const first = mergedHeader(lines, best);
  const headers = first.cells.map((c) => c.text);
  let cols = columnRanges(first.cells);
  const rows: string[][] = [];
  let totals: string[] | null = null;
  for (let i = first.next; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.cells.some((c) => PAGE_FOOTER.test(c.text))) continue; // "Page 2 of 3" and whatever shares its line
    const s = headerScore(line);
    if (s.header && line.cells.length === headers.length) {
      // the header again on a later page: follow its columns
      const again = mergedHeader(lines, i);
      cols = columnRanges(again.cells);
      i = again.next - 1;
      continue;
    }
    const cells = placeCells(line, cols);
    if (isTotalLine(cells)) {
      totals = cells;
      break;
    }
    if (cells.filter((c) => c.trim()).length >= 2) rows.push(cells);
  }
  return { headers, rows, totals, preamble: lines.slice(0, best).map((l) => l.text) };
}

// ───────────────────────────── cells → values ─────────────────────────────

/** A whole count ("18", "1,204", "(2)" → 2); null for a blank, a dash or text. */
export function parseStatementCount(s: string | null | undefined): number | null {
  const t = (s ?? '').replace(/[\s,]/g, '').replace(/^\((.*)\)$/, '$1');
  if (!t || /^[-–—]$/.test(t)) return null;
  if (!/^-?\d+(\.0+)?$/.test(t)) return null;
  return Math.abs(Math.round(Number(t)));
}

/** "£1,234.50" → 1234.5; "(20.00)" or "-£20.00" → −20; null when it is not an amount. */
export function parseStatementMoney(s: string | null | undefined): number | null {
  let t = (s ?? '').replace(/[\s,]/g, '').replace(/GBP/i, '');
  if (!t || /^[-–—]$/.test(t)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  const m = /^([-−])?£?([-−])?(\d+(?:\.\d{1,2})?)$/.exec(t);
  if (!m) return null;
  if (m[1]) negative = !negative;
  if (m[2]) negative = !negative;
  const n = Math.round(Number(m[3]) * 100) / 100;
  return negative ? -n : n;
}

/** True when a sign-up's status means the client did not pay for it. */
export function isCancelledStatus(s: string | null | undefined): boolean {
  const t = (s ?? '').toLowerCase();
  return /cancel|lapse|refund|declin|fail|revers|reject|void|charge-?back|claw-?back|not paid|unpaid|bounced|returned|withdrawn|opted out|stopped|no longer/.test(t);
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number): string | null => {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isValidISODate(iso) ? iso : null;
};
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** Date patterns, global, each with how to read the match: d/m/y (UK), ISO, "5 Oct 2026", "October 5, 2026". */
const DATE_PATTERNS: { re: RegExp; read: (m: RegExpExecArray) => string | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, read: (m) => isoOf(Number(m[1]), Number(m[2]), Number(m[3])) },
  { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g, read: (m) => isoOf(fullYear(m[3]!), Number(m[2]), Number(m[1])) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'), read: (m) => isoOf(Number(m[3]), MONTH_INDEX[m[2]!.toLowerCase()] ?? 0, Number(m[1])) },
  { re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), read: (m) => isoOf(Number(m[3]), MONTH_INDEX[m[1]!.toLowerCase()] ?? 0, Number(m[2])) },
];

export interface FoundDate {
  iso: string;
  index: number;
  end: number;
}

/** Every date written in a text, in order. */
export function findStatementDates(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  for (const { re, read } of DATE_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const iso = read(m);
      if (iso && !found.some((f) => m!.index < f.end && m!.index + m![0].length > f.index)) found.push({ iso, index: m.index, end: m.index + m[0].length });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** One date cell → ISO ("05/10/2026", "5 Oct 2026", "Mon 5 October 2026", "2026-10-05"); null otherwise. */
export function parseStatementDate(s: string | null | undefined): string | null {
  const found = findStatementDates(s ?? '');
  return found.length === 1 ? found[0]!.iso : null;
}

export interface StatementPeriod {
  start: string;
  end: string;
}

const plausible = (start: string, end: string): StatementPeriod | null => {
  const days = daysBetween(start, end);
  return days >= 0 && days < STATEMENT_MAX_PERIOD_DAYS ? { start, end } : null;
};

/** The period one text states, if any. */
export function parsePeriodText(text: string): StatementPeriod | null {
  const t = text.replace(/[‐‑–—]/g, '-');
  // "1-31 October 2026", "5 - 11 Oct 2026"
  const dayRange = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'i').exec(t);
  if (dayRange) {
    const m = MONTH_INDEX[dayRange[3]!.toLowerCase()] ?? 0;
    const y = Number(dayRange[4]);
    const a = isoOf(y, m, Number(dayRange[1]));
    const b = isoOf(y, m, Number(dayRange[2]));
    if (a && b) return plausible(a, b);
  }
  // "28 Sep - 4 Oct 2026"
  const shortRange = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?\\s*(?:-|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'i').exec(t);
  if (shortRange) {
    const y = Number(shortRange[5]);
    const m1 = MONTH_INDEX[shortRange[2]!.toLowerCase()] ?? 0;
    const m2 = MONTH_INDEX[shortRange[4]!.toLowerCase()] ?? 0;
    const a = isoOf(m1 > m2 ? y - 1 : y, m1, Number(shortRange[1]));
    const b = isoOf(y, m2, Number(shortRange[3]));
    if (a && b) return plausible(a, b);
  }
  const dates = findStatementDates(t);
  for (let i = 0; i + 1 < dates.length; i++) {
    const between = t.slice(dates[i]!.end, dates[i + 1]!.index);
    if (/^\s*(-|to|until|till|through|thru|and)\s*$/i.test(between)) {
      const p = plausible(dates[i]!.iso, dates[i + 1]!.iso);
      if (p) return p;
    }
  }
  const first = dates[0];
  if (first) {
    const before = t.slice(0, first.index).toLowerCase();
    if (/(week\s+(ending|ended|end)|w\/e|w\.e\.)\s*:?\s*(on\s+)?$/.test(before)) return { start: addDays(first.iso, -6), end: first.iso };
    if (/(week\s+(commencing|beginning|starting)|w\/c|w\.c\.)\s*:?\s*$/.test(before)) return { start: first.iso, end: addDays(first.iso, 6) };
  }
  // "Statement for October 2026", "Period: October 2026", a line that is just "October 2026"
  const month = new RegExp(`(?:^|period|month|for|statement|covering|:)\\s*${MONTH_RE}\\s+(\\d{4})\\b`, 'i').exec(t.trim());
  if (month && !dates.length) {
    const m = MONTH_INDEX[month[1]!.toLowerCase()] ?? 0;
    const startIso = isoOf(Number(month[2]), m, 1);
    if (startIso) return { start: startIso, end: endOfMonthISO(startIso) };
  }
  return null;
}

/** The statement's period from its text lines: lines that say "period", "week", "month" or "for" first, then any line. */
export function parseStatementPeriod(texts: readonly string[]): StatementPeriod | null {
  const keyed = texts.filter((t) => /period|week|month|covering|statement|\bfor\b|dates?|from/i.test(t));
  for (const t of [...keyed, ...texts.filter((x) => !keyed.includes(x))]) {
    const p = parsePeriodText(t);
    if (p) return p;
  }
  return null;
}

// ───────────────────────────── table + mapping → rows ─────────────────────────────

export interface StatementRowDraft {
  raw: Record<string, string>;
  fundraiserRef: string | null;
  name: string | null;
  saleDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  confirmed: number;
  cancelled: number | null;
  amount: number | null;
}

export interface StatementRowsRead {
  layout: StatementLayout;
  drafts: StatementRowDraft[];
  /** Why the rows cannot be trusted as read (a missing column), in plain words; [] when fine. */
  problems: string[];
}

/** A mapping value → the column index in these headers (a header text is matched case and spacing aside); null if absent. */
export function resolveStatementColumn(headers: readonly string[], value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < headers.length ? value : null;
  const want = headerText(value);
  const i = headers.findIndex((h) => headerText(h) === want);
  return i >= 0 ? i : null;
}

/** The mapping with every column given as its header text (what a saved template keeps). */
export function mappingByHeader(headers: readonly string[], mapping: StatementColumnMapping): StatementColumnMapping {
  const out: StatementColumnMapping = {};
  for (const f of STATEMENT_FIELDS) {
    const i = resolveStatementColumn(headers, mapping[f]);
    if (i !== null) out[f] = headers[i]!;
  }
  return out;
}

/** The raw cells keyed by header ("Column 3" for a blank header; a repeated header gets " (2)"). */
function rawRow(headers: readonly string[], cells: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    let key = h.trim() || `Column ${i + 1}`;
    for (let n = 2; key in raw; n++) key = `${h.trim() || `Column ${i + 1}`} (${n})`;
    raw[key] = (cells[i] ?? '').trim();
  });
  return raw;
}

/** The table's rows as per-fundraiser drafts under this mapping. */
export function statementRowsFromTable(table: { headers: readonly string[]; rows: readonly (readonly string[])[] }, mapping: StatementColumnMapping): StatementRowsRead {
  const col = Object.fromEntries(STATEMENT_FIELDS.map((f) => [f, resolveStatementColumn(table.headers, mapping[f])])) as Record<StatementField, number | null>;
  const problems: string[] = [];
  const missing = STATEMENT_FIELDS.filter((f) => mapping[f] !== undefined && mapping[f] !== '' && col[f] === null);
  for (const f of missing) problems.push(`The saved columns use “${String(mapping[f])}” for ${STATEMENT_FIELD_LABELS[f].toLowerCase()}, but this statement has no such column.`);
  if (col.ref === null && col.name === null) problems.push('There is no column with the fundraiser’s name or ID.');
  const counts = col.gross !== null || col.confirmed !== null || col.cancelled !== null;
  const layout: StatementLayout = counts ? 'totals' : 'per-sub';
  if (!counts && col.date === null && col.status === null) problems.push('There is no column with the number of subs, or with each sign-up’s date or status.');
  const cell = (row: readonly string[], f: StatementField) => (col[f] === null ? '' : (row[col[f]!] ?? '').trim());
  const drafts: StatementRowDraft[] = [];
  for (const row of table.rows) {
    const ref = cell(row, 'ref') || null;
    const name = cell(row, 'name') || null;
    if (!ref && !name) continue;
    const period = col.period === null ? null : parsePeriodText(cell(row, 'period'));
    let confirmed: number;
    let cancelled: number | null;
    let saleDate: string | null = null;
    if (layout === 'totals') {
      const gross = parseStatementCount(cell(row, 'gross'));
      const paid = parseStatementCount(cell(row, 'confirmed'));
      const lost = parseStatementCount(cell(row, 'cancelled'));
      if (gross === null && paid === null && lost === null) continue; // a note or a sub-heading inside the table
      confirmed = paid ?? Math.max(0, (gross ?? 0) - (lost ?? 0));
      cancelled = lost ?? (gross !== null && paid !== null ? Math.max(0, gross - paid) : null);
    } else {
      saleDate = parseStatementDate(cell(row, 'date'));
      const status = cell(row, 'status');
      if (!saleDate && !status) continue;
      const lost = isCancelledStatus(status);
      confirmed = lost ? 0 : 1;
      cancelled = lost ? 1 : 0;
    }
    drafts.push({
      raw: rawRow(table.headers, row),
      fundraiserRef: ref,
      name,
      saleDate,
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      confirmed,
      cancelled,
      amount: parseStatementMoney(cell(row, 'amount')),
    });
  }
  if (!drafts.length && !problems.length) problems.push('The table has no rows Linear Hub could read.');
  return { layout, drafts, problems };
}

/** The "Total" line's confirmed figure under this mapping (to check the rows add up), when it has one. */
export function statementTotalConfirmed(headers: readonly string[], totals: readonly string[] | null, mapping: StatementColumnMapping): number | null {
  if (!totals) return null;
  const paid = resolveStatementColumn(headers, mapping.confirmed);
  if (paid !== null) return parseStatementCount(totals[paid]);
  const gross = resolveStatementColumn(headers, mapping.gross);
  const lost = resolveStatementColumn(headers, mapping.cancelled);
  if (gross === null) return null;
  const g = parseStatementCount(totals[gross]);
  return g === null ? null : Math.max(0, g - (lost === null ? 0 : (parseStatementCount(totals[lost]) ?? 0)));
}

// ───────────────────────────── confirmations → pay weeks ─────────────────────────────

export interface WeekLogged {
  /** Monday of the pay week. */
  weekStart: string;
  logged: number;
}

export interface WeekConfirmed extends WeekLogged {
  confirmed: number;
}

/**
 * A period total spread over its pay weeks (oldest first in, oldest first out): each week keeps what was logged; when
 * the client confirmed fewer, the cancellations come off the LATEST week first, then the one before, and so on; when
 * it confirmed more, the extra subs go on the latest week. With no weeks, nothing is returned (the caller decides).
 * e.g. logged [5, 6, 2], confirmed 9 → cancel 4: the last week 2 → 0, then 6 → 4: [5, 4, 0].
 */
export function allocateConfirmedToWeeks(weeks: readonly WeekLogged[], confirmed: number): WeekConfirmed[] {
  const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const out = sorted.map((w) => ({ weekStart: w.weekStart, logged: Math.max(0, w.logged), confirmed: Math.max(0, w.logged) }));
  if (!out.length) return out;
  const total = out.reduce((s, w) => s + w.logged, 0);
  let diff = Math.max(0, Math.round(confirmed)) - total;
  if (diff > 0) out[out.length - 1]!.confirmed += diff;
  for (let i = out.length - 1; diff < 0 && i >= 0; i--) {
    const take = Math.min(-diff, out[i]!.confirmed);
    out[i]!.confirmed -= take;
    diff += take;
  }
  return out;
}

/** The Mondays of every pay week a period touches. */
export function statementWeekStarts(start: string, end: string): string[] {
  const out: string[] = [];
  for (let m = startOfWeekISO(start); m <= end; m = addDays(m, 7)) out.push(m);
  return out;
}

// ───────────────────────────── words ─────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "5–11 Oct 2026", "28 Sep – 4 Oct 2026", "October 2026" (a whole month), "Period not stated". */
export function formatStatementPeriod(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end || !isValidISODate(start) || !isValidISODate(end)) return 'Period not stated';
  const [y1, m1, d1] = [Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10))];
  const [y2, m2, d2] = [Number(end.slice(0, 4)), Number(end.slice(5, 7)), Number(end.slice(8, 10))];
  if (y1 === y2 && m1 === m2 && d1 === 1 && end === endOfMonthISO(end)) return `${MONTHS_LONG[m1 - 1]} ${y1}`;
  if (start === end) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}
