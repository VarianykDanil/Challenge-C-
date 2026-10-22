/**
 * P8 venue-insights, last fix round (re-review minors):
 *  - Edit bookings sends its changes ({ add, remove }), so someone who tapped "I'm working this" while the leader had
 *    the list open stays booked (the whole-list PUT still works, and still means the whole list);
 *  - someone on leave stays booked and counted (the documented rule: only people who have LEFT drop off), marked
 *    `onLeave` on the roster; they cannot be newly booked until they are back.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setBusinessClock, todayISO } from '../lib/dates.ts';
import { addHistory, startTestServer, type Fixture, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15'; // a Thursday
setBusinessClock(new Date(`${TODAY}T12:00:00`));

let srv: TestServer;
let fx: Fixture;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;

before(async () => {
  srv = await startTestServer();
  fx = srv.fixture!;
  assert.equal(todayISO(), TODAY);
  addHistory(srv.db, { userId: fx.users.rep, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
  addHistory(srv.db, { userId: fx.users.repA2, teamId: fx.teams.a, campaignId: fx.campaignId, weeks: 4, stops: 60, sales: 3 });
  srv.resetCache();
  admin = await srv.login('admin');
  leader = await srv.login('leader');
  rep = await srv.login('rep');
});
after(async () => {
  await srv.close();
  setBusinessClock(null);
});

const ids = (list: Json[]) => list.map((b) => b.userId).sort((a: number, b: number) => a - b);
const roster = async () => (await leader.get(`/events/${fx.events.tomorrowA}/roster`)).json as Json[];

test('Edit bookings sends its changes: a self-booking made while the leader had the list open is kept', async () => {
  const e = fx.events.tomorrowA;
  assert.equal((await leader.put(`/events/${e}/roster`, { userIds: [fx.users.leader] })).status, 200);
  // the leader opens Edit bookings: [leader]
  const opened = ids(await roster());
  assert.deepEqual(opened, [fx.users.leader]);
  // meanwhile Remy taps "I'm working this"
  assert.equal((await rep.post(`/events/${e}/roster/me`)).status, 200);
  // the leader ticks Rita and saves: the changes, not the list they loaded
  const saved = await leader.put(`/events/${e}/roster`, { add: [fx.users.repA2], remove: [] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(ids(saved.json), [fx.users.leader, fx.users.rep, fx.users.repA2].sort((a, b) => a - b), 'Remy is still booked');
  const audit = srv.db.prepare(`SELECT summary FROM audit_log WHERE action = 'PUT /events/:id/roster' ORDER BY id DESC LIMIT 1`).get() as { summary: string };
  assert.match(audit.summary, /: booked Rita Rep$/, 'and nobody is "taken off"');
  // taking someone off names only them
  const off = await leader.put(`/events/${e}/roster`, { remove: [fx.users.leader] });
  assert.deepEqual(ids(off.json), [fx.users.rep, fx.users.repA2].sort((a, b) => a - b));
  // the same rules as the whole list: another team's member is refused, a bad body is 400
  assert.equal((await leader.put(`/events/${e}/roster`, { add: [fx.users.repB] })).status, 400);
  assert.equal((await leader.put(`/events/${e}/roster`, {})).status, 400);
  assert.equal((await leader.put(`/events/${e}/roster`, { userIds: [], add: [] })).status, 400);
  // the whole list still replaces the roster (an older page)
  assert.deepEqual(ids((await leader.put(`/events/${e}/roster`, { userIds: [] })).json), []);
});

test('someone on leave stays booked and counted, marked on leave; someone who has left drops off', async () => {
  const e = fx.events.tomorrowA;
  await leader.put(`/events/${e}/roster`, { userIds: [fx.users.rep, fx.users.repA2] });
  assert.equal((await admin.patch(`/users/${fx.users.repA2}`, { status: 'on_leave' })).status, 200);
  const list = await roster();
  assert.deepEqual(ids(list), [fx.users.rep, fx.users.repA2].sort((a, b) => a - b), 'still on the roster');
  assert.equal(list.find((b) => b.userId === fx.users.repA2)!.onLeave, true);
  assert.equal(list.find((b) => b.userId === fx.users.rep)!.onLeave, undefined);
  const ev = (await leader.get(`/events/${e}`)).json;
  assert.equal(ev.bookings.booked, 2, 'still counted');
  srv.resetCache();
  assert.deepEqual(ids((await leader.get(`/events/${e}/plan`)).json), [fx.users.rep, fx.users.repA2].sort((a, b) => a - b), 'and planned for');
  // saving the list keeps them (they are on it), but nobody on leave can be newly booked
  assert.equal((await leader.put(`/events/${e}/roster`, { remove: [fx.users.repA2] })).status, 200);
  const again = await leader.put(`/events/${e}/roster`, { add: [fx.users.repA2] });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'Rita Rep cannot be booked on an event');
  // back at work: bookable again; someone who has left drops off
  assert.equal((await admin.patch(`/users/${fx.users.repA2}`, { status: 'active' })).status, 200);
  assert.equal((await leader.put(`/events/${e}/roster`, { add: [fx.users.repA2] })).status, 200);
  assert.equal((await admin.patch(`/users/${fx.users.repA2}`, { status: 'left' })).status, 200);
  assert.deepEqual(ids(await roster()), [fx.users.rep]);
  assert.equal((await leader.get(`/events/${e}`)).json.bookings.booked, 1);
  assert.equal((await admin.patch(`/users/${fx.users.repA2}`, { status: 'active' })).status, 200);
  await leader.put(`/events/${e}/roster`, { userIds: [] });
});
