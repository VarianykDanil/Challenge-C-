// Release 1.4 — package F (payments foundation): the pure rules, with hand-computed fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_LIVE_CONFIRMATION, PAYMENT_PROVIDER_IDS } from '../types/payments.ts';
import {
  PAYMENT_BATCH_STATUS_LABELS,
  PAYMENT_ITEM_STATUS_LABELS,
  PAYMENT_PROVIDERS,
  abilityChecklist,
  batchStatusFromItems,
  defaultPaymentReference,
  formatPence,
  formatSortCode,
  isLiveConfirmation,
  isLivePaymentItemStatus,
  maskAccountNumber,
  maskSortCode,
  normaliseAccountNumber,
  normaliseSortCode,
  paymentProviderInfo,
  penceToPounds,
  poundsToPence,
  sumPence,
  validateBankDetails,
} from './payments.ts';

test('pounds to pence: exact for every two-decimal amount, refuses more decimals and non-numbers', () => {
  assert.equal(poundsToPence(945), 94500);
  assert.equal(poundsToPence(945.1), 94510);
  assert.equal(poundsToPence(63.5), 6350);
  assert.equal(poundsToPence(0.07), 7); // 0.07 * 100 = 7.000000000000001
  assert.equal(poundsToPence(1.15), 115); // 1.15 * 100 = 114.99999999999999
  assert.equal(poundsToPence(4.35), 435); // 434.99999999999994
  assert.equal(poundsToPence(1234567.89), 123456789);
  assert.equal(poundsToPence(-20), -2000);
  assert.equal(poundsToPence(0), 0);
  // every pence amount up to £100 round-trips
  for (let p = 0; p <= 10_000; p++) assert.equal(poundsToPence(Number((p / 100).toFixed(2))), p);
  assert.throws(() => poundsToPence(1.005), RangeError);
  assert.throws(() => poundsToPence(Number.NaN), RangeError);
  assert.throws(() => poundsToPence(Number.POSITIVE_INFINITY), RangeError);
  assert.equal(penceToPounds(94510), 945.1);
  assert.equal(penceToPounds(7), 0.07);
  assert.equal(sumPence([94500, 34550, 7]), 129057);
  assert.throws(() => sumPence([1.5]), RangeError);
});

test('money is shown as £1,234.50', () => {
  assert.equal(formatPence(123450), '£1,234.50');
  assert.equal(formatPence(7), '£0.07');
  assert.equal(formatPence(0), '£0.00');
  assert.equal(formatPence(-2000), '−£20.00');
});

test('sort codes and account numbers: normalised, validated, masked', () => {
  assert.equal(normaliseSortCode('12-34-56'), '123456');
  assert.equal(normaliseSortCode(' 12 34 56 '), '123456');
  assert.equal(normaliseSortCode('123456'), '123456');
  assert.equal(normaliseSortCode('12345'), null);
  assert.equal(normaliseSortCode('1234567'), null);
  assert.equal(normaliseSortCode('12-34-5a'), null);
  assert.equal(normaliseSortCode('١٢٣٤٥٦'), null, 'only ASCII digits');
  assert.equal(normaliseAccountNumber('12345678'), '12345678');
  assert.equal(normaliseAccountNumber('1234 5678'), '12345678');
  assert.equal(normaliseAccountNumber('1234567'), null);
  assert.equal(normaliseAccountNumber('123456789'), null);
  assert.equal(normaliseAccountNumber('1234-5678'), '12345678');
  assert.equal(formatSortCode('123456'), '12-34-56');
  assert.equal(maskSortCode('34'), '••-••-34');
  assert.equal(maskAccountNumber('5678'), '••••5678');
});

test('validateBankDetails: plain messages per field, the cleaned values when right', () => {
  const ok = validateBankDetails({ holderName: '  Jordan  Lee ', sortCode: '00-00-00', accountNumber: '0000 0010' });
  assert.deepEqual(ok, { ok: true, value: { holderName: 'Jordan Lee', sortCode: '000000', accountNumber: '00000010' } });
  const bad = validateBankDetails({ holderName: '', sortCode: '12-34', accountNumber: 'abc' });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.deepEqual(bad.errors.map((e) => e.path), ['holderName', 'sortCode', 'accountNumber']);
  assert.match(bad.errors[1]!.message, /6 digits/);
  assert.match(bad.errors[2]!.message, /8 digits/);
  assert.equal(validateBankDetails({ holderName: "Siobhán O'Neill-Smith", sortCode: '000000', accountNumber: '00000000' }).ok, true);
  assert.equal(validateBankDetails({ holderName: 'A <script>', sortCode: '000000', accountNumber: '00000000' }).ok, false);
  assert.equal(validateBankDetails({ holderName: 'x'.repeat(71), sortCode: '000000', accountNumber: '00000000' }).ok, false);
  assert.equal(validateBankDetails({ holderName: 'J', sortCode: '000000', accountNumber: '00000000' }).ok, false);
  // non-strings never throw
  assert.equal(validateBankDetails({ holderName: 5 as unknown as string, sortCode: null as unknown as string, accountNumber: undefined as unknown as string }).ok, false);
});

test('batch status from its items', () => {
  assert.equal(batchStatusFromItems([]), 'cancelled');
  assert.equal(batchStatusFromItems(['queued', 'queued']), 'submitted');
  assert.equal(batchStatusFromItems(['submitted', 'submitted']), 'submitted');
  assert.equal(batchStatusFromItems(['submitted', 'processing']), 'processing');
  assert.equal(batchStatusFromItems(['paid', 'submitted']), 'processing');
  assert.equal(batchStatusFromItems(['failed', 'queued']), 'processing');
  assert.equal(batchStatusFromItems(['paid', 'paid']), 'completed');
  assert.equal(batchStatusFromItems(['paid', 'cancelled']), 'completed');
  assert.equal(batchStatusFromItems(['failed', 'failed']), 'failed');
  assert.equal(batchStatusFromItems(['paid', 'failed']), 'partly_failed');
  assert.equal(batchStatusFromItems(['cancelled', 'cancelled']), 'cancelled');
  assert.equal(isLivePaymentItemStatus('queued'), true);
  assert.equal(isLivePaymentItemStatus('paid'), true, 'a paid item keeps its run out of any other payment');
  assert.equal(isLivePaymentItemStatus('failed'), false);
  assert.equal(isLivePaymentItemStatus('cancelled'), false);
  for (const s of ['draft', 'submitted', 'processing', 'completed', 'partly_failed', 'failed', 'cancelled'] as const) assert.ok(PAYMENT_BATCH_STATUS_LABELS[s]);
  for (const s of ['queued', 'submitted', 'processing', 'paid', 'failed', 'cancelled'] as const) assert.ok(PAYMENT_ITEM_STATUS_LABELS[s]);
});

test('the four ways to pay, each with plain abilities and a logo key', () => {
  assert.deepEqual(PAYMENT_PROVIDERS.map((p) => p.id), [...PAYMENT_PROVIDER_IDS]);
  for (const p of PAYMENT_PROVIDERS) {
    assert.ok(p.name && p.summary && p.iconKey, p.id);
    assert.ok(p.abilities.fees.length > 10, `${p.id} fees`);
    assert.ok(p.abilities.setup.length >= 1, `${p.id} setup`);
    assert.ok(p.abilities.limits.length > 10, `${p.id} limits`);
    // plain words: no ticks or crosses in the copy itself (the page draws them)
    assert.doesNotMatch(JSON.stringify(p), /[✓✗]/);
  }
  const file = paymentProviderInfo('bank_file')!;
  assert.equal(file.kind, 'file');
  assert.equal(file.abilities.paysFromApp, false);
  assert.equal(file.abilities.confirmsAutomatically, false);
  assert.equal(file.abilities.needsBankApproval, true);
  for (const id of ['revolut', 'wise', 'truelayer']) {
    const p = paymentProviderInfo(id)!;
    assert.equal(p.kind, 'api', id);
    assert.equal(p.abilities.testMode, true, `${id} has a sandbox`);
  }
  assert.equal(paymentProviderInfo('nope'), null);
  const lines = abilityChecklist(file.abilities);
  assert.deepEqual(lines.map((l) => l.label), [
    'Pays from Linear Hub',
    'Confirms payment automatically',
    'You approve the payments in your bank',
    'Test mode',
    'Shows your balance',
    'Usually arrives the same day',
  ]);
  assert.equal(lines[0]!.ok, false);
  assert.equal(lines[2]!.ok, true);
});

test('switching to live needs the words typed exactly', () => {
  assert.equal(PAYMENT_LIVE_CONFIRMATION, 'PAY FOR REAL');
  assert.equal(isLiveConfirmation('PAY FOR REAL'), true);
  assert.equal(isLiveConfirmation('  PAY FOR REAL '), true);
  assert.equal(isLiveConfirmation('pay for real'), false);
  assert.equal(isLiveConfirmation('PAY FOR REAL!'), false);
  assert.equal(isLiveConfirmation(undefined), false);
});

test('default payment reference: LINEAR, the week and initials, within 18 characters, bank-safe', () => {
  assert.equal(defaultPaymentReference('2026-10-05', 'Jordan Lee'), 'LINEAR 05OCT JL');
  assert.equal(defaultPaymentReference('2026-12-28', 'Siobhán O\'Neill-Smith'), 'LINEAR 28DEC SO');
  assert.equal(defaultPaymentReference('2026-10-05', 'Prince'), 'LINEAR 05OCT P');
  assert.equal(defaultPaymentReference('2026-10-05', '=cmd'), 'LINEAR 05OCT C');
  for (const r of [defaultPaymentReference('2026-10-05', 'Áine Ní Bhriain Ó Súilleabháin'), defaultPaymentReference('bad', '')]) {
    assert.ok(r.length <= 18, r);
    assert.match(r, /^[A-Z0-9 ]+$/);
  }
});
