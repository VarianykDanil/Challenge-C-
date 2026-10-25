/**
 * Release 1.4 — OWNED BY F payments-foundation: the payments job. Every 5 minutes (unref'd), while an approved payment
 * through an API provider still has items on their way, Linear Hub resends what a failed submit left queued (same
 * idempotency keys) and asks the provider for the latest status (lib/payments/batches.ts refreshWaitingBatches).
 * Nothing happens when nothing is waiting (one cheap query). LM_PAYMENTS_JOB=0 turns it off (Check now on the payment's
 * page still works). Never started by tests.
 */
import { get, type Db } from '../../db/connection.ts';
import { refreshWaitingBatches } from './batches.ts';

export const PAYMENTS_JOB_INTERVAL_MS = 5 * 60_000;

export function paymentsJobEnabled(): boolean {
  return process.env.LM_PAYMENTS_JOB?.trim() !== '0';
}

export function startPaymentsJob(db: Db): () => void {
  if (!paymentsJobEnabled()) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    if (!get(db, `SELECT 1 FROM payment_batches WHERE status IN ('submitted', 'processing') LIMIT 1`)) return;
    running = true;
    try {
      const n = await refreshWaitingBatches(db);
      if (n) console.log(`Payments: checked ${n} payment${n === 1 ? '' : 's'} still on their way`);
    } catch (err) {
      console.error('Payments job failed; it runs again in 5 minutes', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), PAYMENTS_JOB_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
