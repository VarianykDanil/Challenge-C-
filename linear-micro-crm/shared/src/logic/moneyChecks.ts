/**
 * Pure money rules added after the 1.4 review (no I/O):
 *  - officeDaysWorked: an office person's paid weekdays (start date, leaving date, days off, never the future);
 *  - VAT on a self-billed invoice for a VAT-registered supplier: the standard rate on the invoice total, worked out in
 *    whole pence and rounded down to the penny (HMRC lets an invoice's total VAT be rounded down), with HMRC's wording;
 *  - the typed words that free the weeks of a bank file already downloaded;
 *  - how much of a week's pay rests on subs the rep logged that no client statement has confirmed;
 *  - the reference a TEST bank file carries (never mistaken for a real payment).
 */
import type { PaidAs, WeekCampaignPay } from '../types/pay.ts';
import { addDays, daysBetween, dayOfWeek } from './dates.ts';
import { PAYMENT_REFERENCE_MAX, penceToPounds, poundsToPence } from './payments.ts';

// ───────────────────────────── office staff's days ─────────────────────────────

const isWeekday = (date: string) => {
  const d = dayOfWeek(date);
  return d >= 1 && d <= 5;
};

/**
 * Weekdays an office person is paid for in the Mon–Sun week starting `monday`: Mon–Fri from their start date, up to
 * the earliest of Friday, `today` and their leaving date (their last working day), less the weekdays they were away.
 */
export function officeDaysWorked(p: { startDate: string; leavingDate?: string | null; absences?: readonly string[] }, monday: string, today: string): number {
  const first = p.startDate > monday ? p.startDate : monday;
  let last = addDays(monday, 4);
  if (today < last) last = today;
  if (p.leavingDate && p.leavingDate < last) last = p.leavingDate;
  if (last < first) return 0;
  let n = Math.max(0, Math.min(5, daysBetween(first, last) + 1));
  for (const a of new Set(p.absences ?? [])) if (a >= first && a <= last && isWeekday(a)) n--;
  return Math.max(0, n);
}

// ───────────────────────────── VAT on self-billed invoices ─────────────────────────────

/** The UK standard rate of VAT, in per cent. */
export const VAT_STANDARD_RATE_PERCENT = 20;

/** The sentence HMRC requires on a self-billed invoice that shows VAT. */
export const SELF_BILLING_VAT_STATEMENT = 'The VAT shown is your output tax due to HMRC.';

/** VAT on `netPence` at `ratePercent`, in whole pence, rounded down (towards zero) to the penny. */
export function vatPence(netPence: number, ratePercent: number = VAT_STANDARD_RATE_PERCENT): number {
  if (!Number.isSafeInteger(netPence)) throw new RangeError('Pence must be a whole number');
  if (!Number.isInteger(ratePercent) || ratePercent < 0 || ratePercent > 100) throw new RangeError('The VAT rate must be a whole percentage');
  const v = Math.trunc((netPence * ratePercent) / 100);
  return v === 0 ? 0 : v; // never -0
}

/** An invoice's VAT, in pounds (two decimals), when the supplier is VAT registered. */
export interface InvoiceVat {
  /** The invoice total before VAT (the week's pay). */
  net: number;
  ratePercent: number;
  vat: number;
  /** What is paid: net + VAT. */
  gross: number;
}

/**
 * VAT for an invoice of `netPounds` (the run's gross) to a supplier with `vatNumber`; null when the supplier is not VAT
 * registered (no VAT number), so the invoice and the payment stay as they are.
 */
export function invoiceVatFor(netPounds: number, vatNumber: string | null | undefined, ratePercent: number = VAT_STANDARD_RATE_PERCENT): InvoiceVat | null {
  if (!vatNumber || !vatNumber.trim()) return null;
  const net = poundsToPence(Math.round(netPounds * 100) / 100);
  const vat = vatPence(net, ratePercent);
  return { net: penceToPounds(net), ratePercent, vat: penceToPounds(vat), gross: penceToPounds(net + vat) };
}

/** What is paid for a week: the run's gross, plus VAT when its self-billed invoice charges VAT. */
export function amountToPayPence(runGross: number, invoice?: { vatAmount?: number | null } | null): number {
  const vat = invoice?.vatAmount ? poundsToPence(invoice.vatAmount) : 0;
  return poundsToPence(runGross) + vat;
}

// ───────────────────────────── a downloaded bank file ─────────────────────────────

/** Typed to confirm a downloaded bank file was NOT uploaded to the bank (Cancel the rest). */
export const FILE_NOT_UPLOADED_CONFIRMATION = 'NOT UPLOADED';
/** Typed to confirm the bank did NOT pay some lines of a file that was uploaded (Mark as paid, some unticked). */
export const FILE_NOT_PAID_CONFIRMATION = 'NOT PAID';
/** A second bank file for the same person and week within this many days of the first one's download is refused. */
export const FILE_REPEAT_DAYS = 7;

/** `text` is `phrase`, typed exactly (surrounding spaces ignored, any case). */
export function isTypedConfirmation(text: unknown, phrase: string): boolean {
  return typeof text === 'string' && text.trim().toUpperCase() === phrase;
}

// ───────────────────────────── pay resting on unconfirmed subs ─────────────────────────────

export interface UnconfirmedPay {
  /** Subs paid for that no client statement has confirmed (yet, or ever). */
  subs: number;
  /** £ of this week's pay that rests on them: what would not be paid if they did not count. */
  amount: number;
  /** Campaign codes still waiting for their client's statement. */
  awaiting: string[];
  /** Campaign codes whose client sends no statements, so nothing will ever confirm them. */
  neverConfirmed: string[];
}

/**
 * How much of a base-or-commission week rests on subs the rep logged that no statement has confirmed: the pay as
 * calculated (base or commission) minus what it would be with only the confirmed subs (the base still applies then).
 * Bonuses, corrections and deductions are not part of it. Null when nothing rests on unconfirmed subs.
 */
export function unconfirmedPay(r: { paidAs: PaidAs; baseAmount: number; basePay: number; commission: number; commissionAmount: number; perCampaign: readonly WeekCampaignPay[] }): UnconfirmedPay | null {
  const open = r.perCampaign.filter((c) => !c.statementConfirmed && c.confirmed > 0);
  if (!open.length) return null;
  const openAmount = open.reduce((s, c) => s + Number(c.amount || 0), 0);
  const confirmedCommission = Math.max(0, Number(r.commissionAmount) - openAmount);
  const paidNow = Number(r.basePay) + Number(r.commission);
  const without = Math.max(Number(r.baseAmount), confirmedCommission);
  const amount = Math.max(0, Math.round((paidNow - without) * 100) / 100);
  return {
    subs: open.reduce((s, c) => s + c.confirmed, 0),
    amount,
    awaiting: open.filter((c) => c.awaitsStatement !== false).map((c) => c.code),
    neverConfirmed: open.filter((c) => c.awaitsStatement === false).map((c) => c.code),
  };
}

// ───────────────────────────── test bank files ─────────────────────────────

/** "LINEAR 05OCT JL" → "TEST 05OCT JL": what a test-mode bank file writes, so a bank (and Matt) can tell. */
export function testPaymentReference(reference: string): string {
  const rest = String(reference ?? '').replace(/^LINEAR\s*/i, '').trim();
  return `TEST ${rest}`.slice(0, PAYMENT_REFERENCE_MAX).trim();
}

/** The reference on a 1p test payment. */
export const PENNY_TEST_REFERENCE = 'LINEAR 1P TEST';
