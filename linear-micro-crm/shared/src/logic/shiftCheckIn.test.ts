import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIFT_CHECK_IN_EARLY_MINUTES,
  SHIFT_CHECK_IN_QUEUE_LIMIT,
  SHIFT_CHECK_IN_REPLAY_HOURS,
  SHIFT_CHECK_IN_UNDO_GRACE_MS,
  SHIFT_CHECK_IN_UNDO_MS,
} from '../types/checkins.ts';
import {
  addToShiftCheckInQueue,
  canUndoShiftCheckIn,
  naiveDiffMs,
  resolveShiftCheckInTime,
  shiftCheckInClock,
  shiftCheckInLabel,
  shiftCheckInReplayOutcome,
  shiftCheckInStatus,
  shiftCheckInStatusText,
  shiftCheckInUndoMsLeft,
  shiftCheckInWindow,
} from './shiftCheckIn.ts';

// Naive wall-clock timestamps (no Z) keep these tests independent of the machine's timezone.
const DAY = '2026-10-15';

test('status: the existing 5-minute grace rule decides on time; minutes late are rounded up', () => {
  assert.deepEqual(shiftCheckInStatus(DAY, '09:00', `${DAY}T08:41:00`), { minutesLate: 0, onTime: true });
  assert.deepEqual(shiftCheckInStatus(DAY, '09:00', `${DAY}T09:05:00`), { minutesLate: 5, onTime: true });
  assert.deepEqual(shiftCheckInStatus(DAY, '09:00', `${DAY}T09:05:01`), { minutesLate: 6, onTime: false });
  assert.deepEqual(shiftCheckInStatus(DAY, '09:00', `${DAY}T09:36:00`), { minutesLate: 36, onTime: false });
  // an unreadable time is never reported as late
  assert.deepEqual(shiftCheckInStatus(DAY, '09:00', 'not a time'), { minutesLate: null, onTime: true });
});

test('label: "Checked in 09:24 · on time" / "· 6 min late", the time as written', () => {
  assert.equal(shiftCheckInLabel(`${DAY}T09:24:00`, shiftCheckInStatus(DAY, '09:30', `${DAY}T09:24:00`)), 'Checked in 09:24 · on time');
  assert.equal(shiftCheckInLabel(`${DAY}T09:36:00`, shiftCheckInStatus(DAY, '09:30', `${DAY}T09:36:00`)), 'Checked in 09:36 · 6 min late');
  assert.equal(shiftCheckInLabel(`${DAY}T09:24:00`, { minutesLate: null, onTime: true }), 'Checked in 09:24');
  assert.equal(shiftCheckInStatusText({ minutesLate: 3, onTime: true }), 'on time', 'inside the grace it reads on time');
  assert.equal(shiftCheckInClock(`${DAY}T07:05:59`), '07:05');
  assert.equal(shiftCheckInClock('garbage'), '');
});

test('undo: two minutes from the moment it was written, with the server grace on top', () => {
  const created = '2026-10-15T08:24:00.000Z';
  const t0 = Date.parse(created);
  assert.equal(canUndoShiftCheckIn(created, t0), true);
  assert.equal(canUndoShiftCheckIn(created, t0 + SHIFT_CHECK_IN_UNDO_MS), true, 'inclusive at exactly 2 minutes');
  assert.equal(canUndoShiftCheckIn(created, t0 + SHIFT_CHECK_IN_UNDO_MS + 1), false);
  assert.equal(canUndoShiftCheckIn(created, t0 + SHIFT_CHECK_IN_UNDO_MS + 10_000, SHIFT_CHECK_IN_UNDO_GRACE_MS), true, 'grace absorbs a slow request');
  assert.equal(canUndoShiftCheckIn('nope', t0), false);
  assert.equal(shiftCheckInUndoMsLeft(created, t0 + 30_000), 90_000);
  assert.equal(shiftCheckInUndoMsLeft(created, t0 + 5 * 60_000), 0);
  assert.equal(shiftCheckInUndoMsLeft(created, t0 - 60_000), SHIFT_CHECK_IN_UNDO_MS, 'never more than the window');
  assert.equal(shiftCheckInUndoMsLeft('nope', t0), 0);
});

test('window: open all day until the end time (arriving early counts), then ended; other days and cancelled never', () => {
  const ev = { date: DAY, endTime: '17:00', status: 'live' };
  assert.equal(shiftCheckInWindow(ev, DAY, '07:30'), 'open');
  assert.equal(shiftCheckInWindow(ev, DAY, '17:00'), 'open');
  assert.equal(shiftCheckInWindow(ev, DAY, '17:01'), 'ended');
  assert.equal(shiftCheckInWindow(ev, '2026-10-16', '09:00'), 'not-today');
  assert.equal(shiftCheckInWindow({ ...ev, status: 'cancelled' }, DAY, '09:00'), 'cancelled');
});

test('time: a live tap records now, only on the event day and until the event ends', () => {
  const base = { eventDate: DAY, startTime: '09:00', endTime: '17:00', requested: null, now: `${DAY}T09:24:10`, today: DAY };
  assert.deepEqual(resolveShiftCheckInTime(base), { ok: true, checkedInAt: `${DAY}T09:24:10` });
  assert.deepEqual(resolveShiftCheckInTime({ ...base, now: `${DAY}T17:00:00` }), { ok: true, checkedInAt: `${DAY}T17:00:00` });
  const late = resolveShiftCheckInTime({ ...base, now: `${DAY}T17:00:01` });
  assert.equal(late.ok, false);
  assert.match(!late.ok ? late.error : '', /closed at 17:00/);
  const otherDay = resolveShiftCheckInTime({ ...base, today: '2026-10-16', now: '2026-10-16T09:00:00' });
  assert.equal(otherDay.ok, false);
  // a live tap has no early bound: arriving two hours early with signal records the time it was tapped
  assert.deepEqual(resolveShiftCheckInTime({ ...base, now: `${DAY}T07:00:00` }), { ok: true, checkedInAt: `${DAY}T07:00:00` });
});

test('time: a replayed offline tap keeps its time, within the rules', () => {
  const base = { eventDate: DAY, startTime: '09:00', endTime: '17:00', requested: `${DAY}T08:55:00`, now: `${DAY}T11:00:00`, today: DAY };
  assert.deepEqual(resolveShiftCheckInTime(base), { ok: true, checkedInAt: `${DAY}T08:55:00` });
  // sent the next morning (no signal all evening): still accepted with the tapped time
  assert.deepEqual(resolveShiftCheckInTime({ ...base, today: '2026-10-16', now: '2026-10-16T08:00:00' }), { ok: true, checkedInAt: `${DAY}T08:55:00` });
  // a phone clock 3 minutes ahead is "now"; 10 minutes ahead is refused
  assert.deepEqual(resolveShiftCheckInTime({ ...base, requested: `${DAY}T11:03:00` }), { ok: true, checkedInAt: `${DAY}T11:00:00` });
  const future = resolveShiftCheckInTime({ ...base, requested: `${DAY}T11:10:00` });
  assert.equal(future.ok, false);
  assert.match(!future.ok ? future.error : '', /future/);
  // another day's time, or after the end
  assert.equal(resolveShiftCheckInTime({ ...base, requested: '2026-10-14T08:55:00' }).ok, false);
  assert.equal(resolveShiftCheckInTime({ ...base, requested: `${DAY}T17:30:00`, now: `${DAY}T18:00:00` }).ok, false);
});

test('time: an offline tap is never earlier than 60 minutes before the start (an earlier one is recorded as that)', () => {
  const base = { eventDate: DAY, startTime: '09:00', endTime: '17:00', requested: `${DAY}T08:00:00`, now: `${DAY}T11:00:00`, today: DAY };
  assert.equal(SHIFT_CHECK_IN_EARLY_MINUTES, 60);
  assert.deepEqual(resolveShiftCheckInTime(base), { ok: true, checkedInAt: `${DAY}T08:00:00` }, 'exactly 60 minutes before is kept');
  assert.deepEqual(resolveShiftCheckInTime({ ...base, requested: `${DAY}T07:59:59` }), { ok: true, checkedInAt: `${DAY}T08:00:00` });
  // the reviewer's case: a time just after midnight, long before anyone arrived, is not a free "on time" from 00:00
  assert.deepEqual(resolveShiftCheckInTime({ ...base, requested: `${DAY}T00:00:01` }), { ok: true, checkedInAt: `${DAY}T08:00:00` });
  // still on time under the grace rule, so arriving early without signal never costs anyone
  assert.equal(shiftCheckInStatus(DAY, '09:00', `${DAY}T08:00:00`).onTime, true);
  // sent before that bound has even come round (tapped 07:00, sent 07:30): Linear Hub's own clock is the floor
  assert.deepEqual(resolveShiftCheckInTime({ ...base, requested: `${DAY}T07:00:00`, now: `${DAY}T07:30:00` }), { ok: true, checkedInAt: `${DAY}T07:30:00` });
  // an event starting before 01:00: the event's own date is the bound
  assert.deepEqual(resolveShiftCheckInTime({ ...base, startTime: '00:30', requested: `${DAY}T00:00:01` }), { ok: true, checkedInAt: `${DAY}T00:00:01` });
  // seconds on the start time are ignored, as everywhere else
  assert.deepEqual(resolveShiftCheckInTime({ ...base, startTime: '09:00:00', requested: `${DAY}T06:00:00` }), { ok: true, checkedInAt: `${DAY}T08:00:00` });
});

test('time: an offline tap must reach Linear Hub within 24 hours of the event ending', () => {
  const base = { eventDate: DAY, startTime: '09:00', endTime: '17:00', requested: `${DAY}T08:55:00`, now: `${DAY}T11:00:00`, today: DAY };
  assert.equal(SHIFT_CHECK_IN_REPLAY_HOURS, 24);
  const next = '2026-10-16';
  assert.deepEqual(resolveShiftCheckInTime({ ...base, today: next, now: `${next}T17:00:00` }), { ok: true, checkedInAt: `${DAY}T08:55:00` }, 'exactly 24 hours after the end');
  const late = resolveShiftCheckInTime({ ...base, today: next, now: `${next}T17:00:01` });
  assert.equal(late.ok, false);
  assert.equal(
    !late.ok ? late.error : '',
    'This check-in reached Linear Hub more than 24 hours after the event ended at 17:00, so it cannot be recorded. Ask your team leader to record your arrival time.',
  );
  // a week later (the first 1.2 build allowed 7 days) is refused too
  assert.equal(resolveShiftCheckInTime({ ...base, today: '2026-10-22', now: '2026-10-22T09:00:00' }).ok, false);
  // the 24 hours are counted on the wall clock: the October clock change (25 Oct 2026) never moves the deadline
  const sat = '2026-10-24';
  const overChange = { ...base, eventDate: sat, requested: `${sat}T08:55:00`, today: '2026-10-25' };
  assert.equal(resolveShiftCheckInTime({ ...overChange, now: '2026-10-25T17:00:00' }).ok, true);
  assert.equal(resolveShiftCheckInTime({ ...overChange, now: '2026-10-25T17:01:00' }).ok, false);
  // a live tap is never a replay: the end-time rule already covers it
  assert.equal(resolveShiftCheckInTime({ ...base, requested: null, today: next, now: `${next}T09:00:00` }).ok, false);
});

test('naiveDiffMs never shifts by a daylight-saving change', () => {
  // 25 Oct 2026 is the BST → GMT change in London; naive times are compared as written.
  assert.equal(naiveDiffMs('2026-10-25T00:30:00', '2026-10-25T03:30:00'), 3 * 3_600_000);
  assert.ok(Number.isNaN(naiveDiffMs('x', '2026-10-25T03:30:00')));
});

test('replay outcome: 201 sent, 200 already there, keep on no answer / sign-in / PIN / server trouble, else failed', () => {
  assert.equal(shiftCheckInReplayOutcome(201), 'sent');
  assert.equal(shiftCheckInReplayOutcome(200), 'already');
  assert.equal(shiftCheckInReplayOutcome(401), 'stop');
  assert.equal(shiftCheckInReplayOutcome(429), 'stop');
  assert.equal(shiftCheckInReplayOutcome(403, { pinSetupRequired: true }), 'stop');
  assert.equal(shiftCheckInReplayOutcome(403), 'failed');
  assert.equal(shiftCheckInReplayOutcome(400), 'failed');
  assert.equal(shiftCheckInReplayOutcome(404), 'failed');
  assert.equal(shiftCheckInReplayOutcome(409), 'failed');
  assert.equal(shiftCheckInReplayOutcome(500), 'stop');
  assert.equal(shiftCheckInReplayOutcome(503), 'stop');
});

test('queue: one item per event and day, the earliest tap kept; full queue refuses', () => {
  const a = { eventId: 1, date: DAY, checkedInAt: `${DAY}T09:10:00` };
  const q1 = addToShiftCheckInQueue([], a)!;
  assert.deepEqual(q1, [a]);
  // a later second tap keeps the first time
  assert.deepEqual(addToShiftCheckInQueue(q1, { ...a, checkedInAt: `${DAY}T09:20:00` }), [a]);
  // an earlier one (a phone whose clock was corrected) replaces it
  const earlier = { ...a, checkedInAt: `${DAY}T09:00:00` };
  assert.deepEqual(addToShiftCheckInQueue(q1, earlier), [earlier]);
  // another event is added
  const b = { eventId: 2, date: DAY, checkedInAt: `${DAY}T13:00:00` };
  assert.deepEqual(addToShiftCheckInQueue(q1, b), [a, b]);
  const full = Array.from({ length: SHIFT_CHECK_IN_QUEUE_LIMIT }, (_, i) => ({ eventId: 100 + i, date: DAY, checkedInAt: `${DAY}T09:00:00` }));
  assert.equal(addToShiftCheckInQueue(full, b), null);
  // a repeat tap for a queued event is never refused by the limit
  assert.ok(addToShiftCheckInQueue(full, { ...full[0]!, checkedInAt: `${DAY}T10:00:00` }));
});
