/**
 * Release 1.4 — OWNED BY F payments-foundation. Kind 'payments' in the Needs-attention feed, for administrators only:
 *
 *  - someone changed their bank details and an admin has not confirmed them yet: "Jordan Lee changed their bank
 *    details" (warning; up to three by name, then one line for all), linking to Team → person → Bank details;
 *  - live payments that failed and whose run is still unpaid with no newer payment (one line: danger), linking to the
 *    payment (or Runs to pay when several payments are involved);
 *  - a bank file approved but not yet marked paid (info, one per payment, newest two);
 *  - a connection whose last test or payment failed (warning).
 * One UNION ALL statement per call (the feed's budget, attention.test.ts). Keys carry the moment, so a new change or a
 * new failure is new again in the bell.
 */
import { formatPence, type AttentionItem } from '@lm/shared';
import { all, placeholders } from '../../db/connection.ts';
import { listPaymentProviders } from '../payments/registry.ts';
import type { AttentionProvider } from './types.ts';

interface Row {
  kind: 'bank' | 'failed' | 'file' | 'conn';
  id: number;
  name: string | null;
  at: string | null;
  n: number | null;
  amount: number | null;
  reason: string | null;
  batchId: number | null;
}

const FAILED_LOOKBACK_DAYS = 30;

export const provider: AttentionProvider = {
  name: 'payments',
  items(db, me, now) {
    if (me.role !== 'admin') return [];
    const fileProviders = listPaymentProviders().filter((p) => p.info.kind === 'file').map((p) => p.info.id);
    const since = new Date(Date.parse(now.nowISO) - FAILED_LOOKBACK_DAYS * 86_400_000).toISOString();
    const rows = all<Row>(
      db,
      `SELECT 'bank' AS kind, b.user_id AS id, TRIM(u.first_name || ' ' || u.last_name) AS name, b.changed_at AS at, NULL AS n, NULL AS amount, NULL AS reason, NULL AS batchId
       FROM bank_accounts b JOIN users u ON u.id = b.user_id
       WHERE (b.confirmed_by_admin_at IS NULL OR b.confirmed_by_admin_at < b.changed_at) AND u.status <> 'left' AND u.role <> 'client'
       UNION ALL
       SELECT 'failed', i.id, TRIM(u.first_name || ' ' || u.last_name), i.updated_at, NULL, i.amount_pence, i.failure_reason, i.batch_id
       FROM payment_items i JOIN users u ON u.id = i.user_id JOIN payroll_runs p ON p.id = i.payroll_run_id
       WHERE i.live = 1 AND i.status = 'failed' AND p.status IN ('pending', 'failed') AND i.updated_at >= ?
         AND NOT EXISTS (SELECT 1 FROM payment_items j WHERE j.payroll_run_id = i.payroll_run_id AND j.id > i.id AND j.live = 1 AND j.status <> 'cancelled')
       UNION ALL
       SELECT 'file', b.id, c.name, COALESCE(b.approved_at, b.created_at),
              (SELECT COUNT(*) FROM payment_items x WHERE x.batch_id = b.id AND x.status IN ('submitted', 'processing')), b.total_pence, NULL, b.id
       FROM payment_batches b JOIN payment_connections c ON c.id = b.connection_id
       WHERE b.status IN ('submitted', 'processing') AND b.provider IN (${placeholders(Math.max(1, fileProviders.length))})
       UNION ALL
       SELECT 'conn', c.id, c.name, c.last_checked_at, NULL, NULL, c.last_error, NULL
       FROM payment_connections c WHERE c.status = 'error' AND c.disconnected_at IS NULL
       ORDER BY at DESC`,
      [since, ...(fileProviders.length ? fileProviders : ['-'])],
    );
    const items: AttentionItem[] = [];

    const bank = rows.filter((r) => r.kind === 'bank');
    if (bank.length > 3) {
      items.push({
        key: `payments:bank:${bank.length}:${bank[0]!.at}`,
        kind: 'payments',
        severity: 'warning',
        title: `${bank.length} people changed their bank details`,
        body: 'Check them before paying: payments to new details wait until you confirm them in Team.',
        href: '/team',
        actionLabel: 'Open Team',
        at: bank[0]!.at ?? undefined,
        count: bank.length,
      });
    } else {
      for (const r of bank) {
        items.push({
          key: `payments:bank:${r.id}:${r.at}`,
          kind: 'payments',
          severity: 'warning',
          title: `${r.name ?? 'Someone'} changed their bank details`,
          body: 'Check them before paying: payments to the new account wait until you confirm them.',
          href: `/team/${r.id}#bank-details`,
          actionLabel: 'Check details',
          at: r.at ?? undefined,
        });
      }
    }

    const failed = rows.filter((r) => r.kind === 'failed');
    if (failed.length) {
      const first = failed[0]!;
      const batches = new Set(failed.map((r) => r.batchId));
      items.push({
        key: `payments:failed:${Math.max(...failed.map((r) => r.id))}:${failed.length}`,
        kind: 'payments',
        severity: 'danger',
        title: failed.length === 1 ? `A payment to ${first.name ?? 'someone'} failed` : `${failed.length} payments failed`,
        body: `${first.name ?? 'Someone'}, ${formatPence(first.amount ?? 0)}: ${first.reason ?? 'not paid'}. ${failed.length === 1 ? 'Their week' : 'These weeks'} stay${failed.length === 1 ? 's' : ''} on Runs to pay.`,
        href: batches.size === 1 ? `/finance/pay/batches/${first.batchId}` : '/finance?tab=company#runs',
        actionLabel: batches.size === 1 ? 'Open the payment' : 'Open Runs to pay',
        at: first.at ?? undefined,
        count: failed.length,
      });
    }

    for (const r of rows.filter((x) => x.kind === 'file').slice(0, 2)) {
      items.push({
        key: `payments:file:${r.id}`,
        kind: 'payments',
        severity: 'info',
        title: `Payment #${r.id} is waiting for your bank`,
        body: `Upload the file to your bank and approve it there, then mark it paid here (${r.n ?? 0} ${r.n === 1 ? 'person' : 'people'}, ${formatPence(r.amount ?? 0)}).`,
        href: `/finance/pay/batches/${r.id}`,
        actionLabel: 'Open the payment',
        at: r.at ?? undefined,
      });
    }

    for (const r of rows.filter((x) => x.kind === 'conn').slice(0, 2)) {
      items.push({
        key: `payments:conn:${r.id}:${r.at}`,
        kind: 'payments',
        severity: 'warning',
        title: `${r.name ?? 'A payment connection'} needs a look`,
        body: r.reason ? `Its last test did not work: ${r.reason.slice(0, 200)}` : 'Its last test did not work. Test it again in Settings → Payments.',
        href: '/settings#payments',
        actionLabel: 'Open Settings',
        at: r.at ?? undefined,
      });
    }
    return items;
  },
};
