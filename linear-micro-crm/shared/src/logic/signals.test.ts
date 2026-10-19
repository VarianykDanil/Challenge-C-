import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckInPerson, CheckInReasonCode, GaugeTotals } from '../types.ts';
import { addDays } from './dates.ts';
import { CHECK_IN_RULES, checkInWeekTotals, personSignals, rankCheckIns, type PersonSignalInput } from './signals.ts';
import type { WeekStat } from './stats.ts';

// Thursday 15 Oct 2026: this Monday is 12 Oct, last week is w/c 5 Oct, the 16 completed weeks start 22 Jun.
const TODAY = '2026-10-15';
const THIS_MONDAY = '2026-10-12';

function week(i: number, stops: number, sales: number, days = 4): WeekStat {
  return { weekStart: addDays(THIS_MONDAY, -7 * (16 - i)), days, stops, table: Math.round(stops * 0.35), presentations: Math.round(stops * 0.17), closes: Math.round(stops * 0.07), taps: Math.max(sales, Math.round(stops * 0.04)), sales };
}

/** 16 weeks; `f(i)` gives [stops, sales, days?] for week i (0 = oldest). */
function weeks(f: (i: number) => [number, number, number?]): WeekStat[] {
  return Array.from({ length: 16 }, (_, i) => {
    const [stops, sales, days] = f(i);
    return week(i, stops, sales, days ?? 4);
  });
}

const STEADY = weeks((i) => [i % 2 ? 248 : 232, 9]); // 58 / 62 stops a day, 9 sales a week (≈ 3.9%)

/** A steady, punctual, present field rep: nothing fires. */
function base(over: Partial<PersonSignalInput> = {}): PersonSignalInput {
  const w = over.weeks16 ?? STEADY;
  return {
    today: TODAY,
    position: 'field_rep',
    startDate: '2025-01-06',
    weeks16: w,
    current: { weekStart: THIS_MONDAY, days: 3, stops: 180, table: 63, presentations: 31, closes: 12, taps: 8, sales: 7 },
    lateMinutes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    teamLateShare: 0.1,
    attendance: { recentWorked: 7, recentTeamDays: 9, priorWorked: 28, priorTeamDays: 36 },
    lastWeek: { workedDays: 4, teamEventDays: 5 },
    weeklyGross: [480, 520, 500, 510, 495, 505, 490, 515],
    last4Weeks: checkInWeekTotals(w.slice(-4)),
    ...over,
  };
}

const codes = (input: PersonSignalInput): CheckInReasonCode[] => personSignals(input).map((r) => r.code);
const textOf = (input: PersonSignalInput, code: CheckInReasonCode) => personSignals(input).find((r) => r.code === code)?.text;

test('the steady baseline fires nothing', () => {
  assert.deepEqual(personSignals(base()), []);
});

test('(a) stops_drop: this week well under the usual stops a day; z just above −1.5 does not fire', () => {
  // usual μ = 60 (58 / 62 alternating), σ = 2.138 → the gate z = −1.5 sits at 56.8 a day
  const fires = base({ current: { ...base().current, days: 3, stops: 168 } }); // 56 a day, z = −1.87
  assert.deepEqual(codes(fires), ['stops_drop']);
  assert.equal(textOf(fires, 'stops_drop'), 'Averaging 56 stops a day this week against a usual 60');
  assert.deepEqual(codes(base({ current: { ...base().current, days: 3, stops: 171 } })), [], '57 a day, z = −1.40');
  assert.deepEqual(codes(base({ current: { ...base().current, days: 1, stops: 20 } })), [], 'one day this week is not enough');
  const quiet = weeks((i) => [i % 2 ? 80 : 76, 3]); // 19–20 a day: μ = 19.5 < 20
  assert.deepEqual(codes(base({ weeks16: quiet, last4Weeks: checkInWeekTotals(quiet.slice(-4)), current: { ...base().current, days: 3, stops: 30 } })), [], 'usual under 20 a day');
  const patchy = weeks((i) => (i >= 8 && i < 13 ? [0, 0, 0] : [i % 2 ? 248 : 232, 9])); // only 3 worked weeks in the last 8
  assert.ok(!codes(base({ weeks16: patchy, current: { ...base().current, stops: 30 } })).includes('stops_drop'), 'fewer than 4 worked weeks');
});

test('(b) conversion_drop: the last two weeks well under the 8 before (binomial z ≤ −2); 150-stop gate', () => {
  // p0 = 9 / 240 = 3.75%; last two weeks 480 stops → expected 18, σ = 4.16
  const at = (lastTwoSales: [number, number], stops = 240) => weeks((i) => (i >= 14 ? [stops, lastTwoSales[i - 14]!] : [240, 9]));
  const fires = base({ weeks16: at([4, 5]) }); // 9 sales: z = −2.16
  assert.deepEqual(codes(fires), ['conversion_drop']);
  assert.equal(textOf(fires, 'conversion_drop'), 'Conversion 1.9% over the last two weeks against a usual 3.8%');
  assert.deepEqual(codes(base({ weeks16: at([5, 5]) })), [], '10 sales: z = −1.92');
  // 150-stop gate: 0 sales in 150 stops fires (z = −2.42); the same in 149 stops does not
  const gate = (s1: number) => weeks((i) => (i === 14 ? [s1, 0, 2] : i === 15 ? [75, 0, 2] : [240, 9]));
  assert.ok(codes(base({ weeks16: gate(75) })).includes('conversion_drop'), '150 stops');
  assert.ok(!codes(base({ weeks16: gate(74) })).includes('conversion_drop'), '149 stops');
});

test('(c) sustained_decline: 8 v 8 weeks, both halves ≥ 400 stops; 399 stops does not fire', () => {
  const series = (firstWeekStops: number) => weeks((i) => (i < 8 ? [i === 0 ? firstWeekStops : 50, 5, 1] : [50, 2, 1])); // 10% → 4%
  const fires = base({ weeks16: series(50), current: { ...base().current, days: 0, stops: 0, sales: 0 } });
  assert.deepEqual(codes(fires), ['sustained_decline']);
  assert.equal(textOf(fires, 'sustained_decline'), 'Conversion 4.0% over the last 8 weeks, down from 10.0% in the 8 before');
  assert.deepEqual(codes(base({ weeks16: series(49), current: { ...base().current, days: 0, stops: 0, sales: 0 } })), [], '399 stops in the earlier half');
});

test('(c) suppresses (b): a long decline is one reason, not two', () => {
  // weeks 0–7 at 5%, 8–13 at 2.5%, the last two at 0.8%: both tests fire on their own
  const declining = weeks((i) => [240, i < 8 ? 12 : i < 14 ? 6 : 2]);
  const both = codes(base({ weeks16: declining, last4Weeks: checkInWeekTotals(declining.slice(-4)) }));
  assert.ok(both.includes('sustained_decline'));
  assert.ok(!both.includes('conversion_drop'));
  // the same last two weeks without the long decline: conversion_drop alone
  const recentOnly = weeks((i) => [240, i < 14 ? 7.5 : 2]);
  assert.deepEqual(codes(base({ weeks16: recentOnly })), ['conversion_drop']);
});

test('(d) late_often: ≥ 3 of the last 10 late and more than twice the team; 2 of 10 or a high team share does not fire', () => {
  // 5 minutes late is inside the grace period; newest first, only the last 10 count
  const three = [12, 5, 30, 0, 8, 0, 0, 0, 0, 0, 40, 40];
  const fires = base({ lateMinutes: three, teamLateShare: 0.1 });
  assert.deepEqual(codes(fires), ['late_often']);
  assert.equal(textOf(fires, 'late_often'), 'Late for 3 of the last 10 check-ins (team: 1 in 10)');
  assert.deepEqual(codes(base({ lateMinutes: [12, 5, 30, 0, 0, 0, 0, 0, 0, 0, 40, 40], teamLateShare: 0.1 })), [], '2 late of 10');
  assert.deepEqual(codes(base({ lateMinutes: three, teamLateShare: 0.15 })), [], '30% is not more than 2 × 15%');
  assert.equal(textOf(base({ lateMinutes: three, teamLateShare: 0 }), 'late_often'), 'Late for 3 of the last 10 check-ins (team: none)');
  assert.equal(textOf(base({ lateMinutes: [9, 9, 9, 0], teamLateShare: 0.14 }), 'late_often'), 'Late for 3 of the last 4 check-ins (team: 1 in 7)');
  assert.deepEqual(codes(base({ lateMinutes: [] })), []);
});

test('(e) attendance_drop: under half the usual share of team days this fortnight; a prior share of 0.4 does not fire', () => {
  const fires = base({ attendance: { recentWorked: 2, recentTeamDays: 9, priorWorked: 28, priorTeamDays: 36 } });
  assert.deepEqual(codes(fires), ['attendance_drop']);
  assert.equal(textOf(fires, 'attendance_drop'), "Worked 2 of the team's 9 event days this fortnight — usually 7 in 9");
  assert.deepEqual(codes(base({ attendance: { recentWorked: 0, recentTeamDays: 9, priorWorked: 12, priorTeamDays: 30 } })), [], 'prior share 0.4');
  assert.deepEqual(codes(base({ attendance: { recentWorked: 0, recentTeamDays: 3, priorWorked: 28, priorTeamDays: 36 } })), [], 'only 3 team days this fortnight');
  assert.deepEqual(codes(base({ attendance: { recentWorked: 4, recentTeamDays: 9, priorWorked: 28, priorTeamDays: 36 } })), [], '4 of 9 is not under half of 7 in 9');
});

test('(f) zero_week: no gauges last week while the team worked ≥ 3 days; and it suppresses (e)', () => {
  const fires = base({ lastWeek: { workedDays: 0, teamEventDays: 3 } });
  assert.deepEqual(codes(fires), ['zero_week']);
  assert.equal(textOf(fires, 'zero_week'), 'No gauges logged last week (w/c 5 Oct) while the team worked 3 event days');
  assert.deepEqual(codes(base({ lastWeek: { workedDays: 0, teamEventDays: 2 } })), [], 'the team only worked 2 days');
  assert.deepEqual(codes(base({ lastWeek: { workedDays: 0, teamEventDays: 5 }, startDate: '2026-10-05' })), [], 'started last week');
  const both = base({ lastWeek: { workedDays: 0, teamEventDays: 5 }, attendance: { recentWorked: 1, recentTeamDays: 9, priorWorked: 28, priorTeamDays: 36 } });
  assert.deepEqual(codes(both), ['zero_week']);
});

test('(g) earnings_drop: the last four weeks ≤ 0.7 × the four before (≥ £400)', () => {
  const fires = base({ weeklyGross: [410, 410, 410, 410, 180, 180, 180, 180] });
  assert.deepEqual(codes(fires), ['earnings_drop']);
  assert.equal(textOf(fires, 'earnings_drop'), 'Earnings £1,640 → £720 over the last four weeks');
  assert.ok(codes(base({ weeklyGross: [410, 410, 410, 410, 287, 287, 287, 287] })).includes('earnings_drop'), 'exactly 0.7');
  assert.deepEqual(codes(base({ weeklyGross: [410, 410, 410, 410, 288, 287, 287, 287] })), [], 'just over 0.7');
  assert.deepEqual(codes(base({ weeklyGross: [100, 100, 100, 99, 0, 0, 0, 0] })), [], 'the four before were under £400');
  assert.deepEqual(codes(base({ weeklyGross: [410, 410, 410] })), [], 'fewer than 8 weeks');
});

test('(h) trainee_slow: six weeks in and the funnel well under benchmark; names the weakest stage', () => {
  const funnel = (t: [number, number, number, number, number, number]): GaugeTotals => ({ stops: t[0], table: t[1], presentations: t[2], closes: t[3], taps: t[4], sales: t[5] });
  const trainee = (over: Partial<PersonSignalInput>) => base({ position: 'trainee', startDate: addDays(TODAY, -49), ...over });
  const slow = funnel([400, 60, 15, 4, 2, 1]); // mean actual ÷ benchmark 0.597; stop → table 15% v 35% is the weakest
  const fires = trainee({ last4Weeks: slow });
  assert.deepEqual(codes(fires), ['trainee_slow']);
  assert.equal(textOf(fires, 'trainee_slow'), '7 weeks in and still finding the rhythm — stop → table is 15% against the 35% benchmark, a good one to practise together');
  assert.deepEqual(codes(trainee({ last4Weeks: funnel([400, 50, 14, 4, 2, 1]) })), [], 'mean 0.604');
  assert.deepEqual(codes(trainee({ last4Weeks: slow, startDate: addDays(TODAY, -41) })), [], '41 days in');
  assert.deepEqual(codes(trainee({ last4Weeks: funnel([19, 2, 0, 0, 0, 0]) })), [], 'under 20 stops');
  assert.deepEqual(codes(base({ last4Weeks: slow })), [], 'field reps are not trainees');
});

test('reasons are deterministic, weighted, ordered heaviest first and never judgemental', () => {
  const input = base({
    lateMinutes: [12, 30, 8, 0, 0, 0, 0, 0, 0, 0],
    weeklyGross: [410, 410, 410, 410, 180, 180, 180, 180],
    lastWeek: { workedDays: 0, teamEventDays: 4 },
    current: { ...base().current, days: 3, stops: 150 },
  });
  const a = personSignals(input);
  assert.deepEqual(a, personSignals(input));
  assert.deepEqual(a.map((r) => r.code), ['stops_drop', 'zero_week', 'earnings_drop', 'late_often']);
  for (const r of a) {
    assert.equal(r.weight, CHECK_IN_RULES.weights[r.code]);
    assert.doesNotMatch(r.text, /at risk|underperform|failing|struggling|poor/i);
  }
});

function person(userId: number, userName: string, score: number): CheckInPerson {
  return { userId, userName, position: 'field_rep', avatarColor: '#4F46E5', teamId: 1, teamName: 'A', score, reasons: [] };
}

test('rankCheckIns drops scores < 2, sorts by score then name, and keeps 5', () => {
  const ranked = rankCheckIns([
    person(1, 'Zara Hill', 2),
    person(2, 'Amy Cole', 1),
    person(3, 'Ben Ash', 5),
    person(4, 'Cal Dee', 3),
    person(5, 'Abe Fox', 3),
    person(6, 'Dot Ray', 4),
    person(7, 'Eve Kay', 2),
    person(8, 'Fin Lo', 0),
  ]);
  assert.deepEqual(ranked.map((p) => p.userName), ['Ben Ash', 'Dot Ray', 'Abe Fox', 'Cal Dee', 'Eve Kay']);
  assert.equal(rankCheckIns([person(1, 'Solo', 1)]).length, 0);
  assert.deepEqual(rankCheckIns([]), []);
  const input = [person(2, 'B', 2), person(1, 'A', 2)];
  rankCheckIns(input);
  assert.deepEqual(input.map((p) => p.userId), [2, 1], 'does not mutate its input');
});
