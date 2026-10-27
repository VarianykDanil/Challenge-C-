/**
 * Release 1.4 — OWNED BY F payments-foundation: bank details (table bank_accounts, db/extensions/payments.ts).
 *
 *  - One set per person. The sort code and account number are encrypted (lib/crypto.ts) and only ever decrypted for a
 *    payment (`decryptedBankDetails`, lib/payments/batches.ts) — every API answer is masked ("••-••-34", "••••5678").
 *  - Who: a person sees and changes their own (every staff role; never a client account); the admin sees anyone's
 *    (masked) and may change anyone's. Leaders and recruiters see nothing of anyone else's.
 *  - A change needs the changer's current two-step code when they have two-step verification on; an administrator
 *    typing in someone else's details always needs a fresh code.
 *  - The hold (release 1.5, MON-3): no change is ever confirmed by the person who made it.
 *     · The person's own change waits for an administrator (POST /users/:id/bank-details/confirm, fresh code).
 *     · Details an administrator types in for someone (or an administrator's own change) wait for the person to
 *       confirm them in their own account (POST /me/bank-details/confirm) or a DIFFERENT administrator.
 *     · The person is told whenever someone else changed their details (Needs attention: "Your bank details were
 *       changed by … Confirm or report it") and may report them as not theirs (POST /me/bank-details/report): they are
 *       held, every administrator is told, and nobody can confirm them until new details are typed in.
 *    Payments skip details that are waiting (lib/payments/batches.ts). Every step is audited (never the numbers).
 *  - Saving the same details again changes nothing (no audit row, no new hold).
 */
import { maskAccountNumber, maskSortCode, validateBankDetails, type BankDetails, type BankDetailsState, type BankDetailsView, type UserWithTeam } from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../../db/connection.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { nowISO } from '../dates.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../errors.ts';
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
  reportedAt: string | null;
  personSeenAt: string | null;
}

const BANK_SELECT = `
  SELECT b.user_id AS userId, b.holder_name AS holderName, b.sort_code_enc AS sortCodeEnc, b.account_number_enc AS accountNumberEnc,
         b.last4, b.sort_code_last2 AS sortCodeLast2, b.changed_at AS changedAt, b.changed_by AS changedBy,
         TRIM(cu.first_name || ' ' || cu.last_name) AS changedByName, b.confirmed_by_admin_at AS confirmedAt,
         b.confirmed_by AS confirmedBy, TRIM(fu.first_name || ' ' || fu.last_name) AS confirmedByName,
         b.reported_at AS reportedAt, b.person_seen_at AS personSeenAt
  FROM bank_accounts b
  LEFT JOIN users cu ON cu.id = b.changed_by
  LEFT JOIN users fu ON fu.id = b.confirmed_by`;

/** Changed since the last confirmation (or never confirmed), or reported as not theirs: payments wait. */
export function needsConfirmation(r: { changedAt: string; confirmedAt: string | null; reportedAt?: string | null }): boolean {
  return r.confirmedAt === null || r.confirmedAt < r.changedAt || !!r.reportedAt;
}

/** Someone other than the person made the latest change (an administrator typed them in). */
const changedByOther = (r: Pick<BankRow, 'userId' | 'changedBy'>) => r.changedBy !== null && r.changedBy !== r.userId;

/** Who must confirm details that are waiting (null: nothing waits). */
function waitingFor(r: BankRow): BankDetails['waitingFor'] {
  if (!needsConfirmation(r)) return null;
  return changedByOther(r) || r.changedBy === null ? 'person_or_other_admin' : 'office';
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
    waitingFor: waitingFor(r),
    reportedAt: r.reportedAt ?? null,
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

/** Why `viewer` may not confirm `r` now (null: they may). */
function confirmRefusal(r: BankRow, viewer: Pick<UserWithTeam, 'id' | 'role'>): { status: 403 | 409; message: string } | null {
  if (r.reportedAt) return { status: 409, message: 'They reported these details as not theirs. Type in their correct details with them instead.' };
  if (!needsConfirmation(r)) return null;
  const own = viewer.id === r.userId;
  if (viewer.role === 'admin' && r.changedBy === viewer.id) {
    return { status: 403, message: own
      ? 'You changed your own details, so another administrator confirms them.'
      : 'You changed these details, so someone else confirms them: the person in their own account, or another administrator.' };
  }
  if (own) {
    if (!changedByOther(r)) return { status: 409, message: 'You changed these yourself, so an administrator checks them with you before the next payment goes there.' };
    return null;
  }
  if (viewer.role !== 'admin') return { status: 403, message: 'Only the person or an administrator can confirm bank details' };
  if (r.changedBy === viewer.id) {
    return { status: 403, message: 'You changed these details, so someone else confirms them: the person in their own account, or another administrator.' };
  }
  return null;
}

/**
 * Throws what confirming would refuse (before a two-step code is used up): 404 without details, 403 / 409 when
 * `viewer` may not confirm them. Details already confirmed pass (confirming them again changes nothing).
 */
export function assertMayConfirm(db: Db, viewer: UserWithTeam, targetId: number): void {
  const r = bankRow(db, targetId);
  if (!r) throw notFound('Bank details');
  if (viewer.id === targetId && changedByOther(r)) {
    if (r.reportedAt) throw conflict('You reported these details as not yours. The office types in your correct details with you.');
    return;
  }
  const no = needsConfirmation(r) ? confirmRefusal(r, viewer) : null;
  if (no) throw new HttpError(no.status, no.message, { code: no.status === 403 ? 'same_person' : viewer.id === targetId ? 'own_change' : 'bank_details_reported' });
}

/** What GET answers: the masked details, whether a change needs the viewer's two-step code, and what they may do. */
export function bankDetailsView(db: Db, viewer: UserWithTeam, targetId: number): BankDetailsView {
  const r = bankRow(db, targetId);
  const view: BankDetailsView = { details: r ? masked(r) : null, codeRequired: isTwoFactorEnabled(db, viewer.id) };
  if (!r) return view;
  const own = viewer.id === targetId;
  const unseen = changedByOther(r) && !r.reportedAt && (r.personSeenAt === null || r.personSeenAt < r.changedAt);
  view.canConfirm = (needsConfirmation(r) && confirmRefusal(r, viewer) === null) || (own && unseen);
  if (own) {
    view.canReport = changedByOther(r) && !r.reportedAt;
    view.changedBySomeoneElse = unseen;
  }
  return view;
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
  // MON-3: nobody confirms their own change. The person's change waits for an administrator; details an administrator
  // types in wait for the person or another administrator. A new change clears an earlier "not mine" report.
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by, reported_at, reported_note, person_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET holder_name = excluded.holder_name, sort_code_enc = excluded.sort_code_enc,
       account_number_enc = excluded.account_number_enc, last4 = excluded.last4, sort_code_last2 = excluded.sort_code_last2,
       changed_at = excluded.changed_at, changed_by = excluded.changed_by, confirmed_by_admin_at = NULL, confirmed_by = NULL,
       reported_at = NULL, reported_note = NULL, person_seen_at = excluded.person_seen_at`,
    [targetId, v.holderName, encrypt(v.sortCode), encrypt(v.accountNumber), v.accountNumber.slice(-4), v.sortCode.slice(-2), at, actor.id, actor.id === targetId ? at : null],
  );
  return { view: bankDetailsView(db, actor, targetId), changed: true, before };
}

/**
 * The admin checked the details with the person: payments may use them. 404 when there are none. Review fix
 * (cross:X-2): `expectedChangedAt` is the `changedAt` of the details the admin looked at; when the person changed them
 * again since, 409 and nothing is confirmed (the newer details stay held). Left out (older clients), whatever is
 * stored is confirmed, as before.
 */
export function confirmBankDetails(db: Db, admin: UserWithTeam, targetId: number, expectedChangedAt?: string): { view: BankDetailsView; changed: boolean } {
  const r = bankRow(db, targetId);
  if (!r) throw notFound('Bank details');
  if (!needsConfirmation(r)) return { view: bankDetailsView(db, admin, targetId), changed: false };
  if (expectedChangedAt !== undefined && expectedChangedAt !== r.changedAt) {
    throw new HttpError(409, 'They changed their bank details again since you looked: check the new ones before confirming.', { code: 'bank_details_changed' });
  }
  const no = confirmRefusal(r, admin);
  if (no) throw new HttpError(no.status, no.message, { code: no.status === 403 ? 'same_person' : 'bank_details_reported' });
  const at = nowISO();
  run(db, `UPDATE bank_accounts SET confirmed_by_admin_at = ?, confirmed_by = ? WHERE user_id = ?`, [at > r.changedAt ? at : r.changedAt, admin.id, targetId]);
  return { view: bankDetailsView(db, admin, targetId), changed: true };
}

/** 409 unless the latest change was made by someone else (the only case the person confirms or reports). */
function assertChangedByOther(r: BankRow | undefined, doing: string): asserts r is BankRow {
  if (!r) throw notFound('Bank details');
  if (!changedByOther(r)) throw conflict(`You changed these yourself, so there is nothing to ${doing}: an administrator checks them with you.`);
}

/**
 * MON-3: the person says "yes, these are mine" about details someone else typed in: they are confirmed (when they were
 * waiting) and the notice goes. `expectedChangedAt` as for the admin's confirmation.
 */
export function confirmOwnBankDetails(db: Db, me: UserWithTeam, expectedChangedAt?: string): { view: BankDetailsView; changed: boolean } {
  const r = bankRow(db, me.id);
  if (r && !changedByOther(r)) {
    const no = confirmRefusal(r, me);
    if (no) throw new HttpError(no.status, no.message, { code: 'own_change' });
  }
  assertChangedByOther(r, 'confirm');
  if (r.reportedAt) throw conflict('You reported these details as not yours. The office types in your correct details with you.');
  if (expectedChangedAt !== undefined && expectedChangedAt !== r.changedAt) {
    throw new HttpError(409, 'Your bank details were changed again since you looked: check the new ones first.', { code: 'bank_details_changed' });
  }
  const at = nowISO();
  const waiting = needsConfirmation(r);
  const stamp = at > r.changedAt ? at : r.changedAt;
  if (waiting) run(db, `UPDATE bank_accounts SET confirmed_by_admin_at = ?, confirmed_by = ?, person_seen_at = ? WHERE user_id = ?`, [stamp, me.id, stamp, me.id]);
  else run(db, `UPDATE bank_accounts SET person_seen_at = ? WHERE user_id = ?`, [stamp, me.id]);
  return { view: bankDetailsView(db, me, me.id), changed: true };
}

/** MON-3: the person says "these are not my details": held for every payment until new details are typed in. */
export function reportBankDetails(db: Db, me: UserWithTeam, note: string | null): BankDetailsView {
  const r = bankRow(db, me.id);
  assertChangedByOther(r, 'report');
  if (r.reportedAt) return bankDetailsView(db, me, me.id);
  const at = nowISO();
  run(db, `UPDATE bank_accounts SET reported_at = ?, reported_note = ?, person_seen_at = ? WHERE user_id = ?`, [at, note, at, me.id]);
  return bankDetailsView(db, me, me.id);
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
  reportedAt: string | null;
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
    out.set(r.userId, { userId: r.userId, holderName: r.holderName, sortCode, accountNumber, last4: r.last4, changedAt: r.changedAt, confirmedAt: r.confirmedAt, reportedAt: r.reportedAt ?? null });
  }
  return out;
}

/** Masked details of these people (one query): batches and Team. */
export function maskedBankDetails(db: Db, userIds: readonly number[]): Map<number, BankDetails> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  return new Map(all<BankRow>(db, `${BANK_SELECT} WHERE b.user_id IN (${placeholders(ids.length)})`, ids).map((r) => [r.userId, masked(r)]));
}
