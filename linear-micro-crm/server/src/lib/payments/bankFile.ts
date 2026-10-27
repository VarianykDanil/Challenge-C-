/**
 * Release 1.4 — OWNED BY P bank payment file: the `bank_file` way to pay (the contract: ./provider.ts).
 *
 * Linear Hub makes the bulk payment file in the format Matt chose when he connected it (connection setting `format`:
 * shared logic/bankFiles.ts BANK_FILE_FORMATS — the general Faster Payments file, Starling Bank, Revolut Business; the
 * source of each layout is recorded there). Nothing is sent anywhere and no money moves from here:
 *
 *  - submit (on approval, after the admin's fresh two-step code): one line per payment the bank would take, in the
 *    chosen format; each of those items answers 'submitted' with the reference written in the file as its
 *    providerRef (to find it on the bank statement). A payment the bank would refuse (a name with no letters a bank
 *    accepts, Revolut's first-and-last-name rule, an amount over the bank's limit, bank details of the wrong shape)
 *    answers 'failed' with the reason and is left out of the file, so its week stays on Runs to pay. No line at all:
 *    no file. lib/payments/batches.ts stores the file encrypted (GET /payments/batches/:id/file downloads it).
 *  - Matt uploads the file in his online banking and approves it there, then marks in Linear Hub who the bank paid
 *    (POST /payments/batches/:id/mark-paid: all, or some — the rest fail with his reason). `refresh` is never called
 *    for a file (batches.ts answers 409 "mark it paid once your bank has paid it").
 *  - submit is idempotent: making the file again from the same items makes the same file, and it moves no money.
 *  - testConnection: there is nothing to connect to; it answers ok with the format it makes.
 *  - In TEST mode (every new connection) the file is marked: its name starts "TEST-" and every
 *    payment reference starts "TEST" (shared testPaymentReference), so neither Matt nor a bank can take it for a real
 *    run. lib/payments/batches.ts never marks a week paid from a test batch.
 *  - TestFile — the "1p test file": one £0.01 payment to an account the admin chooses, with the
 *    reference LINEAR 1P TEST, to upload to the bank before the first real run.
 */
import { BANK_FILE_FORMATS, PENNY_TEST_REFERENCE, bankFileFormat, bankFileName, buildBankFile, paymentProviderInfo, testPaymentReference, type BankFileFormatId, type PaymentConfigField, type PaymentProviderInfo } from '@lm/shared';
import { ProviderConfigError, validateConfigFields, type PaymentProviderAdapter, type ProviderItemResult } from './provider.ts';

/** The connection form: the format, as a list of choices with the bank's logo (Settings → Payments → Connect). */
export const BANK_FILE_CONFIG_FIELDS: readonly PaymentConfigField[] = [
  {
    name: 'format',
    label: 'File format',
    type: 'select',
    required: true,
    options: BANK_FILE_FORMATS.map((f) => ({ value: f.id, label: f.label, iconKey: f.iconKey, hint: f.summary })),
    help: 'The file your bank’s bulk payment upload takes. If your bank is not in the list, use the general file and check its columns with your bank before the first upload.',
  },
];

function formatOf(settings: Readonly<Record<string, string>>): BankFileFormatId {
  const f = bankFileFormat(settings.format);
  if (!f) throw new ProviderConfigError([{ path: 'format', message: 'File format: choose one of the options' }]);
  return f.id;
}

export function createBankFileProvider(): PaymentProviderAdapter {
  const info = paymentProviderInfo('bank_file') as PaymentProviderInfo;
  return {
    info,
    configFields: BANK_FILE_CONFIG_FIELDS,
    ready: true,
    validateConfig(input, existing) {
      const out = validateConfigFields(BANK_FILE_CONFIG_FIELDS, input, existing);
      formatOf(out.settings);
      return { settings: out.settings, secrets: {} };
    },
    async testConnection(conn) {
      const f = bankFileFormat(formatOf(conn.settings))!;
      return {
        ok: true,
        message: `Ready: Linear Hub makes ${f.bank ? `${f.bank} files` : 'general Faster Payments files'}. There is nothing to connect to: you upload each file to your bank and approve it there.`,
        balancePence: null,
      };
    },
    async submit(conn, batch, items) {
      const id = formatOf(conn.settings);
      const test = batch.mode === 'test';
      const out = buildBankFile(id, items.map((i) => ({
        key: i.id, payeeName: i.payeeName, sortCode: i.sortCode, accountNumber: i.accountNumber, amountPence: i.amountPence,
        reference: test ? testPaymentReference(i.reference) : i.reference,
      })));
      const results: ProviderItemResult[] = [
        ...out.included.map((key) => ({ itemId: key, status: 'submitted' as const, providerRef: out.references.get(key) ?? null, failureReason: null })),
        ...out.rejected.map((r) => ({ itemId: r.key, status: 'failed' as const, providerRef: null, failureReason: r.reason })),
      ];
      return {
        items: results,
        providerRef: null,
        file: out.body ? { name: `${test ? 'TEST-' : ''}${bankFileName(id, batch.id, batch.today)}`, contentType: 'text/csv; charset=utf-8', body: out.body } : undefined,
      };
    },
    testFile(conn, payee, today) {
      const id = formatOf(conn.settings);
      const out = buildBankFile(id, [{ key: 1, payeeName: payee.holderName, sortCode: payee.sortCode, accountNumber: payee.accountNumber, amountPence: 1, reference: PENNY_TEST_REFERENCE }]);
      if (!out.body) throw new ProviderConfigError([{ path: 'holderName', message: out.rejected[0]?.reason ?? 'The bank would not take this line' }]);
      const f = bankFileFormat(id)!;
      return { fileName: `linear-hub-1p-test-${/^\d{4}-\d{2}-\d{2}$/.test(today) ? today : 'today'}-${f.fileSuffix}.csv`, contentType: 'text/csv; charset=utf-8', body: out.body };
    },
    // a file is never checked automatically (batches.ts does not call this for kind 'file'): nothing changes
    async refresh() {
      return [];
    },
  };
}
