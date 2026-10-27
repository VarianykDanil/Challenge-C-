/**
 * Test helpers for the money package (not a test file itself).
 *
 * recordSandboxRun: an API connection goes live only after a test-mode payment through it got an answer from the
 * provider's sandbox (MON-5, lib/payments/connections.ts). Tests that are about something else record that sandbox run
 * straight into the tables: a completed test-mode payment with one item the sandbox answered.
 */
import { run, type Db } from '../db/connection.ts';

export function recordSandboxRun(db: Db, connectionId: number, by?: number): void {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const conn = db.prepare(`SELECT provider, created_by AS createdBy FROM payment_connections WHERE id = ?`).get(connectionId) as { provider: string; createdBy: number };
  const provider = conn.provider;
  const userId = by ?? conn.createdBy;
  const batchId = run(
    db,
    `INSERT INTO payment_batches (connection_id, provider, mode, created_at, created_by, approved_at, approved_by, total_pence, count, status, idempotency_key, updated_at)
     VALUES (?, ?, 'test', ?, ?, ?, ?, 100, 1, 'completed', ?, ?)`,
    [connectionId, provider, at, userId, at, userId, `sandbox-run-${connectionId}-${Math.random()}`, at],
  ).lastInsertRowid;
  run(
    db,
    `INSERT INTO payment_items (batch_id, payroll_run_id, user_id, week_start, amount_pence, payee_name, account_last4, status, provider_ref, submitted_at, paid_at, updated_at, live, attempted_at)
     VALUES (?, 0, ?, '2000-01-03', 100, 'Sandbox Test', '0000', 'paid', 'sandbox-ref', ?, ?, ?, 0, ?)`,
    [batchId, userId, at, at, at, at],
  );
}
