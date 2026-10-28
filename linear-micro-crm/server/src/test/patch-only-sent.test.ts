/**
 * A PATCH changes only the fields it sends. The create forms behind these routes have defaults (a new person is
 * active from today, a new campaign is active, a new event aims for 10 sales, a new interview is pending), and a
 * PATCH that leaves those fields out must keep what is saved, never put the defaults back.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
});
after(async () => {
  await srv.close();
});

const fx = () => srv.fixture!;

/** PATCH `body`, then check in the saved record it answers with that every field of `kept` still has its value. */
async function patchKeeps(url: string, body: Record<string, unknown>, kept: Record<string, unknown>): Promise<void> {
  const r = await admin.patch(url, body);
  assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.json)}`);
  const after = r.json;
  for (const [k, v] of Object.entries(body)) assert.deepEqual(after[k], v, `${url}: ${k} changed as asked`);
  for (const [k, v] of Object.entries(kept)) assert.deepEqual(after[k], v, `${url}: ${k} kept`);
}

test('a person: changing the first name keeps their team, start date, status, phone and city', async () => {
  const id = fx().users.repA2;
  const setUp = { teamId: fx().teams.b, startDate: '2026-02-02', status: 'on_leave', phone: '07700 900123', city: 'Salford' };
  assert.equal((await admin.patch(`/users/${id}`, setUp)).status, 200);
  await patchKeeps(`/users/${id}`, { firstName: 'Ada' }, setUp);
});

test('a campaign: changing the name keeps it paused, its start date and description', async () => {
  const id = fx().campaignId;
  const setUp = { active: false, startDate: '2026-03-02', description: 'Door to door, Greater Manchester' };
  assert.equal((await admin.patch(`/campaigns/${id}`, setUp)).status, 200);
  await patchKeeps(`/campaigns/${id}`, { name: 'Renamed campaign' }, setUp);
});

test('an event: changing the name keeps its target and notes', async () => {
  const id = fx().events.tomorrowA;
  const setUp = { targetSales: 25, notes: 'Park at the back' };
  assert.equal((await admin.patch(`/events/${id}`, setUp)).status, 200);
  await patchKeeps(`/events/${id}`, { name: 'Renamed event' }, setUp);
});

test('an interview: adding notes keeps its outcome and interviewer', async () => {
  const candidate = await admin.post('/recruitment/candidates', { firstName: 'Casey', lastName: 'Example', email: 'casey.example@example.test' });
  assert.equal(candidate.status, 201, JSON.stringify(candidate.json));
  const interview = await admin.post('/recruitment/interviews', {
    candidateId: candidate.json.id,
    type: 'first',
    scheduledAt: '2026-10-01T10:00:00.000Z',
    interviewerId: fx().users.leader,
    outcome: 'passed',
  });
  assert.equal(interview.status, 201, JSON.stringify(interview.json));
  const id = interview.json.id;
  const r = await admin.patch(`/recruitment/interviews/${id}`, { notes: 'Strong on the doorstep' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.notes, 'Strong on the doorstep');
  assert.equal(r.json.outcome, 'passed', 'outcome kept');
  assert.equal(r.json.interviewerId, fx().users.leader, 'interviewer kept');
});

test('every route reads a PATCH body with parsePatch, never schema.partial().parse()', () => {
  const routes = fileURLToPath(new URL('../routes/', import.meta.url));
  const offenders = readdirSync(routes)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /\.partial\(\)\s*\.\s*(safeParse|parse)\(/.test(readFileSync(routes + f, 'utf8')));
  assert.deepEqual(offenders, [], 'use parsePatch(schema, req.body) from lib/validate.ts: it keeps only the fields sent');
});
