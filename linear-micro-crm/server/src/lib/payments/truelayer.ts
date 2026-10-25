/**
 * Release 1.4 — OWNED BY A api-providers: Open Banking payouts through TrueLayer (Payments API v3; contract:
 * ./provider.ts). Payouts leave Matt's TrueLayer GBP merchant account (which he tops up from his business bank) for
 * each person's UK account ("open-loop" payouts to an external account).
 *
 * Documentation this follows (checked 23 Oct 2026):
 *  - Hosts and paths, from TrueLayer's own PHP library
 *    (https://github.com/TrueLayer/truelayer-php/blob/main/src/Constants/Endpoints.php): auth https://auth.truelayer.com
 *    and https://auth.truelayer-sandbox.com, API https://api.truelayer.com and https://api.truelayer-sandbox.com;
 *    POST /connect/token, GET /v3/merchant-accounts, POST /v3/payouts, GET /v3/payouts/{id}.
 *  - Access token: client credentials with the `payments` scope (grant_type client_credentials, client_id,
 *    client_secret, scope; JSON, as TrueLayer's library sends it), https://docs.truelayer.com/docs/generate-a-payments-access-token
 *  - Request signing v2, https://github.com/TrueLayer/truelayer-signing/blob/main/request-signing-v2.md : a
 *    `Tl-Signature` header, a JWS with detached content signed ES512 with an EC P-521 key whose public half Matt uploads
 *    in the Console (Payments → Settings); JOSE header {alg ES512, kid, tl_version "2", tl_headers "Idempotency-Key"};
 *    the payload is "POST /v3/payouts\n" + "Idempotency-Key: <key>\n" + the body. TrueLayer's sandbox checks a
 *    signature at POST /test-signature (its signing examples) — the connection test uses it in test mode.
 *  - Idempotency: an `Idempotency-Key` (a UUID) per payout, https://docs.truelayer.com/docs/sign-your-payments-requests ;
 *    the same key and body answers the first payout; the same key with a different body is 422 "Idempotency-Key
 *    Reuse"; 409 while the first is still being handled. TrueLayer remembers a key for a limited time (6 hours,
 *    https://docs.truelayer.com/docs/idempotency): past TRUELAYER_REPEAT_HOURS a queued payout is failed, not resent.
 *  - The payout, https://docs.truelayer.com/docs/make-a-payout-to-an-external-account : {merchant_account_id,
 *    amount_in_minor, currency GBP, beneficiary {type external_account, account_holder_name, account_identifier
 *    {type sort_code_account_number, sort_code, account_number}, reference}} → 202 {id}.
 *  - Statuses, https://docs.truelayer.com/docs/payout-and-refund-statuses : pending, authorized, executed (the money
 *    has left the merchant account), failed (failure_reason: blocked, insufficient_funds, invalid_iban, invalid_scan,
 *    returned, scheme_error …). A payout can be returned after it was executed
 *    (https://docs.truelayer.com/docs/payout-and-refund-returns): Linear Hub has marked it paid by then — see OWNER NOTES.
 *  - Date of birth and address of the person are optional in the API but TrueLayer asks for them from non-regulated
 *    businesses for sanctions screening (https://docs.truelayer.com/docs/payments-v3-apis-requirements). Linear Hub
 *    1.4 does not send them; if TrueLayer refuses payouts without them, it says so in the payout's reason.
 * Not used: webhooks (Linear Hub checks every 5 minutes), payouts to the business's own account, refunds.
 */
import { createHash, randomUUID } from 'node:crypto';
import { formatPence, paymentProviderInfo, type PaymentConfigField, type PaymentProviderInfo } from '@lm/shared';
import { guardTestNetwork, isTransient, paymentUuid, readPrivateKey, signDetachedJws, withoutValues } from './apiCommon.ts';
import { providerFetch, type ProviderResponse } from './http.ts';
import {
  ProviderConfigError,
  ProviderError,
  validateConfigFields,
  type ConnectionTestResult,
  type PaymentProviderAdapter,
  type ProviderConfig,
  type ProviderConnection,
  type ProviderContext,
  type ProviderItem,
  type ProviderItemResult,
  type SubmitResult,
} from './provider.ts';

export const TRUELAYER_URLS = {
  test: { auth: 'https://auth.truelayer-sandbox.com', api: 'https://api.truelayer-sandbox.com' },
  live: { auth: 'https://auth.truelayer.com', api: 'https://api.truelayer.com' },
} as const;

const TOKEN_SKEW_MS = 60_000;
/**
 * Release 1.4 (review fix cross:X-1): TrueLayer recognises a repeated Idempotency-Key only for a limited time — 6 hours
 * on its general idempotency page (https://docs.truelayer.com/docs/idempotency), 30 days on its Payments v3 page
 * (https://docs.truelayer.com/docs/idempotency-for-payment-requests). Linear Hub keeps to the shorter one with an hour
 * to spare: a payout approved longer ago than this is never sent again blind (there is no lookup by key for payouts),
 * it fails with a reason that says to check the TrueLayer Console first. OWNER_NOTES_1.4.md asks Matt to confirm the
 * window with TrueLayer.
 */
export const TRUELAYER_REPEAT_HOURS = 5;
const HOUR_MS = 3_600_000;
export const MSG_TOO_OLD = `Not sent: this payout was approved more than ${TRUELAYER_REPEAT_HOURS} hours ago and TrueLayer only recognises a repeated payout for 6 hours, so Linear Hub will not send it again. Check the payouts in the TrueLayer Console, then pay this week again if it was not paid.`;
export const MSG_BAD_CLIENT = 'TrueLayer did not accept the client ID or client secret. Copy them again from the TrueLayer Console (the sandbox ones in test mode, the live ones when live).';
export const MSG_BAD_SIGNATURE = 'TrueLayer did not accept the signature. Check that the Signing key ID is the one the Console shows next to the public key you uploaded (Payments → Settings), and that the private key here is the one that goes with it.';
const MSG_SCOPE = 'TrueLayer does not allow payments for this app yet (the “payments” scope). Ask TrueLayer to switch on payouts for your account.';

export const TRUELAYER_FIELDS: readonly PaymentConfigField[] = [
  { name: 'clientId', label: 'Client ID', required: true, help: 'In the TrueLayer Console (console.truelayer.com), in your app’s settings. Test mode uses the sandbox app’s client ID; live uses the live one.' },
  {
    name: 'clientSecret',
    label: 'Client secret',
    secret: true,
    required: true,
    help: 'Shown once in the TrueLayer Console when you make it (you can make a new one there). Linear Hub stores it encrypted and never shows it again.',
  },
  {
    name: 'signingKeyId',
    label: 'Signing key ID',
    required: true,
    help: 'Make a signing key on a computer: openssl ecparam -genkey -name secp521r1 -noout -out ec512-private-key.pem, then openssl ec -in ec512-private-key.pem -pubout -out ec512-public-key.pem. Upload ec512-public-key.pem in the Console (Payments → Settings) and copy the key ID it shows next to it.',
  },
  {
    name: 'privateKey',
    label: 'Signing private key',
    secret: true,
    required: true,
    type: 'textarea',
    placeholder: '-----BEGIN EC PRIVATE KEY-----',
    help: 'The contents of ec512-private-key.pem, the private half of that key. Stored encrypted, never shown again, and never sent to TrueLayer: Linear Hub signs each payout with it.',
  },
  {
    name: 'merchantAccountId',
    label: 'Merchant account ID',
    help: 'Leave it empty when you have one GBP merchant account. With more than one, the test lists them: paste the ID of the one to pay from.',
  },
];

export interface TrueLayerOptions {
  /** Test hook: one local fake for both the auth and the API host (both modes). */
  baseUrl?: string;
  timeoutMs?: number;
}

interface MerchantAccount {
  id: string;
  currency?: string;
  available_balance_in_minor?: number;
  account_holder_name?: string;
}

const infoFor = (): PaymentProviderInfo => paymentProviderInfo('truelayer') as PaymentProviderInfo;

const FAILURE_WORDS: Record<string, string> = {
  insufficient_funds: 'Not enough money in your TrueLayer merchant account: top it up from your bank, then pay this week again.',
  blocked: 'TrueLayer blocked this payout in its checks. Ask TrueLayer why before paying this week again.',
  invalid_scan: 'The receiving bank did not accept the sort code and account number. Check the person’s bank details, then pay this week again.',
  invalid_iban: 'The receiving bank did not accept the account details. Check the person’s bank details, then pay this week again.',
  returned: 'The receiving bank sent the money back. Check the person’s bank details, then pay this week again.',
  scheme_error: 'The payment network refused it. Try paying this week again later.',
};

/** A TrueLayer payout status → Linear Hub's. */
export function fromPayoutStatus(status: unknown, reason?: unknown): Pick<ProviderItemResult, 'status' | 'failureReason'> {
  if (status === 'executed') return { status: 'paid', failureReason: null };
  if (status === 'failed') {
    const code = typeof reason === 'string' ? reason : '';
    return { status: 'failed', failureReason: FAILURE_WORDS[code] ?? `TrueLayer did not pay it${code ? ` (${code.replace(/_/g, ' ')})` : ''}. Check it in the TrueLayer Console, then pay this week again.` };
  }
  return { status: 'processing', failureReason: null }; // pending, authorized
}

/** TrueLayer's problem details as plain words (title, detail and the field messages). */
function problemText(res: ProviderResponse): string {
  const j = (res.json ?? {}) as { title?: unknown; detail?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof j.detail === 'string' && j.detail.trim()) parts.push(j.detail.trim());
  else if (typeof j.title === 'string' && j.title.trim()) parts.push(j.title.trim());
  if (j.errors && typeof j.errors === 'object') {
    const msgs = Object.values(j.errors as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((m): m is string => typeof m === 'string');
    if (msgs.length) parts.push(`(${msgs.join('; ')})`);
  }
  return (parts.join(' ') || `answered ${res.status}`).slice(0, 300);
}

export function createTrueLayerProvider(opts: TrueLayerOptions = {}): PaymentProviderAdapter {
  const tokens = new Map<string, { accessToken: string; expiresAt: number }>();
  const fields = TRUELAYER_FIELDS;

  function session(conn: ProviderConnection, ctx: ProviderContext) {
    const hosts = ctx.baseUrl ?? opts.baseUrl
      ? { auth: (ctx.baseUrl ?? opts.baseUrl) as string, api: (ctx.baseUrl ?? opts.baseUrl) as string }
      : TRUELAYER_URLS[conn.mode === 'live' ? 'live' : 'test'];
    const auth = hosts.auth.replace(/\/+$/, '');
    const api = hosts.api.replace(/\/+$/, '');
    const cacheKey = `${conn.id}:${createHash('sha256').update([conn.mode, conn.settings.clientId ?? '', conn.secrets.clientSecret ?? ''].join('\n')).digest('hex')}`;
    const secretValues = () => [...Object.values(conn.secrets), ...[...tokens.values()].map((t) => t.accessToken)];
    const fetchOpts = (idempotencyKey?: string) => ({ provider: 'TrueLayer', secrets: secretValues(), timeoutMs: opts.timeoutMs, idempotencyKey });
    const transient = (res: ProviderResponse) => new ProviderError(`TrueLayer is not answering properly (answered ${res.status}). Linear Hub tries again later.`, res.status);

    async function token(force = false): Promise<string> {
      const now = ctx.now().getTime();
      const cached = tokens.get(cacheKey);
      if (!force && cached && cached.expiresAt - now > TOKEN_SKEW_MS) return cached.accessToken;
      const url = `${auth}/connect/token`;
      guardTestNetwork(url, 'TrueLayer');
      const res = await providerFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: conn.settings.clientId ?? '', client_secret: conn.secrets.clientSecret ?? '', scope: 'payments' }),
      }, fetchOpts());
      const j = (res.json ?? {}) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
      if (!res.ok || typeof j.access_token !== 'string') {
        if (isTransient(res.status) && res.status !== 409) throw transient(res);
        throw new ProviderError(j.error === 'invalid_scope' ? MSG_SCOPE : MSG_BAD_CLIENT, res.status);
      }
      const ttl = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in * 1000 : 3600_000;
      tokens.set(cacheKey, { accessToken: j.access_token, expiresAt: now + ttl });
      return j.access_token;
    }

    /** A request; `sign` adds Idempotency-Key and Tl-Signature (request signing v2). A 401 that is not about the signature gets one new token. */
    async function call(method: string, path: string, body?: string, sign?: { idempotencyKey: string }): Promise<ProviderResponse> {
      const url = `${api}${path}`;
      guardTestNetwork(url, 'TrueLayer');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (sign) {
        const key = readPrivateKey(conn.secrets.privateKey);
        if (!key || !conn.settings.signingKeyId) throw new ProviderError(MSG_BAD_SIGNATURE);
        headers['Idempotency-Key'] = sign.idempotencyKey;
        const payload = `${method.toUpperCase()} ${path}\nIdempotency-Key: ${sign.idempotencyKey}\n${body ?? ''}`;
        headers['Tl-Signature'] = signDetachedJws({ alg: 'ES512', kid: conn.settings.signingKeyId, tl_version: '2', tl_headers: 'Idempotency-Key' }, payload, key);
      }
      const send = async (t: string) => providerFetch(url, { method, headers: { ...headers, Authorization: `Bearer ${t}` }, body }, fetchOpts(sign?.idempotencyKey));
      let res = await send(await token());
      const aboutSignature = (r: ProviderResponse) => /signature/i.test(String((r.json as { title?: unknown } | null)?.title ?? ''));
      if (res.status === 401 && !aboutSignature(res)) res = await send(await token(true));
      if (res.status === 401) throw new ProviderError(aboutSignature(res) ? MSG_BAD_SIGNATURE : MSG_BAD_CLIENT, 401);
      return res;
    }

    async function merchantAccount(): Promise<MerchantAccount> {
      const res = await call('GET', '/v3/merchant-accounts');
      if (!res.ok) {
        if (isTransient(res.status)) throw transient(res);
        throw new ProviderError(`TrueLayer did not list your merchant accounts: ${problemText(res)}`, res.status);
      }
      const items = ((res.json as { items?: unknown } | null)?.items ?? []) as MerchantAccount[];
      const wanted = conn.settings.merchantAccountId?.trim();
      if (wanted) {
        const m = items.find((x) => x.id === wanted);
        if (!m) throw new ProviderError('TrueLayer has no merchant account with that ID. Leave “Merchant account ID” empty, or paste it again from the test.');
        if (m.currency !== 'GBP') throw new ProviderError('That merchant account is not in pounds: choose your GBP merchant account.');
        return m;
      }
      const gbp = items.filter((x) => x.currency === 'GBP');
      if (gbp.length === 1) return gbp[0];
      if (!gbp.length) throw new ProviderError('Your TrueLayer account has no GBP merchant account to pay from. Ask TrueLayer to open one.');
      throw new ProviderError(`Your TrueLayer account has more than one GBP merchant account: ${gbp.map((m) => `“${m.account_holder_name ?? 'Account'}” (${m.id})`).join(', ')}. Paste the ID of the one to pay from in “Merchant account ID”.`.slice(0, 500));
    }

    return { token, call, merchantAccount, transient };
  }

  return {
    info: infoFor(),
    configFields: fields,
    ready: true,

    validateConfig(input: ProviderConfig, existing?: ProviderConfig): ProviderConfig {
      const out = validateConfigFields(fields, input, existing);
      const key = readPrivateKey(out.secrets.privateKey);
      if (!key || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp521r1') {
        throw new ProviderConfigError([{ path: 'privateKey', message: 'Signing private key: TrueLayer needs an EC P-521 key (ES512), the ec512-private-key.pem made with openssl ecparam -genkey -name secp521r1' }]);
      }
      return out;
    },

    async testConnection(conn, ctx): Promise<ConnectionTestResult> {
      try {
        const s = session(conn, ctx);
        await s.token();
        let signing = 'Your signing key is checked with the first payout.';
        if (conn.mode === 'test') {
          // TrueLayer's sandbox checks a signature here and answers 204
          const res = await s.call('POST', '/test-signature', `linear-hub-test-${randomUUID()}`, { idempotencyKey: randomUUID() });
          if (res.status !== 204 && !res.ok) {
            if (isTransient(res.status)) throw s.transient(res);
            throw new ProviderError(MSG_BAD_SIGNATURE, res.status);
          }
          signing = 'Your signing key works.';
        }
        const m = await s.merchantAccount();
        const pence = Number.isSafeInteger(m.available_balance_in_minor) ? (m.available_balance_in_minor as number) : null;
        const where = conn.mode === 'live' ? 'TrueLayer account (live: real money)' : 'TrueLayer sandbox (test money)';
        return {
          ok: true,
          message: `Connected to your ${where}. Payouts come from the GBP merchant account “${m.account_holder_name ?? m.id}”${pence === null ? '' : `, available ${formatPence(pence)}`}. ${signing}`,
          balancePence: pence,
        };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, message: err.message };
        throw err;
      }
    },

    async submit(conn, batch, items, ctx): Promise<SubmitResult> {
      // review fix (cross:X-1): past TrueLayer's idempotency window a resend could be a second payout: never send blind
      const approved = new Date(batch.approvedAt ?? batch.createdAt);
      if (ctx.now().getTime() - approved.getTime() > TRUELAYER_REPEAT_HOURS * HOUR_MS) {
        return { items: items.map((item) => ({ itemId: item.id, status: 'failed' as const, failureReason: MSG_TOO_OLD })) };
      }
      const s = session(conn, ctx);
      const results: ProviderItemResult[] = [];
      let account: MerchantAccount | null = null;
      for (const item of items) {
        try {
          account ??= await s.merchantAccount();
          const key = paymentUuid(item.idempotencyKey);
          // the same body every time for the same item (TrueLayer compares it with the first one sent with this key)
          const body = JSON.stringify({
            merchant_account_id: account.id,
            amount_in_minor: item.amountPence,
            currency: 'GBP',
            beneficiary: {
              type: 'external_account',
              account_holder_name: item.payeeName,
              account_identifier: { type: 'sort_code_account_number', sort_code: item.sortCode, account_number: item.accountNumber },
              reference: item.reference,
            },
          });
          const res = await s.call('POST', '/v3/payouts', body, { idempotencyKey: key });
          const id = (res.json as { id?: unknown } | null)?.id;
          if (res.ok && typeof id === 'string') {
            results.push({ itemId: item.id, providerRef: id, status: 'processing', failureReason: null });
            continue;
          }
          if (res.status === 422 && /idempotency/i.test(problemText(res))) {
            throw new ProviderError('TrueLayer says a payout with this key was already sent with different details. Check the payouts in the TrueLayer Console before paying this week another way.', 409);
          }
          if (isTransient(res.status)) throw s.transient(res);
          results.push({ itemId: item.id, status: 'failed', failureReason: `TrueLayer refused this payout: ${withoutValues(problemText(res), [item.accountNumber, item.sortCode])}` });
        } catch (err) {
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
        if (!item.providerRef) continue;
        const res = await s.call('GET', `/v3/payouts/${encodeURIComponent(item.providerRef)}`);
        if (res.ok) {
          const p = (res.json ?? {}) as { status?: unknown; failure_reason?: unknown };
          out.push({ itemId: item.id, providerRef: item.providerRef, ...fromPayoutStatus(p.status, p.failure_reason) });
        } else if (isTransient(res.status)) throw s.transient(res);
      }
      return out;
    },
  };
}
