import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  addMonths,
  clampISO,
  daysBetween,
  dayOfWeek,
  eachDay,
  eachWeek,
  endOfMonthISO,
  endOfQuarterISO,
  endOfWeekISO,
  fromISODate,
  isoToUTC,
  isoWeek,
  isoWeekLabel,
  isoWeekday,
  isValidISODate,
  isWithin,
  monthKey,
  previousRange,
  quarterOf,
  rangeFor,
  startOfMonthISO,
  startOfQuarterISO,
  startOfWeekISO,
  toISODate,
  toISODateUTC,
  todayISO,
  dateOnly,
  minISO,
  maxISO,
} from './dates.ts';

test('isValidISODate accepts real dates and rejects malformed or impossible ones', () => {
  assert.equal(isValidISODate('2026-10-15'), true);
  assert.equal(isValidISODate('2024-02-29'), true); // leap year
  assert.equal(isValidISODate('2026-02-29'), false); // not a leap year
  assert.equal(isValidISODate('2026-13-01'), false);
  assert.equal(isValidISODate('2026-04-31'), false);
  assert.equal(isValidISODate('2026-1-01'), false);
  assert.equal(isValidISODate('2026-10-15T09:00:00Z'), false);
  assert.equal(isValidISODate(''), false);
});

test('isoToUTC throws on invalid input and fromISODate gives UTC midnight', () => {
  assert.throws(() => isoToUTC('nope'), RangeError);
  assert.equal(fromISODate('2026-10-15').toISOString(), '2026-10-15T00:00:00.000Z');
});

test('addDays crosses DST changes, month ends and year ends without drift', () => {
  // Europe/London clocks go back on 25 Oct 2026 and forward on 29 Mar 2026
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2026-10-15', 0), '2026-10-15');
  assert.equal(addDays('2026-10-15', 365), '2027-10-15');
});

test('addMonths clamps to the end of shorter months', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-10-15', -12), '2025-10-15');
});

test('daysBetween is signed and DST-safe', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-15'), 14);
  assert.equal(daysBetween('2026-10-15', '2026-10-01'), -14);
  assert.equal(daysBetween('2026-10-15', '2026-10-15'), 0);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
});

test('day of week helpers', () => {
  assert.equal(dayOfWeek('2026-10-15'), 4); // Thursday
  assert.equal(dayOfWeek('2026-10-18'), 0); // Sunday
  assert.equal(isoWeekday('2026-10-18'), 7);
  assert.equal(isoWeekday('2026-10-12'), 1);
});

test('startOfWeekISO / endOfWeekISO use Monday–Sunday weeks', () => {
  assert.equal(startOfWeekISO('2026-10-15'), '2026-10-12'); // Thursday → Monday
  assert.equal(startOfWeekISO('2026-10-12'), '2026-10-12'); // Monday stays
  assert.equal(startOfWeekISO('2026-10-18'), '2026-10-12'); // Sunday → previous Monday
  assert.equal(endOfWeekISO('2026-10-15'), '2026-10-18');
  assert.equal(endOfWeekISO('2026-10-12'), '2026-10-18');
  assert.equal(startOfWeekISO('2027-01-01'), '2026-12-28'); // crosses the year
});

test('month and quarter boundaries', () => {
  assert.equal(startOfMonthISO('2026-10-15'), '2026-10-01');
  assert.equal(endOfMonthISO('2026-10-15'), '2026-10-31');
  assert.equal(endOfMonthISO('2024-02-10'), '2024-02-29');
  assert.equal(endOfMonthISO('2026-02-10'), '2026-02-28');
  assert.equal(quarterOf('2026-02-10'), 1);
  assert.equal(quarterOf('2026-10-15'), 4);
  assert.equal(startOfQuarterISO('2026-05-20'), '2026-04-01');
  assert.equal(endOfQuarterISO('2026-05-20'), '2026-06-30');
  assert.equal(endOfQuarterISO('2026-12-01'), '2026-12-31');
});

test('rangeFor returns calendar periods containing today', () => {
  assert.deepEqual(rangeFor('week', '2026-10-15'), { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(rangeFor('month', '2026-10-15'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(rangeFor('quarter', '2026-10-15'), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(rangeFor('month', '2024-02-10'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(rangeFor('week', '2027-01-01'), { from: '2026-12-28', to: '2027-01-03' });
});

test('previousRange shifts weeks by length and months by whole months', () => {
  assert.deepEqual(previousRange({ from: '2026-10-12', to: '2026-10-18' }), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(previousRange({ from: '2026-10-01', to: '2026-10-31' }), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(previousRange({ from: '2024-03-01', to: '2024-03-31' }), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(previousRange({ from: '2026-10-01', to: '2026-12-31' }), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(previousRange({ from: '2026-01-01', to: '2026-03-31' }), { from: '2025-10-01', to: '2025-12-31' });
  // arbitrary 10-day window shifts by 10 days
  assert.deepEqual(previousRange({ from: '2026-10-11', to: '2026-10-20' }), { from: '2026-10-01', to: '2026-10-10' });
  // a single day
  assert.deepEqual(previousRange({ from: '2026-10-15', to: '2026-10-15' }), { from: '2026-10-14', to: '2026-10-14' });
});

test('eachDay is inclusive and empty when reversed', () => {
  assert.deepEqual(eachDay('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(eachDay('2026-10-15', '2026-10-15'), ['2026-10-15']);
  assert.deepEqual(eachDay('2026-10-16', '2026-10-15'), []);
  assert.equal(eachDay('2026-10-01', '2026-10-31').length, 31);
});

test('eachWeek lists the Monday of every overlapping week', () => {
  assert.deepEqual(eachWeek('2026-10-01', '2026-10-31'), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  assert.deepEqual(eachWeek('2026-10-12', '2026-10-18'), ['2026-10-12']);
  assert.deepEqual(eachWeek('2026-10-16', '2026-10-15'), []);
});

test('ISO week numbers follow ISO-8601 (week 1 holds 4 January)', () => {
  assert.deepEqual(isoWeek('2026-10-15'), { year: 2026, week: 42 });
  assert.equal(isoWeekLabel('2026-10-15'), 'W42');
  assert.deepEqual(isoWeek('2026-01-01'), { year: 2026, week: 1 }); // Thursday
  assert.deepEqual(isoWeek('2027-01-01'), { year: 2026, week: 53 }); // 2026 has 53 ISO weeks
  assert.deepEqual(isoWeek('2024-12-30'), { year: 2025, week: 1 }); // Monday belongs to next ISO year
  assert.deepEqual(isoWeek('2021-01-03'), { year: 2020, week: 53 });
  assert.equal(isoWeekLabel('2026-01-05'), 'W2');
});

test('toISODate uses the local calendar day; toISODateUTC uses UTC', () => {
  assert.equal(toISODate(new Date(2026, 9, 15, 23, 59)), '2026-10-15');
  assert.equal(toISODate(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
  assert.equal(toISODateUTC(new Date(Date.UTC(2026, 9, 15, 23, 59))), '2026-10-15');
  assert.equal(todayISO(new Date(2026, 9, 15, 12)), '2026-10-15');
  assert.equal(dateOnly('2026-10-15T09:30:00.000Z'), '2026-10-15');
  assert.equal(dateOnly('2026-10-15'), '2026-10-15');
});

test('misc helpers', () => {
  assert.equal(monthKey('2026-10-15'), '2026-10');
  assert.equal(isWithin('2026-10-15', '2026-10-01', '2026-10-31'), true);
  assert.equal(isWithin('2026-11-01', '2026-10-01', '2026-10-31'), false);
  assert.equal(clampISO('2026-09-01', '2026-10-01', '2026-10-31'), '2026-10-01');
  assert.equal(clampISO('2026-12-01', '2026-10-01', '2026-10-31'), '2026-10-31');
  assert.equal(clampISO('2026-10-15', '2026-10-01', '2026-10-31'), '2026-10-15');
  assert.equal(minISO('2026-10-01', '2026-09-30'), '2026-09-30');
  assert.equal(maxISO('2026-10-01', '2026-09-30'), '2026-10-01');
});
