import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCheckInOnTime, minutesLate, punctualityRate, punctualitySummary } from './punctuality.ts';

// Local-time timestamps (no Z) keep these tests independent of the machine's timezone.
const DAY = '2026-10-15';

test('isCheckInOnTime allows the 5-minute grace period inclusively', () => {
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T08:45:00`), true);
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T09:04:59`), true);
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T09:05:00`), true);
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T09:05:01`), false);
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T10:00:00`), false);
});

test('isCheckInOnTime honours a custom grace and returns null for missing/invalid data', () => {
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T09:00:01`, 0), false);
  assert.equal(isCheckInOnTime(DAY, '09:00', `${DAY}T09:14:00`, 15), true);
  assert.equal(isCheckInOnTime(DAY, '09:00', null), null);
  assert.equal(isCheckInOnTime(DAY, '09:00', 'not a date'), null);
  assert.equal(isCheckInOnTime('nope', '09:00', `${DAY}T09:00:00`), null);
  // "HH:MM:SS" start times are tolerated
  assert.equal(isCheckInOnTime(DAY, '09:00:00', `${DAY}T09:00:00`), true);
});

test('minutesLate counts whole minutes after the scheduled start, rounded up', () => {
  assert.equal(minutesLate(DAY, '09:00', `${DAY}T08:50:00`), 0);
  assert.equal(minutesLate(DAY, '09:00', `${DAY}T09:00:00`), 0);
  assert.equal(minutesLate(DAY, '09:00', `${DAY}T09:00:01`), 1);
  assert.equal(minutesLate(DAY, '09:00', `${DAY}T09:04:59`), 5);
  assert.equal(minutesLate(DAY, '09:00', `${DAY}T09:05:01`), 6);
  assert.equal(minutesLate(DAY, '09:00', `${DAY}T09:30:00`), 30);
  assert.equal(minutesLate(DAY, '09:00', null), null);
  assert.equal(minutesLate(DAY, '09:00', 'garbage'), null);
});

test('minutesLate > grace exactly when isCheckInOnTime is false', () => {
  for (const t of ['09:04:30', '09:05:00', '09:05:01', '09:05:59', '09:06:00']) {
    const stamp = `${DAY}T${t}`;
    const late = isCheckInOnTime(DAY, '09:00', stamp) === false;
    assert.equal((minutesLate(DAY, '09:00', stamp) ?? 0) > 5, late, t);
  }
});

test('punctualityRate ignores entries without a check-in and is null when none recorded', () => {
  assert.equal(punctualityRate([]), null);
  assert.equal(punctualityRate([{ eventDate: DAY, startTime: '09:00', checkedInAt: null }]), null);
  const rate = punctualityRate([
    { eventDate: DAY, startTime: '09:00', checkedInAt: `${DAY}T08:58:00` },
    { eventDate: DAY, startTime: '09:00', checkedInAt: `${DAY}T09:03:00` },
    { eventDate: DAY, startTime: '09:00', checkedInAt: `${DAY}T09:20:00` },
    { eventDate: DAY, startTime: '09:00', checkedInAt: null },
  ]);
  assert.ok(Math.abs((rate ?? 0) - 2 / 3) < 1e-12);
});

test('punctualitySummary counts and averages lateness', () => {
  const s = punctualitySummary([
    { eventDate: DAY, startTime: '09:00', checkedInAt: `${DAY}T08:58:00` },
    { eventDate: DAY, startTime: '09:00', checkedInAt: `${DAY}T09:10:00` },
    { eventDate: DAY, startTime: '09:00', checkedInAt: `${DAY}T09:20:00` },
    { eventDate: DAY, startTime: '09:00', checkedInAt: null },
  ]);
  assert.equal(s.recorded, 3);
  assert.equal(s.onTime, 1);
  assert.equal(s.late, 2);
  assert.ok(Math.abs((s.rate ?? 0) - 1 / 3) < 1e-12);
  assert.equal(s.avgMinutesLate, 15);
  assert.deepEqual(punctualitySummary([]), { recorded: 0, onTime: 0, late: 0, rate: null, avgMinutesLate: 0 });
});
