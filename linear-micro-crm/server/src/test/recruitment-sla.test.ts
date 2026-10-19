/**
 * p8 recruitment SLAs: next-action deadlines default to the stage target on create and on every stage move (instead of
 * carrying the previous stage's date forward), an explicit body value wins, null opts out, and closed stages have none.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, todayISO } from '../lib/dates.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let recruiter: TestClient;

before(async () => {
  srv = await startTestServer();
  [admin, recruiter] = await Promise.all([srv.login('admin'), srv.login('recruiter')]);
});
after(async () => {
  await srv.close();
});

let n = 0;
async function newCandidate(extra: Record<string, unknown> = {}): Promise<Json> {
  n++;
  const r = await recruiter.post('/recruitment/candidates', { firstName: 'Sla', lastName: `Test${n}`, email: `sla.test${n}@example.com`, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function move(id: number, body: Record<string, unknown>, who: TestClient = recruiter): Promise<Json> {
  const r = await who.post(`/recruitment/candidates/${id}/stage`, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

test('POST /candidates without nextActionAt is due today + 3 days (date-only)', async () => {
  const c = await newCandidate();
  assert.equal(c.stage, 'applied');
  assert.equal(c.nextActionAt, addDays(todayISO(), 3));
  assert.equal(c.nextAction, 'Phone screen');
});

test('POST /candidates keeps an explicit deadline, and an explicit null stays null', async () => {
  assert.equal((await newCandidate({ nextActionAt: null })).nextActionAt, null);
  const date = addDays(todayISO(), 10);
  assert.equal((await newCandidate({ nextActionAt: date })).nextActionAt, date);
  const ts = `${addDays(todayISO(), 1)}T16:30:00.000Z`;
  assert.equal((await newCandidate({ nextActionAt: ts })).nextActionAt, ts);
});

test('applied → screening without nextActionAt is due today + 5 days, not the old date carried forward', async () => {
  const c = await newCandidate({ nextActionAt: addDays(todayISO(), -4) });
  const moved = await move(c.id, { stage: 'screening' });
  assert.equal(moved.stage, 'screening');
  assert.equal(moved.nextActionAt, addDays(todayISO(), 5));
  assert.equal(moved.nextAction, 'Book first interview');
  assert.ok(moved.stageUpdatedAt >= c.stageUpdatedAt, 'the stage clock restarts');
});

test('a stage move with nextActionAt: null clears the deadline', async () => {
  const c = await newCandidate();
  assert.equal((await move(c.id, { stage: 'screening', nextActionAt: null })).nextActionAt, null);
});

test('a stage move with an explicit date or timestamp keeps it', async () => {
  const a = await newCandidate();
  const date = addDays(todayISO(), 2);
  assert.equal((await move(a.id, { stage: 'screening', nextActionAt: date })).nextActionAt, date);
  const b = await newCandidate();
  const ts = `${addDays(todayISO(), 1)}T09:15:00+01:00`;
  assert.equal((await move(b.id, { stage: 'interview', nextActionAt: ts })).nextActionAt, ts);
});

test('each open stage uses its own target: several steps forward, one step back, an admin reopening to offer', async () => {
  const c = await newCandidate();
  assert.equal((await move(c.id, { stage: 'interview' })).nextActionAt, addDays(todayISO(), 7));
  assert.equal((await move(c.id, { stage: 'screening' })).nextActionAt, addDays(todayISO(), 5));
  assert.equal((await move(c.id, { stage: 'offer' })).nextActionAt, addDays(todayISO(), 7));
  assert.equal((await move(c.id, { stage: 'rejected' })).nextActionAt, null);
  const reopened = await move(c.id, { stage: 'offer' }, admin);
  assert.equal(reopened.stage, 'offer');
  assert.equal(reopened.nextActionAt, addDays(todayISO(), 7));
});

test('moving to rejected or withdrawn clears the deadline, even when the body sets one', async () => {
  const a = await newCandidate();
  const rejected = await move(a.id, { stage: 'rejected', nextActionAt: addDays(todayISO(), 3) });
  assert.equal(rejected.nextActionAt, null);
  assert.equal(rejected.nextAction, null);
  const b = await newCandidate();
  assert.equal((await move(b.id, { stage: 'withdrawn' })).nextActionAt, null);
});

test('hiring clears the deadline', async () => {
  const c = await newCandidate();
  await move(c.id, { stage: 'offer' });
  const hired = await move(c.id, { stage: 'hired', teamId: srv.fixture!.teams.a, position: 'trainee' });
  assert.equal(hired.stage, 'hired');
  assert.equal(hired.nextActionAt, null);
});

test('an unreadable nextActionAt on a stage move is a 400 and changes nothing', async () => {
  const c = await newCandidate();
  for (const bad of ['garbage', '2026-02-31', '2026-02-31T10:00:00Z', 'Oct 24 2026', '24/10/2026', '', 42, true]) {
    const r = await recruiter.post(`/recruitment/candidates/${c.id}/stage`, { stage: 'screening', nextActionAt: bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status}`);
  }
  const after = (await recruiter.get(`/recruitment/candidates/${c.id}`)).json;
  assert.equal(after.stage, 'applied');
  assert.equal(after.nextActionAt, addDays(todayISO(), 3));
});

test('create and patch hold nextActionAt to the same rule as a stage move', async () => {
  const bad = ['garbage', '2026-02-31', '2026-02-31T10:00:00Z', 'Oct 24 2026', '24/10/2026', '', 42, true];
  for (const value of bad) {
    n++;
    const r = await recruiter.post('/recruitment/candidates', { firstName: 'Sla', lastName: `Bad${n}`, email: `sla.bad${n}@example.com`, nextActionAt: value });
    assert.equal(r.status, 400, `create ${JSON.stringify(value)} → ${r.status}`);
  }
  const c = await newCandidate();
  for (const value of bad) {
    const r = await recruiter.patch(`/recruitment/candidates/${c.id}`, { nextActionAt: value });
    assert.equal(r.status, 400, `patch ${JSON.stringify(value)} → ${r.status}`);
  }
  assert.equal((await recruiter.get(`/recruitment/candidates/${c.id}`)).json.nextActionAt, addDays(todayISO(), 3), 'nothing changed');
  // every shape the client and the smoke test send still passes
  const good = [addDays(todayISO(), 4), `${addDays(todayISO(), 2)}T16:30:00.000Z`, `${addDays(todayISO(), 2)}T10:00:00-05:00`, `${addDays(todayISO(), 2)}T09:15`];
  for (const value of good) {
    const r = await recruiter.patch(`/recruitment/candidates/${c.id}`, { nextActionAt: value });
    assert.equal(r.status, 200, `patch ${value} → ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.nextActionAt, value);
  }
  assert.equal((await recruiter.patch(`/recruitment/candidates/${c.id}`, { nextActionAt: null })).json.nextActionAt, null);
});

test('a fresh move is never overdue, so it leaves the overdue count', async () => {
  const count = async () => (await recruiter.get('/recruitment/summary')).json.overdueActions as number;
  const c = await newCandidate({ nextActionAt: addDays(todayISO(), -2) });
  const before = await count();
  await move(c.id, { stage: 'screening' });
  assert.equal(await count(), before - 1);
});

test('response shapes are unchanged: a stage move answers a CandidateWithMeta', async () => {
  const c = await newCandidate();
  const moved = await move(c.id, { stage: 'screening' });
  assert.deepEqual(Object.keys(moved).sort(), Object.keys(c).sort());
});
