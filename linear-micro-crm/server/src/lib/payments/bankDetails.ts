/**
 * Release 1.4 — OWNED BY F payments-foundation: bank details (table bank_accounts, db/extensions/payments.ts).
 *
 *  - One set per person. The sort code and account number are encrypted (lib/crypto.ts) and only ever decrypted for a
 *    payment (`decryptedBankDetails`, lib/payments/batches.ts) — every API answer is masked ("••-••-34", "••••5678").
 *  - Who: a person sees and changes their own (every staff role; never a client account); the admin sees anyone's
 *    (masked) and may change anyone's. Leaders and recruiters see nothing of anyone else's.
 *  - A change needs the changer's current two-step code when they have two-step verification on.
 *  - The hold: a change by the person themself leaves the details unconfirmed — the next payment to them waits (skipped
 *    with a plain reason) until an admin confirms them (POST /users/:id/bank-details/confirm), and the admin's
 *    Needs-attention feed says so. Details an admin types in for someone count as confirmed by that admin.
 *  - Saving the same details again changes nothing (no audit row, no new hold).
 */
import { maskAccountNumber, maskSortCode, validateBankDetails, type BankDetails, type BankDetailsState, type BankDetailsView, type UserWithTeam } from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../../db/connection.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { nowISO } from '../dates.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { isTwoFactorEnabled } from '../twofactor.ts';

interface BankRow {
  userId: number;
  holderName: string;
  sortCodeEnc: string;
  accountNumberEnc: string;
  last4: string;
  sortCodeLast2: string;
  changedAt: string;
  changedBy: number | null;
  changedByName: string | null;
  confirmedAt: string | null;
  confirmedBy: number | null;
  confirmedByName: string | null;
}

const BANK_SELECT = `
  SELECT b.user_id AS userId, b.holder_name AS holderName, b.sort_code_enc AS sortCodeEnc, b.account_number_enc AS accountNumberEnc,
         b.last4, b.sort_code_last2 AS sortCodeLast2, b.changed_at AS changedAt, b.changed_by AS changedBy,
         TRIM(cu.first_name || ' ' || cu.last_name) AS changedByName, b.confirmed_by_admin_at AS confirmedAt,
         b.confirmed_by AS confirmedBy, TRIM(fu.first_name || ' ' || fu.last_name) AS confirmedByName
  FROM bank_accounts b
  LEFT JOIN users cu ON cu.id = b.changed_by
  LEFT JOIN users fu ON fu.id = b.confirmed_by`;

/** Changed since the last admin confirmation (or never confirmed): payments wait. */
export function needsConfirmation(r: { changedAt: string; confirmedAt: string | null }): boolean {
  return r.confirmedAt === null || r.confirmedAt < r.changedAt;
}

function masked(r: BankRow): BankDetails {
  return {
    userId: r.userId,
    holderName: r.holderName,
    sortCodeMasked: maskSortCode(r.sortCodeLast2),
    accountNumberMasked: maskAccountNumber(r.last4),
    last4: r.last4,
    sortCodeLast2: r.sortCodeLast2,
    changedAt: r.changedAt,
    changedBy: r.changedBy,
    changedByName: r.changedByName || null,
    confirmedByAdminAt: r.confirmedAt,
    confirmedByName: r.confirmedByName || null,
    needsConfirmation: needsConfirmation(r),
  };
}

function bankRow(db: Db, userId: number): BankRow | undefined {
  return get<BankRow>(db, `${BANK_SELECT} WHERE b.user_id = ?`, [userId]);
}

/** The masked details (null when the person has none). */
export function bankDetailsFor(db: Db, userId: number): BankDetails | null {
  const r = bankRow(db, userId);
  return r ? masked(r) : null;
}

export function bankDetailsState(d: BankDetails | null): BankDetailsState {
  if (!d) return 'missing';
  return d.needsConfirmation ? 'needs_confirmation' : 'ready';
}

/** Who may read or change `targetId`'s details: themself (staff), or an admin. 403 / 404 otherwise. */
export function assertBankDetailsAccess(db: Db, me: UserWithTeam, targetId: number): void {
  if (me.role === 'client') throw forbidden('Bank details are for staff only');
  if (me.id === targetId) return;
  if (me.role !== 'admin') throw forbidden('Only an administrator can see other people’s bank details');
  const target = get<{ role: string }>(db, `SELECT role FROM users WHERE id = ?`, [targetId]);
  if (!target) throw notFound('User');
  if (target.role === 'client') throw badRequest('Client accounts are not paid, so they have no bank details');
}

/** What GET answers: the masked details, and whether a change needs the viewer's two-step code. */
export function bankDetailsView(db: Db, viewer: UserWithTeam, targetId: number): BankDetailsView {
  return { details: bankDetailsFor(db, targetId), codeRequired: isTwoFactorEnabled(db, viewer.id) };
}

export interface SaveResult {
  view: BankDetailsView;
  /** false: the same details were saved again (nothing written). */
  changed: boolean;
  before: BankDetails | null;
}

/**
 * Validates and stores `input` for `targetId`, changed by `actor` (the caller has already checked access and the
 * two-step code). 400 with one message per field when something is wrong.
 */
export function saveBankDetails(db: Db, actor: UserWithTeam, targetId: number, input: { holderName: unknown; sortCode: unknown; accountNumber: unknown }): SaveResult {
  const checked = validateBankDetails(input);
  if (!checked.ok) throw badRequest(checked.errors[0]!.message, checked.errors);
  const v = checked.value;
  const existing = bankRow(db, targetId);
  const before = existing ? masked(existing) : null;
  if (existing && existing.holderName === v.holderName && safeDecrypt(existing.sortCodeEnc) === v.sortCode && safeDecrypt(existing.accountNumberEnc) === v.accountNumber) {
    return { view: bankDetailsView(db, actor, targetId), changed: false, before };
  }
  const at = nowISO();
  // details an admin types in count as checked by that admin; a person's own change waits for the admin's check
  const confirmed = actor.role === 'admin';
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET holder_name = excluded.holder_name, sort_code_enc = excluded.sort_code_enc,
       account_number_enc = excluded.account_number_enc, last4 = excluded.last4, sort_code_last2 = excluded.sort_code_last2,
       changed_at = excluded.changed_at, changed_by = excluded.changed_by, confirmed_by_admin_at = excluded.confirmed_by_admin_at,
       confirmed_by = excluded.confirmed_by`,
    [targetId, v.holderName, encrypt(v.sortCode), encrypt(v.accountNumber), v.accountNumber.slice(-4), v.sortCode.slice(-2), at, actor.id, confirmed ? at : null, confirmed ? actor.id : null],
  );
  return { view: bankDetailsView(db, actor, targetId), changed: true, before };
}

/** The admin checked the details with the person: payments may use them. 404 when there are none. */
export function confirmBankDetails(db: Db, admin: UserWithTeam, targetId: number): { view: BankDetailsView; changed: boolean } {
  const r = bankRow(db, targetId);
  if (!r) throw notFound('Bank details');
  if (!needsConfirmation(r)) return { view: bankDetailsView(db, admin, targetId), changed: false };
  const at = nowISO();
  run(db, `UPDATE bank_accounts SET confirmed_by_admin_at = ?, confirmed_by = ? WHERE user_id = ?`, [at > r.changedAt ? at : r.changedAt, admin.id, targetId]);
  return { view: bankDetailsView(db, admin, targetId), changed: true };
}

function safeDecrypt(payload: string): string | null {
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

export interface DecryptedBankDetails {
  userId: number;
  holderName: string;
  sortCode: string;
  accountNumber: string;
  last4: string;
  changedAt: string;
  confirmedAt: string | null;
}

/** For a payment only: the full details of these people (one query). Rows that cannot be decrypted are left out. */
export function decryptedBankDetails(db: Db, userIds: readonly number[]): Map<number, DecryptedBankDetails> {
  const out = new Map<number, DecryptedBankDetails>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return out;
  const rows = all<BankRow>(db, `${BANK_SELECT} WHERE b.user_id IN (${placeholders(ids.length)})`, ids);
  for (const r of rows) {
    const sortCode = safeDecrypt(r.sortCodeEnc);
    const accountNumber = safeDecrypt(r.accountNumberEnc);
    if (!sortCode || !accountNumber) continue;
    out.set(r.userId, { userId: r.userId, holderName: r.holderName, sortCode, accountNumber, last4: r.last4, changedAt: r.changedAt, confirmedAt: r.confirmedAt });
  }
  return out;
}

/** Masked details of these people (one query): batches and Team. */
export function maskedBankDetails(db: Db, userIds: readonly number[]): Map<number, BankDetails> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  return new Map(all<BankRow>(db, `${BANK_SELECT} WHERE b.user_id IN (${placeholders(ids.length)})`, ids).map((r) => [r.userId, masked(r)]));
}
