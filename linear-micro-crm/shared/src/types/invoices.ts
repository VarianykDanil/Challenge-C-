/**
 * Release 1.3 — P2 invoices contracts (laid down by r3-foundation; OWNED BY P2, which may add fields and types).
 *
 * Owner's decision 1 (quote): "Everyone who works in the field is SELF-EMPLOYED. Each week Linear Hub issues a
 * SELF-BILLING INVOICE on the person's behalf (Linear MCR Limited issues it, the supplier is the person). The person
 * ACCEPTS it, or DISPUTES it so the office checks."
 * Lead decisions: deemed accepted if not disputed by 12:00 the day before payday (or 24 hours after a version issued
 * later than a day before that: shared invoiceDeadline, so nobody's invoice counts as accepted unseen); Mark paid needs accepted or deemed
 * accepted, else an admin override with a reason (audited); a disputed invoice is held until the office resolves it;
 * each person accepts the versioned self-billing agreement once before their first invoice can be accepted.
 *
 * Endpoints (server/src/routes/invoices.ts, mounted at /invoices, owned by P2):
 *  - GET  /invoices/agreement                → SelfBillingAgreement (the current text + whether I accepted it)
 *  - POST /invoices/agreement/accept         → SelfBillingAgreement (records version, time, IP)
 *  - GET  /invoices/profile                  → InvoiceProfile (mine); PUT /invoices/profile InvoiceProfileInput
 *  - GET  /invoices/profile/:userId          → InvoiceProfile (admin); PUT /invoices/profile/:userId (admin)
 *  - GET  /invoices?userId=&weekStart=&status= → InvoiceSummary[] (own; leader: own team; admin: all)
 *  - GET  /invoices/by-run/:runId            → Invoice (scoped like the payslip)
 *  - GET  /invoices/:id                      → Invoice
 *  - POST /invoices/:id/accept               → Invoice (the supplier only)
 *  - POST /invoices/:id/dispute  InvoiceDisputeInput → Invoice (the supplier only)
 *  - GET  /invoices/disputes                 → InvoiceDisputeRow[] (admin)
 *  - POST /invoices/:id/resolve  InvoiceResolveInput → Invoice (admin: 'reissue' = fix and reissue, 'keep' = keep as it is)
 *  - GET  /invoices/company, PUT /invoices/company CompanySettingsInput → CompanySettings (admin; GET also field roles:
 *    the customer block of their own invoice)
 * Server helpers called from finance.ts: lib/invoices.ts
 * `assertInvoicePayable(db, run, me, body)` before POST /finance/payroll/:id/pay, `withInvoiceSummaries(db, runs, me)`
 * on every payroll list / payslip answer, and `startInvoiceJobs(db)` from index.ts (issue on week close, deem accepted).
 * Tables (server/src/db/extensions/invoices.ts): self_billing_agreements, invoices; users columns address_line1,
 * address_line2, address_town, postcode, utr, vat_number; meta `ext:invoices:company` (CompanySettings JSON),
 * `ext:invoices:seq:<YYYY>` (the number sequence).
 */
import type { PayrollStatus } from '../types.ts';
import type { PayLineKind } from './pay.ts';

/** The agreement text's version; bump when the wording changes (everyone accepts again). */
export const SELF_BILLING_AGREEMENT_VERSION = '2026-10';

/** "LM-SB-2026-000123": prefix, year, six-digit sequence per year. */
export const INVOICE_NUMBER_PREFIX = 'LM-SB';

export type InvoiceStatus = 'issued' | 'accepted' | 'deemed_accepted' | 'disputed' | 'resolved';

export interface SelfBillingAgreement {
  version: string;
  title: string;
  /** Plain text, paragraphs separated by blank lines. */
  body: string;
  /** When the signed-in person accepted this version (null: not yet). */
  acceptedAt: string | null;
}

/** A party on the invoice: the supplier (the person) or the customer (Linear MCR Limited). */
export interface InvoiceParty {
  name: string;
  addressLines: string[];
  postcode: string | null;
  /** Customer only. */
  companyNumber?: string | null;
  /** Supplier only, optional. */
  utr?: string | null;
  /** null → the invoice says "Not VAT registered". */
  vatNumber?: string | null;
  /**
   * P2: the supplier's home address and UTR are not shown to this viewer (a team leader): only the person and the
   * office see them. The name and VAT registration stay.
   */
  withheld?: boolean;
}

export interface InvoiceLine {
  kind: PayLineKind | 'correction';
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
  /** false: shown for the explanation but not part of the total (e.g. the base when commission applied). */
  paid: boolean;
  campaignId?: number;
  sourceWeekStart?: string;
  /**
   * Release 1.3.1 fix: why the line is what it is, from the pay breakdown (PayLine.note): "7 logged, 1 cancelled by
   * CHN", "not yet confirmed by BCN", a correction's "1 cancelled by BCN: paid for 10, confirmed 9". Only when there is
   * one that the description does not already say. Invoices issued before this fix have none (their lines are their
   * record and are never rewritten to add one); a new invoice or a new version carries it.
   */
  note?: string;
}

/** What the payroll rows and lists carry (PayrollRunWithUser.invoice). */
export interface InvoiceSummary {
  id: number;
  number: string;
  status: InvoiceStatus;
  /** 1, then 2… after "Fix and reissue". */
  version: number;
  issuedAt: string;
  acceptedAt: string | null;
  disputedAt: string | null;
  /**
   * The deadline, naive London time: 12:00 the day before payday, or 24 hours after this version was issued when that is
   * later; after it an un-disputed invoice counts as accepted.
   */
  deemedAcceptedAt: string;
  total: number;
  /**
   * The VAT on this invoice (£) when the supplier is VAT registered: what is paid is `total` + `vatAmount`. Absent when
   * they are not (no VAT is charged).
   */
  vatAmount?: number;
}

/**
 * The VAT block of a self-billed invoice to a VAT-registered supplier: VAT at the standard rate on the total, rounded
 * down to the penny, and HMRC's sentence for self-billed invoices (SELF_BILLING_VAT_STATEMENT).
 */
export interface InvoiceVatBlock {
  /** The total before VAT (the week's pay). */
  net: number;
  ratePercent: number;
  vat: number;
  /** What is paid: net + VAT. */
  gross: number;
  statement: string;
}

/** P2: GET /invoices — a summary with the person and the pay week it is for. */
export interface InvoiceListRow extends InvoiceSummary {
  payrollRunId: number;
  userId: number;
  userName: string;
  weekStart: string;
  weekEnd: string;
  /** Payday. */
  dueDate: string;
  runStatus: PayrollStatus;
}

/** P2: an earlier version of a reissued invoice (newest first in Invoice.previousVersions). */
export interface InvoiceVersionNote {
  version: number;
  issuedAt: string;
  total: number;
  /** Its status when it was replaced (e.g. 'disputed'). */
  status: InvoiceStatus;
  replacedAt: string;
  /** "Fixed and reissued by the office", "The figures changed". */
  reason: string;
  disputeReason?: string | null;
}

/** P2: what the signed-in viewer may do with an invoice (the server's rules, so the buttons match them). */
export interface InvoiceActions {
  /** The supplier: Accept invoice. */
  accept: boolean;
  /** The supplier: Something's wrong (before the deadline, while unpaid). */
  dispute: boolean;
  /** Admin: Fix and reissue / Keep as it is (a disputed invoice). */
  resolve: boolean;
  /** Admin: Mark paid anyway, with a reason (unpaid and not accepted). */
  markPaidWithReason: boolean;
}

export interface InvoiceDisputeLine {
  /** Index in Invoice.lines. */
  line: number;
  /** "I made 18 sales, not 16". */
  note?: string;
}

export interface InvoiceDispute {
  reason: string;
  lines: InvoiceDisputeLine[];
  at: string;
}

export interface InvoiceResolution {
  action: 'reissue' | 'keep';
  note: string;
  by: number | null;
  byName?: string | null;
  at: string;
}

/** GET /invoices/:id — the full document (screen, print and P4's PDF primitives). */
export interface Invoice extends InvoiceSummary {
  payrollRunId: number;
  userId: number;
  weekStart: string;
  weekEnd: string;
  /** Payday (the run's due date). */
  dueDate: string;
  supplier: InvoiceParty;
  customer: InvoiceParty;
  lines: InvoiceLine[];
  /** "Self-billed invoice issued by Linear MCR Limited on behalf of the supplier under a self-billing agreement". */
  selfBillingNote: string;
  signatory: { name: string; signatureUrl: string | null };
  /**
   * "Accepted electronically by Jordan Lee on Thu 22 Oct 2026, 14:05"; null while not accepted. P2: `withoutAgreement`
   * marks a deemed acceptance of someone who had not accepted the self-billing agreement by then.
   */
  acceptance: { by: string; at: string; deemed: boolean; withoutAgreement?: boolean } | null;
  dispute: InvoiceDispute | null;
  resolution: InvoiceResolution | null;
  /** P2: the run's payroll status and paid date (Mark paid gating, "Paid on …"). */
  runStatus?: PayrollStatus;
  paidDate?: string | null;
  /** P2: the run was marked paid before the invoice was accepted, with the admin's reason (audited). */
  paidOverride?: { reason: string; by: number | null; byName?: string | null; at: string } | null;
  /** P2: earlier versions, newest first (absent before the first reissue). */
  previousVersions?: InvoiceVersionNote[];
  /** P2: what the viewer may do. */
  actions?: InvoiceActions;
  /** VAT, when the supplier is VAT registered (their VAT number is on the invoice); null when no VAT is charged. */
  vat?: InvoiceVatBlock | null;
  /** P2: the supplier only — whether they accepted the current self-billing agreement (needed to accept). */
  agreementAccepted?: boolean;
  /** P2, admin only: the run's gross as it stands now (what Fix and reissue would issue). */
  runTotal?: number;
  /** P2, admin only: the run's figures moved since this version was issued. */
  figuresChanged?: boolean;
}

export interface InvoiceDisputeInput {
  reason: string;
  lines: InvoiceDisputeLine[];
}

export interface InvoiceResolveInput {
  action: 'reissue' | 'keep';
  /** Shown to the person. */
  note: string;
  /**
   * P2, 'reissue' only: a correction added to the disputed week before it is reissued (a pay_adjustments row of kind
   * 'dispute' for the invoice; £, negative to take money off). The run is recalculated with P1's rule.
   */
  adjustment?: { amount: number; note?: string } | null;
}

/** Finance → Company → Disputes. */
export interface InvoiceDisputeRow {
  invoice: InvoiceSummary;
  userId: number;
  userName: string;
  weekStart: string;
  dispute: InvoiceDispute;
  /** Our figure for the disputed lines and the run. */
  ours: { total: number; salesLogged?: number; salesConfirmed?: number };
  /** P2: the run behind it (to open it from the Disputes card) and its payday. */
  payrollRunId?: number;
  dueDate?: string;
  teamName?: string | null;
  /** P2: the disputed lines as printed on the invoice, with the person's note on each. */
  disputedLines?: { line: number; description: string; amount: number; paid: boolean; note?: string }[];
  /** P2: true once the run's figures differ from the disputed invoice (the office changed something). */
  figuresChanged?: boolean;
  /** P2: the run's gross as it stands now (what Fix and reissue would issue). */
  runTotal?: number;
  /** P2: the clients' statements that confirmed this person's sales for the week (Finance → Statements → the statement). */
  statements?: { id: number; campaignCode: string | null }[];
}

/** The person's details printed as the supplier (users columns). */
export interface InvoiceProfile {
  userId: number;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressTown: string | null;
  postcode: string | null;
  utr: string | null;
  vatNumber: string | null;
  /** P2: whether this person's pay runs get a self-billing invoice (reps and leaders: the field people). */
  invoiced?: boolean;
  /** P2: the self-billing agreement they accepted (the current version), if any. */
  agreement?: { version: string; acceptedAt: string | null };
}

export type InvoiceProfileInput = Partial<Omit<InvoiceProfile, 'userId' | 'name' | 'invoiced' | 'agreement'>>;

/** Settings → Company (meta `ext:invoices:company`). */
export interface CompanySettings {
  legalName: string;
  addressLines: string[];
  postcode: string | null;
  companyNumber: string | null;
  signatoryName: string;
  /** Served by P2's own route; null when none uploaded. */
  signatureUrl: string | null;
}

export interface CompanySettingsInput {
  legalName?: string;
  addressLines?: string[];
  postcode?: string | null;
  companyNumber?: string | null;
  signatoryName?: string;
  /** data:image/png;base64,… (≤ 200 KB) or null to remove. */
  signatureImage?: string | null;
}
