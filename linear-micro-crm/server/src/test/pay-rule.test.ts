/**
 * P1 pay-rule: the 1.3 base-or-commission rule end to end on the fixture — runs, the breakdown, statements
 * (applyConfirmedSales: recalculated, corrected on the next unpaid week, no change, idempotent, dry run), bonuses,
 * manual adjustments, settings, campaign rates — with every role, a client account and anonymous callers, plus the
 * upgrade of a 1.2 database and the audit trail.
 *
 * Business clock pinned to Thu 15 Oct 2026 15:00 (London). PAY_RULE_FROM = Mon 7 Sep 2026. FXC (the fixture campaign)
 * paid £10 a sub until Wed 23 Sep and £15 from Thu 24 Sep (a client's commission change). Remy (field rep, team A):
 *   W1 w/c 14 Sep  Mon–Thu 5+4+5+4 = 18 subs × £10 = £180 < 4 × £63.50 = £254          → base £254 (paid)
 *   W2 w/c 21 Sep  Mon 6 + Tue 6 at £10, Thu 6 at £15 = £210 > 3 × £63.50 = £190.50     → commission £210 (paid)
 *   W3 w/c 28 Sep  Mon–Fri 6 a day = 30 × £15 = £450 > £317.50                          → commission £450 (unpaid)
 *   W4 w/c 5 Oct   Mon–Tue 2 a day = 4 × £15 = £60 < £127                                → base £127 (unpaid)
 *   this week      Mon 12 Oct 3 subs                                                     → an estimate
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApplyResult, WeekPayBreakdown } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { EXTENSIONS } from '../db/extensions/index.ts';
import { materialisePayrollRuns, syncPayrollRun } from '../db/maintenance.ts';
import { createSchema, SCHEMA_SQL, upgradeSchema } from '../db/schema.ts';
import { openDb } from '../db/connection.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { addCampaignRate, applyConfirmedSales, campaignRateOn, listCampaignRates, nextUnpaidWeek, weekPayBreakdown } from '../lib/payRule.ts';
import { addClientUser, addEvent, addGauge, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
setBusinessClock(new Date(`${TODAY}T15:00:00`));

const W1 = '2026-09-14';
const W2 = '2026-09-21';
const W3 = '2026-09-28';
const W4 = '2026-10-05';
const THIS_WEEK = '2026-10-12';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repB: TestClient;
let client: TestClient;
const fx = () => srv.fixture!;

const runOf = (userId: number, week: string) =>
  get<Json>(srv.db, `SELECT id, status, days_worked AS days, sales, base_pay AS base, commission, bonus, overrides, gross, paid_as AS paidAs,
                            sales_logged AS logged, sales_confirmed AS confirmed, sales_cancelled AS cancelled, adjustments_total AS adjustments,
                            breakdown_json AS json FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [userId, week]);
const counts = () => ({
  confirmations: Number(get<Json>(srv.db, `SELECT COUNT(*) AS n FROM sale_confirmations`)!.n),
  adjustments: Number(get<Json>(srv.db, `SELECT COUNT(*) AS n FROM pay_adjustments`)!.n),
  runs: JSON.stringify(all(srv.db, `SELECT id, gross, status, breakdown_json FROM payroll_runs ORDER BY id`)),
});

function day(date: string, sales: number, userId = fx().users.rep, teamId = fx().teams.a): void {
  const existing = get<{ id: number }>(srv.db, `SELECT id FROM events WHERE team_id = ? AND date = ? ORDER BY id LIMIT 1`, [teamId, date]);
  const eventId = existing?.id ?? addEvent(srv.db, { campaignId: fx().campaignId, teamId, date });
  addGauge(srv.db, { eventId, userId, date, stops: 60, sales });
}

before(async () => {
  srv = await startTestServer({ today: TODAY });
  const { db } = srv;
  const f = fx();
  run(db, `INSERT INTO meta (key, value) VALUES ('ext:pay:rule_from', '2026-09-07'), ('ext:pay:day_rate', '63.5')`);
  const start = get<{ s: string }>(db, `SELECT start_date AS s FROM campaigns WHERE id = ?`, [f.campaignId])!.s;
  run(db, `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 10, 120, ?, 'seed', NULL, NULL, '2026-01-01T00:00:00Z')`, [f.campaignId, start]);
  run(db, `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 15, 120, '2026-09-24', 'client', ?, NULL, '2026-09-20T10:00:00Z')`, [f.campaignId, f.users.admin]);
  run(db, `UPDATE campaigns SET rep_commission_per_sale = 15 WHERE id = ?`, [f.campaignId]);
  [5, 4, 5, 4].forEach((n, i) => day(`2026-09-1${4 + i}`, n));
  day('2026-09-21', 6);
  day('2026-09-22', 6);
  day('2026-09-24', 6);
  ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].forEach((d) => day(d, 6));
  day('2026-10-05', 2);
  day('2026-10-06', 2);
  day('2026-10-12', 3);
  materialisePayrollRuns(db, TODAY);
  [admin, leader, recruiter, rep, repB, client] = await Promise.all([
    srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('repB'), srv.login('client'),
  ]);
  // W1 and W2 are paid; W3 (overdue) and W4 are still to pay
  assert.equal((await admin.post(`/finance/payroll/${runOf(f.users.rep, W1).id}/pay`, { paidDate: '2026-09-25' })).status, 200);
  assert.equal((await admin.post(`/finance/payroll/${runOf(f.users.rep, W2).id}/pay`, { paidDate: '2026-10-02' })).status, 200);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('runs by the 1.3 rule: base or commission, whichever is higher; overrides 0; the 1.3 columns filled', () => {
  const r = fx().users.rep;
  const w1 = runOf(r, W1);
  assert.deepEqual([w1.days, w1.sales, w1.base, w1.commission, w1.overrides, w1.gross, w1.paidAs], [4, 18, 254, 0, 0, 254, 'base']);
  const w2 = runOf(r, W2);
  assert.deepEqual([w2.days, w2.base, w2.commission, w2.gross, w2.paidAs], [3, 0, 210, 210, 'commission'], '12 × £10 + 6 × £15 = £210 > £190.50');
  const w3 = runOf(r, W3);
  assert.deepEqual([w3.days, w3.gross, w3.paidAs, w3.logged, w3.confirmed, w3.cancelled, w3.adjustments], [5, 450, 'commission', 30, 30, 0, 0]);
  const w4 = runOf(r, W4);
  assert.deepEqual([w4.days, w4.gross, w4.paidAs], [2, 127, 'base']);
  assert.ok(JSON.parse(w4.json).result.lines.length >= 2, 'the calculation is stored with the run');
  // the recruiter: Mon–Fri at the day rate, no gauges → the base; the leader logged nothing → no run; the salaried owner → no run
  assert.deepEqual([runOf(fx().users.recruiter, W3).gross, runOf(fx().users.recruiter, W3).paidAs], [317.5, 'base']);
  assert.equal(runOf(fx().users.leader, W3), undefined);
  assert.equal(runOf(fx().users.admin, W3), undefined);
  assert.deepEqual(materialisePayrollRuns(srv.db, TODAY), { created: 0, updated: 0, deleted: 0 }, 'idempotent');
});

test('GET /pay/settings: admin only; a client gets clientPortalOnly; anonymous 401', async () => {
  assert.deepEqual((await admin.get('/pay/settings')).json, { dayRate: 63.5, ruleFrom: '2026-09-07' });
  for (const c of [leader, recruiter, rep]) assert.equal((await c.get('/pay/settings')).status, 403);
  const cl = await client.get('/pay/settings');
  assert.equal(cl.status, 403);
  assert.equal(cl.json.clientPortalOnly, true);
  assert.equal((await srv.anon().get('/pay/settings')).status, 401);
});

test('GET /pay/breakdown: the paid week as calculated, every line and the sentences', async () => {
  const res = await rep.get(`/pay/breakdown?weekStart=${W2}`);
  assert.equal(res.status, 200);
  const b = res.json as WeekPayBreakdown;
  assert.deepEqual([b.rule, b.status, b.asCalculated, b.daysWorked, b.dayRate, b.baseAmount, b.commissionAmount, b.paidAs, b.gross], [
    'base-or-commission', 'paid', true, 3, 63.5, 190.5, 210, 'commission', 210,
  ]);
  assert.deepEqual(b.lines.map((l) => [l.kind, l.label, l.amount, l.paid]), [
    ['base', '3 days × £63.50', 190.5, false],
    ['commission', 'FXC: 12 subs × £10.00 (to Tue 22 Sep)', 120, true],
    ['commission', 'FXC: 6 subs × £15.00 (from Thu 24 Sep)', 90, true],
  ]);
  assert.deepEqual(b.explanation, [
    'You worked 3 days: base £190.50.',
    'Commission: 18 subs = £210.00.',
    "Commission £210.00 beat your base £190.50, so you're paid the commission.",
  ]);
  assert.equal(b.dueDate, '2026-10-02');
  assert.equal(b.paidDate, '2026-10-02');
  // the office sees the same week with Remy's name in the sentences
  const office = (await admin.get(`/pay/breakdown?userId=${fx().users.rep}&weekStart=${W2}`)).json as WeekPayBreakdown;
  assert.equal(office.explanation[0], 'Remy worked 3 days: base £190.50.');
  assert.equal(office.userName, 'Remy Rep');
  // the week in progress: an estimate (any date in the week answers its Monday)
  const now = (await rep.get(`/pay/breakdown?weekStart=2026-10-14`)).json as WeekPayBreakdown;
  assert.deepEqual([now.weekStart, now.status, now.runId, now.asCalculated, now.daysWorked], [THIS_WEEK, 'estimate', null, false, 1]);
  assert.equal((await rep.get('/pay/breakdown')).json.weekStart, THIS_WEEK, 'default: this week');
});

test('GET /pay/breakdown scoping: own; leader own team; admin anyone; recruiter own; client 403; anonymous 401', async () => {
  const f = fx();
  const q = (userId: number) => `/pay/breakdown?userId=${userId}&weekStart=${W3}`;
  assert.equal((await rep.get(q(f.users.rep))).status, 200);
  assert.equal((await rep.get(q(f.users.repB))).status, 403);
  assert.equal((await rep.get(q(f.users.repA2))).status, 403, 'a rep never sees a teammate');
  assert.equal((await leader.get(q(f.users.rep))).status, 200, 'leader: own team');
  assert.equal((await leader.get(q(f.users.repB))).status, 403, 'leader: not another team');
  assert.equal((await recruiter.get(q(f.users.recruiter))).status, 200);
  assert.equal((await recruiter.get(q(f.users.rep))).status, 403);
  assert.equal((await admin.get(q(f.users.repB))).status, 200);
  const salaried = (await admin.get(q(f.users.admin))).json as WeekPayBreakdown;
  assert.equal(salaried.salaried, true);
  assert.match(salaried.explanation[0]!, /^Your pay plan \(Owner\) pays no day rate and no commission, so weekly pay does not apply from Mon 7 Sep\.$/);
  const cl = await client.get(q(f.users.rep));
  assert.deepEqual([cl.status, cl.json.clientPortalOnly], [403, true]);
  assert.equal((await srv.anon().get(q(f.users.rep))).status, 401);
  assert.equal((await admin.get('/pay/breakdown?userId=99999')).status, 404);
  const clientId = Number(get<Json>(srv.db, `SELECT id FROM users WHERE role = 'client'`)!.id);
  assert.equal((await admin.get(`/pay/breakdown?userId=${clientId}`)).status, 404, 'a client account has no pay');
  assert.equal((await rep.get('/pay/breakdown?weekStart=not-a-date')).status, 400);
  assert.equal((await rep.get('/pay/breakdown?weekStart=2026-12-28')).status, 400, 'too far ahead');
  assert.equal((await rep.get('/pay/breakdown?userId=abc')).status, 400);
});

test('applyConfirmedSales: a dry run writes nothing; then unpaid weeks recalculate and a paid week is corrected on the next unpaid one', () => {
  const f = fx();
  const rows = [
    { userId: f.users.rep, campaignId: f.campaignId, weekStart: W1, confirmed: 16 },
    { userId: f.users.rep, campaignId: f.campaignId, weekStart: W2, confirmed: 16 },
    { userId: f.users.rep, campaignId: f.campaignId, weekStart: W3, confirmed: 27 },
    { userId: f.users.rep, campaignId: f.campaignId, weekStart: '2026-10-07', confirmed: 3 }, // any date in W4
    { userId: 99999, campaignId: f.campaignId, weekStart: W4, confirmed: 1 }, // unknown person: skipped
  ];
  const before = counts();
  const preview = applyConfirmedSales(srv.db, rows, { statementId: 41, actorId: f.users.admin, dryRun: true });
  assert.deepEqual(counts(), before, 'the dry run wrote nothing');
  const applied = applyConfirmedSales(srv.db, rows, { statementId: 41, actorId: f.users.admin });
  const strip = (r: ApplyResult) => r.people.map(({ adjustmentId: _a, ...p }) => p);
  assert.deepEqual(strip(preview), strip(applied), 'the preview is exactly what Apply did');
  assert.deepEqual([preview.dryRun, preview.applied, applied.dryRun, applied.applied], [true, false, false, true]);
  const byWeek = new Map(applied.people.map((p) => [p.weekStart, p]));
  assert.equal(applied.people.length, 4);
  // W1 (paid, base): 16 × £10 = £160 is still below the base → no change
  assert.deepEqual([byWeek.get(W1)!.effect, byWeek.get(W1)!.difference], ['no-change', 0]);
  assert.equal(byWeek.get(W1)!.sentence, '2 cancelled by FXC, but the base still applied: no change.');
  // W2 (paid, commission £210): Thu loses 2 → 12 × £10 + 4 × £15 = £180 < £190.50 → base → −£19.50 on W3
  const w2 = byWeek.get(W2)!;
  assert.deepEqual([w2.effect, w2.logged, w2.confirmed, w2.cancelled, w2.before.gross, w2.after.gross, w2.difference, w2.targetWeekStart], ['adjustment', 18, 16, 2, 210, 190.5, -19.5, W3]);
  assert.deepEqual([w2.before.paidAs, w2.after.paidAs], ['commission', 'base']);
  assert.equal(w2.sentence, 'Paid for 18, 2 cancelled by FXC, so −£19.50 on the pay for w/c 28 Sep.');
  // W3 (unpaid): 27 × £15 = £405 → recalculated (its own figure, with W2's correction on it as well)
  const w3 = byWeek.get(W3)!;
  assert.deepEqual([w3.effect, w3.before.gross, w3.after.gross, w3.difference], ['recalculated', 430.5, 385.5, -45]);
  assert.equal(w3.sentence, "3 cancelled by FXC: the week's pay goes from £430.50 to £385.50 (not paid yet).");
  // W4 (unpaid, base): 3 × £15 = £45 < £127 → no change
  assert.deepEqual([byWeek.get(W4)!.effect, byWeek.get(W4)!.difference], ['no-change', 0]);
  assert.equal(applied.totalDifference, -64.5);
  // the runs: paid ones untouched, W3 recalculated with its correction line
  assert.equal(runOf(f.users.rep, W1).gross, 254);
  assert.equal(runOf(f.users.rep, W2).gross, 210, 'a paid run never changes');
  const r3 = runOf(f.users.rep, W3);
  assert.deepEqual([r3.gross, r3.commission, r3.adjustments, r3.confirmed, r3.cancelled, r3.status], [385.5, 405, -19.5, 27, 3, 'pending']);
  const line = get<Json>(srv.db, `SELECT kind, amount, note, source_week_start AS source, target_week_start AS target, statement_id AS statementId FROM pay_adjustments WHERE statement_id = 41`)!;
  assert.deepEqual({ ...line }, { kind: 'cancellation', amount: -19.5, note: '2 cancelled by FXC: paid for 18, confirmed 16', source: W2, target: W3, statementId: 41 });
});

test('applying the same statement again changes nothing; new figures change its own correction in place', () => {
  const f = fx();
  const rows = [W1, W2, W3].map((weekStart, i) => ({ userId: f.users.rep, campaignId: f.campaignId, weekStart, confirmed: [16, 16, 27][i]! }));
  const before = counts();
  const again = applyConfirmedSales(srv.db, rows, { statementId: 41, actorId: f.users.admin });
  assert.ok(again.people.every((p) => p.effect === 'no-change' && p.difference === 0));
  assert.equal(again.totalDifference, 0);
  assert.deepEqual(counts(), before, 'idempotent');
  // the statement was re-read: 17 of 18 for W2 → 12 × £10 + 5 × £15 = £195 beats the base → the correction becomes −£15
  const fixed = applyConfirmedSales(srv.db, [{ userId: f.users.rep, campaignId: f.campaignId, weekStart: W2, confirmed: 17 }], { statementId: 41, actorId: f.users.admin });
  const p = fixed.people[0]!;
  assert.deepEqual([p.effect, p.difference, p.targetWeekStart], ['adjustment', 4.5, W3]);
  assert.equal(p.sentence, 'Paid for 18, 1 cancelled by FXC, so −£15.00 on the pay for w/c 28 Sep.');
  const lines = all<Json>(srv.db, `SELECT amount, note FROM pay_adjustments WHERE statement_id = 41`);
  assert.deepEqual(lines.map((l) => ({ ...l })), [{ amount: -15, note: '1 cancelled by FXC: paid for 18, confirmed 17' }], 'one line, updated in place');
  assert.equal(runOf(f.users.rep, W3).gross, 390);
  // bad rows are refused before anything is written
  assert.throws(() => applyConfirmedSales(srv.db, [{ userId: f.users.rep, campaignId: f.campaignId, weekStart: 'soon', confirmed: 1 }], { statementId: 42, actorId: null }), /weekStart/);
  assert.throws(() => applyConfirmedSales(srv.db, [{ userId: f.users.rep, campaignId: f.campaignId, weekStart: W3, confirmed: -1 }], { statementId: 42, actorId: null }), /confirmed/);
});

test('the paid week keeps its figures; its breakdown lists the confirmation and the correction made later', async () => {
  const b = (await rep.get(`/pay/breakdown?weekStart=${W2}`)).json as WeekPayBreakdown;
  assert.equal(b.gross, 210);
  assert.equal(b.corrections!.length, 1);
  assert.deepEqual([b.corrections![0]!.amount, b.corrections![0]!.targetWeekStart], [-15, W3]);
  assert.deepEqual(b.explanation.slice(3), [
    'After this week was paid, FXC confirmed 17 of 18 subs.',
    'Correction −£15.00 (1 cancelled by FXC: paid for 18, confirmed 17) on the pay for w/c 28 Sep.',
  ]);
  const w3 = (await rep.get(`/pay/breakdown?weekStart=${W3}`)).json as WeekPayBreakdown;
  assert.deepEqual(w3.lines.filter((l) => l.kind === 'adjustment').map((l) => [l.label, l.amount, l.sourceWeekStart]), [['Correction for w/c 21 Sep', -15, W2]]);
  assert.equal(w3.explanation[1], 'Commission: 27 subs paid (30 logged, 3 cancelled by FXC) = £405.00.');
  assert.equal(w3.explanation.at(-1), 'Total: £390.00.');
  // the person's own adjustments; another rep's are refused
  const mine = (await rep.get('/pay/adjustments')).json as Json[];
  assert.ok(mine.length >= 1 && mine.every((a) => a.userId === fx().users.rep));
  assert.equal((await rep.get(`/pay/adjustments?userId=${fx().users.repB}`)).status, 403);
  assert.ok(((await leader.get('/pay/adjustments')).json as Json[]).some((a) => a.userId === fx().users.rep), 'the leader sees the team');
  assert.equal(((await admin.get(`/pay/adjustments?weekStart=${W3}`)).json as Json[]).length, 1);
  assert.equal((await client.get('/pay/adjustments')).status, 403);
  assert.equal((await srv.anon().get('/pay/adjustments')).status, 401);
});

test('POST /pay/bonuses: admin only, on an unpaid week; the run follows; audited with the run it moved', async () => {
  const f = fx();
  const body = { userId: f.users.rep, weekStart: W4, amount: 50, note: 'Top seller in September' };
  for (const c of [leader, recruiter, rep]) assert.equal((await c.post('/pay/bonuses', body)).status, 403);
  assert.deepEqual([(await client.post('/pay/bonuses', body)).status, (await srv.anon().post('/pay/bonuses', body)).status], [403, 401]);
  const res = await admin.post('/pay/bonuses', body);
  assert.equal(res.status, 201);
  assert.deepEqual([res.json.kind, res.json.amount, res.json.targetWeekStart, res.json.sourceWeekStart, res.json.createdBy, res.json.createdByName], ['bonus', 50, W4, null, f.users.admin, 'Ada Admin']);
  const w4 = runOf(f.users.rep, W4);
  assert.deepEqual([w4.gross, w4.bonus, w4.base, w4.paidAs], [177, 50, 127, 'base'], '£127 base + £50 bonus');
  const audit = all<Json>(srv.db, `SELECT entity, summary FROM audit_log WHERE action = 'POST /pay/bonuses' ORDER BY id`);
  assert.deepEqual(audit.map((a) => a.entity), ['pay_adjustment', 'payroll_run']);
  assert.equal(audit[0]!.summary, 'Added a bonus: Remy Rep w/c 5 Oct, £50 — Top seller in September');
  assert.equal(audit[1]!.summary, 'Recalculated after a bonus: Remy Rep w/c 5 Oct, £127 → £177');
  // refused: a paid week, nothing to say, £0, the salaried owner, a client account, an unknown person, too far ahead
  assert.equal((await admin.post('/pay/bonuses', { ...body, weekStart: W1 })).status, 409);
  assert.equal((await admin.post('/pay/bonuses', { ...body, note: '  ' })).status, 400);
  assert.equal((await admin.post('/pay/bonuses', { ...body, amount: 0 })).status, 400);
  const owner = await admin.post('/pay/bonuses', { ...body, userId: f.users.admin });
  assert.deepEqual([owner.status, owner.json.error], [400, "Ada's pay plan is not paid weekly, so there is no pay to add this to"]);
  const clientId = Number(get<Json>(srv.db, `SELECT id FROM users WHERE role = 'client'`)!.id);
  assert.equal((await admin.post('/pay/bonuses', { ...body, userId: clientId })).status, 404);
  assert.equal((await admin.post('/pay/bonuses', { ...body, userId: 99999 })).status, 404);
  assert.equal((await admin.post('/pay/bonuses', { ...body, weekStart: '2026-12-07' })).status, 400);
  // this week: no run yet, the estimate shows it
  assert.equal((await admin.post('/pay/bonuses', { ...body, weekStart: THIS_WEEK, amount: 25, note: 'Best close rate on Monday' })).status, 201);
  const now = (await rep.get('/pay/breakdown')).json as WeekPayBreakdown;
  assert.deepEqual([now.status, now.bonus, now.lines.find((l) => l.kind === 'bonus')?.label], ['estimate', 25, 'Bonus: Best close rate on Monday']);
});

test('POST /pay/adjustments and DELETE /pay/adjustments/:id: manual lines on unpaid weeks; statement corrections stay', async () => {
  const f = fx();
  const body = { userId: f.users.rep, targetWeekStart: W4, sourceWeekStart: W1, amount: -20, note: 'Lanyard not returned' };
  assert.equal((await rep.post('/pay/adjustments', body)).status, 403);
  assert.equal((await leader.post('/pay/adjustments', body)).status, 403);
  assert.equal((await client.post('/pay/adjustments', body)).status, 403);
  assert.equal((await admin.post('/pay/adjustments', { ...body, amount: 0 })).status, 400);
  const res = await admin.post('/pay/adjustments', body);
  assert.equal(res.status, 201);
  assert.deepEqual([res.json.kind, res.json.amount, res.json.sourceWeekStart], ['manual', -20, W1]);
  assert.equal(runOf(f.users.rep, W4).gross, 157, '£177 − £20');
  const b = (await rep.get(`/pay/breakdown?weekStart=${W4}`)).json as WeekPayBreakdown;
  assert.ok(b.explanation.includes('Adjustment for w/c 14 Sep: −£20.00 (Lanyard not returned).'));
  assert.equal((await rep.del(`/pay/adjustments/${res.json.id}`)).status, 403);
  assert.equal((await admin.del(`/pay/adjustments/${res.json.id}`)).status, 204);
  assert.equal(runOf(f.users.rep, W4).gross, 177, 'removed: back to £177');
  assert.equal((await admin.del(`/pay/adjustments/${res.json.id}`)).status, 404);
  const correction = get<Json>(srv.db, `SELECT id FROM pay_adjustments WHERE statement_id = 41`)!;
  assert.equal((await admin.del(`/pay/adjustments/${correction.id}`)).status, 409, 'a statement correction is not removed by hand');
  assert.equal((await srv.anon().del(`/pay/adjustments/${correction.id}`)).status, 401);
  assert.ok(all<Json>(srv.db, `SELECT summary FROM audit_log WHERE action = 'DELETE /pay/adjustments/:id'`).some((a) => /^Removed an adjustment: Remy Rep w\/c 5 Oct, −£20 — Lanyard not returned$/.test(a.summary)));
});

test('PUT /pay/settings: a new day rate recalculates the unpaid weeks only; moving the rule date moves weeks between the rules', async () => {
  const f = fx();
  for (const c of [leader, recruiter, rep]) assert.equal((await c.put('/pay/settings', { dayRate: 70 })).status, 403);
  assert.equal((await client.put('/pay/settings', { dayRate: 70 })).status, 403);
  assert.equal((await admin.put('/pay/settings', { dayRate: 0 })).status, 400);
  assert.equal((await admin.put('/pay/settings', { dayRate: 501 })).status, 400);
  assert.equal((await admin.put('/pay/settings', { ruleFrom: '2026-09-08' })).status, 400, 'not a Monday');
  assert.equal((await admin.put('/pay/settings', { ruleFrom: '2026-10-19' })).status, 400, 'after this week');
  assert.equal((await admin.put('/pay/settings', { surprise: 1 })).status, 400);
  const res = await admin.put('/pay/settings', { dayRate: 65 });
  assert.deepEqual(res.json, { dayRate: 65, ruleFrom: '2026-09-07' });
  assert.equal(runOf(f.users.rep, W4).gross, 180, '2 × £65 + £50 bonus');
  assert.equal(runOf(f.users.rep, W1).gross, 254, 'paid at £63.50, never changed');
  assert.equal(runOf(f.users.recruiter, W4).gross, 325, 'recruiter: 5 × £65');
  const audit = all<Json>(srv.db, `SELECT entity, summary FROM audit_log WHERE action = 'PUT /pay/settings' ORDER BY id`).slice(-2);
  assert.equal(audit[0]!.summary, 'Changed pay settings: day rate £63.50 → £65');
  // and one row for the unpaid runs it recalculated (Remy's W3 and W4, the recruiter's weeks)
  assert.equal(audit[1]!.entity, 'payroll_run');
  assert.match(audit[1]!.summary, /^Recalculated \d+ unpaid pay runs after the pay settings change: £[\d,.]+ → £[\d,.]+ in all$/);
  // W3 moves back to the 1.2 plan (field rep: £60/day + £45/sale + £75 at 12) when the rule starts on 5 Oct
  await admin.put('/pay/settings', { dayRate: 63.5, ruleFrom: W4 });
  const w3plan = runOf(f.users.rep, W3);
  assert.deepEqual([w3plan.paidAs, w3plan.gross], [null, 5 * 60 + 27 * 45 + 75 - 15], 'plan maths on the 27 confirmed sales, the correction kept');
  const planBreakdown = (await rep.get(`/pay/breakdown?weekStart=${W3}`)).json as WeekPayBreakdown;
  assert.equal(planBreakdown.rule, 'plan');
  assert.match(planBreakdown.explanation[0]!, /^This week was paid by the pay plan in use before Mon 5 Oct/);
  await admin.put('/pay/settings', { ruleFrom: '2026-09-07' });
  assert.deepEqual([runOf(f.users.rep, W3).paidAs, runOf(f.users.rep, W3).gross], ['commission', 390]);
  assert.equal(runOf(f.users.rep, W4).gross, 177);
});

test('campaign rates: the history, a new rate recalculates unpaid weeks from its date, the campaign follows the rate in effect today', async () => {
  const f = fx();
  const list = (await leader.get(`/pay/rates?campaignId=${f.campaignId}`)).json as Json[];
  assert.deepEqual(list.map((r) => [r.repRate, r.effectiveFrom, r.source]), [[15, '2026-09-24', 'client'], [10, list[1].effectiveFrom, 'seed']]);
  assert.equal(list[0].approvedByName, 'Ada Admin');
  for (const c of [rep, recruiter]) assert.equal((await c.get('/pay/rates')).status, 403);
  assert.equal((await client.get('/pay/rates')).status, 403);
  assert.equal((await srv.anon().get('/pay/rates')).status, 401);
  const body = { campaignId: f.campaignId, repRate: 45, payoutRate: 125, effectiveFrom: W4 };
  assert.equal((await leader.post('/pay/rates', body)).status, 403);
  assert.equal((await admin.post('/pay/rates', { ...body, campaignId: 9999 })).status, 404);
  assert.equal((await admin.post('/pay/rates', { ...body, effectiveFrom: '05/10/2026' })).status, 400);
  const res = await admin.post('/pay/rates', body);
  assert.equal(res.status, 201);
  assert.deepEqual([res.json.source, res.json.approvedBy, res.json.repRate], ['admin', f.users.admin, 45]);
  // W4: 3 confirmed subs × £45 = £135 beats £127 → commission £135 + the £50 bonus
  assert.deepEqual([runOf(f.users.rep, W4).paidAs, runOf(f.users.rep, W4).gross], ['commission', 185]);
  assert.equal(runOf(f.users.rep, W3).gross, 390, 'the week before the new rate keeps £15');
  assert.deepEqual({ ...get<Json>(srv.db, `SELECT rep_commission_per_sale AS rep, payout_per_sale AS payout FROM campaigns WHERE id = ?`, [f.campaignId])! }, { rep: 45, payout: 125 });
  assert.equal(campaignRateOn(srv.db, f.campaignId, '2026-09-23')!.repRate, 10);
  assert.equal(campaignRateOn(srv.db, f.campaignId, '2000-01-01')!.repRate, 10, 'before the history: its first rate');
  // P6's approval: a client's change with only the rep rate keeps the payout in effect; a future date waits
  const approved = addCampaignRate(srv.db, { campaignId: f.campaignId, repRate: 50, payoutRate: undefined as unknown as number, effectiveFrom: '2026-11-02', source: 'client', clientPostId: 7 }, f.users.admin);
  assert.deepEqual([approved.source, approved.clientPostId, approved.payoutRate, approved.repRate], ['client', 7, 125, 50]);
  assert.equal(Number(get<Json>(srv.db, `SELECT rep_commission_per_sale AS r FROM campaigns WHERE id = ?`, [f.campaignId])!.r), 45, 'not in effect yet');
  assert.equal(listCampaignRates(srv.db, f.campaignId)[0]!.effectiveFrom, '2026-11-02');
  // the Campaigns form: a changed rep rate adds an 'admin' row from today
  const patched = await admin.patch(`/campaigns/${f.campaignId}`, { repCommissionPerSale: 40 });
  assert.equal(patched.status, 200);
  const today = listCampaignRates(srv.db, f.campaignId).find((r) => r.effectiveFrom === TODAY)!;
  assert.deepEqual([today.repRate, today.source], [40, 'admin']);
  assert.ok(all<Json>(srv.db, `SELECT summary FROM audit_log WHERE action = 'POST /pay/rates'`).some((a) => /^Added a rate for FXC: £45 a sub to the rep, £125 payout, from 2026-10-05$/.test(a.summary)));
});

test('the response cache serves the breakdown and a pay write refreshes it', async () => {
  srv.resetCache();
  const url = `/pay/breakdown?weekStart=${W4}`;
  assert.equal((await rep.get(url)).headers.get('x-cache'), 'MISS');
  assert.equal((await rep.get(url)).headers.get('x-cache'), 'HIT');
  await admin.post('/pay/bonuses', { userId: fx().users.rep, weekStart: W4, amount: 10, note: 'Covered a shift' });
  const fresh = await rep.get(url);
  assert.equal(fresh.headers.get('x-cache'), 'MISS');
  assert.equal(fresh.json.bonus, 60);
});

test('a correction on a week the person did not work moves on to the next week instead of a run below £0', () => {
  const f = fx();
  const before = runOf(f.users.repB, W4);
  assert.equal(before, undefined, 'Bo logged nothing in W4');
  run(srv.db, `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, campaign_id, statement_id, invoice_id, created_by, created_at)
               VALUES (?, ?, ?, 'cancellation', -18, '1 cancelled by FXC: paid for 4, confirmed 3', ?, 77, NULL, NULL, '2026-10-13T09:00:00Z')`, [f.users.repB, W4, W3, f.campaignId]);
  const bo = get<Json>(srv.db, `SELECT id, employee_id AS employeeId, team_id AS teamId, pay_plan_id AS payPlanId, role, start_date AS startDate FROM users WHERE id = ?`, [f.users.repB])!;
  assert.equal(syncPayrollRun(srv.db, bo, W4, TODAY), 'unchanged');
  assert.equal(runOf(f.users.repB, W4), undefined, 'no negative run');
  assert.equal(get<Json>(srv.db, `SELECT target_week_start AS t FROM pay_adjustments WHERE statement_id = 77`)!.t, THIS_WEEK, 'moved to the next week');
  const now = weekPayBreakdown(srv.db, f.users.repB, THIS_WEEK, { today: TODAY })!;
  assert.equal(now.adjustmentsTotal, -18);
  // the next unpaid week for a correction: the earliest pending run after the week, else this week
  assert.equal(nextUnpaidWeek(srv.db, f.users.rep, W1, TODAY), W3);
  assert.equal(nextUnpaidWeek(srv.db, f.users.repB, W1, TODAY), THIS_WEEK);
});

test('a client account gets 403 clientPortalOnly on every /pay route', async () => {
  const calls: [string, string][] = [
    ['GET', '/pay/settings'], ['PUT', '/pay/settings'], ['GET', '/pay/rates'], ['POST', '/pay/rates'], ['GET', '/pay/breakdown'],
    ['GET', '/pay/adjustments'], ['POST', '/pay/bonuses'], ['POST', '/pay/adjustments'], ['DELETE', '/pay/adjustments/1'],
  ];
  for (const [m, p] of calls) {
    const r = await client.req(m, p, m === 'GET' ? undefined : {});
    assert.deepEqual([r.status, r.json?.clientPortalOnly], [403, true], `${m} ${p}`);
    assert.equal((await srv.anon().req(m, p, m === 'GET' ? undefined : {})).status, 401, `anonymous ${m} ${p}`);
  }
  // a client account is never payable, even with an adjustment on it
  const id = addClientUser(srv.db, { campaignId: fx().campaignId, email: 'pay.client@client.test' });
  assert.equal(weekPayBreakdown(srv.db, id, W4), null);
});

test('a 1.2 database upgrades: the rule starts this week, every campaign gets its first rate, no run changes', () => {
  const db = openDb(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    upgradeSchema(db);
    for (const e of EXTENSIONS.slice(0, 5)) {
      if (e.sql.trim()) db.exec(e.sql);
      e.upgrade(db);
    }
    db.exec(`INSERT INTO pay_plans (name, position, base_per_day, commission_per_sale) VALUES ('Old plan', 'field_rep', 60, 45)`);
    db.exec(`INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, avatar_color)
             VALUES ('LM-0001', 'old@example.test', 'Old', 'Person', 'rep', 'field_rep', NULL, 1, '2025-01-06', '#4F46E5')`);
    db.exec(`INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, start_date)
             VALUES ('Old charity', 'OLD', 'charity', 'fundraising', 100, 40, '#DB2777', '2025-01-06')`);
    db.exec(`INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, base_pay, commission, gross, due_date, status, reference)
             VALUES (1, '2026-10-05', '2026-10-11', 4, 10, 240, 450, 690, '2026-10-16', 'pending', 'PAY-202641-LM-0001')`);
    const changed = createSchema(db);
    assert.ok(changed.includes('pay:campaign_rates.seed'));
    assert.ok(changed.includes('pay:payroll_runs.breakdown_json'));
    assert.equal(get<Json>(db, `SELECT value FROM meta WHERE key = 'ext:pay:rule_from'`)!.value, THIS_WEEK, 'the Monday of the week the upgrade ran');
    assert.deepEqual({ ...get<Json>(db, `SELECT rep_rate AS rep, payout_rate AS payout, effective_from AS f, source FROM campaign_rates`)! }, { rep: 40, payout: 100, f: '2025-01-06', source: 'seed' });
    assert.deepEqual({ ...get<Json>(db, `SELECT gross, paid_as AS paidAs, breakdown_json AS json FROM payroll_runs`)! }, { gross: 690, paidAs: null, json: null });
    assert.deepEqual(createSchema(db), [], 'once');
  } finally {
    db.close();
  }
});
