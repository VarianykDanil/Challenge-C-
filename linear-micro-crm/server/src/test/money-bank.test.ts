/**
 * MON-3 / SECURITY-MISSED-2: one administrator alone can no longer redirect someone's pay. Bank details an admin types
 * in (or changes) for someone else wait until that person confirms them in their own account, or a DIFFERENT admin
 * confirms them with a fresh code. The person is told ("Your bank details were changed by … Confirm or report it"), can
 * report them as not theirs, and payments skip details that are waiting. Everything is audited, never the numbers.
 * Bank details are obviously fake (00-00-00 / 0000000x): the repository is public.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf } from '../lib/dates.ts';
import { currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let admin2: TestClient;
let admin2Id: number;
let rep: TestClient;
let repB: TestClient;
let leader: TestClient;

const details = (account: string, holder = 'Remy Rep') => ({ holderName: holder, sortCode: '00-00-00', accountNumber: account });

function addRun(db: Db, userId: number, weekStart: string, gross: number): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [userId, weekStart, addDays(weekStart, 6), gross, gross, paydayForWeek(weekStart), `PAY-B-${userId}-${weekStart}`],
  ).lastInsertRowid;
}

async function setup(): Promise<void> {
  srv = await startTestServer();
  fx = srv.fixture!;
  admin2Id = run(
    srv.db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES ('FX-0009', 'abe.admin@fixture.test', 'Abe', 'Admin', 'admin', 'assistant_owner', NULL, ?, ?, 'active', NULL, '#4F46E5', 'Manchester')`,
    [fx.plans.owner, addDays(fx.today, -365)],
  ).lastInsertRowid;
  [admin, rep, repB, leader] = await Promise.all((['admin', 'rep', 'repB', 'leader'] as const).map((r) => srv.login(r)));
  admin2 = await srv.login({ email: 'abe.admin@fixture.test', employeeId: 'FX-0009' });
}

const code = (userId: number) => currentCode(srv.db, userId);

async function fileConnection(): Promise<number> {
  const id = (await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'generic' } })).json.id as number;
  // bank files start in test mode (CLM-3): this test pays for real
  const live = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: 'PAY FOR REAL' });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  return id;
}

describe('MON-3: bank details typed in by an administrator wait for the person or a second administrator', () => {
  beforeEach(setup);
  afterEach(() => srv.close());

  test('the review probe: the admin types in Remy\'s details; they are NOT confirmed by that admin and payments skip them', async () => {
    const r = await admin.put(`/users/${fx.users.rep}/bank-details`, { ...details('00000007'), code: code(fx.users.admin) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const d = r.json.details;
    assert.equal(d.needsConfirmation, true);
    assert.equal(d.confirmedByAdminAt, null);
    assert.equal(d.changedByName, 'Ada Admin');
    assert.equal(d.waitingFor, 'person_or_other_admin');
    // the same admin cannot confirm what they typed
    const self = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: d.changedAt, code: code(fx.users.admin) });
    assert.equal(self.status, 403, JSON.stringify(self.json));
    assert.match(self.json.error, /someone else/i);
    // a payment leaves Remy out, saying why
    const conn = await fileConnection();
    const week = addDays(mondayOf(fx.today), -14);
    const runId = addRun(srv.db, fx.users.rep, week, 120);
    const other = addRun(srv.db, fx.users.repA2, week, 80);
    run(srv.db, `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
                 VALUES (?, 'Rita Rep', ?, ?, '0002', '00', ?, ?, ?, ?)`,
      [fx.users.repA2, encrypt('000000'), encrypt('00000002'), new Date(businessNow().getTime() - 86_400_000).toISOString(), fx.users.repA2, new Date(businessNow().getTime() - 3_600_000).toISOString(), fx.users.admin]);
    const draft = await admin.post('/payments/batches', { connectionId: conn, runIds: [runId, other] });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    const skip = (draft.json.skipped as Json[]).find((s) => s.runId === runId);
    assert.equal(skip.code, 'bank_details_unconfirmed');
    assert.match(skip.reason, /Ada Admin typed in Remy’s bank details/);
    assert.match(skip.reason, /Remy confirms them|another administrator/);
  });

  test('the person sees a notice and confirms them in their own account (with their code)', async () => {
    const r = await admin.put(`/users/${fx.users.rep}/bank-details`, { ...details('00000007'), code: code(fx.users.admin) });
    srv.resetCache();
    const feed = await rep.get('/me/attention');
    const notice = (feed.json.items as Json[]).find((i) => String(i.key).startsWith('payments:bank-notice'));
    assert.ok(notice, JSON.stringify(feed.json.items.map((i: Json) => i.key)));
    assert.match(notice.title, /Your bank details were changed by Ada Admin on /);
    assert.match(notice.body, /Confirm or report it/);
    assert.equal(notice.severity, 'danger');
    const mine = await rep.get('/me/bank-details');
    assert.equal(mine.json.details.waitingFor, 'person_or_other_admin');
    assert.equal(mine.json.canConfirm, true);
    const ok = await rep.post('/me/bank-details/confirm', { changedAt: r.json.details.changedAt, code: code(fx.users.rep) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.details.needsConfirmation, false);
    assert.equal(ok.json.details.confirmedByName, 'Remy Rep');
    srv.resetCache();
    assert.ok(!((await rep.get('/me/attention')).json.items as Json[]).some((i) => String(i.key).startsWith('payments:bank-notice')), 'gone once confirmed');
    const audit = all<{ summary: string; b: string | null; a: string | null }>(srv.db, `SELECT summary, before_json AS b, after_json AS a FROM audit_log WHERE entity = 'bank_account' ORDER BY id`);
    assert.ok(audit.some((x) => /Remy Rep confirmed their own bank details/.test(x.summary)), JSON.stringify(audit.map((x) => x.summary)));
    assert.ok(!JSON.stringify(audit).includes('00000007'), 'never the numbers');
  });

  test('a different administrator may confirm them, with a fresh code', async () => {
    const r = await admin.put(`/users/${fx.users.rep}/bank-details`, { ...details('00000007'), code: code(fx.users.admin) });
    const noCode = await admin2.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: r.json.details.changedAt });
    assert.equal(noCode.status, 400, 'a fresh code is needed');
    const ok = await admin2.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: r.json.details.changedAt, code: code(admin2Id) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.details.needsConfirmation, false);
    assert.equal(ok.json.details.confirmedByName, 'Abe Admin');
    // the person is still told (they never agreed to it themselves), and can say "yes, these are mine"
    srv.resetCache();
    assert.ok(((await rep.get('/me/attention')).json.items as Json[]).some((i) => String(i.key).startsWith('payments:bank-notice')));
    const seen = await rep.post('/me/bank-details/confirm', { changedAt: r.json.details.changedAt, code: code(fx.users.rep) });
    assert.equal(seen.status, 200);
    srv.resetCache();
    assert.ok(!((await rep.get('/me/attention')).json.items as Json[]).some((i) => String(i.key).startsWith('payments:bank-notice')));
  });

  test('the person reports them as not theirs: held, the office is told, nobody can confirm them', async () => {
    const r = await admin.put(`/users/${fx.users.rep}/bank-details`, { ...details('00000007'), code: code(fx.users.admin) });
    const report = await rep.post('/me/bank-details/report', { note: 'Not my account' });
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.ok(report.json.details.reportedAt);
    assert.equal(report.json.details.needsConfirmation, true);
    const blocked = await admin2.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: r.json.details.changedAt, code: code(admin2Id) });
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error, /not theirs/);
    srv.resetCache();
    const feed = await admin2.get('/me/attention');
    const item = (feed.json.items as Json[]).find((i) => String(i.key).startsWith('payments:bank-reported'));
    assert.ok(item, JSON.stringify(feed.json.items.map((i: Json) => i.key)));
    assert.equal(item.severity, 'danger');
    assert.match(item.title, /Remy Rep says/);
    assert.ok(all(srv.db, `SELECT 1 FROM audit_log WHERE entity = 'bank_account' AND summary LIKE '%reported%'`).length >= 1);
    // new details typed in WITH the person clear the report (and wait again)
    const again = await admin2.put(`/users/${fx.users.rep}/bank-details`, { ...details('00000008'), code: code(admin2Id) });
    assert.equal(again.status, 200);
    assert.equal(again.json.details.reportedAt, null);
  });

  test('a person\'s own change waits for an administrator; they cannot confirm it themselves', async () => {
    const own = await rep.put('/me/bank-details', { ...details('00000005'), code: code(fx.users.rep) });
    assert.equal(own.status, 200);
    assert.equal(own.json.details.waitingFor, 'office');
    assert.equal(own.json.canConfirm, false);
    const self = await rep.post('/me/bank-details/confirm', { changedAt: own.json.details.changedAt, code: code(fx.users.rep) });
    assert.equal(self.status, 409);
    const ok = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: own.json.details.changedAt, code: code(fx.users.admin) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.details.needsConfirmation, false);
  });

  test('an administrator\'s own details wait for another administrator', async () => {
    const own = await admin.put('/me/bank-details', { ...details('00000001', 'Ada Admin'), code: code(fx.users.admin) });
    assert.equal(own.status, 200);
    assert.equal(own.json.details.needsConfirmation, true);
    assert.equal((await admin.post(`/users/${fx.users.admin}/bank-details/confirm`, { changedAt: own.json.details.changedAt, code: code(fx.users.admin) })).status, 403);
    assert.equal((await admin2.post(`/users/${fx.users.admin}/bank-details/confirm`, { changedAt: own.json.details.changedAt, code: code(admin2Id) })).status, 200);
  });

  test('with only one administrator, their own changed details say nobody can confirm them (payments to them are skipped)', async () => {
    run(srv.db, `UPDATE users SET status = 'left' WHERE id = ?`, [admin2Id]);
    srv.resetCache();
    const own = await admin.put('/me/bank-details', { ...details('00000001', 'Ada Admin'), code: code(fx.users.admin) });
    assert.equal(own.status, 200);
    assert.equal(own.json.noOtherAdmin, true, 'the card says why nobody can confirm them');
    // with a second administrator there is someone to confirm them
    run(srv.db, `UPDATE users SET status = 'active' WHERE id = ?`, [admin2Id]);
    srv.resetCache();
    assert.equal((await admin.get('/me/bank-details')).json.noOtherAdmin, undefined);
    // a rep's own change is not about this
    const repOwn = await rep.put('/me/bank-details', { ...details('00000005'), code: code(fx.users.rep) });
    assert.equal(repOwn.json.noOtherAdmin, undefined);
  });

  test('details whose changer was deleted wait for the office, as the label says; the person cannot confirm them', async () => {
    const put = await rep.put('/me/bank-details', { ...details('00000005'), code: code(fx.users.rep) });
    assert.equal(put.status, 200);
    run(srv.db, `UPDATE bank_accounts SET changed_by = NULL WHERE user_id = ?`, [fx.users.rep]);
    srv.resetCache();
    const mine = (await rep.get('/me/bank-details')).json;
    assert.equal(mine.details.waitingFor, 'office');
    assert.equal(mine.canConfirm, false);
    assert.equal((await rep.post('/me/bank-details/confirm', { changedAt: mine.details.changedAt, code: code(fx.users.rep) })).status, 409);
    const asAdmin = (await admin.get(`/users/${fx.users.rep}/bank-details`)).json;
    assert.equal(asAdmin.details.waitingFor, 'office');
    assert.equal(asAdmin.canConfirm, true);
    assert.equal((await admin.post(`/users/${fx.users.rep}/bank-details/confirm`, { changedAt: mine.details.changedAt, code: code(fx.users.admin) })).status, 200);
  });

  test('typing in someone\'s details needs the admin\'s fresh code; reps, leaders and client accounts cannot', async () => {
    const noCode = await admin.put(`/users/${fx.users.rep}/bank-details`, details('00000007'));
    assert.equal(noCode.status, 400);
    assert.equal((await leader.put(`/users/${fx.users.rep}/bank-details`, details('00000007'))).status, 403);
    assert.equal((await repB.post(`/users/${fx.users.rep}/bank-details/confirm`, {})).status, 403);
    assert.equal((await repB.post('/me/bank-details/report', {})).status, 404, 'nothing to report');
    assert.equal((await srv.anon().post('/me/bank-details/confirm', {})).status, 401);
    const client = await srv.login('client');
    assert.equal((await client.post('/me/bank-details/confirm', {})).status, 403);
  });
});

describe('MON-3: upgrading a 1.4.0 database', () => {
  test('details an administrator typed in and "confirmed" themselves are held again; the rest are kept', async () => {
    srv = await startTestServer();
    fx = srv.fixture!;
    const db = srv.db;
    try {
      const at = new Date(Date.now() - 86_400_000).toISOString();
      const ins = (userId: number, changedBy: number, confirmedBy: number | null) =>
        run(db, `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
                 VALUES (?, 'X Y', ?, ?, '0001', '00', ?, ?, ?, ?)`, [userId, encrypt('000000'), encrypt('00000001'), at, changedBy, confirmedBy ? at : null, confirmedBy]);
      ins(fx.users.rep, fx.users.admin, fx.users.admin); // typed in and self-confirmed by the admin (1.4.0)
      ins(fx.users.repA2, fx.users.repA2, fx.users.admin); // the person's own, confirmed by the admin
      // a 1.4.0 database: the new columns do not exist yet
      for (const c of ['reported_at', 'reported_note', 'person_seen_at']) {
        try { db.exec(`ALTER TABLE bank_accounts DROP COLUMN ${c}`); } catch { /* not there */ }
      }
      db.prepare(`DELETE FROM meta WHERE key = 'ext:payments:bank-rehold'`).run();
      const changed = createSchema(db);
      assert.ok(changed.includes('payments:bank_accounts.rehold'), JSON.stringify(changed));
      const held = (id: number) => get<{ c: string | null }>(db, `SELECT confirmed_by_admin_at AS c FROM bank_accounts WHERE user_id = ?`, [id])!.c === null;
      assert.equal(held(fx.users.rep), true, 'one admin alone: held again');
      assert.equal(held(fx.users.repA2), false, 'confirmed by someone other than who changed them: kept');
      assert.deepEqual(createSchema(db).filter((c) => c.startsWith('payments:')), [], 'once');
    } finally {
      await srv.close();
    }
  });
});

