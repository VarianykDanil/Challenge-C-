/**
 * P7 recruitment-plus: date of birth on candidates, the interview change log (bookings, reassignments, reschedules,
 * changes of type, outcomes), the candidate timeline, the question bank, the interview sheet (draft from the bank,
 * questions fixed on the first save) and the schedule — every route for admin, leader, recruiter, rep, a client account
 * and anonymous, the audit rows, and the default bank on an upgraded database.
 *
 * Fixture people: Ada Admin, Lee Leader, Rae Recruiter, Remy Rep (and Cleo Client of the fixture campaign).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { businessWhenLabel, interviewDay, questionTopicWarning } from '@lm/shared';
import { all, get } from '../db/connection.ts';
import { extension as recruitment, upgradeDefaultQuestions } from '../db/extensions/recruitment.ts';
import { DEFAULT_INTERVIEW_QUESTIONS } from '../lib/recruitmentPlus/defaults.ts';
import { addDays, todayISO } from '../lib/dates.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let client: TestClient;
const fx = () => srv.fixture!;
const when = (iso: string) => businessWhenLabel(iso, todayISO());

const lastAudit = () =>
  get<{ action: string; entity: string | null; entityId: number | null; summary: string; beforeJson: string | null; afterJson: string | null; userId: number | null }>(
    srv.db,
    `SELECT action, entity, entity_id AS entityId, summary, before_json AS beforeJson, after_json AS afterJson, user_id AS userId FROM audit_log ORDER BY id DESC LIMIT 1`,
  )!;
const auditCount = () => Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM audit_log`)!.n);

before(async () => {
  srv = await startTestServer();
  [admin, leader, recruiter, rep, client] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('client')]);
});
after(async () => {
  await srv.close();
});

let n = 0;
async function newCandidate(extra: Record<string, unknown> = {}, who: TestClient = recruiter): Promise<Json> {
  n++;
  const r = await who.post('/recruitment/candidates', { firstName: 'Sam', lastName: `Brown${n}`, email: `sam.brown${n}@example.com`, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function newInterview(candidateId: number, body: Record<string, unknown> = {}, who: TestClient = recruiter): Promise<Json> {
  const r = await who.post('/recruitment/interviews', { candidateId, type: 'phone', scheduledAt: '2026-11-10T10:00:00.000Z', interviewerId: fx().users.leader, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// ───────────────────────────── the default bank ─────────────────────────────

test('upgrade: a database with people and no bank gets the default questions once (reported once)', () => {
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM interview_questions`)!.n), 0, 'the fixture is built after createSchema: no bank yet');
  assert.deepEqual(recruitment.upgrade(srv.db), [], 'a data step in its own table, not a schema change: not listed');
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM interview_questions`)!.n), DEFAULT_INTERVIEW_QUESTIONS.length, 'written by that start');
  assert.equal(upgradeDefaultQuestions(srv.db), 0, 'the second start adds nothing (the meta flag)');
  const rows = all<{ type: string; text: string; sort: number; position: string | null; active: number }>(
    srv.db,
    `SELECT interview_type AS type, text, sort, position, active FROM interview_questions ORDER BY id`,
  );
  assert.equal(rows.length, DEFAULT_INTERVIEW_QUESTIONS.length);
  assert.deepEqual(rows.filter((r) => r.type === 'phone').map((r) => r.sort), [0, 1, 2, 3, 4, 5], 'ordered within each type');
  assert.ok(rows.every((r) => r.active === 1));
  assert.deepEqual(new Set(rows.map((r) => r.type)), new Set(['phone', 'first', 'observation', 'final']));
});

test('the default questions are plain and lawful: none touches a protected characteristic', () => {
  for (const q of DEFAULT_INTERVIEW_QUESTIONS) assert.equal(questionTopicWarning(q.text), null, q.text);
});

// ───────────────────────────── roles ─────────────────────────────

test('every P7 route: recruitment roles in, the question bank admin and recruiter only, reps and clients out, anonymous 401', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id);
  const q = (await admin.get('/recruitment/questions?type=phone')).json[0];
  const routes: [string, string, unknown, ('admin' | 'leader' | 'recruiter')[]][] = [
    ['GET', '/recruitment/schedule', undefined, ['admin', 'leader', 'recruiter']],
    ['GET', `/recruitment/candidates/${c.id}/timeline`, undefined, ['admin', 'leader', 'recruiter']],
    ['GET', `/recruitment/candidates/${c.id}/sheets`, undefined, ['admin', 'leader', 'recruiter']],
    ['GET', `/recruitment/interviews/${iv.id}/sheet`, undefined, ['admin', 'leader', 'recruiter']],
    ['PUT', `/recruitment/interviews/${iv.id}/answers`, [{ questionId: q.id, answer: 'Role check' }], ['admin', 'leader', 'recruiter']],
    ['GET', '/recruitment/questions', undefined, ['admin', 'recruiter']],
    ['POST', '/recruitment/questions', { interviewType: 'final', text: 'What would you like to ask us?' }, ['admin', 'recruiter']],
    ['PATCH', `/recruitment/questions/${q.id}`, { text: q.text }, ['admin', 'recruiter']],
    ['PUT', '/recruitment/questions/order', { interviewType: 'observation', ids: [0] }, ['admin', 'recruiter']],
  ];
  const sessions = { admin, leader, recruiter, rep, client };
  for (const [method, path, body, allowed] of routes) {
    for (const [role, s] of Object.entries(sessions)) {
      const r = await s.req(method, path, body);
      if ((allowed as string[]).includes(role)) {
        assert.ok(r.status !== 401 && r.status !== 403 && r.status < 500, `${role} ${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
      } else if (role === 'client') {
        assert.equal(r.status, 403, `client ${method} ${path}`);
        assert.equal(r.json?.clientPortalOnly, true, `client ${method} ${path}`);
      } else {
        assert.equal(r.status, 403, `${role} ${method} ${path} → ${r.status}`);
      }
    }
    assert.equal((await srv.anon().req(method, path, body)).status, 401, `anonymous ${method} ${path}`);
  }
  // The 1.0 routes P7 changed keep their own role check.
  assert.equal((await rep.post('/recruitment/candidates', { firstName: 'A', lastName: 'B', email: 'ab@example.com', dateOfBirth: '2000-01-01' })).status, 403);
  assert.equal((await rep.patch(`/recruitment/interviews/${iv.id}`, { interviewerId: fx().users.admin })).status, 403);
  assert.equal((await client.patch(`/recruitment/candidates/${c.id}`, { dateOfBirth: '2000-01-01' })).status, 403);
});

test('missing records answer 404 with their name; bad ids 400', async () => {
  assert.equal((await admin.get('/recruitment/candidates/99999/timeline')).json.error, 'Candidate not found');
  assert.equal((await admin.get('/recruitment/candidates/99999/sheets')).status, 404);
  assert.equal((await admin.get('/recruitment/interviews/99999/sheet')).json.error, 'Interview not found');
  assert.equal((await admin.put('/recruitment/interviews/99999/answers', [{ questionId: null, questionText: 'Anything?', answer: 'x' }])).status, 404);
  assert.equal((await admin.patch('/recruitment/questions/99999', { active: false })).json.error, 'Question not found');
  assert.equal((await admin.get('/recruitment/candidates/abc/timeline')).status, 400);
});

// ───────────────────────────── date of birth ─────────────────────────────

test('date of birth: saved on create and edit, cleared with null or "", checked against today, absent while not recorded', async () => {
  const today = todayISO();
  const seventeen = addDays(`${Number(today.slice(0, 4)) - 18}${today.slice(4, 7)}-01`, 40);
  const created = await newCandidate({ dateOfBirth: '2001-03-12' });
  assert.equal(created.dateOfBirth, '2001-03-12');
  assert.equal((await leader.get(`/recruitment/candidates/${created.id}`)).json.dateOfBirth, '2001-03-12', 'leaders see it (a recruitment role)');
  const young = await recruiter.patch(`/recruitment/candidates/${created.id}`, { dateOfBirth: seventeen });
  assert.equal(young.status, 200);
  assert.equal(young.json.dateOfBirth, seventeen, 'under 18 is allowed (the profile warns)');
  const notes = await recruiter.patch(`/recruitment/candidates/${created.id}`, { notes: 'Called back' });
  assert.equal(notes.json.dateOfBirth, seventeen, 'a patch without it keeps it');
  assert.equal((await recruiter.patch(`/recruitment/candidates/${created.id}`, { dateOfBirth: '' })).json.dateOfBirth, undefined, '"" clears it');
  await recruiter.patch(`/recruitment/candidates/${created.id}`, { dateOfBirth: '1999-05-05' });
  assert.equal((await recruiter.patch(`/recruitment/candidates/${created.id}`, { dateOfBirth: null })).json.dateOfBirth, undefined, 'null clears it');
  assert.equal(get<{ dob: string | null }>(srv.db, `SELECT date_of_birth AS dob FROM candidates WHERE id = ?`, [created.id])!.dob, null);

  const bad: [unknown, RegExp][] = [
    [addDays(today, 1), /cannot be in the future/],
    [addDays(today, -365 * 10), /Check the year/],
    ['1900-01-01', /Check the year/],
    ['2001-02-30', /real date/],
    ['12/03/2001', /real date/],
  ];
  for (const [value, message] of bad) {
    const r = await recruiter.patch(`/recruitment/candidates/${created.id}`, { dateOfBirth: value });
    assert.equal(r.status, 400, String(value));
    assert.match(r.json.error, message, String(value));
    const p = await recruiter.post('/recruitment/candidates', { firstName: 'Bad', lastName: 'Date', email: `bad.${n++}@example.com`, dateOfBirth: value });
    assert.equal(p.status, 400, `POST ${String(value)}`);
  }
  assert.equal((await recruiter.patch(`/recruitment/candidates/${created.id}`, { dateOfBirth: 20010312 })).status, 400, 'a number is not a date');
});

test('audit: a date of birth change is explained (the 1.2 wording otherwise untouched)', async () => {
  const c = await newCandidate();
  await recruiter.patch(`/recruitment/candidates/${c.id}`, { dateOfBirth: '2001-03-12' });
  let row = lastAudit();
  assert.equal(row.action, 'PATCH /recruitment/candidates/:id');
  assert.equal(row.entity, 'candidate');
  assert.equal(row.entityId, c.id);
  assert.equal(row.summary, `Updated candidate Sam ${c.lastName}: date of birth set to 12 Mar 2001`);
  assert.equal(JSON.parse(row.afterJson!).dateOfBirth, '2001-03-12');
  assert.equal(JSON.parse(row.beforeJson!).dateOfBirth, null);
  await recruiter.patch(`/recruitment/candidates/${c.id}`, { dateOfBirth: '2001-03-13', city: 'Salford' });
  row = lastAudit();
  assert.equal(row.summary, `Updated candidate Sam ${c.lastName}: city — → Salford; date of birth changed from 12 Mar 2001 to 13 Mar 2001`);
  await recruiter.patch(`/recruitment/candidates/${c.id}`, { dateOfBirth: null });
  assert.equal(lastAudit().summary, `Updated candidate Sam ${c.lastName}: date of birth removed (was 13 Mar 2001)`);
  await recruiter.patch(`/recruitment/candidates/${c.id}`, { city: 'Bury' });
  row = lastAudit();
  assert.equal(row.summary, `Updated candidate Sam ${c.lastName}: city Salford → Bury`, 'no date of birth change: the 1.2 row as it was');
  assert.equal('dateOfBirth' in JSON.parse(row.afterJson!), false);
  const created = await newCandidate({ dateOfBirth: '2002-07-01' });
  row = lastAudit();
  assert.equal(row.action, 'POST /recruitment/candidates');
  assert.match(row.summary, /^Added candidate: Sam Brown\d+/);
  assert.equal(JSON.parse(row.afterJson!).dateOfBirth, '2002-07-01');
  assert.equal(row.entityId, created.id);
});

// ───────────────────────────── interview changes and the timeline ─────────────────────────────

test('interview changes: a booking, a reassignment, a reschedule, a change of type and an outcome each log who and when; an unchanged save logs nothing', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id, { scheduledAt: '2026-11-10T10:00:00.000Z', interviewerId: fx().users.leader });
  const changes = () =>
    all<{ field: string; fromValue: string | null; toValue: string | null; changedBy: number }>(
      srv.db,
      `SELECT field, from_value AS fromValue, to_value AS toValue, changed_by AS changedBy FROM interview_changes WHERE interview_id = ? ORDER BY id`,
      [iv.id],
    ).map((r) => ({ ...r }));
  assert.deepEqual(changes(), [{ field: 'booked', fromValue: null, toValue: '2026-11-10T10:00:00.000Z', changedBy: fx().users.recruiter }]);

  await recruiter.patch(`/recruitment/interviews/${iv.id}`, { interviewerId: fx().users.admin, scheduledAt: '2026-11-11T14:30:00+00:00' });
  await recruiter.patch(`/recruitment/interviews/${iv.id}`, { scheduledAt: '2026-11-11T14:30:00.000Z', notes: 'Bring ID' });
  await recruiter.patch(`/recruitment/interviews/${iv.id}`, { type: 'first' });
  await admin.patch(`/recruitment/interviews/${iv.id}`, { outcome: 'passed' });
  await admin.patch(`/recruitment/interviews/${iv.id}`, { interviewerId: null });
  assert.deepEqual(changes().slice(1), [
    { field: 'interviewer', fromValue: String(fx().users.leader), toValue: String(fx().users.admin), changedBy: fx().users.recruiter },
    { field: 'scheduled_at', fromValue: '2026-11-10T10:00:00.000Z', toValue: '2026-11-11T14:30:00.000Z', changedBy: fx().users.recruiter },
    { field: 'type', fromValue: 'phone', toValue: 'first', changedBy: fx().users.recruiter },
    { field: 'outcome', fromValue: 'pending', toValue: 'passed', changedBy: fx().users.admin },
    { field: 'interviewer', fromValue: String(fx().users.admin), toValue: null, changedBy: fx().users.admin },
  ], 'the same instant written another way, and notes, log nothing');
  const failed = await rep.patch(`/recruitment/interviews/${iv.id}`, { outcome: 'failed' });
  assert.equal(failed.status, 403);
  assert.equal(changes().length, 6, 'a refused write logs nothing');
});

test('the timeline: every stage with who moved it, every interview, the booking, reassignment, reschedule and outcome — newest first', async () => {
  const c = await newCandidate();
  await recruiter.post(`/recruitment/candidates/${c.id}/stage`, { stage: 'screening', note: 'Strong CV' });
  const iv = await newInterview(c.id, { scheduledAt: '2026-11-10T10:00:00.000Z', interviewerId: fx().users.leader });
  await recruiter.patch(`/recruitment/interviews/${iv.id}`, { interviewerId: fx().users.admin });
  await recruiter.patch(`/recruitment/interviews/${iv.id}`, { scheduledAt: '2026-11-12T15:00:00.000Z' });
  await admin.patch(`/recruitment/interviews/${iv.id}`, { outcome: 'passed' });
  await leader.post(`/recruitment/candidates/${c.id}/stage`, { stage: 'interview' });

  const r = await leader.get(`/recruitment/candidates/${c.id}/timeline`);
  assert.equal(r.status, 200);
  const items: Json[] = r.json;
  const texts = items.map((i) => i.text);
  // The interview itself sits at its own (future) time, so it comes first; the rest in the order they happened, newest first.
  assert.deepEqual(texts, [
    'Phone screen with Ada Admin',
    'Moved from Phone screen to Interview by Lee Leader',
    'Phone screen outcome recorded as passed by Ada Admin',
    `Phone screen moved from ${when('2026-11-10T10:00:00.000Z')} to ${when('2026-11-12T15:00:00.000Z')} by Rae Recruiter`,
    'Phone screen: interviewer changed from Lee Leader to Ada Admin by Rae Recruiter',
    `Phone screen booked for ${when('2026-11-10T10:00:00.000Z')} by Rae Recruiter`,
    'Moved from Applied to Phone screen by Rae Recruiter',
    'Applied for the Trainee position (added by Rae Recruiter)',
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['interview', 'stage', 'outcome', 'reschedule', 'interviewer', 'booked', 'stage', 'applied']);
  const interview = items[0];
  assert.equal(interview.interviewId, iv.id);
  assert.equal(interview.outcome, 'passed');
  assert.equal(interview.at, '2026-11-12T15:00:00.000Z');
  assert.equal(items.find((i) => i.text.startsWith('Moved from Applied')).detail, 'Strong CV');
  assert.equal(items.find((i) => i.kind === 'outcome').byId, fx().users.admin);
});

// ───────────────────────────── the question bank ─────────────────────────────

test('question bank: add (at the end of its type), edit, turn off, reorder; validation', async () => {
  const before = (await recruiter.get('/recruitment/questions?type=final')).json as Json[];
  const added = await recruiter.post('/recruitment/questions', { interviewType: 'final', text: '  What questions\n do you have for us?  ' });
  assert.equal(added.status, 201);
  assert.equal(added.json.text, 'What questions do you have for us?', 'trimmed, one space between words');
  assert.equal(added.json.sort, Math.max(...before.map((q) => q.sort)) + 1);
  assert.equal(added.json.active, true);
  assert.equal(added.json.position, null);
  let row = lastAudit();
  assert.equal(row.entity, 'interview_question');
  assert.equal(row.entityId, added.json.id);
  assert.equal(row.summary, 'Added a final interview question: “What questions do you have for us?”');

  const leaderOnly = await admin.post('/recruitment/questions', { interviewType: 'final', text: 'How would you run a team huddle?', position: 'team_leader', active: false });
  assert.equal(leaderOnly.json.position, 'team_leader');
  assert.equal(leaderOnly.json.active, false);

  const edited = await admin.patch(`/recruitment/questions/${added.json.id}`, { text: 'What would you like to ask us about the job?' });
  assert.equal(edited.json.text, 'What would you like to ask us about the job?');
  assert.match(lastAudit().summary, /^Edited a final interview question: text/);
  const count = auditCount();
  assert.equal((await admin.patch(`/recruitment/questions/${added.json.id}`, { text: 'What would you like to ask us about the job?' })).status, 200);
  assert.equal(auditCount(), count, 'a save of the same values writes no audit row');
  await admin.patch(`/recruitment/questions/${added.json.id}`, { active: false });
  assert.equal(lastAudit().summary, 'Turned off a final interview question: “What would you like to ask us about the job?”');

  for (const body of [
    { interviewType: 'final', text: 'Why?' },
    { interviewType: 'lunch', text: 'What is your favourite sandwich?' },
    { interviewType: 'final', text: 'x'.repeat(301) },
    { interviewType: 'final', text: 'Valid question here', position: 'client' },
    { text: 'No type given here' },
  ]) {
    assert.equal((await admin.post('/recruitment/questions', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await admin.get('/recruitment/questions?type=lunch')).status, 400);

  const finals = (await admin.get('/recruitment/questions?type=final')).json as Json[];
  const ids = finals.map((q) => q.id);
  const reversed = [...ids].reverse();
  const reordered = await recruiter.put('/recruitment/questions/order', { interviewType: 'final', ids: reversed });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.json.map((q: Json) => q.id), reversed);
  assert.deepEqual(reordered.json.map((q: Json) => q.sort), reversed.map((_, i) => i));
  row = lastAudit();
  assert.equal(row.summary, 'Reordered the final interview questions');
  const again = auditCount();
  await recruiter.put('/recruitment/questions/order', { interviewType: 'final', ids: reversed });
  assert.equal(auditCount(), again, 'the same order writes nothing');
  assert.equal((await recruiter.put('/recruitment/questions/order', { interviewType: 'final', ids: reversed.slice(1) })).status, 400, 'every question of the type');
  assert.equal((await recruiter.put('/recruitment/questions/order', { interviewType: 'final', ids: [...reversed.slice(1), reversed[1]] })).status, 400, 'twice');
  const all4 = (await admin.get('/recruitment/questions')).json as Json[];
  assert.deepEqual([...new Set(all4.map((q) => q.interviewType))], ['phone', 'first', 'observation', 'final'], 'types in interview order');
});

// ───────────────────────────── the interview sheet ─────────────────────────────

test('the sheet: the bank\'s draft until the first save; then the questions as asked, whatever the bank says later', async () => {
  const c = await newCandidate({ positionApplied: 'trainee', dateOfBirth: '2003-04-05' });
  const iv = await newInterview(c.id, { type: 'first' });
  const draft = (await leader.get(`/recruitment/interviews/${iv.id}/sheet`)).json;
  assert.equal(draft.saved, false);
  assert.equal(draft.interview.candidateName, `Sam ${c.lastName}`);
  assert.deepEqual(draft.candidate, { id: c.id, name: `Sam ${c.lastName}`, stage: 'applied', positionApplied: 'trainee', dateOfBirth: '2003-04-05' });
  const bankFirst = DEFAULT_INTERVIEW_QUESTIONS.filter((q) => q.type === 'first');
  assert.deepEqual(draft.answers.map((a: Json) => a.questionText), bankFirst.filter((q) => q.position === null).map((q) => q.text), 'the team leader question is not on a trainee\'s sheet');
  assert.ok(draft.answers.every((a: Json) => a.id === undefined && a.answer === '' && a.score === null));
  assert.deepEqual(draft.summary, { questions: 7, answered: 0, scored: 0, averageScore: null });
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM interview_answers WHERE interview_id = ?`, [iv.id])!.n), 0, 'a read writes nothing');

  const payload = draft.answers.map((a: Json, i: number) => ({ questionId: a.questionId, questionText: a.questionText, answer: i === 0 ? 'Talked a regular round to a loyalty card.' : '', score: i === 0 ? 4 : i === 1 ? 5 : null }));
  payload.push({ questionId: null, questionText: 'Can you do Saturdays in December?', answer: 'Yes', score: null });
  const saved = await leader.put(`/recruitment/interviews/${iv.id}/answers`, payload);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.saved, true);
  assert.equal(saved.json.answers.length, 8);
  assert.deepEqual(saved.json.summary, { questions: 8, answered: 2, scored: 2, averageScore: 4.5 });
  const first = saved.json.answers[0];
  assert.equal(first.updatedByName, 'Lee Leader');
  assert.ok(first.updatedAt);
  assert.equal(saved.json.answers[2].updatedAt, null, 'a blank question has no author');
  assert.equal(saved.json.answers[7].questionId, null);
  let row = lastAudit();
  assert.equal(row.entity, 'candidate');
  assert.equal(row.entityId, c.id);
  assert.equal(row.summary, `Started the first interview sheet for Sam ${c.lastName}: 2 of 8 answered, average score 4.5`);
  assert.equal(JSON.parse(row.afterJson!).answers[0].question, bankFirst[0]!.text);

  // The bank changes; the saved sheet does not.
  const q0 = draft.answers[0].questionId;
  await admin.patch(`/recruitment/questions/${q0}`, { text: 'A brand new wording of the first question' });
  const reread = (await recruiter.get(`/recruitment/interviews/${iv.id}/sheet`)).json;
  assert.equal(reread.answers[0].questionText, bankFirst[0]!.text);
  // A later save sending other words for a stored bank question keeps the stored words.
  const second = reread.answers.map((a: Json) => ({ questionId: a.questionId, questionText: a.questionId === q0 ? 'Changed words' : a.questionText, answer: a.answer, score: a.score }));
  second[1].answer = 'Smile, thank them, move on.';
  const updated = (await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, second)).json;
  assert.equal(updated.answers[0].questionText, bankFirst[0]!.text);
  assert.equal(updated.answers[1].updatedByName, 'Rae Recruiter');
  assert.equal(updated.answers[0].updatedByName, 'Lee Leader', 'an unchanged answer keeps its author');
  row = lastAudit();
  assert.equal(row.summary, `Updated the first interview sheet for Sam ${c.lastName}: 3 of 8 answered, average score 4.5`);

  const count = auditCount();
  const same = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, second);
  assert.equal(same.status, 200);
  assert.equal(auditCount(), count, 'an identical autosave writes no audit row');

  // Taking questions off needs `removed: true`; questions left out of a save stay; the order never changes.
  const left = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [second[1], second[0]]);
  assert.equal(left.json.answers.length, 8, 'questions left out are not taken off');
  assert.deepEqual(left.json.answers.slice(0, 2).map((a: Json) => a.questionId), [second[0].questionId, second[1].questionId], 'the order stays as first saved');
  const after = (await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [{ ...second[6], removed: true }, { ...second[7], removed: true }])).json;
  assert.deepEqual(after.answers.map((a: Json) => a.questionId), second.slice(0, 6).map((a: Json) => a.questionId));
  assert.equal(after.answers.length, 6, 'the question of their own and the last bank question are off the sheet');

  // The candidate page's saved sheets.
  const sheets = (await admin.get(`/recruitment/candidates/${c.id}/sheets`)).json;
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].interviewId, iv.id);
  assert.equal(sheets[0].type, 'first');
  assert.equal(sheets[0].interviewerName, 'Lee Leader');
  assert.equal(sheets[0].answers.length, 6);
  await admin.patch(`/recruitment/questions/${q0}`, { text: bankFirst[0]!.text });
});

test('the sheet refuses unknown or repeated questions, wordless own questions, an empty list, bad scores and long answers', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id);
  const bank = (await admin.get('/recruitment/questions?type=phone')).json as Json[];
  const put = (body: unknown) => recruiter.put(`/recruitment/interviews/${iv.id}/answers`, body);
  const cases: [unknown, RegExp | null][] = [
    [[{ questionId: 999_999, answer: 'x' }], /Unknown question/],
    [[{ questionId: bank[0].id, answer: 'x' }, { questionId: bank[0].id, answer: 'y' }], /twice/],
    [[{ questionId: null, answer: 'x' }], /needs its words/],
    [[{ questionId: null, questionText: 'Saturday?', answer: '' }, { questionId: null, questionText: ' saturday? ', answer: '' }], /twice/],
    [[], null],
    [[{ questionId: bank[0].id, answer: 'x', score: 6 }], null],
    [[{ questionId: bank[0].id, answer: 'x', score: 2.5 }], null],
    [[{ questionId: bank[0].id, answer: 'x'.repeat(4001) }], null],
    [{ questionId: bank[0].id, answer: 'x' }, null],
    [Array.from({ length: 31 }, (_, i) => ({ questionId: null, questionText: `Question number ${i}`, answer: '' })), null],
  ];
  for (const [body, message] of cases) {
    const r = await put(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    if (message) assert.match(r.json.error, message);
  }
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM interview_answers WHERE interview_id = ?`, [iv.id])!.n), 0, 'nothing written');
});

test('a deleted interview takes its sheet and its change log with it', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id);
  await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [{ questionId: null, questionText: 'Anything to add?', answer: 'No' }]);
  srv.db.prepare(`DELETE FROM interviews WHERE id = ?`).run(iv.id);
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM interview_answers WHERE interview_id = ?`, [iv.id])!.n), 0);
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM interview_changes WHERE interview_id = ?`, [iv.id])!.n), 0);
});

// ───────────────────────────── the schedule ─────────────────────────────

test('the schedule: by London day, filters for interviewer (or none) and type, the sheet\'s progress, range checks', async () => {
  const c = await newCandidate({ firstName: 'Zara', positionApplied: 'field_rep' });
  const a = await newInterview(c.id, { scheduledAt: '2026-07-14T23:30:00.000Z', type: 'first', interviewerId: fx().users.leader }); // 00:30 on 15 Jul in London
  const b = await newInterview(c.id, { scheduledAt: '2026-07-15T09:00:00.000Z', type: 'phone', interviewerId: null });
  const d = await newInterview(c.id, { scheduledAt: '2026-07-16T13:00:00.000Z', type: 'observation', interviewerId: fx().users.admin });
  await recruiter.put(`/recruitment/interviews/${d.id}/answers`, [
    { questionId: null, questionText: 'How was the day?', answer: 'Good' },
    { questionId: null, questionText: 'Anything hard?', answer: '' },
  ]);
  const ids = (r: Json) => (r.json as Json[]).filter((i) => i.candidateId === c.id).map((i) => i.id);

  const day = await leader.get('/recruitment/schedule?from=2026-07-15&to=2026-07-15');
  assert.equal(day.status, 200);
  assert.deepEqual(ids(day), [a.id, b.id], 'the 23:30 UTC interview is on 15 Jul in London');
  assert.equal(interviewDay('2026-07-14T23:30:00.000Z'), '2026-07-15');
  const item = (day.json as Json[]).find((i) => i.id === a.id);
  assert.equal(item.day, '2026-07-15');
  assert.equal(item.candidateName, `Zara ${c.lastName}`);
  assert.equal(item.candidateStage, 'applied');
  assert.equal(item.positionApplied, 'field_rep');
  assert.equal(item.interviewerName, 'Lee Leader');
  assert.equal(item.sheetQuestions, DEFAULT_INTERVIEW_QUESTIONS.filter((q) => q.type === 'first' && q.position === null).length, 'the draft count for a field rep');
  assert.equal(item.sheetAnswered, 0);
  assert.deepEqual(ids(await admin.get('/recruitment/schedule?from=2026-07-14&to=2026-07-14')), [], 'not on 14 Jul');

  const week = await recruiter.get('/recruitment/schedule?from=2026-07-13&to=2026-07-19');
  assert.deepEqual(ids(week), [a.id, b.id, d.id], 'in time order');
  const obs = (week.json as Json[]).find((i) => i.id === d.id);
  assert.deepEqual([obs.sheetQuestions, obs.sheetAnswered], [2, 1], 'the saved sheet\'s own counts');
  assert.deepEqual(ids(await recruiter.get(`/recruitment/schedule?from=2026-07-13&to=2026-07-19&interviewerId=${fx().users.leader}`)), [a.id]);
  assert.deepEqual(ids(await recruiter.get('/recruitment/schedule?from=2026-07-13&to=2026-07-19&interviewerId=none')), [b.id]);
  assert.deepEqual(ids(await recruiter.get('/recruitment/schedule?from=2026-07-13&to=2026-07-19&type=observation')), [d.id]);
  assert.deepEqual(ids(await recruiter.get('/recruitment/schedule?from=2026-07-16')), [d.id], 'from alone is one day');

  assert.equal((await recruiter.get('/recruitment/schedule?from=2026-07-19&to=2026-07-13')).status, 400);
  assert.equal((await recruiter.get('/recruitment/schedule?from=2026-01-01&to=2026-07-13')).status, 400, 'at most 93 days');
  assert.equal((await recruiter.get('/recruitment/schedule?type=lunch')).status, 400);
  assert.equal((await recruiter.get('/recruitment/schedule?interviewerId=abc')).status, 400);
  assert.equal((await recruiter.get('/recruitment/schedule?from=2026-02-30')).status, 400);

  // Default: today and the next six days.
  const soon = await newInterview(c.id, { scheduledAt: `${addDays(todayISO(), 2)}T11:00:00.000Z` });
  const later = await newInterview(c.id, { scheduledAt: `${addDays(todayISO(), 9)}T11:00:00.000Z` });
  const def = await recruiter.get('/recruitment/schedule');
  assert.ok(ids(def).includes(soon.id));
  assert.ok(!ids(def).includes(later.id));
});

// ───────────────────────────── two devices on one sheet (review fixes) ─────────────────────────────

const BLANK = { answer: '', score: null };
const sheetOf = async (id: number, who: TestClient = recruiter) => (await who.get(`/recruitment/interviews/${id}/sheet`)).json;
const storedAnswers = (id: number) =>
  all<{ questionId: number | null; text: string; answer: string; score: number | null }>(
    srv.db,
    `SELECT question_id AS questionId, question_text AS text, answer, score FROM interview_answers WHERE interview_id = ? ORDER BY sort, id`,
    [id],
  ).map((r) => ({ ...r }));

test('two devices: a stale copy sends only what it changed, never reverts newer answers and never takes questions off', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id, { type: 'first' });
  const laptop = await sheetOf(iv.id); // opened before the interview: the bank's draft
  const phone = await sheetOf(iv.id, leader);
  const qs = phone.answers as Json[];

  // The phone fixes the sheet with three answers and a question of its own.
  const first = qs.map((a, i) => ({ questionId: a.questionId, questionText: a.questionText, answer: i < 3 ? `Phone: answer ${i + 1}` : '', score: i === 0 ? 4 : null, base: BLANK }));
  first.push({ questionId: null, questionText: 'Can you do Saturdays in December?', answer: 'Yes', score: null, base: BLANK });
  assert.equal((await leader.put(`/recruitment/interviews/${iv.id}/answers`, first)).status, 200);

  // The laptop still shows the draft: it types a closing note on the last question and sends its whole draft.
  const last = (laptop.answers as Json[]).length - 1;
  const stale = (laptop.answers as Json[]).map((a, i) => ({ questionId: a.questionId, questionText: a.questionText, answer: i === last ? 'Laptop: closing note' : '', score: null, base: BLANK }));
  const r = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, stale);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rows = storedAnswers(iv.id);
  assert.deepEqual(rows.slice(0, 3).map((x) => [x.answer, x.score]), [['Phone: answer 1', 4], ['Phone: answer 2', null], ['Phone: answer 3', null]], 'the phone\'s answers stand');
  assert.equal(rows.find((x) => x.questionId === qs[last]!.questionId)!.answer, 'Laptop: closing note');
  assert.equal(rows.find((x) => x.questionId === null)?.answer, 'Yes', 'the phone\'s own question is still on the sheet');
  assert.equal(r.json.answers.length, qs.length + 1);
  assert.equal(r.json.answers.find((a: Json) => a.questionId === qs[0]!.questionId).updatedByName, 'Lee Leader', 'each answer keeps who last changed it');

  // A save that sends one question leaves every other question as it is.
  const one = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [
    { questionId: qs[last]!.questionId, questionText: qs[last]!.questionText, answer: 'Laptop: closing note, edited', score: 3, base: { answer: 'Laptop: closing note', score: null } },
  ]);
  assert.equal(one.status, 200);
  assert.equal(storedAnswers(iv.id).length, qs.length + 1, 'questions left out stay on the sheet');
  assert.equal(storedAnswers(iv.id).find((x) => x.questionId === qs[last]!.questionId)!.score, 3);
});

test('two devices on the same question: 409 with their version, nothing written; sending their words as the base keeps mine', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id, { type: 'phone' });
  const qs = (await sheetOf(iv.id)).answers as Json[];
  const row = (i: number, answer: string, base: { answer: string; score: number | null } = BLANK, score: number | null = null) => ({ questionId: qs[i]!.questionId, questionText: qs[i]!.questionText, answer, score, base });
  await leader.put(`/recruitment/interviews/${iv.id}/answers`, qs.map((_, i) => row(i, i === 0 ? 'Phone: knew the charity well' : '')));
  const count = auditCount();

  // The laptop changed question 1 from the blank it saw, and question 2 as well.
  const clash = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [row(0, 'Laptop: had heard of BCN'), row(1, 'Laptop: a second answer')]);
  assert.equal(clash.status, 409, JSON.stringify(clash.json));
  assert.equal(clash.json.error, 'Question 1 was changed by Lee Leader on another device. Choose which answer to keep.');
  assert.deepEqual(clash.json.details.conflicts, [{ questionId: qs[0]!.questionId, questionText: qs[0]!.questionText }]);
  assert.equal(clash.json.details.sheet.answers[0].answer, 'Phone: knew the charity well', 'the latest sheet comes back to choose from');
  assert.deepEqual(storedAnswers(iv.id).slice(0, 2).map((x) => x.answer), ['Phone: knew the charity well', ''], 'nothing written, not even question 2');
  assert.equal(auditCount(), count, 'a refused save writes no audit row');

  // An answer already equal to what is stored is no clash (the same save arriving twice).
  assert.equal((await leader.put(`/recruitment/interviews/${iv.id}/answers`, [row(0, 'Phone: knew the charity well')])).status, 200);

  // "Keep mine": the laptop sends its words with the phone's as the base.
  const keep = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [row(0, 'Laptop: had heard of BCN', { answer: 'Phone: knew the charity well', score: null }), row(1, 'Laptop: a second answer')]);
  assert.equal(keep.status, 200);
  assert.deepEqual(storedAnswers(iv.id).slice(0, 2).map((x) => x.answer), ['Laptop: had heard of BCN', 'Laptop: a second answer']);
  assert.equal(keep.json.answers[0].updatedByName, 'Rae Recruiter');
});

test('taking a question off needs `removed: true`; a question answered on another device is not taken off', async () => {
  const c = await newCandidate();
  const iv = await newInterview(c.id, { type: 'phone' });
  const qs = (await sheetOf(iv.id)).answers as Json[];
  await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, qs.map((a) => ({ questionId: a.questionId, questionText: a.questionText, answer: '', score: null, base: BLANK })));
  // Not asked: a blank question comes off.
  const off = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [{ questionId: qs[5]!.questionId, questionText: qs[5]!.questionText, answer: '', score: null, base: BLANK, removed: true }]);
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(storedAnswers(iv.id).length, qs.length - 1);
  assert.equal(lastAudit().summary, `Updated the phone screen sheet for Sam ${c.lastName}: 0 of ${qs.length - 1} answered`);
  // Another device wrote an answer to question 5; this one, which saw it blank, tries to take it off.
  await leader.put(`/recruitment/interviews/${iv.id}/answers`, [{ questionId: qs[4]!.questionId, questionText: qs[4]!.questionText, answer: 'Weekends only', score: null, base: BLANK }]);
  const clash = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [{ questionId: qs[4]!.questionId, questionText: qs[4]!.questionText, answer: '', score: null, base: BLANK, removed: true }]);
  assert.equal(clash.status, 409);
  assert.equal(storedAnswers(iv.id).find((x) => x.questionId === qs[4]!.questionId)?.answer, 'Weekends only');
  // The last question on a sheet stays.
  const rest = storedAnswers(iv.id);
  const all1 = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, rest.map((x) => ({ questionId: x.questionId, questionText: x.text, answer: x.answer, score: x.score, base: { answer: x.answer, score: x.score }, removed: true })));
  assert.equal(all1.status, 400);
  assert.match(all1.json.error, /at least one question/);
  // A question of their own added to a saved sheet goes at the end.
  const own = await recruiter.put(`/recruitment/interviews/${iv.id}/answers`, [{ questionId: null, questionText: 'Anything you would like to ask us?', answer: '', score: null, base: BLANK }]);
  assert.equal(own.status, 200);
  assert.equal(own.json.answers.at(-1).questionText, 'Anything you would like to ask us?');
});

// ───────────────────────────── smaller review fixes ─────────────────────────────

test('the question bank refuses a question that is already in the list (same type and position, ignoring case and spaces)', async () => {
  const text = 'What would make this job a good fit for you?';
  const a = await admin.post('/recruitment/questions', { interviewType: 'final', text });
  assert.equal(a.status, 201);
  const b = await recruiter.post('/recruitment/questions', { interviewType: 'final', text: '  what would make this JOB a  good fit for you? ' });
  assert.equal(b.status, 409);
  assert.equal(b.json.error, 'That question is already in the final interview list');
  const c = await recruiter.post('/recruitment/questions', { interviewType: 'final', text: 'What would make this job a good fit for you? Tell us more' });
  assert.equal(c.status, 201, 'a different question');
  assert.equal((await recruiter.patch(`/recruitment/questions/${c.json.id}`, { text })).status, 409, 'an edit to the same words');
  assert.equal((await recruiter.post('/recruitment/questions', { interviewType: 'first', text })).status, 201, 'another interview type is another list');
  assert.equal((await recruiter.post('/recruitment/questions', { interviewType: 'final', text, position: 'team_leader' })).status, 409, 'every position includes team leaders: their sheet would show it twice');
  const coach = 'How would you coach a new starter on their first day?';
  assert.equal((await recruiter.post('/recruitment/questions', { interviewType: 'final', text: coach, position: 'team_leader' })).status, 201);
  assert.equal((await recruiter.post('/recruitment/questions', { interviewType: 'final', text: coach, position: 'trainee' })).status, 201, 'two positions never share a sheet');
  assert.equal((await recruiter.post('/recruitment/questions', { interviewType: 'final', text: coach })).status, 409, 'every position would clash with both');
  assert.equal((await recruiter.patch(`/recruitment/questions/${a.json.id}`, { active: false })).status, 200, 'its own words are no clash');
  assert.equal((await recruiter.post('/recruitment/questions', { interviewType: 'final', text })).status, 409, 'turned off still counts (turn it back on instead)');
});

test('PATCH /recruitment/interviews/:id refuses to move an interview to another candidate', async () => {
  const c = await newCandidate();
  const other = await newCandidate();
  const iv = await newInterview(c.id);
  const r = await recruiter.patch(`/recruitment/interviews/${iv.id}`, { candidateId: other.id });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'An interview stays with its candidate. Book a new interview for the other candidate');
  assert.equal(get<{ c: number }>(srv.db, `SELECT candidate_id AS c FROM interviews WHERE id = ?`, [iv.id])!.c, c.id);
  assert.equal((await recruiter.patch(`/recruitment/interviews/${iv.id}`, { candidateId: c.id, notes: 'Same candidate' })).status, 200, 'its own candidate is fine');
});

test('audit: a missing 1.2 candidate spec loses only the date-of-birth refinement, never the server start', async () => {
  const { withDateOfBirth } = await import('../lib/audit/recruitmentSpecs.ts');
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  try {
    assert.equal(withDateOfBirth('PATCH', '/recruitment/candidates/:id', []), null, 'no 1.2 spec: nothing to refine, no throw');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /No 1\.2 audit spec for PATCH \/recruitment\/candidates\/:id/);
  assert.ok(withDateOfBirth('PATCH', '/recruitment/candidates/:id'), 'today the 1.2 spec is there');
});
