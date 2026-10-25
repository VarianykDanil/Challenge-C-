/**
 * Release 1.4 — OWNED BY F payments-foundation. THE CONTRACT every way to pay implements: the bank payment file
 * (package P, `bank_file`), Revolut Business, Wise Business and TrueLayer payouts (package A). F ships the interface,
 * the registry (./registry.ts), a stub for each of the four (./stubs.ts: info, abilities and form fields, `ready: false`)
 * and a fake provider for tests (./fake.ts). P and A replace a stub with their adapter in ./registry.ts and change
 * nothing else in this folder's contract.
 *
 * ─── What Linear Hub does around an adapter (lib/payments/batches.ts; adapters never touch the database) ───
 *  - Connections: POST /payments/connections calls `validateConfig` with the form's settings and secrets (driven by
 *    `configFields`) and stores what it returns: settings as JSON, secrets as ONE encrypted JSON blob
 *    (lib/crypto.ts encrypt; never returned by any API, never in the audit trail, never logged). A connection always
 *    starts in mode 'test'. Status: `kind: 'file'` adapters start 'connected'; API adapters start 'not_connected' and
 *    become 'connected' after a `testConnection` that answers ok (and 'error' when it does not).
 *    Switching to 'live' needs the admin to type PAYMENT_LIVE_CONFIRMATION ("PAY FOR REAL").
 *  - A batch is made from unpaid payroll runs (every money amount in WHOLE PENCE). Approving it needs the admin's
 *    fresh two-step code; then `submit` is called ONCE with every queued item. Each item carries its own
 *    `idempotencyKey` (`<batch key>:<item id>`): send it as the provider's idempotency key / request id so that a
 *    resubmit of the same item NEVER pays twice. Linear Hub resubmits queued items (Try again, or the next job tick)
 *    only after a submit that threw — so `submit` MUST be idempotent per item key. An adapter whose provider has no
 *    idempotency key must not retry a POST that moves money, and must answer 'processing' (not throw) when it cannot
 *    tell whether a payment went.
 *  - `refresh` is called for items 'submitted' or 'processing' (POST /payments/batches/:id/refresh, and every 5 minutes
 *    while anything is processing, unless LM_PAYMENTS_JOB=0). An item answered 'paid' marks its payroll run paid through
 *    the same path as POST /finance/payroll/:id/pay (lib/markPaid.ts), once; 'failed' leaves the run unpaid on Runs to
 *    pay with the reason.
 *  - A bank file (`kind: 'file'`): `submit` returns `file` and items 'submitted'; the admin downloads it (GET
 *    /payments/batches/:id/file; stored encrypted), uploads it to the bank, and marks the batch paid (POST
 *    …/mark-paid); `refresh` is never called for it.
 *
 * ─── Rules for adapters ───
 *  - Network: only through ./http.ts `providerFetch` (15 s timeout, no retry of a POST unless you pass the idempotency
 *    key, secrets redacted from every error). No test ever calls the real internet: point `baseUrl` at a local fake.
 *  - Errors: throw `ProviderError(message)` with plain words for the admin ("Revolut refused the access token: connect
 *    again in Settings → Payments"); never put a secret, a token or a full account number in a message.
 *  - Per item, `failureReason` is plain words the admin can act on ("The account number does not exist at that bank").
 *  - Amounts are whole pence; currency GBP; payee = holder name + sort code + account number (UK Faster Payments).
 *  - Record each provider's documentation URL in a comment next to the request it documents.
 */
import type { PaymentConfigField, PaymentMode, PaymentProviderInfo } from '@lm/shared';

/** A connection as an adapter sees it: secrets decrypted, only for the length of one call. */
export interface ProviderConnection {
  id: number;
  provider: string;
  name: string;
  mode: PaymentMode;
  settings: Readonly<Record<string, string>>;
  secrets: Readonly<Record<string, string>>;
}

export interface ProviderBatch {
  id: number;
  mode: PaymentMode;
  /** Random and unique per batch; each item's own key is `<idempotencyKey>:<item id>`. */
  idempotencyKey: string;
  createdAt: string;
  /** e.g. "2026-10-23" (business date): for a file name or a batch reference. */
  today: string;
  /**
   * Package A: when the admin approved it (real clock; null for a draft). An adapter whose provider only spots a
   * repeated idempotency key for a limited time (Revolut: 2 weeks; TrueLayer: 6 hours) uses it to never send a payment
   * again blind. Review fix: batches.ts hands both times over on the real clock even while LM_BUSINESS_NOW is set.
   */
  approvedAt?: string | null;
}

/** One payment to make, with the payee's full details (decrypted for this call only). */
export interface ProviderItem {
  id: number;
  payrollRunId: number;
  userId: number;
  amountPence: number;
  currency: 'GBP';
  payeeName: string;
  /** 6 digits, no dashes. */
  sortCode: string;
  /** 8 digits. */
  accountNumber: string;
  /** "LINEAR 05OCT JL" (shared defaultPaymentReference; a bank format may make its own within its limit). */
  reference: string;
  /** The Monday of the pay week. */
  weekStart: string;
  /** `<batch idempotency key>:<item id>`: the provider's idempotency key / request id for this payment. */
  idempotencyKey: string;
  /** The provider's id from an earlier submit (null the first time). */
  providerRef: string | null;
}

export type ProviderItemStatus = 'submitted' | 'processing' | 'paid' | 'failed';

export interface ProviderItemResult {
  itemId: number;
  status: ProviderItemStatus;
  providerRef?: string | null;
  failureReason?: string | null;
}

export interface ProviderFile {
  /** e.g. "linear-hub-payment-12-2026-10-23.csv" (letters, digits, dots and dashes). */
  name: string;
  contentType: string;
  body: string;
}

export interface SubmitResult {
  /** One per item sent (missing items stay queued and are sent again later with the same keys). */
  items: ProviderItemResult[];
  /** The provider's id for the whole batch, when it has one. */
  providerRef?: string | null;
  /** Bank file adapters: the file to download. */
  file?: ProviderFile;
  /**
   * Package A: plain words for why some items were not sent this time (e.g. "Revolut did not answer within 15
   * seconds"). Those items are left out of `items`, stay queued and are sent again later with the same keys; the
   * batch shows this as its last error.
   */
  error?: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Plain words: "Connected to your Revolut Business sandbox." */
  message: string;
  /** The balance the payments come from, when the provider shows it. */
  balancePence?: number | null;
}

/** What validateConfig receives and returns: the form's values, trimmed. */
export interface ProviderConfig {
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

/** Linear Hub's clock and the place adapters may write their own diagnostics (never secrets). */
export interface ProviderContext {
  /** The business date (YYYY-MM-DD). */
  today: string;
  /** Real clock, for tokens and timeouts. */
  now(): Date;
  /** Test hook: a local fake server instead of the provider's base URL. */
  baseUrl?: string;
  /**
   * Package A: keeps secrets the provider handed back during a call (Revolut's refresh token), merged into the
   * connection's ONE encrypted secrets blob; a null or empty value removes that secret (a used authorisation code).
   * Linear Hub provides it for every call on a stored connection (lib/payments/connections.ts providerContext).
   */
  saveSecrets?(patch: Record<string, string | null>): void;
}

export interface PaymentProviderAdapter {
  /** Name, kind, abilities and logo key (the shared PAYMENT_PROVIDERS entry, corrected by the adapter's package). */
  info: PaymentProviderInfo;
  /** The connection form, in order. Secrets are stored encrypted and never shown again. */
  configFields: readonly PaymentConfigField[];
  /**
   * false: the adapter is not built in this version — connections can be saved, but testing and paying answer 501
   * with a plain sentence (NOT_READY_MESSAGE in ./registry.ts).
   */
  ready: boolean;
  /**
   * Checks and cleans the form's values. `existing` holds what is stored (an edit may leave a secret empty to keep
   * it). Throw `ProviderConfigError` with one message per field; return what to store.
   */
  validateConfig(input: ProviderConfig, existing?: ProviderConfig): ProviderConfig;
  /** Proves the details work (in the connection's mode) without moving money. */
  testConnection(conn: ProviderConnection, ctx: ProviderContext): Promise<ConnectionTestResult>;
  /** Sends every item (see the header: idempotent per item key). */
  submit(conn: ProviderConnection, batch: ProviderBatch, items: readonly ProviderItem[], ctx: ProviderContext): Promise<SubmitResult>;
  /** The latest status of items already sent. Items left out are unchanged. */
  refresh(conn: ProviderConnection, items: readonly ProviderItem[], ctx: ProviderContext): Promise<ProviderItemResult[]>;
  /** Optional: stops items not yet paid (answered 'failed' with a reason when stopped). */
  cancel?(conn: ProviderConnection, items: readonly ProviderItem[], ctx: ProviderContext): Promise<ProviderItemResult[]>;
}

/** A plain-words failure talking to a provider (the batch keeps it as last_error; secrets are redacted before). */
export class ProviderError extends Error {
  /** The provider's HTTP status, when there was one. */
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** A wrong connection form: one plain message per field (answered as 400 with `details`). */
export class ProviderConfigError extends Error {
  readonly fields: { path: string; message: string }[];
  constructor(fields: { path: string; message: string }[]) {
    super(fields[0]?.message ?? 'Check the connection details');
    this.name = 'ProviderConfigError';
    this.fields = fields;
  }
}

/**
 * The default validateConfig: every `required` field present, every value a string no longer than its maxLength
 * (200, or 8000 for a textarea), select values from their options, unknown keys dropped. Secrets left empty keep the
 * stored value.
 */
export function validateConfigFields(fields: readonly PaymentConfigField[], input: ProviderConfig, existing?: ProviderConfig): ProviderConfig {
  const errors: { path: string; message: string }[] = [];
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of fields) {
    const source = f.secret ? input.secrets : input.settings;
    const raw = source?.[f.name];
    const kept = f.secret ? existing?.secrets?.[f.name] : existing?.settings?.[f.name];
    if (raw !== undefined && typeof raw !== 'string') {
      errors.push({ path: f.name, message: `${f.label}: type it as text` });
      continue;
    }
    const value = (raw ?? '').trim();
    const max = f.maxLength ?? (f.type === 'textarea' ? 8000 : 200);
    if (value.length > max) {
      errors.push({ path: f.name, message: `${f.label} is too long (at most ${max} characters)` });
      continue;
    }
    if (f.type === 'select' && value && !(f.options ?? []).some((o) => o.value === value)) {
      errors.push({ path: f.name, message: `${f.label}: choose one of the options` });
      continue;
    }
    const final = value || (f.secret ? kept : raw === undefined ? kept : '') || '';
    if (f.required && !final) {
      errors.push({ path: f.name, message: `${f.label} is needed` });
      continue;
    }
    if (final) (f.secret ? secrets : settings)[f.name] = final;
  }
  if (errors.length) throw new ProviderConfigError(errors);
  return { settings, secrets };
}
