/**
 * Release 1.2 — /learning/* — OWNED BY L1 learning-pack.
 *
 *  GET  /learning/progress[?userId=]                    → LearningProgress  (own; ?userId leader: own team, admin: any) — cached
 *  POST /learning/progress/:lessonKey/quiz              LessonQuizInput { answers } → LessonQuizResult (self; the server grades)
 *  POST /learning/progress/:lessonKey/teachback         TeachbackInput → LessonProgress (self, once the self-check passed)
 *  POST /learning/progress/:userId/:lessonKey/signoff   TeachbackSignoffInput → TeachbackSignoffResult (that person's team leader, or admin; never your own)
 *  GET  /learning/team                                  → TeamLearning (leader: own team; admin: everyone active; rep / recruiter 403) — cached
 *  GET  /learning/progression/:userId                   → Progression (self; leader: own team; admin: any) — cached
 *  PUT  /learning/milestones/:userId/:key               ProgressionMilestoneInput → Progression (admin: the criteria the office ticks)
 *
 * Types: shared/src/types/learning.ts; rules: shared/src/logic/learning.ts. Mounted in app.ts with requireAuth; the
 * three GET prefixes are in CACHED_PATHS (20 s per user, cleared by any write). Teach-back text only ever reaches the
 * person, the leader of their team and admins (the only viewers these routes allow). The progression tracker is a
 * smart builder: with LM_SMART=0 it answers the level only (requirements [], headline '', enabled false).
 *
 * The self-check is graded here from the options picked (gradeQuiz, shared/src/logic/learningQuiz.ts); a score sent by
 * the phone is never trusted. A sign-off of a lesson not yet learned also marks it learned (Teach ✓ never shows with
 * Learn ☐); withdrawing that sign-off takes back only the "learned" it gave, and keeps it when the self-check was ever
 * passed (quiz_passed_at) or a teach-back has been written since (withdrawTakesBackLearned in shared).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  LEARNING_LIMITS,
  LESSON_KEYS,
  PROGRESSION_RULES,
  careerLevelFor,
  gradeQuiz,
  isLessonKey,
  isProgressionMilestoneKey,
  lessonStateOf,
  nextCareerLevel,
  progressionFrom,
  type LearningProgress,
  type LessonKey,
  type LessonProgress,
  type LessonQuizResult,
  type Position,
  type Progression,
  type ProgressionMilestoneKey,
  type ProgressionWeek,
  type Role,
  type TeachbackAwaiting,
  type TeachbackSignoffResult,
  type TeamLearning,
  type TeamLearningRow,
  type UserStatus,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../db/connection.ts';
import { addDays, mondayOf, nowISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { idParam } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  role: Role;
  position: Position;
  teamId: number | null;
  teamName: string | null;
  status: UserStatus;
  avatarColor: string;
}

const PERSON_SELECT = `SELECT u.id, u.first_name AS firstName, u.last_name AS lastName, u.role, u.position, u.team_id AS teamId,
  t.name AS teamName, u.status, u.avatar_color AS avatarColor FROM users u LEFT JOIN teams t ON t.id = u.team_id`;

const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;

interface ProgressRow {
  lessonKey: string;
  learnedAt: string | null;
  quizScore: number | null;
  quizTotal: number | null;
  quizPassedAt: string | null;
  teachbackText: string | null;
  teachbackAt: string | null;
  taughtSignedOffBy: number | null;
  taughtSignedOffByName: string | null;
  taughtSignedOffAt: string | null;
}

const PROGRESS_SELECT = `SELECT p.lesson_key AS lessonKey, p.learned_at AS learnedAt, p.quiz_score AS quizScore, p.quiz_total AS quizTotal,
  p.quiz_passed_at AS quizPassedAt, p.teachback_text AS teachbackText, p.teachback_at AS teachbackAt, p.taught_signed_off_by AS taughtSignedOffBy,
  CASE WHEN s.id IS NULL THEN NULL ELSE s.first_name || ' ' || s.last_name END AS taughtSignedOffByName,
  p.taught_signed_off_at AS taughtSignedOffAt
  FROM learning_progress p LEFT JOIN users s ON s.id = p.taught_signed_off_by`;

const emptyLesson = (lessonKey: LessonKey): LessonProgress => ({
  lessonKey, learnedAt: null, quizScore: null, quizTotal: null, quizPassedAt: null, teachbackText: null, teachbackAt: null,
  taughtSignedOffBy: null, taughtSignedOffByName: null, taughtSignedOffAt: null, state: 'new',
});

function toLesson(lessonKey: LessonKey, row: ProgressRow | undefined): LessonProgress {
  if (!row) return emptyLesson(lessonKey);
  return {
    lessonKey,
    learnedAt: row.learnedAt,
    quizScore: row.quizScore,
    quizTotal: row.quizTotal,
    quizPassedAt: row.quizPassedAt,
    teachbackText: row.teachbackText,
    teachbackAt: row.teachbackAt,
    taughtSignedOffBy: row.taughtSignedOffBy,
    taughtSignedOffByName: row.taughtSignedOffByName,
    taughtSignedOffAt: row.taughtSignedOffAt,
    state: lessonStateOf(row),
  };
}

/** Self; a leader their own team; an admin anyone. */
function canView(me: UserWithTeam, target: Pick<Person, 'id' | 'teamId'>): boolean {
  if (me.id === target.id || me.role === 'admin') return true;
  return me.role === 'leader' && me.teamId !== null && me.teamId === target.teamId;
}

/** The option picked for each question (0-based). `score` / `total` from the phone are not accepted: answers or 400. */
const quizSchema = z.object({
  answers: z
    .array(z.number().int().min(0).max(LEARNING_LIMITS.quizMaxOptions - 1), {
      required_error: 'Send answers: the option picked for each question',
      invalid_type_error: 'answers must be a list of option numbers',
    })
    .max(LEARNING_LIMITS.quizMaxQuestions),
});

const teachbackSchema = z.object({
  text: z.string().trim().min(LEARNING_LIMITS.teachbackMinLength, `Write at least ${LEARNING_LIMITS.teachbackMinLength} characters`).max(LEARNING_LIMITS.teachbackMaxLength),
});

const signoffSchema = z.object({ signedOff: z.boolean().default(true) }).default({ signedOff: true });

const milestoneSchema = z.object({ value: z.number().int().min(0).max(LEARNING_LIMITS.milestoneMax) });

export function learningRouter(db: Db): Router {
  const router = Router();

  const person = (id: number): Person => {
    const p = get<Person>(db, `${PERSON_SELECT} WHERE u.id = ?`, [id]);
    if (!p) throw notFound('Person');
    return p;
  };

  const lessonParam = (req: Request): LessonKey => {
    const key = req.params.lessonKey;
    if (!isLessonKey(key)) throw notFound('Lesson');
    return key;
  };

  /** The person `?userId=` / `:userId` names, checked against the caller's scope (default: the caller). */
  const personInScope = (me: UserWithTeam, id: number): Person => {
    const p = person(id);
    if (!canView(me, p)) {
      throw forbidden(me.role === 'leader' ? 'You can only see the learning of your own team' : 'You can only see your own learning');
    }
    return p;
  };

  const lessonRow = (userId: number, key: LessonKey): LessonProgress =>
    toLesson(key, get<ProgressRow>(db, `${PROGRESS_SELECT} WHERE p.user_id = ? AND p.lesson_key = ?`, [userId, key]));

  const progressOf = (p: Person): LearningProgress => {
    const rows = new Map(all<ProgressRow>(db, `${PROGRESS_SELECT} WHERE p.user_id = ?`, [p.id]).map((r) => [r.lessonKey, r]));
    const lessons = LESSON_KEYS.map((k) => toLesson(k, rows.get(k)));
    return {
      userId: p.id,
      userName: nameOf(p),
      lessons,
      learned: lessons.filter((l) => l.learnedAt).length,
      taught: lessons.filter((l) => l.taughtSignedOffAt).length,
      total: LESSON_KEYS.length,
    };
  };

  /** Learned / taught counts over the current lesson keys only (a stray stored key never counts). */
  const countsOf = (userId: number): { learned: number; taught: number } => {
    const r = get<{ learned: number; taught: number }>(
      db,
      `SELECT COUNT(learned_at) AS learned, COUNT(taught_signed_off_at) AS taught FROM learning_progress
       WHERE user_id = ? AND lesson_key IN (${placeholders(LESSON_KEYS.length)})`,
      [userId, ...LESSON_KEYS],
    )!;
    return { learned: Number(r.learned), taught: Number(r.taught) };
  };

  const progressionOf = (me: UserWithTeam, p: Person): Progression => {
    const { learned, taught } = countsOf(p.id);
    const total = LESSON_KEYS.length;
    if (!smartEnabled()) {
      const level = careerLevelFor(p.position);
      return {
        userId: p.id, userName: nameOf(p), position: p.position, level, nextLevel: nextCareerLevel(level),
        requirements: [], headline: '', weeks: [], learned, taught, total, enabled: false,
      };
    }
    // The tracker's window: the last PROGRESSION_RULES.windowWeeks Mon–Sun weeks, this week (so far) last.
    const today = todayISO();
    const thisMonday = mondayOf(today);
    const first = addDays(thisMonday, -7 * (PROGRESSION_RULES.windowWeeks - 1));
    const byWeek = new Map(
      all<{ weekStart: string; own: number; team: number }>(
        db,
        `SELECT date(g.date, 'weekday 0', '-6 days') AS weekStart,
                SUM(CASE WHEN g.user_id = ? THEN g.sales ELSE 0 END) AS own,
                SUM(CASE WHEN u.team_id = ? THEN g.sales ELSE 0 END) AS team
           FROM gauge_entries g JOIN users u ON u.id = g.user_id
          WHERE (g.user_id = ? OR u.team_id = ?) AND g.date BETWEEN ? AND ?
          GROUP BY weekStart`,
        [p.id, p.teamId, p.id, p.teamId, first, today],
      ).map((r) => [r.weekStart, r]),
    );
    const weeks: ProgressionWeek[] = [];
    for (let i = 0; i < PROGRESSION_RULES.windowWeeks; i++) {
      const weekStart = addDays(first, 7 * i);
      const r = byWeek.get(weekStart);
      weeks.push({ weekStart, sales: Number(r?.own ?? 0), teamSales: p.teamId === null ? null : Number(r?.team ?? 0) });
    }
    const milestones: Partial<Record<ProgressionMilestoneKey, number>> = {};
    for (const m of all<{ key: string; value: number }>(db, `SELECT milestone_key AS key, value FROM learning_milestones WHERE user_id = ?`, [p.id])) {
      if (isProgressionMilestoneKey(m.key)) milestones[m.key] = Number(m.value);
    }
    const teamLeadersOnTeam = p.teamId === null
      ? 0
      : Number(
          get<{ n: number }>(
            db,
            `SELECT COUNT(*) AS n FROM users WHERE team_id = ? AND id <> ? AND status = 'active'
               AND position IN ('team_leader', 'crew_leader', 'assistant_owner', 'owner')`,
            [p.teamId, p.id],
          )!.n,
        );
    return progressionFrom({
      userId: p.id, userName: nameOf(p), position: p.position, weeks, learned, taught, total, milestones, teamLeadersOnTeam,
      forSelf: me.id === p.id,
    });
  };

  // ── Reads ──

  router.get('/progress', (req, res) => {
    const me = currentUser(req);
    const raw = req.query.userId;
    let id = me.id;
    if (raw !== undefined && raw !== '') {
      id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid userId');
    }
    res.json(progressOf(personInScope(me, id)));
  });

  router.get('/team', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const total = LESSON_KEYS.length;
    if (me.role === 'leader' && me.teamId === null) {
      const empty: TeamLearning = { rows: [], total, pending: [] };
      return res.json(empty);
    }
    // A leader: the active people of their own team. An admin: everyone active, recruiters included (they have no team
    // leader, so the office signs their teach-backs off).
    const scope = me.role === 'admin' ? '' : 'AND u.team_id = ?';
    const scopeParams = me.role === 'admin' ? [] : [me.teamId];
    const people = all<Person>(
      db,
      `${PERSON_SELECT} WHERE u.status = 'active' ${scope}
       ORDER BY (t.name IS NULL), t.name, u.first_name, u.last_name`,
      scopeParams,
    );
    const progress = all<{ userId: number; lessonKey: string; learnedAt: string | null; teachbackText: string | null; teachbackAt: string | null; taughtSignedOffAt: string | null }>(
      db,
      `SELECT p.user_id AS userId, p.lesson_key AS lessonKey, p.learned_at AS learnedAt, p.teachback_text AS teachbackText,
              p.teachback_at AS teachbackAt, p.taught_signed_off_at AS taughtSignedOffAt
         FROM learning_progress p JOIN users u ON u.id = p.user_id
        WHERE u.status = 'active' ${scope}`,
      scopeParams,
    );
    const byUser = new Map<number, Map<string, (typeof progress)[number]>>();
    for (const r of progress) {
      if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
      byUser.get(r.userId)!.set(r.lessonKey, r);
    }
    const pending: TeachbackAwaiting[] = [];
    const rows: TeamLearningRow[] = people.map((p) => {
      const mine = byUser.get(p.id) ?? new Map();
      const lessons = LESSON_KEYS.map((lessonKey) => {
        const r = mine.get(lessonKey);
        const row = { learnedAt: r?.learnedAt ?? null, teachbackAt: r?.teachbackAt ?? null, taughtSignedOffAt: r?.taughtSignedOffAt ?? null };
        if (r?.teachbackAt && !r.taughtSignedOffAt && p.id !== me.id) {
          pending.push({ userId: p.id, userName: nameOf(p), avatarColor: p.avatarColor, lessonKey, teachbackText: r.teachbackText, teachbackAt: r.teachbackAt });
        }
        return { lessonKey, ...row, state: lessonStateOf(row) };
      });
      return {
        userId: p.id,
        userName: nameOf(p),
        position: p.position,
        avatarColor: p.avatarColor,
        teamId: p.teamId,
        teamName: p.teamName,
        learned: lessons.filter((l) => l.learnedAt).length,
        taught: lessons.filter((l) => l.taughtSignedOffAt).length,
        awaitingSignOff: lessons.filter((l) => l.state === 'teachback_sent').length,
        lessons,
      };
    });
    pending.sort((a, b) => (a.teachbackAt < b.teachbackAt ? 1 : a.teachbackAt > b.teachbackAt ? -1 : a.userId - b.userId));
    const body: TeamLearning = { rows, total, pending };
    res.json(body);
  });

  router.get('/progression/:userId', (req, res) => {
    const me = currentUser(req);
    res.json(progressionOf(me, personInScope(me, idParam(req, 'userId'))));
  });

  // ── Writes ──

  router.post('/progress/:lessonKey/quiz', (req, res) => {
    const me = currentUser(req);
    const key = lessonParam(req);
    const { answers } = quizSchema.parse(req.body);
    const grade = gradeQuiz(key, answers);
    if (!grade.ok) throw badRequest(grade.error);
    const { passed, score, total, correct } = grade;
    const now = nowISO();
    // The last score always replaces the old one; "learned" and "passed" (quiz_passed_at) are set by the first pass
    // and never taken away by a retake, so a failed retake cannot undo a pass (not even through a withdrawn sign-off).
    run(
      db,
      `INSERT INTO learning_progress (user_id, lesson_key, learned_at, quiz_score, quiz_total, quiz_passed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, lesson_key) DO UPDATE SET quiz_score = excluded.quiz_score, quiz_total = excluded.quiz_total,
         learned_at = COALESCE(learning_progress.learned_at, excluded.learned_at),
         quiz_passed_at = COALESCE(learning_progress.quiz_passed_at, excluded.quiz_passed_at), updated_at = excluded.updated_at`,
      [me.id, key, passed ? now : null, score, total, passed ? now : null, now],
    );
    // Which questions were wrong, never which option is right.
    const body: LessonQuizResult = { passed, progress: lessonRow(me.id, key), score, total, correct };
    res.json(body);
  });

  router.post('/progress/:lessonKey/teachback', (req, res) => {
    const me = currentUser(req);
    const key = lessonParam(req);
    const { text } = teachbackSchema.parse(req.body);
    const learned = get<{ learnedAt: string | null }>(db, `SELECT learned_at AS learnedAt FROM learning_progress WHERE user_id = ? AND lesson_key = ?`, [me.id, key]);
    if (!learned?.learnedAt) throw conflict('Pass the self-check first, then teach it back');
    const now = nowISO();
    run(db, `UPDATE learning_progress SET teachback_text = ?, teachback_at = ?, updated_at = ? WHERE user_id = ? AND lesson_key = ?`, [text, now, now, me.id, key]);
    res.json(lessonRow(me.id, key));
  });

  router.post('/progress/:userId/:lessonKey/signoff', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const target = person(idParam(req, 'userId'));
    const key = lessonParam(req);
    const { signedOff } = signoffSchema.parse(req.body ?? {});
    if (target.id === me.id) throw forbidden('Someone else signs off your own teach-back');
    if (!canView(me, target)) throw forbidden('You can only sign off teach-backs from your own team');
    const now = nowISO();
    let markedLearned = false;
    if (signedOff) {
      // An in-person teach-back can be signed off without a written one; a second sign-off keeps the first signer.
      // It also counts as learned: a lesson not learned yet gets learned_at = the sign-off time (the self-check can
      // still be taken; a pass never moves learned_at).
      const wasLearned = get<{ learnedAt: string | null }>(db, `SELECT learned_at AS learnedAt FROM learning_progress WHERE user_id = ? AND lesson_key = ?`, [target.id, key]);
      run(
        db,
        `INSERT INTO learning_progress (user_id, lesson_key, learned_at, taught_signed_off_by, taught_signed_off_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, lesson_key) DO UPDATE SET
           taught_signed_off_by = CASE WHEN learning_progress.taught_signed_off_at IS NULL THEN excluded.taught_signed_off_by ELSE learning_progress.taught_signed_off_by END,
           taught_signed_off_at = COALESCE(learning_progress.taught_signed_off_at, excluded.taught_signed_off_at),
           learned_at = COALESCE(learning_progress.learned_at, learning_progress.taught_signed_off_at, excluded.learned_at),
           updated_at = excluded.updated_at`,
        [target.id, key, now, me.id, now, now],
      );
      markedLearned = !wasLearned?.learnedAt;
    } else {
      // Withdrawn: back to where it was. A "learned" that only this sign-off gave (same time, self-check never passed,
      // no teach-back written since) goes with it. A self-check passed at any point keeps the lesson learned, whatever
      // the last retake scored; so does a teach-back written after the sign-off (it stays, waiting for a sign-off, and
      // a teach-back always sits on a learned lesson). Same rule as withdrawTakesBackLearned in shared.
      run(
        db,
        `UPDATE learning_progress SET
           learned_at = CASE WHEN learned_at = taught_signed_off_at AND quiz_passed_at IS NULL AND teachback_at IS NULL
                               AND NOT COALESCE(quiz_total >= 1 AND quiz_score = quiz_total, 0) THEN NULL ELSE learned_at END,
           taught_signed_off_by = NULL, taught_signed_off_at = NULL, updated_at = ?
         WHERE user_id = ? AND lesson_key = ?`,
        [now, target.id, key],
      );
    }
    const body: TeachbackSignoffResult = markedLearned ? { ...lessonRow(target.id, key), markedLearned } : lessonRow(target.id, key);
    res.json(body);
  });

  router.put('/milestones/:userId/:key', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const target = person(idParam(req, 'userId'));
    const key = req.params.key;
    if (!isProgressionMilestoneKey(key)) throw notFound('Milestone');
    const { value } = milestoneSchema.parse(req.body);
    run(
      db,
      `INSERT INTO learning_milestones (user_id, milestone_key, value, set_by, set_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, milestone_key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
      [target.id, key, value, me.id, nowISO()],
    );
    res.json(progressionOf(me, target));
  });

  return router;
}
