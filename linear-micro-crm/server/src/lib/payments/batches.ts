/**
 * Release 1.4 — OWNED BY F payments-foundation: payment batches, from a draft to paid. docs/LOGIC.md §17.6.
 *
 *  1. Draft (createDraftBatch): from the admin's selected payroll runs and a connection. A run goes in only when it can
 *     be paid this way — unpaid (pending or failed), its week over, more than £0, its self-billing invoice accepted or
 *     deemed accepted (or no invoice: the 1.2 rules), not already in another live payment, and its person has bank
 *     details an admin has confirmed since they last changed. Every other run is skipped with a plain reason (kept on
 *     the batch). Amounts are the runs' gross, converted to pence once (shared poundsToPence).
 *  2. Approve (approveBatch): every item is checked again (run still unpaid, same amount, bank details unchanged since
 *     the draft) BEFORE the admin's fresh two-step code is used; then the batch is claimed (one approval wins) and
 *     submitted through its provider. Until package P / A builds an adapter this answers 501 and nothing changes.
 *  3. Results: an item 'paid' marks its payroll run paid through lib/markPaid.ts (the path POST
 *     /finance/payroll/:id/pay uses: invoices, pay, audit and caches behave as today), once. An item 'failed' leaves
 *     its run unpaid — status 'failed', on Runs to pay with the reason. Test-mode batches (a provider's sandbox) mark
 *     no run paid: nobody was paid.
 *  4. Refresh (refreshBatch; also every 5 minutes while anything is processing, lib/payments/job.ts): resubmits items
 *     a failed submit left queued (with the same idempotency keys, so nobody is paid twice), and asks the provider for
 *     the latest status of the rest.
 *  5. Bank files: the file is stored encrypted and downloaded (batchFile); Matt marks the items the bank paid
 *     (markFileBatchPaid) — the rest he unticks fail with a reason.
 * Never twice: the partial unique index (a run is in at most one live payment), the draft and approval checks, the
 * claim, per-item idempotency keys, and lib/markPaid.ts refusing a run already paid or on its way in a payment.
 * Review fixes (release 1.4):
 *  - The payee each item was approved with is kept with it (payee_enc, encrypted): every send, resend, check and cancel
 *    uses it, so a resend after a timeout is the same request with the same key, even if the person changed their bank
 *    details since. An approved item is never failed here because the details changed: only the provider fails it.
 *  - Linear Hub talks to the provider only in the batch's own mode: a connection switched to live (or back to test)
 *    never sends or checks a payment made in the other mode (connections.ts refuses the switch while one is on its
 *    way; this guards older data).
 *  - attempted_at: when an item was first handed to the provider. Cancel stops at once the items never sent; it waits
 *    (409) while Linear Hub does not know whether the provider made an item (sent, but no reference back yet).
 *  - A run in a payment on its way is frozen (db/maintenance.ts IN_PAYMENT_FROM); a payment that fails or is cancelled
 *    frees it and brings it up to date (lib/payRule.ts syncPersonWeek).
 * Checks before paying and safer payments:
 *  - MON-2: a live bank file counts as sent from its first download (downloaded_at). Freeing its people after that —
 *    Cancel the rest, or Mark as paid with anyone not paid — needs the typed words (FILE_NOT_UPLOADED_CONFIRMATION /
 *    FILE_NOT_PAID_CONFIRMATION) and a fresh two-step code; the items keep freed_confirmed_at and a cancelled file is
 *    void (voided_at, shown on the page and in the audit trail). A new live payment for a person-week that was in a
 *    file downloaded in the last FILE_REPEAT_DAYS days and freed WITHOUT that confirmation (1.4.0 data) is refused
 *    ('recent_file') until someone confirms the old file was not uploaded (the same cancel, on that payment).
 *  - MONEY-MISSED-2: with "Two people approve each payment" on (lib/payments/settings.ts), a live payment needs a first
 *    approval and then a second by a different administrator, each with their own fresh code; nothing is sent until
 *    the second. The page lists bonuses and adjustments added in the last 7 days to its weeks, and who added them.
 *  - MON-1 / MONEY-MISSED-3: each person carries the checks of their run (days waiting for a leader, pay resting on
 *    subs no client statement confirmed), with totals for the payment (lib/payChecks.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  FILE_NOT_PAID_CONFIRMATION,
  amountToPayPence,
  FILE_NOT_UPLOADED_CONFIRMATION,
  FILE_REPEAT_DAYS,
  batchStatusFromItems,
  defaultPaymentReference,
  formatPence,
  isTypedConfirmation,
  invoiceDeadlineText,
  isInvoicePayable,
  payDayLabel,
  payWeekLabel,
  payrollStatusFor,
  poundsToPence,
  type BankDetails,
  type PaymentBatch,
  type PaymentBatchInput,
  type PaymentBatchStatus,
  type PaymentBatchSummary,
  type PaymentItem,
  type PaymentItemStatus,
  type PaymentMarkPaidInput,
  type PaymentMode,
  type PaymentSkip,
  type PayrollRunPayment,
  type PayrollRunWithUser,
  type PaymentCancelInput,
  type PaymentRecentChange,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, placeholders, run, transaction, type Db } from '../../db/connection.ts';
import { getPayroll, getUser, listPayroll } from '../../db/queries.ts';
import { recordAudit } from '../audit.ts';
import { recordSystemEvent } from '../audit/events.ts';
import { payrollSnapshot } from '../auditSpecs.ts';
import { bumpDataVersion } from '../cache.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { addDays, businessNow, isISODate, nowISO, todayISO } from '../dates.ts';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import { invoiceVatByRun, withInvoiceSummaries } from '../invoices.ts';
import { markPayrollRunPaid } from '../markPaid.ts';
import { payrollChecksFor } from '../payChecks.ts';
import { syncPersonWeek } from '../payRule.ts';
import { decryptedBankDetails, maskedBankDetails, needsConfirmation } from './bankDetails.ts';
import { assertFreshCode } from './code.ts';
import { adapterFor, connectionRow, providerConnection, providerContext, type ConnectionRow } from './connections.ts';
import { redactSecrets } from './http.ts';
import { ProviderError, type PaymentProviderAdapter, type ProviderItem, type ProviderItemResult } from './provider.ts';
import { notReadyError } from './stubs.ts';
import { adminsWithTwoStep, paymentsSettings } from './settings.ts';
import { TRUELAYER_REPEAT_HOURS } from './truelayer.ts';

/** At most this many runs in one batch. */
export const BATCH_MAX_RUNS = 500;
const REASON_MAX = 300;

interface BatchRow {
  id: number;
  connectionId: number;
  connectionName: string;
  provider: string;
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
  fileName: string | null;
  idempotencyKey: string;
  providerRef: string | null;
  skippedJson: string | null;
  hasFile: number;
  lastError: string | null;
  updatedAt: string;
  cancelledAt: string | null;
  paidCount: number;
  failedCount: number;
  waitingCount: number;
  queuedCount: number;
  downloadedAt: string | null;
  downloadedByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  firstApprovedAt: string | null;
  firstApprovedBy: number | null;
  firstApprovedByName: string | null;
  freedUnconfirmed: number;
}

const BATCH_SELECT = `
  SELECT b.id, b.connection_id AS connectionId, c.name AS connectionName, b.provider, b.mode, b.created_at AS createdAt,
         b.created_by AS createdBy, TRIM(cu.first_name || ' ' || cu.last_name) AS createdByName, b.approved_at AS approvedAt,
         b.approved_by AS approvedBy, TRIM(au.first_name || ' ' || au.last_name) AS approvedByName, b.total_pence AS totalPence,
         b.count, b.status, b.file_name AS fileName, b.idempotency_key AS idempotencyKey, b.provider_ref AS providerRef,
         b.skipped_json AS skippedJson, (b.file_enc IS NOT NULL) AS hasFile, b.last_error AS lastError, b.updated_at AS updatedAt,
         b.cancelled_at AS cancelledAt,
         COALESCE(s.paid, 0) AS paidCount, COALESCE(s.failed, 0) AS failedCount, COALESCE(s.waiting, 0) AS waitingCount,
         COALESCE(s.queued, 0) AS queuedCount,
         b.downloaded_at AS downloadedAt, TRIM(du.first_name || ' ' || du.last_name) AS downloadedByName,
         b.voided_at AS voidedAt, TRIM(vu.first_name || ' ' || vu.last_name) AS voidedByName, b.void_reason AS voidReason,
         b.first_approved_at AS firstApprovedAt, b.first_approved_by AS firstApprovedBy, TRIM(fa.first_name || ' ' || fa.last_name) AS firstApprovedByName,
         COALESCE(s.freedUnconfirmed, 0) AS freedUnconfirmed
  FROM payment_batches b
  JOIN payment_connections c ON c.id = b.connection_id
  LEFT JOIN users cu ON cu.id = b.created_by
  LEFT JOIN users au ON au.id = b.approved_by
  LEFT JOIN users du ON du.id = b.downloaded_by
  LEFT JOIN users vu ON vu.id = b.voided_by
  LEFT JOIN users fa ON fa.id = b.first_approved_by
  LEFT JOIN (SELECT batch_id, SUM(status = 'paid') AS paid, SUM(status = 'failed') AS failed,
                    SUM(status IN ('queued', 'submitted', 'processing')) AS waiting, SUM(status = 'queued') AS queued,
                    SUM(status IN ('cancelled', 'failed') AND provider_ref IS NOT NULL AND freed_confirmed_at IS NULL) AS freedUnconfirmed
             FROM payment_items GROUP BY batch_id) s ON s.batch_id = b.id`;

interface ItemRow {
  id: number;
  batchId: number;
  payrollRunId: number;
  userId: number;
  userName: string | null;
  weekStart: string;
  runReference: string | null;
  amountPence: number;
  payeeName: string;
  accountLast4: string;
  status: PaymentItemStatus;
  providerRef: string | null;
  failureReason: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  updatedAt: string;
  note: string | null;
  live: number;
  payeeEnc: string | null;
  attemptedAt: string | null;
  runPaidDate: string | null;
  runAdjustedAt: string | null;
}

const ITEM_SELECT = `
  SELECT i.id, i.batch_id AS batchId, i.payroll_run_id AS payrollRunId, i.user_id AS userId,
         TRIM(u.first_name || ' ' || u.last_name) AS userName, i.week_start AS weekStart, p.reference AS runReference,
         i.amount_pence AS amountPence, i.payee_name AS payeeName, i.account_last4 AS accountLast4, i.status,
         i.provider_ref AS providerRef, i.failure_reason AS failureReason, i.submitted_at AS submittedAt, i.paid_at AS paidAt,
         i.updated_at AS updatedAt, i.note, i.live, i.payee_enc AS payeeEnc, i.attempted_at AS attemptedAt,
         p.paid_date AS runPaidDate, p.adjusted_at AS runAdjustedAt
  FROM payment_items i
  LEFT JOIN users u ON u.id = i.user_id
  LEFT JOIN payroll_runs p ON p.id = i.payroll_run_id`;

/** Shown on an item still on its way whose run's figures changed after the approval (the run is frozen meanwhile). */
const CHANGED_WHILE_WAITING = 'The week’s figures changed after you approved this payment. It is paid as approved: put any difference on a later week as an adjustment.';

function batchRow(db: Db, id: number): BatchRow | undefined {
  return get<BatchRow>(db, `${BATCH_SELECT} WHERE b.id = ?`, [id]);
}

function requireBatch(db: Db, id: number): BatchRow {
  const b = batchRow(db, id);
  if (!b) throw notFound('Payment');
  return b;
}

function itemRows(db: Db, batchId: number): ItemRow[] {
  return all<ItemRow>(db, `${ITEM_SELECT} WHERE i.batch_id = ? ORDER BY i.week_start, i.payee_name COLLATE NOCASE, i.id`, [batchId]);
}

const isWaiting = (s: PaymentItemStatus) => s === 'queued' || s === 'submitted' || s === 'processing';

const toItem = (r: ItemRow, approvedAt: string | null = null): PaymentItem => ({
  id: r.id,
  batchId: r.batchId,
  payrollRunId: r.payrollRunId,
  userId: r.userId,
  userName: r.userName || r.payeeName,
  weekStart: r.weekStart,
  runReference: r.runReference,
  amountPence: r.amountPence,
  payeeName: r.payeeName,
  accountLast4: r.accountLast4,
  status: r.status,
  providerRef: r.providerRef,
  failureReason: r.failureReason,
  submittedAt: r.submittedAt,
  paidAt: r.paidAt,
  updatedAt: r.updatedAt,
  note: r.note ?? (r.live && isWaiting(r.status) && approvedAt && r.runAdjustedAt && r.runAdjustedAt > approvedAt ? CHANGED_WHILE_WAITING : null),
  runPaidDate: r.status === 'paid' && r.live ? r.runPaidDate : null,
});

/** The sort code and account number an item was approved with (null: none kept, or unreadable). */
function approvedPayee(i: Pick<ItemRow, 'payeeEnc'>): { sortCode: string; accountNumber: string } | null {
  if (!i.payeeEnc) return null;
  try {
    const v = JSON.parse(decrypt(i.payeeEnc)) as { sortCode?: unknown; accountNumber?: unknown };
    return typeof v.sortCode === 'string' && typeof v.accountNumber === 'string' ? { sortCode: v.sortCode, accountNumber: v.accountNumber } : null;
  } catch {
    return null;
  }
}

/**
 * Where an approved item's money goes: the details it was approved with. An item approved before they were kept
 * (older data) uses the person's current details only while they are exactly those (unchanged since the approval,
 * confirmed, same last four digits); otherwise null and Linear Hub does not send it.
 */
function payeeFor(i: ItemRow, b: Pick<BatchRow, 'approvedAt'>, bank: ReturnType<typeof decryptedBankDetails>): { sortCode: string; accountNumber: string } | null {
  const kept = approvedPayee(i);
  if (kept || i.payeeEnc) return kept;
  const d = bank.get(i.userId);
  if (!d || needsConfirmation(d) || (b.approvedAt !== null && d.changedAt > b.approvedAt) || d.last4 !== i.accountLast4) return null;
  return { sortCode: d.sortCode, accountNumber: d.accountNumber };
}

/**
 * One item as the adapter sees it (the payee the item was approved with; empty when Linear Hub has none). `copy` 2 and
 * up: the person-week was in an earlier downloaded live bank file (MON-2), so the reference says which copy this is.
 */
function providerItem(b: Pick<BatchRow, 'idempotencyKey'>, i: ItemRow, payee: { sortCode: string; accountNumber: string } | null, copy = 1): ProviderItem {
  return {
    id: i.id, payrollRunId: i.payrollRunId, userId: i.userId, amountPence: i.amountPence, currency: 'GBP', payeeName: i.payeeName,
    sortCode: payee?.sortCode ?? '', accountNumber: payee?.accountNumber ?? '', reference: defaultPaymentReference(i.weekStart, i.payeeName, copy),
    weekStart: i.weekStart, idempotencyKey: `${b.idempotencyKey}:${i.id}`, providerRef: i.providerRef,
  };
}

/** Plain words for a batch whose connection is in the other mode now (null: same mode). */
function modeMismatch(b: Pick<BatchRow, 'id' | 'mode'>, conn: Pick<ConnectionRow, 'mode'>): string | null {
  if (conn.mode === b.mode) return null;
  return b.mode === 'test'
    ? `Payment #${b.id} was made in test mode, but the connection is now live. Linear Hub does not send or check it through the live service: switch the connection back to test mode to finish it.`
    : `Payment #${b.id} was made live, but the connection is now in test mode. Linear Hub does not send or check it through the sandbox: switch the connection back to live to finish it.`;
}

/**
 * Review fix (UI-7): why a draft cannot be approved through its connection now (null: it can, as far as the connection
 * goes). The approval answers 409 with the same words; the payment page shows them instead of a guess.
 */
function approveBlockedReason(b: Pick<BatchRow, 'mode'>, conn: ConnectionRow | undefined): string | null {
  if (!conn || conn.disconnectedAt) return 'Its connection was disconnected. Cancel this payment and make a new one.';
  if (conn.mode !== b.mode) {
    return b.mode === 'test'
      ? 'This draft was made in test mode, but the connection is now live: cancel it and make a new payment.'
      : 'This draft was made live, but the connection is now in test mode: cancel it and make a new payment.';
  }
  if (conn.status !== 'connected') return `Test the ${conn.name} connection in Settings → Payments first${conn.lastError ? ` (last time: ${conn.lastError})` : ''}.`;
  return null;
}

/**
 * Review fixes (UI-9, SD-1, SD-2, money:1): why Cancel the rest waits while Linear Hub does not know whether the
 * provider made some items (`what`: "made it", "made the transfers for Remy Rep"), saying only what is true:
 *  - "press Check now first" only when the provider can stop a payment (Wise): elsewhere a sent payment cannot be
 *    stopped from Linear Hub, so Cancel never comes back;
 *  - the week is held only by a live payment (assertNotInPayment): test mode holds nothing;
 *  - TrueLayer is not waited for past TRUELAYER_REPEAT_HOURS: the payout fails with a reason and the week is freed.
 * `then` is the advice for the cancel 409 ("press Check now, then cancel") rather than the page's.
 */
function unsureReason(p: { what: string; providerName: string; provider: string | null; canCancel: boolean; mode: PaymentMode; then?: boolean }): string {
  const X = p.providerName;
  const first = p.canCancel
    ? `Linear Hub is still finding out whether ${X} ${p.what}: press Check now${p.then ? ', then cancel' : ' first'}.`
    : `Linear Hub is still finding out whether ${X} ${p.what}. Payments sent to ${X} cannot be stopped from Linear Hub.`;
  const meanwhile = p.mode === 'test'
    ? 'Test mode: nobody is paid, so the week is not held.'
    : p.provider === 'truelayer'
      ? `If TrueLayer has still not answered ${TRUELAYER_REPEAT_HOURS} hours after the approval, Linear Hub stops trying and the week goes back to Runs to pay: check the TrueLayer Console before paying it again.`
      : `If ${X} cannot be reached, the week stays held until ${X} answers.`;
  return `${first} ${meanwhile}`;
}

/**
 * What Cancel can do with the items still waiting: `local`, queued items Linear Hub never sent (cancelled here);
 * `unsure`, items the provider may have made with no reference back yet (Check now first); `provider`, the rest.
 */
function cancelPlan(waiting: readonly ItemRow[]): { local: ItemRow[]; unsure: ItemRow[]; provider: ItemRow[] } {
  const local = waiting.filter((i) => i.status === 'queued' && !i.attemptedAt);
  const unsure = waiting.filter((i) => !local.includes(i) && (i.status === 'queued' || !i.providerRef));
  return { local, unsure, provider: waiting.filter((i) => !local.includes(i) && !unsure.includes(i)) };
}

function toSummary(b: BatchRow): PaymentBatchSummary {
  return {
    id: b.id,
    connectionId: b.connectionId,
    connectionName: b.connectionName,
    provider: b.provider,
    mode: b.mode,
    createdAt: b.createdAt,
    createdBy: b.createdBy,
    createdByName: b.createdByName || null,
    approvedAt: b.approvedAt,
    approvedBy: b.approvedBy,
    approvedByName: b.approvedByName || null,
    totalPence: b.totalPence,
    count: b.count,
    status: b.status,
    fileName: b.fileName,
    providerRef: b.providerRef,
    paidCount: Number(b.paidCount),
    failedCount: Number(b.failedCount),
    waitingCount: Number(b.waitingCount),
    queuedCount: Number(b.queuedCount),
    lastError: b.lastError,
    downloadedAt: b.downloadedAt,
    downloadedByName: b.downloadedByName || null,
    voidedAt: b.voidedAt,
    voidedByName: b.voidedByName || null,
    voidReason: b.voidReason,
    firstApprovedAt: b.firstApprovedAt,
    firstApprovedBy: b.firstApprovedBy,
    firstApprovedByName: b.firstApprovedByName || null,
  };
}

function parseSkipped(json: string | null): PaymentSkip[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as PaymentSkip[]) : [];
  } catch {
    return [];
  }
}

const kindOf = (provider: string): 'file' | 'api' => {
  try {
    return adapterFor(provider).info.kind;
  } catch {
    return 'api';
  }
};

/** Newest first. */
export function listBatches(db: Db, limit = 50): PaymentBatchSummary[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  return all<BatchRow>(db, `${BATCH_SELECT} ORDER BY b.id DESC LIMIT ${n}`).map(toSummary);
}

/** Two approvals are on, but no second administrator could give one. */
const TWO_APPROVALS_STUCK_MESSAGE = 'Two people approve each payment, but no other administrator uses two-step verification. Add one, or turn the setting off in Settings → Payments.';

/** How many approvals a payment needs: 2 for a live payment while "Two people approve each payment" is on. */
function approvalsNeeded(db: Db, b: Pick<BatchRow, 'mode' | 'firstApprovedAt'>): 1 | 2 {
  if (b.mode !== 'live') return 1;
  return b.firstApprovedAt || paymentsSettings(db).twoApprovals ? 2 : 1;
}

/** MONEY-MISSED-2: bonuses and adjustments added in the last 7 days to the weeks in this payment, newest first. */
function recentChanges(db: Db, rows: readonly ItemRow[]): PaymentRecentChange[] {
  const pairs = [...new Map(rows.map((r) => [`${r.userId}|${r.weekStart}`, r])).values()];
  if (!pairs.length) return [];
  const since = new Date(Date.parse(nowISO()) - 7 * 86_400_000).toISOString();
  return all<PaymentRecentChange & { amount: number }>(
    db,
    `SELECT a.id AS adjustmentId, a.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, a.target_week_start AS weekStart,
            a.kind, a.amount, a.note, a.created_at AS createdAt, a.created_by AS createdBy,
            CASE WHEN cb.id IS NULL THEN NULL ELSE TRIM(cb.first_name || ' ' || cb.last_name) END AS createdByName
     FROM pay_adjustments a JOIN users u ON u.id = a.user_id LEFT JOIN users cb ON cb.id = a.created_by
     WHERE a.created_at >= ? AND (${pairs.map(() => '(a.user_id = ? AND a.target_week_start = ?)').join(' OR ')})
     ORDER BY a.created_at DESC, a.id DESC`,
    [since, ...pairs.flatMap((p) => [p.userId, p.weekStart])],
  ).map((r) => ({ ...r, amount: Number(r.amount), note: r.note ?? '' }));
}

/**
 * The payment as its page shows it. `viewer` (the signed-in admin) decides whether they may give the next approval
 * (MONEY-MISSED-2: not the one who gave the first).
 */
export function batchDetail(db: Db, id: number, viewer?: Pick<UserWithTeam, 'id'>): PaymentBatch {
  const b = requireBatch(db, id);
  const rows = itemRows(db, id);
  const adapter = (() => {
    try {
      return adapterFor(b.provider);
    } catch {
      return null;
    }
  })();
  const kind = adapter?.info.kind ?? 'api';
  const conn = connectionRow(db, b.connectionId);
  const connected = !!conn && !conn.disconnectedAt && conn.status === 'connected' && conn.mode === b.mode;
  // talking to the provider about it: only through its own mode (review fix)
  const reachable = !!conn && !conn.disconnectedAt && conn.mode === b.mode;
  const waitingRows = rows.filter((i) => isWaiting(i.status));
  const waiting = waitingRows.length > 0;
  const approved = b.approvedAt !== null;
  const plan = cancelPlan(waitingRows);
  const cancelApi = plan.local.length === waitingRows.length || (!plan.unsure.length && !!adapter?.cancel && reachable);
  const cancel = b.status === 'draft' || (approved && waiting && (kind === 'file' || cancelApi));
  // MONEY-MISSED-2: the second approval is someone else's
  const needed = approvalsNeeded(db, b);
  let approveWaitsFor: string | null = null;
  if (b.status === 'draft' && needed === 2) {
    const admins = adminsWithTwoStep(db);
    if (b.firstApprovedAt && viewer && b.firstApprovedBy === viewer.id) {
      approveWaitsFor = `You gave the first approval on ${payDayLabel(b.firstApprovedAt.slice(0, 10))}: a different administrator gives the second, with their own code.${admins < 2 ? ' No other administrator uses two-step verification yet: add one, or cancel this payment and turn the setting off.' : ''}`;
    } else if (!b.firstApprovedAt && admins < 2) {
      // nobody could give the second approval: say so before anyone gives a first one that can never be completed
      approveWaitsFor = TWO_APPROVALS_STUCK_MESSAGE;
    }
  }
  const approve = b.status === 'draft' && !!adapter?.ready && connected && approveWaitsFor === null;
  // review fixes UI-7 / UI-9: why, when the button is missing (only when there is something to say)
  const approveBlocked = b.status === 'draft' && !approve && !approveWaitsFor ? approveBlockedReason(b, conn) : null;
  const unsureBlocks = !cancel && approved && kind === 'api' && plan.unsure.length > 0;
  const cancelBlocked = unsureBlocks
    ? unsureReason({ what: plan.unsure.length === 1 ? 'made it' : 'made them', providerName: conn?.name ?? 'the provider', provider: b.provider, canCancel: !!adapter?.cancel, mode: b.mode })
    : null;
  // review fix (SD-1): Cancel the rest is shown greyed out only when Check now can bring it back
  const cancelWaits = unsureBlocks && !!adapter?.cancel;
  // MON-2: a live file counts as sent from its first download
  const downloaded = kind === 'file' && b.mode === 'live' && b.downloadedAt !== null;
  const voidable = downloaded && !b.voidedAt && !waiting && Number(b.freedUnconfirmed) > 0;
  // MON-1 / MONEY-MISSED-3: what to check about each person before paying (their run as it stands)
  const checks = payrollChecksFor(db, rows.filter((r) => r.status !== 'cancelled').map((r) => ({ id: r.payrollRunId, userId: r.userId, weekStart: r.weekStart, weekEnd: addDays(r.weekStart, 6) })));
  // MON-2: an earlier downloaded file that held the same person-week (named on the page)
  const earlier = kind === 'file' && b.mode === 'live' ? earlierFiles(db, id) : null;
  const items = rows.map((r) => {
    const item: PaymentItem = toItem(r, b.approvedAt);
    const c = r.status !== 'cancelled' ? checks.get(r.payrollRunId) : undefined;
    if (c) item.checks = c;
    const e = earlier?.get(r.id);
    if (e) item.earlierFile = e;
    return item;
  });
  const counted = items.filter((i) => i.checks);
  return {
    ...toSummary(b),
    approvalsNeeded: needed,
    items,
    skipped: parseSkipped(b.skippedJson),
    kind,
    recentChanges: recentChanges(db, rows.filter((r) => r.status !== 'cancelled')),
    unconfirmedPence: counted.reduce((sum, i) => sum + Math.round((i.checks?.unconfirmed?.amount ?? 0) * 100), 0),
    unconfirmedSubs: counted.reduce((sum, i) => sum + (i.checks?.unconfirmed?.subs ?? 0), 0),
    daysWaiting: counted.reduce((sum, i) => sum + (i.checks?.daysWaiting ?? 0), 0),
    actions: {
      approve,
      cancel,
      refresh: approved && kind === 'api' && waiting && !!adapter?.ready && reachable,
      download: kind === 'file' && Boolean(b.hasFile) && b.status !== 'cancelled' && !b.voidedAt,
      markPaid: kind === 'file' && approved && items.some((i) => i.status === 'submitted' || i.status === 'processing'),
      ...(approveBlocked ? { approveBlocked } : {}),
      ...(cancelBlocked ? { cancelBlocked } : {}),
      ...(cancelWaits ? { cancelWaits } : {}),
      ...(downloaded && cancel ? { cancelNeedsConfirmation: true } : {}),
      ...(downloaded ? { markNotPaidNeedsConfirmation: true } : {}),
      ...(voidable ? { voidable: true } : {}),
      ...(approveWaitsFor ? { approveWaitsFor } : {}),
    },
  };
}

/**
 * MON-2: the first download of a bank file. From then on a LIVE file's people count as sent; a test file's download is
 * only recorded (its lines carry no real bank details, so it can pay nobody).
 */
export function recordDownload(db: Db, me: UserWithTeam, id: number): void {
  run(db, `UPDATE payment_batches SET downloaded_at = COALESCE(downloaded_at, ?), downloaded_by = COALESCE(downloaded_by, ?) WHERE id = ?`, [nowISO(), me.id, id]);
}

// ───────────────────────────── 1. the draft ─────────────────────────────

const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'They';

interface LivePaymentRow {
  runId: number;
  userId: number;
  weekStart: string;
  batchId: number;
}

/** Live payment items (not failed or cancelled, not test mode) for these runs or these people's weeks. */
function livePayments(db: Db, runIds: readonly number[], userIds: readonly number[], exceptBatch: number | null = null): LivePaymentRow[] {
  if (!runIds.length && !userIds.length) return [];
  const rIds = runIds.length ? runIds : [-1];
  const uIds = userIds.length ? userIds : [-1];
  return all<LivePaymentRow>(
    db,
    `SELECT payroll_run_id AS runId, user_id AS userId, week_start AS weekStart, batch_id AS batchId FROM payment_items
     WHERE live = 1 AND status NOT IN ('failed', 'cancelled') AND batch_id <> ?
       AND (payroll_run_id IN (${placeholders(rIds.length)}) OR user_id IN (${placeholders(uIds.length)}))`,
    [exceptBatch ?? -1, ...rIds, ...uIds],
  );
}

interface RecentFileRow {
  userId: number;
  weekStart: string;
  batchId: number;
  downloadedAt: string;
}

/**
 * MON-2: person-weeks that were in a LIVE bank file downloaded in the last FILE_REPEAT_DAYS days and were then freed
 * (cancelled, or marked not paid) WITHOUT anyone confirming the file was not used (1.4.0 data): the bank may still
 * pay them, so a new payment for them waits.
 */
function recentFiles(db: Db, userIds: readonly number[], exceptBatch: number | null = null): RecentFileRow[] {
  if (!userIds.length) return [];
  const since = new Date(Date.parse(nowISO()) - FILE_REPEAT_DAYS * 86_400_000).toISOString();
  return all<RecentFileRow & { provider: string }>(
    db,
    `SELECT i.user_id AS userId, i.week_start AS weekStart, b.id AS batchId, b.downloaded_at AS downloadedAt, b.provider
     FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id
     WHERE b.mode = 'live' AND b.downloaded_at IS NOT NULL AND b.downloaded_at >= ? AND b.id <> ?
       AND i.provider_ref IS NOT NULL AND i.status IN ('cancelled', 'failed') AND i.freed_confirmed_at IS NULL
       AND i.user_id IN (${placeholders(userIds.length)})`,
    [since, exceptBatch ?? -1, ...userIds],
  ).filter((r) => kindOf(r.provider) === 'file');
}

interface EarlierFileRow {
  itemId: number;
  batchId: number;
  provider: string;
  downloadedAt: string;
  downloadedByName: string | null;
  voidedAt: string | null;
}

/**
 * MON-2: for each item of live bank file payment `batchId`, the earlier live bank files that held the same person-week,
 * were downloaded and then let go (cancelled, or marked not paid): how many, and the latest. A new file's references
 * then say which copy it is ("LINEAR 05OCT JL 2"), so the bank's own duplicate check can tell the files apart, and the
 * page names the earlier file. One grouped read.
 */
function earlierFiles(db: Db, batchId: number): Map<number, NonNullable<PaymentItem['earlierFile']>> {
  const rows = all<EarlierFileRow>(
    db,
    `SELECT cur.id AS itemId, b.id AS batchId, b.provider, b.downloaded_at AS downloadedAt,
            TRIM(du.first_name || ' ' || du.last_name) AS downloadedByName, b.voided_at AS voidedAt
     FROM payment_items cur
     JOIN payment_batches nb ON nb.id = cur.batch_id
     JOIN payment_items i ON i.user_id = cur.user_id AND i.week_start = cur.week_start AND i.batch_id < cur.batch_id
     JOIN payment_batches b ON b.id = i.batch_id
     LEFT JOIN users du ON du.id = b.downloaded_by
     WHERE cur.batch_id = ? AND nb.mode = 'live' AND b.mode = 'live' AND b.provider = nb.provider AND b.downloaded_at IS NOT NULL
       AND i.provider_ref IS NOT NULL AND i.status IN ('cancelled', 'failed')
     ORDER BY b.id`,
    [batchId],
  ).filter((r) => kindOf(r.provider) === 'file');
  const out = new Map<number, NonNullable<PaymentItem['earlierFile']>>();
  for (const r of rows) {
    const copies = (out.get(r.itemId)?.copies ?? 0) + 1;
    out.set(r.itemId, { batchId: r.batchId, downloadedAt: r.downloadedAt, downloadedByName: r.downloadedByName || null, voidedAt: r.voidedAt, copies });
  }
  return out;
}

/** The words for a person-week held by a recent file (MON-2). */
function recentFileReason(f: RecentFileRow): string {
  const until = payDayLabel(addDays(f.downloadedAt.slice(0, 10), FILE_REPEAT_DAYS));
  return `In bank file payment #${f.batchId}, downloaded on ${payDayLabel(f.downloadedAt.slice(0, 10))} and then cancelled without confirming it was not uploaded: your bank may still pay it. Open payment #${f.batchId} and confirm it was not uploaded, or wait until ${until}`;
}

interface Candidate {
  run: PayrollRunWithUser;
  amountPence: number;
  payeeName: string;
  last4: string;
}

/**
 * Why `r` cannot be paid this way (null: it can). `live` payments of other batches, the masked bank details and today
 * come from the caller's grouped reads.
 */
function skipReason(
  r: PayrollRunWithUser,
  ctx: { today: string; live: boolean; inPayment: LivePaymentRow[]; recent: RecentFileRow[]; bank: Map<number, Pick<BankDetails, 'needsConfirmation' | 'changedAt' | 'changedBy' | 'changedByName' | 'reportedAt'>> },
): Omit<PaymentSkip, 'runId' | 'userId' | 'userName' | 'weekStart' | 'amountPence'> | null {
  const first = firstName(r.userName);
  if (r.status === 'paid' || r.status === 'late') return { code: 'already_paid', reason: `Already paid${r.paidDate ? ` on ${payDayLabel(r.paidDate)}` : ''}` };
  if (ctx.live) {
    const other = ctx.inPayment.find((p) => p.runId === r.id || (p.userId === r.userId && p.weekStart === r.weekStart));
    if (other) return { code: 'in_payment', reason: `Already in payment #${other.batchId}` };
    const file = ctx.recent.find((f) => f.userId === r.userId && f.weekStart === r.weekStart);
    if (file) return { code: 'recent_file', reason: recentFileReason(file) };
  }
  if (!(r.weekEnd < ctx.today)) return { code: 'week_not_ended', reason: `The week ends on ${payDayLabel(r.weekEnd)}: pay it after that` };
  if (!(r.gross > 0)) return { code: 'not_positive', reason: r.gross < 0 ? `The week comes to ${formatPence(poundsToPence(r.gross))}, below £0` : 'Nothing to pay: the week comes to £0.00' };
  if (r.invoice) {
    if (r.invoice.status === 'disputed') return { code: 'invoice_disputed', reason: `${first} disputed invoice ${r.invoice.number}: resolve it first in Finance → Company` };
    if (!isInvoicePayable(r.invoice.status)) return { code: 'invoice_not_accepted', reason: `Invoice ${r.invoice.number} is not accepted yet (it counts as accepted at ${invoiceDeadlineText(r.invoice.deemedAcceptedAt)})` };
  }
  const bank = ctx.bank.get(r.userId);
  if (!bank) return { code: 'no_bank_details', reason: `No bank details yet: ask ${first} to add them in Settings → Bank details` };
  if (bank.needsConfirmation) {
    const day = payDayLabel(bank.changedAt.slice(0, 10));
    // MON-3: say who has to confirm them
    if (bank.reportedAt) return { code: 'bank_details_unconfirmed', reason: `${first} reported their bank details as not theirs on ${payDayLabel(bank.reportedAt.slice(0, 10))}: type in the right ones with ${first} first` };
    if (bank.changedBy !== null && bank.changedBy !== r.userId) {
      return { code: 'bank_details_unconfirmed', reason: `${bank.changedByName ?? 'An administrator'} typed in ${first}’s bank details on ${day}: they wait until ${first} confirms them in Settings, or another administrator confirms them in Team` };
    }
    // changed_by NULL: whoever typed them in is no longer in Linear Hub (a demo account golive removed, say)
    if (bank.changedBy === null) {
      return { code: 'bank_details_unconfirmed', reason: `${first}’s bank details were changed on ${day} by someone no longer in Linear Hub: check them with ${first}, then confirm them in Team` };
    }
    return { code: 'bank_details_unconfirmed', reason: `${first} changed their bank details on ${day}: check them with ${first}, then confirm them in Team` };
  }
  return null;
}

function toIntList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw badRequest('Run ids must be whole numbers');
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function usableConnection(db: Db, connectionId: unknown): { conn: ConnectionRow; adapter: PaymentProviderAdapter } {
  const id = typeof connectionId === 'number' && Number.isSafeInteger(connectionId) && connectionId > 0 ? connectionId : null;
  if (!id) throw badRequest('Choose how to pay', [{ path: 'connectionId', message: 'Choose how to pay' }]);
  const conn = connectionRow(db, id);
  if (!conn) throw notFound('Payment connection');
  if (conn.disconnectedAt) throw conflict('This connection was disconnected. Choose another way to pay.');
  const adapter = adapterFor(conn.provider);
  if (conn.status !== 'connected') throw conflict(`Test the ${conn.name} connection in Settings → Payments first${conn.lastError ? ` (last time: ${conn.lastError})` : ''}.`);
  return { conn, adapter };
}

export function createDraftBatch(db: Db, me: UserWithTeam, input: PaymentBatchInput): PaymentBatch {
  const runIds = toIntList(input?.runIds);
  if (!runIds.length) throw badRequest('Choose the runs to pay', [{ path: 'runIds', message: 'Choose the runs to pay' }]);
  if (runIds.length > BATCH_MAX_RUNS) throw badRequest(`Pay at most ${BATCH_MAX_RUNS} runs at a time`);
  const { conn } = usableConnection(db, input?.connectionId);
  const live = conn.mode === 'live';
  const today = todayISO();
  const runs = withInvoiceSummaries(db, listPayroll(db, `WHERE p.id IN (${placeholders(runIds.length)})`, runIds), me);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const userIds = [...new Set(runs.map((r) => r.userId))];
  const inPayment = livePayments(db, runIds, userIds);
  const recent = live ? recentFiles(db, userIds) : [];
  const masked = maskedBankDetails(db, userIds);
  const bank = new Map([...masked].map(([id, d]) => [id, d]));
  const skipped: PaymentSkip[] = [];
  const pay: Candidate[] = [];
  for (const id of runIds) {
    const r = byId.get(id);
    if (!r) {
      skipped.push({ runId: id, userId: null, userName: null, weekStart: null, amountPence: null, code: 'not_found', reason: 'This pay run no longer exists' });
      continue;
    }
    const why = skipReason(r, { today, live, inPayment, recent, bank });
    // the week's pay, plus VAT when the person's self-billed invoice charges VAT (MON-7)
    const amountPence = Number.isFinite(r.gross) ? amountToPayPence(r.gross, r.invoice) : null;
    if (why) {
      skipped.push({ runId: r.id, userId: r.userId, userName: r.userName, weekStart: r.weekStart, amountPence, ...why });
      continue;
    }
    const d = masked.get(r.userId)!;
    pay.push({ run: r, amountPence: amountPence!, payeeName: d.holderName, last4: d.last4 });
  }
  if (!pay.length) throw new HttpError(400, runIds.length === 1 ? 'This run cannot be paid this way' : 'None of these runs can be paid this way', { skipped });
  pay.sort((a, b) => a.run.weekStart.localeCompare(b.run.weekStart) || a.run.userName.localeCompare(b.run.userName));
  const at = nowISO();
  const total = pay.reduce((s, c) => s + c.amountPence, 0);
  try {
    const batchId = transaction(db, () => {
      const id = run(
        db,
        `INSERT INTO payment_batches (connection_id, provider, mode, created_at, created_by, total_pence, count, status, idempotency_key, skipped_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [conn.id, conn.provider, conn.mode, at, me.id, total, pay.length, randomUUID(), JSON.stringify(skipped), at],
      ).lastInsertRowid;
      for (const c of pay) {
        run(
          db,
          `INSERT INTO payment_items (batch_id, payroll_run_id, user_id, week_start, amount_pence, payee_name, account_last4, status, updated_at, live)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          [id, c.run.id, c.run.userId, c.run.weekStart, c.amountPence, c.payeeName, c.last4, at, live ? 1 : 0],
        );
      }
      return id;
    });
    return batchDetail(db, batchId);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: payment_items/.test(e.message ?? '')) {
      throw conflict('One of these runs was put in another payment a moment ago. Refresh Runs to pay and try again.');
    }
    throw err;
  }
}

// ───────────────────────────── 2. approve and send ─────────────────────────────

/** Batches Linear Hub is talking to a provider about right now (one conversation per batch at a time). */
const busy = new Set<number>();

/** What changed since the draft, per item (empty: it can go). */
function recheck(db: Db, me: UserWithTeam, b: BatchRow, items: ItemRow[]): string[] {
  const problems: string[] = [];
  const runs = new Map(withInvoiceSummaries(db, listPayroll(db, `WHERE p.id IN (${placeholders(items.length)})`, items.map((i) => i.payrollRunId)), me).map((r) => [r.id, r]));
  const masked = maskedBankDetails(db, items.map((i) => i.userId));
  const others = b.mode === 'live' ? livePayments(db, items.map((i) => i.payrollRunId), items.map((i) => i.userId), b.id) : [];
  const recent = b.mode === 'live' ? recentFiles(db, items.map((i) => i.userId), b.id) : [];
  for (const i of items) {
    const name = i.userName || i.payeeName;
    const week = payWeekLabel(i.weekStart);
    const r = runs.get(i.payrollRunId);
    if (!r) {
      problems.push(`${name}'s pay run for ${week} no longer exists`);
      continue;
    }
    if (r.status === 'paid' || r.status === 'late') problems.push(`${name}'s pay for ${week} was marked paid${r.paidDate ? ` on ${payDayLabel(r.paidDate)}` : ''}`);
    else if (amountToPayPence(r.gross, r.invoice) !== i.amountPence) problems.push(`${name}'s pay for ${week} changed: now ${formatPence(amountToPayPence(r.gross, r.invoice))}, was ${formatPence(i.amountPence)}`);
    else if (r.invoice && !isInvoicePayable(r.invoice.status)) problems.push(`${name}'s invoice ${r.invoice.number} is ${r.invoice.status === 'disputed' ? 'disputed' : 'not accepted'} now`);
    const d = masked.get(i.userId);
    if (!d) problems.push(`${name}'s bank details were removed`);
    else if (d.changedAt > b.createdAt || d.needsConfirmation) problems.push(`${name}'s bank details changed after this payment was made`);
    if (others.some((o) => o.runId === i.payrollRunId || (o.userId === i.userId && o.weekStart === i.weekStart))) problems.push(`${name}'s pay for ${week} is in another payment now`);
    const file = recent.find((f) => f.userId === i.userId && f.weekStart === i.weekStart);
    if (file) problems.push(`${name}'s pay for ${week} was in bank file payment #${file.batchId}, which may still be paid by your bank`);
  }
  return problems;
}

export async function approveBatch(db: Db, me: UserWithTeam, id: number, code: unknown, source: string): Promise<PaymentBatch> {
  const b = requireBatch(db, id);
  if (b.status === 'cancelled') throw conflict('This payment was cancelled. Make a new one from Runs to pay.');
  if (b.status !== 'draft') throw conflict(`This payment was already approved${b.approvedAt ? ` on ${payDayLabel(b.approvedAt.slice(0, 10))}` : ''}.`);
  const conn = connectionRow(db, b.connectionId);
  // the same words the payment page shows (review fix UI-7)
  if (!conn || conn.disconnectedAt || conn.mode !== b.mode) throw conflict(approveBlockedReason(b, conn) ?? 'Cancel this payment and make a new one.');
  const adapter = adapterFor(conn.provider);
  if (!adapter.ready) throw notReadyError(adapter.info.name);
  const blocked = approveBlockedReason(b, conn);
  if (blocked) throw conflict(blocked);
  const items = itemRows(db, id).filter((i) => i.status === 'queued');
  if (!items.length) throw conflict('There is nobody left to pay in this payment.');
  // before the code is used: nothing changed since the draft
  const problems = recheck(db, me, b, items);
  // the details each payment goes to, kept with it at the approval (review fix: every resend uses exactly these)
  const bank = decryptedBankDetails(db, items.map((i) => i.userId));
  for (const i of items) {
    const d = bank.get(i.userId);
    const name = i.userName || i.payeeName;
    // (the same words as recheck's, so a problem is listed once)
    if (!d) problems.push(`${name}'s bank details were removed`);
    else if (d.last4 !== i.accountLast4) problems.push(`${name}'s bank details changed after this payment was made`);
  }
  if (problems.length) {
    const unique = [...new Set(problems)];
    throw new HttpError(409, `Things changed since this payment was made: ${unique.slice(0, 3).join('; ')}${unique.length > 3 ? ` (and ${unique.length - 3} more)` : ''}. Cancel it and make a new one.`, { code: 'batch_changed', problems: unique });
  }
  // MONEY-MISSED-2: two people approve a live payment — the second must be someone else, each with their own code
  const two = approvalsNeeded(db, b) === 2;
  if (two && b.firstApprovedBy === me.id) throw conflict('You gave the first approval: a different administrator gives the second, with their own code.');
  if (two && !b.firstApprovedAt && adminsWithTwoStep(db) < 2) throw conflict(TWO_APPROVALS_STUCK_MESSAGE);
  assertFreshCode(db, me, code, source, { required: true });
  if (two && !b.firstApprovedAt) {
    const firstAt = nowISO();
    const n = run(db, `UPDATE payment_batches SET first_approved_at = ?, first_approved_by = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND first_approved_at IS NULL`, [firstAt, me.id, firstAt, id]).changes;
    if (!n) throw conflict('Someone gave the first approval a moment ago.');
    bumpDataVersion();
    return batchDetail(db, id, me);
  }
  const at = nowISO();
  // one approval wins, even if two arrive together; the winner keeps each payee with its item
  const claimed = transaction(db, () => {
    const n = run(db, `UPDATE payment_batches SET approved_at = ?, approved_by = ?, status = 'submitted', updated_at = ? WHERE id = ? AND status = 'draft'`, [at, me.id, at, id]).changes;
    if (!n) return 0;
    for (const i of items) {
      const d = bank.get(i.userId)!;
      run(db, `UPDATE payment_items SET payee_enc = ? WHERE id = ? AND status = 'queued'`, [encrypt(JSON.stringify({ sortCode: d.sortCode, accountNumber: d.accountNumber })), i.id]);
    }
    return n;
  });
  if (!claimed) throw conflict('This payment was approved a moment ago.');
  await sendQueued(db, id, me, `POST /payments/batches/:id/approve`);
  return batchDetail(db, id, me);
}

const plain = (err: unknown, secrets: readonly string[]): string => {
  const text = err instanceof ProviderError || err instanceof HttpError ? err.message : `Something went wrong talking to the provider: ${String((err as Error)?.message ?? err)}`;
  return redactSecrets(text, secrets).slice(0, 500);
};

/**
 * Sends the batch's queued items (approval, or a retry after a submit that threw), each to the payee it was approved
 * with and with its own key. Only through the batch's own mode, and never once a cancel was asked for.
 */
async function sendQueued(db: Db, id: number, actor: UserWithTeam | null, action: string | null): Promise<void> {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    const b = requireBatch(db, id);
    const conn = connectionRow(db, b.connectionId);
    if (!conn || conn.disconnectedAt || b.cancelledAt) return;
    const mismatch = modeMismatch(b, conn);
    if (mismatch) {
      run(db, `UPDATE payment_batches SET last_error = ? WHERE id = ?`, [mismatch, id]);
      return;
    }
    const adapter = adapterFor(conn.provider);
    const queued = itemRows(db, id).filter((i) => i.status === 'queued');
    if (!queued.length) return;
    const bank = decryptedBankDetails(db, queued.map((i) => i.userId));
    const earlier = adapter.info.kind === 'file' ? earlierFiles(db, id) : new Map<number, NonNullable<PaymentItem['earlierFile']>>();
    const send: ProviderItem[] = [];
    const held: string[] = [];
    for (const i of queued) {
      const payee = payeeFor(i, b, bank);
      // an approved item is never failed here: without the details it was approved with, it waits (older data)
      if (!payee) {
        held.push(i.userName || i.payeeName);
        continue;
      }
      send.push(providerItem(b, i, payee, 1 + (earlier.get(i.id)?.copies ?? 0)));
    }
    const heldText = held.length
      ? `Linear Hub did not send ${held.join(', ')}'s payment again: it no longer has the bank details you approved it with. Check with ${conn.name} whether it was paid before you pay that week again.`
      : null;
    if (heldText && !send.length) run(db, `UPDATE payment_batches SET last_error = ? WHERE id = ?`, [heldText, id]);
    if (send.length) {
      const pc = providerConnection(conn);
      const secrets = [...Object.values(pc.secrets), ...send.map((s) => s.accountNumber)];
      // from here the provider may have them: Cancel waits until Linear Hub knows (cancelPlan)
      const at = nowISO();
      run(db, `UPDATE payment_items SET attempted_at = ? WHERE attempted_at IS NULL AND id IN (${placeholders(send.length)})`, [at, ...send.map((s) => s.id)]);
      try {
        // the batch's times on the real clock, the one adapters compare them with (review fix cross:X-1: a pinned
        // LM_BUSINESS_NOW must not make a fresh approval look old to a provider's idempotency window)
        const real = (iso: string) => new Date(Date.parse(iso) - (businessNow().getTime() - Date.now())).toISOString();
        const out = await adapter.submit(pc, { id: b.id, mode: b.mode, idempotencyKey: b.idempotencyKey, createdAt: real(b.createdAt), today: todayISO(), approvedAt: b.approvedAt ? real(b.approvedAt) : null }, send, providerContext(db, conn.id));
        applyResults(db, b, out.items, actor, action);
        if (out.file) {
          const name = out.file.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || `linear-hub-payment-${b.id}.csv`;
          run(db, `UPDATE payment_batches SET file_enc = ?, file_name = ? WHERE id = ?`, [encrypt(JSON.stringify({ name, contentType: out.file.contentType, body: out.file.body })), name, id]);
        }
        // package A: items the adapter could not send this time stay queued; its reason is the batch's last error
        const notSent = typeof out.error === 'string' && out.error.trim() ? redactSecrets(out.error, secrets).slice(0, 500) : null;
        run(db, `UPDATE payment_batches SET provider_ref = COALESCE(?, provider_ref), last_error = ? WHERE id = ?`, [out.providerRef ?? null, notSent ?? heldText, id]);
      } catch (err) {
        // the items stay queued: Try again (or the next job tick) sends them with the same keys
        run(db, `UPDATE payment_batches SET last_error = ?, updated_at = ? WHERE id = ?`, [plain(err, secrets), nowISO(), id]);
      }
    }
    finalise(db, id);
  } finally {
    busy.delete(id);
    bumpDataVersion();
  }
}

/** The batch's status from its items (approved batches only). */
function finalise(db: Db, id: number): void {
  const b = requireBatch(db, id);
  if (b.status === 'draft') return;
  const statuses = all<{ status: PaymentItemStatus }>(db, `SELECT status FROM payment_items WHERE batch_id = ?`, [id]).map((r) => r.status);
  const next = batchStatusFromItems(statuses);
  if (next !== b.status) run(db, `UPDATE payment_batches SET status = ?, updated_at = ? WHERE id = ?`, [next, nowISO(), id]);
}

const WAITING: readonly PaymentItemStatus[] = ['queued', 'submitted', 'processing'];

function applyResults(db: Db, b: BatchRow, results: readonly ProviderItemResult[], actor: UserWithTeam | null, action: string | null): void {
  const items = new Map(itemRows(db, b.id).map((i) => [i.id, i]));
  for (const r of results) {
    const i = items.get(r.itemId);
    if (!i || !WAITING.includes(i.status)) continue; // only items still on their way move
    const ref = typeof r.providerRef === 'string' && r.providerRef ? r.providerRef.slice(0, 200) : i.providerRef;
    const at = nowISO();
    if (r.status === 'submitted' || r.status === 'processing') {
      run(db, `UPDATE payment_items SET status = ?, provider_ref = ?, submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?`, [r.status, ref, at, at, i.id]);
    } else if (r.status === 'failed') {
      run(db, `UPDATE payment_items SET provider_ref = ?, submitted_at = COALESCE(submitted_at, ?) WHERE id = ?`, [ref, at, i.id]);
      failItem(db, b, i, String(r.failureReason ?? '').trim() || 'The provider did not pay this one', actor, action);
    } else if (r.status === 'paid') {
      run(db, `UPDATE payment_items SET provider_ref = ?, submitted_at = COALESCE(submitted_at, ?) WHERE id = ?`, [ref, at, i.id]);
      settlePaid(db, b, i, todayISO(), actor, action);
    }
  }
}

/** Records one row for a run a payment moved: by the admin (`action` given) or by Linear Hub itself. */
function recordRun(db: Db, actor: UserWithTeam | null, action: string | null, runId: number, summary: string, before: unknown, after: unknown): void {
  try {
    if (actor && action) recordAudit(db, { userId: actor.id, action, entity: 'payroll_run', entityId: runId, summary, before, after, actorRole: actor.role });
    else recordSystemEvent(db, { name: 'payments.run', summary, entity: 'payroll_run', entityId: runId, after });
  } catch (err) {
    console.error('Audit trail (payment run row) failed; the payment was not affected', err);
  }
}

function failItem(db: Db, b: BatchRow, i: ItemRow, reason: string, actor: UserWithTeam | null, action: string | null): void {
  const at = nowISO();
  const why = reason.slice(0, REASON_MAX);
  run(db, `UPDATE payment_items SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'submitted', 'processing')`, [why, at, i.id]);
  if (!i.live) return;
  // a failed transfer: the run stays unpaid, flagged on Runs to pay (pending → failed), with the reason (GET /finance/payroll)
  const before = payrollSnapshot(db, i.payrollRunId);
  run(db, `UPDATE payroll_runs SET status = 'failed' WHERE id = ? AND status = 'pending'`, [i.payrollRunId]);
  // no longer held: anything that changed while the payment was on its way comes in now
  resyncFreed(db, i);
  const after = payrollSnapshot(db, i.payrollRunId);
  recordRun(db, actor, action, i.payrollRunId, `Payment #${b.id} failed: ${i.userName || i.payeeName} ${payWeekLabel(i.weekStart)}, ${formatPence(i.amountPence)}. ${why}`, before, after);
}

/**
 * A run a payment no longer holds picks up what changed while it was frozen (db/maintenance.ts IN_PAYMENT_FROM): only
 * a run flagged then (adjusted_at, set whenever the pay rules found other figures), so an unchanged run stays as it is.
 */
function resyncFreed(db: Db, i: Pick<ItemRow, 'userId' | 'weekStart' | 'payrollRunId'>): void {
  const flagged = get<{ at: string | null }>(db, `SELECT adjusted_at AS at FROM payroll_runs WHERE id = ? AND status IN ('pending', 'failed')`, [i.payrollRunId]);
  if (!flagged?.at) return;
  try {
    syncPersonWeek(db, i.userId, i.weekStart);
  } catch (err) {
    console.error('Payments: bringing a pay run up to date after its payment failed did not work; it keeps its figures', err);
  }
}

/** An item the provider (or the bank, for a file) paid: its run is marked paid once, through lib/markPaid.ts. */
function settlePaid(db: Db, b: BatchRow, i: ItemRow, paidDate: string, actor: UserWithTeam | null, action: string | null): void {
  const at = nowISO();
  const done = run(db, `UPDATE payment_items SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'submitted', 'processing')`, [at, at, i.id]).changes;
  if (!done) return;
  const note = (text: string) => run(db, `UPDATE payment_items SET note = ? WHERE id = ?`, [text.slice(0, 500), i.id]);
  if (!i.live) {
    note('Test mode: nobody was paid, so this week stays on Runs to pay.');
    return;
  }
  const name = i.userName || i.payeeName;
  const runNow = getPayroll(db, i.payrollRunId) ?? (() => {
    const again = get<{ id: number }>(db, `SELECT id FROM payroll_runs WHERE user_id = ? AND week_start = ?`, [i.userId, i.weekStart]);
    return again ? getPayroll(db, again.id) : undefined;
  })();
  if (!runNow) {
    note(`The pay run was removed after the money was sent. Check ${firstName(name)}'s pay.`);
    recordSystemEvent(db, { name: 'payments.orphan', summary: `Payment #${b.id} paid ${name} ${formatPence(i.amountPence)} for ${payWeekLabel(i.weekStart)}, but that pay run no longer exists`, entity: 'payment_batch', entityId: b.id });
    return;
  }
  if (runNow.status === 'paid' || runNow.status === 'late') {
    note(`This week was already marked paid${runNow.paidDate ? ` on ${payDayLabel(runNow.paidDate)}` : ''}. Check with ${firstName(name)} whether they were paid twice.`);
    return;
  }
  const notes: string[] = [];
  // the run was frozen while the money was on its way (review fix): what changed is for a later week
  if (runNow.adjustedAt && b.approvedAt && runNow.adjustedAt > b.approvedAt) {
    notes.push(`The week’s figures changed while the money was on its way: ${formatPence(i.amountPence)} was paid, as approved. Put any difference on a later week as an adjustment.`);
  }
  const nowPence = amountToPayPence(runNow.gross, { vatAmount: invoiceVatByRun(db, [runNow.id]).get(runNow.id) ?? null });
  if (nowPence !== i.amountPence) notes.push(`Sent ${formatPence(i.amountPence)}; the week now comes to ${formatPence(nowPence)}. Add an adjustment for the difference on a later week.`);
  const before = payrollSnapshot(db, runNow.id);
  const date = paidDate < runNow.weekEnd ? addDays(runNow.weekEnd, 1) : paidDate;
  const approver = actor ?? (b.approvedBy ? getUser(db, b.approvedBy) : undefined) ?? null;
  try {
    if (!approver) throw new HttpError(409, 'the person who approved it no longer has an account');
    markPayrollRunPaid(db, runNow.id, { paidDate: date, actor: approver, body: {}, paymentItemId: i.id });
  } catch (err) {
    // the money has gone: the run is marked paid whatever the invoice or the rules say now, so nobody pays it again
    const today = todayISO();
    const when = date > today ? today : date;
    run(db, `UPDATE payroll_runs SET paid_date = ?, status = ? WHERE id = ? AND status IN ('pending', 'failed')`, [when, payrollStatusFor(runNow.dueDate, when, today), runNow.id]);
    const code = err instanceof HttpError && err.details && typeof err.details === 'object' ? String((err.details as { code?: unknown }).code ?? '') : '';
    notes.push(code.startsWith('invoice_')
      ? 'Marked paid although the invoice was not accepted at that moment (it changed after you approved the payment): the money had already gone.'
      : `Marked paid without the usual checks, because the money had already gone (${err instanceof Error ? err.message.replace(/\.$/, '') : 'a check said no'}).`);
  }
  if (notes.length) note(notes.join(' '));
  const after = payrollSnapshot(db, runNow.id);
  recordRun(db, actor, action, runNow.id, `Marked paid by payment #${b.id}: ${name} ${payWeekLabel(i.weekStart)}, ${formatPence(i.amountPence)}`, before, after);
}

// ───────────────────────────── 4. refresh ─────────────────────────────

/** Resubmits queued items and asks the provider about the rest. `actor` null: the 5-minute job. */
export async function refreshBatch(db: Db, id: number, actor: UserWithTeam | null): Promise<PaymentBatch> {
  const b = requireBatch(db, id);
  if (b.status === 'draft') throw conflict('Approve this payment first.');
  const conn = connectionRow(db, b.connectionId);
  if (!conn) throw notFound('Payment connection');
  const adapter = adapterFor(conn.provider);
  if (adapter.info.kind === 'file') throw conflict('A bank file is not checked automatically: mark it paid once your bank has paid it.');
  if (!adapter.ready) throw notReadyError(adapter.info.name);
  const action = actor ? 'POST /payments/batches/:id/refresh' : null;
  if (conn.disconnectedAt) throw conflict('Its connection was disconnected, so Linear Hub cannot check it any more. Check the payments with the provider.');
  // never through the other mode's service (review fix): the payment page says why
  const mismatch = modeMismatch(b, conn);
  if (mismatch) {
    run(db, `UPDATE payment_batches SET last_error = ? WHERE id = ?`, [mismatch, id]);
    bumpDataVersion();
    throw conflict(mismatch);
  }
  await sendQueued(db, id, actor, action);
  if (busy.has(id)) return batchDetail(db, id);
  const waiting = itemRows(db, id).filter((i) => i.status === 'submitted' || i.status === 'processing');
  if (!waiting.length) return batchDetail(db, id);
  busy.add(id);
  try {
    const bank = decryptedBankDetails(db, waiting.map((i) => i.userId));
    const pc = providerConnection(conn);
    const items: ProviderItem[] = waiting.map((i) => providerItem(b, i, payeeFor(i, b, bank)));
    const secrets = [...Object.values(pc.secrets), ...items.map((x) => x.accountNumber)];
    try {
      const out = await adapter.refresh(pc, items, providerContext(db, conn.id));
      applyResults(db, requireBatch(db, id), out, actor, action);
      // the reason items were left queued stands while any still are
      run(db, `UPDATE payment_batches SET last_error = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM payment_items WHERE batch_id = ? AND status = 'queued')`, [id, id]);
    } catch (err) {
      run(db, `UPDATE payment_batches SET last_error = ?, updated_at = ? WHERE id = ?`, [plain(err, secrets), nowISO(), id]);
    }
    finalise(db, id);
  } finally {
    busy.delete(id);
    bumpDataVersion();
  }
  return batchDetail(db, id);
}

/** The job: every approved API batch with something still on its way. Returns how many were checked. */
export async function refreshWaitingBatches(db: Db): Promise<number> {
  const ids = all<{ id: number; provider: string }>(db, `SELECT id, provider FROM payment_batches WHERE status IN ('submitted', 'processing') AND approved_at IS NOT NULL ORDER BY id`);
  let n = 0;
  for (const { id, provider } of ids) {
    const a = (() => {
      try {
        return adapterFor(provider);
      } catch {
        return null;
      }
    })();
    if (!a || !a.ready || a.info.kind !== 'api') continue;
    try {
      await refreshBatch(db, id, null);
      n++;
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(`Payments: checking payment #${id} failed`, err);
    }
  }
  return n;
}

// ───────────────────────────── cancel, file, mark paid ─────────────────────────────

/**
 * MON-2: freeing the people of a live bank file after its download needs the typed words and a fresh code (400 with
 * `confirmationNeeded` otherwise). Checked before anything changes.
 */
function assertFileFreedConfirmed(db: Db, me: UserWithTeam, b: BatchRow, input: { confirm?: unknown; code?: unknown } | undefined, source: string, phrase: string, what: string): void {
  if (!isTypedConfirmation(input?.confirm, phrase)) {
    const day = b.downloadedAt ? payDayLabel(b.downloadedAt.slice(0, 10)) : 'an earlier day';
    throw new HttpError(400, `This bank file was downloaded on ${day}, so its people count as sent. ${what} type ${phrase} and the code from your authenticator app.`, {
      code: 'confirmation_needed', confirmationNeeded: phrase, details: [{ path: 'confirm', message: `Type ${phrase}` }],
    });
  }
  assertFreshCode(db, me, input?.code, source, { required: true });
}

export async function cancelBatch(db: Db, me: UserWithTeam, id: number, input?: PaymentCancelInput, source = 'unknown'): Promise<PaymentBatch> {
  const b = requireBatch(db, id);
  const at = nowISO();
  if (b.status === 'draft') {
    transaction(db, () => {
      run(db, `UPDATE payment_items SET status = 'cancelled', updated_at = ? WHERE batch_id = ? AND status = 'queued'`, [at, id]);
      run(db, `UPDATE payment_batches SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ? WHERE id = ? AND status = 'draft'`, [at, me.id, at, id]);
    });
    return batchDetail(db, id, me);
  }
  const items = itemRows(db, id).filter((i) => WAITING.includes(i.status));
  const conn = connectionRow(db, b.connectionId);
  const adapter = conn ? adapterFor(conn.provider) : null;
  const file = (adapter?.info.kind ?? kindOf(b.provider)) === 'file';
  const downloaded = file && b.mode === 'live' && b.downloadedAt !== null;
  const unconfirmed = downloaded && !b.voidedAt ? Number(b.freedUnconfirmed) : 0;
  if (!items.length && !unconfirmed) throw conflict('Nothing in this payment is still waiting, so there is nothing to cancel.');
  if (file) {
    // MON-2: after its download the file may be in the bank: only the admin's word (typed, with a code) frees it
    if (downloaded) assertFileFreedConfirmed(db, me, b, input, source, FILE_NOT_UPLOADED_CONFIRMATION, 'Only if you did NOT upload it to your bank (or the bank paid none of it),');
    transaction(db, () => {
      // the file was not used (or not for these people): they stay unpaid on Runs to pay
      run(db, `UPDATE payment_items SET status = 'cancelled', updated_at = ? WHERE batch_id = ? AND status IN ('queued', 'submitted', 'processing')`, [at, id]);
      run(db, `UPDATE payment_batches SET cancelled_at = COALESCE(cancelled_at, ?), cancelled_by = COALESCE(cancelled_by, ?) WHERE id = ?`, [at, me.id, id]);
      if (downloaded) {
        run(db, `UPDATE payment_items SET freed_confirmed_at = ?, freed_by = ? WHERE batch_id = ? AND status IN ('cancelled', 'failed') AND freed_confirmed_at IS NULL`, [at, me.id, id]);
        run(db, `UPDATE payment_batches SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?`, [at, me.id, 'Confirmed not uploaded to the bank (or not paid by it)', id]);
      }
    });
    for (const i of items) if (i.live) resyncFreed(db, i);
    finalise(db, id);
    bumpDataVersion();
    return batchDetail(db, id, me);
  }
  if (!items.length) throw conflict('Nothing in this payment is still waiting, so there is nothing to cancel.');
  const providerName = conn?.name ?? 'the provider';
  const plan = cancelPlan(items);
  // review fix: never "Cancelled" while the provider may have made a payment Linear Hub has no reference for
  if (plan.unsure.length) {
    const names = [...new Set(plan.unsure.map((i) => i.userName || i.payeeName))];
    const noun = conn?.provider === 'wise' ? 'transfer' : 'payment';
    // review fixes (UI-9, SD-1, SD-2, money:1): and what happens meanwhile, the same words as the page's
    const what = `made the ${noun}${plan.unsure.length === 1 ? '' : 's'} for ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
    throw conflict(unsureReason({ what, providerName, provider: b.provider, canCancel: !!adapter?.cancel, mode: b.mode, then: true }));
  }
  const canStop = !!adapter?.cancel && !!conn && !conn.disconnectedAt && conn.mode === b.mode;
  if (plan.provider.length && !canStop && !plan.local.length) {
    throw conflict(conn && !conn.disconnectedAt && conn.mode !== b.mode
      ? modeMismatch(b, conn)!
      : `Payments already sent to ${providerName} cannot be stopped from Linear Hub. Check them with the provider.`);
  }
  if (busy.has(id)) throw conflict('Linear Hub is talking to the provider about this payment right now. Try again in a moment.');
  const action = 'POST /payments/batches/:id/cancel';
  const stoppedBefore = items.length;
  busy.add(id);
  try {
    // never sent: nothing to ask anyone, they stop here and their weeks stay on Runs to pay
    if (plan.local.length) {
      run(db, `UPDATE payment_items SET status = 'cancelled', updated_at = ? WHERE status = 'queued' AND attempted_at IS NULL AND id IN (${placeholders(plan.local.length)})`, [at, ...plan.local.map((i) => i.id)]);
      for (const i of plan.local) if (i.live) resyncFreed(db, i);
    }
    if (plan.provider.length && canStop && adapter?.cancel && conn) {
      const bank = decryptedBankDetails(db, plan.provider.map((i) => i.userId));
      const pc = providerConnection(conn);
      const out = await adapter.cancel(pc, plan.provider.map((i) => providerItem(b, i, payeeFor(i, b, bank))), providerContext(db, conn.id));
      applyResults(db, b, out, me, action);
    }
    const left = itemRows(db, id).filter((i) => WAITING.includes(i.status)).length;
    // only when something actually stopped (Wise may refuse: the transfer is already being paid)
    if (left < stoppedBefore) run(db, `UPDATE payment_batches SET cancelled_at = ?, cancelled_by = ? WHERE id = ?`, [at, me.id, id]);
    finalise(db, id);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw conflict(plain(err, []));
  } finally {
    busy.delete(id);
    bumpDataVersion();
  }
  return batchDetail(db, id, me);
}

export interface BatchFile {
  name: string;
  contentType: string;
  body: string;
}

/** The bank file to download (404 when there is none). */
export function batchFile(db: Db, id: number): BatchFile {
  const row = get<{ fileEnc: string | null; status: string }>(db, `SELECT file_enc AS fileEnc, status FROM payment_batches WHERE id = ?`, [id]);
  if (!row) throw notFound('Payment');
  if (!row.fileEnc || row.status === 'cancelled') throw notFound('Payment file');
  try {
    const f = JSON.parse(decrypt(row.fileEnc)) as BatchFile;
    return { name: f.name, contentType: f.contentType || 'text/csv; charset=utf-8', body: f.body };
  } catch {
    throw new HttpError(500, 'The payment file could not be read (the app secret changed?). Cancel this payment and make a new one.');
  }
}

export function markFileBatchPaid(db: Db, me: UserWithTeam, id: number, input: PaymentMarkPaidInput, source = 'unknown'): PaymentBatch {
  const b = requireBatch(db, id);
  if (kindOf(b.provider) !== 'file') throw conflict(`Linear Hub learns this from ${b.connectionName} by itself: use Check now.`);
  if (b.status === 'draft') throw conflict('Approve this payment first.');
  const waiting = itemRows(db, id).filter((i) => i.status === 'submitted' || i.status === 'processing');
  if (!waiting.length) throw conflict('Nothing in this payment is waiting to be marked paid.');
  const ids = new Set(waiting.map((i) => i.id));
  const paid = input?.paid !== undefined ? toIntList(input.paid) : null;
  const failed = input?.failed !== undefined ? toIntList(input.failed) : [];
  const paidIds = paid ?? (failed.length ? [] : [...ids]);
  for (const x of [...paidIds, ...failed]) if (!ids.has(x)) throw badRequest('Choose people from this payment who are still waiting');
  if (paidIds.some((x) => failed.includes(x))) throw badRequest('Someone cannot be both paid and not paid');
  if (!paidIds.length && !failed.length) throw badRequest('Choose who the bank paid');
  const today = todayISO();
  const paidDate = input?.paidDate ?? today;
  if (!isISODate(paidDate)) throw badRequest('The paid date must be a date formatted YYYY-MM-DD');
  if (paidDate > today) throw badRequest('The paid date cannot be in the future');
  const byId = new Map(waiting.map((i) => [i.id, i]));
  for (const x of paidIds) {
    const weekEnd = addDays(byId.get(x)!.weekStart, 6);
    if (paidDate < weekEnd) throw badRequest(`The paid date cannot be before the pay week ends (${payDayLabel(weekEnd)})`);
  }
  const reasonRaw = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reasonRaw.length > REASON_MAX) throw badRequest(`Keep the reason under ${REASON_MAX} characters`);
  const reason = reasonRaw || 'The bank did not pay this one';
  // MON-2: after the download, saying the bank did NOT pay someone frees their week: the typed words and a fresh code
  const downloaded = b.mode === 'live' && b.downloadedAt !== null;
  if (failed.length && downloaded) assertFileFreedConfirmed(db, me, b, input, source, FILE_NOT_PAID_CONFIRMATION, 'Only if your bank did NOT pay the people you unticked,');
  const action = 'POST /payments/batches/:id/mark-paid';
  // one item at a time (each step is guarded by its own conditional update; the invoice hook may hold a transaction)
  for (const x of paidIds) settlePaid(db, b, byId.get(x)!, paidDate, me, action);
  for (const x of failed) failItem(db, b, byId.get(x)!, reason, me, action);
  if (failed.length && downloaded) run(db, `UPDATE payment_items SET freed_confirmed_at = ?, freed_by = ? WHERE id IN (${placeholders(failed.length)}) AND status = 'failed'`, [nowISO(), me.id, ...failed]);
  finalise(db, id);
  bumpDataVersion();
  return batchDetail(db, id, me);
}

// ───────────────────────────── Runs to pay ─────────────────────────────

/**
 * GET /finance/payroll (admin): each unpaid run's latest payment from Linear Hub — live items only, newest first —
 * in one grouped query. Runs without one are unchanged.
 */
export function withPaymentStatus<T extends PayrollRunWithUser>(db: Db, runs: T[], me: UserWithTeam): T[] {
  if (me.role !== 'admin') return runs;
  const unpaid = runs.filter((r) => r.status === 'pending' || r.status === 'failed');
  if (!unpaid.length) return runs;
  const ids = unpaid.map((r) => r.id);
  const rows = all<{ runId: number; itemId: number; batchId: number; status: PaymentItemStatus; batchStatus: string; failureReason: string | null; updatedAt: string }>(
    db,
    `SELECT i.payroll_run_id AS runId, i.id AS itemId, i.batch_id AS batchId, i.status, b.status AS batchStatus, i.failure_reason AS failureReason, i.updated_at AS updatedAt
     FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id
     WHERE i.live = 1 AND i.status <> 'cancelled' AND i.payroll_run_id IN (${placeholders(ids.length)})
     ORDER BY i.id DESC`,
    ids,
  );
  const latest = new Map<number, PayrollRunPayment>();
  for (const r of rows) {
    if (latest.has(r.runId)) continue;
    latest.set(r.runId, { batchId: r.batchId, itemId: r.itemId, status: r.status, draft: r.batchStatus === 'draft', failureReason: r.failureReason, updatedAt: r.updatedAt });
  }
  if (!latest.size) return runs;
  return runs.map((r) => (latest.has(r.id) && (r.status === 'pending' || r.status === 'failed') ? { ...r, payment: latest.get(r.id)! } : r));
}
