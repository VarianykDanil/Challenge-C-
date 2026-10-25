/**
 * Release 1.4 — payments foundation (package F) contracts. Packages P (the bank payment file) and A (the Revolut,
 * Wise and TrueLayer APIs) build on these and may ADD fields and types; nothing here is renamed or removed.
 *
 * Owner's decision (quote): "also connecting its own payment system i want ability in there" — then "add those
 * different abilities of each bank api and also add their icons". So Linear Hub supports four ways to pay, each with
 * what it can and cannot do shown plainly (PaymentAbilities) and its logo (iconKey → the client's icon map):
 *   1. bank_file  — Linear Hub makes a bulk-payment file; Matt uploads and approves it in his online banking, then
 *                   marks the batch paid in Linear Hub;
 *   2. revolut    — Revolut Business API (pays from Linear Hub);
 *   3. wise       — Wise Business API (creates the transfers from Linear Hub);
 *   4. truelayer  — Open Banking payouts through TrueLayer.
 *
 * Money inside payment code is whole pence (integers). Payroll runs hold pounds with two decimals; they are converted
 * once, exactly (logic/payments.ts poundsToPence). Pay maths never changes: a payment moves the amount the run holds.
 *
 * Endpoints (server/src/routes/payments.ts at /payments and routes/bankDetails.ts; all admin unless marked):
 *  - GET    /payments/providers                         → PaymentProviderView[] (the four, with abilities + form fields)
 *  - GET    /payments/connections                       → PaymentConnection[] (secrets never returned)
 *  - POST   /payments/connections         PaymentConnectionInput  → PaymentConnection (always starts in test mode)
 *  - PATCH  /payments/connections/:id     PaymentConnectionPatch  → PaymentConnection (mode 'live' needs
 *                                                                    confirm: PAYMENT_LIVE_CONFIRMATION)
 *  - DELETE /payments/connections/:id                   → PaymentConnection (disconnected: secrets wiped, history kept)
 *  - POST   /payments/connections/:id/test              → PaymentConnectionTestResult
 *  - GET    /payments/batches                           → PaymentBatchSummary[] (newest first)
 *  - POST   /payments/batches             PaymentBatchInput      → PaymentBatch (a draft; 400 with skipped when none payable)
 *  - GET    /payments/batches/:id                       → PaymentBatch
 *  - POST   /payments/batches/:id/approve PaymentApproveInput    → PaymentBatch (the admin's fresh two-step code; submits)
 *  - POST   /payments/batches/:id/refresh               → PaymentBatch (API: statuses; also retries queued items)
 *  - POST   /payments/batches/:id/cancel                → PaymentBatch (a draft, or a bank file not yet marked paid)
 *  - GET    /payments/batches/:id/file                  → the bank file (download)
 *  - POST   /payments/batches/:id/mark-paid PaymentMarkPaidInput → PaymentBatch (bank file: the bank paid them)
 *  - GET    /me/bank-details                            → BankDetailsView (own, masked; every staff role)
 *  - PUT    /me/bank-details              BankDetailsInput       → BankDetailsView (own; two-step code when on)
 *  - GET    /users/:id/bank-details                     → BankDetailsView (admin, masked)
 *  - PUT    /users/:id/bank-details       BankDetailsInput       → BankDetailsView (admin; two-step code when on)
 *  - POST   /users/:id/bank-details/confirm             → BankDetailsView (admin: checked, payments may use them)
 */

/** The four ways to pay. A test build may register more (the fake provider, id 'fake'). */
export type PaymentProviderId = 'bank_file' | 'revolut' | 'wise' | 'truelayer';
export const PAYMENT_PROVIDER_IDS: readonly PaymentProviderId[] = ['bank_file', 'revolut', 'wise', 'truelayer'];

/** 'file': Linear Hub makes a file you take to your bank; 'api': Linear Hub talks to the provider itself. */
export type PaymentProviderKind = 'file' | 'api';

/** Every API connection starts in 'test' (the provider's sandbox); 'live' needs the admin's typed confirmation. */
export type PaymentMode = 'test' | 'live';
export const PAYMENT_LIVE_CONFIRMATION = 'PAY FOR REAL';

export type PaymentConnectionStatus = 'not_connected' | 'connected' | 'error';

export type PaymentBatchStatus = 'draft' | 'submitted' | 'processing' | 'completed' | 'partly_failed' | 'failed' | 'cancelled';
export type PaymentItemStatus = 'queued' | 'submitted' | 'processing' | 'paid' | 'failed' | 'cancelled';

/** What a way to pay can and cannot do, written plainly (shown as a checklist on Settings → Payments). */
export interface PaymentAbilities {
  /** The money leaves from Linear Hub (✗: you upload a file or approve in the provider's app). */
  paysFromApp: boolean;
  /** Linear Hub learns by itself that a payment arrived (✗: you mark it paid). */
  confirmsAutomatically: boolean;
  /** You approve the payments in your bank's or the provider's app as well. */
  needsBankApproval: boolean;
  /** There is a test mode (sandbox) that moves no real money. */
  testMode: boolean;
  /** Linear Hub can show the balance you pay from. */
  checksBalance: boolean;
  /** Payments usually arrive the same day (UK Faster Payments). */
  sameDay: boolean;
  /**
   * Release 1.4 (P): works with any UK business bank (the bank payment file). Shown in the checklist only when set,
   * so the API providers' checklists are unchanged.
   */
  anyUkBank?: boolean;
  /** Fees, in plain words. */
  fees: string;
  /** What Matt needs to set it up, one line each. */
  setup: string[];
  /** Limits and caveats, in plain words. */
  limits: string;
}

/** One way to pay (the shared list is logic/payments.ts PAYMENT_PROVIDERS). */
export interface PaymentProviderInfo {
  id: PaymentProviderId | (string & {});
  /** "Revolut Business". */
  name: string;
  /** One sentence: how it works. */
  summary: string;
  kind: PaymentProviderKind;
  abilities: PaymentAbilities;
  /** The client's logo key (features/payments/ProviderLogo): 'bank' | 'revolut' | 'wise' | 'truelayer' | 'test'. */
  iconKey: string;
  /**
   * Package A: how to connect, in order — including the steps done OUTSIDE Linear Hub (in the provider's app or
   * console, or on a computer). Shown at the top of the Connect form.
   */
  connectSteps?: string[];
  /** Package A: what switching to live means for this provider (e.g. live has its own keys). Shown with Switch to live. */
  liveNote?: string;
  /**
   * Package A: what approving does NOT do yet, when the provider needs Matt outside Linear Hub afterwards (Wise: he
   * pays the transfers in Wise). Added to the payment page's Approve card.
   */
  approveNote?: string;
  /** Package A: what happens while payments are on their way, and anything Matt does in the provider's app meanwhile. */
  waitingNote?: string;
}

/** One field of a connection form (driven by the provider's configFields). */
export interface PaymentConfigField {
  /** The key in settings (or secrets, when `secret`). */
  name: string;
  label: string;
  /** Stored encrypted, never returned (the form shows "Saved" and leaves the box empty). */
  secret?: boolean;
  required?: boolean;
  /**
   * Package A: needed unless the connection already holds this secret (Revolut's "Code from Revolut" is needed until
   * Linear Hub holds a `refreshToken`). The form marks it required then; the adapter's validateConfig checks it.
   */
  requiredUnless?: string;
  /** "Where to find this", in plain words. */
  help?: string;
  /** Default 'text'. 'textarea' for keys and certificates; 'select' uses `options`. */
  type?: 'text' | 'textarea' | 'select';
  /**
   * Release 1.4 (P): an option may carry a logo key (the client's ProviderLogo) and a one-line hint; a select whose
   * options have logos is drawn as a list of choices with their logos (the bank file's format picker).
   */
  options?: { value: string; label: string; iconKey?: string; hint?: string }[];
  placeholder?: string;
  /** Longest value accepted (default 200; 8000 for a textarea). */
  maxLength?: number;
}

/** GET /payments/providers: a way to pay, its form, and whether this version can pay through it yet. */
export interface PaymentProviderView extends PaymentProviderInfo {
  configFields: PaymentConfigField[];
  /** false until the adapter is built: the connection can be saved, but testing and paying answer 501. */
  available: boolean;
}

export interface PaymentConnection {
  id: number;
  provider: PaymentProviderId | (string & {});
  name: string;
  mode: PaymentMode;
  /** Non-secret settings (e.g. the bank file format, a profile or account id). */
  settings: Record<string, string>;
  /** The names of the secrets that are stored (never their values). */
  secretsSet: string[];
  status: PaymentConnectionStatus;
  lastCheckedAt: string | null;
  /** The last test's or payment's error, in plain words, secrets redacted. */
  lastError: string | null;
  /** The balance seen by the last test, when the provider shows one (pence). */
  balancePence?: number | null;
  createdAt: string;
  createdBy: number | null;
  createdByName?: string | null;
  liveConfirmedAt: string | null;
  liveConfirmedBy: number | null;
  disconnectedAt: string | null;
}

export interface PaymentConnectionInput {
  provider: PaymentProviderId | (string & {});
  /** Default: the provider's name. */
  name?: string;
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
}

/** Only what is sent changes; an empty secret value leaves the stored one as it is. */
export interface PaymentConnectionPatch {
  name?: string;
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
  mode?: PaymentMode;
  /** Required, typed exactly, to switch to live: PAYMENT_LIVE_CONFIRMATION. */
  confirm?: string;
}

export interface PaymentConnectionTestResult {
  ok: boolean;
  /** Plain words, e.g. "Connected to your Revolut Business sandbox. Balance £1,000.00." */
  message: string;
  balancePence?: number | null;
  checkedAt: string;
  connection: PaymentConnection;
}

/** Why a selected run was left out of a batch. */
export type PaymentSkipCode =
  | 'not_found'
  | 'already_paid'
  | 'in_payment'
  | 'week_not_ended'
  | 'not_positive'
  | 'invoice_not_accepted'
  | 'invoice_disputed'
  | 'no_bank_details'
  | 'bank_details_unconfirmed';

export interface PaymentSkip {
  runId: number;
  userId: number | null;
  userName: string | null;
  weekStart: string | null;
  amountPence: number | null;
  code: PaymentSkipCode;
  /** Plain words, e.g. "No bank details yet: ask Jordan to add them in Settings → Bank details." */
  reason: string;
}

export interface PaymentItem {
  id: number;
  batchId: number;
  payrollRunId: number;
  userId: number;
  userName: string;
  weekStart: string;
  /** The run's reference, e.g. "PAY-2026-W41-0010". */
  runReference: string | null;
  amountPence: number;
  /** The account holder's name as the person gave it. */
  payeeName: string;
  /** "5678" — the only part of the account number any API answers with. */
  accountLast4: string;
  status: PaymentItemStatus;
  providerRef: string | null;
  failureReason: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  updatedAt: string;
  /** Something the admin should know, e.g. the run's pay changed after the money was sent. */
  note?: string | null;
}

export interface PaymentBatchSummary {
  id: number;
  connectionId: number;
  connectionName: string;
  provider: PaymentProviderId | (string & {});
  mode: PaymentMode;
  createdAt: string;
  createdBy: number | null;
  createdByName: string | null;
  approvedAt: string | null;
  approvedBy: number | null;
  approvedByName: string | null;
  totalPence: number;
  count: number;
  status: PaymentBatchStatus;
  /** The bank file's name (file batches, once approved). */
  fileName: string | null;
  providerRef: string | null;
  /** Item counts by outcome. */
  paidCount: number;
  failedCount: number;
  /** Queued, submitted or processing. */
  waitingCount: number;
  /** The last error talking to the provider (plain words, secrets redacted). */
  lastError?: string | null;
}

export interface PaymentBatch extends PaymentBatchSummary {
  items: PaymentItem[];
  /** The runs left out when the draft was made, and why. */
  skipped: PaymentSkip[];
  kind: PaymentProviderKind;
  /** What the admin can do now. */
  actions: {
    approve: boolean;
    cancel: boolean;
    refresh: boolean;
    download: boolean;
    markPaid: boolean;
  };
}

export interface PaymentBatchInput {
  connectionId: number;
  runIds: number[];
}

/** A current code from the admin's authenticator app (a code is accepted once). */
export interface PaymentApproveInput {
  code: string;
}

/**
 * Bank file batches: what the bank did. `paid` lists the items the bank paid; `failed` the ones it rejected (with
 * `reason`). With neither, every item still waiting is marked paid. `paidDate` defaults to today.
 */
export interface PaymentMarkPaidInput {
  paid?: number[];
  failed?: number[];
  reason?: string;
  paidDate?: string;
}

/**
 * On an unpaid run in GET /finance/payroll (admin only): the run's latest payment from Linear Hub — still on its way
 * (Runs to pay says so, and Mark paid waits for it), or failed with the reason. Absent when there is none.
 */
export interface PayrollRunPayment {
  batchId: number;
  itemId: number;
  status: PaymentItemStatus;
  /** The batch is still a draft (not approved yet). */
  draft: boolean;
  failureReason: string | null;
  updatedAt: string;
}

// ───────────────────────────── bank details ─────────────────────────────

/** Masked: the numbers themselves are never sent by any API. */
export interface BankDetails {
  userId: number;
  holderName: string;
  /** "••-••-34" */
  sortCodeMasked: string;
  /** "••••5678" */
  accountNumberMasked: string;
  last4: string;
  sortCodeLast2: string;
  changedAt: string;
  changedBy: number | null;
  changedByName: string | null;
  /** When an administrator last confirmed these details (null: not yet, or changed since). */
  confirmedByAdminAt: string | null;
  confirmedByName: string | null;
  /** Changed since the admin's last confirmation: payments to these details wait until the admin confirms them. */
  needsConfirmation: boolean;
}

export interface BankDetailsView {
  details: BankDetails | null;
  /** The person saving must send a current two-step code (they have two-step verification on). */
  codeRequired: boolean;
}

export interface BankDetailsInput {
  holderName: string;
  /** 6 digits; spaces and dashes are ignored ("12-34-56"). */
  sortCode: string;
  /** 8 digits; spaces are ignored. */
  accountNumber: string;
  /** A current authenticator code, when BankDetailsView.codeRequired. */
  code?: string;
}

/** Per person, on Team → person (admin): whether they can be paid from Linear Hub. */
export type BankDetailsState = 'missing' | 'needs_confirmation' | 'ready';
