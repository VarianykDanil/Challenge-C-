/**
 * p3-money-forecast-payroll-checks: this week's pay estimate on GET /finance/me and /me/insights, advisory payroll
 * flags on GET /finance/payroll(/:id), and the pay endpoint semantics the bulk "Mark paid" flow relies on.
 *
 * The business clock is pinned to Thu 15 Oct 2026 15:00 (London) so the fixture's week is always the same:
 * Mon 12 – Sun 18 Oct, team A events Wed 14 (completed), Thu 15 (live, today) and Fri 16 (scheduled).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayrollRunWithUser } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { getUser, listPayroll } from '../db/queries.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { weekPayForecast } from '../lib/smart/payForecast.ts';
import { MAX_FLAGGED_RUNS, gaugeWindows, payrollFlagsFor } from '../lib/smart/payrollFlags.ts';
import { addEvent, addGauge, addHistory, startTestServer, withSmart, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
const fx = () => srv.fixture!;

/** Count every SQL statement prepared or executed on `db` while `fn` runs. */
function countStatements<T>(db: Db, fn: () => T): { result: T; statements: number } {
  const proto = Object.getPrototypeOf(db) as { prepare: Db['prepare']; exec: Db['exec'] };
  let statements = 0;
  const prepare = db.prepare;
  const exec = db.exec;
  Object.assign(db, {
    prepare: (sql: string) => {
      statements++;
      return proto.prepare.call(db, sql);
    },
    exec: (sql: string) => {
      statements++;
      return proto.exec.call(db, sql);
    },
  });
  try {
    return { result: fn(), statements };
  } finally {
    Object.assign(db, { prepare, exec });
  }
}

const rowCounts = (db: Db) => ({
  runs: Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM payroll_runs')!.n),
  gauges: Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM gauge_entries')!.n),
});

before(async () => {
  srv = await startTestServer({ today: TODAY });
  const { db } = srv;
  const f = fx();
  // Remy (field rep: £60/day, £45/sale, £75 at 12): 8 completed weeks, Mon–Thu, 50 stops a day; 2 sales a day for
  // seven weeks, then a big last week at 10 a day (→ high_gross on that run).
  addHistory(db, { userId: f.users.rep, teamId: f.teams.a, campaignId: f.campaignId, weeks: 8, stops: 50, sales: (w) => (w === 7 ? 10 : 2), today: TODAY });
  // This week so far: Mon 3, Tue 4, Wed 4 → 3 days, 11 sales.
  const mon = addEvent(db, { campaignId: f.campaignId, teamId: f.teams.a, date: '2026-10-12' });
  const tue = addEvent(db, { campaignId: f.campaignId, teamId: f.teams.a, date: '2026-10-13' });
  addGauge(db, { eventId: mon, userId: f.users.rep, date: '2026-10-12', stops: 50, sales: 3 });
  addGauge(db, { eventId: tue, userId: f.users.rep, date: '2026-10-13', stops: 50, sales: 4 });
  addGauge(db, { eventId: f.events.yesterdayA, userId: f.users.rep, date: '2026-10-14', stops: 50, sales: 4 });
  [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('GET /finance/me (rep): a labelled estimate with low ≤ likely ≤ high and the bonus distance', async () => {
  await admin.get('/finance/payroll'); // materialise last weeks' runs first (a normal side effect of the finance routes)
  const before = rowCounts(srv.db);
  const me = await rep.get('/finance/me');
  assert.equal(me.status, 200);
  const f = me.json.forecast;
  assert.ok(f && typeof f === 'object');
  assert.equal(f.estimate, true);
  assert.equal(f.weekStart, '2026-10-12');
  assert.equal(f.payday, '2026-10-23');
  assert.ok(f.low <= f.likely && f.likely <= f.high);
  assert.equal(f.bonusGap, Math.max(0, f.bonusThreshold - f.soFar.sales));
  // Release 1.3 (P1): the fixture never wrote PAY_RULE_FROM, so it is this week's Monday: this week is paid by the
  // base-or-commission rule at the campaign's rate (FXC £45 a sub, no rate history), the weeks before by the plan.
  // so far: 3 days and 11 subs → base 3 × £63.50 = £190.50, commission 11 × £45 = £495 → the commission
  assert.deepEqual(f.soFar, { days: 3, sales: 11, gross: 495 });
  // today's live event (nothing logged yet) and Friday's scheduled one
  assert.equal(f.remainingDays, 2);
  // history: 28 days at 2 and 4 at 10 → λ = 3, p10 = 2, p90 = 9.2
  assert.deepEqual(f.basis, { weeks: 8, workedDays: 32, salesPerDay: 3 });
  assert.deepEqual(f.sales, { low: 15, likely: 17, high: 30 });
  // commission 495 + (15 | 17 | 30 − 11) × £45 against a base of 5 × £63.50 = £317.50
  assert.deepEqual([f.low, f.likely, f.high], [675, 765, 1350]);
  // no automatic bonus from 1.3: the rule block says the commission already beats the base
  assert.deepEqual([f.bonusThreshold, f.bonusGap, f.bonusLikelihood, f.stopsForBonus], [0, 0, 'none', null]);
  assert.deepEqual(
    { ...f.rule, beatBaseProbability: f.rule.beatBaseProbability },
    { dayRate: 63.5, projectedDays: 5, baseLikely: 317.5, commissionSoFar: 495, commissionLikely: 765, paidAsLikely: 'commission', ratePerSub: 45, subsToBeatBase: 0, stopsToBeatBase: null, beatBaseProbability: 1, extras: 0 },
  );
  // the official figure is untouched, and nothing was written
  assert.equal(me.json.nextPayAmount, (await withSmart('0', () => rep.get('/finance/me'))).json.nextPayAmount);
  assert.deepEqual(rowCounts(srv.db), before, 'the forecast writes no payroll run and no gauge row');
});

test('/me/insights carries the same forecast as /finance/me', async () => {
  srv.resetCache();
  const [ins, me] = await Promise.all([rep.get('/me/insights'), rep.get('/finance/me')]);
  assert.deepEqual(ins.json.personal.payForecast, me.json.forecast);
});

test('leaders: overrides projected from the team rate; recruiters and admins have no forecast', async () => {
  const l = (await leader.get('/finance/me')).json.forecast;
  // Lee logs nothing himself: 2 team event days left at the £63.50 day rate; no overrides from 1.3 (decision 2)
  assert.equal(l.soFar.days, 0);
  assert.equal(l.basis.weeks, 0, 'no own history → no range');
  assert.equal(l.likely, 2 * 63.5);
  assert.equal(l.low, l.likely);
  assert.equal(l.high, l.likely);
  assert.equal(l.bonusGap, 0);
  assert.equal(l.stopsForBonus, null);
  assert.equal(l.rule.paidAsLikely, 'base');
  assert.equal(l.rule.subsToBeatBase, 3, '£127 base / £45 a sub → 3 subs');
  assert.equal(l.rule.beatBaseProbability, 0, 'no own history to draw on');
  assert.equal((await recruiter.get('/finance/me')).json.forecast, null);
  assert.equal((await admin.get('/finance/me')).json.forecast, null);
  srv.resetCache();
  assert.equal((await recruiter.get('/me/insights')).json.personal.payForecast, null);
});

test('weekPayForecast: null without a team, a constant number of statements, no writes', () => {
  const { db } = srv;
  const remy = getUser(db, fx().users.rep)!;
  assert.equal(weekPayForecast(db, { ...remy, teamId: null }, TODAY), null);
  assert.equal(weekPayForecast(db, { ...remy, role: 'recruiter' }, TODAY), null);
  const { result, statements } = countStatements(db, () => weekPayForecast(db, remy, TODAY));
  assert.ok(result);
  assert.ok(statements <= 6, `${statements} statements`);
});

test('logging today removes today from the days left', async () => {
  const id = addGauge(srv.db, { eventId: fx().events.todayA, userId: fx().users.rep, date: TODAY, stops: 40, sales: 2 });
  // 1.5 (MON-1): a self-logged day pays a base day only with evidence: Remy checked in to today's event
  const ci = srv.db.prepare(`INSERT INTO check_ins (user_id, event_id, date, checked_in_at, source, created_at) VALUES (?, ?, ?, ?, 'button', ?)`)
    .run(fx().users.rep, fx().events.todayA, TODAY, `${TODAY}T09:00:00`, new Date().toISOString()).lastInsertRowid;
  try {
    const f = (await rep.get('/finance/me')).json.forecast;
    assert.equal(f.remainingDays, 1);
    assert.deepEqual([f.soFar.days, f.soFar.sales], [4, 13]);
    // 13 × £45 = £585 beats 4 × £63.50 = £254
    assert.equal(f.soFar.gross, 585);
    assert.equal(f.bonusLikelihood, 'none');
    assert.equal(f.rule.paidAsLikely, 'commission');
    assert.equal(f.rule.beatBaseProbability, 1);
  } finally {
    srv.db.prepare('DELETE FROM gauge_entries WHERE id = ?').run(id);
    srv.db.prepare('DELETE FROM check_ins WHERE id = ?').run(ci);
  }
});

const byWeek = (runs: Json[], userId: number) => new Map(runs.filter((r) => r.userId === userId).map((r) => [r.weekStart, r]));

test('GET /finance/payroll?status=pending,failed (admin): flags arrays on every unpaid run', async () => {
  const res = await admin.get('/finance/payroll?status=pending,failed');
  assert.equal(res.status, 200);
  assert.ok(res.json.length >= 8);
  for (const r of res.json) {
    assert.ok(Array.isArray(r.flags), `run ${r.id} has flags`);
    for (const f of r.flags) {
      assert.ok(['info', 'warning'].includes(f.severity));
      assert.equal(typeof f.text, 'string');
    }
  }
  const remy = byWeek(res.json, fx().users.rep);
  const codes = (week: string) => remy.get(week)!.flags.map((f: Json) => f.code);
  assert.deepEqual(codes('2026-08-17'), ['first_payslip']);
  assert.deepEqual(codes('2026-09-07'), []);
  assert.deepEqual(codes('2026-10-05'), ['high_gross']);
  assert.match(remy.get('2026-10-05')!.flags[0].text, /^£2,115 is 3\.5× the usual £600/);
  // Lee earns overrides on Remy's sales without working a day himself
  const lee = byWeek(res.json, fx().users.leader);
  assert.ok(lee.get('2026-09-07')!.flags.some((f: Json) => f.code === 'override_no_days' && f.severity === 'info'));
});

test('a gauge row added after the run was calculated → stale_amount', async () => {
  const f = fx();
  const fri = addEvent(srv.db, { campaignId: f.campaignId, teamId: f.teams.a, date: '2026-09-11' });
  addGauge(srv.db, { eventId: fri, userId: f.users.rep, date: '2026-09-11', stops: 50, sales: 3 });
  // 1.5 (MON-1): the day counts as a base day once someone confirmed it (here: the leader)
  srv.db.prepare(`INSERT INTO pay_day_checks (user_id, date, decision, source, decided_by, decided_at) VALUES (?, '2026-09-11', 'confirmed', 'leader', ?, ?)`)
    .run(f.users.rep, f.users.leader, new Date().toISOString());
  const runs = (await admin.get('/finance/payroll?status=pending,failed')).json;
  const stale = byWeek(runs, f.users.rep).get('2026-09-07')!;
  const flag = stale.flags.find((x: Json) => x.code === 'stale_amount');
  assert.ok(flag, 'stale flag');
  assert.match(flag.text, /gauges changed since this run was calculated/);
  assert.match(flag.text, /£795, not £600/); // + 1 day × £60 + 3 × £45 (11 sales: still no bonus)
});

test('flags are admin only and only on unpaid runs', async () => {
  for (const c of [leader, rep]) {
    const runs = await c.get('/finance/payroll');
    assert.equal(runs.status, 200);
    assert.ok(runs.json.length > 0);
    assert.ok(runs.json.every((r: Json) => !('flags' in r)), 'no flags key for leaders and reps');
  }
  const remyRuns = byWeek((await admin.get('/finance/payroll?status=pending')).json, fx().users.rep);
  const target = remyRuns.get('2026-08-24')!;
  const paid = await admin.post(`/finance/payroll/${target.id}/pay`, { paidDate: TODAY });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.status, 'late');
  const all_ = (await admin.get('/finance/payroll')).json as Json[];
  const after = all_.find((r) => r.id === target.id)!;
  assert.ok(!('flags' in after), 'a paid run carries no flags');
  assert.ok(all_.filter((r) => r.status === 'pending').every((r) => Array.isArray(r.flags)));
  // the payslip: flags for the admin, never for the person themself
  const unpaid = remyRuns.get('2026-10-05')!;
  const slipAdmin = await admin.get(`/finance/payroll/${unpaid.id}`);
  assert.deepEqual(slipAdmin.json.flags.map((x: Json) => x.code), ['high_gross']);
  const slipRep = await rep.get(`/finance/payroll/${unpaid.id}`);
  assert.equal(slipRep.status, 200);
  assert.ok(!('flags' in slipRep.json));
  assert.ok(!('flags' in (await admin.get(`/finance/payroll/${target.id}`)).json), 'paid payslip: no flags');
});

test('pay endpoint semantics the bulk flow relies on: 409 = already paid, paidDate bounds, failed runs payable', async () => {
  const runs = byWeek((await admin.get('/finance/payroll?status=pending')).json, fx().users.rep);
  const run = runs.get('2026-08-31')!;
  assert.equal((await admin.post(`/finance/payroll/${run.id}/pay`, { paidDate: '2026-09-05' })).status, 400, 'before the week ends');
  assert.equal((await admin.post(`/finance/payroll/${run.id}/pay`, { paidDate: '2026-10-16' })).status, 400, 'in the future');
  assert.equal((await rep.post(`/finance/payroll/${run.id}/pay`, {})).status, 403);
  assert.equal((await admin.post(`/finance/payroll/${run.id}/pay`, { paidDate: '2026-09-06' })).status, 200, 'on the week end');
  assert.equal((await admin.post(`/finance/payroll/${run.id}/pay`, {})).status, 409, 'second time → skipped');
  const failed = runs.get('2026-09-14')!;
  srv.db.prepare(`UPDATE payroll_runs SET status = 'failed' WHERE id = ?`).run(failed.id);
  const listed = (await admin.get('/finance/payroll?status=pending,failed')).json.find((r: Json) => r.id === failed.id);
  assert.ok(Array.isArray(listed.flags), 'failed runs are checked too');
  assert.equal((await admin.post(`/finance/payroll/${failed.id}/pay`, {})).status, 200);
});

test('payrollFlagsFor: admin only, capped at MAX_FLAGGED_RUNS, a bounded number of statements', () => {
  const { db } = srv;
  const runs = listPayroll(db, `WHERE p.status IN ('pending', 'failed')`, []);
  assert.ok(runs.length > 0);
  const adminUser = getUser(db, fx().users.admin)!;
  assert.equal(payrollFlagsFor(db, runs, getUser(db, fx().users.leader)!).size, 0);
  assert.equal(payrollFlagsFor(db, runs, getUser(db, fx().users.rep)!).size, 0);
  const { result, statements } = countStatements(db, () => payrollFlagsFor(db, runs, adminUser));
  assert.equal(result.size, runs.length);
  // 3 grouped statements + weekPayFor per run (plan, own week, team sales when the plan pays overrides)
  assert.ok(statements <= 3 + 3 * runs.length, `${statements} statements for ${runs.length} runs`);
  const many: PayrollRunWithUser[] = Array.from({ length: MAX_FLAGGED_RUNS + 7 }, (_, i) => ({ ...runs[i % runs.length]!, id: 100_000 + i }));
  assert.equal(payrollFlagsFor(db, many, adminUser).size, MAX_FLAGGED_RUNS);
  const paidOnly = runs.map((r) => ({ ...r, status: 'paid' as const }));
  assert.equal(payrollFlagsFor(db, paidOnly, adminUser).size, 0);
  // nothing written
  const before = all(db, 'SELECT id, gross, status FROM payroll_runs ORDER BY id');
  payrollFlagsFor(db, runs, adminUser);
  assert.deepEqual(all(db, 'SELECT id, gross, status FROM payroll_runs ORDER BY id'), before);
});

test('payrollFlagsFor: each run in a batch gets the same checks as when checked alone (per-person history windows)', () => {
  const { db } = srv;
  const runs = listPayroll(db, `WHERE p.status IN ('pending', 'failed')`, []);
  assert.ok(new Set(runs.map((r) => r.userId)).size > 1 && new Set(runs.map((r) => r.weekStart)).size > 1, 'people and weeks vary');
  const adminUser = getUser(db, fx().users.admin)!;
  const batch = payrollFlagsFor(db, runs, adminUser);
  for (const r of runs) assert.deepEqual(batch.get(r.id), payrollFlagsFor(db, [r], adminUser).get(r.id), `run ${r.id} (${r.userName}, ${r.weekStart})`);
  // The gauge scan is per person: 8 weeks before their earliest run to their latest run's Sunday. An old failed
  // transfer (person 1, June) widens only its own person's window, never person 2's.
  const windows = gaugeWindows([
    { userId: 1, weekStart: '2026-10-05', weekEnd: '2026-10-11' },
    { userId: 2, weekStart: '2026-10-05', weekEnd: '2026-10-11' },
    { userId: 1, weekStart: '2026-06-08', weekEnd: '2026-06-14' },
    { userId: 2, weekStart: '2026-09-28', weekEnd: '2026-10-04' },
  ]);
  assert.deepEqual(Object.fromEntries(windows), { 1: { from: '2026-04-13', to: '2026-10-11' }, 2: { from: '2026-08-03', to: '2026-10-11' } });
});

test('LM_SMART=0: no forecast and no flags', async () => {
  await withSmart('0', async () => {
    assert.equal((await rep.get('/finance/me')).json.forecast, null);
    assert.ok((await admin.get('/finance/payroll?status=pending,failed')).json.every((r: Json) => !('flags' in r)));
    assert.equal(weekPayForecast(srv.db, getUser(srv.db, fx().users.rep)!, TODAY), null);
  });
});
