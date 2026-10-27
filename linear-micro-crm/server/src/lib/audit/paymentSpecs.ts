/**
 * Release 1.4 — OWNED BY F payments-foundation: the audit specs of every payments and bank-details write route,
 * registered through ./registry.ts. Snapshots never hold a secret, a token, a sort code or an account number: a
 * connection shows the NAMES of its stored secrets, bank details only the masked last digits (and shared
 * AUDIT_REDACTED_KEYS redacts those keys again before anything is stored).
 *
 * The rows for the payroll runs a payment marks paid or failed are written by lib/payments/batches.ts itself (the
 * same rows whether the admin's request or the 5-minute job settled them); these specs write the batch's own row.
 * A wrong two-step code on a payment approval or a bank details change is recorded (kind sign_in) like one at sign-in.
 */
import { formatPence, maskAccountNumber, maskSortCode, PAYMENT_MODE_LABELS, type PaymentMode } from '@lm/shared';
import { get, type Db } from '../../db/connection.ts';
import type { AuditCall, AuditDone, AuditDraft, AuditRouteSpec } from '../auditSpecs.ts';
import { WRONG_PAYMENT_CODE_MESSAGE } from '../payments/code.ts';

type Snap = Record<string, unknown>;

const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const responseOf = (done: AuditDone): Record<string, unknown> => (isRecord(done.response) ? done.response : {});
const errorOf = (done: AuditDone): string => String(responseOf(done).error ?? '');
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const modeText = (m: unknown) => (m === 'live' || m === 'test' ? PAYMENT_MODE_LABELS[m as PaymentMode].toLowerCase() : String(m ?? ''));

// ───────────────────────────── snapshots ─────────────────────────────

/** A connection without its secrets: provider, name, mode, status, its non-secret settings and the secrets' NAMES. */
function connectionSnap(db: Db, id: number | null): Snap | null {
  if (!id) return null;
  const r = get<Snap & { settingsJson: string; hasSecrets: number }>(
    db,
    `SELECT id, provider, name, mode, status, settings_json AS settingsJson, (secrets_enc IS NOT NULL) AS hasSecrets, live_confirmed_at AS liveConfirmedAt,
            disconnected_at AS disconnectedAt, last_error AS lastError, test_file_at AS testFileAt, test_file_result AS testFileResult
     FROM payment_connections WHERE id = ?`,
    [id],
  );
  if (!r) return null;
  const { settingsJson, hasSecrets, ...rest } = r;
  let settings: unknown = {};
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    settings = {};
  }
  return { ...rest, settings, secretsStored: Boolean(hasSecrets) };
}

function batchSnap(db: Db, id: number | null): Snap | null {
  if (!id) return null;
  return get<Snap>(
    db,
    `SELECT b.id, b.provider, c.name AS connectionName, b.mode, b.status, b.count, b.total_pence AS totalPence, b.approved_at AS approvedAt,
            b.file_name AS fileName, b.cancelled_at AS cancelledAt, b.downloaded_at AS downloadedAt, b.voided_at AS voidedAt,
            b.first_approved_at AS firstApprovedAt, b.first_approved_by AS firstApprovedBy,
            (SELECT COUNT(*) FROM payment_items i WHERE i.batch_id = b.id AND i.status = 'paid') AS paid,
            (SELECT COUNT(*) FROM payment_items i WHERE i.batch_id = b.id AND i.status = 'failed') AS failed,
            (SELECT COUNT(*) FROM payment_items i WHERE i.batch_id = b.id AND i.status IN ('queued', 'submitted', 'processing')) AS waiting
     FROM payment_batches b JOIN payment_connections c ON c.id = b.connection_id WHERE b.id = ?`,
    [id],
  ) ?? null;
}

/** Masked bank details (never the numbers). */
function bankSnap(db: Db, userId: number | null): Snap | null {
  if (!userId) return null;
  const r = get<{ userId: number; name: string; holderName: string; last4: string; last2: string; changedAt: string; changedBy: number | null; confirmedAt: string | null; confirmedBy: number | null; reportedAt: string | null; seenAt: string | null }>(
    db,
    `SELECT b.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS name, b.holder_name AS holderName, b.last4, b.sort_code_last2 AS last2,
            b.changed_at AS changedAt, b.changed_by AS changedBy, b.confirmed_by_admin_at AS confirmedAt, b.confirmed_by AS confirmedBy,
            b.reported_at AS reportedAt, b.person_seen_at AS seenAt
     FROM bank_accounts b JOIN users u ON u.id = b.user_id WHERE b.user_id = ?`,
    [userId],
  );
  if (!r) return null;
  return {
    userId: r.userId, name: r.name, holderName: r.holderName, account: maskAccountNumber(r.last4), sortCodeMask: maskSortCode(r.last2),
    changedAt: r.changedAt, changedBy: r.changedBy, confirmedAt: r.confirmedAt, confirmedBy: r.confirmedBy, reportedAt: r.reportedAt, seenAt: r.seenAt,
  };
}

const personName = (db: Db, id: number | null) =>
  (id ? get<{ name: string }>(db, `SELECT TRIM(first_name || ' ' || last_name) AS name FROM users WHERE id = ?`, [id])?.name : null) ?? 'someone';

const batchText = (s: Snap | null) => (s ? `${people(Number(s.count))}, ${formatPence(Number(s.totalPence))}` : '');

/** A wrong (or missing-but-needed) two-step code, or the code limiter. */
function wrongCode(doing: string, entity: AuditDraft['entity'], entityId: (done: AuditDone) => number | null) {
  return (_db: Db, done: AuditDone): AuditDraft[] => {
    if (!done.me) return [];
    if (done.status === 429) return [{ entity, entityId: entityId(done), summary: `Two-step code refused while ${doing}: too many attempts`, kind: 'sign_in', after: { reason: 'too_many_attempts' } }];
    if (done.status === 400 && errorOf(done) === WRONG_PAYMENT_CODE_MESSAGE) {
      return [{ entity, entityId: entityId(done), summary: `Wrong two-step code while ${doing}`, kind: 'sign_in', after: { reason: 'wrong_code' } }];
    }
    return [];
  };
}

// ───────────────────────────── connections ─────────────────────────────

const connectionCreate: AuditRouteSpec = {
  method: 'POST',
  pattern: '/payments/connections',
  after(db, done) {
    const id = toId(responseOf(done).id);
    const after = connectionSnap(db, id);
    if (!after) return [];
    return [{ entity: 'payment_connection', entityId: id, summary: `Connected ${String(after.name)} (${modeText(after.mode)})`, before: null, after }];
  },
};

const connectionPatch: AuditRouteSpec<Snap | null> = {
  method: 'PATCH',
  pattern: '/payments/connections/:id',
  before: (db, call: AuditCall) => connectionSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const id = toId(done.params.id);
    const after = connectionSnap(db, id);
    if (!after || !before) return [];
    const parts: string[] = [];
    if (before.mode !== after.mode) parts.push(after.mode === 'live' ? `switched to live (${String((isRecord(done.body) && done.body.confirm) || '').trim()} typed)` : 'switched back to test mode');
    if (before.name !== after.name) parts.push(`renamed from ${String(before.name)}`);
    if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) parts.push('settings changed');
    if (isRecord(done.body) && isRecord(done.body.secrets) && Object.values(done.body.secrets).some((v) => typeof v === 'string' && v.trim())) parts.push('keys replaced');
    if (!parts.length) return [];
    return [{ entity: 'payment_connection', entityId: id, summary: `${String(after.name)}: ${parts.join(', ')}`, before, after }];
  },
};

const connectionDelete: AuditRouteSpec<Snap | null> = {
  method: 'DELETE',
  pattern: '/payments/connections/:id',
  before: (db, call) => connectionSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const id = toId(done.params.id);
    const after = connectionSnap(db, id);
    return [{ entity: 'payment_connection', entityId: id, summary: `Disconnected ${String(after?.name ?? before?.name ?? 'a payment connection')} (its keys were deleted)`, before, after }];
  },
};

const connectionTest: AuditRouteSpec = {
  method: 'POST',
  pattern: '/payments/connections/:id/test',
  after(db, done) {
    const id = toId(done.params.id);
    const r = responseOf(done);
    const after = connectionSnap(db, id);
    const name = String(after?.name ?? 'a payment connection');
    return [{ entity: 'payment_connection', entityId: id, summary: r.ok ? `Tested ${name}: it works` : `Tested ${name}: it did not work (${String(r.message ?? '').slice(0, 200)})`, before: null, after }];
  },
};

// ───────────────────────────── batches ─────────────────────────────

const batchCreate: AuditRouteSpec = {
  method: 'POST',
  pattern: '/payments/batches',
  after(db, done) {
    const r = responseOf(done);
    const id = toId(r.id);
    const after = batchSnap(db, id);
    if (!after) return [];
    const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
    return [{ entity: 'payment_batch', entityId: id, summary: `Made draft payment #${id} through ${String(after.connectionName)}: ${batchText(after)}${skipped ? ` (${skipped} left out)` : ''}`, before: null, after }];
  },
};

function outcome(s: Snap | null): string {
  if (!s) return '';
  const bits = [Number(s.paid) ? `${Number(s.paid)} paid` : '', Number(s.failed) ? `${Number(s.failed)} failed` : '', Number(s.waiting) ? `${Number(s.waiting)} on the way` : ''].filter(Boolean);
  return bits.length ? ` — ${bits.join(', ')}` : '';
}

const batchApprove: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/payments/batches/:id/approve',
  before: (db, call) => batchSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const id = toId(done.params.id);
    const after = batchSnap(db, id);
    if (!after) return [];
    // MONEY-MISSED-2: the first of two approvals sends nothing
    if (after.status === 'draft' && after.firstApprovedAt && before && !before.firstApprovedAt) {
      return [{ entity: 'payment_batch', entityId: id, summary: `First approval of payment #${id} through ${String(after.connectionName)} (${modeText(after.mode)}): ${batchText(after)} — waiting for a second administrator`, before, after }];
    }
    const second = after.firstApprovedBy ? ` (second approval; first by ${personName(db, after.firstApprovedBy as number)})` : '';
    return [{ entity: 'payment_batch', entityId: id, summary: `Approved payment #${id} through ${String(after.connectionName)} (${modeText(after.mode)})${second}: ${batchText(after)}${outcome(after)}`, before, after }];
  },
  failed: wrongCode('approving a payment', 'payment_batch', (done) => toId(done.params.id)),
};

const batchRefresh: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/payments/batches/:id/refresh',
  before: (db, call) => batchSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const id = toId(done.params.id);
    const after = batchSnap(db, id);
    if (!after || !before) return [];
    // checking without news writes nothing
    if (before.paid === after.paid && before.failed === after.failed && before.waiting === after.waiting && before.status === after.status) return [];
    return [{ entity: 'payment_batch', entityId: id, summary: `Checked payment #${id} with ${String(after.connectionName)}${outcome(after)}`, before, after }];
  },
};

const batchCancel: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/payments/batches/:id/cancel',
  before: (db, call) => batchSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const id = toId(done.params.id);
    const after = batchSnap(db, id);
    if (!after) return [];
    // MON-2: a downloaded bank file the admin confirmed was not uploaded is void
    if (after.voidedAt && !before?.voidedAt) {
      return [{ entity: 'payment_batch', entityId: id, summary: `Made bank file payment #${id} void: ${personName(db, done.me?.id ?? null)} confirmed (typed NOT UPLOADED, with a code) that the file was not uploaded to the bank — ${batchText(before ?? after)}`, before, after }];
    }
    return [{ entity: 'payment_batch', entityId: id, summary: `Cancelled payment #${id} through ${String(after.connectionName)}: ${batchText(before ?? after)}${outcome(after)}`, before, after }];
  },
  failed: wrongCode('cancelling a downloaded bank file', 'payment_batch', (done) => toId(done.params.id)),
};

const batchMarkPaid: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/payments/batches/:id/mark-paid',
  before: (db, call) => batchSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const id = toId(done.params.id);
    const after = batchSnap(db, id);
    if (!after) return [];
    const paid = Number(after.paid) - Number(before?.paid ?? 0);
    const failed = Number(after.failed) - Number(before?.failed ?? 0);
    const reason = isRecord(done.body) && typeof done.body.reason === 'string' && done.body.reason.trim() ? `: ${done.body.reason.trim().slice(0, 200)}` : '';
    const parts = [paid ? `${people(paid)} paid by the bank` : '', failed ? `${people(failed)} not paid${reason}` : ''].filter(Boolean);
    const confirmed = failed && after.mode === 'live' && after.downloadedAt ? ' (typed NOT PAID, with a code)' : '';
    return [{ entity: 'payment_batch', entityId: id, summary: `Marked bank file payment #${id}: ${parts.join('; ') || 'no change'}${confirmed}`, before, after }];
  },
  failed: wrongCode('marking a bank file not paid', 'payment_batch', (done) => toId(done.params.id)),
};

// ───────────────────────────── settings and the 1p test file ─────────────────────────────

const settingsSnap = (db: Db): Snap => {
  const v = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'ext:payments:two_approvals'`)?.value ?? null;
  return { twoApprovals: v };
};

/** MONEY-MISSED-2: "Two people approve each payment" turned on or off. */
const paymentsSettingsPut: AuditRouteSpec<Snap> = {
  method: 'PUT',
  pattern: '/payments/settings',
  before: (db) => settingsSnap(db),
  after(db, done, before) {
    const after = settingsSnap(db);
    if (before && before.twoApprovals === after.twoApprovals) return [];
    return [{ entity: 'settings', entityId: null, summary: `Turned ${after.twoApprovals === 'on' ? 'on' : 'off'} “Two people approve each payment”`, before, after }];
  },
  failed: wrongCode('changing the payment approvals', 'settings', () => null),
};

/** MON-6: the 1p test file (an export of one payment; never the account number, only its last four digits). */
const testFile: AuditRouteSpec = {
  method: 'POST',
  pattern: '/payments/connections/:id/test-file',
  after(db, done) {
    const id = toId(done.params.id);
    const conn = connectionSnap(db, id);
    const raw = isRecord(done.body) && typeof done.body.accountNumber === 'string' ? done.body.accountNumber.replace(/\D/g, '') : '';
    const last4 = raw.length >= 4 ? raw.slice(-4) : '';
    return [{ entity: 'payment_connection', entityId: id, kind: 'export', summary: `Made a 1p test file for ${String(conn?.name ?? 'a bank file connection')}: one payment of £0.01${last4 ? ` to account ${maskAccountNumber(last4)}` : ''}`, before: null, after: conn }];
  },
  failed: wrongCode('making a 1p test file', 'payment_connection', (done) => toId(done.params.id)),
};

const testFileResult: AuditRouteSpec = {
  method: 'POST',
  pattern: '/payments/connections/:id/test-file-result',
  after(db, done) {
    const id = toId(done.params.id);
    const conn = connectionSnap(db, id);
    const r = responseOf(done);
    return [{ entity: 'payment_connection', entityId: id, summary: `1p test file through ${String(conn?.name ?? 'a bank file connection')}: the bank ${r.testFileResult === 'accepted' ? 'took it' : 'refused it'}`, before: null, after: conn }];
  },
};

// ───────────────────────────── bank details ─────────────────────────────

function bankChange(pattern: string, target: (call: AuditCall) => number | null): AuditRouteSpec<Snap | null> {
  return {
    method: 'PUT',
    pattern,
    before: (db, call) => bankSnap(db, target(call)),
    after(db, done, before) {
      const userId = target(done);
      const after = bankSnap(db, userId);
      if (!after) return [];
      if (before && before.changedAt === after.changedAt) return []; // the same details again
      const self = done.me?.id === userId;
      const who = self ? 'their own' : `${personName(db, userId)}'s`;
      // MON-3: nobody confirms their own change
      const hold = after.confirmedAt
        ? ''
        : self && done.me?.role !== 'admin'
          ? ' — payments wait until an administrator confirms them'
          : self
            ? ' — payments wait until another administrator confirms them'
            : ` — payments wait until ${personName(db, userId).split(' ')[0]} or another administrator confirms them`;
      return [{ entity: 'bank_account', entityId: userId, summary: `${before ? 'Changed' : 'Added'} ${who} bank details: account ${String(after.account)}, sort code ${String(after.sortCodeMask)}${hold}`, before, after }];
    },
    failed: wrongCode('changing bank details', 'bank_account', (done) => target(done)),
  };
}

const bankConfirm: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/users/:id/bank-details/confirm',
  before: (db, call) => bankSnap(db, toId(call.params.id)),
  after(db, done, before) {
    const userId = toId(done.params.id);
    const after = bankSnap(db, userId);
    if (!after || (before && before.confirmedAt === after.confirmedAt)) return [];
    return [{ entity: 'bank_account', entityId: userId, summary: `Confirmed ${personName(db, userId)}'s bank details (account ${String(after.account)})`, before, after }];
  },
  failed: wrongCode('confirming bank details', 'bank_account', (done) => toId(done.params.id)),
};

/** MON-3: the person says yes to details someone else typed in. */
const bankConfirmOwn: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/me/bank-details/confirm',
  before: (db, call) => bankSnap(db, call.me?.id ?? null),
  after(db, done, before) {
    const userId = done.me?.id ?? null;
    const after = bankSnap(db, userId);
    if (!after || (before && before.confirmedAt === after.confirmedAt && before.seenAt === after.seenAt)) return [];
    const by = personName(db, (after.changedBy as number | null) ?? null);
    return [{ entity: 'bank_account', entityId: userId, summary: `${personName(db, userId)} confirmed their own bank details (account ${String(after.account)}), which ${by} had typed in`, before, after }];
  },
  failed: wrongCode('confirming bank details', 'bank_account', (done) => done.me?.id ?? null),
};

/** MON-3: "these are not my details". */
const bankReport: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/me/bank-details/report',
  before: (db, call) => bankSnap(db, call.me?.id ?? null),
  after(db, done, before) {
    const userId = done.me?.id ?? null;
    const after = bankSnap(db, userId);
    if (!after || (before && before.reportedAt === after.reportedAt)) return [];
    const by = personName(db, (after.changedBy as number | null) ?? null);
    const note = isRecord(done.body) && typeof done.body.note === 'string' && done.body.note.trim() ? `: ${done.body.note.trim().slice(0, 200)}` : '';
    return [{ entity: 'bank_account', entityId: userId, summary: `${personName(db, userId)} reported the bank details ${by} typed in (account ${String(after.account)}) as not theirs${note}`, before, after }];
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  connectionCreate,
  connectionPatch,
  connectionDelete,
  connectionTest,
  batchCreate,
  batchApprove,
  batchRefresh,
  batchCancel,
  batchMarkPaid,
  bankChange('/me/bank-details', (call) => call.me?.id ?? null),
  bankChange('/users/:id/bank-details', (call) => toId(call.params.id)),
  bankConfirm,
  bankConfirmOwn,
  bankReport,
  paymentsSettingsPut,
  testFile,
  testFileResult,
];
