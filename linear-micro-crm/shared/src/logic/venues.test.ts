/**
 * P8 venue-insights: the plan maths and the law of averages, against hand-computed fixtures (the working is in the
 * comments, so a reviewer can check each figure with a calculator).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GaugeTotals } from '../types.ts';
import {
  blendPlanRatios,
  expectedHeadcount,
  fittedSalesPerStop,
  goodDayFrom,
  lawOfAveragesSentence,
  pearson,
  perShiftOf,
  planAimText,
  planFunnelRatios,
  planSentence,
  planSteps,
  planTarget,
  poissonBand,
  ratioStability,
  salesPerShiftOf,
  sortVenues,
  stageRatiosOf,
  stopBands,
  VENUE_RULES,
} from './venues.ts';

const T = (stops: number, table: number, presentations: number, closes: number, taps: number, sales: number): GaugeTotals => ({ stops, table, presentations, closes, taps, sales });
const close = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≈ ${expected}`);

test('poissonBand: λ ± z√λ = T at z = 1 (T = 5 → 3.2087 and 7.7913)', () => {
  // √(1 + 20) = 4.58258; low = ((4.58258 − 1) / 2)² = 1.79129² = 3.20871; high = ((4.58258 + 1) / 2)² = 2.79129² = 7.79129
  const b = poissonBand(5);
  close(b.low, 3.208712, 1e-5);
  close(b.high, 7.791288, 1e-5);
  close(b.low + Math.sqrt(b.low), 5);
  close(b.high - Math.sqrt(b.high), 5);
  assert.deepEqual(poissonBand(0), { low: 0, high: 1 });
});

test('planSteps: need = ⌈T ÷ conversion from the stage⌉, with the lucky / slow day range', () => {
  // ratios 0.4 · 0.5 · 0.5 · 0.6 · 0.9 → conversion to a sale from taps 0.9, closes 0.54, presentations 0.27,
  // table 0.135, stops 0.054. T = 5: need 6 taps (5.56), 10 closes (9.26), 19 presentations (18.52), 38 table (37.04),
  // 93 stops (92.59). Low = round(3.2087 ÷ conv) but ≥ 5: 5 (3.57), 6 (5.94), 12 (11.88), 24 (23.77), 59 (59.42).
  // High = round(7.7913 ÷ conv): 9 (8.66), 14 (14.43), 29 (28.86), 58 (57.71), 144 (144.28).
  const steps = planSteps(5, { stopToTable: 0.4, tableToPresentation: 0.5, presentationToClose: 0.5, closeToTap: 0.6, tapToSale: 0.9 });
  assert.deepEqual(steps, [
    { key: 'stops', need: 93, low: 59, high: 144 },
    { key: 'table', need: 38, low: 24, high: 58 },
    { key: 'presentations', need: 19, low: 12, high: 29 },
    { key: 'closes', need: 10, low: 6, high: 14 },
    { key: 'taps', need: 6, low: 5, high: 9 },
  ]);
  for (const s of steps) assert.ok(s.low <= s.need && s.need <= s.high, s.key);
});

test('planSteps: an exact multiple stays exact (3 ÷ 0.3 is 10.000000000000002 in floating point)', () => {
  const steps = planSteps(3, { stopToTable: 1, tableToPresentation: 1, presentationToClose: 1, closeToTap: 1, tapToSale: 0.3 });
  assert.deepEqual(steps.map((s) => s.need), [10, 10, 10, 10, 10]);
  // every stage is at least the target: a funnel never has fewer taps than sales
  const all = planSteps(4, { stopToTable: 1, tableToPresentation: 1, presentationToClose: 1, closeToTap: 1, tapToSale: 1 });
  assert.deepEqual(all.map((s) => [s.need, s.low]), [[4, 4], [4, 4], [4, 4], [4, 4], [4, 4]]);
});

test('blendPlanRatios: (1 − w) × own + w × (w_v × venue + (1 − w_v) × company)', () => {
  const own = { shifts: 10, totals: T(400, 160, 80, 40, 24, 20) }; // 0.4 · 0.5 · 0.5 · 0.6 · 0.8333
  const venue = { shifts: 30, totals: T(1500, 450, 225, 90, 54, 45) }; // 0.3 · 0.5 · 0.4 · 0.6 · 0.8333
  const company = T(10000, 3500, 1750, 700, 420, 378); // 0.35 · 0.5 · 0.4 · 0.6 · 0.9
  const b = blendPlanRatios(own, venue, company);
  close(b.venueWeight, 0.5); // 10 ÷ (10 + 10)
  close(b.locationWeight, 0.75); // 30 ÷ (30 + 10)
  assert.ok(b.ratios);
  close(b.ratios.stopToTable, 0.35625); // location 0.75 × 0.3 + 0.25 × 0.35 = 0.3125; 0.5 × 0.4 + 0.5 × 0.3125
  close(b.ratios.tableToPresentation, 0.5);
  close(b.ratios.presentationToClose, 0.45); // location 0.4; 0.5 × 0.5 + 0.5 × 0.4
  close(b.ratios.closeToTap, 0.6);
  close(b.ratios.tapToSale, 0.8416667); // location 0.75 × 0.83333 + 0.25 × 0.9 = 0.85; 0.5 × 0.83333 + 0.5 × 0.85
});

test('blendPlanRatios: no own shifts → the venue part alone; a new venue → the company; no conversion anywhere → null', () => {
  const company = T(1000, 350, 175, 70, 42, 36);
  const venue = { shifts: 10, totals: T(500, 200, 100, 40, 20, 20) };
  const noOwn = blendPlanRatios({ shifts: 0, totals: T(0, 0, 0, 0, 0, 0) }, venue, company);
  close(noOwn.venueWeight, 1);
  close(noOwn.locationWeight, 0.5);
  close(noOwn.ratios!.stopToTable, 0.5 * 0.4 + 0.5 * 0.35); // 0.375
  close(noOwn.ratios!.tapToSale, 0.5 * 1 + 0.5 * (36 / 42));
  const newVenue = blendPlanRatios({ shifts: 0, totals: T(0, 0, 0, 0, 0, 0) }, { shifts: 0, totals: T(0, 0, 0, 0, 0, 0) }, company);
  close(newVenue.locationWeight, 0);
  close(newVenue.ratios!.stopToTable, 0.35);
  assert.equal(blendPlanRatios({ shifts: 0, totals: T(0, 0, 0, 0, 0, 0) }, { shifts: 0, totals: T(0, 0, 0, 0, 0, 0) }, T(0, 0, 0, 0, 0, 0)).ratios, null);
  assert.equal(blendPlanRatios({ shifts: 2, totals: T(100, 40, 20, 8, 0, 0) }, { shifts: 0, totals: T(0, 0, 0, 0, 0, 0) }, T(100, 40, 20, 8, 0, 0)).ratios, null, 'no taps anywhere');
  // 0 presentations from 40 at the table is data (0%); a stage the person never reached (no presentations, so no
  // presentation → close ratio) takes the location's ratio alone
  const partial = blendPlanRatios({ shifts: 10, totals: T(100, 40, 0, 0, 0, 0) }, venue, company);
  close(partial.ratios!.stopToTable, 0.5 * 0.4 + 0.5 * 0.375);
  close(partial.ratios!.tableToPresentation, 0.5 * 0 + 0.5 * 0.5);
  close(partial.ratios!.presentationToClose, 0.5 * 0.4 + 0.5 * 0.4);
});

test('planTarget: the event share (⌈target ÷ people⌉) against a good day (round p75 of sales per shift)', () => {
  // 17 ÷ 6 = 2.83 → 3. Own [1,1,2,2,2,3,4,5]: p75 at h = 7 × 0.75 = 5.25 → 3 + 0.25 × (4 − 3) = 3.25 → 3: a tie → event
  assert.deepEqual(planTarget({ eventTarget: 17, people: 6, ownShiftSales: [1, 2, 2, 3, 4, 5, 1, 2], venueShiftSales: [] }), { targetSales: 3, targetSource: 'event', eventShare: 3, sharedAmong: 6, goodDay: 3, shareAboveGoodDay: false });
  // own [2,3,4,4,5]: p75 at h = 3 → 4 > 3 → the good day
  assert.deepEqual(planTarget({ eventTarget: 17, people: 6, ownShiftSales: [2, 3, 4, 4, 5], venueShiftSales: [] }), { targetSales: 4, targetSource: 'good-day', eventShare: 3, sharedAmong: 6, goodDay: 4, shareAboveGoodDay: false });
  // 4 own shifts are too few: the venue's [0..7] p75 at h = 5.25 → 5.25 → 5
  assert.deepEqual(planTarget({ eventTarget: 17, people: 6, ownShiftSales: [9, 9, 9, 9], venueShiftSales: [0, 1, 2, 3, 4, 5, 6, 7] }), { targetSales: 5, targetSource: 'venue-good-day', eventShare: 3, sharedAmong: 6, goodDay: 5, shareAboveGoodDay: false });
  // no target, no data: 1 sale
  assert.deepEqual(planTarget({ eventTarget: 0, people: 2, ownShiftSales: [], venueShiftSales: [] }), { targetSales: 1, targetSource: 'event', eventShare: null, sharedAmong: 2, goodDay: null, shareAboveGoodDay: false });
  // a mean turnout divides as a whole number of people: 5.33 → 5 → ⌈19 ÷ 5⌉ = 4; 2.5 → 3 (round half up)
  assert.equal(planTarget({ eventTarget: 19, people: 16 / 3, ownShiftSales: [], venueShiftSales: [] }).eventShare, 4);
  assert.equal(planTarget({ eventTarget: 19, people: 2.5, ownShiftSales: [], venueShiftSales: [] }).sharedAmong, 3);
  // unknown headcount: no share
  assert.equal(planTarget({ eventTarget: 19, people: null, ownShiftSales: [], venueShiftSales: [] }).eventShare, null);
  // a good day is at least 1 (round(p75) of zeros is 0)
  assert.equal(goodDayFrom([0, 0, 0, 0, 0]), 1);
  assert.equal(goodDayFrom([1, 2, 3, 4]), null);
});

test('planTarget: a share far above the good day (more than 1.5 × and 2 sales or more) is a note; the plan aims for the good day', () => {
  // good day [4,4,4,4,4] → 4; 1.5 × 4 = 6. ⌈19 ÷ 3⌉ = 7 > 6 → aim for 4, flagged
  assert.deepEqual(planTarget({ eventTarget: 19, people: 3, ownShiftSales: [4, 4, 4, 4, 4], venueShiftSales: [] }), { targetSales: 4, targetSource: 'good-day', eventShare: 7, sharedAmong: 3, goodDay: 4, shareAboveGoodDay: true });
  // ⌈18 ÷ 3⌉ = 6 = 1.5 × 4 → still the share (the boundary is inclusive)
  assert.deepEqual(planTarget({ eventTarget: 18, people: 3, ownShiftSales: [4, 4, 4, 4, 4], venueShiftSales: [] }), { targetSales: 6, targetSource: 'event', eventShare: 6, sharedAmong: 3, goodDay: 4, shareAboveGoodDay: false });
  // a newcomer: the venue's good day takes the same rule
  const venue = planTarget({ eventTarget: 30, people: 2, ownShiftSales: [], venueShiftSales: [2, 2, 2, 2, 2] });
  assert.deepEqual([venue.targetSales, venue.targetSource, venue.eventShare, venue.shareAboveGoodDay], [2, 'venue-good-day', 15, true]);
  // without a good day there is nothing to compare with: the share
  assert.deepEqual([planTarget({ eventTarget: 30, people: 2, ownShiftSales: [], venueShiftSales: [] }).targetSales, VENUE_RULES.shareStretch], [15, 1.5]);
  // small numbers: a share of 2 against a good day of 1 is twice it but only 1 sale more → still the aim; 3 against 1 is not
  const ones = [1, 1, 1, 1, 1];
  assert.deepEqual([planTarget({ eventTarget: 14, people: 7, ownShiftSales: ones, venueShiftSales: [] }).targetSales, planTarget({ eventTarget: 14, people: 7, ownShiftSales: ones, venueShiftSales: [] }).shareAboveGoodDay], [2, false]);
  assert.deepEqual([planTarget({ eventTarget: 15, people: 7, ownShiftSales: ones, venueShiftSales: [] }).targetSales, planTarget({ eventTarget: 15, people: 7, ownShiftSales: ones, venueShiftSales: [] }).shareAboveGoodDay], [1, true]);
  assert.equal(VENUE_RULES.shareStretchMinGap, 2);
});

test('expectedHeadcount: the habit, the people booked, self-bookings as a floor, walk-ups on a live day', () => {
  const base = { habit: 5.5, booked: 0, managed: false, live: false, logged: 0 };
  assert.equal(expectedHeadcount(base), 5.5, 'nobody booked: the habit');
  assert.equal(expectedHeadcount({ ...base, habit: null }), null, 'nobody booked, no habit: unknown');
  assert.equal(expectedHeadcount({ ...base, booked: 3, managed: true }), 3, 'a leader booked: the people booked');
  assert.equal(expectedHeadcount({ ...base, booked: 3 }), 5.5, 'self-bookings only: the habit is the floor');
  assert.equal(expectedHeadcount({ ...base, booked: 7 }), 7, 'self-bookings above the habit');
  assert.equal(expectedHeadcount({ ...base, habit: null, booked: 2 }), 2, 'no habit: the people booked');
  assert.equal(expectedHeadcount({ ...base, booked: 2, managed: true, live: true, logged: 7 }), 7, 'live: walk-ups count');
  assert.equal(expectedHeadcount({ ...base, booked: 4, managed: true, live: true, logged: 1 }), 4, 'live: the people booked are still expected');
  assert.equal(expectedHeadcount({ ...base, live: true, logged: 9 }), 5.5, 'nobody booked: the 1.1 rule, unchanged');
});

test('plan copy: the sentence and the one-line aim', () => {
  const steps = planSteps(5, { stopToTable: 0.4, tableToPresentation: 0.5, presentationToClose: 0.5, closeToTap: 0.6, tapToSale: 0.9 });
  assert.equal(planSentence(5, 'Golden Square', steps), 'To make 5 sales at Golden Square you need about 93 stops → 38 to table → 19 presentations → 10 closes → 6 taps.');
  assert.equal(planAimText(5, steps), '93 stops → 38 → 19 → 10 → 6 taps for 5 sales');
  const one = planSteps(1, { stopToTable: 1, tableToPresentation: 1, presentationToClose: 1, closeToTap: 1, tapToSale: 1 });
  assert.equal(planSentence(1, 'Mill Gate', one), 'To make 1 sale at Mill Gate you need about 1 stop → 1 to table → 1 presentation → 1 close → 1 tap.');
  assert.equal(planAimText(1, one), '1 stop → 1 → 1 → 1 → 1 tap for 1 sale');
  assert.equal(planSentence(5, 'Mill Gate', []), 'There are not enough gauges yet to plan a day at Mill Gate.');
  assert.equal(planAimText(5, []), '');
  const big = planSteps(20, { stopToTable: 0.2, tableToPresentation: 0.5, presentationToClose: 0.5, closeToTap: 0.5, tapToSale: 0.5 });
  assert.match(planSentence(20, 'X', big), /about 1,600 stops/); // 20 ÷ (0.2 × 0.5⁴ = 0.0125)
  const f = planFunnelRatios({ stopToTable: 0.4, tableToPresentation: 0.5, presentationToClose: 0.5, closeToTap: 0.6, tapToSale: 0.9 });
  close(f.overallConversion, 0.054);
  close(f.stopsPerSale!, 1 / 0.054);
});

test('law of averages: fitted rate, correlation and the three stop bands', () => {
  close(fittedSalesPerStop([{ stops: 100, sales: 4 }, { stops: 50, sales: 1 }]), 5 / 150);
  assert.equal(fittedSalesPerStop([]), 0);
  close(pearson([1, 2, 3], [2, 4, 6])!, 1);
  close(pearson([1, 2, 3], [3, 2, 1])!, -1);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  assert.equal(pearson([1, 2], [1, 2]), null);
  const points = [90, 10, 50, 30, 70, 20, 60, 40, 80].map((stops) => ({ stops, sales: stops / 10 - 1, date: `2026-10-${String(stops / 10).padStart(2, '0')}` }));
  // sorted 10..90, sales 0..8; cuts at 3 and 6: [10,20,30] → 1 a shift, [40,50,60] → 4, [70,80,90] → 7
  assert.deepEqual(stopBands(points), [
    { band: 'fewest', minStops: 10, maxStops: 30, shifts: 3, avgStops: 20, salesPerShift: 1 },
    { band: 'middle', minStops: 40, maxStops: 60, shifts: 3, avgStops: 50, salesPerShift: 4 },
    { band: 'most', minStops: 70, maxStops: 90, shifts: 3, avgStops: 80, salesPerShift: 7 },
  ]);
  assert.deepEqual(stopBands(points.slice(0, VENUE_RULES.bandsMinShifts - 1)), []);
  // 10 shifts: cuts at round(3.33) = 3 and round(6.67) = 7
  const ten = [...points, { stops: 100, sales: 9, date: '2026-10-10' }];
  assert.deepEqual(stopBands(ten).map((b) => b.shifts), [3, 4, 3]);
});

const visit = (stops: number, sales: number): GaugeTotals => T(stops, stops, stops, stops, stops, sales);

test('ratioStability: the CV from visit to visit against the CV luck alone gives', () => {
  // identical rates → CV 0 → steady
  const same = ratioStability([visit(100, 4), visit(200, 8), visit(100, 4)]);
  assert.equal(same.overallConversion?.label, 'steady');
  assert.equal(same.overallConversion?.cv, 0);
  // rates 0.01, 0.10, 0.04 (p = 15 ÷ 300 = 0.05): mean 0.05, SD √(0.0042 ÷ 2) = 0.045826 → CV 0.9165;
  // chance √(0.05 × 0.95 ÷ 100) ÷ 0.05 = 0.43589; 0.9165 ÷ 0.43589 = 2.10 → fairly steady (≤ 2.5 ×)
  const mid = ratioStability([visit(100, 1), visit(100, 10), visit(100, 4)]);
  assert.equal(mid.overallConversion?.cv, 0.917);
  assert.equal(mid.overallConversion?.chanceCv, 0.436);
  assert.equal(mid.overallConversion?.label, 'fairly_steady');
  assert.equal(mid.overallConversion?.visits, 3);
  // rates 0, 0.12, 0.03: SD √(0.0078 ÷ 2) = 0.06245 → CV 1.249; ÷ 0.43589 = 2.87 → varies
  assert.equal(ratioStability([visit(100, 0), visit(100, 12), visit(100, 3)]).overallConversion?.label, 'varies');
  // a ratio at 100% everywhere has no luck to compare with: the 0.05 floor keeps it steady
  assert.equal(mid.stopToTable?.label, 'steady');
  // fewer than three visits → nothing; a ratio nobody converted → nothing
  assert.deepEqual(ratioStability([visit(100, 4), visit(100, 5)]), {});
  assert.equal(ratioStability([visit(100, 0), visit(100, 0), visit(100, 0)]).overallConversion, undefined);
});

test('lawOfAveragesSentence: the plan\'s own example, and the thin-data wording', () => {
  // 984 stops ÷ 41 sales = 24
  assert.equal(lawOfAveragesSentence({ venue: 'Golden Square', shifts: 41, stops: 984, sales: 41, visits: 12, steadiness: 'steady' }), 'At Golden Square, every 24 stops made a sale on average, steady across 41 shifts.');
  assert.equal(lawOfAveragesSentence({ venue: 'Mill Gate', shifts: 30, stops: 900, sales: 30, visits: 8, steadiness: 'fairly_steady' }), 'At Mill Gate, every 30 stops made a sale on average, fairly steady across 30 shifts.');
  assert.equal(lawOfAveragesSentence({ venue: 'Mill Gate', shifts: 30, stops: 900, sales: 30, visits: 8, steadiness: 'varies' }), 'At Mill Gate, every 30 stops made a sale on average across 30 shifts, though it varied from visit to visit.');
  assert.equal(lawOfAveragesSentence({ venue: 'Mill Gate', shifts: 6, stops: 300, sales: 12, visits: 2 }), 'At Mill Gate, every 25 stops made a sale on average across 6 shifts.');
  assert.equal(lawOfAveragesSentence({ venue: 'Mill Gate', shifts: 3, stops: 150, sales: 5, visits: 1 }), 'At Mill Gate, every 30 stops made a sale so far, but 3 shifts are too few to call it a pattern yet.');
  assert.equal(lawOfAveragesSentence({ venue: 'Mill Gate', shifts: 1, stops: 40, sales: 0, visits: 1 }), 'No sales at Mill Gate yet across 1 shift (40 stops).');
  assert.equal(lawOfAveragesSentence({ venue: 'Mill Gate', shifts: 0, stops: 0, sales: 0, visits: 0 }), 'No shifts logged at Mill Gate yet.');
});

test('per shift, sales per shift, stage ratios', () => {
  assert.deepEqual(perShiftOf(T(125, 44, 21, 9, 6, 5), 2), T(62.5, 22, 10.5, 4.5, 3, 2.5));
  assert.deepEqual(perShiftOf(T(10, 0, 0, 0, 0, 0), 3), T(3.3, 0, 0, 0, 0, 0));
  assert.deepEqual(perShiftOf(T(1, 1, 1, 1, 1, 1), 0), T(0, 0, 0, 0, 0, 0));
  assert.equal(salesPerShiftOf(7, 3), 2.33);
  assert.equal(salesPerShiftOf(7, 0), 0);
  assert.deepEqual(stageRatiosOf(T(100, 40, 0, 0, 0, 0)), { stopToTable: 0.4, tableToPresentation: 0, presentationToClose: null, closeToTap: null, tapToSale: null });
});

test('sortVenues: by sales per shift (under 10 shifts after, none last), shifts, last visit; ties by shifts then name', () => {
  const v = (key: string, shifts: number, salesPerShift: number, lastVisit: string | null) => ({ key, venue: key.toUpperCase(), shifts, salesPerShift, lastVisit });
  const list = [v('b', 10, 2.5, '2026-10-01'), v('a', 30, 2.5, '2026-09-01'), v('c', 0, 0, null), v('d', 5, 3.1, '2026-10-15'), v('e', 12, 2.9, '2026-08-01')];
  // e (2.9, 12 shifts) leads; a and b tie on 2.5 (a has more shifts); d's 3.1 from 5 shifts is too few to rank; c last
  assert.deepEqual(sortVenues(list).map((x) => x.key), ['e', 'a', 'b', 'd', 'c']);
  assert.deepEqual(sortVenues(list, 'shifts').map((x) => x.key), ['a', 'e', 'b', 'd', 'c']);
  assert.deepEqual(sortVenues(list, 'last_visit').map((x) => x.key), ['d', 'b', 'a', 'e', 'c']);
});
