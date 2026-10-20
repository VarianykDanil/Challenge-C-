import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GaugeTotals, GaugeUpsertInput } from '../types.ts';
import { GAUGE_KEYS } from '../types.ts';
import { firstMemberWithoutEntry, inCheckInWindow, normaliseTally, preselectTodayEvent, replayDecision, replayOutcome, sameGaugeDay, tallyPerson } from './outbox.ts';

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

/** [stops, table, presentations, closes, taps, sales] → counts, so a funnel reads as one line. */
const F = (...v: number[]): GaugeTotals => Object.fromEntries(GAUGE_KEYS.map((k, i) => [k, v[i] ?? 0])) as unknown as GaugeTotals;
const isFunnel = (c: GaugeTotals) => GAUGE_KEYS.every((k, i) => c[k] >= 0 && (i === 0 || c[k] <= c[GAUGE_KEYS[i - 1]!]));
/** A fixed pseudo-random sequence (no Math.random), so the property tests are repeatable. */
function randomFunnels(n: number, top = 30): GaugeTotals[] {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out: GaugeTotals[] = [ZERO];
  while (out.length < n) {
    let ceiling = Math.floor(next() * (top + 1));
    const counts = {} as GaugeTotals;
    for (const k of GAUGE_KEYS) {
      counts[k] = Math.floor(next() * (ceiling + 1));
      ceiling = counts[k];
    }
    out.push(counts);
  }
  return out;
}
const hintOf = (r: ReturnType<typeof tallyPerson>) => (r.ok ? null : r.hint);

test("tallyPerson: the owner's three examples", () => {
  // "If there is a presentation, the client got to that stage, so it means increment table and stop."
  assert.deepEqual(tallyPerson(ZERO, 'presentations', 1), { ok: true, counts: F(1, 1, 1, 0, 0, 0) });
  // "If there is a tap, increment close and presentation and table and stops."
  assert.deepEqual(tallyPerson(ZERO, 'taps', 1), { ok: true, counts: F(1, 1, 1, 1, 1, 0) });
  // "If the person just stopped, then just stop is incremented."
  assert.deepEqual(tallyPerson(ZERO, 'stops', 1), { ok: true, counts: F(1, 0, 0, 0, 0, 0) });
  // The same on a shift already under way: the stages after the tapped one never move.
  assert.deepEqual(tallyPerson(F(40, 10, 5, 3, 2, 2), 'presentations', 1).counts, F(41, 11, 6, 3, 2, 2));
  assert.deepEqual(tallyPerson(F(40, 10, 5, 3, 2, 2), 'stops', 1).counts, F(41, 10, 5, 3, 2, 2));
});

test('tallyPerson: a sale from zero counts every stage once; To table adds a stop', () => {
  assert.deepEqual(tallyPerson(ZERO, 'sales', 1), { ok: true, counts: F(1, 1, 1, 1, 1, 1) });
  assert.deepEqual(tallyPerson(ZERO, 'table', 1).counts, F(1, 1, 0, 0, 0, 0));
  assert.deepEqual(tallyPerson(ZERO, 'closes', 1).counts, F(1, 1, 1, 1, 0, 0));
});

test('tallyPerson: a shift tapped as on the Quick gauges screen', () => {
  const steps: Array<[keyof GaugeTotals, 1 | -1, GaugeTotals]> = [
    ['stops', 1, F(1, 0, 0, 0, 0, 0)],
    ['presentations', 1, F(2, 1, 1, 0, 0, 0)],
    ['taps', 1, F(3, 2, 2, 1, 1, 0)],
    ['sales', 1, F(4, 3, 3, 2, 2, 1)],
  ];
  let counts = ZERO;
  for (const [k, d, want] of steps) {
    const r = tallyPerson(counts, k, d);
    assert.equal(r.ok, true, `${k} ${d}`);
    assert.deepEqual(r.counts, want, `${k} ${d}`);
    counts = r.counts;
  }
  // Two people got as far as a tap, so a close can't come off before a tap does.
  const closes = tallyPerson(counts, 'closes', -1);
  assert.equal(closes.ok, false);
  assert.equal(closes.counts, counts);
  assert.equal(hintOf(closes), "Can't take one off closes: 2 people got as far as taps. Take one off Taps first.");
  // Taking the sale off again takes that person off every stage they counted on.
  assert.deepEqual(tallyPerson(counts, 'sales', -1), { ok: true, counts: F(3, 2, 2, 1, 1, 0) });
});

test('tallyPerson: −1 is refused at 0 or when the stage after it would be left higher, with one hint', () => {
  const z = tallyPerson(ZERO, 'sales', -1);
  assert.equal(z.ok, false);
  assert.equal(z.counts, ZERO);
  assert.equal(hintOf(z), 'Sales is already 0.');
  assert.equal(hintOf(tallyPerson(ZERO, 'stops', -1)), 'Stops is already 0.');
  // The example in the spec: three people got as far as closes, so presentations can't drop below three.
  const counts = F(5, 4, 3, 3, 1, 0);
  assert.equal(hintOf(tallyPerson(counts, 'presentations', -1)), "Can't take one off presentations: 3 people got as far as closes. Take one off Closes first.");
  // One person, and the table's own wording.
  assert.equal(hintOf(tallyPerson(F(1, 1, 0, 0, 0, 0), 'stops', -1)), "Can't take one off stops: 1 person got as far as the table. Take one off To table first.");
  assert.equal(hintOf(tallyPerson(F(3, 2, 2, 0, 0, 0), 'table', -1)), "Can't take one off to table: 2 people got as far as presentations. Take one off Presentations first.");
  // Allowed when the stage after it is lower: every stage from Stops to it comes down by one.
  assert.deepEqual(tallyPerson(counts, 'closes', -1).counts, F(4, 3, 2, 2, 1, 0));
  assert.deepEqual(tallyPerson(counts, 'stops', -1).counts, F(4, 4, 3, 3, 1, 0));
  // Sales is the end of the funnel: nothing after it can block a −1.
  assert.deepEqual(tallyPerson(F(2, 2, 2, 2, 2, 2), 'sales', -1).counts, F(1, 1, 1, 1, 1, 1));
});

test('tallyPerson: counts that are not a funnel never go below 0', () => {
  // Never stored (normaliseTally repairs what is read back), but the rule must still not produce a negative count.
  const broken = F(0, 1, 1, 0, 0, 0);
  const r = tallyPerson(broken, 'presentations', -1);
  assert.equal(r.ok, false);
  assert.equal(hintOf(r), 'Stops is already 0.');
  assert.equal(r.counts, broken);
});

test('tallyPerson: +1 is refused only at the daily maximum, naming the stage that is full', () => {
  const r = tallyPerson(F(5, 0, 0, 0, 0, 0), 'stops', 1, 5);
  assert.equal(r.ok, false);
  assert.equal(hintOf(r), 'Stops is at the daily maximum of 5.');
  // A sale would raise Stops too, so it is refused while Stops is full, even though Sales is not.
  assert.equal(hintOf(tallyPerson(F(5, 3, 2, 1, 0, 0), 'sales', 1, 5)), 'Stops is at the daily maximum of 5.');
  assert.equal(hintOf(tallyPerson(F(5, 5, 5, 2, 0, 0), 'closes', 1, 5)), 'Stops is at the daily maximum of 5.');
  // Just below it everything still counts, up to the maximum and never past it.
  assert.deepEqual(tallyPerson(F(4, 4, 4, 4, 4, 4), 'sales', 1, 5).counts, F(5, 5, 5, 5, 5, 5));
  // The real maximum, written the British way.
  assert.equal(hintOf(tallyPerson(F(2000, 0, 0, 0, 0, 0), 'table', 1)), 'Stops is at the daily maximum of 2,000.');
  // Taking one off is still allowed at the maximum.
  assert.deepEqual(tallyPerson(F(5, 0, 0, 0, 0, 0), 'stops', -1, 5).counts, F(4, 0, 0, 0, 0, 0));
});

test('tallyPerson: never changes its input, and the same tap gives the same answer', () => {
  const counts = Object.freeze(F(40, 10, 5, 3, 2, 2));
  for (const k of GAUGE_KEYS) {
    for (const d of [1, -1] as const) {
      const a = tallyPerson(counts, k, d);
      assert.deepEqual(tallyPerson(counts, k, d), a);
      if (a.ok) assert.notEqual(a.counts, counts);
    }
  }
  assert.deepEqual(counts, F(40, 10, 5, 3, 2, 2));
});

test('tallyPerson: +1 then −1 (and −1 then +1) on any stage of many valid funnels gives the funnel back', () => {
  for (const counts of randomFunnels(400)) {
    for (const [i, key] of GAUGE_KEYS.entries()) {
      const up = tallyPerson(counts, key, 1);
      assert.equal(up.ok, true, JSON.stringify({ counts, key }));
      // Every stage from Stops to `key` goes up by exactly one; the stages after it never move.
      for (const [j, k] of GAUGE_KEYS.entries()) assert.equal(up.counts[k], counts[k] + (j <= i ? 1 : 0), `${k} after +1 on ${key}`);
      assert.ok(isFunnel(up.counts), JSON.stringify({ counts, key, after: up.counts }));
      assert.deepEqual(tallyPerson(up.counts, key, -1), { ok: true, counts });

      const after = GAUGE_KEYS[i + 1];
      const down = tallyPerson(counts, key, -1);
      assert.equal(down.ok, counts[key] > (after ? counts[after] : 0), JSON.stringify({ counts, key, down }));
      if (down.ok) {
        assert.ok(isFunnel(down.counts), JSON.stringify({ counts, key, after: down.counts }));
        assert.deepEqual(tallyPerson(down.counts, key, 1), { ok: true, counts });
      } else {
        assert.equal(down.counts, counts);
      }
    }
  }
});

test('tallyPerson: every valid funnel can be reached with +1 taps alone, in any order', () => {
  for (const want of randomFunnels(200)) {
    // The people whose furthest stage was k: k's count minus the next stage's.
    const people = GAUGE_KEYS.flatMap((k, i) => Array<keyof GaugeTotals>(want[k] - (i < GAUGE_KEYS.length - 1 ? want[GAUGE_KEYS[i + 1]!] : 0)).fill(k));
    for (const order of [people, [...people].reverse()]) {
      let counts = ZERO;
      for (const k of order) {
        const r = tallyPerson(counts, k, 1);
        assert.equal(r.ok, true);
        counts = r.counts;
        assert.ok(isFunnel(counts));
      }
      assert.deepEqual(counts, want);
    }
  }
});

test('normaliseTally: junk becomes zeros, values are whole, clamped and made a valid funnel', () => {
  assert.deepEqual(normaliseTally(null), ZERO);
  assert.deepEqual(normaliseTally('x'), ZERO);
  assert.deepEqual(normaliseTally({ stops: 4.7, table: '3', presentations: -2, closes: Infinity }), { ...ZERO, stops: 4 });
  assert.deepEqual(normaliseTally({ stops: 3, table: 5, presentations: 2, closes: 2, taps: 9, sales: 1 }), { stops: 3, table: 3, presentations: 2, closes: 2, taps: 2, sales: 1 });
  assert.deepEqual(normaliseTally({ stops: 9999, table: 1 }, 100), { ...ZERO, stops: 100, table: 1 });
});
