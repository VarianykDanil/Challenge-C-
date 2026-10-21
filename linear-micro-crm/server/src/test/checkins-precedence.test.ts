/**
 * Release 1.2 review, security S3: which check-in time punctuality counts, and the bounds on a check-in sent later
 * from a phone. Business clock pinned to 15:00 today, as in shift-checkins.test.ts.
 *
 *  - A check-in time a leader or admin recorded on someone's gauge entry (logged on their behalf) wins over that
 *    person's own one-tap check-in. Otherwise the one-tap check-in wins, as before. Who set the time is
 *    gauge_entries.checked_in_by, written by every gauge write (POST /gauges, PATCH /gauges/:id, POST /gauges/bulk).
 *  - An offline check-in time is never earlier than 60 minutes before the event's start (an earlier one is recorded as
 *    that), and it must reach Linear Hub within 24 hours of the event's end. Live taps are unchanged.
 *  - Second review: the person cannot undo a time recorded for them (change, clear, move, delete: 403); a time that is
 *    the person's own check-in to the minute stays theirs (Log gauges fills it without the seconds); moving an entry
 *    to another event or day keeps its time's author; a time from the phone is always recorded as 'offline'.
 * Never writes a payroll run or a gauge row through a check-in (gauge rows here come from the gauge routes only).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from '../db/connection.ts';
import { Where } from '../db/queries.ts';
import { addDays, setBusinessClock, todayISO } from '../lib/dates.ts';
import { punctualityFor } from '../lib/metrics.ts';
import { addEvent, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = todayISO();
setBusinessClock(new Date(`${TODAY}T15:00:00`));
const YEST = addDays(TODAY, -1);

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let rep: TestClient;
let repA2: TestClient;

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, rep, repA2] = await Promise.all((['admin', 'leader', 'rep', 'repA2'] as const).map((w) => srv.login(w)));
});
after(async () => {
  await srv.close();
  setBusinessClock(null);
});

const fx = () => srv.fixture!;
const G = { stops: 40, table: 12, presentations: 6, closes: 3, taps: 2, sales: 1 };
/** Punctuality (1 on time, 0 late, null no sample) of one person at one event. */
const punctual = (userId: number, eventId: number) => punctualityFor(srv.db, new Where().add('g.user_id = ?', userId).add('g.event_id = ?', eventId));
const authorOf = (gaugeId: number) => get<{ by: number | null }>(srv.db, 'SELECT checked_in_by AS by FROM gauge_entries WHERE id = ?', [gaugeId])!.by;
/** A team A event yesterday 09:00–17:00 (ended 22 hours before the pinned 15:00, so a phone may still send to it). */
const yesterdayEvent = (name: string) => addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: YEST, status: 'completed', startTime: '09:00', endTime: '17:00', name });

test('S3: a late time the leader recorded is not overridden by the rep’s own earlier check-in (reviewer probe 3)', async () => {
  const ev = fx().events.yesterdayA; // 09:00–17:00 yesterday
  const g = await leader.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G, checkedInAt: `${YEST}T10:30` });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.equal(authorOf(g.json.id), fx().users.leader, 'the gauge entry remembers who set its check-in time');
  assert.equal(punctual(fx().users.rep, ev), 0, 'late at 10:30');

  const tap = await rep.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T08:55:00` });
  assert.equal(tap.status, 201, 'the phone’s check-in is still recorded (leaders see it as "sent later")');
  assert.equal(tap.json.source, 'offline');
  assert.equal(punctual(fx().users.rep, ev), 0, 'the leader’s 10:30 still counts');
  srv.resetCache();
  const perf = await admin.get(`/users/${fx().users.rep}/performance?from=${YEST}&to=${YEST}`);
  assert.equal(perf.status, 200);
  assert.equal(perf.json.punctualityRate, 0, 'profiles read the same rule');

  // the rep edits their own counts; the form sends the stored time back unchanged: the leader is still its author
  const edit = await rep.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G, sales: 2, taps: 2, checkedInAt: `${YEST}T10:30:00` });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(authorOf(g.json.id), fx().users.leader);
  assert.equal(punctual(fx().users.rep, ev), 0);
  // an edit that leaves the time out keeps it and its author too
  assert.equal((await rep.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G })).status, 200);
  assert.equal(authorOf(g.json.id), fx().users.leader);
  assert.equal(punctual(fx().users.rep, ev), 0);
});

test('S3: whichever way the leader saves the time (bulk entry or an edit) it counts; clearing it hands back to the check-in', async () => {
  const ev = yesterdayEvent('Bulk A');
  const tap = await repA2.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T08:50:00` });
  assert.equal(tap.status, 201);
  // a bulk row without a time: nobody recorded one, so the check-in counts
  const bulk = await leader.post('/gauges/bulk', { eventId: ev, date: YEST, rows: [{ userId: fx().users.repA2, ...G }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.json));
  const id = get<{ id: number }>(srv.db, 'SELECT id FROM gauge_entries WHERE event_id = ? AND user_id = ?', [ev, fx().users.repA2])!.id;
  assert.equal(authorOf(id), null);
  assert.equal(punctual(fx().users.repA2, ev), 1, 'on time by the check-in');
  // the leader's bulk entry with a time: the leader's time counts
  assert.equal((await leader.post('/gauges/bulk', { eventId: ev, date: YEST, rows: [{ userId: fx().users.repA2, ...G, checkedInAt: `${YEST}T09:40` }] })).status, 200);
  assert.equal(authorOf(id), fx().users.leader);
  assert.equal(punctual(fx().users.repA2, ev), 0);
  // the leader clears the time: no recorded time, back to the check-in
  const cleared = await leader.patch(`/gauges/${id}`, { checkedInAt: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(authorOf(id), null);
  assert.equal(punctual(fx().users.repA2, ev), 1);
  // the leader sets it again by editing the entry
  assert.equal((await leader.patch(`/gauges/${id}`, { checkedInAt: `${YEST}T09:20` })).status, 200);
  assert.equal(authorOf(id), fx().users.leader);
  assert.equal(punctual(fx().users.repA2, ev), 0);
  // the leader edits the counts only: the time and its author stay
  assert.equal((await leader.patch(`/gauges/${id}`, { sales: 1 })).status, 200);
  assert.equal((await leader.post('/gauges/bulk', { eventId: ev, date: YEST, rows: [{ userId: fx().users.repA2, ...G }] })).status, 200);
  assert.equal(authorOf(id), fx().users.leader);
  assert.equal(punctual(fx().users.repA2, ev), 0);
});

test('S3: a time the person recorded themself still gives way to their check-in, as before', async () => {
  const ev = yesterdayEvent('Own A');
  const own = await rep.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G, checkedInAt: `${YEST}T10:30` });
  assert.equal(own.status, 201);
  assert.equal(authorOf(own.json.id), fx().users.rep);
  assert.equal(punctual(fx().users.rep, ev), 0);
  assert.equal((await rep.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T08:58:00` })).status, 201);
  assert.equal(punctual(fx().users.rep, ev), 1, 'their own check-in counts over their own gauge time');
  // the leader edits the rep's counts and sends the rep's own time back unchanged: it is still the rep's time
  assert.equal((await leader.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G, sales: 0, taps: 1, checkedInAt: `${YEST}T10:30` })).status, 200);
  assert.equal(authorOf(own.json.id), fx().users.rep);
  assert.equal(punctual(fx().users.rep, ev), 1);
  // a leader logging their own day is "themself" too
  const lead = await leader.post('/gauges', { eventId: ev, userId: fx().users.leader, date: YEST, ...G, checkedInAt: `${YEST}T10:10` });
  assert.equal(lead.status, 201);
  assert.equal((await leader.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T08:59:00` })).status, 201);
  assert.equal(punctual(fx().users.leader, ev), 1);
  // …until an admin records the leader's time on their behalf
  assert.equal((await admin.patch(`/gauges/${lead.json.id}`, { checkedInAt: `${YEST}T09:45` })).status, 200);
  assert.equal(authorOf(lead.json.id), fx().users.admin);
  assert.equal(punctual(fx().users.leader, ev), 0);
  // moving an entry to someone else makes the mover the author of its time (they vouch for it for the new person)
  const mover = await leader.patch(`/gauges/${own.json.id}`, { userId: fx().users.repA2 });
  assert.equal(mover.status, 200, JSON.stringify(mover.json));
  assert.equal(authorOf(own.json.id), fx().users.leader);
});

test('S3: an offline time is never earlier than 60 minutes before the start; a live tap is unchanged', async () => {
  // today 09:00–17:00: the reviewer's 00:00:01 "before arriving" is recorded as 08:00, the earliest an offline tap can carry
  const morning = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '09:00', endTime: '17:00', name: 'Morning A' });
  const early = await rep.post('/checkins', { eventId: morning, checkedInAt: `${TODAY}T00:00:01` });
  assert.equal(early.status, 201, JSON.stringify(early.json));
  assert.equal(early.json.checkedInAt, `${TODAY}T08:00:00`);
  assert.equal(early.json.onTime, true);
  const inside = await repA2.post('/checkins', { eventId: morning, checkedInAt: `${TODAY}T08:31:00`, source: 'offline' });
  assert.equal(inside.json.checkedInAt, `${TODAY}T08:31:00`, 'inside the hour before the start: kept as tapped');
  // an evening event (17:00–20:00): a live tap at 15:00 is recorded at 15:00, two hours early, exactly as before
  const evening = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'scheduled', startTime: '17:00', endTime: '20:00', name: 'Evening A' });
  const live = await rep.post('/checkins', { eventId: evening });
  assert.equal(live.status, 201);
  assert.match(live.json.checkedInAt, new RegExp(`^${TODAY}T15:0\\d:\\d{2}$`));
  // an offline tap from 14:30 sent now, before 16:00 has come round: recorded at Linear Hub's time, never in the future
  const sentEarly = await repA2.post('/checkins', { eventId: evening, checkedInAt: `${TODAY}T14:30:00` });
  assert.equal(sentEarly.status, 201);
  assert.ok(sentEarly.json.checkedInAt >= `${TODAY}T15:00:00` && sentEarly.json.checkedInAt <= `${TODAY}T15:05:00`, sentEarly.json.checkedInAt);
});

test('S3: a check-in sent later must reach Linear Hub within 24 hours of the event’s end', async () => {
  const mk = (date: string, endTime: string, name: string) => addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date, status: 'completed', startTime: '09:00', endTime, name });
  // ended 23½ hours ago: accepted
  const recent = await rep.post('/checkins', { eventId: mk(YEST, '15:30', 'Recent A'), checkedInAt: `${YEST}T08:57:00` });
  assert.equal(recent.status, 201, JSON.stringify(recent.json));
  // ended 25 hours ago: refused, with a sentence the phone shows as it is
  const stale = await rep.post('/checkins', { eventId: mk(YEST, '14:00', 'Stale A'), checkedInAt: `${YEST}T08:57:00` });
  assert.equal(stale.status, 400);
  assert.equal(
    stale.json.error,
    'This check-in reached Linear Hub more than 24 hours after the event ended at 14:00, so it cannot be recorded. Ask your team leader to record your arrival time.',
  );
  // two days ago (the first 1.2 build allowed a week): refused
  const twoDays = addDays(TODAY, -2);
  const old = await repA2.post('/checkins', { eventId: mk(twoDays, '17:00', 'Old A'), checkedInAt: `${twoDays}T08:57:00`, source: 'offline' });
  assert.equal(old.status, 400);
  assert.match(old.json.error, /24 hours/);
  const rows = get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM check_ins ci JOIN events e ON e.id = ci.event_id WHERE e.name IN ('Stale A', 'Old A')`)!.n;
  assert.equal(rows, 0, 'nothing was written for a refused check-in');
});

test('S3: check-ins still never create a gauge row or a payroll run', async () => {
  const count = (t: string) => get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM ${t}`)!.n;
  const before = { gauges: count('gauge_entries'), runs: count('payroll_runs') };
  const ev = yesterdayEvent('Pay A');
  assert.equal((await rep.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T08:40:00` })).status, 201);
  assert.equal((await repA2.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T06:00:00` })).json.checkedInAt, `${YEST}T08:00:00`);
  assert.deepEqual({ gauges: count('gauge_entries'), runs: count('payroll_runs') }, before);
  const list = await leader.get(`/checkins?eventId=${ev}`);
  assert.deepEqual((list.json.checkIns as Json[]).map((c) => c.source), ['offline', 'offline'], 'leaders see both as sent later');
});

test('S3 (second review): the person cannot change, clear or move a time a leader recorded for them; counts stay editable', async () => {
  const ev = yesterdayEvent('Lock A');
  const other = yesterdayEvent('Lock A other');
  const g = await leader.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G, checkedInAt: `${YEST}T10:30` });
  assert.equal(g.status, 201);
  assert.equal(g.json.checkInOnBehalf, true, 'the answer says the time was recorded on their behalf');
  assert.equal((await rep.post('/checkins', { eventId: ev, checkedInAt: `${YEST}T08:50:00` })).status, 201);
  assert.equal(punctual(fx().users.rep, ev), 0);

  // the reviewer's two-step: the rep edits the time on their own entry → refused, nothing changes
  const patch = await rep.patch(`/gauges/${g.json.id}`, { checkedInAt: `${YEST}T10:31` });
  assert.equal(patch.status, 403, JSON.stringify(patch.json));
  assert.equal(patch.json.error, 'Your team leader recorded your arrival time on these gauges. Ask them to change it.');
  const upsert = await rep.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G, checkedInAt: `${YEST}T09:40` });
  assert.equal(upsert.status, 403);
  assert.equal((await rep.patch(`/gauges/${g.json.id}`, { checkedInAt: null })).status, 403, 'clearing it is a change too');
  const move = await rep.patch(`/gauges/${g.json.id}`, { eventId: other });
  assert.equal(move.status, 403);
  assert.equal(move.json.error, 'Your team leader recorded your arrival time on these gauges. Ask them to move the entry.');
  assert.equal(authorOf(g.json.id), fx().users.leader);
  assert.equal(get<{ at: string }>(srv.db, 'SELECT checked_in_at AS at FROM gauge_entries WHERE id = ?', [g.json.id])!.at, `${YEST}T10:30:00`);
  assert.equal(punctual(fx().users.rep, ev), 0, 'the leader’s 10:30 still counts');

  // the same time sent back (any spelling of it), or left out, is not a change: counts and notes save
  const same = await rep.patch(`/gauges/${g.json.id}`, { sales: 0, taps: 1, checkedInAt: `${YEST}T10:30:00`, notes: 'rain' });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.equal((await rep.post('/gauges', { eventId: ev, userId: fx().users.rep, date: YEST, ...G })).status, 200);
  assert.equal(authorOf(g.json.id), fx().users.leader);

  // who sees the flag: the person and their leader; a teammate sees neither the time nor who recorded it
  srv.resetCache();
  const mine = await rep.get(`/gauges?eventId=${ev}`);
  assert.equal((mine.json as Json[]).find((e) => e.id === g.json.id)?.checkInOnBehalf, true);
  const mate = await repA2.get(`/events/${ev}`);
  const seen = ((mate.json.entries ?? []) as Json[]).find((e) => e.id === g.json.id);
  assert.ok(seen, JSON.stringify(mate.json).slice(0, 200));
  assert.deepEqual([seen.checkedInAt, seen.checkInOnBehalf], [null, false]);
  const ldr = await leader.get(`/events/${ev}`);
  assert.equal(((ldr.json.entries ?? []) as Json[]).find((e) => e.id === g.json.id)?.checkInOnBehalf, true, 'their leader sees it');

  // the leader can still change it (it stays theirs), and an admin can too
  assert.equal((await leader.patch(`/gauges/${g.json.id}`, { checkedInAt: `${YEST}T09:20` })).status, 200);
  assert.equal(authorOf(g.json.id), fx().users.leader);
  assert.equal(punctual(fx().users.rep, ev), 0);
});

test('S3 (second review): a leader cannot undo an arrival time an admin recorded on their own day', async () => {
  const ev = yesterdayEvent('Lock leader A');
  const g = await admin.post('/gauges', { eventId: ev, userId: fx().users.leader, date: YEST, ...G, checkedInAt: `${YEST}T09:50` });
  assert.equal(g.status, 201);
  assert.equal(authorOf(g.json.id), fx().users.admin);
  // bulk entry: their own row with another time is refused (and nothing is saved), other rows are fine
  const bulk = await leader.post('/gauges/bulk', { eventId: ev, date: YEST, rows: [{ userId: fx().users.leader, ...G, checkedInAt: `${YEST}T08:59` }] });
  assert.equal(bulk.status, 400, JSON.stringify(bulk.json));
  assert.deepEqual(bulk.json.details.rows[0].errors, ['An admin recorded your arrival time on these gauges. Ask them to change it.']);
  const kept = await leader.post('/gauges/bulk', { eventId: ev, date: YEST, rows: [{ userId: fx().users.leader, ...G, sales: 0, taps: 1 }, { userId: fx().users.repA2, ...G, checkedInAt: `${YEST}T09:10` }] });
  assert.equal(kept.status, 200, JSON.stringify(kept.json));
  assert.equal(authorOf(g.json.id), fx().users.admin);
  // deleting their own day would drop it: refused; the admin may
  const del = await leader.del(`/gauges/${g.json.id}`);
  assert.equal(del.status, 403);
  assert.equal(del.json.error, 'An admin recorded your arrival time on these gauges. Ask them to delete the entry.');
  assert.equal((await admin.del(`/gauges/${g.json.id}`)).status, 204);
});

test('S3 (second review): a time that is the person’s own check-in to the minute stays theirs, so the precise check-in counts', async () => {
  const ev = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '09:00', endTime: '17:00', name: 'Minute A' });
  try {
    setBusinessClock(new Date(`${TODAY}T09:05:40`));
    const tap = await repA2.post('/checkins', { eventId: ev });
    assert.equal(tap.status, 201);
    assert.deepEqual([tap.json.checkedInAt, tap.json.onTime, tap.json.minutesLate], [`${TODAY}T09:05:40`, false, 6]);
  } finally {
    setBusinessClock(new Date(`${TODAY}T15:00:00`));
  }
  // Log gauges fills the field with the check-in without its seconds; the leader saves it as it is
  const g = await leader.post('/gauges', { eventId: ev, userId: fx().users.repA2, date: TODAY, ...G, checkedInAt: `${TODAY}T09:05` });
  assert.equal(g.status, 201);
  assert.equal(authorOf(g.json.id), fx().users.repA2, 'the person’s own time');
  assert.equal(g.json.checkInOnBehalf, false);
  assert.equal(punctual(fx().users.repA2, ev), 0, '6 minutes late, as the roll call says');
  // a time the leader types themself is the leader's and counts
  assert.equal((await leader.patch(`/gauges/${g.json.id}`, { checkedInAt: `${TODAY}T09:03` })).status, 200);
  assert.equal(authorOf(g.json.id), fx().users.leader);
  assert.equal(punctual(fx().users.repA2, ev), 1);
  // …and saving the check-in's minute again hands it back to the check-in
  assert.equal((await leader.patch(`/gauges/${g.json.id}`, { checkedInAt: `${TODAY}T09:05` })).status, 200);
  assert.equal(authorOf(g.json.id), fx().users.repA2);
  assert.equal(punctual(fx().users.repA2, ev), 0);
});

test('S3 (second review): moving an entry to another event or day keeps its time’s author', async () => {
  const x = yesterdayEvent('Move X');
  const y = yesterdayEvent('Move Y');
  const z = yesterdayEvent('Move Z');
  // the rep's own time at X; the rep's late check-in at Y; the leader moves the entry to Y
  const own = await rep.post('/gauges', { eventId: x, userId: fx().users.rep, date: YEST, ...G, checkedInAt: `${YEST}T08:55` });
  assert.equal(own.status, 201);
  assert.equal((await rep.post('/checkins', { eventId: y, checkedInAt: `${YEST}T09:20:00` })).status, 201);
  const moved = await leader.patch(`/gauges/${own.json.id}`, { eventId: y });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(authorOf(own.json.id), fx().users.rep, 'still the rep’s own time');
  assert.equal(punctual(fx().users.rep, y), 0, 'so their check-in at Y counts: 20 minutes late');
  // a time the leader recorded stays the leader's when the leader moves it
  const led = await leader.post('/gauges', { eventId: x, userId: fx().users.repA2, date: YEST, ...G, checkedInAt: `${YEST}T09:01` });
  assert.equal((await leader.patch(`/gauges/${led.json.id}`, { eventId: z })).status, 200);
  assert.equal(authorOf(led.json.id), fx().users.leader);
});

test('S3 (second review): a check-in that carries a time is always recorded as sent later', async () => {
  const ev = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '09:00', endTime: '17:00', name: 'Source A' });
  // the reviewer's probe: an online phone back-dating with source 'button' / 'quick'
  const button = await rep.post('/checkins', { eventId: ev, checkedInAt: `${TODAY}T08:05:00`, source: 'button' });
  assert.equal(button.status, 201);
  assert.deepEqual([button.json.checkedInAt, button.json.source], [`${TODAY}T08:05:00`, 'offline']);
  const quick = await repA2.post('/checkins', { eventId: ev, checkedInAt: `${TODAY}T07:00:00`, source: 'quick' });
  assert.deepEqual([quick.json.checkedInAt, quick.json.source], [`${TODAY}T08:00:00`, 'offline']);
  // without a time it is Linear Hub's own: a live tap, never "sent later"
  const live = await leader.post('/checkins', { eventId: ev, source: 'offline' });
  assert.equal(live.json.source, 'button');
  const ev2 = addEvent(srv.db, { campaignId: fx().campaignId, teamId: fx().teams.a, date: TODAY, status: 'live', startTime: '09:00', endTime: '17:00', name: 'Source A2' });
  assert.equal((await rep.post('/checkins', { eventId: ev2, source: 'quick' })).json.source, 'quick');
  const list = await leader.get(`/checkins?eventId=${ev}`);
  assert.deepEqual(Object.fromEntries((list.json.checkIns as Json[]).map((c) => [c.userId, c.source])), { [fx().users.rep]: 'offline', [fx().users.repA2]: 'offline', [fx().users.leader]: 'button' });
});
