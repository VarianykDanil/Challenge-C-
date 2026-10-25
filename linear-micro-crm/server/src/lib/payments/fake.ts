/**
 * Release 1.4 — OWNED BY F payments-foundation: a FAKE way to pay, for tests (and, with LM_PAYMENTS_FAKE=1, for trying
 * the screens on a demo database: those are `testOnly`, so they stay in test mode and mark no run paid). It moves no
 * money and talks to nothing. Deterministic and scriptable:
 *
 *   const fake = createFakeProvider({ failFor: (i) => (i.payeeName === 'Bo Rep' ? 'Account closed' : null) });
 *   registerPaymentProvider(fake);          // lib/payments/registry.ts
 *   … approve a batch …
 *   fake.paymentsMade()                     // one per idempotency key, however often an item was resubmitted
 *
 * `kind: 'api'` (default): submit answers each item `submitStatus` ('processing' by default; 'failed' with the reason
 * when `failFor` says so), refresh answers `refreshStatus` ('paid'). `throwSubmit: n` makes the next n submits throw a
 * ProviderError (a timeout) AFTER recording the payments, as a real network failure might — so a test can prove that
 * a resubmit with the same keys pays nobody twice. `kind: 'file'` makes a CSV and answers 'submitted' (a bank file
 * stands in for package P's until it lands). The connection form has one optional field, `label`, and one optional
 * secret, `token`.
 */
import { formatSortCode, type PaymentAbilities, type PaymentProviderKind } from '@lm/shared';
import { ProviderError, validateConfigFields, type ConnectionTestResult, type PaymentProviderAdapter, type ProviderItem, type ProviderItemResult, type ProviderItemStatus } from './provider.ts';

export const FAKE_PROVIDER_ID = 'fake';

export interface FakeProviderOptions {
  id?: string;
  kind?: PaymentProviderKind;
  submitStatus?: ProviderItemStatus;
  refreshStatus?: ProviderItemStatus;
  /** A reason to fail this item with, or null to pay it. */
  failFor?: (item: ProviderItem) => string | null;
  /** The next n submits throw (after recording what they sent). */
  throwSubmit?: number;
  testResult?: ConnectionTestResult;
  /** Supports cancel (answers 'failed' "Stopped before it was paid" for items not yet paid). */
  cancellable?: boolean;
  /**
   * Review fix (cross:X-3): never pays anyone — `info.testOnly`, so its connections stay in test mode (a test bank file
   * too) and cannot be switched to live. The LM_PAYMENTS_FAKE=1 providers (registry.ts demoFakeProviders) set it; the
   * test suite's fake leaves it off, standing in for a real provider that can go live.
   */
  testOnly?: boolean;
}

export interface FakePayment {
  idempotencyKey: string;
  itemId: number;
  amountPence: number;
  payeeName: string;
  sortCode: string;
  accountNumber: string;
  reference: string;
  /** How many times this key was sent. */
  sent: number;
}

export interface FakeProvider extends PaymentProviderAdapter {
  calls: { test: number; submit: number; refresh: number; cancel: number };
  /** Every payment received, one per idempotency key. */
  payments: Map<string, FakePayment>;
  paymentsMade(): number;
  /** Change the script between steps of a test. */
  script(opts: Partial<FakeProviderOptions>): void;
}

const FAKE_ABILITIES: PaymentAbilities = {
  paysFromApp: true,
  confirmsAutomatically: true,
  needsBankApproval: false,
  testMode: true,
  checksBalance: true,
  sameDay: true,
  fees: 'None: the test provider moves no money at all.',
  setup: ['Nothing: it is built in, for trying Linear Hub out'],
  limits: 'For testing only. Nobody is paid.',
};

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  let opts: FakeProviderOptions = { ...options };
  const kind = opts.kind ?? 'api';
  const payments = new Map<string, FakePayment>();
  const calls = { test: 0, submit: 0, refresh: 0, cancel: 0 };
  const fields = [
    { name: 'label', label: 'Label', help: 'Anything: it is only shown here.' },
    { name: 'token', label: 'Test token', secret: true, help: 'Anything: it proves secrets are stored encrypted.' },
  ] as const;
  const paidKeys = new Set<string>();
  const provider: FakeProvider = {
    info: {
      id: opts.id ?? FAKE_PROVIDER_ID,
      name: kind === 'file' ? 'Test bank file' : 'Test provider',
      summary: 'For trying Linear Hub out: it moves no money and pays nobody.',
      kind,
      iconKey: 'test',
      abilities: kind === 'file' ? { ...FAKE_ABILITIES, paysFromApp: false, confirmsAutomatically: false, needsBankApproval: true, checksBalance: false } : FAKE_ABILITIES,
      ...(opts.testOnly ? { testOnly: true } : {}),
    },
    configFields: fields.map((f) => ({ ...f })),
    ready: true,
    calls,
    payments,
    paymentsMade: () => payments.size,
    script(next) {
      opts = { ...opts, ...next };
    },
    validateConfig: (input, existing) => validateConfigFields(provider.configFields, input, existing),
    async testConnection() {
      calls.test++;
      return opts.testResult ?? { ok: true, message: 'Connected to the test provider. Nothing real is paid.', balancePence: 1_000_000 };
    },
    async submit(_conn, batch, items) {
      calls.submit++;
      const results: ProviderItemResult[] = [];
      for (const item of items) {
        const seen = payments.get(item.idempotencyKey);
        if (seen) seen.sent++;
        else {
          payments.set(item.idempotencyKey, {
            idempotencyKey: item.idempotencyKey, itemId: item.id, amountPence: item.amountPence, payeeName: item.payeeName,
            sortCode: item.sortCode, accountNumber: item.accountNumber, reference: item.reference, sent: 1,
          });
        }
        const reason = opts.failFor?.(item) ?? null;
        const status: ProviderItemStatus = reason ? 'failed' : kind === 'file' ? 'submitted' : (opts.submitStatus ?? 'processing');
        if (status === 'paid') paidKeys.add(item.idempotencyKey);
        results.push({ itemId: item.id, status, providerRef: `FAKE-${item.id}`, failureReason: reason });
      }
      if ((opts.throwSubmit ?? 0) > 0) {
        opts.throwSubmit = (opts.throwSubmit ?? 0) - 1;
        throw new ProviderError('The test provider did not answer within 15 seconds');
      }
      const file = kind === 'file'
        ? {
            name: `linear-hub-test-payment-${batch.id}-${batch.today}.csv`,
            contentType: 'text/csv; charset=utf-8',
            body: ['Name,Sort code,Account number,Amount,Reference', ...items.map((i) => `"${i.payeeName.replace(/"/g, '""')}",${formatSortCode(i.sortCode)},${i.accountNumber},${(i.amountPence / 100).toFixed(2)},${i.reference}`)].join('\r\n') + '\r\n',
          }
        : undefined;
      return { items: results, providerRef: `FAKE-BATCH-${batch.id}`, file };
    },
    async refresh(_conn, items) {
      calls.refresh++;
      return items.map((item) => {
        const reason = opts.failFor?.(item) ?? null;
        const status: ProviderItemStatus = reason ? 'failed' : (opts.refreshStatus ?? 'paid');
        if (status === 'paid') paidKeys.add(item.idempotencyKey);
        return { itemId: item.id, status, providerRef: item.providerRef ?? `FAKE-${item.id}`, failureReason: reason };
      });
    },
  };
  if (opts.cancellable) {
    provider.cancel = async (_conn, items) => {
      calls.cancel++;
      return items.map((item) => ({ itemId: item.id, status: paidKeys.has(item.idempotencyKey) ? 'paid' : 'failed', failureReason: paidKeys.has(item.idempotencyKey) ? null : 'Stopped before it was paid' }));
    };
  }
  return provider;
}
