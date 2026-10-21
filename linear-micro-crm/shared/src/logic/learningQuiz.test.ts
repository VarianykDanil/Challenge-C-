// Release 1.2 — L1: the self-check's answer key and grading (the server grades from the options picked, never from a
// score the phone sends). The last test loads the lessons themselves (client/src/content/learning) and fails when the
// key here and the questions there ever disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_KEYS, type LessonKey } from '../types/learning.ts';
import { LEARNING_LIMITS, isTaskLesson } from './learning.ts';
import { QUIZ_ANSWER_KEY, gradeQuiz, quizQuestionCount } from './learningQuiz.ts';

test('every lesson has a key: three questions for a theory, none for the two practical tasks', () => {
  assert.deepEqual(Object.keys(QUIZ_ANSWER_KEY).sort(), [...LESSON_KEYS].sort());
  for (const key of LESSON_KEYS) {
    const answers = QUIZ_ANSWER_KEY[key];
    assert.equal(answers.length, isTaskLesson(key) ? 0 : 3, key);
    assert.equal(quizQuestionCount(key), answers.length, key);
    for (const a of answers) assert.ok(Number.isInteger(a) && a >= 0 && a < LEARNING_LIMITS.quizMaxOptions, `${key}: ${a}`);
  }
});

test('gradeQuiz: every answer right → passed, with a tick per question', () => {
  const g = gradeQuiz('five-steps', [...QUIZ_ANSWER_KEY['five-steps']]);
  assert.deepEqual(g, { ok: true, score: 3, total: 3, correct: [true, true, true], passed: true });
});

test('gradeQuiz: one wrong → not passed; says which question, never which option was right', () => {
  const right = QUIZ_ANSWER_KEY['impulse-factors'];
  const wrong = (right[1]! + 1) % 4;
  const g = gradeQuiz('impulse-factors', [right[0]!, wrong, right[2]!]);
  assert.equal(g.ok, true);
  if (!g.ok) return;
  assert.deepEqual(g, { ok: true, score: 2, total: 3, correct: [true, false, true], passed: false });
  assert.deepEqual(Object.keys(g).sort(), ['correct', 'ok', 'passed', 'score', 'total'], 'no answer key in the grade');
});

test('gradeQuiz: all wrong is 0 of 3', () => {
  const g = gradeQuiz('bamboo-theory', QUIZ_ANSWER_KEY['bamboo-theory'].map((a) => (a + 1) % 4));
  assert.deepEqual(g, { ok: true, score: 0, total: 3, correct: [false, false, false], passed: false });
});

test('gradeQuiz: a missing or extra answer is refused, not graded', () => {
  const short = gradeQuiz('five-steps', [1, 2]);
  assert.deepEqual(short, { ok: false, error: 'Answer all 3 questions' });
  assert.equal(gradeQuiz('five-steps', [1, 2, 0, 1]).ok, false);
  assert.equal(gradeQuiz('five-steps', []).ok, false);
  assert.equal(gradeQuiz('five-steps', [1, 2.5, 0]).ok, false);
  assert.equal(gradeQuiz('five-steps', [1, -1, 0]).ok, false);
});

test('gradeQuiz: a practical task is ticked as done with no answers (1 of 1)', () => {
  assert.deepEqual(gradeQuiz('run-an-impact', []), { ok: true, score: 1, total: 1, correct: [], passed: true });
  assert.deepEqual(gradeQuiz('go-on-a-roadtrip', []), { ok: true, score: 1, total: 1, correct: [], passed: true });
  const extra = gradeQuiz('run-an-impact', [0]);
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.match(extra.error, /no questions/);
});

test('the key matches the lessons’ own questions (client/src/content/learning), so the two never drift', async () => {
  // Loaded at run time (Node strips the types); a computed URL keeps the client files out of this package's typecheck.
  const url = new URL('../../../client/src/content/learning/index.ts', import.meta.url).href;
  const content = (await import(url)) as {
    LESSONS: Record<LessonKey, { key: LessonKey; task?: boolean; quiz: { q: string; options: string[]; answer: number }[] }>;
  };
  for (const key of LESSON_KEYS) {
    const lesson = content.LESSONS[key];
    assert.ok(lesson, `${key} has a lesson`);
    assert.equal(Boolean(lesson.task), isTaskLesson(key), `${key}: task flag`);
    assert.deepEqual(lesson.quiz.map((q) => q.answer), [...QUIZ_ANSWER_KEY[key]], `${key}: answer key`);
    for (const [i, q] of lesson.quiz.entries()) {
      assert.ok(q.options.length >= 2 && q.options.length <= LEARNING_LIMITS.quizMaxOptions, `${key} q${i + 1}: options`);
      assert.ok(q.answer < q.options.length, `${key} q${i + 1}: the right option exists`);
      assert.equal(new Set(q.options).size, q.options.length, `${key} q${i + 1}: no repeated option`);
    }
  }
});
