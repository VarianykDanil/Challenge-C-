/**
 * Release 1.4 — OWNED BY A api-providers: Wise Business through a personal API token (contract: ./provider.ts).
 *
 * What Wise's documentation says (checked 23 Oct 2026), and what Linear Hub does with it:
 *  - Personal tokens, https://docs.wise.com/guides/developer/auth-and-security/personal-api-token and
 *    https://docs.wise.com/api-docs/features/authentication-access/personal-tokens : made in Wise (Your account →
 *    Connect and manage apps → API tokens, with Wise's own two-step check). For UK and EEA profiles, because of PSD2,
 *    a personal token CANNOT FUND transfers (nor read balance statements). The small-business payouts guide,
 *    https://docs.wise.com/guides/product/send-money/use-cases/payouts-smbs , lists what it can do: create quotes,
 *    create recipients, create transfers and track them; and warns that with payment approvals switched on, creating
 *    a transfer fails with "Quote cannot be accepted with this request due to missing approval."
 *    So Linear Hub CREATES the transfers and Matt PAYS (funds) them himself in Wise; Linear Hub never calls the funding
 *    endpoint, and marks a run paid only once Wise says it has sent the money.
 *  - Hosts: production https://api.wise.com; sandbox https://api.wise-sandbox.com (Wise's sandbox V2 —
 *    https://docs.wise.com/guides/developer/environments/sandbox-v2-migration — the old api.sandbox.transferwise.tech
 *    was deprecated on 30 June 2026). Wise added dated global versions (/2026Q3, /2026Q4) in 2026; its changelog
 *    (https://docs.wise.com/changelog) says they are opt-in and the endpoint-based versions used here remain available.
 *  - GET /v2/profiles (the business profile), POST /v1/accounts (a GBP `sort_code` recipient: accountHolderName,
 *    details {legalType PRIVATE, sortCode, accountNumber}), https://docs.wise.com/api-reference/recipient/recipientcreate
 *  - POST /v3/profiles/{profileId}/quotes (GBP → GBP, targetAmount, targetAccount),
 *    https://docs.wise.com/guides/product/send-money/quotes/authenticated-quote
 *  - POST /v1/transfers {targetAccount, quoteUuid, customerTransactionId, details {reference}},
 *    https://docs.wise.com/api-reference/transfer/transfercreate — customerTransactionId (a UUID) is the idempotency
 *    key: "If the initial call fails with an error or timeout, retry with the same customerTransactionId value."
 *  - GET /v1/transfers/{id} (status: incoming_payment_waiting → processing → funds_converted → outgoing_payment_sent;
 *    or cancelled, funds_refunded, bounced_back, charged_back) and PUT /v1/transfers/{id}/cancel (before it is paid),
 *    https://docs.wise.com/api-reference/transfer
 */
import { paymentProviderInfo, type PaymentConfigField, type PaymentProviderInfo } from '@lm/shared';
import { bodyMessage, guardTestNetwork, isTransient, paymentUuid, penceToDecimal, withoutValues } from './apiCommon.ts';
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

export const WISE_LIVE_URL = 'https://api.wise.com';
export const WISE_SANDBOX_URL = 'https://api.wise-sandbox.com';

export const MSG_BAD_TOKEN = 'Wise did not accept the API token. Make a new one in Wise (Your account → Connect and manage apps → API tokens) and save it here. In test mode, use a token from your Wise sandbox account.';
const MSG_APPROVALS = 'Wise refused it because your Wise Business has payment approvals switched on, and Wise does not let an API token get past them. Turn approvals off in Wise for these payments, or pay this week another way.';

export const WISE_FIELDS: readonly PaymentConfigField[] = [
  {
    name: 'apiToken',
    label: 'API token',
    secret: true,
    required: true,
    help: 'In Wise on a computer: Your account → Connect and manage apps → API tokens → Add new token (Wise asks for its own code). Give it full access so Linear Hub can create transfers. Test mode needs a token from your Wise sandbox account. Linear Hub stores it encrypted and never shows it again.',
  },
  {
    name: 'profileId',
    label: 'Business profile ID',
    placeholder: 'Leave empty to use your business profile',
    help: 'Leave it empty and Linear Hub uses the business profile the token belongs to. Only if you have more than one business, type the number of the one to pay from.',
  },
];

export interface WiseOptions {
  /** Test hook: a local fake instead of Wise (both modes). */
  baseUrl?: string;
  timeoutMs?: number;
}

interface WiseProfile {
  id: number;
  type?: string;
  businessName?: string;
  fullName?: string;
  details?: { name?: string };
}

const infoFor = (): PaymentProviderInfo => paymentProviderInfo('wise') as PaymentProviderInfo;

/** A Wise transfer status → Linear Hub's. */
export function fromWiseStatus(status: unknown): Pick<ProviderItemResult, 'status' | 'failureReason'> {
  switch (status) {
    case 'outgoing_payment_sent':
      return { status: 'paid', failureReason: null };
    case 'cancelled':
      return { status: 'failed', failureReason: 'This transfer was cancelled in Wise before it was paid (it was not funded in Wise in time, or someone cancelled it there). The week is back on Runs to pay.' };
    case 'funds_refunded':
      return { status: 'failed', failureReason: 'Wise refunded it: the money went back to your Wise account. Check the person’s bank details, then pay this week again.' };
    case 'charged_back':
      return { status: 'failed', failureReason: 'Wise reversed it (charged back). Check it in Wise before paying this week again.' };
    default:
      // incoming_payment_waiting (waiting for you to pay it in Wise), processing, funds_converted, bounced_back (may
      // still be delivered), waiting_recipient_input_to_proceed, unknown: still on its way
      return { status: 'processing', failureReason: null };
  }
}

const profileName = (p: WiseProfile) => p.businessName ?? p.details?.name ?? p.fullName ?? `profile ${p.id}`;

export function createWiseProvider(opts: WiseOptions = {}): PaymentProviderAdapter {
  const fields = WISE_FIELDS;

  function session(conn: ProviderConnection, ctx: ProviderContext) {
    const base = (ctx.baseUrl ?? opts.baseUrl ?? (conn.mode === 'live' ? WISE_LIVE_URL : WISE_SANDBOX_URL)).replace(/\/+$/, '');
    const token = conn.secrets.apiToken ?? '';

    async function call(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<ProviderResponse> {
      const url = `${base}${path}`;
      guardTestNetwork(url, 'Wise');
      if (!token) throw new ProviderError(MSG_BAD_TOKEN);
      const res = await providerFetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, { provider: 'Wise', secrets: [token], timeoutMs: opts.timeoutMs, idempotencyKey });
      if (res.status === 401) throw new ProviderError(MSG_BAD_TOKEN, 401);
      return res;
    }

    const transient = (res: ProviderResponse) => new ProviderError(`Wise is not answering properly (answered ${res.status}). Linear Hub tries again later.`, res.status);
    const text = (res: ProviderResponse, hide: readonly string[] = []) => withoutValues(bodyMessage(res.json) ?? `answered ${res.status}`, hide);

    async function profile(): Promise<WiseProfile> {
      const res = await call('GET', '/v2/profiles');
      if (!res.ok) {
        if (isTransient(res.status)) throw transient(res);
        throw new ProviderError(`Wise did not show your profiles: ${text(res)}`, res.status);
      }
      const list = (Array.isArray(res.json) ? res.json : []) as WiseProfile[];
      const wanted = conn.settings.profileId?.trim();
      if (wanted) {
        const p = list.find((x) => String(x.id) === wanted);
        if (!p) throw new ProviderError(`Wise has no business profile ${wanted} for this token. Check the Business profile ID, or leave it empty.`);
        return p;
      }
      const business = list.filter((x) => String(x.type ?? '').toUpperCase() === 'BUSINESS');
      if (business.length === 1) return business[0];
      if (!business.length) throw new ProviderError('This Wise token has no business profile. Make the token while signed in to your Wise Business account.');
      throw new ProviderError(`This Wise token has more than one business profile: ${business.map((p) => `“${profileName(p)}” (${p.id})`).join(', ')}. Type the one to pay from in “Business profile ID”.`.slice(0, 500));
    }

    async function transfer(id: string): Promise<{ status: unknown } | null> {
      const res = await call('GET', `/v1/transfers/${encodeURIComponent(id)}`);
      if (res.ok) return (res.json ?? {}) as { status: unknown };
      if (isTransient(res.status)) throw transient(res);
      return null;
    }

    return { call, transient, text, profile, transfer };
  }

  return {
    info: infoFor(),
    configFields: fields,
    ready: true,

    validateConfig(input: ProviderConfig, existing?: ProviderConfig): ProviderConfig {
      const out = validateConfigFields(fields, input, existing);
      if (out.settings.profileId && !/^\d{1,15}$/.test(out.settings.profileId)) {
        throw new ProviderConfigError([{ path: 'profileId', message: 'Business profile ID: digits only (or leave it empty)' }]);
      }
      return out;
    },

    async testConnection(conn, ctx): Promise<ConnectionTestResult> {
      try {
        const p = await session(conn, ctx).profile();
        const where = conn.mode === 'live' ? 'Wise Business (live: real money)' : 'Wise sandbox (test money)';
        return { ok: true, message: `Connected to your ${where}: business profile “${profileName(p)}” (${p.id}). Linear Hub creates the transfers; you fund them in Wise (transfers you do not fund go back to Runs to pay).`, balancePence: null };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, message: err.message };
        throw err;
      }
    },

    async submit(conn, _batch, items, ctx): Promise<SubmitResult> {
      const s = session(conn, ctx);
      const results: ProviderItemResult[] = [];
      let profileId: number | null = null;
      for (const item of items) {
        const hide = [item.accountNumber, item.sortCode];
        try {
          profileId ??= (await s.profile()).id;
          // 1. the recipient (a UK sort code account)
          const rec = await s.call('POST', '/v1/accounts', {
            currency: 'GBP', type: 'sort_code', profile: profileId, accountHolderName: item.payeeName,
            details: { legalType: 'PRIVATE', sortCode: item.sortCode, accountNumber: item.accountNumber },
          });
          if (!rec.ok) {
            if (isTransient(rec.status)) throw s.transient(rec);
            results.push({ itemId: item.id, status: 'failed', failureReason: `Wise would not add this account: ${s.text(rec, hide)} Check the person’s bank details, then pay this week again.` });
            continue;
          }
          const recipientId = (rec.json as { id?: unknown } | null)?.id;
          if (typeof recipientId !== 'number') throw new ProviderError('Wise added the person but did not answer as expected. Linear Hub tries again later.');
          // 2. the quote: GBP to GBP, the amount the person receives
          const quote = await s.call('POST', `/v3/profiles/${profileId}/quotes`, { sourceCurrency: 'GBP', targetCurrency: 'GBP', targetAmount: penceToDecimal(item.amountPence), targetAccount: recipientId });
          if (!quote.ok) {
            if (isTransient(quote.status)) throw s.transient(quote);
            results.push({ itemId: item.id, status: 'failed', failureReason: `Wise could not price this transfer: ${s.text(quote, hide)}` });
            continue;
          }
          const quoteUuid = (quote.json as { id?: unknown } | null)?.id;
          if (typeof quoteUuid !== 'string') throw new ProviderError('Wise made the quote but did not answer as expected. Linear Hub tries again later.');
          // 3. the transfer — one per customerTransactionId, however often it is sent
          const ctid = paymentUuid(item.idempotencyKey);
          const t = await s.call('POST', '/v1/transfers', { targetAccount: recipientId, quoteUuid, customerTransactionId: ctid, details: { reference: item.reference } }, ctid);
          if (!t.ok) {
            if (isTransient(t.status)) throw s.transient(t);
            const said = s.text(t, hide);
            results.push({ itemId: item.id, status: 'failed', failureReason: /missing approval/i.test(said) ? MSG_APPROVALS : `Wise refused this transfer: ${said}` });
            continue;
          }
          const j = (t.json ?? {}) as { id?: unknown; status?: unknown };
          if (typeof j.id !== 'number' && typeof j.id !== 'string') throw new ProviderError('Wise made the transfer but did not answer as expected. Linear Hub checks again later.');
          results.push({ itemId: item.id, providerRef: String(j.id), ...fromWiseStatus(j.status) });
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
        const t = await s.transfer(item.providerRef);
        if (t) out.push({ itemId: item.id, providerRef: item.providerRef, ...fromWiseStatus(t.status) });
      }
      return out;
    },

    async cancel(conn, items, ctx): Promise<ProviderItemResult[]> {
      const s = session(conn, ctx);
      const out: ProviderItemResult[] = [];
      for (const item of items) {
        if (!item.providerRef) continue;
        const res = await s.call('PUT', `/v1/transfers/${encodeURIComponent(item.providerRef)}/cancel`);
        if (res.ok) {
          const status = (res.json as { status?: unknown } | null)?.status;
          out.push(status === 'cancelled' || status === undefined
            ? { itemId: item.id, providerRef: item.providerRef, status: 'failed', failureReason: 'Stopped before it was paid: cancelled in Wise from Linear Hub.' }
            : { itemId: item.id, providerRef: item.providerRef, ...fromWiseStatus(status) });
          continue;
        }
        if (isTransient(res.status)) throw s.transient(res);
        // Wise would not cancel it (already being paid): say where it is now
        const t = await s.transfer(item.providerRef);
        if (t) out.push({ itemId: item.id, providerRef: item.providerRef, ...fromWiseStatus(t.status) });
      }
      return out;
    },
  };
}
