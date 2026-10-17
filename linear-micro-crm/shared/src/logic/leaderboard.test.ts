import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movement, rankOf, rankRows, topN } from './leaderboard.ts';

const rows = [
  { name: 'Ava', sales: 5, stops: 50 },
  { name: 'Ben', sales: 7, stops: 90 },
  { name: 'Cal', sales: 5, stops: 40 },
  { name: 'Dee', sales: 1, stops: 10 },
];

test('rankRows sorts descending with competition ranks and a stable tie order', () => {
  const ranked = rankRows(rows, 'sales');
  assert.deepEqual(
    ranked.map((r) => [r.name, r.rank]),
    [
      ['Ben', 1],
      ['Ava', 2],
      ['Cal', 2],
      ['Dee', 4],
    ],
  );
});

test('rankRows accepts an accessor, ascending order and a tie-break metric', () => {
  const byConversion = rankRows(rows, (r) => r.sales / r.stops);
  assert.equal(byConversion[0].name, 'Cal'); // 0.125
  assert.equal(byConversion[1].name, 'Ava'); // 0.10 (also Dee at 0.10 — Ava came first in the input)
  assert.equal(byConversion[1].rank, 2);
  assert.equal(byConversion[2].name, 'Dee');
  assert.equal(byConversion[2].rank, 2);
  assert.equal(byConversion[3].name, 'Ben');
  assert.equal(byConversion[3].rank, 4);

  const asc = rankRows(rows, 'sales', { direction: 'asc' });
  assert.equal(asc[0].name, 'Dee');
  assert.equal(asc[0].rank, 1);

  // tie on sales: the tie-break (fewer stops = more efficient) decides the ORDER, but both still share rank 2
  const tie = rankRows(rows, 'sales', { tieBreak: (r) => -r.stops });
  assert.deepEqual(
    tie.map((r) => [r.name, r.rank]),
    [
      ['Ben', 1],
      ['Cal', 2],
      ['Ava', 2],
      ['Dee', 4],
    ],
  );
});

test('rankRows does not mutate its input and handles empty and non-numeric values', () => {
  const copy = rows.map((r) => ({ ...r }));
  rankRows(copy, 'sales');
  assert.deepEqual(copy, rows);
  assert.ok(!('rank' in copy[0]));
  assert.deepEqual(rankRows([], 'sales'), []);
  const odd = rankRows([{ v: Number.NaN }, { v: 3 }, { v: undefined as unknown as number }], 'v');
  assert.equal(odd[0].v, 3);
  assert.equal(odd[0].rank, 1);
  assert.equal(odd[1].rank, 2);
  assert.equal(odd[2].rank, 2);
});

test('movement is previous minus current; null for new entrants', () => {
  assert.equal(movement(5, 2), 3);
  assert.equal(movement(2, 5), -3);
  assert.equal(movement(3, 3), 0);
  assert.equal(movement(null, 1), null);
  assert.equal(movement(undefined, 1), null);
  assert.equal(movement(Number.NaN, 1), null);
});

test('topN and rankOf', () => {
  const ranked = rankRows(rows, 'sales');
  assert.deepEqual(topN(ranked, 2).map((r) => r.name), ['Ben', 'Ava']);
  assert.deepEqual(topN(ranked, 0), []);
  assert.deepEqual(topN(ranked, 10).length, 4);
  assert.equal(rankOf(ranked, (r) => r.name === 'Cal'), 2);
  assert.equal(rankOf(ranked, (r) => r.name === 'Zed'), null);
});
