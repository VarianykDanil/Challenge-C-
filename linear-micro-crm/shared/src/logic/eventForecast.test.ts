import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_FORECAST_RULES,
  EVENT_ROSTER_LOOKBACK_DAYS,
  eventForecastFrom,
  inRosterWindow,
  liveFlag,
  pickRate,
  remainingFraction,
  repsNeededFor,
  scheduledFlag,
  suggestedTargetFrom,
  type EventForecastInput,
  type RateBucket,
} from './eventForecast.ts';

const bucket = (basis: RateBucket['basis'], events: number, sales: number, repDays: number): RateBucket => ({ basis, events, sales, repDays });

/** E = expectedReps × sales ÷ repDays: 4 reps × (40 ÷ 10) = 16 by default. */
function input(over: Partial<EventForecastInput> = {}): EventForecastInput {
  return {
    expectedReps: 4,
    bucket: bucket('team', 8, 40, 10),
    targetSales: 16,
    status: 'scheduled',
    startTime: '10:00',
    endTime: '18:00',
    nowHHMM: '09:00',
    salesSoFar: 0,
    teamEventSales: [],
    ...over,
  };
}

test('rules are the agreed constants', () => {
  assert.deepEqual({ ...EVENT_FORECAST_RULES }, { attendanceWeeks: 8, rateWeeks: 12, minBasisDays: 5, z: 1.64, stretch: 1.3, atRisk: 0.7, targetPercentile: 0.6 });
});

test('pickRate: fallback chain team → company → campaign, ≥ 5 distinct events', () => {
  const team4 = bucket('team', 4, 30, 20);
  const company = bucket('company', 12, 90, 40);
  const campaign = bucket('campaign', 30, 200, 100);
  // a team bucket with 4 events falls to company
  assert.equal(pickRate({ team: team4, company, campaign }), company);
  // a team bucket with exactly 5 events is used
  const team5 = bucket('team', 5, 30, 20);
  assert.equal(pickRate({ team: team5, company, campaign }), team5);
  // an empty company bucket falls to campaign (whether empty, null or missing)
  assert.equal(pickRate({ team: team4, company: bucket('company', 0, 0, 0), campaign }), campaign);
  assert.equal(pickRate({ team: null, company: null, campaign }), campaign);
  assert.equal(pickRate({ campaign }), campaign);
  // nothing at all → null
  assert.equal(pickRate({}), null);
  assert.equal(pickRate({ team: team4, company: bucket('company', 3, 9, 9), campaign: bucket('campaign', 4, 9, 9) }), null);
  // a bucket with events but no rep-days cannot give a rate
  assert.equal(pickRate({ team: bucket('team', 6, 0, 0) }), null);
});

test('eventForecastFrom: null without a bucket or without expectedReps', () => {
  assert.equal(eventForecastFrom(input({ bucket: null })), null);
  assert.equal(eventForecastFrom(input({ expectedReps: null })), null);
  assert.equal(eventForecastFrom(input({ expectedReps: 0 })), null);
  assert.equal(eventForecastFrom(input({ bucket: bucket('team', 6, 10, 0) })), null);
});

test('E = 16 → low 9.4, high 22.6 (E ± 1.64√E, one decimal place)', () => {
  const f = eventForecastFrom(input())!;
  assert.equal(f.expectedSales, 16);
  assert.equal(f.low, 9.4);
  assert.equal(f.high, 22.6);
  assert.equal(f.expectedReps, 4);
  assert.equal(f.perRepRate, 4);
  assert.equal(f.basis, 'team');
  assert.equal(f.basisDays, 8);
  assert.equal(f.flag, null, 'target 16 against E = 16 is not a stretch');
  assert.equal(f.repsNeeded, 4, 'ceil(16 ÷ 4)');
  // the low end never goes below zero
  const tiny = eventForecastFrom(input({ expectedReps: 1, bucket: bucket('campaign', 9, 1, 10) }))!;
  assert.equal(tiny.expectedSales, 0.1);
  assert.equal(tiny.low, 0);
  assert.equal(tiny.high, 0.6);
});

test("target 21 against E = 16 → 'stretch' (21 > 1.3 × 16 = 20.8); 20 is not", () => {
  assert.equal(eventForecastFrom(input({ targetSales: 21 }))!.flag, 'stretch');
  assert.equal(eventForecastFrom(input({ targetSales: 20 }))!.flag, null);
  assert.equal(scheduledFlag(21, 16), 'stretch');
  assert.equal(scheduledFlag(20.8, 16), null, 'strictly above 1.3E');
  // reps needed for the stretch target: ceil(21 ÷ 4)
  assert.equal(eventForecastFrom(input({ targetSales: 21 }))!.repsNeeded, 6);
});

test("a live event with 2 sales at 3/4 elapsed and E = 8 against target 14 → 'at_risk'", () => {
  // 10:00–18:00, now 16:00 → a quarter of the day left: 2 + 8 × 0.25 = 4 < 0.7 × 14 = 9.8
  const live = input({ status: 'live', expectedReps: 2, targetSales: 14, salesSoFar: 2, nowHHMM: '16:00' });
  const f = eventForecastFrom(live)!;
  assert.equal(f.expectedSales, 8);
  assert.equal(f.flag, 'at_risk');
  // a live event is never a 'stretch', however high the target
  assert.equal(eventForecastFrom({ ...live, salesSoFar: 9, targetSales: 14 })!.flag, null, '9 + 2 = 11 ≥ 9.8');
  // early in the day the whole E still counts: 0 + 8 × 1 = 8 < 9.8 → behind; with target 11 (7.7) it is not
  assert.equal(eventForecastFrom({ ...live, salesSoFar: 0, nowHHMM: '09:30' })!.flag, 'at_risk');
  assert.equal(eventForecastFrom({ ...live, salesSoFar: 0, nowHHMM: '09:30', targetSales: 11 })!.flag, null);
  // after the end only the sales in count
  assert.equal(liveFlag(14, 8, 10, remainingFraction('10:00', '18:00', '19:00')), null, '10 ≥ 9.8');
  assert.equal(liveFlag(14, 8, 9, remainingFraction('10:00', '18:00', '19:00')), 'at_risk');
});

test('completed and cancelled inputs carry no flag', () => {
  assert.equal(eventForecastFrom(input({ status: 'completed', targetSales: 40 }))!.flag, null);
  assert.equal(eventForecastFrom(input({ status: 'cancelled', targetSales: 40 }))!.flag, null);
});

test('remainingFraction clamps to [0, 1] and survives bad windows', () => {
  assert.equal(remainingFraction('10:00', '18:00', '16:00'), 0.25);
  assert.equal(remainingFraction('10:00', '18:00', '08:00'), 1);
  assert.equal(remainingFraction('10:00', '18:00', '18:30'), 0);
  assert.equal(remainingFraction('10:00', '10:00', '10:00'), 0);
  assert.equal(remainingFraction('bad', '18:00', '10:00'), 0);
});

test('repsNeeded = ceil(target ÷ perRepRate); null without a rate', () => {
  assert.equal(repsNeededFor(17, 2.5), 7);
  assert.equal(repsNeededFor(15, 2.5), 6, 'exact division does not round up');
  assert.equal(repsNeededFor(0, 2.5), 0);
  assert.equal(repsNeededFor(10, 0), null);
  // floating-point: 7 reps at 17/7 a day make exactly 17
  assert.equal(repsNeededFor(17, 17 / 7), 7);
});

test('suggestedTarget = round(p60) of the team’s event sales with ≥ 5 events, else round(E)', () => {
  // [8, 10, 12, 14, 20]: p60 (type 7) = 12 + 0.4 × (14 − 12) = 12.8 → 13
  assert.equal(suggestedTargetFrom([20, 8, 14, 10, 12], 16), 13);
  assert.equal(eventForecastFrom(input({ teamEventSales: [20, 8, 14, 10, 12] }))!.suggestedTarget, 13);
  // 4 events are not enough: round(E)
  assert.equal(eventForecastFrom(input({ teamEventSales: [20, 8, 14, 10] }))!.suggestedTarget, 16);
  assert.equal(eventForecastFrom(input({ expectedReps: 3, teamEventSales: [] }))!.suggestedTarget, 12, 'round(3 × 4)');
  assert.equal(suggestedTargetFrom([], 13.5), 14);
  assert.equal(suggestedTargetFrom([], 0.2), 0);
});

test('deterministic: the same input gives the same forecast', () => {
  const a = eventForecastFrom(input({ status: 'live', salesSoFar: 3, nowHHMM: '12:00', teamEventSales: [5, 9, 11, 7, 13, 6] }));
  const b = eventForecastFrom(input({ status: 'live', salesSoFar: 3, nowHHMM: '12:00', teamEventSales: [5, 9, 11, 7, 13, 6] }));
  assert.deepEqual(a, b);
});

test("'N / M logged' window: completed or live events dated today − 2 … today", () => {
  const today = '2026-10-19';
  assert.equal(EVENT_ROSTER_LOOKBACK_DAYS, 2);
  assert.equal(inRosterWindow({ status: 'live', date: today }, today), true);
  assert.equal(inRosterWindow({ status: 'completed', date: today }, today), true);
  assert.equal(inRosterWindow({ status: 'completed', date: '2026-10-17' }, today), true, 'two days back (across a month or year end too)');
  assert.equal(inRosterWindow({ status: 'completed', date: '2026-10-16' }, today), false, 'three days back is history');
  assert.equal(inRosterWindow({ status: 'completed', date: '2026-12-30' }, '2027-01-01'), true);
  assert.equal(inRosterWindow({ status: 'scheduled', date: today }, today), false, 'nothing to log before it starts');
  assert.equal(inRosterWindow({ status: 'cancelled', date: today }, today), false);
  assert.equal(inRosterWindow({ status: 'live', date: '2026-10-20' }, today), false, 'never a future day');
});
