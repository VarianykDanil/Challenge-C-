import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalBestWeek, salesStreaks, type SalesDay } from './streaks.ts';

const TODAY = '2026-10-15'; // a Thursday
const d = (date: string, sales: number): SalesDay => ({ date, sales });

test('no worked days → current 0, best 0', () => {
  assert.deepEqual(salesStreaks([], TODAY), { current: 0, best: 0 });
});

test('a worked day with no sales resets the run; the best survives', () => {
  const days = [d('2026-10-05', 2), d('2026-10-06', 1), d('2026-10-07', 3), d('2026-10-08', 0), d('2026-10-09', 1), d('2026-10-12', 4)];
  assert.deepEqual(salesStreaks(days, TODAY), { current: 2, best: 3 });
  // the last worked day before today had no sale → current 0, best kept
  assert.deepEqual(salesStreaks([...days, d('2026-10-14', 0)], TODAY), { current: 0, best: 3 });
});

test('calendar days without gauges (weekends, a week off) never break a streak', () => {
  const days = [d('2026-09-25', 1), d('2026-09-28', 2), d('2026-10-09', 1), d('2026-10-13', 1)];
  assert.deepEqual(salesStreaks(days, TODAY), { current: 4, best: 4 });
});

test('rows dated today (or later) are ignored: today is not over yet', () => {
  const days = [d('2026-10-13', 1), d('2026-10-14', 2)];
  assert.deepEqual(salesStreaks([...days, d(TODAY, 0)], TODAY), { current: 2, best: 2 }, 'a slow morning does not reset it');
  assert.deepEqual(salesStreaks([...days, d(TODAY, 5)], TODAY), { current: 2, best: 2 }, 'nor does a good one extend it yet');
  assert.deepEqual(salesStreaks([...days, d('2026-10-20', 3)], TODAY), { current: 2, best: 2 });
});

test('order does not matter and two rows on one date are one worked day', () => {
  const days = [d('2026-10-14', 0), d('2026-10-12', 1), d('2026-10-13', 1), d('2026-10-14', 1)];
  assert.deepEqual(salesStreaks(days, TODAY), { current: 3, best: 3 }, '0 + 1 sales on the 14th is a selling day');
});

test('personalBestWeek: beats every previous week with ≥ 3 worked days, and needs 4 of them', () => {
  const full = [
    { days: 5, sales: 10 },
    { days: 4, sales: 12 },
    { days: 3, sales: 11 },
    { days: 5, sales: 9 },
  ];
  assert.equal(personalBestWeek(full, { sales: 13 }), true);
  assert.equal(personalBestWeek(full, { sales: 12 }), false, 'a tie is not a best');
  // a short week (2 days) with more sales does not count against the best
  assert.equal(personalBestWeek([...full, { days: 2, sales: 30 }], { sales: 13 }), true);
  // weeks with < 3 days do not count towards the 4 either
  assert.equal(personalBestWeek([...full.slice(0, 3), { days: 2, sales: 1 }, { days: 0, sales: 0 }], { sales: 50 }), false);
  assert.equal(personalBestWeek([], { sales: 5 }), false);
});
