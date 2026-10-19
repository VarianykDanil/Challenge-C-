import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateStage, Interview } from '../types.ts';
import {
  OUTCOME_LOOKBACK_DAYS,
  OUTCOME_PROMPT_HOURS,
  STAGE_SLA_DAYS,
  avg,
  businessDateOf,
  candidateIdleDays,
  compareLongestIdle,
  daysPastTarget,
  daysInPipeline,
  defaultNextActionAt,
  hireRate,
  isIdle,
  isOpenStage,
  isOverdue,
  isTerminalStage,
  needsOutcome,
  outcomeLookbackFrom,
  nextStage,
  outcomesToRecord,
  previousStage,
  stageConversion,
  stageIndex,
  stageSlaDays,
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

// ── Stage SLAs (p8) ──

test('STAGE_SLA_DAYS covers every open stage and nothing else', () => {
  assert.deepEqual(STAGE_SLA_DAYS, { applied: 3, screening: 5, interview: 7, observation: 7, offer: 7 });
  for (const s of ['hired', 'rejected', 'withdrawn'] as const) assert.equal(stageSlaDays(s), null, s);
  assert.equal(stageSlaDays('screening'), 5);
});

test('defaultNextActionAt is today + the stage SLA as a date-only deadline; terminal stages get none', () => {
  assert.equal(defaultNextActionAt('screening', '2026-10-19'), '2026-10-24');
  assert.equal(defaultNextActionAt('applied', '2026-10-19'), '2026-10-22');
  assert.equal(defaultNextActionAt('interview', '2026-10-19'), '2026-10-26');
  assert.equal(defaultNextActionAt('observation', '2026-12-28'), '2027-01-04'); // across the new year
  assert.equal(defaultNextActionAt('offer', '2026-10-22'), '2026-10-29'); // across the BST → GMT change (25 Oct)
  assert.equal(defaultNextActionAt('applied', '2026-10-19T15:00:00'), '2026-10-22'); // a timestamp keeps its own day
  for (const s of ['hired', 'rejected', 'withdrawn'] as const) assert.equal(defaultNextActionAt(s, '2026-10-19'), null, s);
  // the default is due on its last day and overdue from the next one (the shared isOverdue rule)
  assert.equal(isOverdue(defaultNextActionAt('screening', '2026-10-19'), '2026-10-24'), false);
  assert.equal(isOverdue(defaultNextActionAt('screening', '2026-10-19'), '2026-10-25'), true);
});

test('businessDateOf reads instants on the Europe/London calendar, whatever the machine zone', () => {
  assert.equal(businessDateOf('2026-10-13T23:30:00.000Z'), '2026-10-14'); // 00:30 BST
  assert.equal(businessDateOf('2026-12-01T23:30:00.000Z'), '2026-12-01'); // 23:30 GMT
  assert.equal(businessDateOf(new Date('2026-03-29T00:30:00Z')), '2026-03-29'); // the night the clocks go forward
  assert.equal(businessDateOf('2026-10-14'), '2026-10-14'); // a date is already a business date
  assert.equal(businessDateOf('2026-10-14T23:30:00'), '2026-10-14'); // naive = London wall clock
  assert.equal(businessDateOf('2026-10-14T23:30:00+05:00'), '2026-10-14'); // 19:30 BST
  assert.equal(businessDateOf('garbage'), null);
  assert.equal(businessDateOf('2026-02-31'), null);
});

const screening = (stageUpdatedAt: string) => ({ stage: 'screening' as CandidateStage, stageUpdatedAt });

test('isIdle is false at exactly the SLA day count and true one day later', () => {
  const c = screening('2026-10-14T09:00:00.000Z'); // Wed 14 Oct, 5-day target
  assert.equal(candidateIdleDays(c, '2026-10-14T18:00:00Z'), 0);
  assert.equal(candidateIdleDays(c, '2026-10-19T12:00:00Z'), 5);
  assert.equal(isIdle(c, '2026-10-19T12:00:00Z'), false); // exactly 5 days: still on target
  assert.equal(isIdle(c, '2026-10-19T22:59:59Z'), false); // 23:59 BST is still the 19th
  assert.equal(candidateIdleDays(c, '2026-10-20T08:00:00Z'), 6);
  assert.equal(isIdle(c, '2026-10-20T08:00:00Z'), true);
  assert.equal(isIdle(c, new Date('2026-10-19T23:00:00Z')), true); // 00:00 BST on the 20th
  // every open stage uses its own target
  for (const stage of ['applied', 'screening', 'interview', 'observation', 'offer'] as const) {
    const sla = STAGE_SLA_DAYS[stage];
    const moved = { stage, stageUpdatedAt: '2026-11-02T10:00:00.000Z' };
    const at = (days: number) => `2026-11-${String(2 + days).padStart(2, '0')}`;
    assert.equal(isIdle(moved, at(sla)), false, `${stage} at ${sla}`);
    assert.equal(isIdle(moved, at(sla + 1)), true, `${stage} at ${sla + 1}`);
  }
});

test('idle days count Europe/London calendar days, not 24-hour blocks', () => {
  // moved at 23:30 GMT on 1 Dec; 00:30 GMT on 3 Dec is two calendar days later although only 25 hours passed
  const c = { stage: 'applied' as CandidateStage, stageUpdatedAt: '2026-12-01T23:30:00.000Z' };
  assert.equal(candidateIdleDays(c, new Date('2026-12-03T00:30:00Z')), 2);
  // moved at 23:30 UTC on 13 Oct = 00:30 BST on the 14th, so the count starts on the 14th
  assert.equal(candidateIdleDays(screening('2026-10-13T23:30:00.000Z'), '2026-10-14T12:00:00Z'), 0);
  // a clock running behind the stage change never gives a negative count
  assert.equal(candidateIdleDays(screening('2026-10-20T09:00:00.000Z'), '2026-10-19'), 0);
});

test('the idle counter restarts after a stage change', () => {
  const now = '2026-10-30T12:00:00Z';
  const before = screening('2026-10-14T09:00:00.000Z');
  assert.equal(candidateIdleDays(before, now), 16);
  assert.equal(isIdle(before, now), true);
  const after = { stage: 'interview' as CandidateStage, stageUpdatedAt: '2026-10-30T11:59:00.000Z' };
  assert.equal(candidateIdleDays(after, now), 0);
  assert.equal(isIdle(after, now), false);
});

test('terminal stages have no idle count and are never idle', () => {
  for (const stage of ['hired', 'rejected', 'withdrawn'] as const) {
    const c = { stage, stageUpdatedAt: '2025-01-01T09:00:00.000Z' };
    assert.equal(candidateIdleDays(c, '2026-10-19'), null, stage);
    assert.equal(isIdle(c, '2026-10-19'), false, stage);
  }
  assert.equal(candidateIdleDays(screening('not a date'), '2026-10-19'), null);
  assert.equal(isIdle(screening('not a date'), '2026-10-19'), false);
});

test('daysPastTarget: idle days minus the stage target; null for closed stages', () => {
  const now = '2026-10-19T12:00:00Z';
  assert.equal(daysPastTarget({ stage: 'applied', stageUpdatedAt: '2026-10-14T09:00:00Z' }, now), 2); // 5 days, target 3
  assert.equal(daysPastTarget({ stage: 'interview', stageUpdatedAt: '2026-10-14T09:00:00Z' }, now), -2); // 5 days, target 7
  assert.equal(daysPastTarget({ stage: 'screening', stageUpdatedAt: '2026-10-14T09:00:00Z' }, now), 0); // exactly on target
  assert.equal(daysPastTarget({ stage: 'hired', stageUpdatedAt: '2026-10-14T09:00:00Z' }, now), null);
  assert.equal(daysPastTarget({ stage: 'offer', stageUpdatedAt: 'nope' }, now), null);
});

test('compareLongestIdle: every idle candidate first (furthest past target first), then on-target ones, closed last', () => {
  const now = '2026-10-19T12:00:00Z';
  const c = (id: number, stage: CandidateStage, stageUpdatedAt: string) => ({ id, stage, stageUpdatedAt });
  // The review case: an Interview candidate 5 days in (target 7, on target) used to sit above an Applied candidate
  // 5 days in (target 3, idle 2 days past) because both moved on the same day.
  const fatima = c(1, 'interview', '2026-10-14T08:00:00Z'); // 5 days, −2
  const joel = c(2, 'applied', '2026-10-14T10:00:00Z'); // 5 days, +2 → idle
  const longInterview = c(3, 'interview', '2026-10-07T09:00:00Z'); // 12 days, +5 → idle
  const longScreening = c(4, 'screening', '2026-09-27T09:00:00Z'); // 22 days, +17 → idle
  const freshOffer = c(5, 'offer', '2026-10-19T09:00:00Z'); // 0 days, −7
  const onTargetApplied = c(6, 'applied', '2026-10-16T09:00:00Z'); // 3 days, 0 (exactly on target)
  const hired = c(7, 'hired', '2026-01-01T09:00:00Z');
  const unreadable = c(8, 'screening', 'nope');
  const sorted = [hired, freshOffer, fatima, unreadable, joel, onTargetApplied, longInterview, longScreening].sort((a, b) => compareLongestIdle(a, b, now));
  // idle (+17, +5, +2) → on target (0, −2, −7) → no count (closed, then the unreadable date: both null, readable date first)
  assert.deepEqual(sorted.map((x) => x.id), [4, 3, 2, 6, 1, 5, 7, 8]);
  const idleFlags = sorted.map((x) => isIdle(x, now));
  assert.deepEqual(idleFlags.slice(0, 3), [true, true, true]);
  assert.ok(idleFlags.slice(3).every((f) => !f), 'nobody idle after the first on-target candidate');
});

test('compareLongestIdle ties: longer in the stage first, then by id; deterministic', () => {
  const now = '2026-10-19T12:00:00Z';
  const a = { id: 9, stage: 'interview' as CandidateStage, stageUpdatedAt: '2026-10-07T15:00:00Z' }; // 12 days, +5
  const b = { id: 3, stage: 'interview' as CandidateStage, stageUpdatedAt: '2026-10-07T08:00:00Z' }; // same day, earlier
  const c = { id: 1, stage: 'screening' as CandidateStage, stageUpdatedAt: '2026-10-09T08:00:00Z' }; // 10 days, +5
  const d = { id: 2, stage: 'screening' as CandidateStage, stageUpdatedAt: '2026-10-09T08:00:00Z' }; // identical to c
  const order = (xs: typeof a[]) => [...xs].sort((x, y) => compareLongestIdle(x, y, now)).map((x) => x.id);
  // all four are +5 past target: longer in the stage first (b, a: 12 days), then c and d (10 days) by id
  assert.deepEqual(order([a, b, c, d]), [3, 9, 1, 2]);
  assert.deepEqual(order([d, c, b, a]), [3, 9, 1, 2]);
  assert.equal(compareLongestIdle(c, c, now), 0);
});

const iv = (over: Partial<Interview> & Pick<Interview, 'id' | 'scheduledAt'>): Interview => ({
  candidateId: 1,
  type: 'first',
  interviewerId: null,
  outcome: 'pending',
  notes: null,
  ...over,
});

test('needsOutcome: pending and at least two hours past', () => {
  const now = '2026-10-19T15:00:00.000Z';
  assert.equal(OUTCOME_PROMPT_HOURS, 2);
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-19T12:00:00.000Z' }), now), true); // 3 h ago
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-19T13:00:00.000Z' }), now), true); // exactly 2 h
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-19T13:00:01.000Z' }), now), false); // not yet
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-20T10:00:00.000Z' }), now), false); // future
  for (const outcome of ['passed', 'failed', 'no_show'] as const) {
    assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-12T10:00:00.000Z', outcome }), now), false, outcome);
  }
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: 'garbage' }), now), false);
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-19T12:00:00.000Z' }), new Date('2026-10-19T15:00:00Z')), true);
});

test('outcomesToRecord: interviewer or candidate owner is me, admin sees all; oldest first', () => {
  const now = '2026-10-19T15:00:00.000Z';
  const owners = new Map<number, number | null>([[10, 7], [11, 8], [12, null]]);
  const list = [
    iv({ id: 5, candidateId: 11, interviewerId: 7, scheduledAt: '2026-10-19T11:00:00.000Z' }), // I interviewed
    iv({ id: 4, candidateId: 10, interviewerId: 9, scheduledAt: '2026-10-16T10:00:00.000Z' }), // I own the candidate
    iv({ id: 3, candidateId: 11, interviewerId: 9, scheduledAt: '2026-10-15T10:00:00.000Z' }), // someone else's
    iv({ id: 2, candidateId: 12, interviewerId: null, scheduledAt: '2026-10-14T10:00:00.000Z' }), // unowned, nobody interviewing
    iv({ id: 1, candidateId: 99, interviewerId: 9, scheduledAt: '2026-10-13T10:00:00.000Z' }), // a candidate the caller did not load
    iv({ id: 6, candidateId: 10, interviewerId: 7, scheduledAt: '2026-10-19T14:00:00.000Z' }), // only an hour ago
    iv({ id: 7, candidateId: 10, interviewerId: 7, scheduledAt: '2026-10-16T09:00:00.000Z', outcome: 'passed' }),
  ];
  const ownerOf = (id: number) => owners.get(id);
  assert.deepEqual(outcomesToRecord(list, { id: 7, role: 'recruiter' }, ownerOf, now).map((x) => x.id), [4, 5]);
  assert.deepEqual(outcomesToRecord(list, { id: 7, role: 'leader' }, ownerOf, now).map((x) => x.id), [4, 5]);
  assert.deepEqual(outcomesToRecord(list, { id: 1, role: 'admin' }, ownerOf, now).map((x) => x.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(outcomesToRecord([], { id: 7, role: 'recruiter' }, ownerOf, now), []);
});

test('needsOutcome: the one rule also stops asking after the 56-day look-back', () => {
  const now = '2026-10-19T15:00:00.000Z';
  assert.equal(OUTCOME_LOOKBACK_DAYS, 56);
  assert.equal(outcomeLookbackFrom(now), '2026-08-24T15:00:00.000Z');
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-10-14T09:00:00.000Z' }), now), true, '5 days ago');
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-08-24T15:00:00.000Z' }), now), true, 'exactly 56 days');
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-08-24T14:59:59.000Z' }), now), false, 'just over 56 days');
  assert.equal(needsOutcome(iv({ id: 1, scheduledAt: '2026-08-20T09:00:00.000Z' }), now), false, '60 days ago');
});

test('outcomesToRecord: an interview carrying a closed candidate stage never asks; without the stage it is not filtered', () => {
  const now = '2026-10-19T15:00:00.000Z';
  const base = iv({ id: 1, candidateId: 10, interviewerId: 7, scheduledAt: '2026-10-19T11:00:00.000Z' });
  const me = { id: 7, role: 'recruiter' as const };
  const ownerOf = () => null;
  for (const stage of ['hired', 'rejected', 'withdrawn'] as const) {
    assert.deepEqual(outcomesToRecord([{ ...base, candidateStage: stage }], me, ownerOf, now), [], stage);
  }
  assert.deepEqual(outcomesToRecord([{ ...base, candidateStage: 'interview' as const }], me, ownerOf, now).map((x) => x.id), [1]);
  assert.deepEqual(outcomesToRecord([base], me, ownerOf, now).map((x) => x.id), [1]);
  assert.deepEqual(outcomesToRecord([{ ...base, scheduledAt: '2026-08-20T09:00:00.000Z' }], me, ownerOf, now), [], 'past the look-back');
});
