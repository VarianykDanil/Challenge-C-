// Release 1.3 — OWNED BY P2 invoices. The words and dates the invoice screens share (no React; also used by the PDF).
import { format } from 'date-fns';
import { formatUtr, formatVatNumber, invoiceDeadlineText, type Invoice, type InvoiceParty, type InvoiceStatus } from '@lm/shared';
import { formatGBP, formatRangeLabel, parseDate } from '@/lib/format';

/** "Thu 22 Oct 2026, 14:05" (a zoned timestamp, or a naive London time such as a deadline). */
export function invoiceMoment(value: string | null | undefined): string {
  const d = parseDate(value);
  return d ? format(d, 'EEE d MMM yyyy, HH:mm') : '—';
}

/** "12:00 Thu 22 Oct" — the deadline, short ("midnight on Thu 22 Oct" for 00:00 on the Friday, never "00:00 Fri"). */
export function deadlineShort(value: string | null | undefined): string {
  return invoiceDeadlineText(value);
}

/** "Mon 19 Oct 2026" */
export function invoiceDay(value: string | null | undefined): string {
  const d = parseDate(value);
  return d ? format(d, 'EEE d MMM yyyy') : '—';
}

export const money = (n: number) => formatGBP(n, { cents: true });

/** A signed amount: "−£20.00" for money taken off. */
export const signedMoney = (n: number) => (n < 0 ? `−${money(Math.abs(n))}` : money(n));

/** The supplier's tax lines: UTR (when known) and VAT. A withheld block (a team leader's view) says why there is no UTR. */
export function supplierTaxLines(p: InvoiceParty): string[] {
  const lines: string[] = [];
  if (p.utr) lines.push(`UTR ${formatUtr(p.utr)}`);
  lines.push(p.vatNumber ? `VAT number ${formatVatNumber(p.vatNumber)}` : 'Not VAT registered');
  return lines;
}

/**
 * The VAT sentence under the total when no VAT is charged. With a VAT number on the invoice the VAT block (Invoice.vat)
 * is shown instead, with HMRC's sentence for self-billed invoices.
 */
export function vatLine(inv: Pick<Invoice, 'supplier' | 'vat'>): string {
  return inv.vat ? inv.vat.statement : 'No VAT: the supplier is not VAT registered.';
}

/** Shown instead of the address when it is withheld from this viewer. */
export const WITHHELD_SUPPLIER = 'Home address and UTR: only the supplier and the office see them';

export function customerExtraLines(p: InvoiceParty): string[] {
  return p.companyNumber ? [`Company number ${p.companyNumber}`] : [];
}

/** The supplier's signature line: accepted, deemed accepted, disputed, kept by the office, or still to accept. */
export function acceptanceSentence(inv: Pick<Invoice, 'status' | 'acceptance' | 'dispute' | 'resolution' | 'deemedAcceptedAt' | 'supplier'>): string {
  if (inv.acceptance && !inv.acceptance.deemed) return `Accepted electronically by ${inv.acceptance.by} on ${invoiceMoment(inv.acceptance.at)}`;
  if (inv.acceptance?.deemed) {
    return inv.acceptance.withoutAgreement
      ? `Deemed accepted at ${invoiceMoment(inv.acceptance.at)}: not disputed by then (the self-billing agreement was not accepted yet)`
      : `Deemed accepted at ${invoiceMoment(inv.acceptance.at)}: not disputed by then`;
  }
  if (inv.status === 'disputed' && inv.dispute) return `Disputed by ${inv.supplier.name} on ${invoiceMoment(inv.dispute.at)}: waiting for the office`;
  if (inv.status === 'resolved' && inv.resolution) return `Checked by the office on ${invoiceMoment(inv.resolution.at)} and kept as it is`;
  return `Not accepted yet. It counts as accepted at ${invoiceMoment(inv.deemedAcceptedAt)} unless disputed.`;
}

/** The badge's tone and its hover text for a status. */
export function statusTone(status: InvoiceStatus): 'info' | 'success' | 'danger' | 'neutral' {
  if (status === 'accepted' || status === 'deemed_accepted') return 'success';
  if (status === 'disputed') return 'danger';
  if (status === 'resolved') return 'neutral';
  return 'info';
}

export function statusHint(status: InvoiceStatus, deemedAcceptedAt: string): string {
  switch (status) {
    case 'issued':
      return `Waiting to be accepted. It counts as accepted at ${deadlineShort(deemedAcceptedAt)} unless disputed.`;
    case 'accepted':
      return 'Accepted by the supplier';
    case 'deemed_accepted':
      return `Not disputed by ${deadlineShort(deemedAcceptedAt)}, so it counts as accepted`;
    case 'disputed':
      return 'The supplier said something is wrong: held until the office answers';
    case 'resolved':
      return 'The office checked it and kept it as it is';
  }
}

/** The pay week as the rest of the app writes it: "12 – 18 Oct 2026" ("28 Sep – 4 Oct 2026" across a month). */
export function weekRange(from: string, to: string): string {
  return parseDate(from) && parseDate(to) ? formatRangeLabel(from, to) : '—';
}
