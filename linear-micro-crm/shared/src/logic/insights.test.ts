import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GaugeTotals } from '../types.ts';
import { BENCHMARK_RATIOS } from '../constants.ts';
import { EMPTY_TOTALS, funnelRatios } from './gauges.ts';
import { coachingInsights } from './insights.ts';

const SAMPLE: GaugeTotals = { stops: 100, table: 40, presentations: 20, closes: 8, taps: 5, sales: 4 };
const AT_BENCHMARK: GaugeTotals = { stops: 1000, table: 350, presentations: 175, closes: 70, taps: 42, sales: 38 };

test('no stops → a single neutral prompt', () => {
  const out = coachingInsights(EMPTY_TOTALS, funnelRatios(EMPTY_TOTALS));
  assert.equal(out.length, 1);
  assert.equal(out[0].tone, 'neutral');
  assert.equal(out[0].title, 'No gauges yet');
});

test('always returns between 1 and 3 insights', () => {
  const cases: GaugeTotals[] = [
    EMPTY_TOTALS,
    { stops: 3, table: 1, presentations: 0, closes: 0, taps: 0, sales: 0 },
    SAMPLE,
    AT_BENCHMARK,
    { stops: 500, table: 50, presentations: 10, closes: 2, taps: 1, sales: 0 },
    { stops: 100, table: 90, presentations: 85, closes: 80, taps: 75, sales: 75 },
  ];
  for (const t of cases) {
    const out = coachingInsights(t, funnelRatios(t));
    assert.ok(out.length >= 1 && out.length <= 3, `${out.length} insights for ${JSON.stringify(t)}`);
    for (const i of out) {
      assert.ok(i.title.length > 0 && i.body.length > 0);
      assert.ok(['positive', 'neutral', 'warning'].includes(i.tone));
    }
  }
});

test('small samples lead with a caveat and name the weakest stage', () => {
  const t: GaugeTotals = { stops: 10, table: 4, presentations: 1, closes: 1, taps: 1, sales: 1 };
  const out = coachingInsights(t, funnelRatios(t));
  assert.equal(out[0].tone, 'neutral');
  assert.equal(out[0].title, 'Early days');
  assert.ok(out[0].body.includes('10 stops'));
  assert.equal(out[1]?.tone, 'warning');
  assert.equal(out[1]?.key, 'tableToPresentation');
  assert.ok(out.length <= 2);
});

test('a typical rep gets a strength, a focus area and a next step', () => {
  const out = coachingInsights(SAMPLE, funnelRatios(SAMPLE));
  assert.equal(out.length, 3);
  assert.equal(out[0].tone, 'positive');
  assert.equal(out[0].key, 'stopToTable');
  assert.ok(out[0].body.includes('40% vs the 35% benchmark'));
  assert.equal(out[1].tone, 'warning');
  assert.equal(out[1].key, 'tapToSale');
  assert.ok(out[1].body.includes('80% vs the 90% benchmark'));
  assert.equal(out[2].tone, 'neutral');
  assert.ok(out[2].body.includes('25 stops per sale'));
});

test('everything on track is celebrated and followed by a volume tip', () => {
  const out = coachingInsights(AT_BENCHMARK, funnelRatios(AT_BENCHMARK));
  assert.equal(out[0].tone, 'positive');
  assert.equal(out[0].title, 'Every stage on track');
  assert.ok(out.every((i) => i.tone !== 'warning'));
  assert.equal(out[out.length - 1].title, 'Volume is your lever');
});

test('two weak stages: the second becomes the neutral "next up" tip', () => {
  const t: GaugeTotals = { stops: 100, table: 20, presentations: 5, closes: 2, taps: 2, sales: 2 };
  const out = coachingInsights(t, funnelRatios(t));
  const warning = out.find((i) => i.tone === 'warning');
  const next = out.find((i) => i.title.startsWith('Next up'));
  assert.ok(warning);
  assert.ok(next);
  assert.notEqual(warning?.key, next?.key);
  assert.ok(warning!.body.includes('Practise') || next!.body.includes('Practise'), 'uses British spelling');
});

test('custom benchmarks change the verdict', () => {
  const relaxed = { ...BENCHMARK_RATIOS, tapToSale: 0.75 };
  const out = coachingInsights(SAMPLE, funnelRatios(SAMPLE), relaxed);
  assert.ok(!out.some((i) => i.tone === 'warning' && i.key === 'tapToSale'));
});

test('no sales yet with plenty of stops gives an encouraging volume message', () => {
  const t: GaugeTotals = { stops: 60, table: 20, presentations: 10, closes: 4, taps: 0, sales: 0 };
  const out = coachingInsights(t, funnelRatios(t));
  assert.ok(out.some((i) => i.title === 'Keep the stops up' && i.body.includes('60 stops')));
});

test('stages nobody has reached are not coached as weak', () => {
  // taps = 0 so tap→sale is undefined; close→tap (4 closes, 0 taps) is the only real weakness
  const t: GaugeTotals = { stops: 60, table: 20, presentations: 10, closes: 4, taps: 0, sales: 0 };
  const out = coachingInsights(t, funnelRatios(t));
  assert.ok(!out.some((i) => i.key === 'tapToSale'));
  assert.equal(out.find((i) => i.tone === 'warning')?.key, 'closeToTap');
});

test('on-benchmark stages with an unreached tail get "On track so far"', () => {
  // The first unreached gauge normally makes its incoming ratio 0 (→ below); only a zero benchmark
  // for that step leaves nothing below while a later stage is still unreached.
  const t: GaugeTotals = { stops: 100, table: 35, presentations: 18, closes: 7, taps: 0, sales: 0 };
  const out = coachingInsights(t, funnelRatios(t), { ...BENCHMARK_RATIOS, closeToTap: 0 });
  assert.equal(out[0].title, 'On track so far');
  assert.equal(out[0].tone, 'positive');
});
