/**
 * Release 1.3 — OWNED BY P2 invoices (laid down by r3-foundation). Pure rules for self-billing invoices: the number
 * format and the "deemed accepted" moment (12:00 the day before payday) — both STABLE (P1's pay views and P9's audit
 * summaries may show them) — plus who is invoiced, the statuses, the deadline of a version issued late (24 hours to
 * accept or dispute it, whatever the day), the lines built
 * from P1's breakdown (or from the stored run while P1's breakdown is not there), the agreement text and the supplier
 * details' formats.
 *
 * Times: an invoice's deadline is a Europe/London wall-clock moment without a zone ("2026-10-22T12:00:00"); `now`
 * arguments are the same kind of naive London time (the server's toBusinessISO), so they compare as strings.
 */
import type { PayrollRun, Role } from '../types.ts';
import type { InvoiceLine, InvoiceStatus } from '../types/invoices.ts';
import { INVOICE_NUMBER_PREFIX, SELF_BILLING_AGREEMENT_VERSION } from '../types/invoices.ts';
import type { PayLine, WeekPayBreakdown } from '../types/pay.ts';
import { addDays, isoToUTC, isValidISODate } from './dates.ts';
import { round2 } from './finance.ts';

/** "LM-SB-2026-000123". */
export function formatInvoiceNumber(year: number, seq: number): string {
  return `${INVOICE_NUMBER_PREFIX}-${year}-${String(Math.max(0, Math.floor(seq))).padStart(6, '0')}`;
}

/**
 * The moment an invoice not disputed by then counts as accepted: 12:00 (business time, Europe/London wall clock, no
 * zone) on the day before payday — "YYYY-MM-DDT12:00:00". Null for an invalid date.
 */
export function deemedAcceptedAt(payday: string): string | null {
  if (!isValidISODate(payday)) return null;
  return `${addDays(payday, -1)}T12:00:00`;
}

// ───────────────────────────── who is invoiced ─────────────────────────────

/**
 * The roles whose pay runs get a self-billing invoice: the field people (decision 1: "Everyone who works in the field
 * is SELF-EMPLOYED"). Office recruiters and administrators (the owner, the assistant owner) keep the payslip.
 */
export const INVOICED_ROLES = ['rep', 'leader'] as const satisfies readonly Role[];

export function isInvoicedRole(role: string | null | undefined): boolean {
  return (INVOICED_ROLES as readonly string[]).includes(role ?? '');
}

// ───────────────────────────── statuses and the deadline ─────────────────────────────

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['issued', 'accepted', 'deemed_accepted', 'disputed', 'resolved'];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  issued: 'Issued',
  accepted: 'Accepted',
  deemed_accepted: 'Deemed accepted',
  disputed: 'Disputed',
  resolved: 'Resolved',
};

/**
 * Statuses that let the office mark the run paid: accepted by the person, deemed accepted (not disputed by the
 * deadline), or resolved ("Keep as it is": the office checked it and the person was told why).
 */
export const PAYABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = ['accepted', 'deemed_accepted', 'resolved'];

export function isInvoicePayable(status: InvoiceStatus | null | undefined): boolean {
  return status != null && PAYABLE_INVOICE_STATUSES.includes(status);
}

/**
 * How long a version issued late always stays open to accept or dispute: 24 hours (the same wall-clock time the next
 * day, to the minute).
 */
export const LATE_INVOICE_OPEN_HOURS = 24;

/** A naive London time plus whole hours ("2026-10-22T13:05:42" + 24 → "2026-10-23T13:06:00", rounded up to the minute). */
function naivePlusHours(naive: string, hours: number): string | null {
  const ms = Date.parse(`${naive.slice(0, 19)}Z`);
  if (!Number.isFinite(ms) || !isValidISODate(naive.slice(0, 10))) return null;
  const t = Math.ceil((ms + hours * 3_600_000) / 60_000) * 60_000;
  return new Date(t).toISOString().slice(0, 19);
}

/**
 * The deadline of an invoice issued (or reissued) at `issuedLocal` (naive London time) for `payday`: 12:00 the day
 * before payday (the lead's rule), or 24 hours after it was issued, whichever is later. So every version gives the
 * person at least a day to accept it or say something's wrong: a version issued on Monday morning has until Thursday
 * 12:00; one reissued on Thursday at 13:05 (a statement, a bonus) has until 13:05 on Friday; one issued on or after
 * payday (a statement applied on Friday morning, an old failed transfer invoiced late) has 24 hours from then. Until
 * the deadline, Mark paid needs the person's acceptance or the office's reason (lead decision). Returns a naive London
 * time ("YYYY-MM-DDTHH:MM:SS").
 */
export function invoiceDeadline(payday: string, issuedLocal: string): string {
  const base = deemedAcceptedAt(payday);
  const fair = naivePlusHours(issuedLocal, LATE_INVOICE_OPEN_HOURS);
  if (!base) return fair ?? `${issuedLocal.slice(0, 10)}T12:00:00`;
  return fair && fair > base ? fair : base;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A deadline (naive London time) in words: "12:00 Thu 22 Oct". A deadline at 00:00 is the end of the day before, so it
 * reads "midnight on Thu 22 Oct" (never "00:00 Fri 23 Oct", easy to read as Friday night). '—' for nothing.
 */
export function invoiceDeadlineText(deadline: string | null | undefined): string {
  const day = (deadline ?? '').slice(0, 10);
  if (!isValidISODate(day)) return '—';
  const time = (deadline ?? '').slice(11, 16) || '00:00';
  const label = (iso: string) => {
    const d = new Date(isoToUTC(iso));
    return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  };
  return time === '00:00' ? `midnight on ${label(addDays(day, -1))}` : `${time} ${label(day)}`;
}

/**
 * The moment a deemed acceptance took effect: the deadline, never before the version existed (an invoice stored by an
 * earlier build could have a deadline before its issue time).
 */
export function deemedAcceptanceMoment(deadline: string, issuedLocal: string): string {
  return issuedLocal && issuedLocal.slice(0, 19) > deadline ? issuedLocal.slice(0, 19) : deadline;
}

/**
 * Whether two versions of an invoice pay the same: the same total and the same paid lines (kind, campaign, quantity,
 * unit price, amount, in order). Lines listed as "Not paid" and the wording of the lines do not count: when only they
 * change (a cancellation on a week paid as the base, a statement confirming the same number), the invoice is refreshed
 * in place and keeps its acceptance; anything else is a new version for the person to check.
 */
export function sameInvoicePayment(
  a: { total: number; lines: readonly InvoiceLine[] },
  b: { total: number; lines: readonly InvoiceLine[] },
): boolean {
  if (round2(a.total) !== round2(b.total)) return false;
  const key = (lines: readonly InvoiceLine[]) =>
    lines.filter((l) => l.paid).map((l) => [l.kind, l.campaignId ?? null, l.quantity ?? null, l.unitPrice ?? null, round2(l.amount)].join('|'));
  const ka = key(a.lines);
  const kb = key(b.lines);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** The status as it stands at `nowLocal`: an issued invoice past its deadline counts as deemed accepted. */
export function effectiveInvoiceStatus(status: InvoiceStatus, deadline: string | null, nowLocal: string): InvoiceStatus {
  if (status === 'issued' && deadline && nowLocal >= deadline) return 'deemed_accepted';
  return status;
}

/** Whether the supplier may still say something's wrong: before the deadline, while the run is unpaid. */
export function canDisputeInvoice(status: InvoiceStatus, deadline: string | null, nowLocal: string, runPaid: boolean): boolean {
  if (runPaid) return false;
  if (status !== 'issued' && status !== 'accepted') return false;
  return !deadline || nowLocal < deadline;
}

// ───────────────────────────── lines ─────────────────────────────

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "£1,234.50" (pence always shown). */
export const invoiceMoney = (n: number): string => GBP.format(Number.isFinite(n) && n !== 0 ? n : 0);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Σ of the paid lines (deductions are negative amounts), in pence. */
export function invoiceLinesTotal(lines: readonly Pick<InvoiceLine, 'amount' | 'paid'>[]): number {
  return round2(lines.reduce((a, l) => (l.paid ? a + l.amount : a), 0));
}

/**
 * P1's breakdown lines → invoice lines (one per PayLine, in order). A deduction always takes money off (its amount is
 * made negative whatever sign the breakdown used); an adjustment that corrects an earlier week becomes a
 * 'correction' line. Release 1.3.1 fix: the line's note comes too (why it is what it is), unless the description
 * already says it (a bonus: "Bonus: top seller") — the note is wording, so it never changes what is paid
 * (sameInvoicePayment).
 */
export function invoiceLinesFromBreakdown(b: Pick<WeekPayBreakdown, 'lines' | 'weekStart'>): InvoiceLine[] {
  return b.lines.map((l: PayLine): InvoiceLine => {
    const amount = round2(l.kind === 'deduction' ? -Math.abs(l.amount) : l.amount);
    const correction = l.kind === 'adjustment' && !!l.sourceWeekStart && l.sourceWeekStart !== b.weekStart;
    const line: InvoiceLine = { kind: correction ? 'correction' : l.kind, description: l.label, amount, paid: l.paid };
    if (l.quantity !== undefined) line.quantity = l.quantity;
    if (l.rate !== undefined) line.unitPrice = l.rate;
    if (l.campaignId !== undefined) line.campaignId = l.campaignId;
    if (l.sourceWeekStart) line.sourceWeekStart = l.sourceWeekStart;
    const note = l.note?.trim();
    if (note && !l.label.includes(note)) line.note = note;
    return line;
  });
}

/**
 * Release 1.3.1 fix: a line's note as the invoice shows it, in grey under the description (screen and PDF): sentence
 * case ("not yet confirmed by BCN" → "Not yet confirmed by BCN"). Null for a line without one — every line of an
 * invoice issued before the fix.
 */
export function invoiceLineNote(l: Pick<InvoiceLine, 'note'>): string | null {
  const note = l.note?.trim();
  return note ? note[0]!.toUpperCase() + note.slice(1) : null;
}

/** The stored run's figures, for invoice lines when P1's breakdown is not available (or does not match the run). */
export type InvoiceRunFigures = Pick<PayrollRun, 'daysWorked' | 'sales' | 'teamSales' | 'basePay' | 'commission' | 'bonus' | 'overrides' | 'deductions' | 'gross'> &
  Partial<Pick<PayrollRun, 'adjustmentsTotal' | 'paidAs'>>;

/** A unit price only when it reproduces the amount exactly ("10 sales × £45.00" = £450.00). */
function exactRate(amount: number, quantity: number): number | undefined {
  if (!(quantity > 0)) return undefined;
  const rate = round2(amount / quantity);
  return round2(rate * quantity) === round2(amount) ? rate : undefined;
}

/**
 * Lines from the stored run: base, commission, bonus, overrides, corrections from earlier weeks (P1's
 * adjustments_total), deductions — only those with an amount — and, if the figures do not add up to the run's gross
 * (they always do for runs this app wrote), one "Other adjustments" line so the invoice total is the run's gross.
 */
export function invoiceLinesFromRun(run: InvoiceRunFigures): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (run.basePay > 0) {
    const rate = exactRate(run.basePay, run.daysWorked);
    lines.push({
      kind: 'base',
      description: rate !== undefined ? `Base: ${plural(run.daysWorked, 'day')} × ${invoiceMoney(rate)}` : `Base: ${plural(run.daysWorked, 'day')} worked`,
      ...(run.daysWorked > 0 ? { quantity: run.daysWorked } : {}),
      ...(rate !== undefined ? { unitPrice: rate } : {}),
      amount: round2(run.basePay),
      paid: true,
    });
  }
  if (run.commission > 0) {
    const rate = exactRate(run.commission, run.sales);
    lines.push({
      kind: 'commission',
      description: rate !== undefined ? `Commission: ${plural(run.sales, 'sale')} × ${invoiceMoney(rate)}` : `Commission: ${plural(run.sales, 'sale')}`,
      ...(run.sales > 0 ? { quantity: run.sales } : {}),
      ...(rate !== undefined ? { unitPrice: rate } : {}),
      amount: round2(run.commission),
      paid: true,
    });
  }
  if (run.bonus > 0) lines.push({ kind: 'bonus', description: 'Bonus', amount: round2(run.bonus), paid: true });
  if (run.overrides > 0) lines.push({ kind: 'override', description: `Team overrides: ${plural(run.teamSales, 'team sale')}`, amount: round2(run.overrides), paid: true });
  if (run.adjustmentsTotal) lines.push({ kind: 'correction', description: 'Corrections from earlier weeks', amount: round2(run.adjustmentsTotal), paid: true });
  if (run.deductions > 0) lines.push({ kind: 'deduction', description: 'Deductions', amount: round2(-run.deductions), paid: true });
  const diff = round2(run.gross - invoiceLinesTotal(lines));
  if (diff !== 0) lines.push({ kind: 'adjustment', description: 'Other adjustments', amount: diff, paid: true });
  return lines;
}

/**
 * The invoice's lines for a run: P1's breakdown when it is there and its paid lines add up to the run's gross (what
 * will be paid), else the stored run's figures. The total is always the run's gross.
 */
export function invoiceLinesFor(run: InvoiceRunFigures, breakdown: Pick<WeekPayBreakdown, 'lines' | 'weekStart'> | null): { lines: InvoiceLine[]; total: number; source: 'breakdown' | 'run' } {
  const total = round2(run.gross);
  if (breakdown && breakdown.lines.length) {
    const lines = invoiceLinesFromBreakdown(breakdown);
    if (invoiceLinesTotal(lines) === total) return { lines, total, source: 'breakdown' };
  }
  return { lines: invoiceLinesFromRun(run), total, source: 'run' };
}

// ───────────────────────────── the words on the invoice ─────────────────────────────

/** The sentence every self-billed invoice carries (HMRC: "self-billing" must appear on the invoice). */
export function selfBillingNote(legalName: string): string {
  return `Self-billed invoice issued by ${legalName} on behalf of the supplier under a self-billing agreement.`;
}

/**
 * The self-billing agreement each field person accepts once (version SELF_BILLING_AGREEMENT_VERSION). Plain English;
 * paragraphs separated by blank lines. Bump the version when the wording changes: everyone accepts again.
 */
export function selfBillingAgreementText(legalName: string): { version: string; title: string; body: string } {
  const body = [
    `This agreement is between you (the supplier: you work for yourself) and ${legalName} (the customer). It lets ${legalName} write your invoices for you, so you do not have to.`,
    `1. Each pay week, ${legalName} issues a self-billed invoice on your behalf for the work you did that week: your base or your commission, any bonus, corrections from earlier weeks and any deductions. Each invoice has its own number (LM-SB-year-number).`,
    `2. You agree not to send your own invoices for the work these invoices cover.`,
    `3. Check each invoice in Linear Hub (Finance → My pay). Accept it, or tap "Something's wrong" and say what is wrong. If you have done neither by 12:00 the day before payday, the invoice counts as accepted. You always get at least 24 hours: an invoice issued or changed later than 12:00 two days before payday counts as accepted 24 hours after it was issued.`,
    `4. If you say something's wrong, the invoice is held until the office checks it. The office either fixes it and issues a new version for you to accept, or explains why it stands.`,
    `5. Keep your details up to date in Settings → Invoices: your address, and your Unique Taxpayer Reference if you have one. Tell the office straight away if you register for VAT, change your VAT number or stop being VAT registered.`,
    `6. You are self-employed: you are responsible for your own tax and National Insurance on what you are paid.`,
    `7. This agreement lasts until you or ${legalName} end it in writing. It is reviewed every 12 months; if the wording changes you will be asked to accept the new version.`,
  ].join('\n\n');
  return { version: SELF_BILLING_AGREEMENT_VERSION, title: 'Self-billing agreement', body };
}

// ───────────────────────────── the supplier's details ─────────────────────────────

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/;

/** "m14 5qt" → "M14 5QT"; null when it is not a UK postcode (empty → null too). */
export function normalisePostcode(value: string | null | undefined): string | null {
  const compact = (value ?? '').toUpperCase().replace(/\s+/g, '');
  if (compact.length < 5 || compact.length > 7) return null;
  const formatted = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return POSTCODE_RE.test(formatted) ? formatted : null;
}

/** A Unique Taxpayer Reference: ten digits (spaces allowed when typed). Null when it is not one. */
export function normaliseUtr(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** A UK VAT number, stored as "GB123456789" (9 digits, or 12 for a branch). Null when it is not one. */
export function normaliseVatNumber(value: string | null | undefined): string | null {
  const compact = (value ?? '').toUpperCase().replace(/[\s.-]/g, '');
  const m = /^(?:GB)?(\d{9}|\d{12})$/.exec(compact);
  return m ? `GB${m[1]}` : null;
}

/** "GB123456789" → "GB 123 4567 89" (as HMRC prints it). */
export function formatVatNumber(vat: string): string {
  const m = /^GB(\d{3})(\d{4})(\d{2})(\d{3})?$/.exec(vat);
  return m ? `GB ${m[1]} ${m[2]} ${m[3]}${m[4] ? ` ${m[4]}` : ''}` : vat;
}

/** "1234567890" → "12345 67890". */
export function formatUtr(utr: string): string {
  return /^\d{10}$/.test(utr) ? `${utr.slice(0, 5)} ${utr.slice(5)}` : utr;
}
