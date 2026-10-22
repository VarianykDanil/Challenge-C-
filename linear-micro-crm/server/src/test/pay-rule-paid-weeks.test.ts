/**
 * P1 pay-rule, review fixes: what happens to weeks that are already PAID.
 *  - A correction on a week the person did not work moves on to the next UNPAID week (never into a paid one).
 *  - A statement on a paid week corrects by (corrected − paid): the week recalculated from the run's own stored inputs
 *    (the day rate, the rates and the logged subs it was paid with), not from today's gauges, rates or day rate.
 *  - A paid 1.2 run (no stored calculation) shows the figures it was paid with, even after its gauges change.
 *  - A run below £0 cannot be marked paid; a manual line that would take a finished week below £0 is refused.
 *  - The recalculations a settings or rate change makes are audited, and a dated rate takes over with the 15-minute sweep.
 *
 * Business clock Thu 15 Oct 2026 15:00 (London). PAY_RULE_FROM = Mon 7 Sep 2026. FXC £10 a sub, FXB £20 a sub.
 *   Rita  W0 w/c 31 Aug  (1.2 plan week) Mon–Tue 2 + 2 = 4 sales: 2 × £60 + 4 × £45 = £300                (paid)
 *   Lee   W0             (1.2 plan week) Mon 1 sale: £80 + £45 + overrides 4 team sales × £5 = £145      (paid)
 *   Remy  W1 w/c 14 Sep  Mon–Thu 5+4+5+4 = 18 × £10 = £180 < 4 × £63.50 = £254       → base £254         (paid)
 *   Rita  W1             the same                                                    → base £254         (paid)
 *   Remy  W2 w/c 21 Sep  Mon–Wed 10 a day = 30 × £10 = £300 > £190.50                → commission £300   (paid)
 *   Bo    W2             Mon–Tue 1 a day = 2 × £10 = £20 < £127                      → base £127         (paid)
 *   Lee   W2             Mon–Fri FXC 2 a day (10 × £10) + Mon–Wed FXB 4 a day (12 × £20) = £340 > £317.50
 *                                                                                    → commission £340   (paid)
 *   Bo    W4 w/c 5 Oct   Mon, no subs                                                → base £63.50       (unpaid)
 *   Rita  W4             Mon–Tue 3 a day = 6 × £10 = £60 < £127                      → base £127         (unpaid)
 * The fixture's recruiter is paid Mon–Fri at the day rate every week (unpaid runs).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { auditMoney, type WeekPayBreakdown } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { rollForwardEventStatuses, syncPayrollRun, materialisePayrollRuns } from '../db/maintenance.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { addCampaignRate, applyConfirmedSales, weekPayBreakdown } from '../lib/payRule.ts';
import { addEvent, addGauge, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
setBusinessClock(new Date(`${TODAY}T15:00:00`));

const W0 = '2026-08-31';
const W1 = '2026-09-14';
const W2 = '2026-09-21';
const W3 = '2026-09-28';
const W4 = '2026-10-05';
const THIS_WEEK = '2026-10-12';

let srv: TestServer;
let admin: TestClient;
let rep: TestClient;
let fxb = 0;
const fx = () => srv.fixture!;

const runOf = (userId: number, week: string) =>
  get<Json>(srv.db, `SELECT id, status, days_worked AS days, sales, base_pay AS base, commission, bonus, overrides, gross, paid_as AS paidAs,
                            adjusted_at AS adjustedAt, breakdown_json AS json FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, week]);
const linesOf = (userId: number) =>
  all<Json>(srv.db, `SELECT id, kind, amount, target_week_start AS target, source_week_start AS source, statement_id AS statementId, campaign_id AS campaignId FROM pay_adjustments WHERE user_id = ? ORDER BY id`, [userId]);
const payUser = (id: number) =>
  get<Json>(srv.db, `SELECT id, employee_id AS employeeId, team_id AS teamId, pay_plan_id AS payPlanId, role, start_date AS startDate FROM users WHERE id = ?`, [id])! as never;

/** One gauge for `userId` on `date` at the team's event for that campaign (created when missing). Returns the gauge id. */
function day(date: string, sales: number, userId: number, teamId: number, campaignId = fx().campaignId): number {
  const existing = get<{ id: number }>(srv.db, `SELECT id FROM events WHERE team_id = ? AND date = ? AND campaign_id = ? ORDER BY id LIMIT 1`, [teamId, date, campaignId]);
  const eventId = existing?.id ?? addEvent(srv.db, { campaignId, teamId, date });
  return addGauge(srv.db, { eventId, userId, date, stops: 60, sales });
}
/** Every unpaid run's gross, by id. */
const unpaidGross = () => new Map(all<Json>(srv.db, `SELECT id, gross FROM payroll_runs WHERE status IN ('pending', 'failed')`).map((r) => [Number(r.id), Number(r.gross)]));
/** The runs whose gross moved between two readings, with their totals before and after. */
function movedRuns(a: Map<number, number>, b: Map<number, number>): { count: number; from: number; to: number } {
  let count = 0, from = 0, to = 0;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(id) === b.get(id)) continue;
    count++;
    from += a.get(id) ?? 0;
    to += b.get(id) ?? 0;
  }
  return { count, from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 };
}
const gaugeOn = (userId: number, date: string) => Number(get<Json>(srv.db, `SELECT id FROM gauge_entries WHERE user_id = ? AND date = ? ORDER BY id LIMIT 1`, [userId, date])!.id);

before(async () => {
  srv = await startTestServer({ today: TODAY });
  const { db } = srv;
  const f = fx();
  run(db, `INSERT INTO meta (key, value) VALUES ('ext:pay:rule_from', '2026-09-07'), ('ext:pay:day_rate', '63.5')`);
  const start = get<{ s: string }>(db, `SELECT start_date AS s FROM campaigns WHERE id = ?`, [f.campaignId])!.s;
  run(db, `UPDATE campaigns SET rep_commission_per_sale = 10 WHERE id = ?`, [f.campaignId]);
  run(db, `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 10, 120, ?, 'seed', NULL, NULL, '2026-01-01T00:00:00Z')`, [f.campaignId, start]);
  fxb = run(db, `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
                 VALUES ('Fixture Broadband', 'FXB', 'b2b', 'broadband', 60, 20, '#0EA5E9', 1, ?, NULL)`, [start]).lastInsertRowid;
  run(db, `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 20, 60, ?, 'seed', NULL, NULL, '2026-01-01T00:00:00Z')`, [fxb, start]);
  const { rep: remy, repA2: rita, repB: bo, leader: lee } = f.users;
  const { a, b } = f.teams;
  day('2026-08-31', 2, rita, a);
  day('2026-09-01', 2, rita, a);
  day('2026-08-31', 1, lee, a);
  [5, 4, 5, 4].forEach((n, i) => day(`2026-09-1${4 + i}`, n, remy, a));
  [5, 4, 5, 4].forEach((n, i) => day(`2026-09-1${4 + i}`, n, rita, a));
  [10, 10, 10].forEach((n, i) => day(`2026-09-2${1 + i}`, n, remy, a));
  day('2026-09-21', 1, bo, b);
  day('2026-09-22', 1, bo, b);
  ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].forEach((d) => day(d, 2, lee, a));
  ['2026-09-21', '2026-09-22', '2026-09-23'].forEach((d) => day(d, 4, lee, a, fxb));
  day('2026-10-05', 0, bo, b);
  day('2026-10-05', 3, rita, a);
  day('2026-10-06', 3, rita, a);
  materialisePayrollRuns(db, TODAY);
  [admin, rep] = await Promise.all([srv.login('admin'), srv.login('rep')]);
  const paid: [number, string, string][] = [
    [rita, W0, '2026-09-11'], [lee, W0, '2026-09-11'], [remy, W1, '2026-09-25'], [rita, W1, '2026-09-25'],
    [remy, W2, '2026-10-02'], [bo, W2, '2026-10-02'], [lee, W2, '2026-10-02'],
  ];
  for (const [u, w, d] of paid) {
    const r = runOf(u, w);
    assert.ok(r, `a run for ${u} ${w}`);
    assert.equal((await admin.post(`/finance/payroll/${r.id}/pay`, { paidDate: d })).status, 200);
  }
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('the fixture: plan weeks and rule weeks paid as the header says', () => {
  const f = fx();
  const g = (u: number, w: string) => [runOf(u, w).gross, runOf(u, w).paidAs, runOf(u, w).status];
  assert.deepEqual(g(f.users.repA2, W0), [300, null, 'paid']);
  assert.deepEqual(g(f.users.leader, W0), [145, null, 'paid']);
  assert.deepEqual(g(f.users.rep, W1), [254, 'base', 'paid']);
  assert.deepEqual(g(f.users.rep, W2), [300, 'commission', 'paid']);
  assert.deepEqual(g(f.users.repB, W2), [127, 'base', 'paid']);
  assert.deepEqual(g(f.users.leader, W2), [340, 'commission', 'paid']);
  assert.deepEqual(g(f.users.repB, W4), [63.5, 'base', 'pending']);
  assert.deepEqual(g(f.users.repA2, W4), [127, 'base', 'pending']);
  assert.equal(runOf(f.users.repB, W1), undefined, 'Bo did not work in W1');
  assert.equal(runOf(f.users.repB, W3), undefined, 'nor in W3');
  // every run stores the calculation it was made with, a 1.2 plan week too, with what it was calculated from
  for (const [u, w] of [[f.users.rep, W2], [f.users.repA2, W0]] as const) {
    const snap = JSON.parse(runOf(u, w).json);
    assert.ok(snap.inputs, `${u} ${w} keeps its inputs`);
  }
  assert.equal(JSON.parse(runOf(f.users.repA2, W0).json).rule, 'plan');
});

test('a manual line on a past week the person did not work goes on the next UNPAID week, never a paid one', async () => {
  const f = fx();
  const bo = f.users.repB;
  const res = await admin.post('/pay/adjustments', { userId: bo, targetWeekStart: W1, amount: -20, note: 'Lanyard not returned' });
  assert.equal(res.status, 201);
  assert.equal(res.json.targetWeekStart, W4, 'W1 and W3 were not worked and W2 is paid: the line lands on W4, the next unpaid week');
  assert.deepEqual([runOf(bo, W2).gross, runOf(bo, W2).status], [127, 'paid'], 'the paid week is untouched');
  assert.equal(runOf(bo, W4).gross, 43.5, '£63.50 − £20');
  const w2 = weekPayBreakdown(srv.db, bo, W2, { today: TODAY })!;
  assert.deepEqual([w2.gross, w2.adjustments.length], [127, 0]);
  assert.equal((await admin.del(`/pay/adjustments/${res.json.id}`)).status, 204, 'and it can still be removed');
  assert.equal(runOf(bo, W4).gross, 63.5);
  // a statement line placed on the empty week moves the same way
  run(srv.db, `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, campaign_id, statement_id, invoice_id, created_by, created_at)
               VALUES (?, ?, ?, 'cancellation', -10, '1 cancelled by FXC: paid for 2, confirmed 1', ?, 90, NULL, NULL, '2026-10-13T09:00:00Z')`, [bo, W1, W2, f.campaignId]);
  assert.equal(syncPayrollRun(srv.db, payUser(bo), W1, TODAY), 'unchanged');
  assert.deepEqual(linesOf(bo).filter((l) => l.statementId === 90).map((l) => l.target), [W4]);
  assert.equal(runOf(bo, W4).gross, 53.5);
  run(srv.db, `DELETE FROM pay_adjustments WHERE statement_id = 90`);
  syncPayrollRun(srv.db, payUser(bo), W4, TODAY);
  assert.equal(runOf(bo, W4).gross, 63.5);
});

test('a run below £0 cannot be marked paid; a manual line that would take a finished week below £0 is refused', async () => {
  const f = fx();
  const bo = f.users.repB;
  const refused = await admin.post('/pay/adjustments', { userId: bo, targetWeekStart: W4, amount: -100, note: 'Advance repaid' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, "That would take Bo's pay for w/c 5 Oct below £0 (−£36.50). Take off at most £63.50 here and put the rest on a later week.");
  assert.equal(runOf(bo, W4).gross, 63.5, 'nothing was written');
  assert.equal(linesOf(bo).length, 0);
  // a statement correction can still be bigger than the week it lands on
  run(srv.db, `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, campaign_id, statement_id, invoice_id, created_by, created_at)
               VALUES (?, ?, ?, 'cancellation', -100, '10 cancelled by FXC: paid for 10, confirmed 0', ?, 91, NULL, NULL, '2026-10-13T09:00:00Z')`, [bo, W4, W2, f.campaignId]);
  syncPayrollRun(srv.db, payUser(bo), W4, TODAY);
  const r = runOf(bo, W4);
  assert.equal(r.gross, -36.5);
  const pay = await admin.post(`/finance/payroll/${r.id}/pay`, { paidDate: TODAY });
  assert.equal(pay.status, 409);
  assert.equal(pay.json.error, "Bo's pay for w/c 5 Oct comes to −£36.50, below £0, so it cannot be marked paid. Add an adjustment to carry part of a correction to a later week first.");
  assert.equal(runOf(bo, W4).status, 'pending');
  const office = weekPayBreakdown(srv.db, bo, W4, { today: TODAY, viewerId: f.users.admin })!;
  assert.equal(office.explanation.at(-1), "Bo's corrections come to more than this week's pay, so the total is below £0 (−£36.50) and nothing can be paid for it as it is. The £36.50 owed is settled with Bo, for example on a later week.");
  const own = weekPayBreakdown(srv.db, bo, W4, { today: TODAY, viewerId: bo })!;
  assert.equal(own.explanation.at(-1), "Your corrections come to more than this week's pay, so the total is below £0 (−£36.50) and nothing can be paid for it as it is. The office will agree with you how the £36.50 is settled, for example on a later week.");
  run(srv.db, `DELETE FROM pay_adjustments WHERE statement_id = 91`);
  syncPayrollRun(srv.db, payUser(bo), W4, TODAY);
  assert.equal(runOf(bo, W4).gross, 63.5);
});

test('a statement on a paid week compares with what was paid, not with gauges edited since (no change when it confirms what was paid)', async () => {
  const f = fx();
  const remy = f.users.rep;
  // the office raises Thursday 17 Sep from 4 to 14 subs after W1 was paid: the run stays as paid, flagged
  const patch = await admin.patch(`/gauges/${gaugeOn(remy, '2026-09-17')}`, { sales: 14, taps: 14, closes: 14, presentations: 20, table: 30, stops: 60 });
  assert.equal(patch.status, 200);
  const w1 = runOf(remy, W1);
  assert.deepEqual([w1.gross, w1.status], [254, 'paid']);
  assert.ok(w1.adjustedAt, 'flagged as adjusted after payment');
  // FXC confirms the 18 subs Remy was paid for: nothing to correct
  const same = applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W1, confirmed: 18 }], { statementId: 501, actorId: f.users.admin });
  const p = same.people[0]!;
  assert.deepEqual([p.effect, p.difference, p.logged, p.confirmed, p.cancelled, p.before.gross, p.after.gross], ['no-change', 0, 18, 18, 0, 254, 254]);
  assert.equal(p.sentence, 'All 18 confirmed by FXC: no change.');
  assert.equal(linesOf(remy).length, 0);
  // 16 of the 18: £160 is still below the £254 base it was paid
  const fewer = applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W1, confirmed: 16 }], { statementId: 501, actorId: f.users.admin });
  assert.deepEqual([fewer.people[0]!.effect, fewer.people[0]!.difference], ['no-change', 0]);
  assert.equal(fewer.people[0]!.sentence, '2 cancelled by FXC, but the base still applied: no change.');
  // the paid week's breakdown keeps the figures it was paid with and says the gauges changed afterwards
  const b = (await rep.get(`/pay/breakdown?weekStart=${W1}`)).json as WeekPayBreakdown;
  assert.deepEqual([b.status, b.gross, b.baseAmount, b.salesLogged], ['paid', 254, 254, 18]);
  assert.ok(b.explanation.some((s) => /^The gauges for this week were changed after it was paid; the figures here are what it was paid with\.$/.test(s)), b.explanation.join(' | '));
});

test('a rate dated in the past leaves a paid week at the rate it was paid: the correction is subs × the rate paid', async () => {
  const f = fx();
  const remy = f.users.rep;
  addCampaignRate(srv.db, { campaignId: f.campaignId, repRate: 12, payoutRate: 120, effectiveFrom: W2 }, f.users.admin);
  assert.equal(runOf(remy, W2).gross, 300, 'the paid run keeps £10 a sub');
  const r = applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 28 }], { statementId: 502, actorId: f.users.admin });
  const p = r.people[0]!;
  // 28 × £10 = £280 (still above the £190.50 base) against the £300 paid → −£20
  assert.deepEqual([p.effect, p.before.gross, p.after.gross, p.difference, p.targetWeekStart], ['adjustment', 300, 280, -20, THIS_WEEK]);
  assert.deepEqual([p.before.paidAs, p.after.paidAs], ['commission', 'commission']);
  assert.equal(p.sentence, 'Paid for 30, 2 cancelled by FXC, so −£20.00 on the pay for w/c 12 Oct.');
  assert.deepEqual(linesOf(remy).map((l) => [l.kind, l.amount, l.source, l.target]), [['cancellation', -20, W2, THIS_WEEK]]);
  // applied again: nothing more
  const again = applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 28 }], { statementId: 502, actorId: f.users.admin });
  assert.deepEqual([again.people[0]!.effect, again.people[0]!.difference, again.people[0]!.before.gross], ['no-change', 0, 280]);
  assert.equal(linesOf(remy).length, 1);
  // put the rate back so the other tests read £10
  run(srv.db, `DELETE FROM campaign_rates WHERE campaign_id = ? AND rep_rate = 12`, [f.campaignId]);
  run(srv.db, `UPDATE campaigns SET rep_commission_per_sale = 10 WHERE id = ?`, [f.campaignId]);
});

test('a day-rate change after payment does not move a paid week; the settings change audits the runs it recalculated', async () => {
  const f = fx();
  const rita = f.users.repA2;
  const before = unpaidGross();
  const res = await admin.put('/pay/settings', { dayRate: 70 });
  assert.equal(res.status, 200);
  assert.equal(runOf(f.users.repB, W4).gross, 70, 'the unpaid week follows the new day rate');
  const moved = movedRuns(before, unpaidGross());
  assert.ok(moved.count >= 3, 'Bo, Rita and the recruiter');
  const audit = all<Json>(srv.db, `SELECT entity, summary FROM audit_log WHERE action = 'PUT /pay/settings' ORDER BY id`);
  assert.deepEqual(audit.map((a) => a.entity), ['settings', 'payroll_run']);
  assert.equal(audit[1]!.summary, `Recalculated ${moved.count} unpaid pay runs after the pay settings change: ${auditMoney(moved.from)} → ${auditMoney(moved.to)} in all`);
  // FXC confirms 30 for Rita's W1 (paid as the base, £254 at £63.50 a day): 30 × £10 = £300 beats £254 → +£46
  const r = applyConfirmedSales(srv.db, [{ userId: rita, campaignId: f.campaignId, weekStart: W1, confirmed: 30 }], { statementId: 503, actorId: f.users.admin });
  const p = r.people[0]!;
  assert.deepEqual([p.effect, p.before.gross, p.after.gross, p.difference, p.targetWeekStart], ['adjustment', 254, 300, 46, W4]);
  assert.deepEqual([p.before.paidAs, p.after.paidAs], ['base', 'commission']);
  assert.equal(p.sentence, 'Paid for 18, FXC confirmed 12 more, so +£46.00 on the pay for w/c 5 Oct.');
  assert.equal((await admin.put('/pay/settings', { dayRate: 63.5 })).status, 200);
  assert.equal(runOf(f.users.repB, W4).gross, 63.5);
});

test('statements for two campaigns on one paid week: the second sees the first one’s correction', () => {
  const f = fx();
  const lee = f.users.leader;
  // FXC confirms 5 of 10: £50 + £240 = £290 < £317.50 → the base → −£22.50
  const a = applyConfirmedSales(srv.db, [{ userId: lee, campaignId: f.campaignId, weekStart: W2, confirmed: 5 }], { statementId: 504, actorId: f.users.admin }).people[0]!;
  assert.deepEqual([a.effect, a.before.gross, a.after.gross, a.difference], ['adjustment', 340, 317.5, -22.5]);
  // FXB confirms 6 of 12: £50 + £120 = £170, still the base, which the correction above already pays → no change
  const b = applyConfirmedSales(srv.db, [{ userId: lee, campaignId: fxb, weekStart: W2, confirmed: 6 }], { statementId: 505, actorId: f.users.admin }).people[0]!;
  assert.deepEqual([b.effect, b.before.gross, b.after.gross, b.difference], ['no-change', 317.5, 317.5, 0]);
  assert.equal(b.sentence, '6 cancelled by FXB, but the base still applied: no change.');
  // the first statement again: idempotent
  const again = applyConfirmedSales(srv.db, [{ userId: lee, campaignId: f.campaignId, weekStart: W2, confirmed: 5 }], { statementId: 504, actorId: f.users.admin }).people[0]!;
  assert.deepEqual([again.effect, again.difference], ['no-change', 0]);
  assert.deepEqual(linesOf(lee).map((l) => [l.amount, l.statementId]), [[-22.5, 504]]);
  // the one statement, both campaigns in one call (a dry run): the second row sees the first
  const both = applyConfirmedSales(srv.db, [
    { userId: lee, campaignId: f.campaignId, weekStart: W2, confirmed: 10 },
    { userId: lee, campaignId: fxb, weekStart: W2, confirmed: 12 },
  ], { statementId: 504, actorId: f.users.admin, dryRun: true });
  assert.deepEqual(both.people.map((p) => [p.campaignId, p.difference]), [[f.campaignId, 0], [fxb, 22.5]], 'all confirmed: the £22.50 comes back');
  assert.equal(both.people[1]!.sentence, "FXB confirmed all 12 subs paid for, which changes the week's earlier correction: +£22.50 on the pay for w/c 12 Oct.");
  assert.equal(both.totalDifference, 22.5);
});

test('a 1.2 run paid before the upgrade (no stored calculation) shows what was paid after its gauges change, and is corrected from it', async () => {
  const f = fx();
  const rita = f.users.repA2;
  // a run made by 1.2: no stored calculation, no 1.3 columns
  run(srv.db, `UPDATE payroll_runs SET breakdown_json = NULL, paid_as = NULL, sales_logged = NULL, sales_confirmed = NULL, sales_cancelled = NULL, adjustments_total = NULL WHERE user_id = ? AND week_start = ?`, [rita, W0]);
  const fresh = weekPayBreakdown(srv.db, rita, W0, { today: TODAY })!;
  assert.deepEqual([fresh.rule, fresh.status, fresh.gross, fresh.basePay, fresh.commission], ['plan', 'paid', 300, 120, 180]);
  // Monday raised from 2 to 6 sales after payment
  const patch = await admin.patch(`/gauges/${gaugeOn(rita, '2026-08-31')}`, { sales: 6, taps: 6, closes: 6, presentations: 12, table: 20, stops: 60 });
  assert.equal(patch.status, 200);
  assert.deepEqual([runOf(rita, W0).gross, runOf(rita, W0).status], [300, 'paid']);
  const b = (await admin.get(`/pay/breakdown?userId=${rita}&weekStart=${W0}`)).json as WeekPayBreakdown;
  assert.deepEqual([b.rule, b.status, b.gross, b.basePay, b.commission, b.salesLogged, b.daysWorked], ['plan', 'paid', 300, 120, 180, 4, 2]);
  assert.equal(b.lines.reduce((s, l) => s + (l.paid ? l.amount : 0), 0), 300, 'the lines add up to what was paid');
  assert.ok(b.explanation.includes('Total: £300.00.'), b.explanation.join(' | '));
  assert.ok(b.explanation.includes('The gauges for this week were changed after it was paid; the figures here are what it was paid with.'));
  // a statement for that week: 3 of the 4 sales paid → −£45 at the plan's £45 a sale
  const p = applyConfirmedSales(srv.db, [{ userId: rita, campaignId: f.campaignId, weekStart: W0, confirmed: 3 }], { statementId: 506, actorId: f.users.admin }).people[0]!;
  assert.deepEqual([p.effect, p.logged, p.before.gross, p.after.gross, p.difference], ['adjustment', 4, 300, 255, -45]);
  assert.equal(p.sentence, 'Paid for 4, 1 cancelled by FXC, so −£45.00 on the pay for w/c 5 Oct.');
  // the leader's W0 (a plan week calculated by 1.3, stored) keeps its figures too: £145 with the £20 of overrides
  const lee = weekPayBreakdown(srv.db, f.users.leader, W0, { today: TODAY })!;
  assert.deepEqual([lee.rule, lee.gross, lee.overrides, lee.asCalculated], ['plan', 145, 20, true]);
  const q = applyConfirmedSales(srv.db, [{ userId: f.users.leader, campaignId: f.campaignId, weekStart: W0, confirmed: 0 }], { statementId: 506, actorId: f.users.admin }).people[0]!;
  assert.deepEqual([q.effect, q.before.gross, q.after.gross, q.difference], ['adjustment', 145, 100, -45], 'the overrides stay as paid');
});

test('a run stored before the inputs were kept is corrected from its own per-campaign figures', () => {
  const f = fx();
  const bo = f.users.repB;
  const r = runOf(bo, W2);
  const snap = JSON.parse(r.json);
  delete snap.inputs;
  run(srv.db, `UPDATE payroll_runs SET breakdown_json = ? WHERE id = ?`, [JSON.stringify(snap), r.id]);
  const p = applyConfirmedSales(srv.db, [{ userId: bo, campaignId: f.campaignId, weekStart: W2, confirmed: 0 }], { statementId: 507, actorId: f.users.admin }).people[0]!;
  assert.deepEqual([p.effect, p.difference, p.logged], ['no-change', 0, 2]);
  assert.equal(p.sentence, '2 cancelled by FXC, but the base still applied: no change.');
  const more = applyConfirmedSales(srv.db, [{ userId: bo, campaignId: f.campaignId, weekStart: W2, confirmed: 15 }], { statementId: 507, actorId: f.users.admin, dryRun: true }).people[0]!;
  assert.deepEqual([more.effect, more.difference], ['adjustment', 23], '15 × £10 = £150 beats the £127 base');
});

test('a new rate: the recalculation is audited; a dated rate takes over with the 15-minute sweep and is audited as automatic', async () => {
  const f = fx();
  const rita = runOf(f.users.repA2, W4).gross;
  const res = await admin.post('/pay/rates', { campaignId: f.campaignId, repRate: 30, payoutRate: 120, effectiveFrom: W4 });
  assert.equal(res.status, 201);
  // Rita's W4: 6 × £30 = £180 now beats the £127 base (her corrections stay on top); Bo's W4 had no subs
  assert.equal(runOf(f.users.repA2, W4).gross, rita + 53);
  const audit = all<Json>(srv.db, `SELECT entity, summary FROM audit_log WHERE action = 'POST /pay/rates' ORDER BY id`);
  assert.deepEqual(audit.map((a) => a.entity), ['campaign_rate', 'payroll_run']);
  assert.equal(audit[1]!.summary, `Recalculated 1 unpaid pay run after the rate change: ${auditMoney(rita)} → ${auditMoney(rita + 53)} in all`);
  // nothing moved → no recalculation row
  assert.equal((await admin.post('/pay/rates', { campaignId: fxb, repRate: 25, payoutRate: 60, effectiveFrom: W4 })).status, 201);
  assert.equal(all<Json>(srv.db, `SELECT entity FROM audit_log WHERE action = 'POST /pay/rates'`).length, 3);
  // a rate from tomorrow: not in effect yet; when the day comes the sweep makes it the campaign's own
  addCampaignRate(srv.db, { campaignId: f.campaignId, repRate: 31, payoutRate: 130, effectiveFrom: '2026-10-16' }, f.users.admin);
  assert.equal(Number(get<Json>(srv.db, `SELECT payout_per_sale AS p FROM campaigns WHERE id = ?`, [f.campaignId])!.p), 120);
  rollForwardEventStatuses(srv.db, '2026-10-16', '00:20');
  assert.deepEqual({ ...get<Json>(srv.db, `SELECT rep_commission_per_sale AS rep, payout_per_sale AS payout FROM campaigns WHERE id = ?`, [f.campaignId])! }, { rep: 31, payout: 130 });
  const sys = all<Json>(srv.db, `SELECT user_id AS userId, action, entity, entity_id AS entityId, summary FROM audit_log WHERE action = 'SYSTEM pay.rates' ORDER BY id`);
  assert.equal(sys.length, 1);
  assert.deepEqual([sys[0]!.userId, sys[0]!.entity, sys[0]!.entityId], [null, 'campaign', f.campaignId]);
  assert.equal(sys[0]!.summary, 'FXC rate from Fri 16 Oct in effect: £31 a sub to the rep (was £30), £130 payout (was £120)');
});
