/**
 * Release 1.3 — self-billing invoices on the server — OWNED BY P2 invoices (laid down by r3-foundation; the three
 * exports below are STABLE hooks the foundation wired into code P2 does not own):
 *
 *  - assertInvoicePayable(db, run, me, body): routes/finance.ts calls it in POST /finance/payroll/:id/pay before the run
 *    is marked paid. P2 throws 409 unless the run's invoice is accepted or deemed accepted, or the admin sent an
 *    override with a reason (`body.overrideReason`, recorded in the audit trail). Stub: allows everything (1.2 rules).
 *  - withInvoiceSummaries(db, runs, me): routes/finance.ts passes every payroll answer through it (GET /finance/payroll,
 *    GET /finance/me, GET /finance/payroll/:id) so each run carries `invoice` (InvoiceSummary) once one is issued.
 *    One grouped query, never a query per row. Stub: returns the runs unchanged (same array).
 *  - startInvoiceJobs(db): index.ts calls it once at start-up; P2 issues invoices for newly closed weeks and marks them
 *    deemed accepted at 12:00 the day before payday (unref'd timers, every 15 minutes). Returns a stop function. Stub:
 *    starts nothing.
 */
import type { PayrollRunWithUser, UserWithTeam } from '@lm/shared';
import type { Db } from '../db/connection.ts';

/** STUB (P2): throw (409) when the run may not be marked paid yet. */
export function assertInvoicePayable(db: Db, run: PayrollRunWithUser, me: UserWithTeam, body: unknown): void {
  void db;
  void run;
  void me;
  void body;
}

/** STUB (P2): the runs with their invoice summaries attached (unchanged until P2 lands). */
export function withInvoiceSummaries<T extends PayrollRunWithUser>(db: Db, runs: T[], me: UserWithTeam): T[] {
  void db;
  void me;
  return runs;
}

/** STUB (P2): start the invoice jobs; returns a stop function. */
export function startInvoiceJobs(db: Db): () => void {
  void db;
  return () => {};
}
