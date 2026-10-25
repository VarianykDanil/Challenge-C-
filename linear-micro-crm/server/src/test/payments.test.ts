/**
 * Release 1.4 — package F (payments foundation): every payments and bank-details route for every role (admin,
 * leader, recruiter, rep, client, signed out), the batch lifecycle with the fake provider (draft → approve with a fresh
 * two-step code → paid / failed / processing → refresh), never paying a run twice (resubmits, the unique index, the
 * hold on Mark paid, approvals that race), test mode paying nobody, bank files, the 501 of the four providers until
 * packages P and A land, and secrets / account numbers never leaving the server.
 */
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { PAYMENT_LIVE_CONFIRMATION, paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf } from '../lib/dates.ts';
import { createFakeProvider, type FakeProvider } from '../lib/payments/fake.ts';
import { providerFetch, redactSecrets } from '../lib/payments/http.ts';
import { validateConfigFields } from '../lib/payments/provider.ts';
import { registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { stubProvider } from '../lib/payments/stubs.ts';
import { totp } from '../lib/totp.ts';
import { resetCodeFailures } from '../lib/twofactor.ts';
import { isWriteLimited } from '../middleware/writeLimit.ts';
import { currentCode, enrolTwoFactor, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

// ───────────────────────────── helpers ─────────────────────────────

function addRun(db: Db, p: { userId: number; weekStart: string; gross: number; status?: 'pending' | 'failed' | 'paid' | 'late'; paidDate?: string | null; ref?: string }): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)`,
    [p.userId, p.weekStart, addDays(p.weekStart, 6), p.gross, p.gross, paydayForWeek(p.weekStart), p.paidDate ?? null, p.status ?? 'pending', p.ref ?? `PAY-T-${p.userId}-${p.weekStart}`],
  ).lastInsertRowid;
}

/**
 * A user's two-step secret. Release 1.4 (S, two-step for everyone): the fixture's accounts already signed in with two-step
 * on (helpers.ts set it up), so this hands back that enrolled secret; it sets two-step up (no QR dance) only for someone
 * who has none yet.
 */
function enable2fa(db: Db, userId: number): string {
  const row = get<{ s: string | null }>(db, `SELECT totp_secret_enc AS s FROM users WHERE id = ? AND totp_enabled_at IS NOT NULL`, [userId]);
  return row?.s ? decrypt(row.s) : enrolTwoFactor(db, userId);
}

/** A code the server accepts now (a code works once: the replay marker is cleared first). */
function freshCode(db: Db, userId: number, secret: string): string {
  run(db, `UPDATE users SET totp_last_counter = NULL WHERE id = ?`, [userId]);
  return totp(secret);
}

/** Bank details straight into the table (sort code 00-00-00 is obviously fake). */
function setBank(db: Db, userId: number, opts: { account?: string; confirmed?: boolean; holder?: string } = {}): void {
  const account = opts.account ?? `0000${String(userId).padStart(4, '0')}`;
  // a day before now on the business clock, the clock payments compare bank details changes with (LM_BUSINESS_NOW)
  const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET account_number_enc = excluded.account_number_enc, last4 = excluded.last4, changed_at = excluded.changed_at, confirmed_by_admin_at = excluded.confirmed_by_admin_at`,
    [userId, opts.holder ?? `Person ${userId}`, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, opts.confirmed === false ? null : at],
  );
}

const runStatus = (db: Db, id: number) => get<{ status: string; paidDate: string | null }>(db, `SELECT status, paid_date AS paidDate FROM payroll_runs WHERE id = ?`, [id])!;

let srv: TestServer;
let fx: NonNullable<TestServer['fixture']>;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let client: TestClient;
let anon: TestClient;
let fake: FakeProvider;
let adminSecret: string;
let weeks: { w3: string; w4: string; w5: string; current: string };

async function setup(): Promise<void> {
  srv = await startTestServer();
  fx = srv.fixture!;
  [admin, leader, recruiter, rep, client] = await Promise.all((['admin', 'leader', 'recruiter', 'rep', 'client'] as const).map((r) => srv.login(r)));
  anon = srv.anon();
  const monday = mondayOf(fx.today);
  weeks = { w3: addDays(monday, -21), w4: addDays(monday, -28), w5: addDays(monday, -35), current: monday };
}

/** A fake API connection (switched to live when asked) and the admin's two-step verification on. */
async function fakeConnection(opts: { live?: boolean; kind?: 'api' | 'file' } = {}): Promise<number> {
  fake = createFakeProvider({ kind: opts.kind ?? 'api' });
  registerPaymentProvider(fake);
  const made = await admin.post('/payments/connections', { provider: 'fake', name: 'Fake', settings: { label: 'x' }, secrets: { token: 'tok-SECRET-123456' } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.id as number;
  if (opts.kind !== 'file') {
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    if (opts.live) {
      const live = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
      assert.equal(live.status, 200, JSON.stringify(live.json));
      assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.ok, true);
    }
  }
  return id;
}

// ───────────────────────────── who may call what ─────────────────────────────

describe('role scoping: payments are admin only, bank details are your own (or the admin’s)', () => {
  before(setup);
  after(async () => {
    unregisterPaymentProvider('fake');
    await srv.close();
  });

  const ADMIN_ROUTES: [string, string][] = [
    ['GET', '/payments/providers'],
    ['GET', '/payments/connections'],
    ['POST', '/payments/connections'],
    ['PATCH', '/payments/connections/1'],
    ['DELETE', '/payments/connections/1'],
    ['POST', '/payments/connections/1/test'],
    ['GET', '/payments/batches'],
    ['POST', '/payments/batches'],
    ['GET', '/payments/batches/1'],
    ['POST', '/payments/batches/1/approve'],
    ['POST', '/payments/batches/1/refresh'],
    ['POST', '/payments/batches/1/cancel'],
    ['GET', '/payments/batches/1/file'],
    ['POST', '/payments/batches/1/mark-paid'],
    ['GET', '/users/2/bank-details'],
    ['PUT', '/users/2/bank-details'],
    ['POST', '/users/2/bank-details/confirm'],
  ];

  test('signed out: 401 everywhere', async () => {
    for (const [m, p] of [...ADMIN_ROUTES, ['GET', '/me/bank-details'], ['PUT', '/me/bank-details']] as [string, string][]) {
      assert.equal((await anon.req(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
    }
  });

  test('leader, recruiter, rep: 403 on every admin route; client: 403 (client portal only) on all of them and on /me/bank-details', async () => {
    for (const [m, p] of ADMIN_ROUTES) {
      for (const [who, c] of [['leader', leader], ['recruiter', recruiter], ['rep', rep]] as const) {
        assert.equal((await c.req(m, p, m === 'GET' ? undefined : {})).status, 403, `${who} ${m} ${p}`);
      }
      const r = await client.req(m, p, m === 'GET' ? undefined : {});
      assert.equal(r.status, 403, `client ${m} ${p}`);
      assert.equal(r.json.clientPortalOnly, true);
    }
    for (const [m, p] of [['GET', '/me/bank-details'], ['PUT', '/me/bank-details']] as const) {
      const r = await client.req(m, p, m === 'GET' ? undefined : {});
      assert.equal(r.status, 403);
      assert.equal(r.json.clientPortalOnly, true);
    }
  });

  test('admin reaches every route (no 401/403)', async () => {
    for (const [m, p] of ADMIN_ROUTES) {
      const r = await admin.req(m, p, m === 'GET' ? undefined : {});
      assert.ok(r.status !== 401 && r.status !== 403, `${m} ${p} → ${r.status}`);
    }
  });

  test('every staff role reads and saves their own bank details; leaders cannot see their team’s', async () => {
    // Release 1.4 (S): everyone signs in with two-step now, so every change asks for a current code
    for (const c of [admin, leader, recruiter, rep]) {
      const r = await c.get('/me/bank-details');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { details: null, codeRequired: true });
    }
    const saved = await rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '00-00-00', accountNumber: '0000 0042', code: currentCode(srv.db, fx.users.rep) });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal((await leader.get(`/users/${fx.users.rep}/bank-details`)).status, 403, 'a leader never sees a team member’s bank details');
    assert.equal((await recruiter.get(`/users/${fx.users.rep}/bank-details`)).status, 403);
    assert.equal((await rep.get(`/users/${fx.users.repA2}/bank-details`)).status, 403);
    assert.equal((await rep.get(`/users/${fx.users.rep}/bank-details`)).status, 403, 'the admin route, even for yourself');
  });

  test('every write route is under the per-person write limit', () => {
    for (const [m, p] of [...ADMIN_ROUTES, ['PUT', '/me/bank-details']] as [string, string][]) {
      if (m === 'GET') continue;
      assert.equal(isWriteLimited(m, p), true, `${m} ${p}`);
    }
    assert.equal(isWriteLimited('GET', '/payments/batches'), false);
  });
});

// ───────────────────────────── providers and connections ─────────────────────────────

describe('ways to pay and connections', () => {
  beforeEach(setup);
  afterEach(async () => {
    unregisterPaymentProvider('fake');
    await srv.close();
  });

  test('the four ways to pay, with plain abilities, form fields; all four available since packages P and A', async () => {
    const r = await admin.get('/payments/providers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((p: Json) => p.id), ['bank_file', 'revolut', 'wise', 'truelayer']);
    for (const p of r.json as Json[]) {
      // Release 1.4: the bank payment file (P, paymentsFile.test.ts) and the API providers (A, payments-api.test.ts)
      assert.equal(p.available, true, p.id);
      assert.ok(p.configFields.length > 0, p.id);
      assert.ok(typeof p.abilities.paysFromApp === 'boolean' && p.abilities.fees && p.abilities.setup.length, p.id);
    }
    assert.equal(r.json.find((p: Json) => p.id === 'bank_file').kind, 'file');
    assert.ok(r.json.find((p: Json) => p.id === 'revolut').configFields.some((f: Json) => f.name === 'privateKey' && f.secret === true));
    registerPaymentProvider(createFakeProvider());
    assert.ok((await admin.get('/payments/providers')).json.some((p: Json) => p.id === 'fake' && p.available));
  });

  test('a connection starts in test mode; secrets are stored encrypted and never answered or recorded', async () => {
    // package A: Revolut's form needs a real RSA key, the redirect address and the code from Revolut
    const secret = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const marker = secret.split('\n')[1].slice(0, 24);
    const made = await admin.post('/payments/connections', { provider: 'revolut', settings: { clientId: 'client-abc', redirectUri: 'https://example.com' }, secrets: { privateKey: secret, authCode: 'oa_sand_code_123' } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.mode, 'test');
    assert.equal(made.json.status, 'not_connected');
    assert.equal(made.json.name, 'Revolut Business');
    assert.deepEqual(made.json.secretsSet, ['authCode', 'privateKey']);
    assert.deepEqual(made.json.settings, { clientId: 'client-abc', redirectUri: 'https://example.com' });
    const everything = JSON.stringify([made.json, (await admin.get('/payments/connections')).json]);
    assert.ok(!everything.includes(marker) && !everything.includes('oa_sand_code_123'), 'no secret in any answer');
    const stored = get<{ enc: string }>(srv.db, `SELECT secrets_enc AS enc FROM payment_connections WHERE id = ?`, [made.json.id])!.enc;
    assert.match(stored, /^v1:/);
    assert.ok(!stored.includes(marker));
    const audit = JSON.stringify(all(srv.db, `SELECT summary, before_json, after_json FROM audit_log`));
    assert.ok(!audit.includes(marker) && !audit.includes('oa_sand_code_123'), 'no secret in the audit trail');
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE entity = 'payment_connection'`).some((r) => /Revolut Business/.test(r.summary)));
    // an edit that leaves the secret empty keeps it
    const renamed = await admin.patch(`/payments/connections/${made.json.id}`, { name: 'Revolut (office)', secrets: { privateKey: '' } });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.json.secretsSet, ['authCode', 'privateKey']);
    // required fields, plainly
    const missing = await admin.post('/payments/connections', { provider: 'revolut', settings: {} });
    assert.equal(missing.status, 400);
    assert.ok(missing.json.details.some((d: Json) => d.path === 'clientId' && /Client ID is needed/.test(d.message)));
    assert.equal((await admin.post('/payments/connections', { provider: 'paypal' })).status, 400);
  });

  test('testing or paying through a provider not built yet answers 501 with a plain sentence', async () => {
    // package A built Wise: its stub stands in here for "a way to pay this version cannot use yet"
    registerPaymentProvider(stubProvider('wise'));
    try {
      const made = await admin.post('/payments/connections', { provider: 'wise', secrets: { apiToken: 'wise-token-123456' } });
      const t = await admin.post(`/payments/connections/${made.json.id}/test`);
      assert.equal(t.status, 501);
      assert.match(t.json.error, /Paying through Wise Business is not switched on in this version of Linear Hub yet/);
      assert.ok(!JSON.stringify(t.json).includes('wise-token'));
    } finally {
      unregisterPaymentProvider('wise');
    }
  });

  test('a bank file connection makes real files at once; it has no test mode', async () => {
    const made = await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'generic' } });
    assert.equal(made.status, 201);
    assert.equal(made.json.mode, 'live');
    assert.equal(made.json.status, 'connected');
    assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'test' })).status, 400);
    assert.equal((await admin.post('/payments/connections', { provider: 'bank_file', settings: { format: 'mt940' } })).status, 400, 'only the listed formats');
  });

  test('live needs a working test and the words typed exactly; changing details needs a new test', async () => {
    fake = createFakeProvider();
    registerPaymentProvider(fake);
    const id = (await admin.post('/payments/connections', { provider: 'fake' })).json.id;
    assert.equal((await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION })).status, 409, 'test first');
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.connection.status, 'connected');
    const lower = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: 'pay for real' });
    assert.equal(lower.status, 400);
    assert.match(lower.json.error, /type PAY FOR REAL exactly/);
    const live = await admin.patch(`/payments/connections/${id}`, { mode: 'live', confirm: 'PAY FOR REAL' });
    assert.equal(live.status, 200);
    assert.equal(live.json.mode, 'live');
    assert.ok(live.json.liveConfirmedAt);
    assert.equal(live.json.status, 'not_connected', 'the live service gets its own test');
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE entity = 'payment_connection'`).some((r) => /live/i.test(r.summary)));
    assert.equal((await admin.post(`/payments/connections/${id}/test`)).json.connection.status, 'connected');
    const edited = await admin.patch(`/payments/connections/${id}`, { settings: { label: 'new' } });
    assert.equal(edited.json.status, 'not_connected');
    fake.script({ testResult: { ok: false, message: 'The token tok-ABCDEFGH was refused' } });
    const bad = await admin.post(`/payments/connections/${id}/test`);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.connection.status, 'error');
    // disconnect: secrets wiped, history kept
    const gone = await admin.del(`/payments/connections/${id}`);
    assert.equal(gone.status, 200);
    assert.ok(gone.json.disconnectedAt);
    assert.equal(get<{ enc: string | null }>(srv.db, `SELECT secrets_enc AS enc FROM payment_connections WHERE id = ?`, [id])!.enc, null);
    assert.equal((await admin.patch(`/payments/connections/${id}`, { name: 'x' })).status, 409);
  });
});

// ───────────────────────────── bank details ─────────────────────────────

describe('bank details', () => {
  beforeEach(setup);
  afterEach(() => srv.close());

  test('validated plainly, masked on every read, encrypted at rest, never in the audit trail', async () => {
    const bad = await rep.put('/me/bank-details', { holderName: '', sortCode: '12-34', accountNumber: '123' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.details.map((d: Json) => d.path), ['holderName', 'sortCode', 'accountNumber']);
    const saved = await rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '00-00-34', accountNumber: '0000 5678', code: currentCode(srv.db, fx.users.rep) });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const d = saved.json.details;
    assert.equal(d.sortCodeMasked, '••-••-34');
    assert.equal(d.accountNumberMasked, '••••5678');
    assert.equal(d.needsConfirmation, true, 'a person’s own change waits for the admin');
    const reads = JSON.stringify([saved.json, (await rep.get('/me/bank-details')).json, (await admin.get(`/users/${fx.users.rep}/bank-details`)).json]);
    assert.ok(!reads.includes('00005678') && !reads.includes('000034'), 'the numbers never leave the server');
    const row = get<{ s: string; a: string }>(srv.db, `SELECT sort_code_enc AS s, account_number_enc AS a FROM bank_accounts WHERE user_id = ?`, [fx.users.rep])!;
    assert.match(row.s, /^v1:/);
    assert.ok(!row.a.includes('5678'));
    const audit = all<{ summary: string; entity: string; b: string | null; a: string | null }>(srv.db, `SELECT summary, entity, before_json AS b, after_json AS a FROM audit_log WHERE entity = 'bank_account'`);
    assert.equal(audit.length, 1);
    assert.match(audit[0]!.summary, /bank details/i);
    assert.ok(!JSON.stringify(audit).includes('00005678'));
    // the same details again: nothing new
    assert.equal((await rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '000034', accountNumber: '00005678', code: currentCode(srv.db, fx.users.rep) })).status, 200);
    assert.equal(all(srv.db, `SELECT 1 FROM audit_log WHERE entity = 'bank_account'`).length, 1);
  });

  test('a change by the person puts a Needs-attention item in the admin’s feed until the admin confirms', async () => {
    assert.equal((await rep.put('/me/bank-details', { holderName: 'Remy Rep', sortCode: '000000', accountNumber: '00000004', code: currentCode(srv.db, fx.users.rep) })).status, 200);
    srv.resetCache();
    const feed = await admin.get('/me/attention');
    const item = feed.json.items.find((i: Json) => i.kind === 'payments');
    assert.ok(item, JSON.stringify(feed.json.items.map((i: Json) => i.key)));
    assert.match(item.title, /Remy Rep changed their bank details/);
    assert.equal(item.href, `/team/${fx.users.rep}#bank-details`);
    assert.ok(!(await rep.get('/me/attention')).json.items.some((i: Json) => i.kind === 'payments'), 'only the admin sees it');
    const ok = await admin.post(`/users/${fx.users.rep}/bank-details/confirm`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.details.needsConfirmation, false);
    srv.resetCache();
    assert.ok(!(await admin.get('/me/attention')).json.items.some((i: Json) => i.kind === 'payments'));
    assert.equal((await admin.post(`/users/${fx.users.repB}/bank-details/confirm`)).status, 404, 'nothing to confirm');
  });

  test('details an admin types in for someone count as confirmed', async () => {
    const r = await admin.put(`/users/${fx.users.repB}/bank-details`, { holderName: 'Bo Rep', sortCode: '000000', accountNumber: '00000006', code: currentCode(srv.db, fx.users.admin) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.details.needsConfirmation, false);
    assert.match(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE entity = 'bank_account'`)[0]!.summary, /Bo Rep/);
  });

  test('with two-step verification on, a change needs a current code (a typing mistake never uses one up)', async () => {
    const secret = enable2fa(srv.db, fx.users.rep);
    assert.equal((await rep.get('/me/bank-details')).json.codeRequired, true);
    const body = { holderName: 'Remy Rep', sortCode: '000000', accountNumber: '00000004' };
    assert.equal((await rep.put('/me/bank-details', body)).status, 400);
    const wrong = await rep.put('/me/bank-details', { ...body, code: '000000' === totp(secret) ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /code is not right/);
    const typo = await rep.put('/me/bank-details', { ...body, accountNumber: '12', code: freshCode(srv.db, fx.users.rep, secret) });
    assert.equal(typo.status, 400);
    assert.deepEqual(typo.json.details.map((d: Json) => d.path), ['accountNumber']);
    const ok = await rep.put('/me/bank-details', { ...body, code: totp(secret) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    resetCodeFailures();
  });

  test('client accounts have no bank details, even through the admin route', async () => {
    const c = get<{ id: number }>(srv.db, `SELECT id FROM users WHERE role = 'client' LIMIT 1`)!;
    assert.equal((await admin.get(`/users/${c.id}/bank-details`)).status, 400);
    assert.equal((await admin.get('/users/999999/bank-details')).status, 404);
  });
});

// ───────────────────────────── batches ─────────────────────────────

describe('payment batches with the fake provider', () => {
  beforeEach(async () => {
    await setup();
    resetCodeFailures();
  });
  afterEach(async () => {
    unregisterPaymentProvider('fake');
    await srv.close();
  });

  test('draft: only payable runs go in, every other one is skipped with a plain reason; amounts in exact pence', async () => {
    const conn = await fakeConnection({ live: true });
    setBank(srv.db, fx.users.rep);
    setBank(srv.db, fx.users.repB, { confirmed: false });
    setBank(srv.db, fx.users.leader);
    const ok = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 345.15 });
    const noBank = addRun(srv.db, { userId: fx.users.repA2, weekStart: weeks.w3, gross: 300 });
    const unconfirmed = addRun(srv.db, { userId: fx.users.repB, weekStart: weeks.w3, gross: 300 });
    const paid = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w4, gross: 200, status: 'paid', paidDate: addDays(weeks.w4, 9) });
    const notEnded = addRun(srv.db, { userId: fx.users.leader, weekStart: weeks.current, gross: 100 });
    const negative = addRun(srv.db, { userId: fx.users.leader, weekStart: weeks.w4, gross: -20 });
    const r = await admin.post('/payments/batches', { connectionId: conn, runIds: [ok, noBank, unconfirmed, paid, notEnded, negative, 987654] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.status, 'draft');
    assert.equal(r.json.count, 1);
    assert.equal(r.json.totalPence, 34515);
    assert.equal(r.json.items[0].amountPence, 34515);
    assert.equal(r.json.items[0].accountLast4, String(fx.users.rep).padStart(4, '0'));
    const codes = Object.fromEntries(r.json.skipped.map((s: Json) => [s.runId, s.code]));
    assert.deepEqual(codes, {
      [noBank]: 'no_bank_details', [unconfirmed]: 'bank_details_unconfirmed', [paid]: 'already_paid', [notEnded]: 'week_not_ended',
      [negative]: 'not_positive', 987654: 'not_found',
    });
    assert.match(r.json.skipped.find((s: Json) => s.runId === noBank).reason, /No bank details yet: ask Rita to add them in Settings → Bank details/);
    assert.equal(r.json.actions.approve, true);
    // nothing payable at all: 400 with the reasons
    const none = await admin.post('/payments/batches', { connectionId: conn, runIds: [noBank] });
    assert.equal(none.status, 400);
    assert.equal(none.json.details.skipped[0].code, 'no_bank_details');
    // the same run in a second live batch: skipped (and the database refuses it outright)
    const again = await admin.post('/payments/batches', { connectionId: conn, runIds: [ok, noBank] });
    assert.equal(again.status, 400);
    assert.equal(again.json.details.skipped.find((s: Json) => s.runId === ok).code, 'in_payment');
    assert.throws(() => run(srv.db, `INSERT INTO payment_items (batch_id, payroll_run_id, user_id, week_start, amount_pence, payee_name, account_last4, updated_at) VALUES (?, ?, ?, ?, 100, 'x', '0000', 'now')`, [r.json.id, ok, fx.users.rep, weeks.w3]), /UNIQUE/);
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE entity = 'payment_batch'`).some((a) => /draft payment #\d+/i.test(a.summary)));
  });

  test('approve: a fresh two-step code, checked server-side, then paid runs are marked paid once through the usual path', async () => {
    const conn = await fakeConnection({ live: true });
    fake.script({ submitStatus: 'paid' });
    setBank(srv.db, fx.users.rep);
    setBank(srv.db, fx.users.repA2);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 345 });
    const b = addRun(srv.db, { userId: fx.users.repA2, weekStart: weeks.w3, gross: 120.5 });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a, b] })).json;
    // Release 1.4 (S): the admin signed in with two-step on, as everyone must; an admin without it never gets this far
    // (the setup gate), and the demo admin, who is exempt, is asked to set it up first (r4-integration.test.ts)
    adminSecret = enable2fa(srv.db, fx.users.admin);
    assert.equal((await admin.post(`/payments/batches/${draft.id}/approve`, {})).status, 400);
    const wrong = await admin.post(`/payments/batches/${draft.id}/approve`, { code: totp(adminSecret) === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(fake.calls.submit, 0, 'nothing sent on a wrong code');
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE summary LIKE 'Wrong two-step code%'`).length >= 1, 'a wrong code is recorded');
    const ok = await admin.post(`/payments/batches/${draft.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.status, 'completed');
    assert.equal(ok.json.paidCount, 2);
    assert.ok(ok.json.approvedAt);
    for (const id of [a, b]) assert.match(runStatus(srv.db, id).status, /^(paid|late)$/);
    assert.equal(fake.paymentsMade(), 2);
    assert.deepEqual([...fake.payments.values()].map((p) => p.amountPence).sort((x, y) => x - y), [12050, 34500]);
    const runRows = all<{ summary: string; userId: number }>(srv.db, `SELECT summary, user_id AS userId FROM audit_log WHERE entity = 'payroll_run' AND summary LIKE 'Marked paid by payment%'`);
    assert.equal(runRows.length, 2);
    assert.ok(runRows.every((r) => r.userId === fx.users.admin));
    assert.ok(all<{ summary: string }>(srv.db, `SELECT summary FROM audit_log WHERE entity = 'payment_batch'`).some((x) => /Approved payment #\d+/.test(x.summary)));
    // never twice: approving again, a new draft, Mark paid by hand
    assert.equal((await admin.post(`/payments/batches/${draft.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) })).status, 409);
    const redo = await admin.post('/payments/batches', { connectionId: conn, runIds: [a] });
    assert.equal(redo.status, 400);
    assert.equal(redo.json.details.skipped[0].code, 'already_paid');
    assert.equal((await admin.post(`/finance/payroll/${a}/pay`, {})).status, 409);
    assert.equal(fake.paymentsMade(), 2);
    // Runs to pay no longer lists them; the invoice-free 1.2 rules applied
    const toPay = await admin.get('/finance/payroll?status=pending,failed');
    assert.ok(!toPay.json.some((r: Json) => r.id === a || r.id === b));
  });

  test('processing → refresh → paid; a failed item leaves its run unpaid, flagged, with the reason on Runs to pay', async () => {
    const conn = await fakeConnection({ live: true });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    setBank(srv.db, fx.users.repB, { holder: 'Bo Rep' });
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 100 });
    const b = addRun(srv.db, { userId: fx.users.repB, weekStart: weeks.w3, gross: 200 });
    fake.script({ submitStatus: 'processing', failFor: (i) => (i.payeeName === 'Bo Rep' ? 'The account was closed' : null) });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a, b] })).json;
    const sent = await admin.post(`/payments/batches/${draft.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.status, 'processing');
    assert.equal(runStatus(srv.db, a).status, 'pending', 'processing: not paid yet');
    assert.equal(runStatus(srv.db, b).status, 'failed');
    // while it is on its way, Mark paid by hand is held
    const held = await admin.post(`/finance/payroll/${a}/pay`, {});
    assert.equal(held.status, 409);
    assert.match(held.json.error, /is in payment #\d+, which is still on its way/);
    const toPay = (await admin.get('/finance/payroll?status=pending,failed')).json as Json[];
    assert.equal(toPay.find((r) => r.id === a).payment.status, 'processing');
    assert.equal(toPay.find((r) => r.id === b).payment.failureReason, 'The account was closed');
    assert.equal((await rep.get('/finance/payroll')).json.find((r: Json) => r.id === a)?.payment, undefined, 'only the admin sees payment details');
    // refresh: the provider says paid
    const done = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'partly_failed');
    assert.match(runStatus(srv.db, a).status, /^(paid|late)$/);
    assert.equal(runStatus(srv.db, b).status, 'failed');
    srv.resetCache();
    const feed = (await admin.get('/me/attention')).json.items as Json[];
    assert.ok(feed.some((i) => i.kind === 'payments' && /A payment to Bo Rep failed/.test(i.title)), JSON.stringify(feed.map((i) => i.title)));
    // the failed run can go in a new payment (and the failure leaves the feed)
    setBank(srv.db, fx.users.repB, { holder: 'Bo Rep', account: '00009999' });
    fake.script({ failFor: () => null });
    const retry = await admin.post('/payments/batches', { connectionId: conn, runIds: [b] });
    assert.equal(retry.status, 201, JSON.stringify(retry.json));
    srv.resetCache();
    assert.ok(!((await admin.get('/me/attention')).json.items as Json[]).some((i) => /payment.*failed/i.test(i.title)));
  });

  test('a submit that times out leaves items queued; Check now sends them again with the same keys — nobody is paid twice', async () => {
    const conn = await fakeConnection({ live: true });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 50 });
    fake.script({ throwSubmit: 2, submitStatus: 'paid' });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a] })).json;
    const first = await admin.post(`/payments/batches/${draft.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'submitted');
    assert.equal(first.json.items[0].status, 'queued');
    assert.match(first.json.lastError, /did not answer within 15 seconds/);
    assert.ok(!JSON.stringify(first.json).includes('tok-SECRET'));
    assert.equal(runStatus(srv.db, a).status, 'pending');
    await admin.post(`/payments/batches/${draft.id}/refresh`);
    const third = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(third.json.status, 'completed', JSON.stringify(third.json));
    assert.equal(fake.calls.submit, 3);
    assert.equal(fake.paymentsMade(), 1, 'one payment, sent three times with one idempotency key');
    assert.equal([...fake.payments.values()][0]!.sent, 3);
    assert.match(runStatus(srv.db, a).status, /^(paid|late)$/);
    assert.equal(all(srv.db, `SELECT 1 FROM audit_log WHERE entity = 'payroll_run' AND summary LIKE 'Marked paid by payment%'`).length, 1);
  });

  test('two approvals at once: one wins, one submit', async () => {
    const conn = await fakeConnection({ live: true });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 70 });
    fake.script({ submitStatus: 'paid' });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a] })).json;
    const code = freshCode(srv.db, fx.users.admin, adminSecret);
    const [x, y] = await Promise.all([admin.post(`/payments/batches/${draft.id}/approve`, { code }), admin.post(`/payments/batches/${draft.id}/approve`, { code })]);
    assert.equal([x.status, y.status].filter((s) => s === 200).length, 1, `${x.status} ${y.status}`);
    assert.equal(fake.calls.submit, 1);
    assert.equal(fake.paymentsMade(), 1);
  });

  test('approval checks again before the code is used: pay or bank details changed since the draft', async () => {
    const conn = await fakeConnection({ live: true });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 100 });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a] })).json;
    run(srv.db, `UPDATE payroll_runs SET gross = 101 WHERE id = ?`, [a]);
    const code = freshCode(srv.db, fx.users.admin, adminSecret);
    const changed = await admin.post(`/payments/batches/${draft.id}/approve`, { code });
    assert.equal(changed.status, 409);
    assert.match(changed.json.error, /pay for w\/c .* changed: now £101\.00, was £100\.00/);
    run(srv.db, `UPDATE payroll_runs SET gross = 100 WHERE id = ?`, [a]);
    run(srv.db, `UPDATE bank_accounts SET changed_at = ?, confirmed_by_admin_at = ? WHERE user_id = ?`, [new Date(businessNow().getTime() + 60_000).toISOString(), new Date(businessNow().getTime() + 60_000).toISOString(), fx.users.rep]);
    const bank = await admin.post(`/payments/batches/${draft.id}/approve`, { code });
    assert.equal(bank.status, 409);
    assert.match(bank.json.error, /bank details changed after this payment was made/);
    assert.equal(fake.calls.submit, 0);
    // the code was not used up by either refusal
    run(srv.db, `UPDATE bank_accounts SET changed_at = ?, confirmed_by_admin_at = ? WHERE user_id = ?`, ['2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', fx.users.rep]);
    assert.equal((await admin.post(`/payments/batches/${draft.id}/approve`, { code })).status, 200);
  });

  test('test mode pays nobody: no run is marked paid, and the run can still go in a live payment', async () => {
    const testConn = await fakeConnection({ live: false });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 80 });
    fake.script({ submitStatus: 'paid' });
    const draft = (await admin.post('/payments/batches', { connectionId: testConn, runIds: [a] })).json;
    assert.equal(draft.mode, 'test');
    const done = await admin.post(`/payments/batches/${draft.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    assert.equal(done.json.status, 'completed');
    assert.match(done.json.items[0].note, /Test mode: nobody was paid/);
    assert.equal(runStatus(srv.db, a).status, 'pending');
    const live = await admin.post('/payments/connections', { provider: 'fake', name: 'Live fake' });
    await admin.post(`/payments/connections/${live.json.id}/test`);
    await admin.patch(`/payments/connections/${live.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    await admin.post(`/payments/connections/${live.json.id}/test`);
    assert.equal((await admin.post('/payments/batches', { connectionId: live.json.id, runIds: [a] })).status, 201);
  });

  test('a bank file: approve makes the file (admin download, recorded); Mark as paid pays the ticked and fails the rest', async () => {
    const conn = await fakeConnection({ kind: 'file' });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep, { holder: 'Remy Rep' });
    setBank(srv.db, fx.users.repA2, { holder: 'Rita Rep' });
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 10 });
    const b = addRun(srv.db, { userId: fx.users.repA2, weekStart: weeks.w3, gross: 20 });
    const draft = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a, b] })).json;
    assert.equal(draft.kind, 'file');
    assert.equal((await admin.get(`/payments/batches/${draft.id}/file`)).status, 404, 'no file before approval');
    const sent = await admin.post(`/payments/batches/${draft.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    assert.equal(sent.json.status, 'submitted');
    assert.equal(sent.json.actions.download, true);
    assert.equal(sent.json.actions.markPaid, true);
    assert.equal(sent.json.actions.refresh, false);
    const file = await admin.get(`/payments/batches/${draft.id}/file`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename="linear-hub-test-payment-/);
    assert.equal(file.headers.get('cache-control'), 'no-store');
    assert.match(String(file.json), new RegExp(`0000${String(fx.users.rep).padStart(4, '0')}`), 'the file holds the account numbers');
    assert.ok(all<{ kind: string }>(srv.db, `SELECT kind FROM audit_log WHERE action = 'GET /payments/batches/:id/file'`).some((r) => r.kind === 'export'));
    const stored = get<{ f: string }>(srv.db, `SELECT file_enc AS f FROM payment_batches WHERE id = ?`, [draft.id])!.f;
    assert.ok(!stored.includes('Remy'), 'stored encrypted');
    assert.equal((await admin.post(`/payments/batches/${draft.id}/refresh`)).status, 409);
    const itemA = sent.json.items.find((i: Json) => i.payrollRunId === a).id;
    const itemB = sent.json.items.find((i: Json) => i.payrollRunId === b).id;
    assert.equal((await admin.post(`/payments/batches/${draft.id}/mark-paid`, { paid: [itemA], failed: [itemA] })).status, 400);
    assert.equal((await admin.post(`/payments/batches/${draft.id}/mark-paid`, { paid: [itemA], paidDate: addDays(fx.today, 1) })).status, 400, 'not in the future');
    const marked = await admin.post(`/payments/batches/${draft.id}/mark-paid`, { paid: [itemA], failed: [itemB], reason: 'Rejected by the bank: name does not match' });
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.status, 'partly_failed');
    assert.match(runStatus(srv.db, a).status, /^(paid|late)$/);
    assert.equal(runStatus(srv.db, b).status, 'failed');
    assert.equal(marked.json.items.find((i: Json) => i.id === itemB).failureReason, 'Rejected by the bank: name does not match');
    assert.equal((await admin.post(`/payments/batches/${draft.id}/mark-paid`, {})).status, 409, 'nothing left waiting');
  });

  test('cancel: a draft, or a bank file not yet marked; an API payment on its way cannot be stopped here', async () => {
    const fileConn = await fakeConnection({ kind: 'file' });
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 10 });
    const d1 = (await admin.post('/payments/batches', { connectionId: fileConn, runIds: [a] })).json;
    const c1 = await admin.post(`/payments/batches/${d1.id}/cancel`);
    assert.equal(c1.json.status, 'cancelled');
    const d2 = (await admin.post('/payments/batches', { connectionId: fileConn, runIds: [a] })).json;
    await admin.post(`/payments/batches/${d2.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    const c2 = await admin.post(`/payments/batches/${d2.id}/cancel`);
    assert.equal(c2.json.status, 'cancelled');
    assert.equal(runStatus(srv.db, a).status, 'pending');
    assert.equal((await admin.get(`/payments/batches/${d2.id}/file`)).status, 404);
    unregisterPaymentProvider('fake');
    const apiConn = await fakeConnection({ live: true });
    fake.script({ submitStatus: 'processing' });
    const d3 = (await admin.post('/payments/batches', { connectionId: apiConn, runIds: [a] })).json;
    await admin.post(`/payments/batches/${d3.id}/approve`, { code: freshCode(srv.db, fx.users.admin, adminSecret) });
    const c3 = await admin.post(`/payments/batches/${d3.id}/cancel`);
    assert.equal(c3.status, 409);
    assert.match(c3.json.error, /cannot be stopped from Linear Hub/);
    assert.equal((await admin.del(`/payments/connections/${apiConn}`)).status, 409, 'not while a payment through it is on its way');
  });

  test('a provider not built yet: the draft is made, approval answers 501 before the code is used', async () => {
    adminSecret = enable2fa(srv.db, fx.users.admin);
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 10 });
    // Release 1.4: P built the bank file and A built Wise, so Wise's stub stands in for "a way to pay this version
    // cannot use yet", marked connected by hand (its own test answers 501) to reach the approval
    registerPaymentProvider(stubProvider('wise'));
    try {
      const conn = (await admin.post('/payments/connections', { provider: 'wise', secrets: { apiToken: 'wise-token-123456' } })).json.id;
      run(srv.db, `UPDATE payment_connections SET status = 'connected' WHERE id = ?`, [conn]);
      const draft = await admin.post('/payments/batches', { connectionId: conn, runIds: [a] });
      assert.equal(draft.status, 201);
      assert.equal(draft.json.actions.approve, false);
      const code = freshCode(srv.db, fx.users.admin, adminSecret);
      const r = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code });
      assert.equal(r.status, 501);
      assert.match(r.json.error, /Paying through Wise Business is not switched on in this version of Linear Hub yet/);
      assert.equal((await admin.get(`/payments/batches/${draft.json.id}`)).json.status, 'draft');
      // the code still works (it was not used)
      assert.equal((await admin.put('/me/bank-details', { holderName: 'Ada Admin', sortCode: '000000', accountNumber: '00000001', code })).status, 200);
    } finally {
      unregisterPaymentProvider('wise');
    }
  });

  test('GET /payments/batches lists newest first with counts; GET one shows items and skipped', async () => {
    const conn = await fakeConnection({ live: true });
    setBank(srv.db, fx.users.rep);
    const a = addRun(srv.db, { userId: fx.users.rep, weekStart: weeks.w3, gross: 10 });
    const b = addRun(srv.db, { userId: fx.users.repA2, weekStart: weeks.w3, gross: 10 });
    const d = (await admin.post('/payments/batches', { connectionId: conn, runIds: [a, b] })).json;
    const list = await admin.get('/payments/batches');
    assert.equal(list.json[0].id, d.id);
    assert.equal(list.json[0].waitingCount, 1);
    const one = await admin.get(`/payments/batches/${d.id}`);
    assert.equal(one.json.skipped.length, 1);
    assert.equal(one.json.items.length, 1);
    assert.equal((await admin.get('/payments/batches/987654')).status, 404);
  });
});

// ───────────────────────────── the demo and the small helpers ─────────────────────────────

describe('the demo seed', () => {
  before(async () => {
    srv = await startTestServer({ seed: true });
  });
  after(() => srv.close());

  test('obviously fake bank details for the field people; one change waits for the admin; the admin has no two-step yet', async () => {
    const admin_ = await srv.login('admin');
    const rep_ = await srv.login('rep');
    const mine = await rep_.get('/me/bank-details');
    assert.equal(mine.status, 200);
    assert.equal(mine.json.details.sortCodeMasked, '••-••-00');
    assert.equal(mine.json.details.needsConfirmation, false, 'Jordan’s are confirmed');
    const rows = all<{ s: string }>(srv.db, `SELECT sort_code_last2 AS s FROM bank_accounts`);
    assert.ok(rows.length > 10);
    assert.ok(rows.every((r) => r.s === '00'));
    assert.equal(all(srv.db, `SELECT 1 FROM bank_accounts WHERE confirmed_by_admin_at IS NULL OR confirmed_by_admin_at < changed_at`).length, 1);
    const feed = await admin_.get('/me/attention');
    assert.ok(feed.json.items.some((i: Json) => i.kind === 'payments' && /changed their bank details/.test(i.title)));
    assert.equal(all(srv.db, `SELECT 1 FROM payment_connections`).length, 0, 'Matt sets up connections himself');
    const providers = await admin_.get('/payments/providers');
    assert.equal(providers.json.length, 4);
  });
});

test('providerFetch: a timeout in plain words, secrets redacted, no retry of a POST without an idempotency key', async () => {
  let calls = 0;
  const failing: typeof fetch = async () => {
    calls++;
    throw new Error('connect ECONNREFUSED with token sk_live_ABCDEFGHIJ');
  };
  await assert.rejects(providerFetch('http://127.0.0.1:1/pay', { method: 'POST' }, { provider: 'Revolut', secrets: ['sk_live_ABCDEFGHIJ'], fetchImpl: failing }), (e: Error) => {
    assert.match(e.message, /could not reach Revolut/i);
    assert.ok(!e.message.includes('sk_live_ABCDEFGHIJ'));
    return true;
  });
  assert.equal(calls, 1, 'a POST that moves money is never retried');
  calls = 0;
  await assert.rejects(providerFetch('http://127.0.0.1:1/pay', { method: 'POST' }, { provider: 'Revolut', idempotencyKey: 'k1', fetchImpl: failing }));
  assert.equal(calls, 3, 'with an idempotency key it is safe to try again');
  calls = 0;
  const slow: typeof fetch = (_u, init) => new Promise((_resolve, reject) => {
    calls++;
    const keepAlive = setTimeout(() => {}, 5_000); // AbortSignal.timeout's timer does not hold the event loop
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
  });
  await assert.rejects(providerFetch('http://127.0.0.1:1/x', { method: 'POST' }, { provider: 'Wise', timeoutMs: 30, fetchImpl: slow }), /Wise did not answer within 0 seconds|Wise did not answer within/);
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123 and key s3cr3tkey', ['s3cr3tkey']), 'Authorization: Bearer [redacted] and key [redacted]');
});

test('validateConfigFields: required, lengths, select options, kept secrets', () => {
  const fields = [
    { name: 'a', label: 'A', required: true },
    { name: 's', label: 'S', secret: true, required: true },
    { name: 'f', label: 'F', type: 'select' as const, options: [{ value: 'x', label: 'X' }] },
  ];
  assert.throws(() => validateConfigFields(fields, { settings: {}, secrets: {} }), /A is needed/);
  assert.deepEqual(validateConfigFields(fields, { settings: { a: ' 1 ', junk: 'y' }, secrets: { s: 'k' } }), { settings: { a: '1' }, secrets: { s: 'k' } });
  assert.deepEqual(validateConfigFields(fields, { settings: { a: '1' }, secrets: { s: '' } }, { settings: {}, secrets: { s: 'old' } }), { settings: { a: '1' }, secrets: { s: 'old' } });
  assert.throws(() => validateConfigFields(fields, { settings: { a: '1', f: 'z' }, secrets: { s: 'k' } }), /choose one of the options/);
  assert.throws(() => validateConfigFields(fields, { settings: { a: 'x'.repeat(201) }, secrets: { s: 'k' } }), /too long/);
});
