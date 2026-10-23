/**
 * Release 1.3.1 fix (1.3 final security check): three 1.3 writes come under the per-person write limit of 60 a
 * minute (middleware/writeLimit.ts) — a rep's "I'm working this" / "I can't make it" (POST and DELETE
 * /events/:id/roster/me), Edit bookings (PUT /events/:id/roster) and the interview sheet's autosave (PUT
 * /recruitment/interviews/:id/answers). Each one wrote an audit row and cleared the whole response cache with no
 * limit. The 61st in a minute is 429 with the usual sentence; a refused call writes nothing, is not audited and does
 * not clear the cache.
 *
 * Fixture people: Lee Leader, Rae Recruiter, Remy Rep (team A). The write limit uses the real clock.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from '../db/connection.ts';
import { currentDataVersion } from '../lib/cache.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { WRITE_LIMIT_MESSAGE, WRITE_LIMIT_PER_MINUTE, isWriteLimited } from '../middleware/writeLimit.ts';
import { startTestServer, type Json, type TestClient, type TestResponse, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
const fx = () => srv.fixture!;
const auditCount = () => Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM audit_log`)!.n);

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);
});
after(async () => {
  await srv.close();
  setBusinessClock(null);
});

/** The 61st call: 429 with the sentence and Retry-After, no audit row, the cache left alone. */
async function assertRefused(call: () => Promise<TestResponse>, what: string): Promise<void> {
  const audited = auditCount();
  const version = currentDataVersion();
  const refused = await call();
  assert.equal(refused.status, 429, `${what}: ${JSON.stringify(refused.json)}`);
  assert.deepEqual(refused.json, { error: WRITE_LIMIT_MESSAGE });
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal(auditCount(), audited, `${what}: a refused call is not audited`);
  assert.equal(currentDataVersion(), version, `${what}: a refused call does not clear the cache`);
}

test('the limit covers the 1.3 roster writes and the interview sheet autosave (any case, trailing slash, encoded id)', () => {
  for (const [method, path] of [
    ['POST', '/events/12/roster/me'],
    ['DELETE', '/events/12/roster/me'],
    ['PUT', '/events/12/roster'],
    ['PUT', '/events/12/roster/'],
    ['POST', '/EVENTS/12/Roster/Me'],
    ['DELETE', '/events/%31%32/roster/me'],
    ['PUT', '/recruitment/interviews/7/answers'],
    ['PUT', '/Recruitment/Interviews/7/Answers/'],
    ['PUT', '/recruitment/interviews/%37/answers'],
  ] as const) assert.ok(isWriteLimited(method, path), `${method} ${path}`);
  for (const [method, path] of [
    ['GET', '/events/12/roster'],
    ['GET', '/events/12/plan'],
    ['PATCH', '/events/12'],
    ['DELETE', '/events/12'],
    ['POST', '/events'],
    ['PUT', '/events/12/rosterx'],
    ['GET', '/recruitment/interviews/7/sheet'],
    ['PATCH', '/recruitment/interviews/7'],
    ['POST', '/recruitment/interviews'],
    ['PUT', '/recruitment/interviews/7/answers/extra'],
    // the 1.2 rules are unchanged: DELETE was never limited by path prefix
    ['DELETE', '/checkins/4'],
  ] as const) assert.ok(!isWriteLimited(method, path), `${method} ${path}`);
});

test(`POST and DELETE /events/:id/roster/me: the ${WRITE_LIMIT_PER_MINUTE + 1}st in a minute is 429, not audited, cache kept`, async () => {
  const e = fx().events.tomorrowA;
  const audited = auditCount();
  const statuses: number[] = [];
  for (let i = 0; i < WRITE_LIMIT_PER_MINUTE; i++) {
    const r = i % 2 === 0 ? await rep.post(`/events/${e}/roster/me`) : await rep.del(`/events/${e}/roster/me`);
    statuses.push(r.status);
  }
  assert.deepEqual([...new Set(statuses)], [200], 'the first 60 are answered as before');
  assert.equal(auditCount() - audited, WRITE_LIMIT_PER_MINUTE, 'each one audited as before');
  await assertRefused(() => rep.post(`/events/${e}/roster/me`), 'POST roster/me');
  await assertRefused(() => rep.del(`/events/${e}/roster/me`), 'DELETE roster/me');
  // an encoded id reaches the same route (Express decodes it), so it counts too
  const encoded = [...String(e)].map((d) => `%3${d}`).join('');
  assert.equal((await admin.post(`/events/${encoded}/roster/me`)).status, 200, 'the encoded path books the event');
  assert.equal((await admin.del(`/events/${encoded}/roster/me`)).status, 200);
  await assertRefused(() => rep.post(`/events/${encoded}/roster/me`), 'POST roster/me, encoded id');
  const booked = (await leader.get(`/events/${e}/roster`)).json as Json[];
  assert.ok(!booked.some((b) => b.userId === fx().users.rep), 'the refused booking was not made');
});

test(`PUT /events/:id/roster: the ${WRITE_LIMIT_PER_MINUTE + 1}st in a minute is 429, not audited, cache kept`, async () => {
  const e = fx().events.tomorrowA;
  const statuses: number[] = [];
  for (let i = 0; i < WRITE_LIMIT_PER_MINUTE; i++) {
    const body = i % 2 === 0 ? { add: [fx().users.repA2] } : { remove: [fx().users.repA2] };
    statuses.push((await leader.put(`/events/${e}/roster`, body)).status);
  }
  assert.deepEqual([...new Set(statuses)], [200]);
  await assertRefused(() => leader.put(`/events/${e}/roster`, { add: [fx().users.repA2] }), 'PUT roster');
  const booked = (await leader.get(`/events/${e}/roster`)).json as Json[];
  assert.ok(!booked.some((b) => b.userId === fx().users.repA2), 'the refused change was not made');
});

test(`PUT /recruitment/interviews/:id/answers: the ${WRITE_LIMIT_PER_MINUTE + 1}st in a minute is 429, not audited, cache kept`, async () => {
  const c = await recruiter.post('/recruitment/candidates', { firstName: 'Sam', lastName: 'Limit', email: 'sam.limit@example.com' });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const iv = await recruiter.post('/recruitment/interviews', { candidateId: c.json.id, type: 'phone', scheduledAt: '2026-11-10T10:00:00.000Z', interviewerId: fx().users.leader });
  assert.equal(iv.status, 201, JSON.stringify(iv.json));
  const url = `/recruitment/interviews/${iv.json.id}/answers`;
  const statuses: number[] = [];
  // one tab's saves, numbered (its own earlier save is never a conflict)
  const save = (answer: string, version: number) => recruiter.put(url, [{ questionId: null, questionText: 'Anything to add?', answer, device: 'tab-limit-test', version }]);
  for (let i = 0; i < WRITE_LIMIT_PER_MINUTE; i++) statuses.push((await save(`Answer ${i}`, i + 1)).status);
  assert.deepEqual([...new Set(statuses)], [200], JSON.stringify(statuses));
  await assertRefused(() => save('Too many', WRITE_LIMIT_PER_MINUTE + 1), 'PUT answers');
  const sheet = (await recruiter.get(`/recruitment/interviews/${iv.json.id}/sheet`)).json as Json;
  assert.ok(!JSON.stringify(sheet).includes('Too many'), 'the refused answer was not saved');
});
