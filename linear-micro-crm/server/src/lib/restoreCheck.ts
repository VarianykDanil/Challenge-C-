/**
 * What a restore would make Linear Hub forget about money: the live database's payments approved, sent or paid, bank
 * files made or downloaded, bank details changed and pay runs marked paid (on time or late) that the backup does not
 * have. After such a restore, the same
 * week could be paid again (a new payment gets new idempotency keys, so the bank or provider does not stop it), or
 * paid to someone's old bank details. Restore lists them and asks for a typed confirmation; the restored database
 * then carries a warning (meta `restore_payment_warning`) that the Needs-attention bell shows the office.
 *
 * Compared by content, not by clock: a row counts when the backup lacks it or holds an earlier state of it. When the
 * comparison cannot be made (an unreadable or unexpected database), it fails closed: `unknown` says why, and restore
 * asks for the typed confirmation and stores the warning all the same.
 */
import { DatabaseSync } from 'node:sqlite';
import { formatPence } from '@lm/shared';

export interface PaymentLosses {
  /** Live payments approved that the backup has not approved (or does not have). */
  approved: Array<{ id: number; approvedAt: string; pence: number; count: number }>;
  /** Payments to people that went to the bank or were paid, which the backup still has as not sent (or as sent, not paid). */
  sent: { count: number; pence: number; names: string[] };
  /** Bank files made that the backup has not made. */
  bankFiles: Array<{ id: number; fileName: string }>;
  /**
   * Live bank files downloaded that the backup has as not downloaded (MON-2: a downloaded file counts as sent, as it may
   * be at the bank). Approval names the file, so a backup made between approval and download has the file but not the
   * download: restored, the file could be cancelled without the NOT UPLOADED words and the week paid again.
   */
  downloaded: Array<{ id: number; fileName: string }>;
  /** People whose bank details changed after the backup: the backup has their OLD details. */
  bankDetails: string[];
  /** Pay runs marked paid (status 'paid', or 'late' when paid after the due date) that the backup still has as unpaid. */
  paidRuns: { count: number; gross: number; names: string[] };
  /** Everything above added up (0: nothing found to lose). */
  total: number;
  /** Why the comparison could not be made (null when it was): then nothing tells what would be forgotten. */
  unknown: string | null;
}

export const RESTORE_WARNING_META = 'restore_payment_warning';

/** Nothing lost (no live database to compare with). */
export const noLosses = (): PaymentLosses => ({
  approved: [],
  sent: { count: 0, pence: 0, names: [] },
  bankFiles: [],
  downloaded: [],
  bankDetails: [],
  paidRuns: { count: 0, gross: 0, names: [] },
  total: 0,
  unknown: null,
});

const totalOf = (l: PaymentLosses) => l.approved.length + l.sent.count + l.bankFiles.length + l.downloaded.length + l.bankDetails.length + l.paidRuns.count;

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

function tables(db: DatabaseSync, schema: 'main' | 'bk'): Set<string> {
  return new Set((db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name));
}

function columns(db: DatabaseSync, schema: 'main' | 'bk', table: string): Set<string> {
  return new Set((db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>).map((r) => r.name));
}

/** A run counts as paid when marked paid on time ('paid') or after its due date ('late'), as everywhere else. */
const PAID_RUN = `('paid', 'late')`;
/** The audit action 1.4.0 wrote for a bank file's download (1.5's upgrade turns the first into downloaded_at). */
const DOWNLOAD_ACTION = 'GET /payments/batches/:id/file';

/** Compares the live database with a backup (both closed files). The live file is opened read-only. */
export function paymentLosses(liveFile: string, backupFile: string): PaymentLosses {
  const out = noLosses();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(liveFile, { readOnly: true });
  } catch (err) {
    return { ...out, unknown: `the current database could not be opened: ${reason(err)}` };
  }
  try {
    db.prepare(`ATTACH DATABASE ? AS bk`).run(backupFile);
    const live = tables(db, 'main');
    const bk = tables(db, 'bk');
    const has = (t: string) => live.has(t);
    const inBackup = (t: string) => bk.has(t);
    const name = `TRIM(u.first_name || ' ' || u.last_name)`;

    if (has('payment_batches')) {
      out.approved = (
        db
          .prepare(
            `SELECT b.id, b.approved_at AS approvedAt, b.total_pence AS pence, b.count FROM main.payment_batches b
             WHERE b.mode = 'live' AND b.approved_at IS NOT NULL
               ${inBackup('payment_batches') ? `AND NOT EXISTS (SELECT 1 FROM bk.payment_batches x WHERE x.id = b.id AND x.approved_at IS NOT NULL)` : ''}
             ORDER BY b.approved_at`,
          )
          .all() as Array<{ id: number; approvedAt: string; pence: number; count: number }>
      ).map((r) => ({ ...r, pence: Number(r.pence), count: Number(r.count) }));
      out.bankFiles = db
        .prepare(
          `SELECT b.id, b.file_name AS fileName FROM main.payment_batches b
           WHERE b.mode = 'live' AND b.file_name IS NOT NULL
             ${inBackup('payment_batches') ? `AND NOT EXISTS (SELECT 1 FROM bk.payment_batches x WHERE x.id = b.id AND x.file_name IS NOT NULL)` : ''}
           ORDER BY b.id`,
        )
        .all() as Array<{ id: number; fileName: string }>;
      if (columns(db, 'main', 'payment_batches').has('downloaded_at')) {
        // Downloaded in the backup: its own downloaded_at; a 1.4 backup has no such column, but its audit trail has the
        // download (the upgrade after the restore turns that into downloaded_at). No payments table: never downloaded.
        const downloadedInBackup = !inBackup('payment_batches')
          ? null
          : columns(db, 'bk', 'payment_batches').has('downloaded_at')
            ? `x.downloaded_at IS NOT NULL`
            : inBackup('audit_log')
              ? `EXISTS (SELECT 1 FROM bk.audit_log a WHERE a.action = '${DOWNLOAD_ACTION}' AND a.entity = 'payment_batch' AND a.entity_id = x.id)`
              : null;
        out.downloaded = db
          .prepare(
            `SELECT b.id, COALESCE(b.file_name, 'payment #' || b.id) AS fileName FROM main.payment_batches b
             WHERE b.mode = 'live' AND b.downloaded_at IS NOT NULL
               ${downloadedInBackup ? `AND NOT EXISTS (SELECT 1 FROM bk.payment_batches x WHERE x.id = b.id AND ${downloadedInBackup})` : ''}
             ORDER BY b.id`,
          )
          .all() as Array<{ id: number; fileName: string }>;
      }
    }
    if (has('payment_items')) {
      // Lost when the backup has it as not sent, or as sent but not paid while it is paid now (restored, it would be
      // on its way again and could be cancelled and paid a second time).
      const rows = db
        .prepare(
          `SELECT ${name} AS name, i.amount_pence AS pence FROM main.payment_items i JOIN main.users u ON u.id = i.user_id
           WHERE i.live = 1 AND i.status IN ('submitted', 'processing', 'paid')
             ${
               inBackup('payment_items')
                 ? `AND NOT EXISTS (SELECT 1 FROM bk.payment_items x WHERE x.id = i.id AND x.status IN ('submitted', 'processing', 'paid')
                      AND (i.status <> 'paid' OR x.status = 'paid'))`
                 : ''
             }
           ORDER BY i.id`,
        )
        .all() as Array<{ name: string; pence: number }>;
      out.sent = { count: rows.length, pence: rows.reduce((n, r) => n + Number(r.pence), 0), names: [...new Set(rows.map((r) => r.name))] };
    }
    if (has('bank_accounts')) {
      out.bankDetails = (
        db
          .prepare(
            `SELECT ${name} AS name FROM main.bank_accounts b JOIN main.users u ON u.id = b.user_id
             ${inBackup('bank_accounts') ? `WHERE NOT EXISTS (SELECT 1 FROM bk.bank_accounts x WHERE x.user_id = b.user_id AND x.changed_at = b.changed_at)` : ''}
             ORDER BY b.changed_at`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
    }
    if (has('payroll_runs')) {
      const rows = db
        .prepare(
          `SELECT ${name} AS name, r.gross FROM main.payroll_runs r JOIN main.users u ON u.id = r.user_id
           WHERE r.status IN ${PAID_RUN}
             ${inBackup('payroll_runs') ? `AND NOT EXISTS (SELECT 1 FROM bk.payroll_runs x WHERE x.user_id = r.user_id AND x.week_start = r.week_start AND x.status IN ${PAID_RUN})` : ''}
           ORDER BY r.week_start`,
        )
        .all() as Array<{ name: string; gross: number }>;
      out.paidRuns = { count: rows.length, gross: rows.reduce((n, r) => n + Number(r.gross), 0), names: [...new Set(rows.map((r) => r.name))] };
    }
    out.total = totalOf(out);
    return out;
  } catch (err) {
    // fail closed: an error must never read as "nothing to lose"
    out.total = totalOf(out);
    return { ...out, unknown: reason(err) };
  } finally {
    db.close();
  }
}

const some = (names: string[], max = 4) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pounds = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The lines restore prints before asking (empty when nothing would be lost). */
export function describeLosses(l: PaymentLosses): string[] {
  if (!l.total && !l.unknown) return [];
  if (!l.total) {
    return [
      `Linear Hub could not compare the money records in the current database with this backup (${l.unknown}).`,
      'So it cannot tell whether restoring makes it forget payments approved, sent or paid, bank files made or downloaded, bank details changes or pay runs marked paid after the backup.',
      'If you restore, check each payment against the bank statement before paying anyone, so nobody is paid twice or to old bank details.',
    ];
  }
  const lines = ['This backup is older than these money records. Restoring it makes Linear Hub forget them:'];
  if (l.approved.length) {
    const pence = l.approved.reduce((n, a) => n + a.pence, 0);
    lines.push(`  - ${plural(l.approved.length, 'payment')} approved after the backup (${formatPence(pence)} in all; ${l.approved.map((a) => `#${a.id}`).join(', ')})`);
  }
  if (l.sent.count) lines.push(`  - ${plural(l.sent.count, 'payment')} to people sent to the bank or paid (${formatPence(l.sent.pence)}): ${some(l.sent.names)}`);
  if (l.bankFiles.length) lines.push(`  - ${plural(l.bankFiles.length, 'bank file')} made: ${some(l.bankFiles.map((f) => f.fileName))}`);
  if (l.downloaded.length) {
    const one = l.downloaded.length === 1;
    lines.push(
      `  - ${plural(l.downloaded.length, 'bank file')} downloaded after the backup, so ${one ? 'it' : 'they'} may be at the bank: ${some(l.downloaded.map((f) => f.fileName))}. ` +
        `The backup has ${one ? 'it' : 'them'} as not downloaded, so ${one ? 'it' : 'they'} could be cancelled and paid again.`,
    );
  }
  if (l.bankDetails.length) lines.push(`  - ${plural(l.bankDetails.length, 'bank details change', 'bank details changes')}: ${some(l.bankDetails)}. The backup has their OLD bank details.`);
  if (l.paidRuns.count) lines.push(`  - ${plural(l.paidRuns.count, 'pay run')} marked paid (${pounds(l.paidRuns.gross)}): ${some(l.paidRuns.names)}`);
  if (l.unknown) lines.push(`  - and maybe more: Linear Hub could not compare everything (${l.unknown})`);
  lines.push(
    'After the restore, Linear Hub would show these people as not paid yet, so they could be paid twice, or paid to old bank details.',
    'Check each one against the bank statement before paying anyone.',
  );
  return lines;
}

/** Stored in the restored database, so the office sees the warning in the Needs-attention bell. */
export function restoreWarningRecord(l: PaymentLosses, backupName: string, at: Date = new Date()): string {
  return JSON.stringify({
    at: at.toISOString(),
    backup: backupName,
    approved: l.approved.length,
    sent: l.sent.count,
    bankFiles: l.bankFiles.length,
    downloaded: l.downloaded.length,
    bankDetails: l.bankDetails.length,
    paidRuns: l.paidRuns.count,
    unknown: Boolean(l.unknown),
  });
}
