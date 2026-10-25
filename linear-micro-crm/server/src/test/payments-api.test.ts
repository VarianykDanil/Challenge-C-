/**
 * Release 1.4 — package A (API providers): the Revolut Business, Wise Business and TrueLayer payout adapters against
 * local fake servers that follow each provider's documented shapes (./paymentApiFakes.ts). No test calls the real
 * internet: every adapter here points at 127.0.0.1, and an adapter left on a real host refuses to call it under
 * `node --test`.
 *
 * Per provider: the connection form's checks, the connection test (sign-in, balance), paying (the documented request
 * shapes, amounts exact, the idempotency key), a resubmit never paying twice (also after a timeout and a 5xx), partial
 * failure, statuses on refresh, token refresh (Revolut), request signing (TrueLayer), cancel (Wise), and no secret or
 * full account number in any message. Then the whole flow through Linear Hub's routes for each of the three: connect,
 * test, switch to live, approve with a fresh two-step code, check, paid once.
 */
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { PAYMENT_LIVE_CONFIRMATION, paydayForWeek } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { encrypt } from '../lib/crypto.ts';
import { addDays, businessNow, mondayOf, setBusinessClock } from '../lib/dates.ts';
import { paymentUuid } from '../lib/payments/apiCommon.ts';
import type { PaymentProviderAdapter, ProviderBatch, ProviderConnection, ProviderContext, ProviderItem } from '../lib/payments/provider.ts';
import { ProviderConfigError } from '../lib/payments/provider.ts';
import { registerPaymentProvider, unregisterPaymentProvider } from '../lib/payments/registry.ts';
import { createRevolutProvider, REVOLUT_LIVE_URL, REVOLUT_SANDBOX_URL } from '../lib/payments/revolut.ts';
import { createTrueLayerProvider, TRUELAYER_REPEAT_HOURS, TRUELAYER_URLS } from '../lib/payments/truelayer.ts';
import { createWiseProvider, WISE_LIVE_URL, WISE_SANDBOX_URL } from '../lib/payments/wise.ts';
import { startRevolutFake, startTrueLayerFake, startWiseFake, type RevolutFake, type TrueLayerFake, type WiseFake } from './paymentApiFakes.ts';
import { currentCode, startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

// ───────────────────────────── helpers ─────────────────────────────

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ec = generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
const EC_PEM = ec.privateKey.export({ type: 'sec1', format: 'pem' }).toString();
const ec256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const EC256_PEM = ec256.privateKey.export({ type: 'sec1', format: 'pem' }).toString();

/** Obviously fake UK bank details (the repository is public). */
function item(id: number, over: Partial<ProviderItem> = {}): ProviderItem {
  return {
    id, payrollRunId: 100 + id, userId: 10 + id, amountPence: 6350, currency: 'GBP', payeeName: 'Jordan Lee', sortCode: '000000',
    accountNumber: `0000000${id}`.slice(-8), reference: 'LINEAR 05OCT JL', weekStart: '2026-10-05', idempotencyKey: `batch-key-1:${id}`, providerRef: null, ...over,
  };
}

const batch = (over: Partial<ProviderBatch> = {}): ProviderBatch => ({ id: 1, mode: 'test', idempotencyKey: 'batch-key-1', createdAt: new Date().toISOString(), today: '2026-10-23', approvedAt: new Date().toISOString(), ...over });

/** What Linear Hub keeps for one connection: settings, secrets (saveSecrets merges into them, as connections.ts does). */
class StoredConnection {
  settings: Record<string, string>;
  secrets: Record<string, string>;
  mode: 'test' | 'live';
  saves = 0;
  constructor(settings: Record<string, string>, secrets: Record<string, string>, mode: 'test' | 'live' = 'test') {
    this.settings = { ...settings };
    this.secrets = { ...secrets };
    this.mode = mode;
  }
  conn(provider: string): ProviderConnection {
    return { id: 7, provider, name: provider, mode: this.mode, settings: { ...this.settings }, secrets: { ...this.secrets } };
  }
  ctx(baseUrl: string): ProviderContext {
    return {
      today: '2026-10-23',
      now: () => new Date(),
      baseUrl,
      saveSecrets: (patch) => {
        this.saves++;
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') delete this.secrets[k];
          else this.secrets[k] = v;
        }
      },
    };
  }
}

/** Every string an error or message could carry, joined, to look for secrets in. */
function noSecretsIn(text: string, secrets: readonly string[]): void {
  for (const s of secrets) assert.ok(!text.includes(s), `a secret leaked: ${s.slice(0, 12)}…`);
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), 'a private key leaked');
}

async function throwsProvider(p: Promise<unknown>, re: RegExp): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.equal((err as Error).name, 'ProviderError', String(err));
    assert.match((err as Error).message, re);
    return (err as Error).message;
  }
  assert.fail('expected a ProviderError');
}

function configError(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ProviderConfigError, String(err));
    return err.fields;
  }
  assert.fail('expected a ProviderConfigError');
}

test('payment idempotency ids: a UUID (version 5) per item key, the same every time, at most 40 characters', () => {
  const a = paymentUuid('batch-key-1:1');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(paymentUuid('batch-key-1:1'), a);
  assert.notEqual(paymentUuid('batch-key-1:2'), a);
  assert.ok(a.length <= 40, 'Revolut request_id is at most 40 characters');
});

test('the documented base URLs: sandbox in test mode, production only when live', () => {
  assert.equal(REVOLUT_SANDBOX_URL, 'https://sandbox-b2b.revolut.com/api/1.0');
  assert.equal(REVOLUT_LIVE_URL, 'https://b2b.revolut.com/api/1.0');
  assert.equal(WISE_SANDBOX_URL, 'https://api.wise-sandbox.com');
  assert.equal(WISE_LIVE_URL, 'https://api.wise.com');
  assert.deepEqual(TRUELAYER_URLS.test, { auth: 'https://auth.truelayer-sandbox.com', api: 'https://api.truelayer-sandbox.com' });
  assert.deepEqual(TRUELAYER_URLS.live, { auth: 'https://auth.truelayer.com', api: 'https://api.truelayer.com' });
});

test('under node --test an adapter never calls a real provider (it answers plainly instead)', async () => {
  const wise = createWiseProvider();
  const conn = new StoredConnection({}, { apiToken: 'wise-token-never-sent' });
  const out = await wise.testConnection(conn.conn('wise'), { today: '2026-10-23', now: () => new Date() });
  assert.equal(out.ok, false);
  assert.match(out.message, /tests never call/i);
});

// ───────────────────────────── Revolut Business ─────────────────────────────

describe('Revolut Business adapter (sandbox fake)', () => {
  let fake: RevolutFake;
  let revolut: PaymentProviderAdapter;
  let stored: StoredConnection;
  beforeEach(async () => {
    fake = await startRevolutFake({ publicKey: rsa.publicKey });
    revolut = createRevolutProvider({ timeoutMs: 400 });
    stored = new StoredConnection({ clientId: fake.clientId, redirectUri: `https://${fake.redirectDomain}/linear-hub` }, { privateKey: RSA_PEM, authCode: fake.issueCode() });
  });
  afterEach(() => fake.close());

  test('the form: client ID, redirect address, an RSA private key, and the code from Revolut (the whole address is fine)', () => {
    assert.equal(revolut.info.id, 'revolut');
    assert.equal(revolut.ready, true);
    assert.deepEqual(revolut.configFields.map((f) => f.name), ['clientId', 'redirectUri', 'privateKey', 'authCode', 'accountId']);
    for (const f of revolut.configFields) assert.ok(f.help && f.help.length > 20, `${f.name} has plain help`);
    // the code is needed until Linear Hub holds Revolut's sign-in: the form marks it required until then
    assert.equal(revolut.configFields.find((f) => f.name === 'authCode')?.requiredUnless, 'refreshToken');
    const ok = revolut.validateConfig({ settings: { clientId: ' abc ', redirectUri: 'https://example.com/back' }, secrets: { privateKey: RSA_PEM, authCode: 'https://example.com/back?code=oa_sand_123&state=x' } });
    assert.equal(ok.settings.clientId, 'abc');
    assert.equal(ok.secrets.authCode, 'oa_sand_123', 'the code is taken out of the address');
    const noKey = configError(() => revolut.validateConfig({ settings: { clientId: 'abc', redirectUri: 'https://example.com' }, secrets: { privateKey: EC_PEM, authCode: 'x' } }));
    assert.ok(noKey.some((e) => e.path === 'privateKey' && /RSA private key/.test(e.message)));
    const badUri = configError(() => revolut.validateConfig({ settings: { clientId: 'abc', redirectUri: 'example' }, secrets: { privateKey: RSA_PEM, authCode: 'x' } }));
    assert.ok(badUri.some((e) => e.path === 'redirectUri'));
    const noCode = configError(() => revolut.validateConfig({ settings: { clientId: 'abc', redirectUri: 'https://example.com' }, secrets: { privateKey: RSA_PEM } }));
    assert.ok(noCode.some((e) => e.path === 'authCode' && /Enable access/.test(e.message)));
  });

  test('an edit keeps the stored sign-in (refresh token) unless the key, client ID or code changes', () => {
    const existing = { settings: { clientId: 'abc', redirectUri: 'https://example.com', accountId: '' }, secrets: { privateKey: RSA_PEM, refreshToken: 'oa_sand_refresh_1' } };
    const renamed = revolut.validateConfig({ settings: { clientId: 'abc', redirectUri: 'https://example.com', accountId: 'acc-1' }, secrets: {} }, existing);
    assert.equal(renamed.secrets.refreshToken, 'oa_sand_refresh_1');
    assert.equal(renamed.secrets.privateKey, RSA_PEM);
    const newClient = configError(() => revolut.validateConfig({ settings: { clientId: 'other', redirectUri: 'https://example.com' }, secrets: {} }, existing));
    assert.ok(newClient.some((e) => e.path === 'authCode'), 'a new client ID needs a new code');
    const newCode = revolut.validateConfig({ settings: { clientId: 'abc', redirectUri: 'https://example.com' }, secrets: { authCode: 'oa_sand_new' } }, existing);
    assert.equal(newCode.secrets.refreshToken, undefined);
    assert.equal(newCode.secrets.authCode, 'oa_sand_new');
  });

  test('first test: swaps the code for tokens (signed client assertion), keeps the refresh token encrypted, shows the GBP balance', async () => {
    const out = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(out.ok, true, out.message);
    assert.match(out.message, /Revolut Business sandbox/);
    assert.equal(out.balancePence, 317189, '£3,171.89 exactly');
    assert.ok(stored.secrets.refreshToken?.startsWith('oa_sand_refresh_'), 'the refresh token is stored');
    assert.equal(stored.secrets.authCode, undefined, 'a code works once: it is removed');
    assert.deepEqual(fake.tokenGrants, ['authorization_code']);
    // the next test (a new Linear Hub process: no token in memory) uses the refresh token
    const again = await createRevolutProvider().testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(again.ok, true);
    assert.deepEqual(fake.tokenGrants, ['authorization_code', 'refresh_token']);
    noSecretsIn(JSON.stringify([out, again]), [RSA_PEM, stored.secrets.refreshToken!]);
  });

  test('an expired code, a wrong client ID or a refresh token Revolut no longer accepts: plain words, no secrets', async () => {
    stored.secrets.authCode = 'oa_sand_expired';
    const expired = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(expired.ok, false);
    assert.match(expired.message, /code from Revolut has expired or was already used/);
    assert.match(expired.message, /2 minutes/);
    stored.secrets.authCode = fake.issueCode();
    stored.settings.clientId = 'someone-else';
    const wrong = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /Revolut did not accept the client ID, private key or redirect address/);
    delete stored.secrets.authCode;
    stored.settings.clientId = fake.clientId;
    stored.secrets.refreshToken = 'oa_sand_refresh_revoked';
    const revoked = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(revoked.ok, false);
    assert.match(revoked.message, /Enable access/);
    noSecretsIn(JSON.stringify([expired, wrong, revoked]), [RSA_PEM, 'oa_sand_refresh_revoked']);
  });

  test('several GBP accounts: the test asks which; a chosen account is used and must be GBP', async () => {
    fake.accounts.push({ id: 'd2d2d2d2-2222-4b4b-8c8c-1f1f1f1f1f1f', name: 'Payroll', balance: 100, currency: 'GBP', state: 'active' });
    const out = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(out.ok, false);
    assert.match(out.message, /more than one GBP account/);
    assert.match(out.message, /Payroll/);
    stored.settings.accountId = 'd2d2d2d2-2222-4b4b-8c8c-1f1f1f1f1f1f';
    const chosen = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(chosen.ok, true, chosen.message);
    assert.equal(chosen.balancePence, 10000);
    stored.settings.accountId = 'c1d5c0a2-1111-4a4a-9a9a-0e0e0e0e0e0e';
    const euro = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(euro.ok, false);
    assert.match(euro.message, /not a GBP account/);
  });

  test('pays: one counterparty per person (reused), /pay with a request_id per item, the amount in pounds exactly', async () => {
    await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    const items = [item(1, { amountPence: 6350 }), item(2, { amountPence: 123456, payeeName: 'Mary Ann O’Neill' })];
    const out = await revolut.submit(stored.conn('revolut'), batch(), items, stored.ctx(fake.url));
    assert.deepEqual(out.items.map((r) => r.status), ['processing', 'processing']);
    assert.equal(fake.txns.size, 2);
    const t1 = [...fake.txns.values()].find((t) => t.request_id === paymentUuid('batch-key-1:1'))!;
    assert.equal(t1.amount, 63.5);
    assert.equal(t1.reference, 'LINEAR 05OCT JL');
    assert.equal(t1.account_id, fake.accounts[0].id, 'from the only GBP account');
    assert.equal(out.items[0].providerRef, t1.id);
    assert.equal([...fake.txns.values()].find((t) => t.request_id === paymentUuid('batch-key-1:2'))!.amount, 1234.56);
    assert.equal(fake.counterparties.length, 2);
    const mary = fake.counterparties.find((c) => c.accountNo === '00000002')!;
    assert.equal(mary.name, 'Mary Ann O’Neill', 'first names, then the last name');
    // the same person paid again next week: the counterparty is reused
    await revolut.submit(stored.conn('revolut'), batch({ id: 2, idempotencyKey: 'batch-key-2' }), [item(1, { idempotencyKey: 'batch-key-2:1' })], stored.ctx(fake.url));
    assert.equal(fake.counterparties.length, 2);
    assert.equal(fake.txns.size, 3);
  });

  test('a resubmit never pays twice: Revolut refuses a repeated request_id and Linear Hub finds the first payment', async () => {
    const items = [item(1), item(2)];
    const first = await revolut.submit(stored.conn('revolut'), batch(), items, stored.ctx(fake.url));
    const again = await revolut.submit(stored.conn('revolut'), batch(), items, stored.ctx(fake.url));
    assert.equal(fake.txns.size, 2, 'still two payments');
    assert.deepEqual(again.items.map((r) => r.providerRef), first.items.map((r) => r.providerRef));
    assert.deepEqual(again.items.map((r) => r.status), ['processing', 'processing']);
  });

  test('a timeout after Revolut made the payment: that item stays queued with a plain error, the resend finds it (one payment)', async () => {
    fake.script({ paySlow: 3 }); // the first try and both retries: Revolut is unreachable for a while
    const out = await revolut.submit(stored.conn('revolut'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.equal(fake.txns.size, 1, 'Revolut made the first payment although Linear Hub did not hear back');
    assert.deepEqual(out.items.map((r) => r.itemId), [], 'nothing is known for sure: both stay queued');
    assert.match(out.error ?? '', /Revolut did not answer within/);
    const again = await revolut.submit(stored.conn('revolut'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.deepEqual(again.items.map((r) => r.status), ['processing', 'processing']);
    assert.equal(fake.txns.size, 2, 'one payment each');
    assert.equal(again.error ?? null, null);
  });

  test('a 5xx on /pay is tried again with the same request_id (one payment)', async () => {
    fake.script({ payFail: 1, payThenFail: true });
    const out = await revolut.submit(stored.conn('revolut'), batch(), [item(1)], stored.ctx(fake.url));
    assert.equal(out.items[0].status, 'processing');
    assert.equal(fake.txns.size, 1);
  });

  test('partial failure: one person’s account refused (plain reason), the other paid; a completed transfer is paid at once', async () => {
    fake.script({ refuseAccounts: ['00000002'], payState: 'completed' });
    const out = await revolut.submit(stored.conn('revolut'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    const [one, two] = out.items;
    assert.equal(one.status, 'paid');
    assert.equal(two.status, 'failed');
    assert.match(two.failureReason ?? '', /Revolut would not add this account/);
    assert.ok(!(two.failureReason ?? '').includes('00000002'), 'no full account number in a reason');
  });

  test('refresh: completed → paid, declined/failed/reverted → failed with a plain reason, pending → processing; found by request_id when the id is missing', async () => {
    const sent = await revolut.submit(stored.conn('revolut'), batch(), [item(1), item(2), item(3), item(4)], stored.ctx(fake.url));
    const ids = sent.items.map((r) => r.providerRef!);
    fake.setState(ids[0], 'completed');
    fake.setState(ids[1], 'declined', 'insufficient_balance');
    fake.setState(ids[2], 'reverted');
    const items = [1, 2, 3, 4].map((n, i) => item(n, { providerRef: n === 4 ? null : ids[i] }));
    const out = await revolut.refresh(stored.conn('revolut'), items, stored.ctx(fake.url));
    const by = new Map(out.map((r) => [r.itemId, r]));
    assert.equal(by.get(1)!.status, 'paid');
    assert.equal(by.get(2)!.status, 'failed');
    assert.match(by.get(2)!.failureReason ?? '', /Revolut declined it \(insufficient balance\)/);
    assert.equal(by.get(3)!.status, 'failed');
    assert.match(by.get(3)!.failureReason ?? '', /sent back/);
    assert.equal(by.get(4)!.status, 'processing');
    assert.equal(by.get(4)!.providerRef, ids[3], 'found by its request_id');
  });

  test('token refresh: a token close to expiry is refreshed first; a 401 refreshes once and tries again', async () => {
    fake.script({ tokenTtl: 30 });
    await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    await revolut.refresh(stored.conn('revolut'), [], stored.ctx(fake.url));
    await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.deepEqual(fake.tokenGrants, ['authorization_code', 'refresh_token'], 'a 30-second token is refreshed before use');
    fake.script({ tokenTtl: 2399 });
    await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(fake.tokenGrants.length, 3);
    await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(fake.tokenGrants.length, 3, 'a 40-minute token is reused');
    fake.script({ unauthorizedNext: 1 });
    const out = await revolut.testConnection(stored.conn('revolut'), stored.ctx(fake.url));
    assert.equal(out.ok, true, out.message);
    assert.equal(fake.tokenGrants.length, 4, 'refreshed once after the 401');
  });

  test('a payment made more than 13 days ago is never sent again blind (Revolut only spots repeats for 2 weeks)', async () => {
    const old = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const out = await revolut.submit(stored.conn('revolut'), batch({ createdAt: old, approvedAt: old }), [item(1)], stored.ctx(fake.url));
    assert.equal(fake.requests.filter((r) => r.path === '/pay').length, 0);
    assert.equal(out.items[0].status, 'failed');
    assert.match(out.items[0].failureReason ?? '', /more than 13 days ago/);
  });

  test('no secret, token or full account number in any request log line Linear Hub could show', async () => {
    fake.script({ refuseAccounts: ['00000001'] });
    const out = await revolut.submit(stored.conn('revolut'), batch(), [item(1)], stored.ctx(fake.url));
    noSecretsIn(JSON.stringify(out), [RSA_PEM, stored.secrets.refreshToken ?? 'none', '00000001']);
  });
});

// ───────────────────────────── Wise Business ─────────────────────────────

describe('Wise Business adapter (sandbox fake)', () => {
  let fake: WiseFake;
  let wise: PaymentProviderAdapter;
  let stored: StoredConnection;
  beforeEach(async () => {
    fake = await startWiseFake();
    wise = createWiseProvider({ timeoutMs: 400 });
    stored = new StoredConnection({}, { apiToken: fake.token });
  });
  afterEach(() => fake.close());

  test('abilities say plainly that you pay (fund) the transfers in Wise; the form has the token and the profile', () => {
    assert.equal(wise.ready, true);
    assert.equal(wise.info.abilities.paysFromApp, false);
    assert.equal(wise.info.abilities.needsBankApproval, true);
    assert.equal(wise.info.abilities.confirmsAutomatically, true);
    assert.match(wise.info.abilities.limits, /does not let an API token pay/);
    assert.deepEqual(wise.configFields.map((f) => f.name), ['apiToken', 'profileId']);
    const bad = configError(() => wise.validateConfig({ settings: { profileId: 'abc' }, secrets: { apiToken: 'x'.repeat(30) } }));
    assert.ok(bad.some((e) => e.path === 'profileId'));
  });

  test('test: finds the business profile; a wrong token is a plain answer', async () => {
    const out = await wise.testConnection(stored.conn('wise'), stored.ctx(fake.url));
    assert.equal(out.ok, true, out.message);
    assert.match(out.message, /Wise sandbox/);
    assert.match(out.message, /Test Business Ltd/);
    assert.equal(out.balancePence ?? null, null, 'Wise balances are not read with a personal token');
    stored.secrets.apiToken = 'wrong-token-1234';
    const wrong = await wise.testConnection(stored.conn('wise'), stored.ctx(fake.url));
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /Wise did not accept the API token/);
    noSecretsIn(wrong.message, ['wrong-token-1234']);
    stored.secrets.apiToken = fake.token;
    stored.settings.profileId = '999';
    const other = await wise.testConnection(stored.conn('wise'), stored.ctx(fake.url));
    assert.equal(other.ok, false);
    assert.match(other.message, /profile 999/);
  });

  test('creates recipient → quote → transfer (customerTransactionId per item); never funds it', async () => {
    const out = await wise.submit(stored.conn('wise'), batch(), [item(1, { amountPence: 6350 })], stored.ctx(fake.url));
    assert.equal(out.items[0].status, 'processing');
    const [t] = [...fake.transfers.values()];
    assert.equal(t.customerTransactionId, paymentUuid('batch-key-1:1'));
    assert.equal(t.targetValue, 63.5);
    assert.equal(t.reference, 'LINEAR 05OCT JL');
    assert.equal(out.items[0].providerRef, String(t.id));
    const r = fake.recipients.get(t.targetAccount)!;
    assert.deepEqual(r, { accountHolderName: 'Jordan Lee', sortCode: '000000', accountNumber: '00000001' });
    assert.equal(fake.fundAttempts, 0, 'Linear Hub never tries to fund a transfer');
  });

  test('a resubmit (also after a timeout) returns the same transfer: one per item', async () => {
    fake.script({ transferSlow: 3 });
    const first = await wise.submit(stored.conn('wise'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.equal(first.items.length, 0);
    assert.match(first.error ?? '', /Wise did not answer within/);
    assert.equal(fake.transfers.size, 1);
    const again = await wise.submit(stored.conn('wise'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.deepEqual(again.items.map((r) => r.status), ['processing', 'processing']);
    assert.equal(fake.transfers.size, 2);
    const third = await wise.submit(stored.conn('wise'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.deepEqual(third.items.map((r) => r.providerRef), again.items.map((r) => r.providerRef));
    assert.equal(fake.transfers.size, 2);
  });

  test('partial failure: a refused account fails with Wise’s words; payment approvals switched on fail plainly', async () => {
    fake.script({ refuseAccounts: ['00000002'] });
    const out = await wise.submit(stored.conn('wise'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.equal(out.items[0].status, 'processing');
    assert.equal(out.items[1].status, 'failed');
    assert.match(out.items[1].failureReason ?? '', /Wise would not add this account: Please specify a valid account number/);
    assert.ok(!(out.items[1].failureReason ?? '').includes('00000002'));
    fake.script({ refuseAccounts: [], approvalsOn: true });
    const appr = await wise.submit(stored.conn('wise'), batch({ idempotencyKey: 'b2' }), [item(3, { idempotencyKey: 'b2:3' })], stored.ctx(fake.url));
    assert.equal(appr.items[0].status, 'failed');
    assert.match(appr.items[0].failureReason ?? '', /payment approvals/);
  });

  test('refresh: waiting for you to pay it in Wise → processing; sent → paid; cancelled or refunded → failed; bounced back → processing', async () => {
    const sent = await wise.submit(stored.conn('wise'), batch(), [1, 2, 3, 4, 5].map((n) => item(n)), stored.ctx(fake.url));
    const ids = sent.items.map((r) => Number(r.providerRef));
    fake.setStatus(ids[1], 'outgoing_payment_sent');
    fake.setStatus(ids[2], 'cancelled');
    fake.setStatus(ids[3], 'funds_refunded');
    fake.setStatus(ids[4], 'bounced_back');
    const out = await wise.refresh(stored.conn('wise'), [1, 2, 3, 4, 5].map((n, i) => item(n, { providerRef: String(ids[i]) })), stored.ctx(fake.url));
    assert.deepEqual(out.map((r) => r.status), ['processing', 'paid', 'failed', 'failed', 'processing']);
    assert.match(out[2].failureReason ?? '', /cancelled in Wise before it was paid/);
    assert.match(out[3].failureReason ?? '', /Wise refunded it/);
  });

  test('a 503 on a status check is tried again; still failing, the check stops with a plain error', async () => {
    const sent = await wise.submit(stored.conn('wise'), batch(), [item(1)], stored.ctx(fake.url));
    fake.script({ getFail: 1 });
    const ok = await wise.refresh(stored.conn('wise'), [item(1, { providerRef: sent.items[0].providerRef })], stored.ctx(fake.url));
    assert.equal(ok[0].status, 'processing');
    fake.script({ getFail: 5 });
    await throwsProvider(wise.refresh(stored.conn('wise'), [item(1, { providerRef: sent.items[0].providerRef })], stored.ctx(fake.url)), /Wise is not answering properly \(answered 503\)/);
  });

  test('cancel: a transfer still waiting to be paid in Wise is cancelled there; one already on its way stays', async () => {
    const sent = await wise.submit(stored.conn('wise'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    fake.setStatus(Number(sent.items[1].providerRef), 'processing');
    assert.ok(wise.cancel, 'Wise transfers can be cancelled before they are paid');
    const out = await wise.cancel!(stored.conn('wise'), [item(1, { providerRef: sent.items[0].providerRef }), item(2, { providerRef: sent.items[1].providerRef })], stored.ctx(fake.url));
    assert.equal(out[0].status, 'failed');
    assert.match(out[0].failureReason ?? '', /Stopped before it was paid/);
    assert.equal(out[1].status, 'processing');
    assert.equal(fake.transfers.get(Number(sent.items[0].providerRef))!.status, 'cancelled');
  });
});

// ───────────────────────────── TrueLayer payouts ─────────────────────────────

describe('TrueLayer payouts adapter (sandbox fake)', () => {
  let fake: TrueLayerFake;
  let tl: PaymentProviderAdapter;
  let stored: StoredConnection;
  beforeEach(async () => {
    fake = await startTrueLayerFake({ publicKey: ec.publicKey });
    tl = createTrueLayerProvider({ timeoutMs: 400 });
    stored = new StoredConnection({ clientId: fake.clientId, signingKeyId: fake.kid }, { clientSecret: fake.clientSecret, privateKey: EC_PEM });
  });
  afterEach(() => fake.close());

  test('the form: client ID and secret, signing key ID and an EC P-521 private key (ES512)', () => {
    assert.equal(tl.ready, true);
    assert.deepEqual(tl.configFields.map((f) => f.name), ['clientId', 'clientSecret', 'signingKeyId', 'privateKey', 'merchantAccountId']);
    const ok = tl.validateConfig({ settings: { clientId: 'a', signingKeyId: fake.kid }, secrets: { clientSecret: 's', privateKey: EC_PEM } });
    assert.equal(ok.settings.signingKeyId, fake.kid);
    const wrongCurve = configError(() => tl.validateConfig({ settings: { clientId: 'a', signingKeyId: fake.kid }, secrets: { clientSecret: 's', privateKey: EC256_PEM } }));
    assert.ok(wrongCurve.some((e) => e.path === 'privateKey' && /P-521/.test(e.message)));
    const rsaKey = configError(() => tl.validateConfig({ settings: { clientId: 'a', signingKeyId: fake.kid }, secrets: { clientSecret: 's', privateKey: RSA_PEM } }));
    assert.ok(rsaKey.some((e) => e.path === 'privateKey'));
  });

  test('test: client credentials token, a signed request TrueLayer checks, the merchant account balance', async () => {
    const out = await tl.testConnection(stored.conn('truelayer'), stored.ctx(fake.url));
    assert.equal(out.ok, true, out.message);
    assert.match(out.message, /TrueLayer sandbox/);
    assert.equal(out.balancePence, 250_000);
    assert.equal(fake.signatures.ok, 1, 'the signing key was checked');
    stored.secrets.privateKey = generateKeyPairSync('ec', { namedCurve: 'secp521r1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    const badKey = await tl.testConnection(stored.conn('truelayer'), stored.ctx(fake.url));
    assert.equal(badKey.ok, false);
    assert.match(badKey.message, /TrueLayer did not accept the signature/);
    stored.secrets.clientSecret = 'wrong-secret-1234';
    const wrong = await tl.testConnection(stored.conn('truelayer'), stored.ctx(fake.url));
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /TrueLayer did not accept the client ID or client secret/);
    noSecretsIn(JSON.stringify([out, badKey, wrong]), ['wrong-secret-1234', fake.clientSecret]);
  });

  test('merchant account: the only GBP one is used; with several, the test asks which', async () => {
    fake.script({ merchantAccounts: [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', currency: 'GBP', available_balance_in_minor: 1, current_balance_in_minor: 1, account_holder_name: 'One' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', currency: 'GBP', available_balance_in_minor: 2, current_balance_in_minor: 2, account_holder_name: 'Two' },
    ] });
    const out = await tl.testConnection(stored.conn('truelayer'), stored.ctx(fake.url));
    assert.equal(out.ok, false);
    assert.match(out.message, /more than one GBP merchant account/);
    stored.settings.merchantAccountId = 'aaaaaaaa-0000-4000-8000-000000000002';
    const chosen = await tl.testConnection(stored.conn('truelayer'), stored.ctx(fake.url));
    assert.equal(chosen.ok, true, chosen.message);
    assert.equal(chosen.balancePence, 2);
  });

  test('pays: a signed POST /v3/payouts with an Idempotency-Key per item, pence as amount_in_minor, sort code and account number', async () => {
    const out = await tl.submit(stored.conn('truelayer'), batch(), [item(1, { amountPence: 6350 })], stored.ctx(fake.url));
    assert.equal(out.items[0].status, 'processing');
    const [p] = [...fake.payouts.values()];
    assert.equal(p.idempotencyKey, paymentUuid('batch-key-1:1'));
    assert.equal(p.amount_in_minor, 6350);
    assert.deepEqual(p.beneficiary, { type: 'external_account', account_holder_name: 'Jordan Lee', account_identifier: { type: 'sort_code_account_number', sort_code: '000000', account_number: '00000001' }, reference: 'LINEAR 05OCT JL' });
    assert.equal(out.items[0].providerRef, p.id);
    assert.equal(fake.signatures.bad, 0);
  });

  test('a resubmit (also after a timeout or a 503) is the same payout: one per item', async () => {
    fake.script({ payoutSlow: 3 });
    const first = await tl.submit(stored.conn('truelayer'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.equal(first.items.length, 0);
    assert.match(first.error ?? '', /TrueLayer did not answer within/);
    assert.equal(fake.payouts.size, 1);
    fake.script({ payoutFail: 1 });
    const again = await tl.submit(stored.conn('truelayer'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.deepEqual(again.items.map((r) => r.status), ['processing', 'processing']);
    assert.equal(fake.payouts.size, 2);
    const third = await tl.submit(stored.conn('truelayer'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.deepEqual(third.items.map((r) => r.providerRef), again.items.map((r) => r.providerRef));
    assert.equal(fake.payouts.size, 2);
  });

  test('partial failure: refused details fail with TrueLayer’s words, the rest go', async () => {
    fake.script({ refuseAccounts: ['00000002'] });
    const out = await tl.submit(stored.conn('truelayer'), batch(), [item(1), item(2)], stored.ctx(fake.url));
    assert.equal(out.items[0].status, 'processing');
    assert.equal(out.items[1].status, 'failed');
    assert.match(out.items[1].failureReason ?? '', /TrueLayer refused this payout: .*account number is not valid/);
    assert.ok(!(out.items[1].failureReason ?? '').includes('00000002'));
  });

  test('cross:X-1: a payout approved more than 5 hours ago is never sent again blind (TrueLayer only knows a repeated key for 6 hours)', async () => {
    assert.equal(TRUELAYER_REPEAT_HOURS, 5);
    const posts = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/v3/payouts').length;
    const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const out = await tl.submit(stored.conn('truelayer'), batch({ createdAt: old, approvedAt: old }), [item(1), item(2)], stored.ctx(fake.url));
    assert.deepEqual(out.items.map((r) => r.status), ['failed', 'failed']);
    assert.match(out.items[0].failureReason ?? '', /^Not sent: this payout was approved more than 5 hours ago and TrueLayer only recognises a repeated payout for 6 hours/);
    assert.match(out.items[0].failureReason ?? '', /Check the payouts in the TrueLayer Console, then pay this week again if it was not paid\.$/);
    assert.equal(posts(), 0, 'nothing sent');
    assert.equal(fake.payouts.size, 0);
    // inside the window it is sent as usual
    const recent = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const ok = await tl.submit(stored.conn('truelayer'), batch({ createdAt: recent, approvedAt: recent }), [item(1)], stored.ctx(fake.url));
    assert.equal(ok.items[0].status, 'processing');
    assert.equal(posts(), 1);
  });

  test('refresh: executed → paid; failed → failed with plain words; pending and authorized → processing', async () => {
    const sent = await tl.submit(stored.conn('truelayer'), batch(), [1, 2, 3, 4].map((n) => item(n)), stored.ctx(fake.url));
    const ids = sent.items.map((r) => r.providerRef!);
    fake.setStatus(ids[0], 'executed');
    fake.setStatus(ids[1], 'failed', 'insufficient_funds');
    fake.setStatus(ids[2], 'authorized');
    const out = await tl.refresh(stored.conn('truelayer'), [1, 2, 3, 4].map((n, i) => item(n, { providerRef: ids[i] })), stored.ctx(fake.url));
    assert.deepEqual(out.map((r) => r.status), ['paid', 'failed', 'processing', 'processing']);
    assert.match(out[1].failureReason ?? '', /Not enough money in your TrueLayer merchant account/);
  });
});

// ───────────────────────────── through Linear Hub ─────────────────────────────

function addRun(db: Db, p: { userId: number; weekStart: string; gross: number }): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, NULL, 'pending', ?)`,
    [p.userId, p.weekStart, addDays(p.weekStart, 6), p.gross, p.gross, paydayForWeek(p.weekStart), `PAY-A-${p.userId}-${p.weekStart}`],
  ).lastInsertRowid;
}

function setBank(db: Db, userId: number, account: string): void {
  // a day before now on the business clock, the clock payments compare bank details changes with (LM_BUSINESS_NOW)
  const at = new Date(businessNow().getTime() - 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, '00', ?, ?, ?, NULL)`,
    [userId, `Person ${userId} Test`, encrypt('000000'), encrypt(account), account.slice(-4), at, userId, at],
  );
}

describe('through Linear Hub: connect, test, live, approve with a code, checked, paid once', () => {
  let srv: TestServer;
  let admin: TestClient;
  let weekStart: string;
  let rev: RevolutFake;
  let wiseFake: WiseFake;
  let tlFake: TrueLayerFake;
  let publicKeys: { rsa: KeyObject; ec: KeyObject };
  before(async () => {
    publicKeys = { rsa: rsa.publicKey, ec: ec.publicKey };
    [rev, wiseFake, tlFake] = await Promise.all([startRevolutFake({ publicKey: publicKeys.rsa }), startWiseFake(), startTrueLayerFake({ publicKey: publicKeys.ec })]);
  });
  after(async () => {
    await Promise.all([rev.close(), wiseFake.close(), tlFake.close()]);
  });
  beforeEach(async () => {
    srv = await startTestServer();
    admin = await srv.login('admin');
    weekStart = addDays(mondayOf(srv.fixture!.today), -21);
    registerPaymentProvider(createRevolutProvider({ baseUrl: rev.url }));
    registerPaymentProvider(createWiseProvider({ baseUrl: wiseFake.url }));
    registerPaymentProvider(createTrueLayerProvider({ baseUrl: tlFake.url }));
  });
  afterEach(async () => {
    for (const id of ['revolut', 'wise', 'truelayer']) unregisterPaymentProvider(id);
    await srv.close();
  });

  // Release 1.4 (S): the fixture admin signed in with two-step on (helpers.ts); every approval takes a current code
  const code = () => currentCode(srv.db, srv.fixture!.users.admin);

  async function connectLive(provider: string, settings: Record<string, string>, secrets: Record<string, string>, liveSecrets: Record<string, string> = {}): Promise<number> {
    const made = await admin.post('/payments/connections', { provider, settings, secrets });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.mode, 'test');
    const t = await admin.post(`/payments/connections/${made.json.id}/test`);
    assert.equal(t.json.ok, true, JSON.stringify(t.json));
    const live = await admin.patch(`/payments/connections/${made.json.id}`, { mode: 'live', confirm: PAYMENT_LIVE_CONFIRMATION });
    assert.equal(live.status, 200, JSON.stringify(live.json));
    if (Object.keys(liveSecrets).length) assert.equal((await admin.patch(`/payments/connections/${made.json.id}`, { secrets: liveSecrets })).status, 200);
    const t2 = await admin.post(`/payments/connections/${made.json.id}/test`);
    assert.equal(t2.json.ok, true, JSON.stringify(t2.json));
    return made.json.id as number;
  }

  async function payOne(connectionId: number, account: string): Promise<{ batchId: number; runId: number }> {
    const userId = srv.fixture!.users.rep;
    setBank(srv.db, userId, account);
    const runId = addRun(srv.db, { userId, weekStart, gross: 63.5 });
    const draft = await admin.post('/payments/batches', { connectionId, runIds: [runId] });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    assert.equal(draft.json.totalPence, 6350);
    const approved = await admin.post(`/payments/batches/${draft.json.id}/approve`, { code: code() });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.items[0].status, 'processing');
    assert.equal(approved.json.lastError ?? null, null);
    return { batchId: draft.json.id, runId };
  }

  const runStatus = (id: number) => get<{ status: string }>(srv.db, `SELECT status FROM payroll_runs WHERE id = ?`, [id])!.status;
  /** Marked paid ('late': paid after its due date — these weeks ended three weeks ago). */
  const PAID = ['paid', 'late'];

  test('the three API providers are available now', async () => {
    const r = await admin.get('/payments/providers');
    for (const id of ['revolut', 'wise', 'truelayer']) {
      const p = r.json.find((x: Json) => x.id === id);
      assert.equal(p.available, true, id);
      // what is done outside Linear Hub, what live needs and what happens while payments are on their way
      assert.ok(p.connectSteps.length >= 3 && p.liveNote && p.waitingNote, id);
    }
    const wise = r.json.find((x: Json) => x.id === 'wise');
    assert.equal(wise.abilities.paysFromApp, false);
    assert.match(wise.approveNote, /pay the transfers there/);
    assert.equal(r.json.find((x: Json) => x.id === 'revolut').configFields.find((f: Json) => f.name === 'authCode').requiredUnless, 'refreshToken');
  });

  test('Revolut: the refresh token is stored encrypted (never answered); paid when Revolut completes it; once', async () => {
    const id = await connectLive('revolut', { clientId: rev.clientId, redirectUri: `https://${rev.redirectDomain}` }, { privateKey: RSA_PEM, authCode: rev.issueCode() }, { authCode: rev.issueCode() });
    const conn = (await admin.get('/payments/connections')).json.find((c: Json) => c.id === id);
    assert.ok(conn.secretsSet.includes('refreshToken'));
    assert.ok(!JSON.stringify(conn).includes('oa_sand_refresh'));
    const stored = get<{ enc: string }>(srv.db, `SELECT secrets_enc AS enc FROM payment_connections WHERE id = ?`, [id])!.enc;
    assert.ok(!stored.includes('oa_sand_refresh'), 'encrypted at rest');
    const { batchId, runId } = await payOne(id, '00000010');
    assert.equal(rev.txns.size, 1);
    const [txn] = [...rev.txns.values()];
    rev.setState(txn.id, 'completed');
    const checked = await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.equal(checked.json.status, 'completed');
    assert.ok(PAID.includes(runStatus(runId)), runStatus(runId));
    await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.equal((await admin.post(`/payments/batches/${batchId}/approve`, { code: code() })).status, 409);
    assert.equal(rev.txns.size, 1, 'paid once');
    const audit = JSON.stringify(all(srv.db, `SELECT summary, before_json, after_json FROM audit_log`));
    noSecretsIn(audit, [RSA_PEM, 'oa_sand_refresh', '00000010']);
  });

  test('Wise: the transfer waits for Matt in Wise; when Wise has sent it, the run is paid; cancel before that stops it', async () => {
    const id = await connectLive('wise', {}, { apiToken: wiseFake.token });
    const { batchId, runId } = await payOne(id, '00000011');
    const [t] = [...wiseFake.transfers.values()];
    assert.equal(t.status, 'incoming_payment_waiting');
    const waiting = await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.equal(waiting.json.items[0].status, 'processing');
    assert.equal(runStatus(runId), 'pending');
    wiseFake.setStatus(t.id, 'outgoing_payment_sent');
    await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.ok(PAID.includes(runStatus(runId)), runStatus(runId));
    assert.equal(wiseFake.transfers.size, 1);
    assert.equal(wiseFake.fundAttempts, 0);
    // a second week, cancelled before Matt pays it in Wise
    const runB = addRun(srv.db, { userId: srv.fixture!.users.rep, weekStart: addDays(weekStart, 7), gross: 10 });
    const d2 = (await admin.post('/payments/batches', { connectionId: id, runIds: [runB] })).json;
    await admin.post(`/payments/batches/${d2.id}/approve`, { code: code() });
    const detail = (await admin.get(`/payments/batches/${d2.id}`)).json;
    assert.equal(detail.actions.cancel, true);
    const c = await admin.post(`/payments/batches/${d2.id}/cancel`);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.items[0].status, 'failed');
    assert.equal(runStatus(runB), 'failed', 'back on Runs to pay with the reason');
  });

  test('TrueLayer: signed payout, executed → paid once', async () => {
    const id = await connectLive('truelayer', { clientId: tlFake.clientId, signingKeyId: tlFake.kid }, { clientSecret: tlFake.clientSecret, privateKey: EC_PEM });
    const { batchId, runId } = await payOne(id, '00000012');
    const [p] = [...tlFake.payouts.values()];
    tlFake.setStatus(p.id, 'executed');
    await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.ok(PAID.includes(runStatus(runId)), runStatus(runId));
    await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.equal(tlFake.payouts.size, 1);
  });

  test('a provider that does not answer: the payment keeps its items queued with the reason; the next check sends them (once)', async () => {
    const id = await connectLive('truelayer', { clientId: tlFake.clientId, signingKeyId: tlFake.kid }, { clientSecret: tlFake.clientSecret, privateKey: EC_PEM });
    registerPaymentProvider(createTrueLayerProvider({ baseUrl: tlFake.url, timeoutMs: 300 }));
    tlFake.script({ payoutSlow: 3 });
    const userId = srv.fixture!.users.rep;
    setBank(srv.db, userId, '00000013');
    const runId = addRun(srv.db, { userId, weekStart, gross: 20 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    const before = tlFake.payouts.size;
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.items[0].status, 'queued');
    assert.match(approved.json.lastError ?? '', /TrueLayer did not answer within/);
    const again = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(again.json.items[0].status, 'processing');
    assert.equal(again.json.lastError ?? null, null);
    assert.equal(tlFake.payouts.size, before + 1, 'one payout although it was sent twice');
  });

  test('cross:X-1: a TrueLayer payout that timed out and is checked more than 5 hours later is failed, never sent again', async () => {
    const id = await connectLive('truelayer', { clientId: tlFake.clientId, signingKeyId: tlFake.kid }, { clientSecret: tlFake.clientSecret, privateKey: EC_PEM });
    registerPaymentProvider(createTrueLayerProvider({ baseUrl: tlFake.url, timeoutMs: 300 }));
    tlFake.script({ payoutSlow: 3 });
    const userId = srv.fixture!.users.rep;
    setBank(srv.db, userId, '00000015');
    const runId = addRun(srv.db, { userId, weekStart, gross: 25 });
    const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
    const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
    assert.equal(approved.json.items[0].status, 'queued');
    const posts = () => tlFake.requests.filter((r) => r.method === 'POST' && r.path === '/v3/payouts').length;
    const sentBefore = posts();
    // a MacBook closed for the afternoon: the approval was 6 hours ago
    const aged = new Date(Date.now() - 6 * 3_600_000).toISOString();
    run(srv.db, `UPDATE payment_batches SET approved_at = ?, created_at = ? WHERE id = ?`, [aged, aged, draft.id]);
    run(srv.db, `UPDATE payment_items SET attempted_at = ? WHERE batch_id = ?`, [aged, draft.id]);
    const checked = await admin.post(`/payments/batches/${draft.id}/refresh`);
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    assert.equal(posts(), sentBefore, 'POST /v3/payouts sent again: 0');
    assert.equal(checked.json.items[0].status, 'failed');
    assert.match(checked.json.items[0].failureReason, /Not sent: this payout was approved more than 5 hours ago/);
    assert.equal(runStatus(runId), 'failed', 'back on Runs to pay with the reason');
  });

  test('cross:X-1: the age is measured on one clock (a pinned business clock does not make a fresh approval look old)', async () => {
    const id = await connectLive('truelayer', { clientId: tlFake.clientId, signingKeyId: tlFake.kid }, { clientSecret: tlFake.clientSecret, privateKey: EC_PEM });
    registerPaymentProvider(createTrueLayerProvider({ baseUrl: tlFake.url, timeoutMs: 300 }));
    setBusinessClock(new Date(Date.now() - 2 * 86_400_000)); // LM_BUSINESS_NOW two days behind, as for screenshots
    try {
      tlFake.script({ payoutSlow: 3 });
      const userId = srv.fixture!.users.rep;
      setBank(srv.db, userId, '00000016');
      const runId = addRun(srv.db, { userId, weekStart: addDays(weekStart, -7), gross: 26 });
      const draft = (await admin.post('/payments/batches', { connectionId: id, runIds: [runId] })).json;
      const approved = await admin.post(`/payments/batches/${draft.id}/approve`, { code: code() });
      assert.equal(approved.json.items[0].status, 'queued', JSON.stringify(approved.json));
      const again = await admin.post(`/payments/batches/${draft.id}/refresh`);
      assert.equal(again.json.items[0].status, 'processing', 'sent again with the same key, not failed as too old');
    } finally {
      setBusinessClock(null);
    }
  });

  test('test mode pays nobody real and marks no run paid (sandbox)', async () => {
    const made = await admin.post('/payments/connections', { provider: 'wise', secrets: { apiToken: wiseFake.token } });
    assert.equal((await admin.post(`/payments/connections/${made.json.id}/test`)).json.ok, true);
    const { batchId, runId } = await payOne(made.json.id, '00000014');
    const t = [...wiseFake.transfers.values()].at(-1)!;
    wiseFake.setStatus(t.id, 'outgoing_payment_sent');
    const done = await admin.post(`/payments/batches/${batchId}/refresh`);
    assert.equal(done.json.items[0].status, 'paid');
    assert.match(done.json.items[0].note ?? '', /Test mode/);
    assert.equal(runStatus(runId), 'pending');
  });
});
