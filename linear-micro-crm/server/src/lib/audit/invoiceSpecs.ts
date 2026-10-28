/**
 * Release 1.3 — OWNED BY P2 invoices: this package's audit specs, in the shape of lib/auditSpecs.ts (AuditRouteSpec:
 * method, pattern, before, after → AuditDraft[]), registered through ./registry.ts (P9 owns the registry). One entry
 * per write route of /invoices, plus a refinement of the 1.2 Mark-paid entry (package specs are matched first): the
 * same row and wording, and — when the admin paid without an accepted invoice — the invoice and the reason.
 * A write that changed nothing writes no row (an agreement accepted twice, a profile or company saved unchanged).
 * Snapshots never include PINs, passwords, secrets, tokens or codes (lib/audit.ts redacts again); the signature image is
 * recorded as a file name, never its bytes. Automatic steps (invoices issued, reissued, deemed accepted) are recorded
 * by lib/invoices.ts with recordSystemEvent.
 */
import { auditChangeText, auditDiff, auditMoney, auditWeekLabel, formatVatNumber, SELF_BILLING_AGREEMENT_VERSION } from '@lm/shared';
import { get, type Db } from '../../db/connection.ts';
import { payrollSnapshot, type AuditCall, type AuditDone, type AuditDraft, type AuditRouteSpec } from '../auditSpecs.ts';
import { WRONG_PAYMENT_CODE_MESSAGE } from '../payments/code.ts';

type Snap = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const quote = (s: string, max = 120) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;

/** Runs a read that may meet a missing column on an old database; any SQL error → fallback. */
function soft<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** An invoice as the trail shows it (no line JSON: the total and the status say what changed). */
function invoiceSnapshot(db: Db, id: number): Snap | null {
  return soft(() => get<Snap>(
    db,
    `SELECT i.id, i.number, i.version, i.status, i.total, i.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName,
            p.week_start AS weekStart, i.accepted_at AS acceptedAt, i.disputed_at AS disputedAt, i.dispute_reason AS disputeReason,
            i.resolved_at AS resolvedAt, i.resolution_action AS resolutionAction, i.resolution_note AS resolutionNote,
            i.paid_override_reason AS paidOverrideReason
     FROM invoices i JOIN users u ON u.id = i.user_id JOIN payroll_runs p ON p.id = i.payroll_run_id WHERE i.id = ?`,
    [id],
  ) ?? null, null);
}

function profileSnapshot(db: Db, userId: number): Snap | null {
  return soft(() => get<Snap>(
    db,
    `SELECT id, TRIM(first_name || ' ' || last_name) AS name, address_line1 AS addressLine1, address_line2 AS addressLine2,
            address_town AS addressTown, postcode, utr, vat_number AS vatNumber FROM users WHERE id = ?`,
    [userId],
  ) ?? null, null);
}

function companySnapshot(db: Db): Snap {
  const raw = soft(() => get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'ext:invoices:company'`)?.value ?? null, null);
  try {
    const v = raw ? (JSON.parse(raw) as Snap) : {};
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

const invoiceLabel = (s: Snap | null): string =>
  s ? `invoice ${str(s.number, '?')} (${str(s.userName, 'someone')}, ${auditWeekLabel(str(s.weekStart))}, ${auditMoney(num(s.total))})` : 'an invoice';

/** A route that changes one invoice (:id): before/after snapshots, entity 'invoice'. */
function invoiceRoute(method: 'POST', pattern: string, summary: (before: Snap | null, after: Snap | null, done: AuditDone) => string, skipUnchanged = false): AuditRouteSpec<Snap | null> {
  return {
    method,
    pattern,
    before: (db, call) => {
      const id = toId(call.params.id);
      return id ? invoiceSnapshot(db, id) : null;
    },
    after(db, done, before) {
      const id = toId(done.params.id);
      const after = id ? invoiceSnapshot(db, id) : null;
      if (skipUnchanged && before && after && !auditDiff(before, after).length) return [];
      return [{ entity: 'invoice', entityId: id, summary: summary(before ?? null, after, done), before: before ?? null, after }];
    },
  };
}

const PROFILE_FIELDS: Record<string, string> = {
  addressLine1: 'address', addressLine2: 'address', addressTown: 'town', postcode: 'postcode', utr: 'UTR', vatNumber: 'VAT number',
};
const changedProfileFields = (before: Snap | null, after: Snap | null): string =>
  [...new Set(auditDiff(before, after).map((c) => PROFILE_FIELDS[c.field] ?? c.field))].join(', ');

function profileRoute(pattern: string, self: boolean): AuditRouteSpec<Snap | null> {
  return {
    method: 'PUT',
    pattern,
    before: (db, call: AuditCall) => {
      const id = self ? call.me?.id ?? null : toId(call.params.userId);
      return id ? profileSnapshot(db, id) : null;
    },
    after(db, done, before) {
      const id = self ? done.me?.id ?? null : toId(done.params.userId);
      const after = id ? profileSnapshot(db, id) : null;
      if (before && after && !auditDiff(before, after).length) return [];
      const fields = changedProfileFields(before ?? null, after) || 'nothing';
      // a new VAT number adds no VAT until the office confirms it (POST …/vat/confirm)
      const waits = after?.vatNumber && after.vatNumber !== before?.vatNumber ? ' (the VAT number waits for the office to check it)' : '';
      const summary = self ? `Updated their invoice details: ${fields}${waits}` : `Updated invoice details for ${str(after?.name, 'someone')}: ${fields}${waits}`;
      return [{ entity: 'user', entityId: id, summary, before: before ?? null, after }];
    },
  };
}

/** A person's VAT number and its confirmation (MON-7). */
function vatSnapshot(db: Db, userId: number): Snap | null {
  return soft(() => get<Snap>(
    db,
    `SELECT id, TRIM(first_name || ' ' || last_name) AS name, vat_number AS vatNumber, vat_changed_at AS vatChangedAt,
            vat_changed_by AS vatChangedBy, vat_confirmed_at AS vatConfirmedAt, vat_confirmed_by AS vatConfirmedBy FROM users WHERE id = ?`,
    [userId],
  ) ?? null, null);
}

/** MON-7: an administrator confirmed someone's VAT number (checked with HMRC); a wrong code is recorded too. */
const vatConfirm: AuditRouteSpec<Snap | null> = {
  method: 'POST',
  pattern: '/invoices/profile/:userId/vat/confirm',
  before: (db, call) => {
    const id = toId(call.params.userId);
    return id ? vatSnapshot(db, id) : null;
  },
  after(db, done, before) {
    const id = toId(done.params.userId);
    const after = id ? vatSnapshot(db, id) : null;
    if (!after?.vatConfirmedAt || before?.vatConfirmedAt) return [];
    return [{
      entity: 'user',
      entityId: id,
      summary: `Confirmed ${str(after.name, 'someone')}'s VAT number ${formatVatNumber(str(after.vatNumber))} (checked with HMRC): VAT at 20% is added to their invoices from now on`,
      before: before ?? null,
      after,
    }];
  },
  failed(_db, done): AuditDraft[] {
    if (!done.me) return [];
    const id = toId(done.params.userId);
    const error = isRecord(done.response) ? str(done.response.error) : '';
    if (done.status === 429) return [{ entity: 'user', entityId: id, summary: 'Two-step code refused while confirming a VAT number: too many attempts', kind: 'sign_in', after: { reason: 'too_many_attempts' } }];
    if (done.status === 400 && error === WRONG_PAYMENT_CODE_MESSAGE) return [{ entity: 'user', entityId: id, summary: 'Wrong two-step code while confirming a VAT number', kind: 'sign_in', after: { reason: 'wrong_code' } }];
    return [];
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  {
    method: 'POST',
    pattern: '/invoices/agreement/accept',
    before: (db, call) => (call.me ? soft(() => get<Snap>(db, `SELECT accepted_at AS acceptedAt FROM self_billing_agreements WHERE user_id = ? AND version = ?`, [call.me!.id, SELF_BILLING_AGREEMENT_VERSION]) ?? null, null) : null),
    after(_db, done, before) {
      if (before || !done.me) return []; // already accepted: nothing changed
      const r = isRecord(done.response) ? done.response : {};
      return [{ entity: 'agreement', entityId: done.me.id, summary: `Accepted the self-billing agreement (version ${str(r.version, SELF_BILLING_AGREEMENT_VERSION)})`, before: null, after: { version: r.version, acceptedAt: r.acceptedAt } }];
    },
  },
  profileRoute('/invoices/profile', true),
  profileRoute('/invoices/profile/:userId', false),
  vatConfirm,
  {
    method: 'PUT',
    pattern: '/invoices/company',
    before: (db) => companySnapshot(db),
    after(db, _done, before) {
      const after = companySnapshot(db);
      const changes = auditDiff(before ?? {}, after);
      if (!changes.length) return [];
      return [{ entity: 'settings', entityId: null, summary: `Updated the company details on invoices: ${auditChangeText(changes, { max: 4 })}`, before: before ?? null, after }];
    },
  },
  invoiceRoute('POST', '/invoices/:id/accept', (_b, after) => `Accepted ${invoiceLabel(after)}`, true),
  invoiceRoute('POST', '/invoices/:id/dispute', (_b, after) => `Said something's wrong with ${invoiceLabel(after)}: ${quote(str(after?.disputeReason))}`),
  invoiceRoute('POST', '/invoices/:id/resolve', (before, after) =>
    after?.resolutionAction === 'keep'
      ? `Kept ${invoiceLabel(after)} as it is: ${quote(str(after?.resolutionNote))}`
      : `Fixed and reissued ${invoiceLabel(after)} as version ${num(after?.version)}${before ? ` (was ${auditMoney(num(before.total))})` : ''}: ${quote(str(after?.resolutionNote))}`),
  // Refines the 1.2 entry for Mark paid: same row; the invoice and the admin's reason when it was not accepted.
  {
    method: 'POST',
    pattern: '/finance/payroll/:id/pay',
    before: (db, call) => {
      const id = toId(call.params.id);
      if (!id) return null;
      const overrideAt = soft(() => get<{ at: string | null }>(db, `SELECT paid_override_at AS at FROM invoices WHERE payroll_run_id = ?`, [id])?.at ?? null, null);
      return { run: payrollSnapshot(db, id), overrideAt };
    },
    after(db, done, state: { run: Snap | null; overrideAt: string | null } | null | undefined) {
      const id = toId(done.params.id);
      const before = state?.run ?? null;
      const after = id ? payrollSnapshot(db, id) : null;
      const s = after ?? before;
      const invoice = id ? soft(() => get<{ id: number; number: string; status: string; reason: string | null; at: string | null }>(
        db,
        `SELECT id, number, status, paid_override_reason AS reason, paid_override_at AS at FROM invoices WHERE payroll_run_id = ?`,
        [id],
      ) ?? null, null) : null;
      let summary = s
        ? `${s.status === 'late' ? 'Marked paid (late)' : 'Marked paid'}: ${str(s.userName, 'Someone')} ${auditWeekLabel(String(s.weekStart))}, ${auditMoney(num(s.gross))}`
        : 'Marked a pay run paid';
      // the hook wrote the override during this request: its time is new
      const overridden = !!invoice?.reason && !!invoice.at && invoice.at !== (state?.overrideAt ?? null);
      if (overridden) summary += ` without an accepted invoice (${invoice!.number}). Reason: ${quote(invoice!.reason!)}`;
      const afterSnap = after && invoice ? { ...after, invoiceNumber: invoice.number, invoiceStatus: invoice.status, ...(overridden ? { overrideReason: invoice.reason } : {}) } : after;
      return [{ entity: 'payroll_run', entityId: id, summary, before, after: afterSnap }];
    },
  },
];
