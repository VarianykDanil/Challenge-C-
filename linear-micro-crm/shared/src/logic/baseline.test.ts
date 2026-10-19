import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_RULES, personalBaselineFrom } from './baseline.ts';
import type { WeekStat } from './stats.ts';
import type { GaugeTotals } from '../types.ts';

/** A plausible funnel (stops ≥ table ≥ … ≥ sales) from stops and sales; the middle stages sit near benchmark. */
function funnel(stops: number, sales: number, partial: Partial<GaugeTotals> = {}): GaugeTotals {
  const table = partial.table ?? Math.min(stops, Math.max(sales, Math.round(stops * 0.35)));
  const presentations = partial.presentations ?? Math.min(table, Math.max(sales, Math.round(table * 0.5)));
  const closes = partial.closes ?? Math.min(presentations, Math.max(sales, Math.round(presentations * 0.4)));
  const taps = partial.taps ?? Math.min(closes, Math.max(sales, Math.round(closes * 0.6)));
  return { stops, table, presentations, closes, taps, sales };
}

const MONDAYS = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
const THIS_MONDAY = '2026-09-28';

function week(weekStart: string, days: number, stops: number, sales: number, partial: Partial<GaugeTotals> = {}): WeekStat {
  return { weekStart, days, ...funnel(stops, sales, partial) };
}

/** 8 weeks of 5 worked days at `perDay(i)` stops a day and `conv` conversion. */
function history(perDay: (i: number) => number, conv: number, days = 5): WeekStat[] {
  return MONDAYS.map((m, i) => {
    const stops = perDay(i) * days;
    return week(m, days, stops, Math.round(stops * conv));
  });
}

const flat = () => history(() => 60, 0.03);
/** Alternating 55 / 65 stops a day: μ = 60, σ = √(8·25/7) ≈ 5.345. */
const spread = () => history((i) => (i % 2 ? 65 : 55), 0.03);

test('8 flat weeks (60 stops a day, 3%) with a matching current week → a baseline and no alerts', () => {
  const b = personalBaselineFrom(flat(), week(THIS_MONDAY, 3, 180, 5));
  assert.ok(b);
  assert.equal(b.weeks, 8);
  assert.equal(b.stopsPerDayMean, 60);
  assert.equal(b.stopsPerDaySd, 0);
  assert.equal(b.conversion, 0.03);
  assert.deepEqual(b.current, { days: 3, stops: 180, sales: 5, stopsPerDay: 60, conversion: 5 / 180 });
  assert.deepEqual(b.alerts, []);
});

test('stops at μ − 2σ over 2 days → exactly one stopsPerDay warning with volume as the lever; over 1 day → none', () => {
  const weeks = spread();
  const b0 = personalBaselineFrom(weeks, week(THIS_MONDAY, 0, 0, 0))!;
  const target = b0.stopsPerDayMean - 2 * b0.stopsPerDaySd; // ≈ 49.3
  const stops = Math.round(target * 2); // 99 → 49.5 a day, z ≈ −1.96
  const b = personalBaselineFrom(weeks, week(THIS_MONDAY, 2, stops, 3))!;
  assert.equal(b.alerts.length, 1);
  const [a] = b.alerts;
  assert.equal(a!.metric, 'stopsPerDay');
  assert.equal(a!.tone, 'warning');
  assert.ok(a!.z <= -BASELINE_RULES.stopsZ);
  assert.equal(a!.usual, 60);
  assert.match(a!.body, /volume is the lever/);
  // under 100 stops the conversion was not tested: no "holding" claim and no per-sale figure (the coaching card beside
  // this note gives its own figure from this period's rate, and two different figures would clash)
  assert.equal(a!.body, 'You are averaging 50 stops a day this week against your usual 60 — a slow site or a short day? More stops mean more chances to sell, so volume is the lever.');

  const oneDay = personalBaselineFrom(weeks, week(THIS_MONDAY, 1, Math.round(target), 1))!;
  assert.deepEqual(oneDay.alerts, [], 'one worked day is not enough for a pace alert');
});

test('stops warning with a tested, steady conversion says the conversion is holding (26 = ceil(1 / p0))', () => {
  // usual: 62 stops a day at 3.9% (σ > 0); this week: 3 days at 41 a day = 123 stops, 5 sales (4.1%)
  const weeks = MONDAYS.map((m, i) => {
    const stops = (i % 2 ? 64 : 60) * 5;
    return week(m, 5, stops, Math.round(stops * 0.039));
  });
  const b = personalBaselineFrom(weeks, week(THIS_MONDAY, 3, 123, 5))!;
  assert.equal(b.alerts.length, 1);
  const p0 = b.conversion;
  assert.equal(Math.ceil(1 / p0), 26);
  assert.equal(
    b.alerts[0]!.body,
    'You are averaging 41 stops a day this week against your usual 62 — a slow site or a short day? Your conversion is holding, so volume is the lever: every extra 26 stops is about one sale.',
  );
});

test('a slow week whose conversion has also slipped (but not to a warning) is never called "holding"', () => {
  // usual ≈ 62 stops a day (σ ≈ 6) at ≈ 4.4%; this week 3 days, 135 stops (45 a day) → a stops warning every time
  const weeks = [55, 69, 58, 66, 54, 70, 60, 64].map((perDay, i) => week(MONDAYS[i]!, 5, perDay * 5, Math.round(perDay * 5 * 0.044)));
  const at = (sales: number) => personalBaselineFrom(weeks, week(THIS_MONDAY, 3, 135, sales))!;
  const p0 = at(0).conversion;
  assert.equal((Math.round(p0 * 1000) / 10).toFixed(1), '4.4');
  const neutral = 'You are averaging 45 stops a day this week against your usual 62 — a slow site or a short day? More stops mean more chances to sell, so volume is the lever.';
  for (const sales of [2, 3, 4, 5]) {
    // 1.5%, 2.2%, 3.0%, 3.7% against 4.4%: under 90% of the usual rate, and no conversion warning (z > −2)
    const b = at(sales);
    assert.deepEqual(b.alerts.map((x) => [x.metric, x.tone]), [['stopsPerDay', 'warning']], `${sales} sales`);
    assert.ok(!/holding/.test(b.alerts[0]!.body), `${sales} sales must not be "holding"`);
    assert.equal(b.alerts[0]!.body, neutral);
  }
  // 6 sales (4.4%) is the usual rate → holding, with the per-sale figure from the usual rate
  const usual = at(6);
  assert.equal(usual.alerts.length, 1);
  assert.equal(usual.alerts[0]!.body, `You are averaging 45 stops a day this week against your usual 62 — a slow site or a short day? Your conversion is holding, so volume is the lever: every extra ${Math.ceil(1 / p0)} stops is about one sale.`);
  // 0 sales on 100 stops against ≈ 3.8% (binomial z ≈ −1.98, so no conversion warning) is not "holding" either
  const low = MONDAYS.map((m, i) => week(m, 5, (i % 2 ? 64 : 56) * 5, Math.round((i % 2 ? 64 : 56) * 5 * 0.038)));
  const zero = personalBaselineFrom(low, week(THIS_MONDAY, 2, 100, 0))!;
  assert.deepEqual(zero.alerts.map((x) => [x.metric, x.tone]), [['stopsPerDay', 'warning']]);
  assert.ok(zero.alerts[0]!.z <= -BASELINE_RULES.stopsZ);
  assert.ok(!/holding/.test(zero.alerts[0]!.body));
});

test('conversion 1.5% on 80 stops → no alert (fewer than 100 stops this week)', () => {
  const b = personalBaselineFrom(flat(), week(THIS_MONDAY, 2, 80, 1))!; // 1.25% → "1.3%"; even 0 sales would stay quiet
  assert.deepEqual(b.alerts, []);
  const none = personalBaselineFrom(flat(), week(THIS_MONDAY, 2, 80, 0))!;
  assert.deepEqual(none.alerts, []);
});

test('conversion warning names the weakest stage as the one lever', () => {
  // usual 4%; this week 300 stops at 1.0% with presentation → close well under its 40% benchmark
  const weeks = history(() => 60, 0.04);
  const current = week(THIS_MONDAY, 5, 300, 3, { table: 105, presentations: 52, closes: 10, taps: 6 });
  const b = personalBaselineFrom(weeks, current)!;
  assert.equal(b.alerts.length, 1);
  const [a] = b.alerts;
  assert.equal(a!.metric, 'conversion');
  assert.equal(a!.tone, 'warning');
  assert.ok(a!.z <= -2);
  assert.equal(a!.current, 0.01);
  assert.equal(a!.usual, 0.04);
  assert.equal(a!.title, 'Conversion below your usual');
  assert.equal(a!.body, 'Your conversion is 1.0% this week against your usual 4.0% (300 stops). Presentation → close is furthest below benchmark — start there.');
});

test('conversion warning with every stage within 10% of benchmark never claims "benchmark or better"', () => {
  // usual 7%; this week 3.7% on 300 stops with presentation → close at 37% (−7% against 40%: on track, but under)
  const onTrack = personalBaselineFrom(history(() => 60, 0.07), week(THIS_MONDAY, 5, 300, 11, { table: 105, presentations: 54, closes: 20, taps: 12 }))!;
  assert.deepEqual(onTrack.alerts.map((a) => [a.metric, a.tone]), [['conversion', 'warning']]);
  assert.equal(onTrack.alerts[0]!.body, 'Your conversion is 3.7% this week against your usual 7.0% (300 stops). No stage is more than 10% under benchmark, and presentation → close is the furthest under it — start there.');
  // usual 8%; this week 4.3% with every stage at or above its benchmark → the stage closest to slipping under
  const above = personalBaselineFrom(history(() => 60, 0.08), week(THIS_MONDAY, 5, 300, 13, { table: 108, presentations: 55, closes: 23, taps: 14 }))!;
  assert.deepEqual(above.alerts.map((a) => [a.metric, a.tone]), [['conversion', 'warning']]);
  assert.equal(above.alerts[0]!.body, 'Your conversion is 4.3% this week against your usual 8.0% (300 stops). Every stage is at benchmark or better, and close → tap is the closest to slipping under — start there.');
});

test('both warnings → one combined alert that leads with conversion', () => {
  const weeks = history((i) => (i % 2 ? 65 : 55), 0.04);
  const current = week(THIS_MONDAY, 3, 120, 0, { table: 40, presentations: 20, closes: 8, taps: 0 }); // 40 a day, 0%
  const b = personalBaselineFrom(weeks, current)!;
  assert.equal(b.alerts.length, 1);
  const [a] = b.alerts;
  assert.equal(a!.metric, 'conversion');
  assert.equal(a!.tone, 'warning');
  assert.match(a!.body, /^Your conversion is 0\.0% this week against your usual 4\.0% \(120 stops\), and you are averaging 40 stops a day against your usual 60\. /);
  assert.match(a!.body, / Close → tap is furthest below benchmark — start there\.$/);
  assert.ok(!/volume is the lever/.test(a!.body), 'one lever only');
});

test('positive alerts praise only, warnings come first, and there are never more than 2', () => {
  const weeks = history((i) => (i % 2 ? 65 : 55), 0.03);
  // 80 stops a day over 4 days at 6% → both positive
  const up = personalBaselineFrom(weeks, week(THIS_MONDAY, 4, 320, 19))!;
  assert.equal(up.alerts.length, 2);
  assert.deepEqual(up.alerts.map((a) => [a.metric, a.tone]), [['conversion', 'positive'], ['stopsPerDay', 'positive']]);
  for (const a of up.alerts) assert.ok(!/estimate|about one sale|every extra/.test(a.body), 'no projection in praise');
  assert.equal(up.alerts[1]!.body, 'You are averaging 80 stops a day this week, up on your usual 60. Great energy — keep it going.');
  // fewer stops but converting well above usual → the warning first, then the praise
  const mixed = personalBaselineFrom(weeks, week(THIS_MONDAY, 3, 135, 9))!; // 45 a day at 6.7%
  assert.deepEqual(mixed.alerts.map((a) => [a.metric, a.tone]), [['stopsPerDay', 'warning'], ['conversion', 'positive']]);
  assert.match(mixed.alerts[0]!.body, /Your conversion is holding, so volume is the lever/);
});

test('null with fewer than 4 worked weeks or under 20 stops a day; weeks off are ignored, not slow', () => {
  const three = flat().map((w, i) => (i < 5 ? { ...w, days: 0, stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 } : w));
  assert.equal(personalBaselineFrom(three, week(THIS_MONDAY, 2, 120, 4)), null, '3 usable weeks');
  const four = flat().map((w, i) => (i < 4 ? { ...w, days: 0, stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 } : w));
  const b = personalBaselineFrom(four, week(THIS_MONDAY, 2, 120, 4));
  assert.ok(b);
  assert.equal(b.weeks, 4);
  assert.equal(b.stopsPerDayMean, 60, 'the weeks off do not drag the mean down');
  assert.equal(personalBaselineFrom(history(() => 15, 0.05), week(THIS_MONDAY, 2, 30, 1)), null, 'μ = 15');
  assert.equal(personalBaselineFrom([], week(THIS_MONDAY, 0, 0, 0)), null);
});

test('only the newest 8 weeks count, Monday (no days yet) gives a baseline with no alerts, and the copy is deterministic', () => {
  const older = history(() => 10, 0.01); // would drag μ under 20 if it counted
  const weeks = [...older, ...spread()];
  const monday = personalBaselineFrom(weeks, week(THIS_MONDAY, 0, 0, 0))!;
  assert.equal(monday.weeks, 8);
  assert.equal(monday.stopsPerDayMean, 60);
  assert.deepEqual(monday.alerts, []);
  assert.deepEqual(monday.current, { days: 0, stops: 0, sales: 0, stopsPerDay: 0, conversion: 0 });
  const a = personalBaselineFrom(spread(), week(THIS_MONDAY, 2, 96, 2));
  const b = personalBaselineFrom(spread(), week(THIS_MONDAY, 2, 96, 2));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('no sales in the usual weeks: no conversion test and no "per sale" figure', () => {
  const weeks = history((i) => (i % 2 ? 65 : 55), 0);
  const b = personalBaselineFrom(weeks, week(THIS_MONDAY, 3, 120, 0))!;
  assert.equal(b.conversion, 0);
  assert.equal(b.alerts.length, 1);
  assert.equal(b.alerts[0]!.metric, 'stopsPerDay');
  assert.ok(b.alerts[0]!.body.endsWith('a short day? More stops mean more chances to sell, so volume is the lever.'));
  assert.ok(!/NaN|Infinity/.test(b.alerts[0]!.body));
});
