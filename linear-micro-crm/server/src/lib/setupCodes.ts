/**
 * One-time setup codes. Every new account (Add person, a hire, a client invite, the first owner `npm run golive`
 * makes) and every admin reset of someone's two-step verification or PIN gets a random code: shown once, valid for
 * 7 days, single use, stored only as a SHA-256 hash. An account that has not finished setting up (no two-step yet, or
 * an admin reset its PIN) can only sign in with that code, so knowing someone's email and employee ID is never enough
 * to start their account and pick its PIN and authenticator.
 *
 * A new code replaces any unused one for the same person. Codes are about 59 random bits (shared SETUP_CODE_*), so a
 * plain hash is enough: there is nothing to guess within 7 days, and wrong codes count against the sign-in limiter.
 * Nothing here logs a code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SETUP_CODE_ALPHABET, SETUP_CODE_DAYS, SETUP_CODE_LENGTH, normaliseSetupCode } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';

export type SetupCodeReason = 'new_account' | 'reset_2fa' | 'reset_pin' | 'reissue' | 'golive' | 'command';

export interface IssuedSetupCode {
  code: string;
  expiresAt: string;
}

/** Twelve symbols from the unambiguous alphabet, drawn uniformly (rejection sampling, no modulo bias). */
export function generateSetupCode(): string {
  const n = SETUP_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < SETUP_CODE_LENGTH) {
    for (const byte of randomBytes(32)) {
      if (byte >= limit) continue;
      out += SETUP_CODE_ALPHABET[byte % n];
      if (out.length === SETUP_CODE_LENGTH) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

export function hashSetupCode(normalised: string): string {
  return createHash('sha256').update(`setup-code:${normalised}`, 'utf8').digest('hex');
}

/**
 * Makes a new code for `userId` (any unused older one stops working) and returns it, the only time it exists in plain.
 * Runs inside the caller's transaction when there is one.
 */
export function issueSetupCode(db: Db, userId: number, opts: { createdBy: number | null; reason: SetupCodeReason; now?: Date }): IssuedSetupCode {
  const now = opts.now ?? new Date();
  const code = generateSetupCode();
  const expiresAt = new Date(now.getTime() + SETUP_CODE_DAYS * 86_400_000).toISOString();
  run(db, `DELETE FROM setup_codes WHERE user_id = ? AND used_at IS NULL`, [userId]);
  run(
    db,
    `INSERT INTO setup_codes (user_id, code_hash, reason, created_at, created_by, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [userId, hashSetupCode(code), opts.reason, now.toISOString(), opts.createdBy, expiresAt],
  );
  return { code, expiresAt };
}

/**
 * Uses up `typed` for `userId` when it is that person's unused, unexpired code: marks it used and clears the "next
 * sign-in needs a code" mark. False for anything else (wrong, used, expired, not a code at all).
 */
export function consumeSetupCode(db: Db, userId: number, typed: unknown, now: Date = new Date()): boolean {
  const normalised = normaliseSetupCode(typed);
  if (!normalised) return false;
  const used = run(
    db,
    `UPDATE setup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    [now.toISOString(), userId, hashSetupCode(normalised), now.toISOString()],
  ).changes;
  if (used !== 1) return false;
  run(db, `UPDATE users SET setup_code_required = 0 WHERE id = ? AND setup_code_required <> 0`, [userId]);
  return true;
}

/** After an admin PIN reset: the next sign-in needs a setup code even though two-step is on. */
export function requireSetupCodeAtNextSignIn(db: Db, userId: number): void {
  run(db, `UPDATE users SET setup_code_required = 1 WHERE id = ?`, [userId]);
}

/**
 * Does this account have to show a setup code to sign in? Every account but a one-tap demo account (trial mode) that
 * has no two-step verification yet, or whose PIN an admin reset.
 */
export function needsSetupCode(db: Db, userId: number, opts: { twoFactorEnabled: boolean; demoSignIn: boolean }): boolean {
  if (opts.demoSignIn) return false;
  if (!opts.twoFactorEnabled) return true;
  return Boolean(get<{ r: number }>(db, `SELECT setup_code_required AS r FROM users WHERE id = ?`, [userId])?.r);
}

/** When the person's current unused code stops working (null when they have none), for the Team page. */
export function openSetupCodeExpiry(db: Db, userId: number): string | null {
  return get<{ e: string }>(db, `SELECT expires_at AS e FROM setup_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`, [
    userId, new Date().toISOString(),
  ])?.e ?? null;
}
