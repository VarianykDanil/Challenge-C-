/**
 * Release 1.3 — OWNED BY P9 audit-everything. What a FAILED sign-in or security check writes to the audit trail
 * (the `failed` hooks of the 1.2 sign-in, PIN and two-step specs in lib/auditSpecs.ts; lib/audit.ts runs them on a 4xx
 * answer, within its failure budget). Kind `sign_in`. Never the PIN, the code, the employee ID typed or the challenge
 * token: only what happened, to which account, and (for an email nobody has) the email typed — only when it is an
 * email (the Login page's test), so an employee ID typed into the email box is never kept. Every snapshot has a
 * `reason` (shared AUDIT_SIGN_IN_REASONS; the trail says it in words).
 *
 *   POST /auth/login       401 → "Failed sign-in: wrong employee ID" · "…: the account is deactivated" ·
 *                                "Failed sign-in with an unknown email: jo@example.com" · "Failed sign-in: wrong PIN
 *                                (4 tries left before a lock)"
 *                          423 → "PIN locked after 10 wrong PINs in a row, until 14:35" (this try started the lock) ·
 *                                "Sign-in refused: the PIN is locked until 14:35" (it was locked already)
 *                          429 → "Sign-in refused: too many attempts, try again in 12 minutes"
 *   POST /auth/login/2fa   401 → "Failed sign-in: wrong two-step code" · 410 → "Sign-in stopped: too many wrong
 *                                two-step codes" / "…: the two-step code was not entered within 5 minutes" · 429
 *   POST /auth/pin(/remove) 400 wrong current PIN → "Wrong current PIN while changing their PIN" · 423 → "PIN locked …"
 *                          · 429
 *   POST /auth/2fa/enable | disable | recovery-codes   400 wrong code → "Wrong two-step code while turning on two-step
 *                                verification" · 429
 * Validation answers (a missing field, a PIN that breaks the rules) write nothing: nobody tried a credential.
 * The account a failure is filed under is the one the email (or the challenge) belongs to: entity `user`, and the row's
 * person is that account, so Team → person → Activity shows the failed attempts on it.
 */
import { PIN_LOCK_AFTER_FAILURES, type AuditSignInReason } from '@lm/shared';
import { get, type Db } from '../../db/connection.ts';
import type { AuditCall, AuditDone, AuditDraft } from '../auditSpecs.ts';
import { pinUnlockTime } from '../pin.ts';

/** The words routes/auth.ts answers with (a test holds them equal to its exports). */
export const SIGN_IN_MESSAGES = {
  wrongCurrentPin: 'Your current PIN is not right',
  wrongCode: 'That code is not valid',
  tooManyCodes: 'Too many wrong codes for this sign-in, start again',
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const responseOf = (done: AuditDone): Record<string, unknown> => (isRecord(done.response) ? done.response : {});
const detailsOf = (done: AuditDone): Record<string, unknown> => {
  const d = responseOf(done).details;
  return isRecord(d) ? d : {};
};
const errorOf = (done: AuditDone): string => {
  const e = responseOf(done).error;
  return typeof e === 'string' ? e : '';
};

interface Account {
  id: number;
  name: string;
  status: string;
}

export interface SignInState {
  account: Account | null;
  /** What was typed in the email box (trimmed, lower case, at most 80 characters). */
  typedEmail: string;
  /** The account's PIN was locked already when the request arrived. */
  pinLockedBefore: boolean;
}

const ACCOUNT_SELECT = `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.status FROM users u`;

/**
 * The Login page's email test (client/src/pages/Login.tsx EMAIL_RE): text, one "@", text with a dot — and, stricter
 * than the page, no control or invisible format character (\p{C}: bidi overrides, zero-width characters), so an
 * anonymous caller cannot store an "unknown email" that displays as somebody else's address. Anything else is kept
 * as no email at all.
 */
export const EMAIL_SHAPE = /^[^\s@\p{C}]+@[^\s@\p{C}]+\.[^\s@\p{C}]+$/u;

/** What a failed attempt's row keeps: why it failed, and a few facts (never what was typed but an email). */
type FailureFacts = { reason: AuditSignInReason } & Record<string, unknown>;

function lockedNow(db: Db, userId: number): boolean {
  const row = get<{ until: string | null }>(db, `SELECT pin_locked_until AS until FROM users WHERE id = ? AND pin_hash IS NOT NULL`, [userId]);
  return Boolean(row?.until && Date.parse(row.until) > Date.now());
}

/** POST /auth/login, before the handler: whose account the email belongs to (one indexed lookup). */
export function signInBefore(db: Db, call: AuditCall): SignInState {
  const body = isRecord(call.body) ? call.body : {};
  const typedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 80) : '';
  const account = typedEmail ? (get<Account>(db, `${ACCOUNT_SELECT} WHERE lower(u.email) = ?`, [typedEmail]) ?? null) : null;
  return { account, typedEmail, pinLockedBefore: account ? lockedNow(db, account.id) : false };
}

const filed = (account: Account | null, summary: string, after: FailureFacts): AuditDraft => ({
  entity: account ? 'user' : null,
  entityId: account?.id ?? null,
  userId: account?.id ?? null,
  summary,
  before: null,
  after,
  kind: 'sign_in',
});

const unlockText = (lockedUntil: unknown) => (typeof lockedUntil === 'string' && lockedUntil ? pinUnlockTime(lockedUntil) : 'later');

/** "try again in 12 minutes" from the limiter's sentence, else "" (lib/limiter.ts words it). */
function retryText(done: AuditDone): string {
  const m = /try again in (\d+ minutes?)/i.exec(errorOf(done));
  return m ? `, try again in ${m[1]}` : '';
}

/** POST /auth/login answered 4xx. */
export function signInFailed(_db: Db, done: AuditDone, state: SignInState | undefined): AuditDraft[] {
  const account = state?.account ?? null;
  const body = responseOf(done);
  const details = detailsOf(done);
  if (done.status === 429) return [filed(account, `Sign-in refused: too many attempts${retryText(done)}`, { reason: 'too_many_attempts' })];
  if (done.status === 423 && details.reason === 'locked') {
    const until = unlockText(details.lockedUntil);
    if (state?.pinLockedBefore) return [filed(account, `Sign-in refused: the PIN is locked until ${until}`, { reason: 'pin_locked', lockedUntil: details.lockedUntil ?? null })];
    return [filed(account, `PIN locked after ${PIN_LOCK_AFTER_FAILURES} wrong PINs in a row, until ${until}`, { reason: 'pin_locked_now', lockedUntil: details.lockedUntil ?? null })];
  }
  if (done.status !== 401) return []; // 400: a missing field; nobody tried a credential
  if (body.requiresPin === true && details.reason === 'wrong') {
    const left = typeof details.attemptsLeft === 'number' ? details.attemptsLeft : null;
    const tail = left === null ? '' : ` (${left === 1 ? '1 try' : `${left} tries`} left before a lock)`;
    return [filed(account, `Failed sign-in: wrong PIN${tail}`, { reason: 'wrong_pin', attemptsLeft: left })];
  }
  if (!account) {
    // an email nobody has is kept (whose address is being tried); anything else typed into the box is not
    const email = state?.typedEmail && EMAIL_SHAPE.test(state.typedEmail) ? state.typedEmail : null;
    return [filed(null, `Failed sign-in with an unknown email${email ? `: ${email}` : ''}`, { reason: 'unknown_email', typedEmail: email })];
  }
  if (account.status === 'left') return [filed(account, 'Failed sign-in: the account is deactivated', { reason: 'deactivated' })];
  return [filed(account, 'Failed sign-in: wrong employee ID', { reason: 'wrong_employee_id' })];
}

export interface TwoFactorSignInState {
  account: Account | null;
}

/** POST /auth/login/2fa, before the handler: the account the challenge belongs to (the token is only looked up). */
export function twoFactorSignInBefore(db: Db, call: AuditCall): TwoFactorSignInState {
  const body = isRecord(call.body) ? call.body : {};
  const token = typeof body.challengeToken === 'string' ? body.challengeToken.trim().slice(0, 128) : '';
  if (!token) return { account: null };
  const account = get<Account>(db, `${ACCOUNT_SELECT} JOIN two_factor_challenges c ON c.user_id = u.id WHERE c.token = ?`, [token]) ?? null;
  return { account };
}

/** POST /auth/login/2fa answered 4xx (an unknown challenge writes nothing: there is no account to file it under). */
export function twoFactorSignInFailed(_db: Db, done: AuditDone, state: TwoFactorSignInState | undefined): AuditDraft[] {
  const account = state?.account ?? null;
  if (!account) return [];
  if (done.status === 429) return [filed(account, `Sign-in refused: too many attempts${retryText(done)}`, { reason: 'too_many_attempts' })];
  if (done.status === 401) return [filed(account, 'Failed sign-in: wrong two-step code', { reason: 'wrong_code' })];
  if (done.status === 410) {
    return errorOf(done) === SIGN_IN_MESSAGES.tooManyCodes
      ? [filed(account, 'Sign-in stopped: too many wrong two-step codes', { reason: 'too_many_codes' })]
      : [filed(account, 'Sign-in stopped: the two-step code was not entered within 5 minutes', { reason: 'challenge_expired' })];
  }
  return [];
}

const self = (done: AuditDone, summary: string, after: FailureFacts): AuditDraft[] =>
  done.me ? [{ entity: 'user', entityId: done.me.id, summary, before: null, after, kind: 'sign_in' }] : [];

const isWrongCurrentPin = (done: AuditDone) =>
  done.status === 400 && errorOf(done) === SIGN_IN_MESSAGES.wrongCurrentPin;

/** POST /auth/pin and /auth/pin/remove answered 4xx: a wrong current PIN, a lock, the limiter. */
export function pinCheckFailed(doing: 'changing' | 'removing') {
  return (_db: Db, done: AuditDone): AuditDraft[] => {
    if (done.status === 429) return self(done, `PIN ${doing === 'changing' ? 'change' : 'removal'} refused: too many attempts${retryText(done)}`, { reason: 'too_many_attempts' });
    if (done.status === 423) {
      const m = /after (.+?), or ask/i.exec(errorOf(done));
      return self(done, `PIN locked after wrong current PINs while ${doing} their PIN${m ? `, until ${m[1]}` : ''}`, { reason: 'pin_locked' });
    }
    if (isWrongCurrentPin(done)) return self(done, `Wrong current PIN while ${doing} their PIN`, { reason: 'wrong_current_pin' });
    return [];
  };
}

/** POST /auth/2fa/enable | disable | recovery-codes answered 4xx: a wrong code or the limiter. */
export function codeCheckFailed(doing: string) {
  return (_db: Db, done: AuditDone): AuditDraft[] => {
    if (done.status === 429) return self(done, `Two-step code refused while ${doing}: too many attempts${retryText(done)}`, { reason: 'too_many_attempts' });
    if (done.status === 400 && errorOf(done) === SIGN_IN_MESSAGES.wrongCode) return self(done, `Wrong two-step code while ${doing}`, { reason: 'wrong_code' });
    return [];
  };
}
