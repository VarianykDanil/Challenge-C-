/**
 * Signal-proof logging (p7): the gauge outbox's replay protocol against the real API. The client replays a queued
 * entry as GET /gauges?eventId&userId&from=date&to=date → shared replayDecision() → POST /gauges; these tests run the
 * same steps with the fixture and check that a repeat send is idempotent (201 then 200, one row), that a leader's
 * later edit (or delete) moves the item to review instead of being overwritten (or re-created), that a lost-answer
 * save is recognised, that the server still enforces write scope, and that 4xx answers map to 'failed'. No API
 * contract changed.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { replayDecision, replayOutcome, sameGaugeDay, type GaugeUpsertInput } from '@lm/shared';
import { get } from '../db/connection.ts';
import { addDays } from '../lib/dates.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let repA2: TestClient;

before(async () => {
  srv = await startTestServer();
  [admin, leader, rep, repA2] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('rep'), srv.login('repA2')]);
});
after(async () => {
  await srv.close();
});

const fx = () => srv.fixture!;

/** The client's lookup step: the server's entry for that (event, person, date), or null. */
async function lookup(client: TestClient, input: Pick<GaugeUpsertInput, 'eventId' | 'userId' | 'date'>): Promise<Json | null> {
  const r = await client.get(`/gauges?eventId=${input.eventId}&userId=${input.userId}&from=${input.date}&to=${input.date}&limit=5`);
  assert.equal(r.status, 200);
  return (r.json as Json[]).find((g) => g.eventId === input.eventId && g.userId === input.userId && g.date === input.date) ?? null;
}

function day(userId: number, eventId: number, stops: number, sales: number): GaugeUpsertInput {
  return { eventId, userId, date: fx().today, stops, table: Math.min(stops, 10), presentations: Math.min(stops, 6), closes: Math.min(stops, 3), taps: Math.min(stops, 2), sales, checkedInAt: null, notes: null };
}

const rows = (eventId: number, userId: number) => get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE event_id = ? AND user_id = ?`, [eventId, userId])!.n;

test('a queued new day is sent (201); sending it again is idempotent (200, same row)', async () => {
  const input = day(fx().users.rep, fx().events.todayA, 40, 2);
  const queuedAt = new Date().toISOString();
  const existing = await lookup(rep, input);
  assert.equal(existing, null);
  assert.equal(replayDecision({ queuedAt, expectedExistingId: null }, existing), 'send');
  const first = await rep.post('/gauges', input);
  assert.equal(first.status, 201);
  assert.equal(replayOutcome(first.status), 'logged');
  // The answer was lost and the phone sends again: the upsert finds the day and updates it in place.
  const again = await rep.post('/gauges', input);
  assert.equal(again.status, 200);
  assert.equal(replayOutcome(again.status), 'updated');
  assert.equal(again.json.id, first.json.id);
  assert.equal(rows(input.eventId, input.userId), 1);
  // …and the replay's lookup recognises a save that already landed, so it would not even send twice.
  const now = await lookup(rep, input);
  assert.ok(now && sameGaugeDay(now, input));
});

test("a leader's edit after the phone queued its update moves the item to review", async () => {
  const input = day(fx().users.repA2, fx().events.todayA, 30, 1);
  const created = await repA2.post('/gauges', input);
  assert.equal(created.status, 201);
  // The rep's form prefilled that entry (seen id + submittedAt), then the signal dropped and the update was queued.
  const seen = { id: created.json.id as number, submittedAt: created.json.submittedAt as string };
  const queued = { ...input, stops: 34, sales: 2 };
  // While it waited, the leader corrected the day on Linear Hub.
  const edit = await leader.patch(`/gauges/${seen.id}`, { stops: 31 });
  assert.equal(edit.status, 200);
  const existing = await lookup(repA2, queued);
  assert.ok(existing);
  assert.equal(existing.id, seen.id);
  assert.ok(Date.parse(existing.submittedAt) >= Date.parse(seen.submittedAt), 'the edit stamps a new submittedAt');
  // The client compares against the submittedAt it had seen (server clock), so phone clock skew cannot matter.
  assert.equal(replayDecision({ queuedAt: seen.submittedAt, expectedExistingId: seen.id }, existing), existing.submittedAt === seen.submittedAt ? 'send' : 'review');
  assert.equal(replayDecision({ queuedAt: seen.submittedAt, expectedExistingId: seen.id }, { id: existing.id, submittedAt: addSecond(seen.submittedAt) }), 'review');
  // Nothing was overwritten: the leader's value stands.
  assert.equal((await lookup(repA2, queued))!.stops, 31);
  // Without the edit, the same item is safe to send and updates the rep's own entry.
  assert.equal(replayDecision({ queuedAt: seen.submittedAt, expectedExistingId: seen.id }, seen), 'send');
});

test('an update whose entry was deleted while it waited moves to review; nothing re-creates the day', async () => {
  const input = { ...day(fx().users.repA2, fx().events.yesterdayA, 25, 1), date: addDays(fx().today, -1) };
  const created = await repA2.post('/gauges', input);
  assert.equal(created.status, 201);
  // The rep's form prefilled that entry, then the signal dropped and the update was queued on the phone.
  const seen = { id: created.json.id as number, submittedAt: created.json.submittedAt as string };
  const queued = { ...input, stops: 28 };
  // While it waited, the leader deleted the day.
  const del = await leader.del(`/gauges/${seen.id}`);
  assert.equal(del.status, 204);
  const existing = await lookup(repA2, queued);
  assert.equal(existing, null);
  // A send would create a new gauge row (and a paid day) behind the leader's back, so the person decides.
  assert.equal(replayDecision({ queuedAt: seen.submittedAt, expectedExistingId: seen.id }, existing), 'review');
  assert.equal(rows(input.eventId, input.userId), 0);
  // A new day (nothing seen, nothing on the server) is still sent straight away.
  assert.equal(replayDecision({ queuedAt: seen.submittedAt, expectedExistingId: null }, existing), 'send');
});

test('an entry the phone had not seen (logged elsewhere) is never overwritten: review', async () => {
  const input = day(fx().users.leader, fx().events.todayA, 20, 1);
  const elsewhere = await leader.post('/gauges', { ...input, stops: 22 });
  assert.equal(elsewhere.status, 201);
  const existing = await lookup(leader, input);
  assert.equal(replayDecision({ queuedAt: new Date().toISOString(), expectedExistingId: null }, existing), 'review');
  assert.equal(sameGaugeDay(existing, input), false);
});

test('the server still enforces write scope on a replayed send', async () => {
  // A rep's phone can only hold the rep's own saves, but even a tampered item cannot write someone else's day.
  const other = day(fx().users.repB, fx().events.todayB, 10, 0);
  const r = await rep.post('/gauges', other);
  assert.equal(r.status, 403);
  assert.equal(replayOutcome(r.status), 'failed');
  // …and the lookup itself is scoped: a rep cannot read another person's gauges.
  const peek = await rep.get(`/gauges?eventId=${other.eventId}&userId=${other.userId}&from=${other.date}&to=${other.date}`);
  assert.equal(peek.status, 403);
  // An admin's phone may replay for any team.
  const a = await admin.post('/gauges', other);
  assert.equal(a.status, 201);
});

test('a 4xx answer (a check-in in the future from a skewed phone clock, a day not started) maps to failed', async () => {
  const future = { ...day(fx().users.rep, fx().events.yesterdayA, 5, 0), date: addDays(fx().today, -1), checkedInAt: `${addDays(fx().today, 2)}T09:00` };
  const r = await rep.post('/gauges', future);
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /future/i);
  assert.equal(replayOutcome(r.status), 'failed');
  const notYet = await rep.post('/gauges', { ...day(fx().users.rep, fx().events.tomorrowA, 5, 0), date: addDays(fx().today, 1) });
  assert.equal(notYet.status, 400);
  assert.equal(replayOutcome(notYet.status), 'failed');
});

function addSecond(iso: string): string {
  return new Date(Date.parse(iso) + 1000).toISOString();
}
