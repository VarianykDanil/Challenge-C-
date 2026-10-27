/**
 * Release 1.3 — recruitment additions: the interview schedule, the candidate timeline and saved sheets, the question
 * bank and the interview sheet — OWNED BY P7 recruitment-plus. Mounted at /recruitment BEFORE the 1.0 recruitment
 * router (routes/recruitment.ts, also P7's in 1.3): only the paths below are answered here, everything else falls
 * through. Role checks are per route (recruitment roles: admin, leader, recruiter; the question bank: admin, recruiter).
 *
 *  GET   /recruitment/schedule?from=&to=&interviewerId=&type= → InterviewScheduleItem[] (default today … today + 6;
 *        interviewerId=none: no interviewer; at most 93 days)
 *  GET   /recruitment/candidates/:id/timeline                 → CandidateTimelineItem[] (newest first)
 *  GET   /recruitment/candidates/:id/sheets                   → CandidateSheet[] (saved sheets, the questions as asked)
 *  GET   /recruitment/questions?type=                         → InterviewQuestion[] (admin, recruiter)
 *  POST  /recruitment/questions  InterviewQuestionInput       → 201 InterviewQuestion (admin, recruiter)
 *  PATCH /recruitment/questions/:id                           → InterviewQuestion (admin, recruiter)
 *  PUT   /recruitment/questions/order  { interviewType, ids } → InterviewQuestion[] of that type (admin, recruiter)
 *  GET   /recruitment/interviews/:id/sheet                    → InterviewSheet
 *  PUT   /recruitment/interviews/:id/answers  InterviewAnswerInput[] → InterviewSheet (autosave: what this device changed,
 *        each with its `base`; `removed: true` takes a question off; 409 { conflicts, sheet } when another device changed
 *        the same question first — nothing is written then; `device` + `version`: the tab's id and save number, so its
 *        own earlier save, still on its way when the next one was built, is never taken for another device's change)
 * POST and PATCH /questions answer 409 when the words are already in that interview type's list for the same position
 * (or every position), ignoring case and spaces.
 * Types: shared/src/types/recruitmentPlus.ts. Rules: lib/recruitmentPlus/store.ts. Audit specs: lib/audit/recruitmentSpecs.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_QUESTION_MAX,
  INTERVIEW_SHEET_MAX_QUESTIONS,
  INTERVIEW_TYPE_NAMES,
  INTERVIEW_TYPE_ORDER,
  POSITIONS,
  SHEET_DEVICE_PATTERN,
  normaliseQuestionText,
  sheetConflictMessage,
  type InterviewSheetConflictDetails,
  type InterviewType,
  type Position,
} from '@lm/shared';
import { all, run, transaction, type Db } from '../db/connection.ts';
import { getCandidate, getInterview } from '../db/queries.ts';
import { addDays, diffDays, nowISO, todayISO } from '../lib/dates.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import {
  candidateSheets,
  candidateTimeline,
  getQuestion,
  interviewSheet,
  listQuestions,
  nextQuestionSort,
  saveInterviewAnswers,
  scheduleItems,
} from '../lib/recruitmentPlus/store.ts';
import { idParam, isoDate, parsePatch } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const RECRUITMENT = requireRole('admin', 'leader', 'recruiter');
const QUESTION_BANK = requireRole('admin', 'recruiter');

/** The longest schedule one request returns (a quarter). */
export const SCHEDULE_MAX_DAYS = 93;

const interviewType = z.enum(INTERVIEW_TYPE_ORDER as [InterviewType, ...InterviewType[]]);
const questionText = z
  .string()
  .transform(normaliseQuestionText)
  .pipe(z.string().min(5, 'Write the question in at least 5 characters').max(INTERVIEW_QUESTION_MAX, `Keep the question under ${INTERVIEW_QUESTION_MAX} characters`));

const questionBody = z.object({
  interviewType,
  position: z.enum(POSITIONS as [Position, ...Position[]]).nullable().optional(),
  text: questionText,
  sort: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

const orderBody = z.object({ interviewType, ids: z.array(z.number().int().positive()).min(1).max(200) });

const answerText = z.string().max(INTERVIEW_ANSWER_MAX, `Keep each answer under ${INTERVIEW_ANSWER_MAX} characters`);
const score = z.number().int().min(1).max(5).nullable();
const answerBody = z
  .array(
    z.object({
      questionId: z.number().int().positive().nullable(),
      questionText: z.string().max(INTERVIEW_QUESTION_MAX + 50).optional(),
      answer: answerText,
      score: score.optional(),
      /** The stored answer and score this device started from. */
      base: z.object({ answer: answerText, score }).optional(),
      removed: z.boolean().optional(),
      /** The sending browser tab's made-up id and its save number: its own earlier saves are never a conflict. */
      device: z.string().regex(SHEET_DEVICE_PATTERN, 'A device id is 8 to 64 letters, digits, - or _').optional(),
      version: z.number().int().positive().max(2_147_483_647).optional(),
    }).refine((a) => (a.device === undefined) === (a.version === undefined), 'Send a device id and its save number together'),
  )
  .min(1, 'Send at least one question')
  .max(INTERVIEW_SHEET_MAX_QUESTIONS, `A sheet holds at most ${INTERVIEW_SHEET_MAX_QUESTIONS} questions`);

const scheduleQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  interviewerId: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  type: interviewType.optional(),
  candidateId: z.coerce.number().int().positive().optional(),
});

/**
 * 409 when the words are already in that interview type's list for the same position or every position (a sheet would
 * show the question twice), ignoring case and spaces. `except`: the question being edited.
 */
function assertNotInList(db: Db, type: InterviewType, position: Position | null, text: string, except: number | null): void {
  const words = normaliseQuestionText(text).toLowerCase();
  const clash = all<{ id: number; text: string; position: Position | null; active: number }>(
    db,
    `SELECT id, text, position, active FROM interview_questions WHERE interview_type = ? AND id <> ?`,
    [type, except ?? 0],
  ).find((q) => (q.position === null || position === null || q.position === position) && normaliseQuestionText(q.text).toLowerCase() === words);
  if (!clash) return;
  const list = `the ${INTERVIEW_TYPE_NAMES[type].toLowerCase()} list`;
  throw new HttpError(409, clash.active ? `That question is already in ${list}` : `That question is already in ${list}, turned off. Turn it back on instead`);
}

export function recruitmentPlusRouter(db: Db): Router {
  const router = Router();

  router.get('/schedule', RECRUITMENT, (req, res) => {
    const q = scheduleQuery.parse(req.query);
    const today = todayISO();
    const from = q.from ?? today;
    const to = q.to ?? (q.from ? q.from : addDays(today, 6));
    if (from > to) throw badRequest('`from` must be on or before `to`');
    if (diffDays(from, to) > SCHEDULE_MAX_DAYS) throw badRequest(`Show at most ${SCHEDULE_MAX_DAYS} days at a time`);
    res.json(scheduleItems(db, { from, to, interviewerId: q.interviewerId ?? null, type: q.type ?? null, candidateId: q.candidateId ?? null }));
  });

  router.get('/candidates/:id/timeline', RECRUITMENT, (req, res) => {
    const items = candidateTimeline(db, idParam(req), todayISO());
    if (!items) throw notFound('Candidate');
    res.json(items);
  });

  router.get('/candidates/:id/sheets', RECRUITMENT, (req, res) => {
    const id = idParam(req);
    if (!getCandidate(db, id)) throw notFound('Candidate');
    res.json(candidateSheets(db, id));
  });

  // ── the question bank (Settings → Recruitment) ──
  router.get('/questions', QUESTION_BANK, (req, res) => {
    const type = req.query.type === undefined || req.query.type === '' ? null : interviewType.parse(req.query.type);
    res.json(listQuestions(db, type));
  });

  router.post('/questions', QUESTION_BANK, (req, res) => {
    const body = questionBody.parse(req.body);
    assertNotInList(db, body.interviewType, body.position ?? null, body.text, null);
    const now = nowISO();
    const id = run(db, `INSERT INTO interview_questions (interview_type, position, text, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      body.interviewType, body.position ?? null, body.text, body.sort ?? nextQuestionSort(db, body.interviewType), body.active === false ? 0 : 1, now, now,
    ]).lastInsertRowid;
    res.status(201).json(getQuestion(db, id));
  });

  // Before /questions/:id would not matter (a different method), but the literal path reads better first.
  router.put('/questions/order', QUESTION_BANK, (req, res) => {
    const body = orderBody.parse(req.body);
    const current = listQuestions(db, body.interviewType);
    const ids = new Set(body.ids);
    if (ids.size !== body.ids.length) throw badRequest('A question is in the list twice');
    if (ids.size !== current.length || current.some((q) => !ids.has(q.id))) throw badRequest('Send every question of this interview type, in the new order');
    const at = nowISO();
    transaction(db, () => {
      body.ids.forEach((id, sort) => {
        const q = current.find((c) => c.id === id)!;
        if (q.sort !== sort) run(db, `UPDATE interview_questions SET sort = ?, updated_at = ? WHERE id = ?`, [sort, at, id]);
      });
    });
    res.json(listQuestions(db, body.interviewType));
  });

  router.patch('/questions/:id', QUESTION_BANK, (req, res) => {
    const id = idParam(req);
    const existing = getQuestion(db, id);
    if (!existing) throw notFound('Question');
    const patch = parsePatch(questionBody, req.body);
    const next = { ...existing, ...patch, position: patch.position === undefined ? existing.position : patch.position };
    // Moving a question to another type puts it at the end of that type's list unless a place is given.
    const sort = patch.sort ?? (patch.interviewType && patch.interviewType !== existing.interviewType ? nextQuestionSort(db, patch.interviewType) : existing.sort);
    const unchanged = next.interviewType === existing.interviewType && next.position === existing.position && next.text === existing.text && sort === existing.sort && next.active === existing.active;
    if (next.interviewType !== existing.interviewType || next.position !== existing.position || next.text !== existing.text) assertNotInList(db, next.interviewType, next.position, next.text, id);
    if (!unchanged) {
      run(db, `UPDATE interview_questions SET interview_type = ?, position = ?, text = ?, sort = ?, active = ?, updated_at = ? WHERE id = ?`, [
        next.interviewType, next.position, next.text, sort, next.active ? 1 : 0, nowISO(), id,
      ]);
    }
    res.json(getQuestion(db, id));
  });

  // ── the interview sheet ──
  router.get('/interviews/:id/sheet', RECRUITMENT, (req, res) => {
    const sheet = interviewSheet(db, idParam(req), todayISO());
    if (!sheet) throw notFound('Interview');
    res.json(sheet);
  });

  router.put('/interviews/:id/answers', RECRUITMENT, (req, res) => {
    const id = idParam(req);
    if (!getInterview(db, id)) throw notFound('Interview');
    const answers = answerBody.parse(req.body);
    const result = saveInterviewAnswers(db, id, answers, currentUser(req).id, nowISO());
    if (result.conflicts.length) {
      const details: InterviewSheetConflictDetails = {
        conflicts: result.conflicts.map((c) => ({ questionId: c.questionId, questionText: c.questionText })),
        sheet: interviewSheet(db, id, todayISO())!,
      };
      throw new HttpError(409, sheetConflictMessage(result.conflicts), details);
    }
    res.json(interviewSheet(db, id, todayISO()));
  });

  return router;
}
