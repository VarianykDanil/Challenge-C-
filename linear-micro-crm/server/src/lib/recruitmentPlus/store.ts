/**
 * Release 1.3 — OWNED BY P7 recruitment-plus. The reads and writes behind routes/recruitmentPlus.ts and P7's additions
 * to routes/recruitment.ts: the question bank, the interview change log (bookings, reassignments, reschedules, changes
 * of type, outcomes), the interview sheet (draft from the bank until the first save, then the questions as asked),
 * the candidate timeline and the interview schedule. Grouped queries only (no per-row loops); recruitment roles only
 * (the routes check).
 */
import {
  buildCandidateTimeline,
  draftSheetQuestions,
  interviewChangeLabels,
  interviewDay,
  INTERVIEW_SHEET_MAX_QUESTIONS,
  INTERVIEW_TYPE_ORDER,
  normaliseQuestionText,
  sheetSummary,
  type CandidateSheet,
  type CandidateTimelineItem,
  type Interview,
  type InterviewAnswer,
  type InterviewAnswerInput,
  type InterviewChange,
  type InterviewChangeField,
  type InterviewQuestion,
  type InterviewScheduleItem,
  type InterviewSheet,
  type InterviewType,
  type Position,
} from '@lm/shared';
import { all, get, placeholders, run, transaction, type Db, type Param } from '../../db/connection.ts';
import { getCandidate, getInterview, listInterviews, listStageChanges } from '../../db/queries.ts';
import { addDays } from '../dates.ts';
import { badRequest } from '../errors.ts';
import { DEFAULT_INTERVIEW_QUESTIONS } from './defaults.ts';

// ───────────────────────────── the question bank ─────────────────────────────

type QuestionRow = Omit<InterviewQuestion, 'active'> & { active: number };

const QUESTION_SELECT = `SELECT id, interview_type AS interviewType, position, text, sort, active, created_at AS createdAt, updated_at AS updatedAt FROM interview_questions`;
/** Types in the order a candidate meets them, then the bank's order. */
const TYPE_ORDER_SQL = `CASE interview_type ${INTERVIEW_TYPE_ORDER.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} ELSE 9 END`;

const mapQuestion = (r: QuestionRow): InterviewQuestion => ({ ...r, active: r.active === 1 });

export function listQuestions(db: Db, type?: InterviewType | null): InterviewQuestion[] {
  const where = type ? 'WHERE interview_type = ?' : '';
  return all<QuestionRow>(db, `${QUESTION_SELECT} ${where} ORDER BY ${TYPE_ORDER_SQL}, sort, id`, type ? [type] : []).map(mapQuestion);
}

export function getQuestion(db: Db, id: number): InterviewQuestion | undefined {
  const r = get<QuestionRow>(db, `${QUESTION_SELECT} WHERE id = ?`, [id]);
  return r ? mapQuestion(r) : undefined;
}

/** The next sort value at the end of a type's list. */
export function nextQuestionSort(db: Db, type: InterviewType): number {
  return Number(get<{ n: number | null }>(db, `SELECT MAX(sort) AS n FROM interview_questions WHERE interview_type = ?`, [type])?.n ?? -1) + 1;
}

/** Writes the default bank when the table is empty. Returns how many questions went in. */
export function insertDefaultQuestions(db: Db, at: string): number {
  if (get(db, `SELECT 1 FROM interview_questions LIMIT 1`)) return 0;
  const sortOf = new Map<InterviewType, number>();
  let n = 0;
  for (const d of DEFAULT_INTERVIEW_QUESTIONS) {
    const sort = sortOf.get(d.type) ?? 0;
    sortOf.set(d.type, sort + 1);
    run(db, `INSERT INTO interview_questions (interview_type, position, text, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`, [d.type, d.position, d.text, sort, at, at]);
    n++;
  }
  return n;
}

// ───────────────────────────── the change log ─────────────────────────────

const CHANGE_SELECT = `
  SELECT ic.id, ic.interview_id AS interviewId, ic.field, ic.from_value AS fromValue, ic.to_value AS toValue,
         ic.changed_by AS changedBy, u.first_name || ' ' || u.last_name AS changedByName, ic.changed_at AS changedAt
  FROM interview_changes ic LEFT JOIN users u ON u.id = ic.changed_by`;

function insertChange(db: Db, interviewId: number, field: InterviewChangeField, from: string | null, to: string | null, by: number | null, at: string): void {
  run(db, `INSERT INTO interview_changes (interview_id, field, from_value, to_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)`, [interviewId, field, from, to, by, at]);
}

/** A new interview: who booked it, for when. */
export function logInterviewBooked(db: Db, interview: Pick<Interview, 'id' | 'scheduledAt'>, by: number, at: string): void {
  insertChange(db, interview.id, 'booked', null, interview.scheduledAt, by, at);
}

const sameInstant = (a: string, b: string) => {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
};

/**
 * One row per field that really changed on PATCH /recruitment/interviews/:id: the interviewer (ids), the time (ISO
 * instants, compared as instants), the type and the outcome. Returns the fields logged.
 */
export function logInterviewChanges(db: Db, before: Interview, after: Interview, by: number, at: string): InterviewChangeField[] {
  const logged: InterviewChangeField[] = [];
  const add = (field: InterviewChangeField, from: string | null, to: string | null) => {
    insertChange(db, after.id, field, from, to, by, at);
    logged.push(field);
  };
  if ((before.interviewerId ?? null) !== (after.interviewerId ?? null)) add('interviewer', before.interviewerId === null ? null : String(before.interviewerId), after.interviewerId === null ? null : String(after.interviewerId));
  if (!sameInstant(before.scheduledAt, after.scheduledAt)) add('scheduled_at', before.scheduledAt, after.scheduledAt);
  if (before.type !== after.type) add('type', before.type, after.type);
  if (before.outcome !== after.outcome) add('outcome', before.outcome, after.outcome);
  return logged;
}

type ChangeRow = Omit<InterviewChange, 'fromLabel' | 'toLabel'>;

function changesOf(db: Db, interviewIds: number[]): ChangeRow[] {
  if (!interviewIds.length) return [];
  return all<ChangeRow>(db, `${CHANGE_SELECT} WHERE ic.interview_id IN (${placeholders(interviewIds.length)}) ORDER BY ic.changed_at, ic.id`, interviewIds);
}

/** Names of the interviewers a set of changes mentions (one query; people who left keep their name). */
function interviewerNames(db: Db, changes: readonly ChangeRow[]): Map<number, string> {
  const ids = new Set<number>();
  for (const c of changes) {
    if (c.field !== 'interviewer') continue;
    for (const v of [c.fromValue, c.toValue]) {
      const id = Number(v);
      if (v !== null && Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  if (!ids.size) return new Map();
  const list = [...ids];
  return new Map(all<{ id: number; name: string }>(db, `SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id IN (${placeholders(list.length)})`, list).map((r) => [r.id, r.name]));
}

function labelled(changes: ChangeRow[], names: Map<number, string>, today: string): InterviewChange[] {
  return changes.map((c) => ({ ...c, ...interviewChangeLabels(c, { nameOf: (id) => names.get(id) ?? null, today }) }));
}

// ───────────────────────────── the candidate timeline ─────────────────────────────

/** Newest first: stage moves with who made them, interviews, and every recorded interview change. Null: no candidate. */
export function candidateTimeline(db: Db, candidateId: number, today: string): CandidateTimelineItem[] | null {
  const candidate = getCandidate(db, candidateId);
  if (!candidate) return null;
  const interviews = listInterviews(db, 'WHERE i.candidate_id = ?', [candidateId]);
  const changes = changesOf(db, interviews.map((i) => i.id));
  const names = interviewerNames(db, changes);
  return buildCandidateTimeline({
    positionApplied: candidate.positionApplied,
    stageChanges: listStageChanges(db, candidateId),
    interviews,
    changes,
    nameOf: (id) => names.get(id) ?? null,
    today,
  });
}

// ───────────────────────────── the interview sheet ─────────────────────────────

interface AnswerRow {
  id: number;
  interviewId: number;
  questionId: number | null;
  questionText: string;
  sort: number;
  answer: string;
  score: number | null;
  updatedAt: string | null;
  updatedById: number | null;
  updatedByName: string | null;
  /** `<user id>:<device id>` of the save that last wrote the row (null: written without a device id). */
  writer: string | null;
  /** That save's number from its device. */
  writerVersion: number | null;
}

const ANSWER_SELECT = `
  SELECT a.id, a.interview_id AS interviewId, a.question_id AS questionId, a.question_text AS questionText, a.sort, a.answer, a.score,
         a.updated_at AS updatedAt, a.updated_by AS updatedById, u.first_name || ' ' || u.last_name AS updatedByName,
         a.device AS writer, a.device_version AS writerVersion
  FROM interview_answers a LEFT JOIN users u ON u.id = a.updated_by`;

/** What is stored in interview_answers.device: the person and their device, so one person can never pass for another. */
const writerKey = (by: number, device: string) => `${by}:${device}`;
/** The device part of a stored writer (what the sheet page compares with its own id). */
const deviceOf = (writer: string | null): string | null => (writer ? writer.slice(writer.indexOf(':') + 1) : null);

function answersOf(db: Db, interviewIds: number[]): AnswerRow[] {
  if (!interviewIds.length) return [];
  return all<AnswerRow>(db, `${ANSWER_SELECT} WHERE a.interview_id IN (${placeholders(interviewIds.length)}) ORDER BY a.interview_id, a.sort, a.id`, interviewIds);
}

const toAnswer = (r: AnswerRow): InterviewAnswer => ({
  interviewId: r.interviewId, questionId: r.questionId, questionText: r.questionText, answer: r.answer, score: r.score, updatedAt: r.updatedAt,
  id: r.id, sort: r.sort, updatedById: r.updatedById, updatedByName: r.updatedByName, device: deviceOf(r.writer),
});

/** The bank's draft for an interview with nothing saved: active questions of its type for every position or the candidate's. */
function draftAnswers(db: Db, interviewId: number, type: InterviewType, position: Position | null): InterviewAnswer[] {
  return draftSheetQuestions(listQuestions(db, type), type, position).map((q, i) => ({
    interviewId, questionId: q.id, questionText: q.text, answer: '', score: null, updatedAt: null, sort: i,
  }));
}

/** GET /recruitment/interviews/:id/sheet. Null: no interview. Reads only (the draft is never written by a read). */
export function interviewSheet(db: Db, interviewId: number, today: string): InterviewSheet | null {
  const interview = getInterview(db, interviewId);
  if (!interview) return null;
  const candidate = getCandidate(db, interview.candidateId);
  if (!candidate) return null;
  const saved = answersOf(db, [interviewId]).map(toAnswer);
  const answers = saved.length ? saved : draftAnswers(db, interviewId, interview.type, candidate.positionApplied);
  const changes = changesOf(db, [interviewId]);
  const name = `${candidate.firstName} ${candidate.lastName}`;
  return {
    interview: { ...interview, candidateName: name },
    answers,
    saved: saved.length > 0,
    candidate: { id: candidate.id, name, stage: candidate.stage, positionApplied: candidate.positionApplied, dateOfBirth: candidate.dateOfBirth ?? null },
    summary: sheetSummary(answers),
    changes: labelled(changes, interviewerNames(db, changes), today),
  };
}

/** A question another device changed (or answered) after this one last saw it: the save is refused (409). */
export interface SheetSaveConflict {
  questionId: number | null;
  questionText: string;
  /** Its place on the sheet, from 1. */
  number: number;
  /** Who last changed it. */
  byName: string | null;
}

/** What PUT /answers did: whether anything was written (an identical save writes nothing), or why nothing was. */
export interface SaveSheetResult {
  changed: boolean;
  /** Non-empty: nothing was written. */
  conflicts: SheetSaveConflict[];
}

const sameValue = (a: { answer: string; score: number | null }, b: { answer: string; score: number | null }) => a.answer === b.answer && (a.score ?? null) === (b.score ?? null);

/**
 * PUT /recruitment/interviews/:id/answers — the sheet page's autosave. Each item is one question, in the order on
 * screen (the order matters only for the first save):
 *  - A bank question is matched by `questionId`, a question of the interviewer's own (questionId null) by its words.
 *  - The first save fixes the questions: every item becomes a row with the words the interviewer had on screen
 *    (`questionText`, else the bank's words now). A stored question keeps its words for good, whatever a later save or
 *    a bank edit says.
 *  - After that a save holds only what the device changed: questions left out stay exactly as they are, and a question
 *    comes off only with `removed: true`. A new question goes at the end; the order of stored ones never changes.
 *  - `base` (the answer and score the device started from) makes each write safe when the sheet is open on two
 *    devices: an item equal to its base is left alone (the stored, newer words stand); a changed one is written only
 *    while the stored row still equals the base. Otherwise it is a conflict, and if there is any, nothing is written.
 *    An item already equal to the stored row is never a conflict (the same save arriving twice).
 *  - `device` + `version` make a device's own saves idempotent: when the stored row was last written by the same
 *    person from the same device, the base is not checked. A later save from it (higher version) is written — it was
 *    built from newer words on that screen while the earlier save was on its way (a tab closed or reloaded mid-save) —
 *    and an older or repeated one (lower or equal version, arriving late) leaves the row as it is. Rows written are
 *    stamped with the device and version (blank rows of a first save too, so a late older save never fills them), and
 *    so is a row a save finds already holding its words (that is not a change: no author, time or audit row).
 *  - Only rows whose answer or score changed are written, with who and when; an identical save writes nothing.
 * Throws 400 for an unknown bank question, a question twice, a question of their own without words, or a sheet left
 * with no question or more than INTERVIEW_SHEET_MAX_QUESTIONS.
 */
export function saveInterviewAnswers(db: Db, interviewId: number, inputs: readonly InterviewAnswerInput[], by: number, at: string): SaveSheetResult {
  const bankIds = [...new Set(inputs.map((i) => i.questionId).filter((id): id is number => id !== null))];
  const bank = new Map(
    bankIds.length ? all<{ id: number; text: string }>(db, `SELECT id, text FROM interview_questions WHERE id IN (${placeholders(bankIds.length)})`, bankIds).map((r) => [r.id, r.text]) : [],
  );
  const seenIds = new Set<number>();
  const seenTexts = new Set<string>();
  const wanted = inputs.map((input, index) => {
    const text = input.questionText === undefined ? '' : normaliseQuestionText(input.questionText);
    if (input.questionId !== null) {
      if (!bank.has(input.questionId)) throw badRequest(`Unknown question ${input.questionId}`);
      if (seenIds.has(input.questionId)) throw badRequest('A question is on the sheet twice');
      seenIds.add(input.questionId);
    } else {
      if (!text) throw badRequest('A question of your own needs its words');
      if (seenTexts.has(text.toLowerCase())) throw badRequest(`"${text}" is on the sheet twice`);
      seenTexts.add(text.toLowerCase());
    }
    return {
      questionId: input.questionId, text, answer: input.answer.trim(), score: input.score ?? null, index,
      base: input.base ? { answer: input.base.answer.trim(), score: input.base.score ?? null } : null,
      removed: input.removed === true,
      writer: input.device ? writerKey(by, input.device) : null,
      version: input.device && input.version !== undefined ? input.version : null,
    };
  });
  /** The stored row was last written by this person from this device: newer (true), older or the same save (false). */
  const ownSave = (row: AnswerRow, w: (typeof wanted)[number]): boolean | null =>
    w.writer !== null && w.version !== null && row.writer === w.writer && row.writerVersion !== null ? w.version > row.writerVersion : null;

  return transaction(db, () => {
    const stored = answersOf(db, [interviewId]);
    const fresh = stored.length === 0;
    const byQuestion = new Map(stored.filter((r) => r.questionId !== null).map((r) => [r.questionId!, r]));
    const byText = new Map(stored.filter((r) => r.questionId === null).map((r) => [normaliseQuestionText(r.questionText).toLowerCase(), r]));
    const numberOf = new Map(stored.map((r, i) => [r.id, i + 1]));
    const conflicts: SheetSaveConflict[] = [];
    const conflict = (row: AnswerRow) => conflicts.push({ questionId: row.questionId, questionText: row.questionText, number: numberOf.get(row.id)!, byName: row.updatedByName });
    const updates: { row: AnswerRow; answer: string; score: number | null; writer: string | null; version: number | null }[] = [];
    const deletes: AnswerRow[] = [];
    const inserts: typeof wanted = [];
    const stamps: { row: AnswerRow; writer: string; version: number | null }[] = [];

    for (const w of wanted) {
      const row = w.questionId !== null ? byQuestion.get(w.questionId) : byText.get(w.text.toLowerCase());
      const own = row ? ownSave(row, w) : null;
      if (w.removed) {
        if (!row || own === false) continue; // gone already, or this device wrote it again since
        if (own === null && w.base && !sameValue(row, w.base)) conflict(row);
        else deletes.push(row);
        continue;
      }
      if (row) {
        if (sameValue(row, w)) {
          // Already so: noted as this device's latest save, so a late older one cannot change it back.
          if (own !== false && w.writer !== null && (row.writer !== w.writer || row.writerVersion !== w.version)) stamps.push({ row, writer: w.writer, version: w.version });
          continue;
        }
        if (own === false) continue; // this device's own newer save is stored: a late older one changes nothing
        if (own === null && w.base && sameValue(w.base, w)) continue; // not changed on this device: the stored, newer words stand
        if (own === null && w.base && !sameValue(w.base, row)) {
          conflict(row);
          continue;
        }
        updates.push({ row, answer: w.answer, score: w.score, writer: w.writer, version: w.version });
        continue;
      }
      // A bank question the saved sheet does not hold, sent unchanged (an older draft, or one taken off elsewhere).
      if (!fresh && w.questionId !== null && w.base && sameValue(w.base, w)) continue;
      inserts.push(w);
    }
    if (conflicts.length) return { changed: false, conflicts: conflicts.sort((a, b) => a.number - b.number) };

    const total = stored.length - deletes.length + inserts.length;
    if (total < 1) throw badRequest('A sheet keeps at least one question');
    if (total > INTERVIEW_SHEET_MAX_QUESTIONS) throw badRequest(`A sheet holds at most ${INTERVIEW_SHEET_MAX_QUESTIONS} questions`);

    for (const u of updates) {
      run(db, `UPDATE interview_answers SET answer = ?, score = ?, updated_at = ?, updated_by = ?, device = ?, device_version = ? WHERE id = ?`, [u.answer, u.score, at, by, u.writer, u.version, u.row.id]);
    }
    for (const t of stamps) run(db, `UPDATE interview_answers SET device = ?, device_version = ? WHERE id = ?`, [t.writer, t.version, t.row.id]);
    for (const r of deletes) run(db, `DELETE FROM interview_answers WHERE id = ?`, [r.id]);
    let nextSort = stored.reduce((m, r) => Math.max(m, r.sort), -1) + 1;
    for (const w of inserts) {
      const questionText = w.questionId !== null ? (w.text || bank.get(w.questionId)!) : w.text;
      const blank = w.answer === '' && w.score === null;
      run(
        db,
        `INSERT INTO interview_answers (interview_id, question_id, question_text, sort, answer, score, updated_at, updated_by, device, device_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [interviewId, w.questionId, questionText, fresh ? w.index : nextSort++, w.answer, w.score, blank ? null : at, blank ? null : by, w.writer, w.version],
      );
    }
    return { changed: updates.length + deletes.length + inserts.length > 0, conflicts: [] };
  });
}

/** GET /recruitment/candidates/:id/sheets — every interview of the candidate with a saved sheet, in date order. */
export function candidateSheets(db: Db, candidateId: number): CandidateSheet[] {
  const interviews = listInterviews(db, 'WHERE i.candidate_id = ?', [candidateId]);
  const answers = answersOf(db, interviews.map((i) => i.id));
  const byInterview = new Map<number, InterviewAnswer[]>();
  for (const r of answers) {
    const list = byInterview.get(r.interviewId) ?? [];
    list.push(toAnswer(r));
    byInterview.set(r.interviewId, list);
  }
  return interviews
    .filter((iv) => byInterview.has(iv.id))
    .map((iv) => {
      const list = byInterview.get(iv.id)!;
      return {
        interviewId: iv.id, type: iv.type, scheduledAt: iv.scheduledAt, interviewerId: iv.interviewerId, interviewerName: iv.interviewerName ?? null,
        outcome: iv.outcome, answers: list, summary: sheetSummary(list),
      };
    });
}

// ───────────────────────────── the schedule ─────────────────────────────

export interface ScheduleQuery {
  from: string;
  to: string;
  /** A person, 'none' (no interviewer) or null (everyone). */
  interviewerId: number | 'none' | null;
  type: InterviewType | null;
  candidateId?: number | null;
}

/**
 * Interviews whose Europe/London date is in [from, to], by time, with the candidate's name, stage and position and the
 * sheet's progress (saved questions, else the bank's draft count for the type and position). One query for the
 * interviews (a UTC window one day wider each side, then trimmed by London date), one for the bank.
 */
export function scheduleItems(db: Db, q: ScheduleQuery): InterviewScheduleItem[] {
  const where: string[] = [`i.scheduled_at >= ?`, `i.scheduled_at < ?`];
  const params: Param[] = [`${addDays(q.from, -1)}T00:00:00.000Z`, `${addDays(q.to, 2)}T00:00:00.000Z`];
  if (q.interviewerId === 'none') where.push('i.interviewer_id IS NULL');
  else if (q.interviewerId !== null) {
    where.push('i.interviewer_id = ?');
    params.push(q.interviewerId);
  }
  if (q.type) {
    where.push('i.type = ?');
    params.push(q.type);
  }
  if (q.candidateId) {
    where.push('i.candidate_id = ?');
    params.push(q.candidateId);
  }
  const rows = all<Interview & { candidateName: string; candidateStage: InterviewScheduleItem['candidateStage']; positionApplied: Position; saved: number; answered: number }>(
    db,
    `SELECT i.id, i.candidate_id AS candidateId, i.type, i.scheduled_at AS scheduledAt, i.interviewer_id AS interviewerId,
            u.first_name || ' ' || u.last_name AS interviewerName, i.outcome, i.notes,
            c.first_name || ' ' || c.last_name AS candidateName, c.stage AS candidateStage, c.position_applied AS positionApplied,
            COALESCE(s.saved, 0) AS saved, COALESCE(s.answered, 0) AS answered
     FROM interviews i
     JOIN candidates c ON c.id = i.candidate_id
     LEFT JOIN users u ON u.id = i.interviewer_id
     LEFT JOIN (SELECT interview_id, COUNT(*) AS saved, SUM(TRIM(answer) <> '') AS answered FROM interview_answers GROUP BY interview_id) s ON s.interview_id = i.id
     WHERE ${where.join(' AND ')}
     ORDER BY i.scheduled_at, i.id`,
    params,
  );
  const bank = listQuestions(db);
  const draftCount = new Map<string, number>();
  const draftOf = (type: InterviewType, position: Position) => {
    const key = `${type}|${position}`;
    if (!draftCount.has(key)) draftCount.set(key, draftSheetQuestions(bank, type, position).length);
    return draftCount.get(key)!;
  };
  const out: InterviewScheduleItem[] = [];
  for (const r of rows) {
    const day = interviewDay(r.scheduledAt);
    if (day < q.from || day > q.to) continue;
    const { saved, answered, ...rest } = r;
    out.push({ ...rest, day, sheetQuestions: Number(saved) || draftOf(r.type, r.positionApplied), sheetAnswered: Number(answered) || 0 });
  }
  return out;
}
