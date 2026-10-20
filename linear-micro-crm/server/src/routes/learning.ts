/**
 * Release 1.2 — /learning/* — OWNED BY L1 learning-pack (laid down by r2-foundation as a stub).
 *
 *  GET  /learning/progress[?userId=]                    → LearningProgress  (own; ?userId leader: own team, admin: any) — cached
 *  POST /learning/progress/:lessonKey/quiz              LessonQuizInput → LessonQuizResult (self)
 *  POST /learning/progress/:lessonKey/teachback         TeachbackInput → LessonProgress (self)
 *  POST /learning/progress/:userId/:lessonKey/signoff   TeachbackSignoffInput → LessonProgress (that person's team leader, or admin)
 *  GET  /learning/team                                  → TeamLearning (leader: own team; admin: all; rep / recruiter 403) — cached
 *  GET  /learning/progression/:userId                   → Progression (self; leader: own team; admin: any) — cached
 * L1 may add more endpoints under /learning. Types: shared/src/types/learning.ts. Mounted in app.ts with requireAuth;
 * the three GET prefixes are in CACHED_PATHS (20 s per user, cleared by any write).
 */
import { Router } from 'express';
import { LESSON_KEYS, type LearningProgress, type LessonProgress, type TeamLearning } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const notYet = () => new HttpError(501, 'Learning progress is not available yet');

const emptyLesson = (lessonKey: LessonProgress['lessonKey']): LessonProgress => ({
  lessonKey, learnedAt: null, quizScore: null, quizTotal: null, teachbackText: null, teachbackAt: null,
  taughtSignedOffBy: null, taughtSignedOffByName: null, taughtSignedOffAt: null, state: 'new',
});

export function learningRouter(db: Db): Router {
  void db;
  const router = Router();

  // STUB (L1): the caller's own progress, every lesson still "new".
  router.get('/progress', (req, res) => {
    const me = currentUser(req);
    const body: LearningProgress = {
      userId: me.id,
      userName: `${me.firstName} ${me.lastName}`,
      lessons: LESSON_KEYS.map(emptyLesson),
      learned: 0,
      taught: 0,
      total: LESSON_KEYS.length,
    };
    res.json(body);
  });
  router.post('/progress/:lessonKey/quiz', () => { throw notYet(); });
  router.post('/progress/:lessonKey/teachback', () => { throw notYet(); });
  router.post('/progress/:userId/:lessonKey/signoff', requireRole('admin', 'leader'), () => { throw notYet(); });

  // STUB (L1)
  router.get('/team', requireRole('admin', 'leader'), (_req, res) => {
    const body: TeamLearning = { rows: [], total: LESSON_KEYS.length };
    res.json(body);
  });
  router.get('/progression/:userId', () => { throw notYet(); });

  return router;
}
