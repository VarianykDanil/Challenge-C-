/**
 * Release 1.4 (F payments-foundation): "Mark paid" for one payroll run, moved out of POST /finance/payroll/:id/pay
 * unchanged so that a payment made from Linear Hub marks its run paid through exactly the same path — the same checks,
 * the same invoice hook (lib/invoices.ts assertInvoicePayable), the same UPDATE. The route answers what this returns;
 * the audit row is written by the route's audit spec (lib/audit/invoiceSpecs.ts), or by lib/payments/batches.ts for a
 * payment, and the response cache is cleared by the write middleware (the route) or by the caller (a payment).
 */
import { payMoney, payWeekLabel, payrollStatusFor, type PayrollRunWithUser, type UserWithTeam } from '@lm/shared';
import { z } from 'zod';
import { get, run, type Db } from '../db/connection.ts';
import { getPayroll } from '../db/queries.ts';
import { todayISO } from './dates.ts';
import { HttpError, badRequest, conflict, notFound } from './errors.ts';
import { assertInvoicePayable } from './invoices.ts';
import { isoDate } from './validate.ts';

export interface MarkPaidOptions {
  /** YYYY-MM-DD; default: the body's `paidDate`, else today (business clock). */
  paidDate?: string;
  /** Who marks it paid (an admin). */
  actor: UserWithTeam;
  /** The request body, for the invoice hook's `overrideReason` (a payment passes {}). */
  body?: unknown;
  /** Release 1.4: the payment item marking it paid (its own approved payment does not hold the run). */
  paymentItemId?: number;
}

/**
 * Release 1.4 (F): a run whose payment from Linear Hub is approved and still on its way cannot be marked paid by hand
 * (it would be paid twice): 409 until the payment finishes or is cancelled. Drafts do not hold a run (approving a draft
 * checks again).
 */
export function assertNotInPayment(db: Db, run_: PayrollRunWithUser, exceptItemId?: number): void {
  const live = get<{ batchId: number }>(
    db,
    `SELECT i.batch_id AS batchId FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id
     WHERE i.live = 1 AND i.status IN ('queued', 'submitted', 'processing') AND b.status <> 'draft' AND i.id <> ?
       AND (i.payroll_run_id = ? OR (i.user_id = ? AND i.week_start = ?))
     LIMIT 1`,
    [exceptItemId ?? -1, run_.id, run_.userId, run_.weekStart],
  );
  if (live) {
    const first = run_.userName.split(' ')[0] ?? run_.userName;
    throw new HttpError(409, `${first}'s pay for ${payWeekLabel(run_.weekStart)} is in payment #${live.batchId}, which is still on its way. Wait for it to finish, or cancel it, before marking the week paid by hand.`, { code: 'in_payment', batchId: live.batchId });
  }
}

/** Marks one unpaid (pending or failed) run paid; 404 / 409 / 400 exactly as POST /finance/payroll/:id/pay. */
export function markPayrollRunPaid(db: Db, id: number, opts: MarkPaidOptions): PayrollRunWithUser {
  const existing = getPayroll(db, id);
  if (!existing) throw notFound('Payroll run');
  // pending AND failed runs can be paid; only money that already landed is refused
  if (existing.status === 'paid' || existing.status === 'late') throw conflict(`Payroll run ${existing.reference} was already paid on ${existing.paidDate}`);
  const paidDate = opts.paidDate ?? z.object({ paidDate: isoDate.optional() }).parse(opts.body ?? {}).paidDate;
  const today = todayISO();
  const date = paidDate ?? today;
  // money cannot land before the pay week has ended, nor on a day that has not happened yet
  if (date > today) throw badRequest('paidDate cannot be in the future');
  if (date < existing.weekEnd) throw badRequest(`paidDate cannot be before the pay week ends (${existing.weekEnd})`);
  const status = payrollStatusFor(existing.dueDate, date, today); // 'paid' or 'late'
  // Release 1.3 (P1): corrections bigger than the week's pay leave a run below £0 — money is owed, not paid
  if (existing.gross < 0) {
    const first = existing.userName.split(' ')[0] ?? existing.userName;
    throw conflict(`${first}'s pay for ${payWeekLabel(existing.weekStart)} comes to ${payMoney(existing.gross)}, below £0, so it cannot be marked paid. Add an adjustment to carry part of a correction to a later week first.`);
  }
  // Release 1.4 (F): never alongside a payment from Linear Hub that is on its way
  assertNotInPayment(db, existing, opts.paymentItemId);
  // Release 1.3 (P2): Mark paid needs the self-billing invoice accepted or deemed accepted, else an admin override with
  // a reason (lib/invoices.ts; allows everything until P2 lands).
  assertInvoicePayable(db, existing, opts.actor, opts.body ?? {});
  run(db, `UPDATE payroll_runs SET paid_date = ?, status = ? WHERE id = ?`, [date, status, id]);
  return getPayroll(db, id)!;
}
