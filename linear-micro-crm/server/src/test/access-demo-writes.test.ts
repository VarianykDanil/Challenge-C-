/**
 * During the trial anyone on the office network can open the one-tap demo accounts (review of SEC-1). So a demo account
 * may play with the demo company, its own account and new records, but never change a person of the office's own
 * (their pay, role, status, employee ID, client IDs, sign-in), office-wide money and security settings, payments, or
 * the office's own records; and it never downloads a payment file. Anything not on the list of what a demo account may
 * write is refused, so a new route is safe until someone decides otherwise. Demoting an administrator, setting one as
 * left and changing someone's employee ID need the acting administrator's fresh two-step code.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, run, type Db } from '../db/connection.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { DEMO_ACCOUNTS, currentCode, enrolTwoFactor, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const db = (): Db => srv!.db;
const idOf = (employeeId: string) => get<{ id: number }>(db(), `SELECT id FROM users WHERE lower(employee_id) = lower(?)`, [employeeId])!.id;
const refused = (r: { status: number; json: Json }) => r.status === 403 && r.json?.details?.code === 'demo_account';

function addPerson(employeeId: string, email: string, role = 'rep', first = 'Kit'): number {
  const plan = get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = 'field_rep' ORDER BY id LIMIT 1`)!.id;
  return run(
    db(),
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, ?, 'Lane', ?, ?, 1, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
    [employeeId, email, first, role, role === 'admin' ? 'assistant_owner' : 'field_rep', plan, addDays(todayISO(), -30)],
  ).lastInsertRowid;
}

/** A copy of one of `from`'s rows in `table` for `to` (other columns as they are). */
function cloneRow(table: string, where: string, params: (string | number)[], overrides: Record<string, string | number | null>): number {
  const cols = all<{ name: string; pk: number }>(db(), `PRAGMA table_info(${table})`).filter((c) => !c.pk).map((c) => c.name);
  const select = cols.map((c) => (c in overrides ? '?' : c)).join(', ');
  const values = cols.filter((c) => c in overrides).map((c) => overrides[c]!);
  return run(db(), `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${select} FROM ${table} WHERE ${where} LIMIT 1`, [...values, ...params]).lastInsertRowid;
}

interface Setup {
  kit: number;
  jordan: number;
  kitRun: number;
  kitAdjustment: number;
  batch: number;
  realEvent: number;
  demoGauge: number;
}

/** A trial database with a person of the office's own (Kit), their pay run, an adjustment and a payment batch. */
function trialWithKit(): Setup {
  const kit = addPerson('LM-0600', 'kit.lane@office.example');
  const jordan = idOf(DEMO_ACCOUNTS.rep.employeeId);
  const week = mondayOf(addDays(todayISO(), -7));
  const kitRun = cloneRow('payroll_runs', `user_id = ?`, [jordan], { user_id: kit, week_start: addDays(week, -70), status: 'pending', paid_date: null, reference: 'KIT-0001' });
  const kitAdjustment = run(
    db(),
    `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, created_by, created_at) VALUES (?, ?, NULL, 'adjustment', 10, 'Travel', NULL, ?)`,
    [kit, week, new Date().toISOString()],
  ).lastInsertRowid;
  const connection = run(
    db(),
    `INSERT INTO payment_connections (provider, name, mode, settings_json, status, created_at) VALUES ('bank_file', 'Office bank', 'test', '{}', 'connected', ?)`,
    [new Date().toISOString()],
  ).lastInsertRowid;
  const now = new Date().toISOString();
  const batch = run(
    db(),
    `INSERT INTO payment_batches (connection_id, provider, mode, created_at, total_pence, count, status, idempotency_key, updated_at) VALUES (?, 'bank_file', 'test', ?, 5000, 1, 'submitted', 'k-1', ?)`,
    [connection, now, now],
  ).lastInsertRowid;
  run(
    db(),
    `INSERT INTO payment_items (batch_id, payroll_run_id, user_id, week_start, amount_pence, payee_name, account_last4, status, updated_at, live) VALUES (?, ?, ?, ?, 5000, 'Kit Lane', '1234', 'submitted', ?, 0)`,
    [batch, kitRun, kit, addDays(week, -70), now],
  );
  // an event the office made in the app (the audit trail says so)
  const realEvent = cloneRow('events', `id = 1`, [], { name: 'Our own roadshow' });
  run(db(), `INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary, kind) VALUES (?, ?, 'POST /events', 'event', ?, 'Created event', 'change')`, [now, kit, realEvent]);
  const demoGauge = get<{ id: number }>(db(), `SELECT id FROM gauge_entries WHERE user_id = ? ORDER BY id LIMIT 1`, [jordan])!.id;
  srv!.resetCache();
  return { kit, jordan, kitRun, kitAdjustment, batch, realEvent, demoGauge };
}

test('a one-tap demo admin cannot touch a person of the office’s own: pay, role, status, employee ID, client IDs, gauges, pay runs, payments', async () => {
  srv = await startTestServer({ seed: true });
  const s = trialWithKit();
  const demo = await srv.login('admin');
  const week = mondayOf(todayISO());
  const bcn = get<{ id: number }>(db(), `SELECT id FROM campaigns WHERE code = 'BCN'`)!.id;
  const event = get<{ id: number; date: string }>(db(), `SELECT id, date FROM events WHERE id <= 10 ORDER BY id LIMIT 1`)!;

  const attempts: [string, Promise<{ status: number; json: Json }>][] = [
    ['adjustment for Kit', demo.post('/pay/adjustments', { userId: s.kit, targetWeekStart: week, amount: 1500, note: 'x' })],
    ['bonus for Kit', demo.post('/pay/bonuses', { userId: s.kit, weekStart: week, amount: 2500, note: 'thanks' })],
    ['remove Kit’s adjustment', demo.del(`/pay/adjustments/${s.kitAdjustment}`)],
    ['Kit → leader', demo.patch(`/users/${s.kit}`, { role: 'leader' })],
    ['Kit → left', demo.patch(`/users/${s.kit}`, { status: 'left' })],
    ['Kit’s employee ID', demo.patch(`/users/${s.kit}`, { employeeId: 'LM-0999' })],
    ['Kit’s client ID', demo.put(`/statements/client-refs/${s.kit}`, [{ campaignId: bcn, ref: 'BCN-KIT' }])],
    ['a gauge for Kit', demo.post('/gauges', { eventId: event.id, userId: s.kit, date: event.date, stops: 10, tableCount: 0, presentations: 2, closes: 1, taps: 1, sales: 1 })],
    ['move a demo gauge to Kit', demo.patch(`/gauges/${s.demoGauge}`, { userId: s.kit })],
    ['Kit’s pay run paid', demo.post(`/finance/payroll/${s.kitRun}/pay`, {})],
    ['a batch with Kit’s run', demo.post('/payments/batches', { connectionId: 1, runIds: [s.kitRun] })],
    ['mark Kit’s batch paid', demo.post(`/payments/batches/${s.batch}/mark-paid`, {})],
    ['cancel Kit’s batch', demo.post(`/payments/batches/${s.batch}/cancel`, {})],
    ['change the office’s own event', demo.patch(`/events/${s.realEvent}`, { name: 'Renamed' })],
  ];
  for (const [what, p] of attempts) {
    const r = await p;
    assert.ok(refused(r), `${what}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /^Demo accounts cannot /);
  }
  // nothing changed
  const kit = get<{ role: string; status: string; employeeId: string }>(db(), `SELECT role, status, employee_id AS employeeId FROM users WHERE id = ?`, [s.kit])!;
  assert.deepEqual({ ...kit }, { role: 'rep', status: 'active', employeeId: 'LM-0600' });
  assert.equal(get<{ n: number }>(db(), `SELECT COUNT(*) AS n FROM pay_adjustments WHERE user_id = ?`, [s.kit])!.n, 1);
  assert.equal(get(db(), `SELECT 1 FROM user_client_refs WHERE user_id = ?`, [s.kit]), undefined);
  assert.equal(get<{ s: string }>(db(), `SELECT status AS s FROM payroll_runs WHERE id = ?`, [s.kitRun])!.s, 'pending');
  assert.equal(get<{ u: number }>(db(), `SELECT user_id AS u FROM gauge_entries WHERE id = ?`, [s.demoGauge])!.u, s.jordan);
});

test('office-wide money and security settings, payment connections and the payment file are out of reach of demo accounts', async () => {
  srv = await startTestServer({ seed: true });
  const s = trialWithKit();
  const demo = await srv.login('admin');
  const bcn = get<{ id: number }>(db(), `SELECT id FROM campaigns WHERE code = 'BCN'`)!.id;
  const attempts: [string, Promise<{ status: number; json: Json }>][] = [
    ['security settings', demo.put('/auth/security-settings', { requirePin: false, sessionMaxHours: 24 })],
    ['pay settings', demo.put('/pay/settings', { dayRate: 99 })],
    ['a pay rate', demo.post('/pay/rates', { campaignId: bcn, repRate: 50, payoutRate: 200, effectiveFrom: todayISO() })],
    ['a campaign’s pay per sale', demo.patch(`/campaigns/${bcn}`, { repCommissionPerSale: 99 })],
    ['a payment connection', demo.post('/payments/connections', { provider: 'bank_file', name: 'Mine', settings: {} })],
    ['change a payment connection', demo.patch('/payments/connections/1', { name: 'Renamed' })],
    ['remove a payment connection', demo.del('/payments/connections/1')],
    ['company details on invoices', demo.put('/invoices/company', { name: 'Someone Else Ltd' })],
    ['statement mail settings', demo.put('/statements/mail', { address: 'x@example.test', appPassword: 'abcd efgh ijkl mnop' })],
    ['statement senders', demo.put('/statements/senders', { senders: [] })],
    ['the question bank', demo.post('/recruitment/questions', { interviewType: 'first', position: 'trainee', text: 'Why?' })],
    ['the payment file', demo.get(`/payments/batches/${s.batch}/file`)],
  ];
  for (const [what, p] of attempts) {
    const r = await p;
    assert.ok(refused(r), `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  // a real administrator (two-step on) may do them
  const realAdmin = addPerson('LM-0700', 'sam.owner@office.example', 'admin', 'Sam');
  enrolTwoFactor(db(), realAdmin);
  const sam = await srv.login({ email: 'sam.owner@office.example', employeeId: 'LM-0700' });
  assert.equal((await sam.put('/pay/settings', { dayRate: 70 })).status, 200);
  assert.equal((await sam.post('/pay/adjustments', { userId: s.kit, targetWeekStart: mondayOf(todayISO()), amount: 15, note: 'Travel' })).status, 201);
});

test('a demo account still works the demo company, its own account and the records it makes', async () => {
  srv = await startTestServer({ seed: true });
  trialWithKit();
  const demo = await srv.login('admin');
  const amelia = idOf(DEMO_ACCOUNTS.leader.employeeId);
  const jordan = idOf(DEMO_ACCOUNTS.rep.employeeId);
  const week = mondayOf(todayISO());
  const ok = (r: { status: number; json: Json }, what: string) => assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  ok(await demo.patch(`/users/${amelia}`, { phone: '07700 900123' }), 'edit a demo person');
  ok(await demo.post('/pay/adjustments', { userId: jordan, targetWeekStart: week, amount: 12, note: 'Demo' }), 'pay a demo person');
  const cand = await demo.post('/recruitment/candidates', { firstName: 'Ada', lastName: 'Example', email: 'ada.example@office.example' });
  ok(cand, 'add a candidate');
  ok(await demo.patch(`/recruitment/candidates/${cand.json.id}`, { notes: 'Called back' }), 'change the candidate it made');
  const seedCandidate = get<{ id: number }>(db(), `SELECT id FROM candidates ORDER BY id LIMIT 1`)!.id;
  ok(await demo.patch(`/recruitment/candidates/${seedCandidate}`, { notes: 'Demo note' }), 'change a demo candidate');
  ok(await demo.post('/announcements', { title: 'Hello', body: 'Demo note' }), 'post an announcement');
  ok(await demo.put('/invoices/profile', { utr: null }), 'its own invoice details');
  const bcn = get<{ id: number }>(db(), `SELECT id FROM campaigns WHERE code = 'BCN'`)!.id;
  ok(await demo.patch(`/campaigns/${bcn}`, { description: 'Demo campaign' }), 'describe a demo campaign');

  // a real person who still signs in one-tap (an office's own starter account) logs their own gauges
  const kit = idOf('LM-0600');
  run(db(), `INSERT INTO meta (key, value) VALUES ('seed_demo_teams', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    JSON.stringify([{ teamId: 1, accounts: [{ id: kit, employeeId: 'LM-0600', email: 'kit.lane@office.example' }] }]),
  ]);
  srv.resetCache();
  const kitClient: TestClient = await srv.login({ email: 'kit.lane@office.example', employeeId: 'LM-0600' });
  const event = get<{ id: number; date: string }>(db(), `SELECT id, date FROM events WHERE team_id = 1 AND date <= ? ORDER BY date DESC LIMIT 1`, [todayISO()])!;
  const own = await kitClient.post('/gauges', { eventId: event.id, userId: kit, date: event.date, stops: 10, tableCount: 0, presentations: 2, closes: 1, taps: 1, sales: 1 });
  assert.notEqual(own.json?.details?.code, 'demo_account', JSON.stringify(own.json));
});

test('a demo write to a record or person that does not exist gets the route’s own 404, not a demo refusal', async () => {
  srv = await startTestServer({ seed: true });
  const demo = await srv.login('admin');
  for (const [what, p] of [
    ['an interview for no candidate', demo.post('/recruitment/interviews', { candidateId: 999999, type: 'first', scheduledAt: `${todayISO()}T10:00`, interviewerId: null })],
    ['no event', demo.patch('/events/999999', { name: 'x' })],
    ['no candidate', demo.patch('/recruitment/candidates/999999', { notes: 'x' })],
    ['no person', demo.patch('/users/999999', { city: 'Bury' })],
  ] as const) {
    const r = await p;
    assert.equal(r.status, 404, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  }
});

test('demoting an administrator, setting one as left or changing someone’s employee ID needs the admin’s fresh code', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  const me = get<{ id: number }>(db(), `SELECT id FROM users WHERE employee_id = 'FX-0001'`)!.id;
  const other = run(
    db(),
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     SELECT 'FX-0090', 'second.admin@fixture.test', 'Second', 'Admin', 'admin', 'assistant_owner', NULL, pay_plan_id, start_date, 'active', NULL, '#4F46E5', NULL FROM users WHERE id = ?`,
    [me],
  ).lastInsertRowid;
  const rep = get<{ id: number }>(db(), `SELECT id FROM users WHERE employee_id = 'FX-0004'`)!.id;
  for (const [what, id, body] of [
    ['demote', other, { role: 'rep' }],
    ['left', other, { status: 'left' }],
    ['employee ID', rep, { employeeId: 'FX-0444' }],
  ] as const) {
    const r = await admin.patch(`/users/${id}`, body);
    assert.equal(r.status, 400, `${what} without a code: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /6-digit code/);
  }
  assert.equal(get<{ role: string }>(db(), `SELECT role FROM users WHERE id = ?`, [other])!.role, 'admin');
  // with a fresh code each goes through; one code covers a change that is sensitive twice over
  const ok = await admin.patch(`/users/${other}`, { role: 'rep', email: 'second.rep@fixture.test', code: currentCode(db(), me) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.role, 'rep');
  const id = await admin.patch(`/users/${rep}`, { employeeId: 'FX-0444', code: currentCode(db(), me) });
  assert.equal(id.status, 200, JSON.stringify(id.json));
  // the same ID again is no change: no code needed
  assert.equal((await admin.patch(`/users/${rep}`, { employeeId: 'fx-0444', phone: '07700 900111' })).status, 200);
  // setting yourself as left is never allowed: that answer comes first, before any code is asked for
  const self = await admin.patch(`/users/${me}`, { status: 'left' });
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'You cannot deactivate your own account');
});

test('every write route has a rule for demo accounts, and every rule names a real route', async () => {
  const { createApp } = await import('../app.ts');
  const { listApiRoutes } = await import('../lib/routeTable.ts');
  const { DEMO_READ_RULES, DEMO_WRITE_RULES } = await import('../lib/demoWrites.ts');
  const { openDb } = await import('../db/connection.ts');
  const { createSchema } = await import('../db/schema.ts');
  const d = openDb(':memory:');
  try {
    createSchema(d);
    const routes = listApiRoutes(createApp(d)).map((r) => `${r.method} ${r.path}`);
    const writes = [...new Set(routes.filter((r) => !r.startsWith('GET ')))];
    const missing = writes.filter((r) => !(r in DEMO_WRITE_RULES));
    assert.deepEqual(missing, [], 'decide what a demo account may do with these (lib/demoWrites.ts); until then they are refused');
    const stale = [...Object.keys(DEMO_WRITE_RULES), ...Object.keys(DEMO_READ_RULES)].filter((k) => !routes.includes(k));
    assert.deepEqual(stale, [], 'rules for routes that do not exist');
  } finally {
    d.close();
  }
});
