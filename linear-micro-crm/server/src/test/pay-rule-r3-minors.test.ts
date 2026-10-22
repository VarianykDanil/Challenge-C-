/**
 * P1 pay-rule, last fix round (re-review minors):
 *  - an UNPAID run made by the 1.2 code (no stored calculation) shows its own figures once the live calculation moved
 *    away from it (a plan change), so the breakdown and Mark paid agree;
 *  - a paid 1.2 week is corrected at the rate it was paid at, not the person's plan of today;
 *  - removing a bonus cannot take a finished unpaid week below £0;
 *  - a correction Linear Hub moves on from a week with no work is recorded in the audit trail as an automatic step;
 *  - a statement line whose total ends up the other way from its subs is worded (and kinded) by its total.
 *
 * Business clock Thu 15 Oct 2026 15:00 (London). PAY_RULE_FROM = Mon 7 Sep 2026. FXC £10 a sub.
 *   Rita  W0 w/c 31 Aug  (1.2 plan week) Mon–Tue 2 + 2 = 4 sales: 2 × £60 + 4 × £45 = £300                (paid)
 *   Bo    W0             (1.2 plan week) Mon 2 sales: £60 + 2 × £45 = £150                               (unpaid)
 *   Remy  W2 w/c 21 Sep  Mon–Wed 10 a day = 30 × £10 = £300 > £190.50                → commission £300   (paid)
 *   Bo    W4 w/c 5 Oct   Mon, no subs                                                → base £63.50       (unpaid)
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySentence, type WeekPayBreakdown } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { materialisePayrollRuns } from '../db/maintenance.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { applyConfirmedSales, weekPayBreakdown } from '../lib/payRule.ts';
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
const fx = () => srv.fixture!;

const runOf = (userId: number, week: string) =>
  get<Json>(srv.db, `SELECT id, status, days_worked AS days, sales, base_pay AS base, commission, bonus, overrides, gross, breakdown_json AS json FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, week]);
const linesOf = (userId: number) =>
  all<Json>(srv.db, `SELECT id, kind, amount, note, target_week_start AS target, source_week_start AS source, statement_id AS statementId FROM pay_adjustments WHERE user_id = ? ORDER BY id`, [userId]);

function day(date: string, sales: number, userId: number, teamId: number, campaignId = fx().campaignId): number {
  const existing = get<{ id: number }>(srv.db, `SELECT id FROM events WHERE team_id = ? AND date = ? AND campaign_id = ? ORDER BY id LIMIT 1`, [teamId, date, campaignId]);
  const eventId = existing?.id ?? addEvent(srv.db, { campaignId, teamId, date });
  return addGauge(srv.db, { eventId, userId, date, stops: 60, sales });
}

/** A run as the 1.2 code left it: no stored calculation and none of the 1.3 columns. */
const as12 = (userId: number, week: string) =>
  run(srv.db, `UPDATE payroll_runs SET breakdown_json = NULL, paid_as = NULL, sales_logged = NULL, sales_confirmed = NULL, sales_cancelled = NULL, adjustments_total = NULL WHERE user_id = ? AND week_start = ?`, [userId, week]);

before(async () => {
  srv = await startTestServer({ today: TODAY });
  const { db } = srv;
  const f = fx();
  run(db, `INSERT INTO meta (key, value) VALUES ('ext:pay:rule_from', '2026-09-07'), ('ext:pay:day_rate', '63.5')`);
  const start = get<{ s: string }>(db, `SELECT start_date AS s FROM campaigns WHERE id = ?`, [f.campaignId])!.s;
  run(db, `UPDATE campaigns SET rep_commission_per_sale = 10 WHERE id = ?`, [f.campaignId]);
  run(db, `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 10, 120, ?, 'seed', NULL, NULL, '2026-01-01T00:00:00Z')`, [f.campaignId, start]);
  const { rep: remy, repA2: rita, repB: bo } = f.users;
  const { a, b } = f.teams;
  day('2026-08-31', 2, rita, a);
  day('2026-09-01', 2, rita, a);
  day('2026-08-31', 2, bo, b);
  [10, 10, 10].forEach((n, i) => day(`2026-09-2${1 + i}`, n, remy, a));
  day('2026-10-05', 0, bo, b);
  materialisePayrollRuns(db, TODAY);
  admin = await srv.login('admin');
  for (const [u, w, d] of [[rita, W0, '2026-09-11'], [remy, W2, '2026-10-02']] as const) {
    assert.equal((await admin.post(`/finance/payroll/${runOf(u, w).id}/pay`, { paidDate: d })).status, 200);
  }
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('an unpaid run made by 1.2 shows its own figures after a plan change, so the breakdown agrees with Mark paid', async () => {
  const f = fx();
  const bo = f.users.repB;
  as12(bo, W0);
  assert.deepEqual([runOf(bo, W0).gross, runOf(bo, W0).status], [150, 'pending']);
  const fresh = weekPayBreakdown(srv.db, bo, W0, { today: TODAY })!;
  assert.deepEqual([fresh.rule, fresh.gross, fresh.basePay, fresh.commission, fresh.asCalculated], ['plan', 150, 60, 90, false], 'the live calculation still equals the run');
  // the trainee plan pays £50 a day and £40 a sale: the live figure would be £130; the run (what Mark paid pays) stays £150
  assert.equal((await admin.patch(`/users/${bo}`, { payPlanId: f.plans.trainee })).status, 200);
  assert.equal(runOf(bo, W0).gross, 150);
  const b = (await admin.get(`/pay/breakdown?userId=${bo}&weekStart=${W0}`)).json as WeekPayBreakdown;
  assert.deepEqual([b.rule, b.status, b.gross, b.basePay, b.commission, b.daysWorked], ['plan', 'pending', 150, 60, 90, 1]);
  assert.equal(b.lines.reduce((s, l) => s + (l.paid ? l.amount : 0), 0), 150, 'the lines add up to the run');
  assert.ok(b.explanation.includes('Total: £150.00.'), b.explanation.join(' | '));
  assert.equal((await admin.patch(`/users/${bo}`, { payPlanId: f.plans.rep })).status, 200);
});

test('a paid 1.2 week is corrected at the rate it was paid at, not at the plan the person is on today', async () => {
  const f = fx();
  const rita = f.users.repA2;
  as12(rita, W0);
  assert.equal((await admin.patch(`/users/${rita}`, { payPlanId: f.plans.trainee })).status, 200);
  // 3 of the 4 sales paid at £45 → −£45 (the trainee plan's £40 a sale would say −£40)
  const p = applyConfirmedSales(srv.db, [{ userId: rita, campaignId: f.campaignId, weekStart: W0, confirmed: 3 }], { statementId: 701, actorId: f.users.admin, dryRun: true }).people[0]!;
  assert.deepEqual([p.effect, p.logged, p.before.gross, p.after.gross, p.difference], ['adjustment', 4, 300, 255, -45]);
  assert.equal((await admin.patch(`/users/${rita}`, { payPlanId: f.plans.rep })).status, 200);
});

test('removing a bonus cannot take a finished unpaid week below £0; nothing is removed', async () => {
  const f = fx();
  const bo = f.users.repB;
  assert.equal(runOf(bo, W4).gross, 63.5);
  const bonus = await admin.post('/pay/bonuses', { userId: bo, weekStart: W4, amount: 50, note: 'Top week' });
  assert.equal(bonus.status, 201);
  const take = await admin.post('/pay/adjustments', { userId: bo, targetWeekStart: W4, amount: -103.5, note: 'Advance repaid' });
  assert.equal(take.status, 201, 'the bonus made room for it');
  assert.equal(runOf(bo, W4).gross, 10);
  const del = await admin.del(`/pay/adjustments/${bonus.json.id}`);
  assert.equal(del.status, 400);
  assert.equal(del.json.error, "Removing this would take Bo's pay for w/c 5 Oct below £0 (−£40.00), so it could not be paid. Remove or reduce the lines that take money off that week first.");
  assert.equal(runOf(bo, W4).gross, 10, 'nothing changed');
  assert.equal(linesOf(bo).filter((l) => l.id === bonus.json.id).length, 1, 'the bonus is still there');
  // the other order works: take the deduction off first, then the bonus
  assert.equal((await admin.del(`/pay/adjustments/${take.json.id}`)).status, 204);
  assert.equal((await admin.del(`/pay/adjustments/${bonus.json.id}`)).status, 204);
  assert.equal(runOf(bo, W4).gross, 63.5);
  // removing a negative line is never refused
  const neg = await admin.post('/pay/adjustments', { userId: bo, targetWeekStart: W4, amount: -10, note: 'Lanyard' });
  assert.equal((await admin.del(`/pay/adjustments/${neg.json.id}`)).status, 204);
});

test('a correction moved on from a week with no work is recorded as an automatic step (one row for the whole move)', async () => {
  const f = fx();
  const bo = f.users.repB;
  const res = await admin.post('/pay/adjustments', { userId: bo, targetWeekStart: W1, amount: -20, note: 'Lanyard not returned' });
  assert.equal(res.status, 201);
  assert.equal(res.json.targetWeekStart, W4, 'W1, W2 and W3 were not worked: the line lands on W4');
  const sys = all<Json>(srv.db, `SELECT user_id AS userId, action, entity, entity_id AS entityId, summary, kind FROM audit_log WHERE action = 'SYSTEM pay.carry_forward' ORDER BY id`);
  assert.equal(sys.length, 1, sys.map((s) => s.summary).join(' | '));
  assert.deepEqual([sys[0]!.userId, sys[0]!.entity, sys[0]!.entityId, sys[0]!.kind], [null, 'pay_adjustment', res.json.id, 'automatic']);
  assert.equal(sys[0]!.summary, 'Moved 1 correction (−£20) for Bo Rep from w/c 14 Sep to w/c 5 Oct: no work that week');
  // nothing moves when the week is synced again
  materialisePayrollRuns(srv.db, TODAY);
  assert.equal(all(srv.db, `SELECT 1 FROM audit_log WHERE action = 'SYSTEM pay.carry_forward'`).length, 1);
  assert.equal((await admin.del(`/pay/adjustments/${res.json.id}`)).status, 204);
});

test('a statement line whose total ends up the other way from its subs is worded and kinded by its total', () => {
  const f = fx();
  const remy = f.users.rep;
  // S601: 28 of 30 (−£20); S602: 25 (−£30 more, −£50 in all); S601 re-read with 28: its line becomes +£10
  applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 28 }], { statementId: 601, actorId: f.users.admin });
  applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 25 }], { statementId: 602, actorId: f.users.admin });
  const c = applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 28 }], { statementId: 601, actorId: f.users.admin }).people[0]!;
  const lines = linesOf(remy);
  assert.equal(Math.round(lines.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100, -20, 'the totals stay right: corrected − paid');
  const s601 = lines.find((l) => l.statementId === 601)!;
  assert.deepEqual([s601.kind, s601.amount, s601.target], ['statement', 10, THIS_WEEK]);
  assert.equal(s601.note, "FXC confirmed 28 of the 30 paid for, which changes the week's earlier correction");
  assert.equal(c.sentence, "Paid for 30, 2 cancelled by FXC, which changes the week's earlier correction: +£10.00 on the pay for w/c 12 Oct.");
  assert.equal(lines.find((l) => l.statementId === 602)!.kind, 'cancellation');
  // the shared sentence, the other way round: more confirmed but the line comes off
  assert.equal(
    applySentence({ logged: 30, confirmed: 32, campaignCode: 'FXC', effect: 'adjustment', before: { gross: 300, paidAs: 'commission' }, after: { gross: 290, paidAs: 'commission' }, difference: -10, targetWeekStart: THIS_WEEK, paidFor: 30 }),
    "Paid for 30, FXC confirmed 2 more, which changes the week's earlier correction: −£10.00 on the pay for w/c 12 Oct.",
  );
  void W3;
});

test('replacesStatementId: the replaced statement’s line on an unpaid week is handed over and updated in place (P3 never writes pay lines)', () => {
  const f = fx();
  const remy = f.users.rep;
  // after the test above: S601 +£10 and S602 −£30 on w/c 12 Oct, the week confirmed at 28 (−£20 in all)
  const before = linesOf(remy).map((l) => [l.statementId, l.amount]);
  assert.deepEqual(before, [[601, 10], [602, -30]]);
  // a preview (dry run) hands nothing over
  applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 26 }], { statementId: 803, actorId: f.users.admin, dryRun: true, replacesStatementId: 602 });
  assert.deepEqual(linesOf(remy).map((l) => [l.statementId, l.amount]), before);
  // S803 replaces S602 and confirms 26: 26 × £10 = £260 against £300 paid → −£40 in all; S602's line becomes S803's
  const p = applyConfirmedSales(srv.db, [{ userId: remy, campaignId: f.campaignId, weekStart: W2, confirmed: 26 }], { statementId: 803, actorId: f.users.admin, replacesStatementId: 602 }).people[0]!;
  assert.deepEqual([p.effect, p.difference, p.targetWeekStart], ['adjustment', -20, THIS_WEEK]);
  assert.equal(p.sentence, 'Paid for 30, 4 cancelled by FXC, so −£50.00 on the pay for w/c 12 Oct.');
  assert.deepEqual(linesOf(remy).map((l) => [l.statementId, l.amount, l.kind]), [[601, 10, 'statement'], [803, -50, 'cancellation']], 'one line per statement: no second, contradictory one');
  assert.throws(() => applyConfirmedSales(srv.db, [], { statementId: 803, actorId: null, replacesStatementId: 803 }), /replacesStatementId/);
});
