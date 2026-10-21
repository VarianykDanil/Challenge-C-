/**
 * L1 learning-pack, release 1.2 fixes (G4):
 *  - the server grades the self-check from the options picked (`{ answers }`); a typed-in `{ score, total }` is refused
 *    (security review S4 / content review #13 — the reviewer's probe1 posted `{ score: 1, total: 1 }` and was "learned");
 *  - a failed attempt says which questions are wrong, never which option is right;
 *  - an in-person sign-off also counts as learned, so the checklist never shows Teach ✓ with Learn ☐ (content #12);
 *  - re-review: withdrawing that sign-off never takes "learned" from a lesson whose self-check was passed (even when a
 *    later retake failed: quiz_passed_at) or that has a teach-back written since (never "teach-back sent" + Learn ☐).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIZ_ANSWER_KEY } from '@lm/shared';
import { createSchema } from '../db/schema.ts';
import { all, get, run } from '../db/connection.ts';
import { setBusinessClock, toISODate } from '../lib/dates.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = toISODate(new Date());
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, rep, repA2, repB] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('rep'), srv.login('repA2'), srv.login('repB')]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

const fx = () => srv.fixture!;
const count = (table: string) => Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n);
const row = (userId: number, key: string) =>
  get<{ learnedAt: string | null; quizScore: number | null; quizTotal: number | null; quizPassedAt: string | null; taughtAt: string | null }>(
    srv.db,
    `SELECT learned_at AS learnedAt, quiz_score AS quizScore, quiz_total AS quizTotal, quiz_passed_at AS quizPassedAt,
            taught_signed_off_at AS taughtAt
       FROM learning_progress WHERE user_id = ? AND lesson_key = ?`,
    [userId, key],
  );
const right = (key: keyof typeof QUIZ_ANSWER_KEY) => [...QUIZ_ANSWER_KEY[key]];
const wrongAt = (key: keyof typeof QUIZ_ANSWER_KEY, i: number) => right(key).map((a, j) => (j === i ? (a + 1) % 4 : a));

test('S4 regression (probe1): a self-reported score no longer marks a lesson learned', async () => {
  for (const body of [{ score: 1, total: 1 }, { score: 3, total: 3 }, { score: 3, total: 3, answers: undefined }]) {
    const r = await repA2.post('/learning/progress/law-of-averages/quiz', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(row(fx().users.repA2, 'law-of-averages'), undefined, 'nothing stored');
  const p = (await repA2.get('/learning/progress')).json;
  assert.equal(p.learned, 0);
});

test('quiz: the server grades the picks — all right is learned; the score in the body is ignored', async () => {
  const before = [count('gauge_entries'), count('payroll_runs')];
  const r = await rep.post('/learning/progress/five-steps/quiz', { answers: right('five-steps'), score: 0, total: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.json.passed, true);
  assert.deepEqual([r.json.score, r.json.total, r.json.correct], [3, 3, [true, true, true]]);
  assert.equal(r.json.progress.state, 'learned');
  assert.deepEqual([r.json.progress.quizScore, r.json.progress.quizTotal], [3, 3]);
  assert.ok(r.json.progress.quizPassedAt, 'the pass is recorded');
  assert.equal(r.json.progress.quizPassedAt, r.json.progress.learnedAt);
  assert.deepEqual([count('gauge_entries'), count('payroll_runs')], before, 'never a gauge row or a payroll run');
});

test('quiz: a failed attempt says which questions are wrong and nothing about the right option', async () => {
  const r = await repB.post('/learning/progress/impulse-factors/quiz', { answers: wrongAt('impulse-factors', 1) });
  assert.equal(r.status, 200);
  assert.equal(r.json.passed, false);
  assert.deepEqual([r.json.score, r.json.total, r.json.correct], [2, 3, [true, false, true]]);
  assert.equal(r.json.progress.state, 'new');
  assert.equal(r.json.progress.quizPassedAt, null, 'a miss is no pass');
  assert.deepEqual(Object.keys(r.json).sort(), ['correct', 'passed', 'progress', 'score', 'total']);
  assert.ok(!JSON.stringify(r.json).includes('answer'), 'no answer key in the reply');
  // a retake after a pass keeps "learned" and records the last score
  await repB.post('/learning/progress/impulse-factors/quiz', { answers: right('impulse-factors') });
  const { learnedAt, quizPassedAt } = row(fx().users.repB, 'impulse-factors')!;
  assert.ok(learnedAt && quizPassedAt);
  const again = await repB.post('/learning/progress/impulse-factors/quiz', { answers: wrongAt('impulse-factors', 0) });
  assert.equal(again.json.progress.state, 'learned');
  assert.equal(again.json.progress.learnedAt, learnedAt);
  assert.equal(again.json.progress.quizScore, 2);
  assert.equal(again.json.progress.quizPassedAt, quizPassedAt, 'a failed retake keeps the pass on record');
  // a second pass does not move it either
  await repB.post('/learning/progress/impulse-factors/quiz', { answers: right('impulse-factors') });
  assert.equal(row(fx().users.repB, 'impulse-factors')!.quizPassedAt, quizPassedAt);
});

test('quiz: validation — every question answered, whole numbers, a task takes no answers', async () => {
  const post = (key: string, body: unknown) => rep.post(`/learning/progress/${key}/quiz`, body);
  assert.equal((await post('five-steps', {})).status, 400);
  assert.equal((await post('five-steps', { answers: [1, 2] })).status, 400);
  assert.equal((await post('five-steps', { answers: [1, 2, 0, 0] })).status, 400);
  assert.equal((await post('five-steps', { answers: [1, 2.5, 0] })).status, 400);
  assert.equal((await post('five-steps', { answers: [1, -1, 0] })).status, 400);
  assert.equal((await post('five-steps', { answers: '120' })).status, 400);
  const short = await post('working-habits', { answers: [3] });
  assert.equal(short.status, 400);
  assert.equal(short.json.error, 'Answer all 3 questions');
  assert.equal((await post('not-a-lesson', { answers: [] })).status, 404);
  assert.equal((await post('run-an-impact', { answers: [0] })).status, 400);
  const task = await post('run-an-impact', { answers: [] });
  assert.equal(task.status, 200);
  assert.equal(task.json.passed, true);
  assert.equal(task.json.progress.state, 'learned');
  assert.deepEqual([task.json.progress.quizScore, task.json.progress.quizTotal], [1, 1]);
});

test('sign-off before the self-check: an in-person teach-back counts as learned too', async () => {
  const url = (key: string) => `/learning/progress/${fx().users.repA2}/${key}/signoff`;
  assert.equal(row(fx().users.repA2, 'green-light-theory'), undefined, 'nothing yet');
  const r = await leader.post(url('green-light-theory'), {});
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'taught');
  assert.ok(r.json.learnedAt, 'learned set by the sign-off');
  assert.equal(r.json.learnedAt, r.json.taughtSignedOffAt);
  assert.equal(r.json.markedLearned, true);
  // the person's own page and the team checklist agree: Learn ✓ and Teach ✓
  const p = (await repA2.get('/learning/progress')).json;
  const l = p.lessons.find((x: Json) => x.lessonKey === 'green-light-theory');
  assert.ok(l.learnedAt && l.taughtSignedOffAt);
  assert.equal(p.learned, p.lessons.filter((x: Json) => x.learnedAt).length);
  const team = (await leader.get('/learning/team')).json;
  const mine = team.rows.find((x: Json) => x.userId === fx().users.repA2);
  assert.ok(mine.lessons.every((x: Json) => !x.taughtSignedOffAt || x.learnedAt), 'never Teach ✓ with Learn ☐');
  // a sign-off after the self-check keeps the self-check's learned time and says nothing new
  await repA2.post('/learning/progress/buying-signs/quiz', { answers: right('buying-signs') });
  const learnedAt = row(fx().users.repA2, 'buying-signs')!.learnedAt;
  const s = await admin.post(url('buying-signs'), {});
  assert.equal(s.json.learnedAt, learnedAt);
  assert.equal(s.json.markedLearned, undefined);
});

test('withdrawing a sign-off takes back only the "learned" that the sign-off itself gave', async () => {
  const url = (key: string) => `/learning/progress/${fx().users.repA2}/${key}/signoff`;
  // green-light-theory was learned by the sign-off alone (previous test): withdrawing it goes back to new
  let r = await leader.post(url('green-light-theory'), { signedOff: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'new');
  assert.equal(r.json.learnedAt, null);
  // buying-signs was learned from the self-check: withdrawing keeps it learned
  r = await leader.post(url('buying-signs'), { signedOff: false });
  assert.equal(r.json.state, 'learned');
  assert.ok(r.json.learnedAt);
  // signed off first, self-check passed afterwards: withdrawing keeps it learned (the self-check stands)
  await leader.post(url('strategic-pause'), {});
  await repA2.post('/learning/progress/strategic-pause/quiz', { answers: right('strategic-pause') });
  r = await leader.post(url('strategic-pause'), { signedOff: false });
  assert.equal(r.json.state, 'learned');
});

test('re-review (content #12): sign-off first, pass, then a failed retake, then withdraw → stays learned', async () => {
  const url = `/learning/progress/${fx().users.repA2}/gumball-theory/signoff`;
  const s = await leader.post(url, {});
  assert.equal(s.json.markedLearned, true);
  const signedAt = s.json.learnedAt;
  const pass = await repA2.post('/learning/progress/gumball-theory/quiz', { answers: right('gumball-theory') });
  assert.equal(pass.json.passed, true);
  assert.equal(pass.json.progress.learnedAt, signedAt, 'a pass never moves learned_at');
  assert.ok(pass.json.progress.quizPassedAt);
  const miss = await repA2.post('/learning/progress/gumball-theory/quiz', { answers: wrongAt('gumball-theory', 2) });
  assert.deepEqual([miss.json.passed, miss.json.score, miss.json.total], [false, 2, 3]);
  const w = await leader.post(url, { signedOff: false });
  assert.equal(w.status, 200);
  assert.equal(w.json.state, 'learned', 'the pass keeps it learned, whatever the last retake scored');
  assert.equal(w.json.learnedAt, signedAt);
  assert.deepEqual([w.json.quizScore, w.json.quizTotal], [2, 3]);
  assert.equal(w.json.quizPassedAt, pass.json.progress.quizPassedAt);
  assert.equal(w.json.taughtSignedOffAt, null);
  const p = (await repA2.get('/learning/progress')).json;
  assert.equal(p.lessons.find((x: Json) => x.lessonKey === 'gumball-theory').state, 'learned');
});

test('re-review (content #12): sign-off, a teach-back written, withdraw → stays learned, the teach-back waits again', async () => {
  const url = `/learning/progress/${fx().users.repA2}/can-cant-controls/signoff`;
  const s = await leader.post(url, {});
  assert.equal(s.json.markedLearned, true);
  // the sign-off counted it as learned, so the teach-back can be written
  const tb = await repA2.post('/learning/progress/can-cant-controls/teachback', { text: 'I control my pitch, pace and attitude; not the weather.' });
  assert.equal(tb.status, 200);
  const w = await leader.post(url, { signedOff: false });
  assert.equal(w.status, 200);
  assert.equal(w.json.state, 'teachback_sent');
  assert.ok(w.json.learnedAt, 'never "teach-back sent" with Learn ☐');
  assert.equal(w.json.learnedAt, s.json.learnedAt);
  assert.ok(w.json.teachbackAt && w.json.teachbackText);
  assert.equal(w.json.taughtSignedOffAt, null);
  // the leader's checklist agrees, and the teach-back is back in the queue
  const team = (await leader.get('/learning/team')).json;
  const mine = team.rows.find((x: Json) => x.userId === fx().users.repA2);
  const lesson = mine.lessons.find((x: Json) => x.lessonKey === 'can-cant-controls');
  assert.equal(lesson.state, 'teachback_sent');
  assert.ok(lesson.learnedAt);
  for (const r of team.rows) {
    for (const l of r.lessons) assert.ok(!(l.teachbackAt || l.taughtSignedOffAt) || l.learnedAt, `${r.userName} ${l.lessonKey}: Learn ☐ with a teach-back or a sign-off`);
  }
  assert.ok(team.pending.some((x: Json) => x.userId === fx().users.repA2 && x.lessonKey === 'can-cant-controls'));
  // signed off again and withdrawn again: still the same
  await leader.post(url, {});
  const again = await leader.post(url, { signedOff: false });
  assert.equal(again.json.state, 'teachback_sent');
  assert.equal(again.json.learnedAt, s.json.learnedAt);
  // no teach-back and no pass: the withdraw still takes the "learned" the sign-off gave
  const plain = `/learning/progress/${fx().users.repA2}/pre-emptive-strike/signoff`;
  await leader.post(plain, {});
  await repA2.post('/learning/progress/pre-emptive-strike/quiz', { answers: wrongAt('pre-emptive-strike', 1) });
  const gone = await leader.post(plain, { signedOff: false });
  assert.deepEqual([gone.json.state, gone.json.learnedAt, gone.json.quizScore], ['new', null, 2]);
});

test('upgrade: an older row signed off without "learned" is repaired once, then nothing to do', async () => {
  run(srv.db, `INSERT INTO learning_progress (user_id, lesson_key, taught_signed_off_by, taught_signed_off_at, updated_at) VALUES (?, 'bamboo-theory', ?, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z')`, [
    fx().users.repB,
    fx().users.admin,
  ]);
  const changed = createSchema(srv.db);
  assert.ok(changed.includes('learning:learning_progress.learned_at'), JSON.stringify(changed));
  assert.equal(row(fx().users.repB, 'bamboo-theory')!.learnedAt, '2026-10-01T10:00:00.000Z');
  assert.ok(!createSchema(srv.db).some((c) => c.startsWith('learning:')), 'a second run changes nothing');
  const broken = all(srv.db, `SELECT 1 FROM learning_progress WHERE taught_signed_off_at IS NOT NULL AND learned_at IS NULL`);
  assert.equal(broken.length, 0);
});

test('upgrade: a table from before quiz_passed_at gets the column, filled in from the older rows, once', async () => {
  const u = fx().users.repB;
  const by = fx().users.admin;
  const T0 = '2026-10-01T09:00:00.000Z';
  const T1 = '2026-10-02T09:00:00.000Z';
  run(srv.db, `ALTER TABLE learning_progress DROP COLUMN quiz_passed_at`);
  const legacy = (key: string, learnedAt: string | null, score: number | null, total: number | null, signedAt: string | null) =>
    run(
      srv.db,
      `INSERT INTO learning_progress (user_id, lesson_key, learned_at, quiz_score, quiz_total, taught_signed_off_by, taught_signed_off_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [u, key, learnedAt, score, total, signedAt ? by : null, signedAt, T1],
    );
  legacy('green-light-theory', T0, 3, 3, T1); // passed, then signed off
  legacy('gumball-theory', T1, 2, 3, T1); // learned by the sign-off, a failed attempt: never passed
  legacy('can-cant-controls', T1, 3, 3, T1); // learned by the sign-off, passed afterwards
  legacy('buying-signs', T0, 1, 3, null); // passed, then a failed retake, no sign-off
  legacy('strategic-pause', null, 1, 3, null); // never passed
  const changed = createSchema(srv.db);
  assert.ok(changed.includes('learning:learning_progress.quiz_passed_at'), JSON.stringify(changed));
  const passedAt = (key: string) => row(u, key)!.quizPassedAt;
  assert.equal(passedAt('green-light-theory'), T0);
  assert.equal(passedAt('gumball-theory'), null);
  assert.equal(passedAt('can-cant-controls'), T1);
  assert.equal(passedAt('buying-signs'), T0);
  assert.equal(passedAt('strategic-pause'), null);
  assert.ok(!createSchema(srv.db).some((c) => c.startsWith('learning:')), 'a second run changes nothing');
  // and the withdraw rule reads it: the sign-off-only lesson goes back, the passed one stays
  const withdraw = (key: string) => admin.post(`/learning/progress/${u}/${key}/signoff`, { signedOff: false });
  assert.equal((await withdraw('gumball-theory')).json.state, 'new');
  assert.equal((await withdraw('can-cant-controls')).json.state, 'learned');
  assert.equal((await withdraw('green-light-theory')).json.state, 'learned');
});
