/**
 * Release 1.4 — package A (API providers): local fake servers for Revolut Business, Wise Business and TrueLayer
 * payouts, for the adapter and route tests. They follow the request / response / error shapes of each provider's
 * documentation (the URLs are in lib/payments/revolut.ts, wise.ts and truelayer.ts) and check what a real server
 * would check: Revolut's client-assertion JWT (RS256), TrueLayer's Tl-Signature (ES512, detached JWS), bearer tokens,
 * idempotency (Revolut request_id, Wise customerTransactionId, TrueLayer Idempotency-Key). They listen on 127.0.0.1
 * on a free port: no test ever calls the real internet.
 *
 * Each fake is scriptable (`fake.script`) — a delay longer than the adapter's timeout that still makes the payment (as
 * a real timeout might), a 500 the next n times, a person whose account is refused, a payment declined later — and
 * records every request (`fake.requests`), so a test can count the payments made.
 */
import { createHash, randomUUID, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Reply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Wait this long before answering (the request is handled first: the work is done even if the client gave up). */
  delayMs?: number;
}

type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

export interface FakeHttpServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startFakeHttp(handler: Handler): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://fake');
      const rec: RecordedRequest = { method: (req.method ?? 'GET').toUpperCase(), path: u.pathname, query: u.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(rec);
      void (async () => {
        let reply: Reply;
        try {
          reply = await handler(rec);
        } catch (err) {
          reply = { status: 500, json: { message: `fake failed: ${(err as Error).message}` } };
        }
        if (reply.delayMs) await sleep(reply.delayMs);
        if (res.destroyed) return;
        const body = reply.json === undefined ? '' : JSON.stringify(reply.json);
        res.writeHead(reply.status, { ...(body ? { 'content-type': 'application/json' } : {}), ...reply.headers });
        res.end(body);
      })();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

const b64urlJson = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

function bearer(req: RecordedRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer (.+)$/i.exec(h) : null;
  return m ? m[1] : null;
}

// ───────────────────────────── Revolut Business ─────────────────────────────

export interface RevolutTxn {
  id: string;
  request_id: string;
  state: 'created' | 'pending' | 'completed' | 'declined' | 'failed' | 'reverted';
  reason_code?: string;
  amount: number;
  currency: string;
  reference: string;
  account_id: string;
  counterparty_id: string;
  receiver_account_id: string;
  created_at: string;
}

export interface RevolutScript {
  /** Seconds an access token lives (Revolut: 2399, i.e. 40 minutes). */
  tokenTtl: number;
  /** The next n POST /pay answer 500 (after making the payment when `payThenFail`). */
  payFail: number;
  payThenFail: boolean;
  /** The next n POST /pay are answered `slowMs` late (each is handled first: a payment is made, a repeat refused). */
  paySlow: number;
  slowMs: number;
  /** State a new transfer starts in. */
  payState: RevolutTxn['state'];
  /** Account numbers Revolut refuses as a counterparty (400). */
  refuseAccounts: string[];
  /** The next n API calls answer 401 (an access token Revolut no longer accepts). */
  unauthorizedNext: number;
}

export interface RevolutFake extends FakeHttpServer {
  clientId: string;
  redirectDomain: string;
  /** Hands out a fresh authorisation code (one use), as Revolut's consent page does. */
  issueCode(): string;
  txns: Map<string, RevolutTxn>;
  counterparties: { id: string; name: string; accountId: string; accountNo: string; sortCode: string }[];
  accounts: { id: string; name: string; balance: number; currency: string; state: string }[];
  setState(txnId: string, state: RevolutTxn['state'], reasonCode?: string): void;
  script(next: Partial<RevolutScript>): void;
  tokenGrants: string[];
}

/**
 * A fake of https://sandbox-b2b.revolut.com/api/1.0 (paths after /api/1.0): POST /auth/token, GET /accounts,
 * GET /counterparties, POST /counterparty, POST /pay, GET /transaction/{id}, GET /transactions.
 */
export async function startRevolutFake(opts: { publicKey: KeyObject; clientId?: string; redirectDomain?: string }): Promise<RevolutFake> {
  const clientId = opts.clientId ?? 'fake-client-id';
  const redirectDomain = opts.redirectDomain ?? 'example.com';
  const codes = new Set<string>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Map<string, number>(); // token → expires (ms)
  const txns = new Map<string, RevolutTxn>();
  const counterparties: RevolutFake['counterparties'] = [];
  const accounts = [
    { id: 'b7ec67d3-5af1-42c8-bece-3d28a1f0894d', name: 'Main', balance: 3171.89, currency: 'GBP', state: 'active', public: false, created_at: '2026-01-05T09:00:00Z', updated_at: '2026-10-01T09:00:00Z', account_type: 'current' },
    { id: 'c1d5c0a2-1111-4a4a-9a9a-0e0e0e0e0e0e', name: 'Euro', balance: 50, currency: 'EUR', state: 'active', public: false, created_at: '2026-01-05T09:00:00Z', updated_at: '2026-10-01T09:00:00Z', account_type: 'current' },
  ];
  const tokenGrants: string[] = [];
  let s: RevolutScript = { tokenTtl: 2399, payFail: 0, payThenFail: false, paySlow: 0, slowMs: 900, payState: 'pending', refuseAccounts: [], unauthorizedNext: 0 };

  const checkAssertion = (jwt: string | null): string | null => {
    if (!jwt) return 'client_assertion missing';
    const [h, p, sig] = jwt.split('.');
    if (!h || !p || !sig) return 'not a JWT';
    const header = b64urlJson(h);
    if (header.alg !== 'RS256') return 'alg must be RS256';
    if (!cryptoVerify('sha256', Buffer.from(`${h}.${p}`), opts.publicKey, Buffer.from(sig, 'base64url'))) return 'bad signature';
    const claims = b64urlJson(p);
    if (claims.sub !== clientId) return 'sub must be the client ID';
    if (claims.iss !== redirectDomain) return 'iss must be the redirect domain';
    if (claims.aud !== 'https://revolut.com') return 'aud must be https://revolut.com';
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return 'exp must be a number in the future';
    return null;
  };
  const newAccess = () => {
    const t = `oa_sand_access_${randomUUID()}`;
    accessTokens.set(t, Date.now() + s.tokenTtl * 1000);
    return t;
  };
  const authorised = (req: RecordedRequest): Reply | null => {
    if (s.unauthorizedNext > 0) {
      s.unauthorizedNext--;
      return { status: 401, json: { code: 9002, message: 'The request should be authorized.' } };
    }
    const t = bearer(req);
    const exp = t ? accessTokens.get(t) : undefined;
    if (!exp || exp < Date.now()) return { status: 401, json: { code: 9002, message: 'The request should be authorized.' } };
    return null;
  };
  const txnView = (t: RevolutTxn) => ({
    id: t.id, type: 'transfer', request_id: t.request_id, state: t.state, ...(t.reason_code ? { reason_code: t.reason_code } : {}),
    created_at: t.created_at, updated_at: t.created_at, ...(t.state === 'completed' ? { completed_at: t.created_at } : {}), reference: t.reference,
    legs: [{ leg_id: t.id, account_id: t.account_id, counterparty: { id: t.counterparty_id, account_type: 'external', account_id: t.receiver_account_id }, amount: -t.amount, currency: t.currency, description: `To ${t.reference}` }],
  });

  /** POST /pay: https://developer.revolut.com/docs/api/business#create-payment (a repeated request_id: 400, code 3020). */
  const payReply = (req: RecordedRequest): Reply => {
    const b = JSON.parse(req.body || '{}') as Record<string, unknown>;
    const rid = typeof b.request_id === 'string' ? b.request_id : '';
    if (!rid || rid.length > 40) return { status: 400, json: { code: 2101, message: "'request_id' is required (at most 40 characters)" } };
    const recv = b.receiver as { counterparty_id?: string; account_id?: string } | undefined;
    if (typeof b.account_id !== 'string' || !recv?.counterparty_id || typeof b.amount !== 'number' || b.currency !== 'GBP' || typeof b.reference !== 'string') {
      return { status: 400, json: { code: 2101, message: "'account_id', 'receiver', 'amount', 'currency' and 'reference' are required" } };
    }
    if ([...txns.values()].some((t) => t.request_id === rid)) return { status: 400, json: { code: 3020, message: `Duplicate request: ${rid}` } };
    if (s.payFail > 0 && !s.payThenFail) {
      s.payFail--;
      return { status: 500, json: { code: 9000, message: 'Internal error' } };
    }
    const t: RevolutTxn = { id: randomUUID(), request_id: rid, state: s.payState, amount: b.amount, currency: 'GBP', reference: b.reference, account_id: b.account_id, counterparty_id: recv.counterparty_id, receiver_account_id: recv.account_id ?? '', created_at: new Date().toISOString() };
    txns.set(t.id, t);
    if (s.payFail > 0) {
      s.payFail--;
      return { status: 500, json: { code: 9000, message: 'Internal error' } };
    }
    return { status: 200, json: { id: t.id, state: t.state, created_at: t.created_at, ...(t.state === 'completed' ? { completed_at: t.created_at } : {}) } };
  };

  const http = await startFakeHttp(async (req) => {
    if (req.method === 'POST' && req.path === '/auth/token') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return { status: 400, json: { error: 'invalid_request', error_description: 'form body expected' } };
      const f = new URLSearchParams(req.body);
      if (f.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return { status: 400, json: { error: 'invalid_request', error_description: 'client_assertion_type' } };
      const bad = checkAssertion(f.get('client_assertion'));
      if (bad) return { status: 400, json: { error: 'invalid_client', error_description: bad } };
      const grant = f.get('grant_type') ?? '';
      tokenGrants.push(grant);
      if (grant === 'authorization_code') {
        const code = f.get('code') ?? '';
        if (!codes.delete(code)) return { status: 400, json: { error: 'invalid_grant', error_description: 'The authorisation code is invalid or has expired' } };
        const refresh = `oa_sand_refresh_${randomUUID()}`;
        refreshTokens.add(refresh);
        return { status: 200, json: { access_token: newAccess(), token_type: 'bearer', expires_in: s.tokenTtl, refresh_token: refresh } };
      }
      if (grant === 'refresh_token') {
        if (!refreshTokens.has(f.get('refresh_token') ?? '')) return { status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token is invalid' } };
        return { status: 200, json: { access_token: newAccess(), token_type: 'bearer', expires_in: s.tokenTtl } };
      }
      return { status: 400, json: { error: 'unsupported_grant_type' } };
    }
    const denied = authorised(req);
    if (denied) return denied;
    if (req.method === 'GET' && req.path === '/accounts') return { status: 200, json: accounts };
    if (req.method === 'GET' && req.path === '/counterparties') {
      const no = req.query.get('account_no');
      const sc = req.query.get('sort_code');
      const found = counterparties.filter((c) => (!no || c.accountNo === no) && (!sc || c.sortCode === sc.replace(/-/g, '')));
      return { status: 200, json: found.map((c) => ({ id: c.id, name: c.name, profile_type: 'personal', state: 'created', created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:00:00Z', accounts: [{ id: c.accountId, account_no: c.accountNo, sort_code: c.sortCode, name: c.name, bank_country: 'GB', currency: 'GBP', type: 'external' }] })) };
    }
    if (req.method === 'POST' && req.path === '/counterparty') {
      const b = JSON.parse(req.body || '{}') as Record<string, unknown>;
      const n = b.individual_name as { first_name?: string; last_name?: string } | undefined;
      if (!n?.first_name || !n?.last_name || b.bank_country !== 'GB' || b.currency !== 'GBP' || typeof b.account_no !== 'string' || typeof b.sort_code !== 'string') {
        return { status: 400, json: { code: 3000, message: "'individual_name', 'bank_country', 'currency', 'account_no' and 'sort_code' are required" } };
      }
      if (s.refuseAccounts.includes(b.account_no)) return { status: 400, json: { code: 3000, message: `${b.account_no} is not a valid account number` } };
      const c = { id: randomUUID(), name: `${n.first_name} ${n.last_name}`, accountId: randomUUID(), accountNo: b.account_no, sortCode: String(b.sort_code).replace(/-/g, '') };
      counterparties.push(c);
      return { status: 200, json: { id: c.id, name: c.name, profile_type: 'personal', state: 'created', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), accounts: [{ id: c.accountId, account_no: c.accountNo, sort_code: c.sortCode, name: c.name, bank_country: 'GB', currency: 'GBP', type: 'external' }] } };
    }
    if (req.method === 'POST' && req.path === '/pay') {
      const slow = s.paySlow > 0 ? (s.paySlow--, s.slowMs) : 0;
      const reply = payReply(req);
      return slow ? { ...reply, delayMs: slow } : reply;
    }
    const one = /^\/transaction\/([^/]+)$/.exec(req.path);
    if (req.method === 'GET' && one) {
      const t = txns.get(decodeURIComponent(one[1]));
      return t ? { status: 200, json: txnView(t) } : { status: 404, json: { code: 3006, message: 'Resource not found' } };
    }
    if (req.method === 'GET' && req.path === '/transactions') {
      const rid = req.query.get('request_id');
      if (rid && !req.query.get('from')) return { status: 400, json: { code: 2101, message: "'from' is required with 'request_id'" } };
      return { status: 200, json: [...txns.values()].filter((t) => !rid || t.request_id === rid).map(txnView) };
    }
    return { status: 404, json: { code: 3006, message: 'Resource not found' } };
  });
  return {
    ...http,
    clientId,
    redirectDomain,
    issueCode() {
      const c = `oa_sand_${randomUUID()}`;
      codes.add(c);
      return c;
    },
    txns,
    counterparties,
    accounts,
    tokenGrants,
    setState(id, state, reasonCode) {
      const t = txns.get(id);
      if (t) Object.assign(t, { state, reason_code: reasonCode });
    },
    script(next) {
      s = { ...s, ...next };
    },
  };
}

// ───────────────────────────── Wise Business ─────────────────────────────

export interface WiseTransfer {
  id: number;
  targetAccount: number;
  quoteUuid: string;
  customerTransactionId: string;
  status: string;
  reference: string;
  targetValue: number;
}

export interface WiseScript {
  /** Account numbers Wise refuses as a recipient (422). */
  refuseAccounts: string[];
  /** Business payment approvals are switched on: transfers made with a personal token are refused. */
  approvalsOn: boolean;
  /** The next n GET /v1/transfers/{id} answer 503. */
  getFail: number;
  /** The next n POST /v1/transfers are answered `slowMs` late (each is handled first: a transfer is made or found). */
  transferSlow: number;
  slowMs: number;
}

export interface WiseFake extends FakeHttpServer {
  token: string;
  businessProfileId: number;
  transfers: Map<number, WiseTransfer>;
  recipients: Map<number, { accountHolderName: string; sortCode: string; accountNumber: string }>;
  setStatus(id: number, status: string): void;
  script(next: Partial<WiseScript>): void;
  /** Funding calls received (Linear Hub must never fund: personal tokens cannot for UK businesses). */
  fundAttempts: number;
}

/** A fake of https://api.wise-sandbox.com: GET /v2/profiles, POST /v1/accounts, POST /v3/profiles/{id}/quotes, POST /v1/transfers, GET /v1/transfers/{id}, PUT /v1/transfers/{id}/cancel. */
export async function startWiseFake(opts: { token?: string } = {}): Promise<WiseFake> {
  const token = opts.token ?? 'wise-sandbox-token-0000';
  const businessProfileId = 20202;
  const transfers = new Map<number, WiseTransfer>();
  const recipients = new Map<number, { accountHolderName: string; sortCode: string; accountNumber: string }>();
  const quotes = new Map<string, { targetAmount: number; targetAccount: number | null }>();
  let nextId = 1000;
  let fundAttempts = 0;
  let s: WiseScript = { refuseAccounts: [], approvalsOn: false, getFail: 0, transferSlow: 0, slowMs: 900 };
  const view = (t: WiseTransfer) => ({
    id: t.id, user: 1, targetAccount: t.targetAccount, sourceAccount: null, quote: null, quoteUuid: t.quoteUuid, status: t.status, reference: t.reference,
    rate: 1, created: '2026-10-23 10:00:00', business: businessProfileId, details: { reference: t.reference }, hasActiveIssues: false,
    sourceCurrency: 'GBP', sourceValue: t.targetValue, targetCurrency: 'GBP', targetValue: t.targetValue, customerTransactionId: t.customerTransactionId,
  });
  /** POST /v1/transfers: https://docs.wise.com/api-reference/transfer/transfercreate (a repeated customerTransactionId: the first transfer). */
  const transferReply = (req: RecordedRequest): Reply => {
    const b = JSON.parse(req.body || '{}') as Record<string, unknown>;
    const ctid = typeof b.customerTransactionId === 'string' ? b.customerTransactionId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ctid)) return { status: 422, json: { errors: [{ code: 'NOT_VALID', message: 'customerTransactionId must be a UUID', path: 'customerTransactionId' }] } };
    const seen = [...transfers.values()].find((t) => t.customerTransactionId === ctid);
    if (seen) return { status: 200, json: view(seen) }; // a repeat: the first transfer, never a second one
    if (s.approvalsOn) return { status: 422, json: { errors: [{ code: 'quote.not.accepted', message: 'Quote cannot be accepted with this request due to missing approval.' }] } };
    const quote = quotes.get(String(b.quoteUuid ?? ''));
    if (!quote || typeof b.targetAccount !== 'number' || !recipients.has(b.targetAccount)) return { status: 422, json: { errors: [{ code: 'NOT_VALID', message: 'Please check the quote and recipient.' }] } };
    const ref = ((b.details ?? {}) as Record<string, unknown>).reference;
    const t: WiseTransfer = { id: nextId++, targetAccount: b.targetAccount, quoteUuid: String(b.quoteUuid), customerTransactionId: ctid, status: 'incoming_payment_waiting', reference: typeof ref === 'string' ? ref : '', targetValue: quote.targetAmount };
    transfers.set(t.id, t);
    return { status: 200, json: view(t) };
  };
  const http = await startFakeHttp((req) => {
    if (bearer(req) !== token) return { status: 401, json: { error: 'invalid_token', error_description: 'Invalid token' } };
    if (req.method === 'GET' && req.path === '/v2/profiles') {
      return { status: 200, json: [{ id: 10101, type: 'PERSONAL', fullName: 'Test Person' }, { id: businessProfileId, type: 'BUSINESS', businessName: 'Test Business Ltd' }] };
    }
    if (req.method === 'POST' && req.path === '/v1/accounts') {
      const b = JSON.parse(req.body || '{}') as Record<string, unknown>;
      const d = (b.details ?? {}) as Record<string, unknown>;
      if (b.currency !== 'GBP' || b.type !== 'sort_code' || b.profile !== businessProfileId || typeof b.accountHolderName !== 'string' || typeof d.sortCode !== 'string' || typeof d.accountNumber !== 'string' || d.legalType !== 'PRIVATE') {
        return { status: 422, json: { errors: [{ code: 'NOT_VALID', message: 'Please check the recipient details.', path: 'details' }] } };
      }
      if (s.refuseAccounts.includes(d.accountNumber)) return { status: 422, json: { errors: [{ code: 'NOT_VALID', message: 'Please specify a valid account number.', path: 'accountNumber', arguments: ['accountNumber', d.accountNumber] }] } };
      const id = nextId++;
      recipients.set(id, { accountHolderName: b.accountHolderName, sortCode: d.sortCode, accountNumber: d.accountNumber });
      return { status: 200, json: { id, profile: businessProfileId, accountHolderName: b.accountHolderName, type: 'sort_code', country: 'GB', currency: 'GBP', details: { sortCode: d.sortCode, accountNumber: d.accountNumber } } };
    }
    const q = /^\/v3\/profiles\/(\d+)\/quotes$/.exec(req.path);
    if (req.method === 'POST' && q) {
      if (Number(q[1]) !== businessProfileId) return { status: 403, json: { errors: [{ code: 'FORBIDDEN', message: 'Profile not found' }] } };
      const b = JSON.parse(req.body || '{}') as Record<string, unknown>;
      if (b.sourceCurrency !== 'GBP' || b.targetCurrency !== 'GBP' || typeof b.targetAmount !== 'number' || b.targetAmount <= 0) return { status: 422, json: { errors: [{ code: 'NOT_VALID', message: 'Please check the amount.' }] } };
      const id = randomUUID();
      quotes.set(id, { targetAmount: b.targetAmount, targetAccount: typeof b.targetAccount === 'number' ? b.targetAccount : null });
      return { status: 200, json: { id, sourceCurrency: 'GBP', targetCurrency: 'GBP', sourceAmount: b.targetAmount, targetAmount: b.targetAmount, rate: 1, status: 'PENDING', profile: businessProfileId, paymentOptions: [] } };
    }
    if (req.method === 'POST' && req.path === '/v1/transfers') {
      const slow = s.transferSlow > 0 ? (s.transferSlow--, s.slowMs) : 0;
      const reply = transferReply(req);
      return slow ? { ...reply, delayMs: slow } : reply;
    }
    const one = /^\/v1\/transfers\/(\d+)$/.exec(req.path);
    if (req.method === 'GET' && one) {
      if (s.getFail > 0) {
        s.getFail--;
        return { status: 503, json: { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Try again later' }] } };
      }
      const t = transfers.get(Number(one[1]));
      return t ? { status: 200, json: view(t) } : { status: 404, json: { errors: [{ code: 'NOT_FOUND', message: 'Transfer not found' }] } };
    }
    const cancel = /^\/v1\/transfers\/(\d+)\/cancel$/.exec(req.path);
    if (req.method === 'PUT' && cancel) {
      const t = transfers.get(Number(cancel[1]));
      if (!t) return { status: 404, json: { errors: [{ code: 'NOT_FOUND', message: 'Transfer not found' }] } };
      if (t.status !== 'incoming_payment_waiting') return { status: 422, json: { errors: [{ code: 'transfer.cancel.not.allowed', message: 'This transfer can no longer be cancelled.' }] } };
      t.status = 'cancelled';
      return { status: 200, json: view(t) };
    }
    if (req.method === 'POST' && /^\/v3\/profiles\/\d+\/transfers\/\d+\/payments$/.test(req.path)) {
      fundAttempts++;
      return { status: 403, json: { errors: [{ code: 'FORBIDDEN', message: 'Personal tokens cannot fund transfers for this profile' }] } };
    }
    return { status: 404, json: { errors: [{ code: 'NOT_FOUND', message: 'Not found' }] } };
  });
  return {
    ...http,
    token,
    businessProfileId,
    transfers,
    recipients,
    get fundAttempts() {
      return fundAttempts;
    },
    setStatus(id, status) {
      const t = transfers.get(id);
      if (t) t.status = status;
    },
    script(next) {
      s = { ...s, ...next };
    },
  };
}

// ───────────────────────────── TrueLayer payouts ─────────────────────────────

export interface TrueLayerPayout {
  id: string;
  idempotencyKey: string;
  bodyHash: string;
  merchant_account_id: string;
  amount_in_minor: number;
  currency: string;
  beneficiary: Record<string, unknown>;
  status: 'pending' | 'authorized' | 'executed' | 'failed';
  failure_reason?: string;
  created_at: string;
}

export interface TrueLayerScript {
  /** Account numbers TrueLayer refuses (400 invalid parameters). */
  refuseAccounts: string[];
  /** The next n POST /v3/payouts are answered `slowMs` late (each is handled first: a payout is made or found). */
  payoutSlow: number;
  slowMs: number;
  /** The next n POST /v3/payouts answer 503 (before making anything). */
  payoutFail: number;
  /** Merchant accounts to list. */
  merchantAccounts: { id: string; currency: string; available_balance_in_minor: number; current_balance_in_minor: number; account_holder_name: string }[];
}

export interface TrueLayerFake extends FakeHttpServer {
  clientId: string;
  clientSecret: string;
  kid: string;
  payouts: Map<string, TrueLayerPayout>;
  setStatus(id: string, status: TrueLayerPayout['status'], failureReason?: string): void;
  script(next: Partial<TrueLayerScript>): void;
  /** Signatures checked (and how many failed). */
  signatures: { ok: number; bad: number };
}

/** Verifies a Tl-Signature (request-signing v2: detached JWS, ES512) the way TrueLayer does. */
export function verifyTlSignature(signature: string, publicKey: KeyObject, kid: string, method: string, path: string, headers: Record<string, string>, body: string): boolean {
  const [h, empty, sig] = signature.split('.');
  if (!h || empty !== '' || !sig) return false;
  const header = b64urlJson(h);
  if (header.alg !== 'ES512' || header.kid !== kid || header.tl_version !== '2') return false;
  const names = String(header.tl_headers ?? '').split(',').filter(Boolean);
  if (!names.some((n) => n.toLowerCase() === 'idempotency-key')) return false;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let payload = `${method} ${path}\n`;
  for (const n of names) payload += `${n}: ${lower[n.toLowerCase()] ?? ''}\n`;
  payload += body;
  return cryptoVerify('sha512', Buffer.from(`${h}.${Buffer.from(payload).toString('base64url')}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
}

/**
 * A fake of TrueLayer's sandbox (auth https://auth.truelayer-sandbox.com and API https://api.truelayer-sandbox.com,
 * both on one local port): POST /connect/token, GET /v3/merchant-accounts, POST /test-signature, POST /v3/payouts,
 * GET /v3/payouts/{id}.
 */
export async function startTrueLayerFake(opts: { publicKey: KeyObject; kid?: string }): Promise<TrueLayerFake> {
  const clientId = 'sandbox-linearhub-0000';
  const clientSecret = 'tl-sandbox-secret-0000';
  const kid = opts.kid ?? '9f2b7bd6-c055-40b5-b616-120ccfd33c49';
  const tokens = new Set<string>();
  const payouts = new Map<string, TrueLayerPayout>();
  const signatures = { ok: 0, bad: 0 };
  let s: TrueLayerScript = {
    refuseAccounts: [],
    payoutSlow: 0,
    slowMs: 900,
    payoutFail: 0,
    merchantAccounts: [{ id: '2a6f4a2e-1d5c-4c5b-9b8b-6c1b2d6f0a11', currency: 'GBP', available_balance_in_minor: 250_000, current_balance_in_minor: 260_000, account_holder_name: 'Test Business Ltd' }],
  };
  const problem = (status: number, title: string, detail?: string, errors?: Record<string, string[]>) => ({
    status, headers: { 'content-type': 'application/problem+json' },
    json: { type: `https://docs.truelayer.com/docs/error-types#${title.toLowerCase().replace(/\s+/g, '-')}`, title, status, trace_id: randomUUID(), ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) },
  });
  const signedOk = (req: RecordedRequest): boolean => {
    const sig = req.headers['tl-signature'];
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') hdrs[k] = v;
    const ok = typeof sig === 'string' && verifyTlSignature(sig, opts.publicKey, kid, req.method, req.path, hdrs, req.body);
    if (ok) signatures.ok++;
    else signatures.bad++;
    return ok;
  };
  const view = (p: TrueLayerPayout) => ({
    id: p.id, merchant_account_id: p.merchant_account_id, amount_in_minor: p.amount_in_minor, currency: p.currency, beneficiary: p.beneficiary, status: p.status,
    created_at: p.created_at, ...(p.status === 'executed' ? { executed_at: p.created_at } : {}), ...(p.status === 'authorized' ? { authorized_at: p.created_at } : {}),
    ...(p.status === 'failed' ? { failed_at: p.created_at, failure_reason: p.failure_reason ?? 'unknown' } : {}), scheme_id: 'faster_payments_service',
  });
  const http = await startFakeHttp((req) => {
    if (req.method === 'POST' && req.path === '/connect/token') {
      const b = (() => {
        try {
          return JSON.parse(req.body || '{}') as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      if (b.grant_type !== 'client_credentials' || b.client_id !== clientId || b.client_secret !== clientSecret) return { status: 400, json: { error: 'invalid_client' } };
      if (b.scope !== 'payments') return { status: 400, json: { error: 'invalid_scope' } };
      const t = `tl_access_${randomUUID()}`;
      tokens.add(t);
      return { status: 200, json: { access_token: t, expires_in: 3600, token_type: 'Bearer', scope: 'payments' } };
    }
    const t = bearer(req);
    if (!t || !tokens.has(t)) return problem(401, 'Unauthorized', 'The access token is missing or not valid');
    if (req.method === 'GET' && req.path === '/v3/merchant-accounts') {
      return { status: 200, json: { items: s.merchantAccounts.map((m) => ({ ...m, account_identifiers: [{ type: 'sort_code_account_number', sort_code: '040668', account_number: '00000871' }] })) } };
    }
    if (req.method === 'POST' && req.path === '/test-signature') return signedOk(req) ? { status: 204 } : problem(401, 'Invalid Request Signature');
    if (req.method === 'POST' && req.path === '/v3/payouts') {
      const slow = s.payoutSlow > 0 ? (s.payoutSlow--, s.slowMs) : 0;
      const reply = ((): Reply => {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !key) return problem(400, 'Invalid Parameters', 'Idempotency-Key header is required');
        if (!signedOk(req)) return problem(401, 'Invalid Request Signature');
        if (s.payoutFail > 0) {
          s.payoutFail--;
          return problem(503, 'Service Unavailable');
        }
        const hash = createHash('sha256').update(req.body).digest('hex');
        const seen = [...payouts.values()].find((p) => p.idempotencyKey === key);
        if (seen) return seen.bodyHash === hash ? { status: 202, json: { id: seen.id } } : problem(422, 'Idempotency-Key Reuse');
        const b = JSON.parse(req.body || '{}') as Record<string, unknown>;
        const ben = (b.beneficiary ?? {}) as Record<string, unknown>;
        const ai = (ben.account_identifier ?? {}) as Record<string, unknown>;
        const errors: Record<string, string[]> = {};
        if (!s.merchantAccounts.some((m) => m.id === b.merchant_account_id)) errors.merchant_account_id = ['Merchant account not found'];
        if (!Number.isSafeInteger(b.amount_in_minor) || (b.amount_in_minor as number) <= 0) errors.amount_in_minor = ['Must be a positive whole number'];
        if (b.currency !== 'GBP') errors.currency = ['Must be GBP'];
        if (ben.type !== 'external_account') errors['beneficiary.type'] = ['Must be external_account'];
        if (typeof ben.account_holder_name !== 'string' || !ben.account_holder_name) errors['beneficiary.account_holder_name'] = ['Required'];
        if (typeof ben.reference !== 'string' || !ben.reference || ben.reference.length > 18) errors['beneficiary.reference'] = ['Required, at most 18 characters'];
        if (ai.type !== 'sort_code_account_number' || !/^\d{6}$/.test(String(ai.sort_code)) || !/^\d{8}$/.test(String(ai.account_number))) errors['beneficiary.account_identifier'] = ['A sort code (6 digits) and account number (8 digits)'];
        else if (s.refuseAccounts.includes(String(ai.account_number))) errors['beneficiary.account_identifier.account_number'] = ['The account number is not valid'];
        if (Object.keys(errors).length) return problem(400, 'Invalid Parameters', 'Some parameters are invalid', errors);
        const p: TrueLayerPayout = { id: randomUUID(), idempotencyKey: key, bodyHash: hash, merchant_account_id: String(b.merchant_account_id), amount_in_minor: b.amount_in_minor as number, currency: 'GBP', beneficiary: ben, status: 'pending', created_at: new Date().toISOString() };
        payouts.set(p.id, p);
        return { status: 202, json: { id: p.id } };
      })();
      return slow ? { ...reply, delayMs: slow } : reply;
    }
    const one = /^\/v3\/payouts\/([^/]+)$/.exec(req.path);
    if (req.method === 'GET' && one) {
      const p = payouts.get(decodeURIComponent(one[1]));
      return p ? { status: 200, json: view(p) } : problem(404, 'Not Found', 'Payout not found');
    }
    return problem(404, 'Not Found');
  });
  return {
    ...http,
    clientId,
    clientSecret,
    kid,
    payouts,
    signatures,
    setStatus(id, status, failureReason) {
      const p = payouts.get(id);
      if (p) Object.assign(p, { status, failure_reason: failureReason });
    },
    script(next) {
      s = { ...s, ...next };
    },
  };
}
