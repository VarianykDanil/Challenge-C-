import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avg,
  daysInPipeline,
  hireRate,
  isOpenStage,
  isOverdue,
  isTerminalStage,
  nextStage,
  previousStage,
  stageConversion,
  stageIndex,
  timeToHireDays,
} from './recruitment.ts';

test('stageIndex follows the happy path and is −1 for rejected/withdrawn', () => {
  assert.equal(stageIndex('applied'), 0);
  assert.equal(stageIndex('offer'), 4);
  assert.equal(stageIndex('hired'), 5);
  assert.equal(stageIndex('rejected'), -1);
  assert.equal(stageIndex('withdrawn'), -1);
});

test('open vs terminal stages', () => {
  for (const s of ['applied', 'screening', 'interview', 'observation', 'offer'] as const) {
    assert.equal(isOpenStage(s), true, s);
    assert.equal(isTerminalStage(s), false, s);
  }
  for (const s of ['hired', 'rejected', 'withdrawn'] as const) {
    assert.equal(isOpenStage(s), false, s);
    assert.equal(isTerminalStage(s), true, s);
  }
});

test('nextStage / previousStage walk the pipeline and stop at the ends', () => {
  assert.equal(nextStage('applied'), 'screening');
  assert.equal(nextStage('offer'), 'hired');
  assert.equal(nextStage('hired'), null);
  assert.equal(nextStage('rejected'), null);
  assert.equal(nextStage('withdrawn'), null);
  assert.equal(previousStage('screening'), 'applied');
  assert.equal(previousStage('hired'), 'offer');
  assert.equal(previousStage('applied'), null);
  assert.equal(previousStage('rejected'), null);
});

test('stageConversion from funnel rows', () => {
  const conv = stageConversion([
    { stage: 'applied', count: 40 },
    { stage: 'screening', count: 20 },
    { stage: 'interview', count: 10 },
    { stage: 'observation', count: 6 },
    { stage: 'offer', count: 4 },
    { stage: 'hired', count: 3 },
  ]);
  assert.equal(conv.length, 5);
  assert.deepEqual(conv[0], { from: 'applied', to: 'screening', fromCount: 40, toCount: 20, rate: 0.5 });
  assert.equal(conv[1].rate, 0.5);
  assert.equal(conv[2].rate, 0.6);
  assert.ok(Math.abs(conv[3].rate - 4 / 6) < 1e-12);
  assert.equal(conv[4].rate, 0.75);
  assert.equal(conv[4].to, 'hired');
});

test('stageConversion from a record, with missing stages and zero denominators', () => {
  const conv = stageConversion({ applied: 10, screening: 0, hired: 1 });
  assert.equal(conv[0].rate, 0);
  assert.equal(conv[1].fromCount, 0);
  assert.equal(conv[1].rate, 0);
  assert.equal(conv[4].rate, 0); // offer 0 → hired 1 still gives 0, never Infinity
  assert.equal(stageConversion([]).length, 5);
  assert.ok(stageConversion({}).every((c) => c.rate === 0 && c.fromCount === 0));
});

test('hireRate', () => {
  assert.equal(hireRate(40, 3), 0.075);
  assert.equal(hireRate(0, 0), 0);
});

test('timeToHireDays accepts dates and timestamps and is never negative', () => {
  assert.equal(timeToHireDays('2026-09-01', '2026-09-22'), 21);
  assert.equal(timeToHireDays('2026-09-01', '2026-09-01'), 0);
  assert.equal(timeToHireDays('2026-09-22', '2026-09-01'), 0);
  assert.equal(timeToHireDays('2026-09-01T09:00:00Z', '2026-09-22T17:30:00Z'), 21);
  assert.equal(timeToHireDays('2026-09-01T23:00:00Z', '2026-09-02T01:00:00Z'), 0); // 2 hours rounds to 0 days
  assert.equal(timeToHireDays('2026-09-01', '2026-09-02T13:00:00Z'), 2); // 37h rounds to 2
  assert.equal(timeToHireDays('garbage', '2026-09-22'), 0);
});

test('daysInPipeline measures from application to a given day', () => {
  assert.equal(daysInPipeline('2026-09-01', '2026-10-15'), 44);
  assert.equal(daysInPipeline('2026-09-01T10:00:00Z', '2026-09-03'), 2);
  assert.equal(daysInPipeline('2026-09-01', new Date(2026, 8, 11, 12)), 10);
});

test('avg', () => {
  assert.equal(avg([]), 0);
  assert.equal(avg([1, 2, 3]), 2);
  assert.equal(avg([1, 2, 3, Number.NaN, Infinity]), 2);
  assert.equal(avg([5]), 5);
});

test('isOverdue with date-only and timestamp deadlines', () => {
  assert.equal(isOverdue(null, '2026-10-15'), false);
  assert.equal(isOverdue(undefined, '2026-10-15'), false);
  assert.equal(isOverdue('', '2026-10-15'), false);
  assert.equal(isOverdue('2026-10-14', '2026-10-15'), true);
  assert.equal(isOverdue('2026-10-15', '2026-10-15'), false); // due today is not overdue yet
  assert.equal(isOverdue('2026-10-16', '2026-10-15'), false);
  assert.equal(isOverdue('2026-10-15T09:00:00Z', '2026-10-15T09:00:01Z'), true);
  assert.equal(isOverdue('2026-10-15T09:00:00Z', '2026-10-15T09:00:00Z'), false);
  assert.equal(isOverdue('2026-10-15T09:00:00Z', new Date('2026-10-15T08:59:59Z')), false);
  assert.equal(isOverdue('2026-10-14', new Date(2026, 9, 15, 0, 1)), true);
  assert.equal(isOverdue('garbage', '2026-10-15'), false);
});
