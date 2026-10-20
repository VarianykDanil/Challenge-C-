/**
 * Release 1.2 — OWNED BY L2 learning-pitch.
 * Pure: turns a pitch's plain-text body into blocks (spoken lines with inline name / close / pause / direction
 * segments, stage directions, pause beats, Yes / No branches), tags each spoken line with its step of the five steps
 * and its annotations (./pitchAnnotations.ts), estimates how long each step reads aloud, and parses the fact-check
 * notes. Deterministic: the same text always gives the same result. Format: shared/src/types/pitches.ts.
 *
 * Script format (one spoken line per line; blank lines separate paragraphs):
 *  - a whole line in brackets is a stage direction: "(Slow smile and cautious)";
 *  - "(Pause)", "(Pause - 1 Second)", "(Long pause)" is a pause beat (1 s when no length is given);
 *  - "(Name)" is the person's name slot; "(Close)" marks the close (and starts the close step);
 *  - brackets inside a spoken line become inline segments: "Pretty amazing right!! (Close)";
 *  - "(Introduction)", "(Short story)", "(Presentation)", "(Close)" or "(Consolidation)" on its own line starts that step;
 *  - a line starting "Yes -" or "No -" starts a branch for the answer to the previous question. A branch runs until the
 *    other answer's line ("No -" after "Yes -"), or until an end line "(Both)" / "(Back to the pitch)"; the last
 *    branch otherwise ends at the end of its first paragraph (the next blank line). The same answer again ("Yes -" after
 *    "Yes -") starts a new question's branches. When a later question's branches open with the other answer, end the
 *    earlier ones with "(Both)" so the two are not read as one question.
 */
import type {
  PitchAnnotation,
  PitchBlock,
  PitchBranch,
  PitchCard,
  PitchFact,
  PitchFactTone,
  PitchScript,
  PitchSegment,
  PitchStepEstimate,
  PitchStepKey,
  PitchStepTarget,
} from '../types/pitches.ts';
import { annotatePitchLine, PITCH_ANNOTATION_RULES, PITCH_DIRECTION_RULES, straightenQuotes } from './pitchAnnotations.ts';

/** Target times from the COD pack's "5 steps to a conversation" (null: the pack sets none). */
export const PITCH_STEP_TARGETS: PitchStepTarget[] = [
  { step: 'introduction', label: 'Introduction', minSeconds: 7, maxSeconds: 10 },
  { step: 'short-story', label: 'Short story', minSeconds: 10, maxSeconds: 15 },
  { step: 'presentation', label: 'Presentation', minSeconds: null, maxSeconds: null },
  { step: 'close', label: 'Close', minSeconds: null, maxSeconds: null },
  { step: 'consolidation', label: 'Consolidation', minSeconds: null, maxSeconds: null },
];

/**
 * The five steps in order. Written out (not mapped from PITCH_STEP_TARGETS) so the module has no top-level calls: the
 * client bundler can then leave the parser out of the main chunk and load it with the pitch page only.
 */
export const PITCH_STEP_ORDER: readonly PitchStepKey[] = ['introduction', 'short-story', 'presentation', 'close', 'consolidation'];

/** Read-aloud speed behind every estimate: a brisk, clear conversational pace. */
export const PITCH_WORDS_PER_MINUTE = 150;
/** A pause beat without a length ("(Pause)") counts as one second. */
export const PITCH_DEFAULT_PAUSE_SECONDS = 1;

/** Limits shared by the editor and PUT /pitches/:campaignCode. */
export const PITCH_TITLE_MAX = 120;
export const PITCH_BODY_MAX = 20_000;
export const PITCH_FACTS_MAX = 10_000;

/**
 * Phrases that start a step when the writer has not marked it. Steps only move forward: a cue for an earlier step later
 * in the script changes nothing. The first spoken line is always the introduction.
 */
export const PITCH_STEP_CUES: readonly { step: PitchStepKey; pattern: RegExp }[] = [
  { step: 'short-story', pattern: /\bwhat we do\b|\bwho we are\b|\bwe(?:'re| are) from\b|\bwe (?:help|support|fund|provide|raise)\b/i },
  {
    step: 'presentation',
    pattern: /\bsurvival rate\b|\bas of (?:19|20)\d\d\b|\bsince (?:19|20)\d\d\b|\bthe problem\b|\bthe solution\b|\bunfortunately\b|\bobviously\b/i,
  },
  {
    step: 'close',
    pattern: /\(\s*close\s*\)|\bI(?:'m| am) sure (?:we|you) can count on\b|\bcan (?:we|I) count on\b|\bshall we get you\b|\blet's get you (?:signed|set) up\b/i,
  },
  {
    step: 'consolidation',
    pattern: /\bwelcome call\b|\bwelcome pack\b|\bthank you (?:so much )?for (?:signing|joining)\b|\bat least (?:2|two) years\b/i,
  },
];

const BRACKET_RE = /\(([^()]*)\)/g;
const WHOLE_BRACKETS_RE = /^(?:\s*\([^()]*\))+\s*$/;
/** "Yes -", "No - Count yourself lucky…", "Yes: …" — but never "No-one". */
const BRANCH_RE = /^(yes|no)(?:\s+[-–—:]|\s*[-–—:](?=\s|$))\s*(.*)$/i;
const BRANCH_END_RE = /^\(\s*(?:both|either way|then|back to (?:the )?pitch|end(?: of)? (?:the )?branch(?:es)?)\s*\)$/i;
const PAUSE_RE = /^(?:[a-z]+\s+)?pause\b/i;
const PAUSE_SECONDS_RE = /(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\b/i;
const NAME_RE = /^(?:their |the person's |the customer's )?name$/i;
const CLOSE_RE = /^close$/i;
const STEP_MARKER_RE = /^(?:step\s*\d\s*[:.\-–—]?\s*)?(introduction|intro|short story|presentation|close|consolidation)$/i;
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

const stepIndex = (s: PitchStepKey) => Math.max(0, PITCH_STEP_ORDER.indexOf(s));

/** CRLF / CR → LF, so line numbers match what the editor shows. */
export function normalisePitchText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Spoken words in a piece of text (numbers count; emoji and punctuation do not). */
export function countPitchWords(text: string): number {
  return (text.match(WORD_RE) ?? []).length;
}

function stepMarkerOf(inner: string): PitchStepKey | null {
  const m = STEP_MARKER_RE.exec(inner.trim());
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  if (word === 'intro' || word === 'introduction') return 'introduction';
  if (word === 'short story') return 'short-story';
  return word as PitchStepKey;
}

function bracketSegment(inner: string): PitchSegment {
  const text = inner.replace(/\s+/g, ' ').trim();
  if (NAME_RE.test(text)) return { kind: 'name' };
  if (CLOSE_RE.test(text)) return { kind: 'close' };
  if (PAUSE_RE.test(text)) {
    const s = PAUSE_SECONDS_RE.exec(text.replace(PAUSE_RE, ''));
    return { kind: 'pause', seconds: s ? Number(s[1]) : null };
  }
  return { kind: 'direction', text };
}

/** The inline pieces of one line: words, name slot, close marker, pauses and directions, in order. */
export function pitchSegments(line: string): PitchSegment[] {
  const out: PitchSegment[] = [];
  const pushText = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t) out.push({ kind: 'text', text: t });
  };
  let last = 0;
  for (const m of line.matchAll(BRACKET_RE)) {
    pushText(line.slice(last, m.index));
    out.push(bracketSegment(m[1]!));
    last = m.index + m[0].length;
  }
  pushText(line.slice(last));
  return out;
}

/** The words of a line as said aloud: text segments joined, the name slot as `name` (default "(Name)"). */
export function pitchSpokenText(segments: readonly PitchSegment[], name = '(Name)'): string {
  return segments
    .flatMap((s) => (s.kind === 'text' ? [s.text] : s.kind === 'name' ? [name] : []))
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function mergeAnnotations(...lists: PitchAnnotation[][]): PitchAnnotation[] {
  const out: PitchAnnotation[] = [];
  for (const list of lists) for (const a of list) if (!out.some((b) => b.theory === a.theory)) out.push(a);
  return out;
}

interface Ctx {
  step: PitchStepKey;
  spoken: number;
  lastSpoken: string | null;
}

/** The blocks of one non-blank line (several when a line holds only bracket groups, e.g. "(Smile) (Pause)"). */
function lineBlocks(raw: string, line: number, ctx: Ctx): PitchBlock[] {
  const text = raw.trim();
  if (WHOLE_BRACKETS_RE.test(text)) {
    const out: PitchBlock[] = [];
    for (const m of text.matchAll(BRACKET_RE)) {
      const seg = bracketSegment(m[1]!);
      if (seg.kind === 'pause') {
        out.push({ kind: 'pause', line, seconds: seg.seconds, text: m[0], step: ctx.step, annotations: annotatePitchLine(m[0]) });
      } else if (seg.kind === 'direction') {
        const marker = stepMarkerOf(seg.text);
        if (marker) {
          ctx.step = marker;
          out.push({ kind: 'direction', line, text: seg.text, step: marker, annotations: [], stepMarker: marker });
        } else {
          out.push({ kind: 'direction', line, text: seg.text, step: ctx.step, annotations: annotatePitchLine(seg.text, PITCH_DIRECTION_RULES) });
        }
      } else {
        // "(Name)" or "(Close)" on a line of its own: a spoken beat with no words.
        out.push(spokenBlock(m[0], [seg], line, ctx));
      }
    }
    return out;
  }
  return [spokenBlock(text, pitchSegments(text), line, ctx)];
}

function spokenBlock(text: string, segments: PitchSegment[], line: number, ctx: Ctx): PitchBlock {
  const plain = straightenQuotes(text);
  if (ctx.spoken > 0) {
    for (const cue of PITCH_STEP_CUES) {
      cue.pattern.lastIndex = 0;
      if (stepIndex(cue.step) > stepIndex(ctx.step) && cue.pattern.test(plain)) ctx.step = cue.step;
    }
  }
  ctx.spoken++;
  const spoken = pitchSpokenText(segments);
  if (spoken) ctx.lastSpoken = spoken;
  const directions = segments.flatMap((s) => (s.kind === 'direction' ? [annotatePitchLine(s.text, PITCH_DIRECTION_RULES)] : []));
  return { kind: 'line', line, text, segments, step: ctx.step, annotations: mergeAnnotations(annotatePitchLine(text, PITCH_ANNOTATION_RULES), ...directions) };
}

function pushBlock(into: PitchBlock[], block: PitchBlock): void {
  if (block.kind === 'break' && (into.length === 0 || into[into.length - 1]!.kind === 'break')) return;
  into.push(block);
}

function trimBreaks(blocks: PitchBlock[]): PitchBlock[] {
  while (blocks.length && blocks[blocks.length - 1]!.kind === 'break') blocks.pop();
  return blocks;
}

/** Where a branch that starts on line index `i` stops: the index of its first line that is not in it. */
function branchEnd(lines: string[], i: number, answer: 'yes' | 'no', seen: Set<'yes' | 'no'>): { stop: number; endMarker: boolean; sibling: boolean } {
  const opposite = answer === 'yes' ? 'no' : 'yes';
  for (let k = i + 1; k < lines.length; k++) {
    const t = lines[k]!.trim();
    if (BRANCH_END_RE.test(t)) return { stop: k, endMarker: true, sibling: false };
    const m = BRANCH_RE.exec(t);
    if (m) {
      if (m[1]!.toLowerCase() === opposite && !seen.has(opposite)) return { stop: k, endMarker: false, sibling: true };
      break;
    }
  }
  // No other answer and no end line: the branch is its first paragraph.
  let k = i + 1;
  const inline = (BRANCH_RE.exec(lines[i]!.trim())?.[2] ?? '').trim();
  if (!inline) while (k < lines.length && !lines[k]!.trim()) k++;
  while (k < lines.length && lines[k]!.trim() && !BRANCH_RE.test(lines[k]!.trim())) k++;
  return { stop: k, endMarker: false, sibling: false };
}

function parseBranchGroup(lines: string[], start: number, ctx: Ctx): { block: PitchBlock; next: number } {
  const question = ctx.lastSpoken;
  const groupStep = ctx.step;
  let furthest = ctx.step;
  const branches: PitchBranch[] = [];
  const seen = new Set<'yes' | 'no'>();
  let i = start;
  while (i < lines.length) {
    const m = BRANCH_RE.exec(lines[i]!.trim());
    if (!m) break;
    const answer = m[1]!.toLowerCase() as 'yes' | 'no';
    if (seen.has(answer)) break; // the same answer again starts a new group
    seen.add(answer);
    const end = branchEnd(lines, i, answer, seen);
    ctx.step = groupStep;
    const blocks: PitchBlock[] = [];
    const inline = m[2]!.trim();
    if (inline) for (const b of lineBlocks(inline, i + 1, ctx)) pushBlock(blocks, b);
    for (let j = i + 1; j < end.stop; j++) {
      const t = lines[j]!.trim();
      if (!t) pushBlock(blocks, { kind: 'break', line: j + 1 });
      else for (const b of lineBlocks(t, j + 1, ctx)) pushBlock(blocks, b);
    }
    if (stepIndex(ctx.step) > stepIndex(furthest)) furthest = ctx.step;
    branches.push({ answer, label: answer === 'yes' ? 'Yes' : 'No', blocks: trimBreaks(blocks) });
    i = end.stop;
    if (end.endMarker) {
      i++;
      break;
    }
    if (!end.sibling) break;
  }
  ctx.step = furthest;
  ctx.lastSpoken = null;
  return { block: { kind: 'branch', line: start + 1, question, branches, step: groupStep }, next: i };
}

interface Estimate {
  total: number;
  perStep: Map<PitchStepKey, number>;
}

function addTo(map: Map<PitchStepKey, number>, step: PitchStepKey, s: number) {
  map.set(step, (map.get(step) ?? 0) + s);
}

/** Read-aloud seconds of one spoken line: its words at PITCH_WORDS_PER_MINUTE plus any inline pauses. */
export function pitchLineSeconds(segments: readonly PitchSegment[], wordsPerMinute = PITCH_WORDS_PER_MINUTE): number {
  let s = 0;
  for (const seg of segments) {
    if (seg.kind === 'text') s += (countPitchWords(seg.text) * 60) / wordsPerMinute;
    else if (seg.kind === 'pause') s += seg.seconds ?? PITCH_DEFAULT_PAUSE_SECONDS;
  }
  return s;
}

/** Along the longest path: every main block plus, per Yes / No group, the longer branch. */
function estimate(blocks: readonly PitchBlock[]): Estimate {
  const perStep = new Map<PitchStepKey, number>();
  let total = 0;
  for (const b of blocks) {
    if (b.kind === 'line') {
      const s = pitchLineSeconds(b.segments);
      total += s;
      addTo(perStep, b.step ?? 'introduction', s);
    } else if (b.kind === 'pause') {
      const s = b.seconds ?? PITCH_DEFAULT_PAUSE_SECONDS;
      total += s;
      addTo(perStep, b.step ?? 'introduction', s);
    } else if (b.kind === 'branch') {
      let best: Estimate | null = null;
      for (const br of b.branches) {
        const e = estimate(br.blocks);
        if (!best || e.total > best.total) best = e;
      }
      if (best) {
        total += best.total;
        for (const [step, s] of best.perStep) addTo(perStep, step, s);
      }
    }
  }
  return { total, perStep };
}

/** Every spoken line block, in reading order (branches in order, Yes before No as written). */
export function pitchSpokenLines(blocks: readonly PitchBlock[]): Extract<PitchBlock, { kind: 'line' }>[] {
  const out: Extract<PitchBlock, { kind: 'line' }>[] = [];
  for (const b of blocks) {
    if (b.kind === 'line') out.push(b);
    else if (b.kind === 'branch') for (const br of b.branches) out.push(...pitchSpokenLines(br.blocks));
  }
  return out;
}

/** Parse a pitch body into blocks. Deterministic: the same text always gives the same blocks. */
export function parsePitchScript(body: string): PitchScript {
  const lines = normalisePitchText(body ?? '').split('\n');
  const ctx: Ctx = { step: 'introduction', spoken: 0, lastSpoken: null };
  const blocks: PitchBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (!t) {
      pushBlock(blocks, { kind: 'break', line: i + 1 });
      i++;
      continue;
    }
    if (BRANCH_RE.test(t)) {
      const { block, next } = parseBranchGroup(lines, i, ctx);
      pushBlock(blocks, block);
      i = next;
      continue;
    }
    if (BRANCH_END_RE.test(t)) {
      // An end line outside a branch says nothing to read aloud.
      i++;
      continue;
    }
    for (const b of lineBlocks(t, i + 1, ctx)) pushBlock(blocks, b);
    i++;
  }
  trimBreaks(blocks);

  const spoken = pitchSpokenLines(blocks);
  const words = spoken.map((b) => countPitchWords(pitchSpokenText(b.segments)));
  const est = estimate(blocks);
  const steps: PitchStepEstimate[] = PITCH_STEP_TARGETS.map((t) => {
    const mine = spoken.filter((b) => b.step === t.step && countPitchWords(pitchSpokenText(b.segments)) > 0);
    return {
      ...t,
      seconds: Math.round(est.perStep.get(t.step) ?? 0),
      lines: mine.length,
      firstLine: mine.length ? Math.min(...mine.map((b) => b.line)) : null,
    };
  });
  return {
    blocks,
    lineCount: words.filter((w) => w > 0).length,
    wordCount: words.reduce((a, b) => a + b, 0),
    estimatedSeconds: Math.round(est.total),
    steps,
    wordsPerMinute: PITCH_WORDS_PER_MINUTE,
  };
}

/** How a step's estimate compares with the pack's target: 'none' when the pack sets no target or the step is empty. */
export function pitchStepVerdict(seconds: number, target: Pick<PitchStepTarget, 'minSeconds' | 'maxSeconds'>): 'under' | 'within' | 'over' | 'none' {
  if (seconds <= 0 || (target.minSeconds == null && target.maxSeconds == null)) return 'none';
  if (target.minSeconds != null && seconds < target.minSeconds) return 'under';
  if (target.maxSeconds != null && seconds > target.maxSeconds) return 'over';
  return 'within';
}

/** A short, stable key for a line's text (FNV-1a, base 36): flashcard progress survives edits to other lines. */
export function pitchLineKey(text: string): string {
  let h = 0x811c9dc5;
  const s = straightenQuotes(text).replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Memorise mode: one card per spoken line with words, in reading order, with the line before it as the cue. A branch
 * line carries its answer ("If yes") and the question. Keys are pitchLineKey of the text, suffixed ":2", ":3" when the
 * same words come back.
 */
export function pitchCards(script: Pick<PitchScript, 'blocks'>): PitchCard[] {
  const cards: PitchCard[] = [];
  const seen = new Map<string, number>();
  let previous: string | null = null;
  const visit = (blocks: readonly PitchBlock[], branch: PitchCard['branch']) => {
    for (const b of blocks) {
      if (b.kind === 'line') {
        const text = pitchSpokenText(b.segments);
        if (!countPitchWords(text)) continue;
        const base = pitchLineKey(text);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        cards.push({ key: n === 1 ? base : `${base}:${n}`, line: b.line, text, segments: b.segments, step: b.step ?? 'introduction', branch, cue: previous });
        previous = text;
      } else if (b.kind === 'branch') {
        const before = previous;
        let after = previous;
        for (const br of b.branches) {
          previous = before;
          visit(br.blocks, { answer: br.answer, label: br.label, question: b.question });
          after = previous;
        }
        previous = after;
      }
    }
  };
  visit(script.blocks, null);
  return cards;
}

// ── Fact-check notes ──

const URL_RE = /https?:\/\/[^\s)<>"”]+/g;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const LEAD_QUOTES_RE = /^((?:\s*(?:and|&|,)?\s*["“][^"”]+["”])+)\s*(?:[:\-–—]\s*)?/;
const QUOTE_RE = /["“]([^"”]+)["”]/g;
const SUGGESTION_RE = /\bSuggested(?: accurate)? wording:\s*["“]([^"”]+)["”]\.?/i;
const VERIFIED_RE = /^(?:matches|confirmed|correct|verified|accurate|true)\b/i;

function splitFactItems(text: string): string[] {
  const lines = normalisePitchText(text).split('\n');
  const items: string[] = [];
  if (lines.some((l) => BULLET_RE.test(l))) {
    let current: string | null = null;
    for (const l of lines) {
      if (BULLET_RE.test(l)) {
        if (current != null) items.push(current);
        current = l.replace(BULLET_RE, '');
      } else if (!l.trim()) {
        if (current != null) items.push(current);
        current = null;
      } else {
        current = current == null ? l.trim() : `${current} ${l.trim()}`;
      }
    }
    if (current != null) items.push(current);
  } else {
    let current: string[] = [];
    for (const l of lines) {
      if (l.trim()) current.push(l.trim());
      else if (current.length) {
        items.push(current.join(' '));
        current = [];
      }
    }
    if (current.length) items.push(current.join(' '));
  }
  return items.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Lower case, straight quotes, apostrophes dropped, other punctuation and emoji as spaces: for matching only. */
function matchKey(s: string): string {
  return straightenQuotes(s)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .trim();
}

function containsInOrder(hay: string, frags: readonly string[]): boolean {
  let pos = 0;
  for (const f of frags) {
    const idx = hay.indexOf(f, pos);
    if (idx < 0) return false;
    pos = idx + f.length;
  }
  return true;
}

/** 1-based body lines a quote matches; "…" / "..." in the quote stands for words left out. Tries 1 line, then 2–3. */
export function matchPitchQuote(quote: string, body: string): number[] {
  const frags = straightenQuotes(quote).split(/\.{3}|…/).map(matchKey).filter(Boolean);
  if (!frags.length) return [];
  const keys = normalisePitchText(body).split('\n').map(matchKey);
  const hits: number[] = [];
  keys.forEach((k, i) => {
    if (k && containsInOrder(k, frags)) hits.push(i + 1);
  });
  if (hits.length || frags.length < 2) return hits;
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i] || !keys[i]!.includes(frags[0]!)) continue;
    const window: number[] = [i];
    for (let k = i + 1; k < keys.length && window.length < 3; k++) {
      if (!keys[k]) continue;
      window.push(k);
      if (containsInOrder(window.map((w) => keys[w]).join(' '), frags)) return window.map((w) => w + 1);
    }
  }
  return [];
}

function cleanNote(text: string): string {
  const t = text
    .replace(/\(?\s*\bSources?:?\s*https?:\/\/[^\s)<>"”]+\s*\)?/gi, ' ')
    .replace(/\(?\s*https?:\/\/[^\s)<>"”]+\s*\)?/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\bSources?:\s*$/i, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.–—-]+/, '')
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** Split the fact-check notes into notes matched to the script lines they quote. */
export function parsePitchFacts(facts: string | null, body: string): PitchFact[] {
  if (!facts || !facts.trim()) return [];
  return splitFactItems(facts).map((item) => {
    const lead = LEAD_QUOTES_RE.exec(item);
    const quotes = lead ? [...lead[1]!.matchAll(QUOTE_RE)].map((m) => m[1]!.trim()).filter(Boolean) : [];
    let rest = lead ? item.slice(lead[0].length) : item;
    const sources = [...new Set([...rest.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:]+$/, '')))];
    const sug = SUGGESTION_RE.exec(rest);
    const suggestion = sug ? sug[1]!.trim() : null;
    if (sug) rest = rest.replace(sug[0], ' ');
    const note = cleanNote(rest);
    const tone: PitchFactTone = quotes.length === 0 ? 'info' : VERIFIED_RE.test(note) ? 'verified' : 'check';
    const lines = [...new Set(quotes.flatMap((q) => matchPitchQuote(q, body)))].sort((a, b) => a - b);
    return { quote: quotes[0] ?? null, quotes, note, suggestion, tone, sources, lines };
  });
}
