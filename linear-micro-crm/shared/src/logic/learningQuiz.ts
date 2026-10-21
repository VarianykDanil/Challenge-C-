/**
 * Release 1.2 — OWNED BY L1 learning-pack. The self-check's answer key and how a self-check is graded.
 *
 * The server grades: POST /learning/progress/:lessonKey/quiz sends the option picked for each question
 * (`{ answers: [1, 2, 0] }`) and the score is worked out here, never taken from the phone. A failed attempt says which
 * questions are wrong (`correct`), never which option is right.
 *
 * The questions themselves live with the lessons (client/src/content/learning/*.ts, each with its `answer`). This key
 * is a copy of those answers; learningQuiz.test.ts loads the lessons and fails if the two ever disagree, so change both
 * together (reordering a question's options changes its answer here too).
 *
 * Not a secret: the lessons the phone loads carry each `answer` and its explanation, and `correct` shows which
 * questions were right, so a determined person can find every answer. What the server grading stops is a made-up
 * score (`{ score: 3, total: 3 }`) marking a lesson learned. The check that counts is the leader's sign-off.
 *
 * Exported through ./learning.ts (logic/index.ts re-exports that module).
 */
import type { LessonKey } from '../types/learning.ts';

/** The right option (0-based) for each self-check question, in question order. [] for the two practical tasks. */
export const QUIZ_ANSWER_KEY: Readonly<Record<LessonKey, readonly number[]>> = {
  'five-steps': [1, 2, 0],
  'working-habits': [3, 0, 1],
  'law-of-averages': [2, 0, 3],
  'impulse-factors': [2, 1, 2],
  'green-light-theory': [2, 0, 1],
  'gumball-theory': [2, 2, 0],
  'can-cant-controls': [2, 3, 1],
  'buying-signs': [2, 0, 2],
  'strategic-pause': [1, 2, 0],
  'bamboo-theory': [2, 0, 3],
  'pre-emptive-strike': [1, 3, 0],
  'attitude-regain': [1, 2, 0],
  'bullet-theory': [2, 1, 2],
  'straight-line-theory': [1, 2, 0],
  'core-principles': [1, 2, 0],
  'progression-structure': [2, 0, 3],
  'direct-indirect-marketing': [3, 0, 1],
  'assuming-the-role': [1, 2, 0],
  'theory-of-teachback': [1, 2, 0],
  'run-an-impact': [],
  'go-on-a-roadtrip': [],
};

/** How many questions a lesson's self-check has (0 for a practical task, which is ticked as done instead). */
export function quizQuestionCount(lessonKey: LessonKey): number {
  return QUIZ_ANSWER_KEY[lessonKey].length;
}

/** A graded self-check. */
export interface QuizGrade {
  ok: true;
  /** Right answers. A practical task ticked as done counts as 1 of 1. */
  score: number;
  total: number;
  /** One entry per question, in order: whether the option picked was right ([] for a task). */
  correct: boolean[];
  /** Every answer right (the lesson is learned on the first pass). */
  passed: boolean;
}

/** A self-check that cannot be graded (the server answers 400 with `error`). */
export interface QuizGradeRefused {
  ok: false;
  error: string;
}

/**
 * Grades one attempt. `answers[i]` is the 0-based option picked for question i; every question must be answered
 * (a whole number from 0). A practical task takes no answers (`[]`) and is ticked as done (1 of 1).
 */
export function gradeQuiz(lessonKey: LessonKey, answers: readonly number[]): QuizGrade | QuizGradeRefused {
  const key = QUIZ_ANSWER_KEY[lessonKey];
  if (key.length === 0) {
    if (answers.length > 0) return { ok: false, error: 'This task has no questions: send no answers to tick it as done' };
    return { ok: true, score: 1, total: 1, correct: [], passed: true };
  }
  if (answers.length !== key.length) return { ok: false, error: `Answer all ${key.length} questions` };
  if (!answers.every((a) => Number.isInteger(a) && a >= 0)) return { ok: false, error: 'Each answer is the number of the option picked, from 0' };
  const correct = key.map((right, i) => answers[i] === right);
  const score = correct.filter(Boolean).length;
  // Same rule as quizPassed (learning.ts): every answer right, at least one question.
  return { ok: true, score, total: key.length, correct, passed: score === key.length };
}
