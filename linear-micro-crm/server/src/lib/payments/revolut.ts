/**
 * Release 1.4 — OWNED BY A api-providers: paying through the Revolut Business API (contract: ./provider.ts).
 *
 * Documentation this follows (checked 23 Oct 2026; Revolut's official OpenAPI file is
 * https://github.com/revolut-engineering/revolut-openapi/blob/master/yaml/business.yaml):
 *  - Base URLs (OpenAPI `servers`): production https://b2b.revolut.com/api/1.0, sandbox https://sandbox-b2b.revolut.com/api/1.0.
 *  - Sign-in, https://developer.revolut.com/docs/guides/manage-accounts/get-started/make-your-first-api-request :
 *    Matt makes a key pair and uploads the public certificate in Revolut Business (Settings → APIs → Business API, with
 *    an OAuth redirect URI); Revolut shows a client ID. "Enable access" (consent, done in Revolut) sends his browser to
 *    the redirect URI with `?code=…` — the code works ONCE and for TWO MINUTES. Linear Hub swaps it at POST /auth/token
 *    (form: grant_type=authorization_code, code, client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer,
 *    client_assertion=<JWT>) for an access token (40 minutes, `expires_in` 2399) and a refresh token; later
 *    grant_type=refresh_token. The client assertion is a JWT signed RS256 with the private key: iss = the redirect
 *    URI's domain (no https://), sub = the client ID, aud = "https://revolut.com", exp = a number.
 *  - GET /accounts (the GBP account to pay from and its balance), https://developer.revolut.com/docs/api/business#get-accounts
 *  - GET /counterparties?account_no=&sort_code= (exact match) and POST /counterparty (a UK individual: individual_name
 *    {first_name, last_name}, bank_country GB, currency GBP, sort_code, account_no),
 *    https://developer.revolut.com/docs/api/business#get-counterparties ,
 *    https://developer.revolut.com/docs/guides/manage-accounts/counterparties/create-a-counterparty
 *  - POST /pay {request_id, account_id, receiver {counterparty_id, account_id}, amount (a decimal), currency, reference},
 *    https://developer.revolut.com/docs/api/business#create-payment — `request_id` (at most 40 characters) is the
 *    idempotency key: a repeat is refused (400, code 3020 "Duplicate request"), and Revolut only spots repeats for
 *    2 weeks ("Idempotency checks apply only to transactions created within the last 2 weeks").
 *  - GET /transaction/{id} and GET /transactions?request_id=&from= (from is required, at most 14 days),
 *    https://developer.revolut.com/docs/api/business#get-transaction ; states created, pending, completed, declined,
 *    failed, reverted (TransactionState), with `reason_code` when declined or failed.
 * Not used: Confirmation of Payee (POST /account-name-validation: in the UK it needs Revolut API Support to switch it
 * on), payment drafts (payments that need an approver), webhooks (Linear Hub checks every 5 minutes instead).
 */
import { createHash } from 'node:crypto';
import { formatPence, paymentProviderInfo, type PaymentConfigField, type PaymentProviderInfo } from '@lm/shared';
import { bodyMessage, decimalToPence, guardTestNetwork, isTransient, paymentUuid, penceToDecimal, readPrivateKey, signJwt, splitHolderName, withoutValues } from './apiCommon.ts';
import { providerFetch, type ProviderResponse } from './http.ts';
import {
  ProviderConfigError,
  ProviderError,
  validateConfigFields,
  type ConnectionTestResult,
  type PaymentProviderAdapter,
  type ProviderBatch,
  type ProviderConfig,
  type ProviderConnection,
  type ProviderContext,
  type ProviderItem,
  type ProviderItemResult,
  type SubmitResult,
} from './provider.ts';

export const REVOLUT_LIVE_URL = 'https://b2b.revolut.com/api/1.0';
export const REVOLUT_SANDBOX_URL = 'https://sandbox-b2b.revolut.com/api/1.0';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** A token with less than this left is refreshed first. */
const TOKEN_SKEW_MS = 60_000;
/** Revolut spots a repeated request_id for 2 weeks; Linear Hub stops sending a payment again a day before. */
export const REVOLUT_REPEAT_DAYS = 13;
const DAY_MS = 86_400_000;

export const MSG_CODE_EXPIRED = 'The code from Revolut has expired or was already used (a code works once, for 2 minutes). In Revolut Business, choose Enable access for the certificate again, paste the new code here and save straight away.';
export const MSG_BAD_CLIENT = 'Revolut did not accept the client ID, private key or redirect address. Check they all belong to the same API certificate in Revolut Business (Settings → APIs → Business API) and, in test mode, that it is your sandbox certificate.';
export const MSG_REAUTH = 'Revolut no longer accepts Linear Hub’s access. In Revolut Business, open Settings → APIs → Business API, choose the certificate, choose Enable access again, then paste the new code here and save.';
const MSG_NO_CODE = 'Paste the code from Revolut: in Revolut Business choose Enable access for the API certificate, then copy the address Revolut sends you to.';

/** The connection form (Settings → Payments → Connect). "Where to find this" for each field, in plain words. */
export const REVOLUT_FIELDS: readonly PaymentConfigField[] = [
  {
    name: 'clientId',
    label: 'Client ID',
    required: true,
    help: 'In Revolut Business on a computer: Settings → APIs → Business API, then your API certificate. Test mode needs the client ID of a sandbox certificate (sandbox-business.revolut.com); live needs your real one.',
  },
  {
    name: 'redirectUri',
    label: 'OAuth redirect URI',
    required: true,
    placeholder: 'https://example.com',
    help: 'The address you typed as the OAuth redirect URI when you added the certificate in Revolut, exactly. It can be any website address: Linear Hub only uses its domain to sign in to Revolut.',
  },
  {
    name: 'privateKey',
    label: 'Private key',
    secret: true,
    required: true,
    type: 'textarea',
    placeholder: '-----BEGIN PRIVATE KEY-----',
    help: 'The private key you made on your computer with the certificate you uploaded (for example privatecert.pem). Linear Hub stores it encrypted and never shows it again.',
  },
  {
    name: 'authCode',
    label: 'Code from Revolut',
    secret: true,
    requiredUnless: 'refreshToken',
    maxLength: 2000,
    placeholder: 'https://example.com/?code=oa_…',
    help: 'In Revolut Business choose Enable access for the certificate and allow it. Revolut then opens your redirect address: copy that whole address (or just the code after “code=”), paste it here and save straight away, because the code only works for 2 minutes. You need it the first time, and again only if Revolut stops accepting Linear Hub.',
  },
  {
    name: 'accountId',
    label: 'GBP account to pay from',
    help: 'Leave it empty when you have one GBP account. With more than one, the test lists them: paste the ID of the one to pay from.',
  },
];

export interface RevolutOptions {
  /** Test hook: a local fake instead of Revolut (both modes). */
  baseUrl?: string;
  /** Per request (default 15 s, ./http.ts). */
  timeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
}

interface RevolutAccount {
  id: string;
  name?: string;
  balance?: number;
  currency?: string;
  state?: string;
}

interface Payee {
  counterpartyId: string;
  accountId: string;
}

/** The code out of whatever Matt pasted: the whole redirect address, or the code itself. */
export function revolutCodeFrom(raw: string): string {
  const text = raw.trim();
  const m = /[?&#]code=([^&#\s]+)/.exec(text);
  return m ? decodeURIComponent(m[1]) : text;
}

/** The redirect URI's domain (the client assertion's `iss`), or null when it is not an address. */
export function redirectDomain(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const u = new URL(uri.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

const infoFor = (): PaymentProviderInfo => paymentProviderInfo('revolut') as PaymentProviderInfo;

const plainReason = (code: string | undefined) => (code ? ` (${code.replace(/_/g, ' ')})` : '');

/** A Revolut transaction state → Linear Hub's. */
function fromState(state: unknown, reasonCode?: string): Pick<ProviderItemResult, 'status' | 'failureReason'> {
  switch (state) {
    case 'completed':
      return { status: 'paid', failureReason: null };
    case 'declined':
      return { status: 'failed', failureReason: `Revolut declined it${plainReason(reasonCode)}. Check your Revolut balance and the person’s bank details, then pay this week again.` };
    case 'failed':
      return { status: 'failed', failureReason: `Revolut could not make this payment${plainReason(reasonCode)}. Check it in Revolut, then pay this week again.` };
    case 'reverted':
      return { status: 'failed', failureReason: `Revolut reversed it: the money was sent back${plainReason(reasonCode)}. Check the person’s bank details, then pay this week again.` };
    default: // created, pending (and anything new): still on its way
      return { status: 'processing', failureReason: null };
  }
}

export function createRevolutProvider(opts: RevolutOptions = {}): PaymentProviderAdapter {
  const tokens = new Map<string, CachedToken>();
  const fields = REVOLUT_FIELDS;

  /** One call's view of the connection: base URL, token, requests. */
  function session(conn: ProviderConnection, ctx: ProviderContext) {
    const base = (ctx.baseUrl ?? opts.baseUrl ?? (conn.mode === 'live' ? REVOLUT_LIVE_URL : REVOLUT_SANDBOX_URL)).replace(/\/+$/, '');
    const cacheKey = `${conn.id}:${createHash('sha256').update([conn.mode, conn.settings.clientId ?? '', conn.secrets.privateKey ?? '', conn.settings.redirectUri ?? ''].join('\n')).digest('hex')}`;
    const secretValues = () => [...Object.values(conn.secrets), ...[...tokens.values()].flatMap((t) => [t.accessToken, t.refreshToken ?? ''])];
    const fetchOpts = (idempotencyKey?: string) => ({ provider: 'Revolut', secrets: secretValues(), timeoutMs: opts.timeoutMs, idempotencyKey });
    /** The pasted code was swapped in this call already (a code works once). */
    let codeUsed = false;

    async function grant(params: Record<string, string>): Promise<ProviderResponse> {
      const key = readPrivateKey(conn.secrets.privateKey);
      const iss = redirectDomain(conn.settings.redirectUri);
      if (!key || !iss || !conn.settings.clientId) throw new ProviderError(MSG_BAD_CLIENT);
      const assertion = signJwt({ iss, sub: conn.settings.clientId, aud: 'https://revolut.com', exp: Math.floor(ctx.now().getTime() / 1000) + 300 }, key);
      const url = `${base}/auth/token`;
      guardTestNetwork(url, 'Revolut');
      const body = new URLSearchParams({ ...params, client_assertion_type: ASSERTION_TYPE, client_assertion: assertion }).toString();
      return providerFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body }, fetchOpts());
    }

    async function token(force = false): Promise<string> {
      const now = ctx.now().getTime();
      const cached = tokens.get(cacheKey);
      const storedRefresh = conn.secrets.refreshToken ?? null;
      const pastedCode = conn.secrets.authCode && !codeUsed ? conn.secrets.authCode : null;
      const usable = cached && !pastedCode && (codeUsed || !storedRefresh || storedRefresh === cached.refreshToken);
      if (!force && usable && cached.expiresAt - now > TOKEN_SKEW_MS) return cached.accessToken;
      let res: ProviderResponse;
      let viaCode = false;
      if (pastedCode) {
        viaCode = true;
        res = await grant({ grant_type: 'authorization_code', code: pastedCode });
      } else {
        const refresh = (codeUsed ? cached?.refreshToken : null) ?? storedRefresh ?? cached?.refreshToken ?? null;
        if (!refresh) throw new ProviderError(MSG_NO_CODE);
        res = await grant({ grant_type: 'refresh_token', refresh_token: refresh });
      }
      const j = (res.json ?? {}) as Record<string, unknown>;
      if (!res.ok || typeof j.access_token !== 'string') {
        if (isTransient(res.status) && res.status !== 409) throw new ProviderError(`Revolut is not answering properly (answered ${res.status}). Linear Hub tries again later.`, res.status);
        const err = typeof j.error === 'string' ? j.error : '';
        if (err === 'invalid_grant') throw new ProviderError(viaCode ? MSG_CODE_EXPIRED : MSG_REAUTH, res.status);
        throw new ProviderError(MSG_BAD_CLIENT, res.status);
      }
      const refreshToken = typeof j.refresh_token === 'string' ? j.refresh_token : (storedRefresh ?? cached?.refreshToken ?? null);
      const ttl = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in * 1000 : 2399_000;
      tokens.set(cacheKey, { accessToken: j.access_token, expiresAt: now + ttl, refreshToken });
      if (viaCode) codeUsed = true;
      if (viaCode || (refreshToken && refreshToken !== storedRefresh)) {
        if (!ctx.saveSecrets) throw new ProviderError('Linear Hub could not keep the sign-in from Revolut. Try the test again.');
        // the code works once: it is replaced by the refresh token, stored encrypted with the other secrets
        ctx.saveSecrets({ refreshToken, authCode: null });
      }
      return j.access_token;
    }

    /** An API call with the bearer token; a 401 gets one new token and one more try (nothing was done on a 401). */
    async function call(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<ProviderResponse> {
      const url = `${base}${path}`;
      guardTestNetwork(url, 'Revolut');
      const send = async (t: string) => providerFetch(url, {
        method,
        headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, fetchOpts(idempotencyKey));
      let res = await send(await token());
      if (res.status === 401) res = await send(await token(true));
      if (res.status === 401) throw new ProviderError(MSG_REAUTH, 401);
      return res;
    }

    const failText = (res: ProviderResponse, hide: readonly string[] = []) => withoutValues(bodyMessage(res.json) ?? `answered ${res.status}`, hide);

    /** A 5xx / 429 left after the retries: try again later. */
    const transient = (res: ProviderResponse) => new ProviderError(`Revolut is not answering properly (answered ${res.status}). Linear Hub tries again later.`, res.status);

    async function account(): Promise<RevolutAccount> {
      const res = await call('GET', '/accounts');
      if (!res.ok) {
        if (isTransient(res.status)) throw transient(res);
        throw new ProviderError(`Revolut did not list your accounts: ${failText(res)}`, res.status);
      }
      const all = (Array.isArray(res.json) ? res.json : []) as RevolutAccount[];
      const wanted = conn.settings.accountId?.trim();
      if (wanted) {
        const a = all.find((x) => x.id === wanted);
        if (!a) throw new ProviderError('Revolut has no account with that ID. Leave “GBP account to pay from” empty, or paste the ID again from the test.');
        if (a.currency !== 'GBP') throw new ProviderError(`“${a.name ?? a.id}” is not a GBP account. Linear Hub pays people in pounds: choose your GBP account.`);
        return a;
      }
      const gbp = all.filter((x) => x.currency === 'GBP' && (x.state ?? 'active') === 'active');
      if (gbp.length === 1) return gbp[0];
      if (!gbp.length) throw new ProviderError('Your Revolut Business has no active GBP account to pay from.');
      throw new ProviderError(`Your Revolut Business has more than one GBP account: ${gbp.map((a) => `“${a.name ?? 'Account'}” (${a.id})`).join(', ')}. Paste the ID of the one to pay from in “GBP account to pay from”.`.slice(0, 500));
    }

    /** An existing counterparty with exactly these UK details, or a new one. */
    async function payee(item: ProviderItem): Promise<Payee | ProviderItemResult> {
      const hide = [item.accountNumber, item.sortCode];
      const q = new URLSearchParams({ account_no: item.accountNumber, sort_code: item.sortCode });
      const found = await call('GET', `/counterparties?${q.toString()}`);
      if (!found.ok && isTransient(found.status)) throw transient(found);
      if (found.ok && Array.isArray(found.json)) {
        for (const c of found.json as { id?: string; state?: string; accounts?: { id?: string; account_no?: string; sort_code?: string; currency?: string }[] }[]) {
          const acc = (c.accounts ?? []).find((a) => a.account_no === item.accountNumber && (a.sort_code ?? '').replace(/-/g, '') === item.sortCode && (a.currency ?? 'GBP') === 'GBP');
          if (c.id && acc?.id && c.state !== 'deleted') return { counterpartyId: c.id, accountId: acc.id };
        }
      }
      const { first, last } = splitHolderName(item.payeeName);
      const made = await call('POST', '/counterparty', { individual_name: { first_name: first, last_name: last }, bank_country: 'GB', currency: 'GBP', account_no: item.accountNumber, sort_code: item.sortCode });
      if (!made.ok) {
        if (isTransient(made.status)) throw transient(made);
        return { itemId: item.id, status: 'failed', failureReason: `Revolut would not add this account: ${failText(made, hide)}. Check the person’s bank details, then pay this week again.` };
      }
      const c = (made.json ?? {}) as { id?: string; accounts?: { id?: string }[] };
      const accId = c.accounts?.[0]?.id;
      if (!c.id || !accId) throw new ProviderError('Revolut added the person but did not answer as expected. Linear Hub tries again later.');
      return { counterpartyId: c.id, accountId: accId };
    }

    /** The transaction made with this request_id, if Revolut has one (searching at most 14 days, as documented). */
    async function byRequestId(requestId: string, from: Date): Promise<{ id: string; state: unknown; reason_code?: string } | null> {
      const to = new Date(Math.min(from.getTime() + 13.9 * DAY_MS, ctx.now().getTime() + 60_000));
      const q = new URLSearchParams({ request_id: requestId, from: from.toISOString(), to: to.toISOString() });
      const res = await call('GET', `/transactions?${q.toString()}`);
      if (!res.ok) {
        if (isTransient(res.status)) throw transient(res);
        throw new ProviderError(`Revolut did not show its transactions: ${failText(res)}`, res.status);
      }
      const list = (Array.isArray(res.json) ? res.json : []) as { id?: string; request_id?: string; state?: unknown; reason_code?: string }[];
      const t = list.find((x) => x.request_id === requestId && typeof x.id === 'string');
      return t ? { id: t.id as string, state: t.state, reason_code: t.reason_code } : null;
    }

    return { token, call, account, payee, byRequestId, failText, transient };
  }

  const resultFor = (item: ProviderItem, ref: string | null, state: unknown, reasonCode?: string): ProviderItemResult => ({ itemId: item.id, providerRef: ref, ...fromState(state, reasonCode) });

  const adapter: PaymentProviderAdapter = {
    info: infoFor(),
    configFields: fields,
    ready: true,

    validateConfig(input: ProviderConfig, existing?: ProviderConfig): ProviderConfig {
      const out = validateConfigFields(fields, input, existing);
      const errors: { path: string; message: string }[] = [];
      if (!redirectDomain(out.settings.redirectUri)) errors.push({ path: 'redirectUri', message: 'OAuth redirect URI: type the whole address, e.g. https://example.com' });
      const key = readPrivateKey(out.secrets.privateKey);
      if (!key || key.asymmetricKeyType !== 'rsa') {
        errors.push({ path: 'privateKey', message: 'Private key: paste the RSA private key that goes with your Revolut certificate (it starts with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----)' });
      }
      const typedCode = typeof input.secrets?.authCode === 'string' ? input.secrets.authCode.trim() : '';
      if (out.secrets.authCode) out.secrets.authCode = revolutCodeFrom(out.secrets.authCode);
      // keep the stored sign-in when nothing it depends on changed (an edit of the account, say)
      const kept = existing?.secrets?.refreshToken;
      const same = !typedCode && existing && out.settings.clientId === existing.settings?.clientId && out.secrets.privateKey === existing.secrets?.privateKey
        && redirectDomain(out.settings.redirectUri) === redirectDomain(existing.settings?.redirectUri);
      if (kept && same) out.secrets.refreshToken = kept;
      if (!out.secrets.authCode && !out.secrets.refreshToken) errors.push({ path: 'authCode', message: MSG_NO_CODE });
      if (errors.length) throw new ProviderConfigError(errors);
      return out;
    },

    async testConnection(conn, ctx): Promise<ConnectionTestResult> {
      try {
        const s = session(conn, ctx);
        const a = await s.account();
        const pence = decimalToPence(a.balance);
        const where = conn.mode === 'live' ? 'Revolut Business account (live: real money)' : 'Revolut Business sandbox (test money)';
        return {
          ok: true,
          message: `Connected to your ${where}. Payments go from “${a.name ?? 'your GBP account'}” (GBP)${pence === null ? '' : `, balance ${formatPence(pence)}`}.`,
          balancePence: pence,
        };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, message: err.message };
        throw err;
      }
    },

    async submit(conn, batch: ProviderBatch, items, ctx): Promise<SubmitResult> {
      const s = session(conn, ctx);
      const results: ProviderItemResult[] = [];
      const approved = new Date(batch.approvedAt ?? batch.createdAt);
      const tooOld = ctx.now().getTime() - approved.getTime() > REVOLUT_REPEAT_DAYS * DAY_MS;
      let from: RevolutAccount | null = null;
      for (const item of items) {
        const requestId = paymentUuid(item.idempotencyKey);
        try {
          if (tooOld) {
            // Revolut would not spot a repeat any more: look, never send blind
            const t = await s.byRequestId(requestId, new Date(approved.getTime() - 3_600_000));
            results.push(t
              ? resultFor(item, t.id, t.state, t.reason_code)
              : { itemId: item.id, status: 'failed', failureReason: `Not sent: this payment was approved more than ${REVOLUT_REPEAT_DAYS} days ago and Revolut only spots a repeated payment for 2 weeks, so Linear Hub will not send it again. Check Revolut, then pay this week again if it was not paid.` });
            continue;
          }
          from ??= await s.account();
          const who = await s.payee(item);
          if (!('counterpartyId' in who)) {
            results.push(who);
            continue;
          }
          const res = await s.call('POST', '/pay', {
            request_id: requestId,
            account_id: from.id,
            receiver: { counterparty_id: who.counterpartyId, account_id: who.accountId },
            amount: penceToDecimal(item.amountPence),
            currency: 'GBP',
            reference: item.reference,
          }, requestId);
          const j = (res.json ?? {}) as { id?: unknown; state?: unknown; code?: unknown };
          if (res.ok && typeof j.id === 'string') {
            results.push(resultFor(item, j.id, j.state));
            continue;
          }
          if (res.status === 400 && Number(j.code) === 3020) {
            // a repeat: Revolut already has this payment — find it, never make a second one
            const t = await s.byRequestId(requestId, new Date(ctx.now().getTime() - 13.9 * DAY_MS));
            if (!t) throw new ProviderError('Revolut says this payment was already sent but does not show it yet. Linear Hub checks again later.');
            results.push(resultFor(item, t.id, t.state, t.reason_code));
            continue;
          }
          if (isTransient(res.status)) throw s.transient(res);
          results.push({ itemId: item.id, status: 'failed', failureReason: `Revolut refused this payment: ${s.failText(res, [item.accountNumber, item.sortCode])}.` });
        } catch (err) {
          // no answer for this one: it (and the rest) stay queued and go again later with the same request_id
          if (err instanceof ProviderError && isTransient(err.status)) return { items: results, error: err.message };
          throw err;
        }
      }
      return { items: results };
    },

    async refresh(conn, items, ctx): Promise<ProviderItemResult[]> {
      if (!items.length) return [];
      const s = session(conn, ctx);
      const out: ProviderItemResult[] = [];
      for (const item of items) {
        if (item.providerRef) {
          const res = await s.call('GET', `/transaction/${encodeURIComponent(item.providerRef)}`);
          if (res.ok) {
            const t = (res.json ?? {}) as { state?: unknown; reason_code?: string };
            out.push(resultFor(item, item.providerRef, t.state, t.reason_code));
          } else if (isTransient(res.status)) throw s.transient(res);
          continue; // 404 and the like: unchanged
        }
        const t = await s.byRequestId(paymentUuid(item.idempotencyKey), new Date(ctx.now().getTime() - 13.9 * DAY_MS));
        if (t) out.push(resultFor(item, t.id, t.state, t.reason_code));
      }
      return out;
    },
  };
  return adapter;
}
