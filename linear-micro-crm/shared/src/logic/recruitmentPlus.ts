/**
 * Release 1.3 — OWNED BY P7 recruitment-plus (laid down by r3-foundation). Pure rules for the recruitment additions:
 * a candidate's age from the date of birth and the "Under 18" warning, the readable wording of every interview change,
 * the candidate timeline (who moved each stage, every interview, reassignments, reschedules, outcomes) and its order,
 * the interview sheet's draft questions and counts, the schedule's day groups and ranges, and the question bank's
 * gentle check for questions about protected characteristics. Used by the server and the client alike.
 */
import { POSITION_LABELS, STAGE_LABELS } from '../constants.ts';
import type { CandidateStage, Interview, Position, StageChange } from '../types.ts';
import {
  CANDIDATE_ADULT_AGE,
  CANDIDATE_MAX_AGE,
  CANDIDATE_MIN_AGE,
  type CandidateTimelineItem,
  type CandidateTimelineKind,
  type InterviewAnswer,
  type InterviewAnswerInput,
  type InterviewAnswerValue,
  type InterviewChange,
  type InterviewOutcome,
  type InterviewQuestion,
  type InterviewSheetSummary,
  type InterviewType,
} from '../types/recruitmentPlus.ts';
import { addDays, dayOfWeek, isValidISODate, startOfWeekISO } from './dates.ts';
import { businessDateOf } from './recruitment.ts';

// ───────────────────────────── date of birth ─────────────────────────────

/** Whole years between `dateOfBirth` and `today` (both YYYY-MM-DD); null when either is not a valid date. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  if (!isValidISODate(dateOfBirth) || !isValidISODate(today) || dateOfBirth > today) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** True when the candidate is under 18 on `today`. */
export function isUnderAge(dateOfBirth: string, today: string): boolean {
  const age = ageOn(dateOfBirth, today);
  return age !== null && age < CANDIDATE_ADULT_AGE;
}

/**
 * Why a date of birth cannot be saved, or null when it can: a real `YYYY-MM-DD` date, not in the future, giving an age
 * from CANDIDATE_MIN_AGE (14) to CANDIDATE_MAX_AGE (100) on `today` — anything else is almost always a typo in the year.
 * Under 18 is allowed (the profile warns).
 */
export function dateOfBirthProblem(dateOfBirth: string, today: string): string | null {
  if (!isValidISODate(dateOfBirth)) return 'Enter the date of birth as a real date';
  if (dateOfBirth > today) return 'A date of birth cannot be in the future';
  const age = ageOn(dateOfBirth, today);
  if (age === null) return 'Enter the date of birth as a real date';
  if (age < CANDIDATE_MIN_AGE) return `That makes them ${age}. Check the year: candidates are at least ${CANDIDATE_MIN_AGE}`;
  if (age > CANDIDATE_MAX_AGE) return `That makes them ${age}. Check the year`;
  return null;
}

// ───────────────────────────── words ─────────────────────────────

/** Interview types in the order a candidate meets them. */
export const INTERVIEW_TYPE_ORDER: readonly InterviewType[] = ['phone', 'first', 'observation', 'final'];

/** The same words as the client's labels (lib/labels.ts INTERVIEW_TYPE_LABELS). */
export const INTERVIEW_TYPE_NAMES: Record<InterviewType, string> = {
  phone: 'Phone screen',
  first: 'First interview',
  observation: 'Observation day',
  final: 'Final interview',
};

export const INTERVIEW_OUTCOME_NAMES: Record<InterviewOutcome, string> = {
  pending: 'Pending',
  passed: 'Passed',
  failed: 'Failed',
  no_show: 'No show',
};

export function isInterviewType(value: unknown): value is InterviewType {
  return typeof value === 'string' && (INTERVIEW_TYPE_ORDER as readonly string[]).includes(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let londonParts: Intl.DateTimeFormat | null = null;

/** "2026-10-22" → "Thu 22 Oct" (with the year when it is not `todayYear`'s). */
export function dayLabel(date: string, today?: string): string {
  if (!isValidISODate(date)) return date;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const year = today && today.slice(0, 4) !== String(y) ? ` ${y}` : '';
  return `${WEEKDAYS[dayOfWeek(date)]} ${d} ${MONTHS[m - 1]}${year}`;
}

/**
 * An instant as Europe/London wall-clock words: "Thu 22 Oct, 10:00" (with the year when it is not the year of
 * `today`, YYYY-MM-DD). The raw value when it cannot be read.
 */
export function businessWhenLabel(iso: string, today?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  londonParts ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of londonParts.formatToParts(d)) p[part.type] = part.value;
  return `${dayLabel(`${p.year}-${p.month}-${p.day}`, today)}, ${p.hour}:${p.minute}`;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ───────────────────────────── interview changes ─────────────────────────────

/** How to read the stored values of a change: interviewer ids → names, instants → London time. */
export interface ChangeLabelContext {
  nameOf(id: number): string | null;
  today?: string;
}

/** The readable from / to of one interview_changes row ("Amelia Hart", "Thu 22 Oct, 10:00", "First interview", "Passed"). */
export function interviewChangeLabels(change: Pick<InterviewChange, 'field' | 'fromValue' | 'toValue'>, ctx: ChangeLabelContext): { fromLabel: string | null; toLabel: string | null } {
  const label = (v: string | null): string | null => {
    if (v === null || v === '') return null;
    switch (change.field) {
      case 'interviewer': {
        const id = Number(v);
        return Number.isInteger(id) && id > 0 ? (ctx.nameOf(id) ?? 'a former colleague') : null;
      }
      case 'scheduled_at':
      case 'booked':
        return businessWhenLabel(v, ctx.today);
      case 'type':
        return INTERVIEW_TYPE_NAMES[v as InterviewType] ?? v;
      case 'outcome':
        return INTERVIEW_OUTCOME_NAMES[v as InterviewOutcome] ?? v;
    }
  };
  return { fromLabel: label(change.fromValue), toLabel: label(change.toValue) };
}

/**
 * One change as a sentence, named for its interview (`type`, the interview's type now):
 *   booked        "First interview booked for Thu 22 Oct, 10:00 by Priya Shah"
 *   interviewer   "First interview: interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah"
 *   scheduled_at  "First interview moved from Thu 22 Oct, 10:00 to Fri 23 Oct, 14:00 by Priya Shah"
 *   type          "Phone screen changed to first interview by Priya Shah"
 *   outcome       "First interview outcome recorded as passed by Amelia Hart" (or "changed from passed to failed")
 */
export function interviewChangeText(
  change: Pick<InterviewChange, 'field' | 'fromLabel' | 'toLabel' | 'changedByName'>,
  type: InterviewType,
): string {
  const name = INTERVIEW_TYPE_NAMES[type];
  const by = change.changedByName ? ` by ${change.changedByName}` : '';
  const from = change.fromLabel ?? null;
  const to = change.toLabel ?? null;
  switch (change.field) {
    case 'booked':
      return `${name} booked${to ? ` for ${to}` : ''}${by}`;
    case 'interviewer':
      if (from && to) return `${name}: interviewer changed from ${from} to ${to}${by}`;
      if (to) return `${name}: ${to} set as the interviewer${by}`;
      return `${name}: ${from ?? 'the interviewer'} taken off as the interviewer${by}`;
    case 'scheduled_at':
      return from ? `${name} moved from ${from} to ${to ?? 'a new time'}${by}` : `${name} moved to ${to ?? 'a new time'}${by}`;
    case 'type':
      return `${from ?? name} changed to ${lower(to ?? name)}${by}`;
    case 'outcome':
      if (!from || from === INTERVIEW_OUTCOME_NAMES.pending) return `${name} outcome recorded as ${lower(to ?? 'pending')}${by}`;
      return `${name} outcome changed from ${lower(from)} to ${lower(to ?? 'pending')}${by}`;
  }
}

// ───────────────────────────── the candidate timeline ─────────────────────────────

const KIND_RANK: Record<CandidateTimelineKind, number> = { applied: 0, stage: 1, booked: 2, interviewer: 3, reschedule: 3, interview: 4, outcome: 5 };
const OPEN_ORDER: CandidateStage[] = ['applied', 'screening', 'interview', 'observation', 'offer', 'hired'];

/** A stage move as a sentence: "Moved from Applied to Phone screen by Priya Shah", "Rejected at Interview by …". */
export function stageChangeText(change: Pick<StageChange, 'fromStage' | 'toStage' | 'changedByName'>, positionApplied?: Position): string {
  const by = change.changedByName ? ` by ${change.changedByName}` : '';
  const from = change.fromStage;
  const to = change.toStage;
  if (from === null) {
    const role = positionApplied ? ` for the ${POSITION_LABELS[positionApplied]} position` : '';
    return `Applied${role}${change.changedByName ? ` (added by ${change.changedByName})` : ''}`;
  }
  if (from === 'rejected' || from === 'withdrawn') return `Reopened at ${STAGE_LABELS[to]}${by}`;
  if (to === 'rejected') return `Rejected at ${STAGE_LABELS[from]}${by}`;
  if (to === 'withdrawn') return `Withdrew at ${STAGE_LABELS[from]}${change.changedByName ? ` (recorded by ${change.changedByName})` : ''}`;
  if (to === 'hired') return `Hired${by}`;
  if (OPEN_ORDER.indexOf(to) < OPEN_ORDER.indexOf(from)) return `Moved back from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}${by}`;
  return `Moved from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}${by}`;
}

/** An interview as a sentence: "First interview with Amelia Hart" ("… (no interviewer set)"). */
export function interviewText(iv: Pick<Interview, 'type' | 'interviewerName'>): string {
  return `${INTERVIEW_TYPE_NAMES[iv.type]}${iv.interviewerName ? ` with ${iv.interviewerName}` : ' (no interviewer set)'}`;
}

export interface CandidateTimelineInput {
  positionApplied?: Position;
  stageChanges: readonly Pick<StageChange, 'id' | 'fromStage' | 'toStage' | 'changedAt' | 'changedById' | 'changedByName' | 'note'>[];
  interviews: readonly Pick<Interview, 'id' | 'type' | 'scheduledAt' | 'interviewerId' | 'interviewerName' | 'outcome' | 'notes'>[];
  /** interview_changes rows of those interviews (labels are filled in here from `nameOf`). */
  changes: readonly Pick<InterviewChange, 'id' | 'interviewId' | 'field' | 'fromValue' | 'toValue' | 'changedBy' | 'changedByName' | 'changedAt'>[];
  /** Interviewer ids in `changes` → names (people who left keep their name). */
  nameOf(id: number): string | null;
  /** YYYY-MM-DD: years are written only for other years. */
  today?: string;
}

interface Ranked {
  item: CandidateTimelineItem;
  ms: number;
  rank: number;
  seq: number;
}

/**
 * Everything that happened to a candidate, newest first: every stage move with who made it (stage_changes.changed_by_id),
 * every interview at its time with its interviewer and outcome (upcoming ones first), and every booking, reassignment,
 * reschedule, change of type and outcome recorded in interview_changes. Ties at the same instant keep the story's order
 * (applied, stage, booked, interviewer / reschedule, interview, outcome — newest first, so an outcome sits above its
 * interview), then the later row first.
 */
export function buildCandidateTimeline(input: CandidateTimelineInput): CandidateTimelineItem[] {
  const rows: Ranked[] = [];
  const push = (item: CandidateTimelineItem, seq: number) => {
    const ms = Date.parse(item.at);
    rows.push({ item, ms: Number.isNaN(ms) ? 0 : ms, rank: KIND_RANK[item.kind], seq });
  };
  for (const s of input.stageChanges) {
    push(
      {
        at: s.changedAt,
        kind: s.fromStage === null ? 'applied' : 'stage',
        text: stageChangeText(s, input.positionApplied),
        byId: s.changedById,
        byName: s.changedByName ?? null,
        detail: s.note ?? null,
        stage: s.toStage,
      },
      s.id,
    );
  }
  const typeOf = new Map<number, InterviewType>();
  for (const iv of input.interviews) {
    typeOf.set(iv.id, iv.type);
    push(
      {
        at: iv.scheduledAt,
        kind: 'interview',
        text: interviewText(iv),
        byId: iv.interviewerId,
        byName: iv.interviewerName ?? null,
        interviewId: iv.id,
        detail: iv.notes ?? null,
        outcome: iv.outcome,
      },
      iv.id,
    );
  }
  const KIND_OF: Record<InterviewChange['field'], CandidateTimelineKind> = {
    booked: 'booked', interviewer: 'interviewer', scheduled_at: 'reschedule', type: 'interview', outcome: 'outcome',
  };
  for (const c of input.changes) {
    const type = typeOf.get(c.interviewId);
    if (!type) continue;
    const labels = interviewChangeLabels(c, { nameOf: input.nameOf, today: input.today });
    push(
      {
        at: c.changedAt,
        kind: KIND_OF[c.field],
        text: interviewChangeText({ field: c.field, ...labels, changedByName: c.changedByName ?? null }, type),
        byId: c.changedBy,
        byName: c.changedByName ?? null,
        interviewId: c.interviewId,
      },
      c.id,
    );
  }
  rows.sort((a, b) => b.ms - a.ms || b.rank - a.rank || b.seq - a.seq);
  return rows.map((r) => r.item);
}

// ───────────────────────────── the interview sheet ─────────────────────────────

/** The bank's questions for a sheet that has none saved yet: active, of the type, for every position or this one; ordered. */
export function draftSheetQuestions<Q extends Pick<InterviewQuestion, 'id' | 'interviewType' | 'position' | 'sort' | 'active'>>(
  bank: readonly Q[],
  type: InterviewType,
  position: Position | null,
): Q[] {
  return bank
    .filter((q) => q.active && q.interviewType === type && (q.position === null || q.position === position))
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
}

/** A 1–5 score, or null for anything else. */
export function validScore(score: unknown): number | null {
  return typeof score === 'number' && Number.isInteger(score) && score >= 1 && score <= 5 ? score : null;
}

/**
 * Counts over a sheet: questions, answered (a written answer), scored (a 1–5 score), and the mean of the scores to one
 * decimal place (half up; null when nothing is scored). A score without a written answer still counts as scored.
 */
export function sheetSummary(answers: readonly { answer: string; score: number | null }[]): InterviewSheetSummary {
  let answered = 0;
  let scored = 0;
  let total = 0;
  for (const a of answers) {
    if (a.answer.trim() !== '') answered++;
    const s = validScore(a.score);
    if (s !== null) {
      scored++;
      total += s;
    }
  }
  return { questions: answers.length, answered, scored, averageScore: scored ? Math.round((total / scored) * 10 + 1e-9) / 10 : null };
}

/** Trimmed, with runs of whitespace (and line breaks) as one space: how a question is stored and compared. */
export function normaliseQuestionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Questions about protected characteristics (Equality Act 2010) have no place in an interview. A gentle check for the
 * question bank and the sheet's own questions: the topic a question seems to touch, or null. It warns, never blocks
 * ("health and safety" and "availability" are fine).
 */
export function questionTopicWarning(text: string): string | null {
  const t = ` ${normaliseQuestionText(text).toLowerCase().replace(/[’‘]/g, "'")} `
    // The agency's own clients and causes are not questions about anyone's family: Children's Hospice North, a children's charity.
    .replace(/\bchildren'?s'? (hospice|charit(y|ies)|cause)/g, ' ');
  const checks: [RegExp, string][] = [
    [/\b(how old (are|were|will) you|your age|age are you|date of birth|year (were you|you were) born|when were you born|retire|(year|when) (did |have )?you (leave|left|finish|finished|graduate|graduated)( from)? (school|college|sixth form|uni|university)|graduat(e|ion) year|year (did )?you graduate)/, 'age'],
    [/\bhealth\b(?!\s*(and|&)\s*safety)|\b(disab|illness|medical|medication|sick (days|leave|record)|mental health|injur)/, 'health'],
    [/\b(pregnan|maternity|paternity|children|kids|childcare|bab(y|ies)\b|married|marital|husband|wife|spouse|civil partner|family plans|start a family)|\b(your partner|(have|got|live with) a partner)\b/, 'family'],
    [/\b(religio|church|mosque|synagogue|temple|pray(s|ed|ing|er|ers)?\b|faiths?\b)/, 'religion'],
    [/\b(where are you (really )?from|nationality|native (language|speaker)|first language|your second language|english (is not|isn't) your|mother tongue|accent|ethnic|race\b)/, 'nationality or race'],
    [/\b(sexual|sexuality|gay|lesbian|transgender|gender identity|boyfriend|girlfriend)/, 'sexual orientation or gender'],
    [/\b(trade union|union member)/, 'trade union membership'],
  ];
  for (const [re, topic] of checks) if (re.test(t)) return topic;
  return null;
}

// ───────────────────────────── one sheet open on more than one device ─────────────────────────────
//
// The sheet page saves only what it changed, each question with the answer and score it started from (its `base`).
// The server leaves a question whose answer equals its base as it is (another device's newer words stand) and writes a
// changed one only while the stored row still equals the base — else 409, and the page shows both versions. After each
// save (and each refetch) the page takes in what other devices wrote to questions it has not touched.
// Each save also carries the tab's device id and save number, and the server stamps the rows it writes with them: a
// question this device wrote last is never a conflict for it (its own save still on its way when the next one was
// built, as a tab closes or reloads mid-save), on the server or in mergeSheetRows.

/** How the page and the server match a question: a bank question by its id, a question of the interviewer's own by its words. */
export function sheetQuestionKey(questionId: number | null, questionText: string): string {
  return questionId !== null ? `q${questionId}` : `own:${normaliseQuestionText(questionText).toLowerCase()}`;
}

/** The same answer (spaces at either end do not count, as the server trims them) and the same score. */
export function sameAnswer(a: InterviewAnswerValue, b: InterviewAnswerValue): boolean {
  return a.answer.trim() === b.answer.trim() && (a.score ?? null) === (b.score ?? null);
}

const BLANK_ANSWER: InterviewAnswerValue = { answer: '', score: null };

/** Another device's version of a question this device has changed too, until the interviewer chooses. */
export interface SheetConflict extends InterviewAnswerValue {
  byName: string | null;
  at: string | null;
}

/** One question as the sheet page holds it. */
export interface SheetEditRow extends InterviewAnswerValue {
  key: string;
  questionId: number | null;
  questionText: string;
  /** The stored answer and score this device last saw (blank while the question is not stored). */
  base: InterviewAnswerValue;
  /** Stored on the server (false: the bank's draft, or a question added on this device and not saved yet). */
  stored: boolean;
  /** Added on this device and not stored yet. */
  added: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  conflict: SheetConflict | null;
}

function editRow(a: InterviewAnswer): SheetEditRow {
  const value = { answer: a.answer, score: a.score ?? null };
  return {
    key: sheetQuestionKey(a.questionId, a.questionText), questionId: a.questionId, questionText: a.questionText, ...value, base: value,
    stored: a.id !== undefined, added: false, updatedAt: a.updatedAt, updatedByName: a.updatedByName ?? null, conflict: null,
  };
}

/** The page's rows for a sheet from the server (the bank's draft, or the questions as asked). */
export function sheetEditRows(sheet: { answers: readonly InterviewAnswer[] }): SheetEditRow[] {
  return sheet.answers.map(editRow);
}

/** A question of the interviewer's own, added on this device. */
export function newSheetRow(questionText: string): SheetEditRow {
  const text = normaliseQuestionText(questionText);
  return { key: sheetQuestionKey(null, text), questionId: null, questionText: text, ...BLANK_ANSWER, base: BLANK_ANSWER, stored: false, added: true, updatedAt: null, updatedByName: null, conflict: null };
}

/** Changed on this device since it last saw the stored row. */
export const sheetRowChanged = (r: SheetEditRow): boolean => !sameAnswer(r, r.base);

/** Who sends a save: the tab's device id and this save's number (rising with each save from the tab). */
export interface SheetSaveFrom {
  device: string;
  version: number;
}

/**
 * What the next save sends. Until the sheet is saved anywhere (`saved` false) every question goes, so the first save
 * fixes the questions; after that only the questions changed or added here and the ones taken off here. A question in
 * conflict waits for the interviewer's choice.
 * `inFlight`: what the save still on its way sent, by key; a question changed since then goes too, even when it is back
 * to its base (typed, sent, then rubbed out). `from`: stamped on every item (device id and save number).
 */
export function sheetSavePayload(
  rows: readonly SheetEditRow[],
  removed: readonly SheetEditRow[],
  saved: boolean,
  opts: { inFlight?: ReadonlyMap<string, InterviewAnswerValue>; from?: SheetSaveFrom } = {},
): InterviewAnswerInput[] {
  const out: InterviewAnswerInput[] = [];
  const from = opts.from ? { device: opts.from.device, version: opts.from.version } : {};
  for (const r of rows) {
    if (r.conflict) continue;
    const sent = opts.inFlight?.get(r.key);
    if (saved && !r.added && !sheetRowChanged(r) && !(sent && !sameAnswer(sent, r))) continue;
    out.push({ questionId: r.questionId, questionText: r.questionText, answer: r.answer, score: r.score, base: r.base, ...from });
  }
  for (const r of removed) out.push({ questionId: r.questionId, questionText: r.questionText, answer: '', score: null, base: r.base, removed: true, ...from });
  return out;
}

/**
 * The page's rows after the server answered (a save, a 409 or a refetch): the server's questions in its order, then
 * questions this device holds that the server does not (added here, or typed into after another device took them off,
 * so nothing typed is lost). Per question:
 *  - the same as stored → in step (base = stored);
 *  - what is stored is this device's own save (what the save this answers sent, or a row stamped with one of `own`,
 *    this tab's device ids) → kept, base = stored (typed more since, or rubbed out back to the old words);
 *  - stored still equals the base → only this device changed it: kept;
 *  - not changed here → another device's words are taken in;
 *  - else both changed it → kept, with the other device's version as `conflict` (the row keeps its own "last changed"
 *    details: the box holds this device's words; the conflict says who wrote the other version, and when).
 * `sent`: what the save that this answers sent, by key. `removed`: questions taken off here and not saved yet.
 * While nothing is stored anywhere (a draft) the rows are kept if anything was changed here, else the bank's draft now.
 */
export function mergeSheetRows(
  local: readonly SheetEditRow[],
  server: { answers: readonly InterviewAnswer[]; saved: boolean },
  opts: { sent?: ReadonlyMap<string, InterviewAnswerValue>; removed?: ReadonlySet<string>; own?: ReadonlySet<string> } = {},
): SheetEditRow[] {
  if (!server.saved) {
    const touched = local.some((r) => r.added || sheetRowChanged(r)) || (opts.removed?.size ?? 0) > 0;
    return touched ? [...local] : sheetEditRows(server);
  }
  const mine = new Map(local.map((r) => [r.key, r]));
  const theirs = new Set<string>();
  const out: SheetEditRow[] = [];
  for (const a of server.answers) {
    const key = sheetQuestionKey(a.questionId, a.questionText);
    theirs.add(key);
    if (opts.removed?.has(key)) continue;
    const r = mine.get(key);
    if (!r) {
      out.push(editRow(a));
      continue;
    }
    const stored = { answer: a.answer, score: a.score ?? null };
    const meta = { questionText: a.questionText, stored: true, added: false, updatedAt: a.updatedAt, updatedByName: a.updatedByName ?? null };
    const sent = opts.sent?.get(key);
    const ownSave = (sent !== undefined && sameAnswer(sent, stored)) || (a.device != null && (opts.own?.has(a.device) ?? false));
    if (sameAnswer(r, stored)) out.push({ ...r, ...meta, base: stored, conflict: null });
    else if (ownSave) out.push({ ...r, ...meta, base: stored, conflict: null });
    else if (sameAnswer(r.base, stored)) out.push({ ...r, ...meta, conflict: null });
    else if (!sheetRowChanged(r)) out.push({ ...r, ...meta, ...stored, base: stored, conflict: null });
    else out.push({ ...r, questionText: a.questionText, stored: true, added: false, conflict: { ...stored, byName: a.updatedByName ?? null, at: a.updatedAt } });
  }
  for (const r of local) {
    if (theirs.has(r.key)) continue;
    if (r.added || sheetRowChanged(r)) out.push({ ...r, stored: false, added: true, conflict: null });
  }
  return out;
}

/** "Last changed by Rhys Morgan, Thu 22 Oct, 10:42" under an answer; null while nobody has written it. */
export function answerChangedLabel(a: { updatedAt: string | null; updatedByName?: string | null }, today?: string): string | null {
  if (!a.updatedAt) return null;
  return `Last changed${a.updatedByName ? ` by ${a.updatedByName}` : ''}, ${businessWhenLabel(a.updatedAt, today)}`;
}

/** The 409's words: "Question 3 was changed by Rhys Morgan on another device. Choose which answer to keep." */
export function sheetConflictMessage(conflicts: readonly { number: number; byName: string | null }[]): string {
  if (conflicts.length === 1) {
    const c = conflicts[0]!;
    return `Question ${c.number} was changed${c.byName ? ` by ${c.byName}` : ''} on another device. Choose which answer to keep.`;
  }
  const numbers = conflicts.map((c) => c.number).sort((a, b) => a - b);
  const list = `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
  return `Questions ${list} were changed on another device. Choose which answers to keep.`;
}

/**
 * The page was left with questions in conflict (their words are kept on this device until the sheet is opened again):
 * "Your answer to question 3 was not saved: Amelia Hart changed it on another device. Open the sheet to choose which
 * to keep."
 */
export function sheetLeftConflictMessage(conflicts: readonly { number: number; byName: string | null }[]): string {
  const sorted = [...conflicts].sort((a, b) => a.number - b.number);
  if (sorted.length === 1) {
    const c = sorted[0]!;
    return `Your answer to question ${c.number} was not saved: ${c.byName ?? 'someone'} changed it on another device. Open the sheet to choose which to keep.`;
  }
  const numbers = sorted.map((c) => c.number);
  return `Your answers to questions ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)} were not saved: they were changed on another device. Open the sheet to choose which to keep.`;
}

// ───────────────────────────── the schedule ─────────────────────────────

/** The schedule's quick ranges: today, this week (Mon–Sun) and next week. */
export type ScheduleRangePreset = 'today' | 'this_week' | 'next_week';

export function scheduleRange(preset: ScheduleRangePreset, today: string): { from: string; to: string } {
  if (preset === 'today') return { from: today, to: today };
  const monday = startOfWeekISO(today);
  const from = preset === 'this_week' ? monday : addDays(monday, 7);
  return { from, to: addDays(from, 6) };
}

/** The Europe/London date of an interview (YYYY-MM-DD), for grouping by day; '' when unreadable. */
export function interviewDay(scheduledAt: string): string {
  return businessDateOf(scheduledAt) ?? '';
}

/** Interviews by London day, days in order and each day's interviews by time. */
export function groupScheduleByDay<T extends { scheduledAt: string; day?: string }>(items: readonly T[]): { day: string; items: T[] }[] {
  const byDay = new Map<string, T[]>();
  for (const it of items) {
    const day = it.day || interviewDay(it.scheduledAt);
    const list = byDay.get(day) ?? [];
    list.push(it);
    byDay.set(day, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({ day, items: list.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)) }));
}
