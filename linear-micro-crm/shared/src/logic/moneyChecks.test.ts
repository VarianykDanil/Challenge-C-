import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WeekCampaignPay } from '../types/pay.ts';
import {
  FILE_NOT_PAID_CONFIRMATION,
  FILE_NOT_UPLOADED_CONFIRMATION,
  SELF_BILLING_VAT_STATEMENT,
  amountToPayPence,
  invoiceVatFor,
  isTypedConfirmation,
  officeDaysWorked,
  testPaymentReference,
  unconfirmedPay,
  vatPence,
} from './moneyChecks.ts';

// Mon 12 Oct 2026 … Sun 18 Oct
const MON = '2026-10-12';

test('officeDaysWorked: Mon–Fri, from the start date, to today and the leaving date, less days off', () => {
  const p = { startDate: '2025-01-01' };
  assert.equal(officeDaysWorked(p, MON, '2026-10-20'), 5, 'a full week');
  assert.equal(officeDaysWorked(p, MON, '2026-10-14'), 3, 'the week in progress: to today');
  assert.equal(officeDaysWorked({ startDate: '2026-10-14' }, MON, '2026-10-20'), 3, 'started on Wednesday');
  assert.equal(officeDaysWorked({ ...p, leavingDate: '2026-10-13' }, MON, '2026-10-20'), 2, 'left on Tuesday');
  assert.equal(officeDaysWorked({ ...p, leavingDate: '2026-10-09' }, MON, '2026-10-20'), 0, 'left the week before');
  assert.equal(officeDaysWorked({ ...p, absences: ['2026-10-13', '2026-10-14', '2026-10-14'] }, MON, '2026-10-20'), 3, 'two days off (one listed twice)');
  assert.equal(officeDaysWorked({ ...p, absences: ['2026-10-17', '2026-10-05'] }, MON, '2026-10-20'), 5, 'a weekend day off and a day off in another week change nothing');
  assert.equal(officeDaysWorked({ ...p, leavingDate: '2026-10-13', absences: ['2026-10-15'] }, MON, '2026-10-20'), 2, 'a day off after leaving is not taken twice');
  assert.equal(officeDaysWorked({ ...p, absences: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'] }, MON, '2026-10-20'), 0);
});

test('VAT: the standard rate on the invoice total, in pence, rounded down to the penny', () => {
  assert.equal(vatPence(10000), 2000, '£100.00 → £20.00');
  assert.equal(vatPence(31751), 6350, '£317.51 → £63.502 → £63.50 (down)');
  assert.equal(vatPence(31754), 6350, '£317.54 → £63.508 → £63.50 (down, never up)');
  assert.equal(vatPence(1), 0, '1p → 0.2p → 0p');
  assert.equal(vatPence(4), 0);
  assert.equal(vatPence(5), 1);
  assert.equal(vatPence(0), 0);
  assert.equal(Object.is(vatPence(-4), -0), false, 'never −0');
  assert.equal(vatPence(-31754), -6350, 'a credit rounds towards zero too');
  assert.throws(() => vatPence(1.5), RangeError);
  assert.throws(() => vatPence(100, 20.5), RangeError);
});

test('invoiceVatFor: only for a VAT-registered supplier; net + VAT = what is paid, exactly', () => {
  assert.equal(invoiceVatFor(254, null), null);
  assert.equal(invoiceVatFor(254, ''), null);
  assert.deepEqual(invoiceVatFor(254, 'GB123456789'), { net: 254, ratePercent: 20, vat: 50.8, gross: 304.8 });
  assert.deepEqual(invoiceVatFor(317.51, 'GB123456789'), { net: 317.51, ratePercent: 20, vat: 63.5, gross: 381.01 });
  // floating point: 0.1 + 0.2 pounds of work
  assert.deepEqual(invoiceVatFor(0.1 + 0.2, 'GB123456789'), { net: 0.3, ratePercent: 20, vat: 0.06, gross: 0.36 });
  for (const n of [0.01, 1.15, 63.5, 945.5, 1234.56, 9999.99]) {
    const v = invoiceVatFor(n, 'GB123456789')!;
    assert.equal(Math.round(v.net * 100) + Math.round(v.vat * 100), Math.round(v.gross * 100), `${n}`);
    assert.ok(v.vat <= n * 0.2 + 1e-9, `${n}: never more than 20%`);
  }
  assert.equal(SELF_BILLING_VAT_STATEMENT, 'The VAT shown is your output tax due to HMRC.');
});

test('amountToPayPence: the run, plus the invoice VAT when there is some', () => {
  assert.equal(amountToPayPence(254), 25400);
  assert.equal(amountToPayPence(254, null), 25400);
  assert.equal(amountToPayPence(254, { vatAmount: 50.8 }), 30480);
  assert.equal(amountToPayPence(1.15, { vatAmount: 0.23 }), 138);
});

test('typed confirmations: the exact words, any case, surrounding spaces ignored', () => {
  assert.equal(isTypedConfirmation(' not uploaded ', FILE_NOT_UPLOADED_CONFIRMATION), true);
  assert.equal(isTypedConfirmation('NOT UPLOADED', FILE_NOT_UPLOADED_CONFIRMATION), true);
  assert.equal(isTypedConfirmation('NOTUPLOADED', FILE_NOT_UPLOADED_CONFIRMATION), false);
  assert.equal(isTypedConfirmation(undefined, FILE_NOT_PAID_CONFIRMATION), false);
  assert.equal(isTypedConfirmation('NOT PAID', FILE_NOT_PAID_CONFIRMATION), true);
});

const camp = (over: Partial<WeekCampaignPay>): WeekCampaignPay => ({
  campaignId: 1, code: 'BCN', logged: 10, confirmed: 10, cancelled: 0, statementConfirmed: false, rate: 10, amount: 100, ...over,
});

test('unconfirmedPay: what would not be paid without the subs no statement confirmed', () => {
  // commission £300 (BCN £200 not yet confirmed, CHN £100 confirmed) beats the £254 base: £46 rests on BCN
  const r = unconfirmedPay({
    paidAs: 'commission', baseAmount: 254, basePay: 0, commission: 300, commissionAmount: 300,
    perCampaign: [camp({ code: 'BCN', confirmed: 20, logged: 20, amount: 200 }), camp({ campaignId: 2, code: 'CHN', statementConfirmed: true, amount: 100 })],
  });
  assert.deepEqual(r, { subs: 20, amount: 46, awaiting: ['BCN'], neverConfirmed: [] });
  // paid the base: nothing rests on the subs
  assert.equal(unconfirmedPay({ paidAs: 'base', baseAmount: 254, basePay: 254, commission: 0, commissionAmount: 100, perCampaign: [camp({})] })!.amount, 0);
  // a campaign whose client sends no statements: never confirmed
  const never = unconfirmedPay({ paidAs: 'commission', baseAmount: 63.5, basePay: 0, commission: 150, commissionAmount: 150, perCampaign: [camp({ code: 'VLT', awaitsStatement: false, confirmed: 15, amount: 150 })] })!;
  assert.deepEqual(never, { subs: 15, amount: 86.5, awaiting: [], neverConfirmed: ['VLT'] });
  // everything confirmed: null
  assert.equal(unconfirmedPay({ paidAs: 'commission', baseAmount: 0, basePay: 0, commission: 100, commissionAmount: 100, perCampaign: [camp({ statementConfirmed: true })] }), null);
});

test('testPaymentReference: TEST first, within 18 characters', () => {
  assert.equal(testPaymentReference('LINEAR 05OCT JL'), 'TEST 05OCT JL');
  assert.equal(testPaymentReference('LINEAR'), 'TEST');
  assert.ok(testPaymentReference('LINEAR 05OCT ABCDEFGHIJKLMN').length <= 18);
});
