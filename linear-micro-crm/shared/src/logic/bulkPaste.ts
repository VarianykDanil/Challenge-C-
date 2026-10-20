/**
 * Release 1.2 — OWNED BY U2 bulk-entry.
 * Pure: reads a WhatsApp paste ("Jordan 65 22 11 5 3 3", "Jordan L - 65/22/11/5/3/3", "amelia: 40 12 6 2 1 1", with
 * emojis, timestamps and extra words) into rows matched against the team (fuzzy first / full name, ambiguous names
 * flagged for a choice), each with its six gauges and the funnel problems to show. Types: shared/src/types/bulk.ts.
 *
 * How a line is read (docs/LOGIC.md §15.4 has the full rules):
 *  1. A WhatsApp export prefix ("[20/10/2026, 17:42:13] Jordan Lee: …", "20/10/2026, 17:42 - Jordan Lee: …",
 *     "[17:42, 20/10/2026] Jordan Lee: …") is removed and its sender remembered for the following lines of the same
 *     message. Emojis, WhatsApp formatting (*bold*, _italic_, ~strike~) and invisible marks are dropped.
 *  2. A check-in time ("9:58", "09:58", "9.58am", "10am") is taken out first, so its digits are never a gauge; a
 *     time without am/pm before 7:00 is read as the afternoon (1:05 → 13:05). Dates ("20/10", "20/10/26",
 *     "2026-10-20") are dropped; a run of 4+ numbers ("65/22/11/5/3/3") is never a date.
 *  3. Numbers stuck to letters ("2nd", "x2"), money ("£10") and percentages are not gauges — unless the letters are a
 *     gauge word ("65stops").
 *  4. A line needs at least three gauge numbers; anything less is chatter (counted in `ignored`). Several people on
 *     one line split where a team member's name follows three or more numbers.
 *  5. Six numbers are read in funnel order. With three or more gauge words ("65 stops, 22 to table…", "stops: 65 …")
 *     each number goes to its word instead.
 *  6. The name is the words before the numbers (after them when the line starts with numbers), ignoring filler
 *     ("gauges", "today", "for" …). No name at all → the message's sender. A name that matches nobody is never
 *     swapped for the sender: the person chooses.
 */
import type { GaugeKey, GaugeTotals } from '../types.ts';
import { GAUGE_KEYS } from '../types.ts';
import { GAUGE_LABELS, GAUGE_MAX_PER_DAY } from '../constants.ts';
import type { ParsedPasteLine, PasteMember, PasteParseResult } from '../types/bulk.ts';

/** Fewer gauge numbers than this on a line → chatter, not a row. */
export const PASTE_MIN_NUMBERS = 3;

/** Words that name a gauge, normalised (lower case, letters only). */
const LABELS: Readonly<Record<string, GaugeKey>> = {
  stop: 'stops', stops: 'stops', stp: 'stops', stps: 'stops',
  table: 'table', tables: 'table', tabled: 'table', tbl: 'table', tbls: 'table', tab: 'table', tabs: 'table',
  pre: 'presentations', pres: 'presentations', prez: 'presentations', preso: 'presentations', presos: 'presentations',
  presentation: 'presentations', presentations: 'presentations', pitch: 'presentations', pitches: 'presentations', pitched: 'presentations',
  close: 'closes', closes: 'closes', closed: 'closes', cls: 'closes',
  tap: 'taps', taps: 'taps', tapped: 'taps',
  sale: 'sales', sales: 'sales', sold: 'sales', signup: 'sales', signups: 'sales', dd: 'sales', dds: 'sales',
};

/** Filler between a number and its gauge word ("22 to table", "3 x sales"). */
const FILLER = new Set(['to', 'the', 'of', 'x', 'at', 'on', 'a']);

/**
 * Words that are not a name: they never decide that a line names someone, and never fuzzy-match a person (an exact
 * first or last name still counts, so a "Will" on the team is found).
 */
const STOPWORDS = new Set([
  'a', 'afternoon', 'all', 'an', 'and', 'are', 'arrived', 'at', 'back', 'big', 'check', 'checked', 'checkin', 'ci', 'day', 'did',
  'done', 'end', 'eod', 'evening', 'figures', 'final', 'for', 'from', 'gauge', 'gauges', 'good', 'got', 'great', 'guys', 'had',
  'haha', 'here', 'hey', 'hi', 'i', 'im', 'in', 'is', 'it', 'its', 'just', 'late', 'lol', 'me', 'mine', 'morning', 'my', 'nice',
  'no', 'numbers', 'nums', 'of', 'ok', 'okay', 'on', 'our', 'out', 'results', 'shift', 'so', 'sorry', 'start', 'started', 'stats',
  'team', 'teams', 'than', 'the', 'to', 'today', 'todays', 'tonight', 'total', 'totals', 'up', 'update', 'updated', 'was', 'we',
  'well', 'were', 'with', 'x', 'xx', 'xxx', 'yday', 'yesterday', 'mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'wednesday',
  'thu', 'thur', 'thurs', 'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday',
]);

// ── text clean-up ──────────────────────────────────────────────────────────

/** Bidi marks, zero-width characters and the BOM that WhatsApp exports carry. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
/** Every kind of space (no-break, narrow no-break before "pm", figure space …) → a plain space. */
const SPACES_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\t]/g;
/** Emoji, skin tones and flags → a space; the keycap and variation marks vanish ("3️⃣" reads as 3). */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu;
const EMOJI_MARKS_RE = /[\ufe0e\ufe0f\u20e3]/g;

/** "[20/10/2026, 17:42:13] " or "[17:42, 20/10/2026] " (iOS, WhatsApp Web / desktop copy). */
const BRACKET_PREFIX_RE = /^\[(?:[\d/.,:\-\s]|[ap]\.?\s?m\.?)+\]\s*/i;
/** "20/10/2026, 17:42 - " (Android export). */
const DASH_PREFIX_RE = /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:[ap]\.?\s?m\.?)?\s+-\s+/i;
/** The sender after a prefix: "Jordan Lee: …", "~ Jordan: …", "+44 7700 900123: …". */
const SENDER_RE = /^~?\s*([^:]{1,60}?)\s*:\s*(.*)$/;

function clean(s: string): string {
  return s.replace(INVISIBLE_RE, '').replace(SPACES_RE, ' ').replace(EMOJI_MARKS_RE, '').replace(EMOJI_RE, ' ');
}

/** Lower case, accents dropped, letters only ("Zoë" → "zoe", "O'Brien" → "obrien", "L." → "l"). */
export function normaliseName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]/gu, '');
}

// ── check-in times and dates ───────────────────────────────────────────────

/** "9:58", "09:58", "9.58am", "1:05 pm" (a dot only with am/pm); never inside a run like "65:22:11". */
const CLOCK_RE = /(?<![\d:.])(\d{1,2})([:.])(\d{2})(?::\d{2})?(?:\s?([ap])\.?m\.?)?(?![\d:]|\.\d)/gi;
/** "10am", "2 pm". */
const HOUR_RE = /(?<![\d:.])(\d{1,2})\s?([ap])\.?m\.?(?![\p{L}\d])/giu;

function toHHMM(hour: number, minute: number, ampm: string | undefined): string | null {
  if (minute > 59) return null;
  let h = hour;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    const pm = ampm.toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else {
    if (h > 23) return null;
    // Nobody checks in for a field shift between 01:00 and 06:59: "1:05" is five past one in the afternoon.
    if (h >= 1 && h <= 6) h += 12;
  }
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface TimeHit { start: number; end: number; hhmm: string }

function findTimes(body: string): TimeHit[] {
  const hits: TimeHit[] = [];
  for (const m of body.matchAll(CLOCK_RE)) {
    if (m[2] === '.' && !m[4]) continue; // "9.55" alone is two numbers, not a time
    const hhmm = toHHMM(Number(m[1]), Number(m[3]), m[4]);
    if (hhmm) hits.push({ start: m.index!, end: m.index! + m[0].length, hhmm });
  }
  for (const m of body.matchAll(HOUR_RE)) {
    const start = m.index!;
    if (hits.some((h) => start < h.end && start + m[0].length > h.start)) continue;
    const hhmm = toHHMM(Number(m[1]), 0, m[2]);
    if (hhmm) hits.push({ start, end: start + m[0].length, hhmm });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** A run of numbers joined by "/", "." or "-" with no spaces ("20/10", "65/22/11/5/3/3", "2026-10-20"). */
const NUMBER_RUN_RE = /\d+(?:[/.\-]\d+)+/g;

function isDateRun(parts: string[]): boolean {
  if (parts.length < 2 || parts.length > 3) return false;
  const n = parts.map(Number);
  if (parts.length === 3 && parts[0]!.length === 4) return n[1]! >= 1 && n[1]! <= 12 && n[2]! >= 1 && n[2]! <= 31; // 2026-10-20
  const [d, mo] = n;
  if (!(d! >= 1 && d! <= 31 && mo! >= 1 && mo! <= 12)) return false;
  if (parts.length === 3) return parts[2]!.length === 2 || parts[2]!.length === 4;
  return parts[0]!.length <= 2 && parts[1]!.length <= 2;
}

/** Blank out dates and times (same length, so positions stay put); returns the times found, in order. */
function stripDatesAndTimes(body: string): { text: string; times: TimeHit[] } {
  const times = findTimes(body);
  let text = body;
  const blank = (start: number, end: number) => {
    text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
  };
  for (const t of times) blank(t.start, t.end);
  for (const m of text.matchAll(NUMBER_RUN_RE)) {
    if (isDateRun(m[0].split(/[/.\-]/))) blank(m.index!, m.index! + m[0].length);
  }
  return { text, times };
}

// ── tokens ─────────────────────────────────────────────────────────────────

type Token =
  | { kind: 'num'; value: number; pos: number; /** stuck to a non-gauge word, money or % → not a gauge */ skip: boolean; /** stuck to a gauge word ("65stops") */ glued: GaugeKey | null }
  | { kind: 'word'; text: string; norm: string; pos: number }
  | { kind: 'label'; key: GaugeKey; pos: number }
  | { kind: 'time'; hhmm: string; pos: number };

const TOKEN_RE = /\d+|\p{L}[\p{L}\p{M}'’]*/gu;
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);

function tokenise(text: string, times: TimeHit[]): Token[] {
  const tokens: Token[] = times.map((t) => ({ kind: 'time', hhmm: t.hhmm, pos: t.start }));
  const words = [...text.matchAll(TOKEN_RE)];
  for (let i = 0; i < words.length; i++) {
    const m = words[i]!;
    const pos = m.index!;
    const raw = m[0];
    if (/^\d/.test(raw)) {
      const before = text[pos - 1];
      const after = text[pos + raw.length];
      // a word glued to the number: is it a gauge word?
      const prevWord = isLetter(before) ? words[i - 1] : undefined;
      const nextWord = isLetter(after) ? words[i + 1] : undefined;
      const glued = (nextWord && LABELS[normaliseName(nextWord[0])]) || (prevWord && LABELS[normaliseName(prevWord[0])]) || null;
      const money = before !== undefined && /[£$€#]/.test(before);
      const percent = after === '%';
      const skip = money || percent || (!glued && (isLetter(before) || isLetter(after))) || raw.length > 6;
      tokens.push({ kind: 'num', value: Number(raw), pos, skip, glued: skip ? null : glued });
    } else {
      const norm = normaliseName(raw);
      if (!norm) continue;
      const label = LABELS[norm];
      // a word glued to a number is not a name: a gauge word was used by that number already ("65stops"), anything
      // else made the number a non-gauge ("2nd", "x2")
      if (/\d/.test(text[pos - 1] ?? '') || /\d/.test(text[pos + raw.length] ?? '')) continue;
      tokens.push(label ? { kind: 'label', key: label, pos } : { kind: 'word', text: raw.replace(/[.'’]+$/, ''), norm, pos });
    }
  }
  return tokens.sort((a, b) => a.pos - b.pos);
}

const isGaugeNum = (t: Token): t is Extract<Token, { kind: 'num' }> => t.kind === 'num' && !t.skip;

// ── name matching ──────────────────────────────────────────────────────────

/** Optimal string alignment distance, capped: returns `cap + 1` as soon as it is exceeded. */
function osaDistance(a: string, b: string, cap = 1): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length]![b.length]!;
}

/** A near miss: a typo ("Jordon"), a swap ("Aemlia") or a short form ("Jord", "Sam" for Samuel). */
function fuzzy(token: string, name: string): boolean {
  if (!name || token === name) return false;
  if (token.length >= 3 && token.length < name.length && name.startsWith(token)) return true;
  return token.length >= 4 && name.length >= 4 && osaDistance(token, name) <= 1;
}

interface NameScore { best: number; ids: number[] }

/**
 * Score every member against the name's tokens and keep those with the top score. Exact matches use every token;
 * near misses only the meaningful ones (`fuzzyTokens`), so "the" never finds a Theo.
 *  100 first + last · 90 first + last initial · 85 first + near-miss last · 70 first · 65 near-miss first + last
 *  60 last · 55 near-miss first + last initial · 40 near-miss first
 */
function scoreMembers(members: readonly PasteMember[], tokens: string[], fuzzyTokens: string[]): NameScore {
  const exact = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) exact.add(tokens[i]! + tokens[i + 1]!); // "Mary Jane" finds "Mary-Jane"
  const initials = new Set(tokens.filter((t) => t.length === 1));
  let best = 0;
  let ids: number[] = [];
  for (const m of members) {
    const f = normaliseName(m.firstName);
    const l = normaliseName(m.lastName);
    const fExact = !!f && exact.has(f);
    const lExact = !!l && exact.has(l);
    const lInitial = !!l && initials.has(l[0]!);
    const fNear = !fExact && fuzzyTokens.some((t) => fuzzy(t, f));
    const lNear = !lExact && fuzzyTokens.some((t) => fuzzy(t, l));
    const score = fExact && lExact ? 100
      : fExact && lInitial ? 90
      : fExact && lNear ? 85
      : fExact ? 70
      : fNear && lExact ? 65
      : lExact ? 60
      : fNear && lInitial ? 55
      : fNear ? 40
      : 0;
    if (score === 0) continue;
    if (score > best) {
      best = score;
      ids = [m.userId];
    } else if (score === best) ids.push(m.userId);
  }
  return { best, ids };
}

/** True when the word is some member's first or last name exactly (where one person's numbers end and the next begins). */
function isMemberName(norm: string, members: readonly PasteMember[]): boolean {
  return members.some((m) => normaliseName(m.firstName) === norm || normaliseName(m.lastName) === norm);
}

// ── values ─────────────────────────────────────────────────────────────────

const LABEL_LOWER: Record<GaugeKey, string> = {
  stops: 'stops', table: 'to table', presentations: 'presentations', closes: 'closes', taps: 'taps', sales: 'sales',
};

/** Plain-English funnel problems for one set of gauges ("To table (22) is more than stops (12)"). */
export function pasteFunnelIssues(t: GaugeTotals, max: number = GAUGE_MAX_PER_DAY): string[] {
  const issues: string[] = [];
  for (const k of GAUGE_KEYS) if (t[k] > max) issues.push(`${GAUGE_LABELS[k]} (${t[k]}) is over the ${max.toLocaleString('en-GB')} a day limit`);
  for (let i = 1; i < GAUGE_KEYS.length; i++) {
    const prev = GAUGE_KEYS[i - 1]!;
    const cur = GAUGE_KEYS[i]!;
    if (t[cur] > t[prev]) issues.push(`${GAUGE_LABELS[cur]} (${t[cur]}) is more than ${LABEL_LOWER[prev]} (${t[prev]})`);
  }
  return issues;
}

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Gauge words paired with their numbers: "65 stops" (number first) or "stops: 65" (word first), whichever fits more. */
function labelledValues(seg: Token[]): { values: GaugeTotals | null; issues: string[] } {
  const pairs = (dir: -1 | 1) => {
    const out: { key: GaugeKey; value: number }[] = [];
    const used = new Set<number>();
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i]!;
      if (t.kind === 'num' && !t.skip && t.glued) {
        out.push({ key: t.glued, value: t.value });
        used.add(i);
        continue;
      }
      if (t.kind !== 'label') continue;
      let j = i + dir;
      while (j >= 0 && j < seg.length && seg[j]!.kind === 'word' && FILLER.has((seg[j] as Extract<Token, { kind: 'word' }>).norm)) j += dir;
      const n = seg[j];
      if (n && isGaugeNum(n) && !n.glued && !used.has(j)) {
        used.add(j);
        out.push({ key: t.key, value: n.value });
      }
    }
    return out;
  };
  const before = pairs(-1);
  const after = pairs(1);
  const chosen = after.length > before.length ? after : before;
  const values: Partial<GaugeTotals> = {};
  const issues: string[] = [];
  for (const p of chosen) {
    if (values[p.key] !== undefined && values[p.key] !== p.value) issues.push(`${GAUGE_LABELS[p.key]} is written twice`);
    values[p.key] = p.value;
  }
  const missing = GAUGE_KEYS.filter((k) => values[k] === undefined);
  if (missing.length) issues.push(`Missing ${listWords(missing.map((k) => LABEL_LOWER[k]))}`);
  return { values: issues.length ? null : (values as GaugeTotals), issues };
}

// ── the parser ─────────────────────────────────────────────────────────────

interface Sender { name: string; tokens: string[] }

function readPrefix(line: string): { body: string; sender: Sender | null } | null {
  const m = BRACKET_PREFIX_RE.exec(line) ?? DASH_PREFIX_RE.exec(line);
  if (!m) return null;
  // a bracket of numbers only is a WhatsApp prefix when it has a time in it ("[17:42, 20/10/2026]")
  if (!/\d{1,2}[:.]\d{2}/.test(m[0])) return null;
  const rest = line.slice(m[0].length);
  const s = SENDER_RE.exec(rest);
  if (!s) return { body: rest, sender: null }; // a system message ("Messages are end-to-end encrypted")
  const name = s[1]!.trim();
  const tokens = [...name.matchAll(TOKEN_RE)].map((w) => normaliseName(w[0])).filter((t) => t && !/^\d/.test(t));
  return { body: s[2]!, sender: { name, tokens } };
}

/**
 * Split a line's tokens where a member's name follows three or more gauge numbers — only when the numbers already
 * have a name in front of them ("65 22 11 5 3 3 Jordan" is one person named at the end).
 */
function segments(tokens: Token[], members: readonly PasteMember[]): Token[][] {
  const out: Token[][] = [[]];
  let nums = 0;
  let named = false;
  for (const t of tokens) {
    if (t.kind === 'word' && named && nums >= PASTE_MIN_NUMBERS && isMemberName(t.norm, members)) {
      out.push([]);
      nums = 0;
      named = false;
    }
    out[out.length - 1]!.push(t);
    if (isGaugeNum(t)) nums++;
    else if (t.kind === 'word' && nums === 0 && !STOPWORDS.has(t.norm)) named = true;
  }
  return out;
}

/**
 * Read a pasted WhatsApp message (or a whole chat export) into one row per person. Deterministic and pure: the same
 * text and team give the same rows.
 */
export function parseBulkPaste(text: string, members: readonly PasteMember[]): PasteParseResult {
  const lines: ParsedPasteLine[] = [];
  let ignored = 0;
  let sender: Sender | null = null;
  const rawLines = text.split(/\r\n|\r|\n|\u2028|\u2029/);
  rawLines.forEach((raw, index) => {
    const lineNo = index + 1;
    let body = clean(raw);
    const prefix = readPrefix(body.trim());
    if (prefix) {
      sender = prefix.sender;
      body = prefix.body;
    }
    if (!body.trim()) {
      if (raw.trim()) ignored++;
      return;
    }
    body = body.replace(/[*_~`]/g, ' ').replace(/[\u2010-\u2015\u2212]/g, '-');
    const { text: stripped, times } = stripDatesAndTimes(body);
    const tokens = tokenise(stripped, times);
    const segs = segments(tokens, members).filter((seg) => {
      const nums = seg.filter(isGaugeNum).length;
      const labels = seg.filter((t) => t.kind === 'label' || (t.kind === 'num' && !t.skip && t.glued)).length;
      return nums >= PASTE_MIN_NUMBERS || (labels >= PASTE_MIN_NUMBERS && nums >= 1);
    });
    if (!segs.length) {
      ignored++;
      return;
    }
    segs.forEach((seg, si) => lines.push(readSegment(seg, { lineNo, raw, key: segs.length > 1 ? `${lineNo}.${si + 1}` : String(lineNo), sender, members })));
  });
  return { lines: markReplaced(lines), ignored };
}

function readSegment(seg: Token[], ctx: { lineNo: number; raw: string; key: string; sender: Sender | null; members: readonly PasteMember[] }): ParsedPasteLine {
  const issues: string[] = [];
  const firstNum = seg.findIndex((t) => t.kind === 'num' || t.kind === 'label');
  let lastNum = -1;
  seg.forEach((t, i) => {
    if (t.kind === 'num' || t.kind === 'label') lastNum = i;
  });
  const wordsIn = (from: number, to: number) => seg.slice(from, to).filter((t): t is Extract<Token, { kind: 'word' }> => t.kind === 'word');
  let nameWords = wordsIn(0, firstNum < 0 ? seg.length : firstNum);
  if (!nameWords.some((w) => !STOPWORDS.has(w.norm))) {
    const trailing = wordsIn(lastNum + 1, seg.length);
    if (trailing.some((w) => !STOPWORDS.has(w.norm))) nameWords = trailing;
  }
  const meaningful = nameWords.filter((w) => !STOPWORDS.has(w.norm));

  // ── who ──
  let name = meaningful.map((w) => w.text).join(' ');
  let nameFrom: ParsedPasteLine['nameFrom'] = meaningful.length ? 'line' : null;
  let score: NameScore = { best: 0, ids: [] };
  if (meaningful.length) {
    score = scoreMembers(ctx.members, nameWords.map((w) => w.norm), meaningful.map((w) => w.norm));
  } else if (ctx.sender && ctx.sender.tokens.length) {
    name = ctx.sender.name;
    nameFrom = 'sender';
    score = scoreMembers(ctx.members, ctx.sender.tokens, ctx.sender.tokens.filter((t) => !STOPWORDS.has(t)));
  }
  const matches = score.ids;
  if (!name) issues.push('No name on this line — choose who it is');
  else if (matches.length === 0) issues.push(`No one called “${name}” on this team — choose who it is`);
  else if (matches.length > 1) issues.push(`${matches.length} people match “${name}” — choose one`);

  // ── the numbers ──
  const labelCount = seg.filter((t) => t.kind === 'label' || (t.kind === 'num' && !t.skip && t.glued)).length;
  let values: GaugeTotals | null = null;
  const nums = seg.filter(isGaugeNum).map((t) => t.value);
  const inOrder = nums.length === GAUGE_KEYS.length
    ? { stops: nums[0]!, table: nums[1]!, presentations: nums[2]!, closes: nums[3]!, taps: nums[4]!, sales: nums[5]! }
    : null;
  if (labelCount >= PASTE_MIN_NUMBERS) {
    // gauge words decide; when they do not add up but six plain numbers do, the words were just chat
    const r = labelledValues(seg);
    values = r.values ?? inOrder;
    if (!values) issues.push(...r.issues);
  } else {
    values = inOrder;
    if (!values) issues.push(`Found ${nums.length} number${nums.length === 1 ? '' : 's'}, need ${GAUGE_KEYS.length}`);
  }
  if (values) issues.push(...pasteFunnelIssues(values));
  const time = seg.find((t): t is Extract<Token, { kind: 'time' }> => t.kind === 'time');

  return {
    line: ctx.lineNo,
    key: ctx.key,
    raw: ctx.raw,
    name,
    nameFrom,
    matches,
    userId: matches.length === 1 ? matches[0]! : null,
    guess: matches.length === 1 && score.best < 60,
    values,
    checkIn: time ? time.hhmm : null,
    issues,
    replacedBy: null,
  };
}

// ── choices and filling the table ──────────────────────────────────────────

/** One person's row as the paste fills it: the last complete line for that person wins. */
export interface PasteFill {
  userId: number;
  values: GaugeTotals;
  /** "HH:mm", or null when the line had no time. */
  checkIn: string | null;
  /** Key of the line it came from. */
  key: string;
  line: number;
}

/** Set `replacedBy` on every complete line that a later complete line for the same person overrides. */
function markReplaced(lines: ParsedPasteLine[]): ParsedPasteLine[] {
  const lastFor = new Map<number, ParsedPasteLine>();
  for (const l of lines) if (l.userId !== null && l.values) lastFor.set(l.userId, l);
  return lines.map((l) => {
    const last = l.userId !== null && l.values ? lastFor.get(l.userId) : undefined;
    const replacedBy = last && last.key !== l.key ? last.key : null;
    return replacedBy === l.replacedBy ? l : { ...l, replacedBy };
  });
}

/**
 * Apply the person's choices (line key → user id) for ambiguous or unknown names, and recompute which lines a later
 * line replaces. A choice for an ambiguous line must be one of its matches; any team member can be chosen for an
 * unknown name or to correct a match. `null` clears a choice back to the parser's own match.
 */
export function resolvePaste(lines: readonly ParsedPasteLine[], choices: Readonly<Record<string, number | null>>, members: readonly PasteMember[]): ParsedPasteLine[] {
  const ids = new Set(members.map((m) => m.userId));
  const next = lines.map((l) => {
    const chosen = choices[l.key];
    const own = l.matches.length === 1 ? l.matches[0]! : null;
    const allowed = chosen != null && ids.has(chosen) && (l.matches.length < 2 || l.matches.includes(chosen));
    const userId = allowed ? chosen : own;
    return userId === l.userId ? l : { ...l, userId };
  });
  return markReplaced(next);
}

/** The rows a paste fills: one per person, from the last complete line naming them, in line order. */
export function pasteFills(lines: readonly ParsedPasteLine[]): PasteFill[] {
  const byUser = new Map<number, PasteFill>();
  for (const l of lines) {
    if (l.userId === null || !l.values) continue;
    byUser.delete(l.userId); // re-insert so the order follows the line that wins
    byUser.set(l.userId, { userId: l.userId, values: { ...l.values }, checkIn: l.checkIn, key: l.key, line: l.line });
  }
  return [...byUser.values()].sort((a, b) => a.line - b.line || a.key.localeCompare(b.key));
}
