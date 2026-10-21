/**
 * Release 1.3 — recruitment additions: the interview schedule, the candidate timeline, the question bank and the
 * interview sheet — OWNED BY P7 recruitment-plus (laid down by r3-foundation as a stub: reads empty, writes 501).
 * Mounted at /recruitment BEFORE the 1.0 recruitment router (routes/recruitment.ts, also P7's in 1.3): only the paths
 * below are answered here, everything else falls through. Role checks are per route (recruitment roles: admin, leader,
 * recruiter; the question bank: admin, recruiter).
 *
 *  GET   /recruitment/schedule?from=&to=&interviewerId=&type= → InterviewScheduleItem[]
 *  GET   /recruitment/candidates/:id/timeline                 → CandidateTimelineItem[]
 *  GET   /recruitment/questions?type=                         → InterviewQuestion[]
 *  POST  /recruitment/questions  InterviewQuestionInput       → 201 InterviewQuestion
 *  PATCH /recruitment/questions/:id                           → InterviewQuestion
 *  GET   /recruitment/interviews/:id/sheet                    → InterviewSheet
 *  PUT   /recruitment/interviews/:id/answers  InterviewAnswerInput[] → InterviewSheet
 * Types: shared/src/types/recruitmentPlus.ts. Audit specs: lib/audit/recruitmentSpecs.ts.
 */
import { Router } from 'express';
import type { CandidateTimelineItem, InterviewQuestion, InterviewScheduleItem } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

const RECRUITMENT = requireRole('admin', 'leader', 'recruiter');
const QUESTION_BANK = requireRole('admin', 'recruiter');
const notYet = () => {
  throw new HttpError(501, 'This part of recruitment is not available yet');
};

export function recruitmentPlusRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/schedule', RECRUITMENT, (_req, res) => {
    const rows: InterviewScheduleItem[] = [];
    res.json(rows);
  });
  router.get('/candidates/:id/timeline', RECRUITMENT, (_req, res) => {
    const rows: CandidateTimelineItem[] = [];
    res.json(rows);
  });
  router.get('/questions', QUESTION_BANK, (_req, res) => {
    const rows: InterviewQuestion[] = [];
    res.json(rows);
  });
  router.post('/questions', QUESTION_BANK, notYet);
  router.patch('/questions/:id', QUESTION_BANK, notYet);
  router.get('/interviews/:id/sheet', RECRUITMENT, notYet);
  router.put('/interviews/:id/answers', RECRUITMENT, notYet);
  return router;
}
