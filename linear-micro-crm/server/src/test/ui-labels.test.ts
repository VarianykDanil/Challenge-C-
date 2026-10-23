/**
 * Release 1.3.1 UI review: the client's own small rules for two labels, run under Node (pure modules, no React).
 *
 *  - UI-13 (client/src/features/events/peopleLabel.ts): the event header counts the people booked before the day and
 *    "x logged · N booked" during it; the bare "N reps" (people who logged gauges) stays for everything else.
 *  - UI-17 (client/src/lib/ratios.ts conversionKpi): with no stops the Conversion tile is "—" in the neutral tone, never
 *    "0.0%" in red as if the person were failing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPeopleLabel } from '../../../client/src/features/events/peopleLabel.ts';
import { conversionKpi, ratioTone } from '../../../client/src/lib/ratios.ts';

test('eventPeopleLabel: booked before the day, logged and booked on the day, reps otherwise', () => {
  assert.equal(eventPeopleLabel({ status: 'scheduled', repCount: 0, bookings: { booked: 7, me: false } }), '7 booked');
  assert.equal(eventPeopleLabel({ status: 'scheduled', repCount: 0, bookings: { booked: 1, me: true } }), '1 booked');
  assert.equal(eventPeopleLabel({ status: 'live', repCount: 3, bookings: { booked: 7, me: false } }), '3 logged · 7 booked');
  assert.equal(eventPeopleLabel({ status: 'live', repCount: 0, bookings: { booked: 7, me: false } }), '0 logged · 7 booked');
  assert.equal(eventPeopleLabel({ status: 'live', repCount: 9, bookings: { booked: 7, me: false } }), '9 logged · 7 booked', 'walk-ups log too');
  // nobody booked (no bookings key), or the day is over: the people who logged, as before
  assert.equal(eventPeopleLabel({ status: 'scheduled', repCount: 0 }), '0 reps');
  assert.equal(eventPeopleLabel({ status: 'live', repCount: 2 }), '2 reps');
  assert.equal(eventPeopleLabel({ status: 'live', repCount: 1, bookings: { booked: 0, me: false } }), '1 rep');
  assert.equal(eventPeopleLabel({ status: 'completed', repCount: 6, bookings: { booked: 7, me: false } }), '6 reps');
  assert.equal(eventPeopleLabel({ status: 'cancelled', repCount: 0, bookings: { booked: 4, me: false } }), '0 reps');
  assert.equal(eventPeopleLabel({ status: 'scheduled', repCount: 0, bookings: { booked: 1200, me: false } }), '1,200 booked');
});

test('conversionKpi: nothing logged → "—" in the neutral tone; with stops → the % in its benchmark tone', () => {
  assert.deepEqual(conversionKpi(0, 0), { value: '—', tone: 'default' });
  assert.deepEqual(conversionKpi(0, Number.NaN), { value: '—', tone: 'default' });
  assert.equal(conversionKpi(120, 0).value, '0.0%');
  assert.equal(conversionKpi(120, 0).tone, 'danger', 'stops but no sales is a real 0%');
  assert.equal(conversionKpi(100, 0.05).value, '5.0%');
  assert.equal(conversionKpi(100, 0.05).tone, ratioTone('overallConversion', 0.05));
});
