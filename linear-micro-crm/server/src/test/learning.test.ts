/**
 * L1 learning-pack: /learning/* on the small fixture (behaviour and role scoping), plus the demo seed's progress.
 * Assert shapes, rules and scoping, never seeded names beyond the demo accounts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_KEYS, PROGRESSION_RULES, QUIZ_ANSWER_KEY } from '@lm/shared';
import { get } from '../db/connection.ts';
import { setBusinessClock, toISODate } from '../lib/dates.ts';
import { addHistory, startTestServer, withSmart, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = toISODate(new Date());
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, recruiter, rep, repA2, repB] = await Promise.all([
    srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('repA2'), srv.login('repB'),
  ]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

const fx = () => srv.fixture!;
const gaugeRows = () => Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM gauge_entries`)!.n);
const lesson = (p: Json, key: string) => (p.lessons as Json[]).find((l) => l.lessonKey === key);
/** The self-check's answers with `wrong` of them changed (0 → every answer right). */
const answers = (key: keyof typeof QUIZ_ANSWER_KEY, wrong = 0) => QUIZ_ANSWER_KEY[key].map((a, i) => (i < wrong ? (a + 1) % 4 : a));

test('GET /learning/progress: own progress, one row per lesson in checklist order, all new at first', async () => {
  const r = await rep.get('/learning/progress');
  assert.equal(r.status, 200);
  assert.equal(r.json.userId, fx().users.rep);
  assert.equal(r.json.userName, 'Remy Rep');
  assert.deepEqual(r.json.lessons.map((l: Json) => l.lessonKey), [...LESSON_KEYS]);
  assert.ok(r.json.lessons.every((l: Json) => l.state === 'new' && l.learnedAt === null));
  assert.deepEqual([r.json.learned, r.json.taught, r.json.total], [0, 0, 21]);
});

test('quiz: learned only when every answer is right; a later retake keeps "learned" and records the last score', async () => {
  const before = gaugeRows();
  let r = await rep.post('/learning/progress/five-steps/quiz', { answers: answers('five-steps', 1) });
  assert.equal(r.status, 200);
  assert.equal(r.json.passed, false);
  assert.equal(r.json.progress.state, 'new');
  assert.equal(r.json.progress.quizScore, 2);
  r = await rep.post('/learning/progress/five-steps/quiz', { answers: answers('five-steps') });
  assert.equal(r.json.passed, true);
  assert.equal(r.json.progress.state, 'learned');
  const learnedAt = r.json.progress.learnedAt;
  assert.ok(learnedAt);
  r = await rep.post('/learning/progress/five-steps/quiz', { answers: answers('five-steps', 2) });
  assert.equal(r.json.passed, false);
  assert.equal(r.json.progress.state, 'learned');
  assert.equal(r.json.progress.learnedAt, learnedAt);
  assert.equal(r.json.progress.quizScore, 1);
  assert.equal(r.json.progress.quizTotal, 3);
  const p = (await rep.get('/learning/progress')).json;
  assert.equal(p.learned, 1);
  assert.equal(lesson(p, 'five-steps').state, 'learned');
  assert.equal(gaugeRows(), before, 'learning never writes a gauge row');
});

test('quiz: validation and unknown lessons (a score from the phone is refused; learning-selfcheck.test.ts has more)', async () => {
  assert.equal((await rep.post('/learning/progress/five-steps/quiz', { score: 3, total: 3 })).status, 400);
  assert.equal((await rep.post('/learning/progress/five-steps/quiz', { answers: [1, 2] })).status, 400);
  assert.equal((await rep.post('/learning/progress/five-steps/quiz', { answers: [1, 1.5, 0] })).status, 400);
  assert.equal((await rep.post('/learning/progress/five-steps/quiz', {})).status, 400);
  assert.equal((await rep.post('/learning/progress/not-a-lesson/quiz', { answers: [] })).status, 404);
});

test('teach-back: only after the self-check, at least a sentence, then waiting for a sign-off', async () => {
  const text = 'Intro, short story, presentation, close and consolidation, in that order.';
  assert.equal((await rep.post('/learning/progress/bullet-theory/teachback', { text })).status, 409);
  assert.equal((await rep.post('/learning/progress/five-steps/teachback', { text: 'too short' })).status, 400);
  const r = await rep.post('/learning/progress/five-steps/teachback', { text: `  ${text}  ` });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'teachback_sent');
  assert.equal(r.json.teachbackText, text);
  assert.ok(r.json.teachbackAt);
});

test('sign-off: the leader of the team or an admin, never your own, never another team', async () => {
  const url = (userId: number, key = 'five-steps') => `/learning/progress/${userId}/${key}/signoff`;
  assert.equal((await rep.post(url(fx().users.repA2), {})).status, 403, 'reps cannot sign off');
  assert.equal((await recruiter.post(url(fx().users.rep), {})).status, 403, 'recruiters cannot sign off');
  assert.equal((await leader.post(url(fx().users.repB), {})).status, 403, 'another team');
  assert.equal((await leader.post(url(fx().users.leader), {})).status, 403, 'your own');
  assert.equal((await leader.post(url(fx().users.rep, 'nope'), {})).status, 404);
  assert.equal((await leader.post(url(99999), {})).status, 404);

  let r = await leader.post(url(fx().users.rep), {});
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'taught');
  assert.equal(r.json.taughtSignedOffBy, fx().users.leader);
  assert.equal(r.json.taughtSignedOffByName, 'Lee Leader');
  // a second sign-off (by the admin) keeps the first signer
  r = await admin.post(url(fx().users.rep), { signedOff: true });
  assert.equal(r.json.taughtSignedOffBy, fx().users.leader);
  // withdraw: back to waiting
  r = await leader.post(url(fx().users.rep), { signedOff: false });
  assert.equal(r.json.state, 'teachback_sent');
  assert.equal(r.json.taughtSignedOffAt, null);
  // an in-person teach-back: signed off with nothing written, and it counts as learned too
  r = await admin.post(url(fx().users.repB, 'strategic-pause'), {});
  assert.equal(r.json.state, 'taught');
  assert.equal(r.json.teachbackText, null);
  assert.ok(r.json.learnedAt);
  assert.equal(r.json.markedLearned, true);
  r = await leader.post(url(fx().users.rep), {});
  assert.equal(r.json.state, 'taught');
  const p = (await rep.get('/learning/progress')).json;
  assert.deepEqual([p.learned, p.taught], [1, 1]);
});

test("GET /learning/progress?userId: leaders see their own team, admins anyone, reps only themselves", async () => {
  assert.equal((await rep.get(`/learning/progress?userId=${fx().users.repA2}`)).status, 403);
  assert.equal((await rep.get(`/learning/progress?userId=${fx().users.rep}`)).status, 200);
  assert.equal((await recruiter.get(`/learning/progress?userId=${fx().users.rep}`)).status, 403);
  assert.equal((await leader.get(`/learning/progress?userId=${fx().users.repB}`)).status, 403);
  const mine = await leader.get(`/learning/progress?userId=${fx().users.rep}`);
  assert.equal(mine.status, 200);
  assert.equal(lesson(mine.json, 'five-steps').teachbackText?.startsWith('Intro'), true, 'the team leader reads the teach-back');
  assert.equal((await admin.get(`/learning/progress?userId=${fx().users.repB}`)).status, 200);
  assert.equal((await rep.get('/learning/progress?userId=abc')).status, 400);
  assert.equal((await admin.get('/learning/progress?userId=99999')).status, 404);
});

test('GET /learning/team: leader → own team only; admin → every field person; reps and recruiters 403', async () => {
  assert.equal((await rep.get('/learning/team')).status, 403);
  assert.equal((await recruiter.get('/learning/team')).status, 403);
  // repA2 writes a teach-back so the leader has something waiting
  await repA2.post('/learning/progress/law-of-averages/quiz', { answers: answers('law-of-averages') });
  await repA2.post('/learning/progress/law-of-averages/teachback', { text: 'The more stops I make, the more sales I get.' });
  const t = await leader.get('/learning/team');
  assert.equal(t.status, 200);
  assert.equal(t.json.total, 21);
  assert.ok(t.json.rows.length >= 3);
  assert.ok(t.json.rows.every((r: Json) => r.teamId === fx().teams.a), 'only team A');
  assert.ok(t.json.rows.every((r: Json) => r.lessons.length === 21));
  const a2 = t.json.rows.find((r: Json) => r.userId === fx().users.repA2);
  assert.deepEqual([a2.learned, a2.taught, a2.awaitingSignOff], [1, 0, 1]);
  assert.ok(t.json.pending.some((p: Json) => p.userId === fx().users.repA2 && p.lessonKey === 'law-of-averages' && /more stops/.test(p.teachbackText)));
  assert.ok(t.json.pending.every((p: Json) => p.userId !== fx().users.leader), 'never your own in the queue');

  const all = await admin.get('/learning/team');
  assert.equal(all.status, 200);
  const ids = all.json.rows.map((r: Json) => r.userId);
  assert.ok(ids.includes(fx().users.repB), 'admin sees team B');
  assert.ok(ids.includes(fx().users.recruiter), 'admin sees recruiters too (the office signs their teach-backs off)');
  assert.ok(!t.json.rows.some((r: Json) => r.userId === fx().users.recruiter), 'a leader never sees the recruiter');
  // nothing about team B reaches the team A leader
  assert.ok(!t.json.rows.some((r: Json) => r.userId === fx().users.repB));
  assert.ok(!t.json.pending.some((p: Json) => p.userId === fx().users.repB));
  void repB;
});

test('GET /learning/progression: level from position, real weekly sales, scoped like progress', async () => {
  // Remy: last completed week 4 days × 4 sales = 16 → the 14-in-a-week criterion is met.
  addHistory(srv.db, { userId: fx().users.rep, teamId: fx().teams.a, campaignId: fx().campaignId, weeks: 2, stops: 60, sales: (w) => (w === 1 ? 4 : 2), today: TODAY });
  srv.resetCache();
  const r = await rep.get(`/learning/progression/${fx().users.rep}`);
  assert.equal(r.status, 200);
  const p = r.json;
  assert.equal(p.level, 'entry');
  assert.equal(p.nextLevel, 'leadership');
  assert.equal(p.enabled, true);
  assert.equal(p.weeks.length, PROGRESSION_RULES.windowWeeks);
  assert.equal(p.weeks.at(-2).sales, 16, 'last week');
  assert.equal(p.weeks.at(-3).sales, 8, 'the week before');
  assert.ok(p.weeks.every((w: Json) => w.teamSales >= w.sales), 'team sales include the person');
  const sales = p.requirements.find((q: Json) => q.key === 'sales');
  assert.equal(sales.met, true);
  assert.match(sales.options[0].detail, /^Reached: 16 sales the week of /);
  assert.match(p.headline, /^Your next level: 1 of 21 lessons learned; 1 of 21 taught back$/);

  // scoping
  assert.equal((await rep.get(`/learning/progression/${fx().users.repA2}`)).status, 403);
  assert.equal((await leader.get(`/learning/progression/${fx().users.repB}`)).status, 403);
  const seen = await leader.get(`/learning/progression/${fx().users.rep}`);
  assert.equal(seen.status, 200);
  assert.match(seen.json.headline, /^Next level: /, 'phrased for the leader, not "Your"');
  assert.equal((await admin.get(`/learning/progression/${fx().users.repB}`)).status, 200);
  assert.equal((await admin.get('/learning/progression/0')).status, 400);

  // recruiters sit outside the ladder
  const rec = (await recruiter.get(`/learning/progression/${fx().users.recruiter}`)).json;
  assert.equal(rec.level, null);
  assert.deepEqual(rec.requirements, []);
});

test('PUT /learning/milestones: admin ticks a manual criterion; others 403; bad key 404, bad value 400', async () => {
  const url = `/learning/milestones/${fx().users.leader}/trained_personalities`;
  assert.equal((await leader.put(url, { value: 1 })).status, 403);
  assert.equal((await rep.put(url, { value: 1 })).status, 403);
  assert.equal((await admin.put(`/learning/milestones/${fx().users.leader}/nope`, { value: 1 })).status, 404);
  assert.equal((await admin.put(url, { value: -1 })).status, 400);
  assert.equal((await admin.put(url, { value: 'yes' })).status, 400);
  const r = await admin.put(url, { value: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.level, 'leadership');
  const req = r.json.requirements.find((q: Json) => q.key === 'personalities');
  assert.equal(req.met, true);
  assert.equal(req.options[0].manual, true);
  // the leader sees it on their own tracker
  const own = (await leader.get(`/learning/progression/${fx().users.leader}`)).json;
  assert.equal(own.requirements.find((q: Json) => q.key === 'personalities').met, true);
  assert.match(own.headline, /^Your next level: 0 of 3 people trained to leadership$/);
});

test('cached reads refresh after a write', async () => {
  const a = await repA2.get('/learning/progress');
  const b = await repA2.get('/learning/progress');
  assert.equal(b.headers.get('x-cache'), 'HIT');
  await repA2.post('/learning/progress/working-habits/quiz', { answers: answers('working-habits') });
  const c = await repA2.get('/learning/progress');
  assert.equal(c.headers.get('x-cache'), 'MISS');
  assert.equal(c.json.learned, a.json.learned + 1);
});

test('kill switch: LM_SMART=0 leaves the level but no tracker', async () => {
  await withSmart('0', async () => {
    srv.resetCache();
    const p = (await rep.get(`/learning/progression/${fx().users.rep}`)).json;
    assert.equal(p.enabled, false);
    assert.equal(p.level, 'entry');
    assert.deepEqual(p.requirements, []);
    assert.equal(p.headline, '');
    // lessons keep working
    assert.equal((await rep.get('/learning/progress')).status, 200);
  });
  srv.resetCache();
});

test('demo seed: the demo rep has progress waiting for their leader; no learning row for anyone who left', async () => {
  const demo = await startTestServer({ seed: true, today: TODAY });
  try {
    const jordan = await demo.login('rep');
    const amelia = await demo.login('leader');
    const p = (await jordan.get('/learning/progress')).json;
    assert.deepEqual([p.learned, p.taught], [9, 4]);
    assert.equal(p.lessons.filter((l: Json) => l.state === 'teachback_sent').length, 2);
    const team = (await amelia.get('/learning/team')).json;
    assert.ok(team.pending.some((x: Json) => x.userId === p.userId), "Jordan's teach-backs wait for the leader");
    const left = Number(get<{ n: number }>(demo.db, `SELECT COUNT(*) AS n FROM learning_progress l JOIN users u ON u.id = l.user_id WHERE u.status = 'left'`)!.n);
    assert.equal(left, 0);
    const prog = (await jordan.get(`/learning/progression/${p.userId}`)).json;
    assert.equal(prog.level, 'entry');
    assert.match(prog.headline, /^Your next level: |^Every criterion/);
  } finally {
    await demo.close();
  }
});
