import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GaugeTotals, GaugeUpsertInput } from '../types.ts';
import { GAUGE_KEYS } from '../types.ts';
import { firstMemberWithoutEntry, inCheckInWindow, normaliseTally, preselectTodayEvent, replayDecision, replayOutcome, sameGaugeDay, tallyStep } from './outbox.ts';

const QUEUED = '2026-10-19T10:00:00.000Z';

test('replayDecision: no existing entry → send', () => {
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: null }, null), 'send');
});

test('replayDecision: the entry the phone was changing is gone (deleted meanwhile) → review', () => {
  // Sending would create the day again behind the back of whoever deleted it (and a gauge row pays a day's base).
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, null), 'review');
});

test('replayDecision: same id with an older (or equal) submittedAt → send', () => {
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 7, submittedAt: '2026-10-19T09:30:00.000Z' }), 'send');
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 7, submittedAt: QUEUED }), 'send');
});

test('replayDecision: a different id → review', () => {
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 8, submittedAt: '2026-10-19T09:30:00.000Z' }), 'review');
});

test('replayDecision: a newer submittedAt (someone edited it after the phone queued) → review', () => {
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 7, submittedAt: '2026-10-19T10:00:00.001Z' }), 'review');
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 7, submittedAt: '2026-10-19T14:02:00.000Z' }), 'review');
});

test('replayDecision: expectedExistingId null with an existing entry → review', () => {
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: null }, { id: 7, submittedAt: '2026-10-18T09:00:00.000Z' }), 'review');
});

test('replayDecision compares instants, not strings, and never sends on an unreadable timestamp', () => {
  // 11:00+01:00 is 10:00Z: the same instant as the queue time, so not newer.
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 7, submittedAt: '2026-10-19T11:00:00+01:00' }), 'send');
  assert.equal(replayDecision({ queuedAt: QUEUED, expectedExistingId: 7 }, { id: 7, submittedAt: 'not a date' }), 'review');
  assert.equal(replayDecision({ queuedAt: '', expectedExistingId: 7 }, { id: 7, submittedAt: QUEUED }), 'review');
});

const DAY: GaugeTotals = { stops: 40, table: 14, presentations: 7, closes: 3, taps: 2, sales: 2 };
const input = (extra: Partial<GaugeUpsertInput> = {}): GaugeUpsertInput => ({ ...DAY, eventId: 1, userId: 2, date: '2026-10-19', ...extra });

test('sameGaugeDay: equal counts with omitted check-in / notes match', () => {
  assert.equal(sameGaugeDay({ ...DAY, checkedInAt: '2026-10-19T09:58:00', notes: 'Busy' }, input()), true);
});

test('sameGaugeDay: any differing count does not match', () => {
  for (const k of GAUGE_KEYS) assert.equal(sameGaugeDay({ ...DAY, [k]: DAY[k] + 1 }, input()), false, k);
});

test('sameGaugeDay: check-in compared to the minute, notes trimmed, null and empty alike', () => {
  assert.equal(sameGaugeDay({ ...DAY, checkedInAt: '2026-10-19T09:58:00', notes: null }, input({ checkedInAt: '2026-10-19T09:58', notes: null })), true);
  assert.equal(sameGaugeDay({ ...DAY, checkedInAt: '2026-10-19T09:58:00', notes: null }, input({ checkedInAt: '2026-10-19T09:59' })), false);
  assert.equal(sameGaugeDay({ ...DAY, checkedInAt: null, notes: 'Rain' }, input({ checkedInAt: null, notes: ' Rain ' })), true);
  assert.equal(sameGaugeDay({ ...DAY, checkedInAt: null, notes: null }, input({ notes: '' })), true);
  assert.equal(sameGaugeDay({ ...DAY, checkedInAt: null, notes: 'Rain' }, input({ notes: null })), false);
});

test('replayOutcome: 201 logged, 200 updated, 4xx failed, 401 and 5xx stop', () => {
  assert.equal(replayOutcome(201), 'logged');
  assert.equal(replayOutcome(200), 'updated');
  for (const s of [400, 403, 404, 409, 422]) assert.equal(replayOutcome(s), 'failed', String(s));
  assert.equal(replayOutcome(401), 'stop');
  for (const s of [500, 502, 503, 504]) assert.equal(replayOutcome(s), 'stop', String(s));
});

test('inCheckInWindow: [start − 60, start + 90], both ends included', () => {
  // The spec's examples for a 10:00 start: 09:55 offers the chip, 14:00 does not.
  assert.equal(inCheckInWindow('10:00', '09:55'), true);
  assert.equal(inCheckInWindow('10:00', '14:00'), false);
  assert.equal(inCheckInWindow('10:00', '09:00'), true);
  assert.equal(inCheckInWindow('10:00', '08:59'), false);
  assert.equal(inCheckInWindow('10:00', '11:30'), true);
  assert.equal(inCheckInWindow('10:00', '11:31'), false);
  // An early start: the window does not wrap past midnight.
  assert.equal(inCheckInWindow('00:30', '23:50'), false);
  assert.equal(inCheckInWindow('10:00:00', '10:15'), true);
  assert.equal(inCheckInWindow('', '10:00'), false);
  assert.equal(inCheckInWindow('10:00', 'later'), false);
});

const ev = (id: number, teamId: number, date: string, status: string) => ({ id, teamId, date, status });

test('preselectTodayEvent: exactly one own-team event today that is live or completed', () => {
  const today = '2026-10-19';
  assert.equal(preselectTodayEvent([ev(1, 5, today, 'live'), ev(2, 5, '2026-10-18', 'completed')], today, 5), 1);
  assert.equal(preselectTodayEvent([ev(1, 5, today, 'completed')], today, 5), 1);
  // Not started yet, cancelled, another team's: none of them count.
  assert.equal(preselectTodayEvent([ev(1, 5, today, 'scheduled'), ev(2, 5, today, 'cancelled'), ev(3, 6, today, 'live')], today, 5), null);
  // Two candidates: the person chooses.
  assert.equal(preselectTodayEvent([ev(1, 5, today, 'live'), ev(2, 5, today, 'live')], today, 5), null);
  assert.equal(preselectTodayEvent([ev(1, 5, today, 'live')], today, null), null);
  assert.equal(preselectTodayEvent([], today, 5), null);
});

test('firstMemberWithoutEntry: first active gauge-logging member with no entry, in list order', () => {
  const members = [
    { id: 1, role: 'leader', status: 'active' },
    { id: 2, role: 'rep', status: 'inactive' },
    { id: 3, role: 'recruiter', status: 'active' },
    { id: 4, role: 'rep', status: 'active' },
    { id: 5, role: 'rep', status: 'active' },
  ];
  assert.equal(firstMemberWithoutEntry(members, []), 1);
  assert.equal(firstMemberWithoutEntry(members, [1]), 4);
  assert.equal(firstMemberWithoutEntry(members, new Set([1, 4])), 5);
  assert.equal(firstMemberWithoutEntry(members, [1, 4, 5]), null);
});

const ZERO: GaugeTotals = { stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 };

test('tallyStep: +1 on stops always works; a +1 changes only its own row', () => {
  const r = tallyStep(ZERO, 'stops', 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { ...ZERO, stops: 1 });
  const r2 = tallyStep({ ...ZERO, stops: 3, table: 1 }, 'table', 1);
  assert.deepEqual(r2.counts, { ...ZERO, stops: 3, table: 2 });
});

test('tallyStep: a +1 that would pass the stage above is refused with a hint', () => {
  const counts = { stops: 5, table: 3, presentations: 2, closes: 1, taps: 1, sales: 1 };
  const r = tallyStep(counts, 'sales', 1);
  assert.equal(r.ok, false);
  assert.equal(r.counts, counts);
  assert.ok(!r.ok && r.hint === "Sales can't go above taps (1) — add one to Taps first.", !r.ok ? r.hint : '');
  const t = tallyStep(ZERO, 'table', 1);
  assert.ok(!t.ok && t.hint.startsWith("To table can't go above stops (0)"));
});

test('tallyStep: a −1 that would drop below the stage beneath is refused; 0 cannot go lower', () => {
  const counts = { stops: 3, table: 3, presentations: 1, closes: 0, taps: 0, sales: 0 };
  const r = tallyStep(counts, 'stops', -1);
  assert.ok(!r.ok && r.hint === "Stops can't go below to table (3) — take one off To table first.");
  assert.deepEqual(tallyStep(counts, 'table', -1).counts, { ...counts, table: 2 });
  const z = tallyStep(counts, 'sales', -1);
  assert.ok(!z.ok && z.hint === 'Sales is already 0.');
  // Sales is the bottom of the funnel: nothing below it can block a −1.
  assert.deepEqual(tallyStep({ ...counts, closes: 1, taps: 1, sales: 1 }, 'sales', -1).counts, { ...counts, closes: 1, taps: 1, sales: 0 });
});

test('tallyStep: the daily maximum caps stops', () => {
  const r = tallyStep({ ...ZERO, stops: 5 }, 'stops', 1, 5);
  assert.ok(!r.ok && r.hint === 'Stops is at the daily maximum of 5.');
});

test('tallyStep: every accepted sequence keeps the funnel valid', () => {
  let counts = ZERO;
  const taps: Array<[keyof GaugeTotals, 1 | -1]> = [['stops', 1], ['stops', 1], ['table', 1], ['sales', 1], ['presentations', 1], ['closes', 1], ['taps', 1], ['sales', 1], ['stops', -1], ['stops', -1], ['table', -1]];
  for (const [k, d] of taps) {
    counts = tallyStep(counts, k, d).counts;
    for (let i = 1; i < GAUGE_KEYS.length; i++) assert.ok(counts[GAUGE_KEYS[i]!] <= counts[GAUGE_KEYS[i - 1]!], JSON.stringify(counts));
  }
  assert.deepEqual(counts, { stops: 1, table: 1, presentations: 1, closes: 1, taps: 1, sales: 1 });
});

test('normaliseTally: junk becomes zeros, values are whole, clamped and made a valid funnel', () => {
  assert.deepEqual(normaliseTally(null), ZERO);
  assert.deepEqual(normaliseTally('x'), ZERO);
  assert.deepEqual(normaliseTally({ stops: 4.7, table: '3', presentations: -2, closes: Infinity }), { ...ZERO, stops: 4 });
  assert.deepEqual(normaliseTally({ stops: 3, table: 5, presentations: 2, closes: 2, taps: 9, sales: 1 }), { stops: 3, table: 3, presentations: 2, closes: 2, taps: 2, sales: 1 });
  assert.deepEqual(normaliseTally({ stops: 9999, table: 1 }, 100), { ...ZERO, stops: 100, table: 1 });
});
