/**
 * Two-step verification (TOTP) service: pending/active secrets encrypted at rest, single-use codes (the last
 * accepted time-step is remembered per user, so a code can never be replayed), single-use recovery codes (SHA-256
 * hashed), five-minute login challenges with an attempt cap and the failed-code limiters. Routes stay thin; nothing
 * in here logs a code or a secret.
 */
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { TwoFactorSetup, TwoFactorStatus } from '@lm/shared';
import { all, get, run, transaction, type Db } from '../db/connection.ts';
import { decrypt, decryptLegacy, encrypt } from './crypto.ts';
import { conflict, gone } from './errors.ts';
import { FailureLimiter } from './limiter.ts';
import { sessionKey } from './sessionKey.ts';
import { generateSecret, matchTotpCounter, otpauthUrl } from './totp.ts';

export const TOTP_ISSUER = 'Linear Hub';
export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Wrong codes one login challenge absorbs before it is consumed (`410`, back to step one). */
export const CHALLENGE_MAX_ATTEMPTS = 6;
/** Failed codes per (source address, user) before `429`, and the window they are counted in. */
export const CODE_MAX_FAILURES = 6;
export const CODE_WINDOW_MS = 10 * 60_000;
/**
 * Backstop across every source address for one user (distributed guessing). Deliberately well above the per-source
 * limit so a stranger hammering the second step from one address cannot lock the real person out for long.
 */
export const CODE_MAX_FAILURES_PER_USER = 30;

interface TotpRow {
  id: number;
  email: string;
  secretEnc: string | null;
  pendingEnc: string | null;
  enabledAt: string | null;
  /** time-step counter of the last accepted authenticator code (RFC 6238 §5.2: one code, one use) */
  lastCounter: number | null;
}

function totpRow(db: Db, userId: number): TotpRow | undefined {
  return get<TotpRow>(
    db,
    `SELECT id, email, totp_secret_enc AS secretEnc, totp_pending_enc AS pendingEnc, totp_enabled_at AS enabledAt, totp_last_counter AS lastCounter FROM users WHERE id = ?`,
    [userId],
  );
}

export function isTwoFactorEnabled(db: Db, userId: number): boolean {
  return Boolean(totpRow(db, userId)?.enabledAt);
}

export function recoveryCodesLeft(db: Db, userId: number): number {
  return get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`, [userId])!.n;
}

export function twoFactorStatus(db: Db, userId: number): TwoFactorStatus {
  const row = totpRow(db, userId);
  const enabled = Boolean(row?.enabledAt);
  return {
    enabled,
    enabledAt: row?.enabledAt ?? null,
    recoveryCodesLeft: enabled ? recoveryCodesLeft(db, userId) : 0,
    pendingSetup: Boolean(row?.pendingEnc) && !enabled,
  };
}

// ── setup / enable / disable ─────────────────────────────────────────────────

/** Creates (or replaces) the pending secret and renders the QR code. `409` when 2FA is already on. */
export async function beginSetup(db: Db, userId: number): Promise<TwoFactorSetup> {
  const row = totpRow(db, userId);
  if (!row) throw conflict('Unknown user');
  if (row.enabledAt) throw conflict('Two-step verification is already on');
  const secret = generateSecret();
  run(db, `UPDATE users SET totp_pending_enc = ? WHERE id = ?`, [encrypt(secret), userId]);
  const url = otpauthUrl({ issuer: TOTP_ISSUER, label: `${TOTP_ISSUER}:${row.email}`, secret });
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret, otpauthUrl: url, qrSvg };
}

/**
 * Checks `code` against the pending secret and, when it matches, activates it (remembering the code's time step so
 * it cannot be used again), issues the recovery codes and signs out every *other* session (`keepSessionToken`).
 * Returns `null` on a wrong code so the route can answer 400 and count the failure. `409` when nothing is pending
 * or 2FA is already on.
 */
export function enableTwoFactor(db: Db, userId: number, code: string, keepSessionToken: string | undefined): string[] | null {
  const row = totpRow(db, userId);
  if (!row) throw conflict('Unknown user');
  if (row.enabledAt) throw conflict('Two-step verification is already on');
  if (!row.pendingEnc) throw conflict('No two-step setup is pending — start with setup');
  const counter = matchTotpCounter(decrypt(row.pendingEnc), code);
  if (counter === null) return null;
  return transaction(db, () => {
    run(db, `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = ?, totp_last_counter = ? WHERE id = ?`, [
      new Date().toISOString(), counter, userId,
    ]);
    const codes = writeRecoveryCodes(db, userId);
    if (keepSessionToken) run(db, `DELETE FROM sessions WHERE user_id = ? AND token <> ?`, [userId, sessionKey(keepSessionToken)]);
    else run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]);
    return codes;
  });
}

/** Removes the active and pending secrets, the replay marker and every recovery code (disable and the admin reset). */
export function clearTwoFactor(db: Db, userId: number): void {
  transaction(db, () => clearTwoFactorRows(db, userId));
}

/** clearTwoFactor without its own transaction, for a caller that holds one. */
export function clearTwoFactorRows(db: Db, userId: number): void {
  run(db, `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_counter = NULL WHERE id = ?`, [userId]);
  run(db, `DELETE FROM recovery_codes WHERE user_id = ?`, [userId]);
  run(db, `DELETE FROM two_factor_challenges WHERE user_id = ?`, [userId]);
}

/**
 * Rows encrypted by a release that ran on the built-in development key are re-encrypted under the real key at
 * start-up, so switching to the generated / configured secret never locks existing enrolments out. Returns how many
 * columns were rewritten. Rows that decrypt with neither key are left alone (the admin reset clears them).
 */
export function reencryptLegacySecrets(db: Db): number {
  let rewritten = 0;
  const rows = all<{ id: number; secretEnc: string | null; pendingEnc: string | null }>(
    db,
    `SELECT id, totp_secret_enc AS secretEnc, totp_pending_enc AS pendingEnc FROM users WHERE totp_secret_enc IS NOT NULL OR totp_pending_enc IS NOT NULL`,
  );
  const rekey = (payload: string | null): string | null => {
    if (!payload) return null;
    try {
      decrypt(payload);
      return null; // already under the current key
    } catch {
      try {
        const plain = decryptLegacy(payload);
        rewritten++;
        return encrypt(plain);
      } catch {
        return null; // unknown key: leave as is
      }
    }
  };
  transaction(db, () => {
    for (const r of rows) {
      const secret = rekey(r.secretEnc);
      const pending = rekey(r.pendingEnc);
      if (secret) run(db, `UPDATE users SET totp_secret_enc = ? WHERE id = ?`, [secret, r.id]);
      if (pending) run(db, `UPDATE users SET totp_pending_enc = ? WHERE id = ?`, [pending, r.id]);
    }
  });
  return rewritten;
}

// ── verification ──────────────────────────────────────────────────────────────

export type SecondFactor = 'totp' | 'recovery';

/**
 * Verifies a current authenticator code or an unused recovery code against the *active* secret. An authenticator
 * code is accepted once: its time-step counter must be greater than the last accepted one (a replay inside the
 * ±1-step window is refused like a wrong code) and is then stored. A matching recovery code is marked used on the
 * spot. Returns which factor matched, or `null`. Callers must check `isTwoFactorEnabled` first.
 */
export function verifySecondFactor(db: Db, userId: number, input: { code?: string; recoveryCode?: string }): SecondFactor | null {
  const row = totpRow(db, userId);
  if (!row?.secretEnc || !row.enabledAt) return null;
  if (input.code !== undefined) {
    const counter = matchTotpCounter(decrypt(row.secretEnc), input.code);
    if (counter !== null) {
      if (row.lastCounter !== null && counter <= row.lastCounter) return null; // already used
      run(db, `UPDATE users SET totp_last_counter = ? WHERE id = ?`, [counter, userId]);
      return 'totp';
    }
  }
  if (input.recoveryCode !== undefined) {
    const normalised = normaliseRecoveryCode(input.recoveryCode);
    if (normalised) {
      const used = run(db, `UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, [
        new Date().toISOString(), userId, hashRecoveryCode(normalised),
      ]).changes;
      if (used === 1) return 'recovery';
    }
  }
  return null;
}

// ── recovery codes ────────────────────────────────────────────────────────────

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `xxxx-xxxx`, lower-case alphanumerics drawn uniformly from `crypto.randomBytes` (rejection sampling, no modulo bias). */
export function generateRecoveryCode(): string {
  let out = '';
  while (out.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte >= 252) continue; // 252 = 7 × 36: the largest multiple of the alphabet size below 256
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      if (out.length === 8) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Lower-cases and re-hyphenates what the user typed (`XXXX XXXX`, `xxxxxxxx`, `xxxx-xxxx`); `null` if it cannot be a code. */
export function normaliseRecoveryCode(input: string): string | null {
  const clean = input.toLowerCase().replace(/[\s\-]/g, '');
  return /^[a-z0-9]{8}$/.test(clean) ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null;
}

export function hashRecoveryCode(normalised: string): string {
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/** Deletes and re-inserts the hashed codes; the caller owns the transaction (SQLite has no nested BEGIN). */
function writeRecoveryCodes(db: Db, userId: number): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  run(db, `DELETE FROM recovery_codes WHERE user_id = ?`, [userId]);
  for (const code of codes) run(db, `INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`, [userId, hashRecoveryCode(code)]);
  return codes;
}

/** Removes every recovery code of the user (two-step turned on over an insecure connection keeps none). */
export function deleteRecoveryCodes(db: Db, userId: number): void {
  run(db, `DELETE FROM recovery_codes WHERE user_id = ?`, [userId]);
}

/** Replaces the user's recovery codes with a fresh set and returns the plaintext codes (shown once). */
export function issueRecoveryCodes(db: Db, userId: number): string[] {
  return transaction(db, () => writeRecoveryCodes(db, userId));
}

// ── login challenges ──────────────────────────────────────────────────────────

export interface Challenge { token: string; userId: number; createdAt: string; expiresAt: string; attempts: number }

/** A single-purpose token for the second login step: bound to the user, valid for five minutes, deleted after use. */
export function createChallenge(db: Db, userId: number): string {
  purgeExpiredChallenges(db);
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  run(db, `INSERT INTO two_factor_challenges (token, user_id, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, 0)`, [
    token, userId, new Date(now).toISOString(), new Date(now + CHALLENGE_TTL_MS).toISOString(),
  ]);
  return token;
}

/**
 * The live challenge for `token`; `410` (and the row is deleted) when it is unknown, used, expired or has absorbed
 * `CHALLENGE_MAX_ATTEMPTS` wrong codes — the client goes back to step one for a fresh challenge.
 */
export function requireChallenge(db: Db, token: string): Challenge {
  const row = get<Challenge>(db, `SELECT token, user_id AS userId, created_at AS createdAt, expires_at AS expiresAt, attempts FROM two_factor_challenges WHERE token = ?`, [token]);
  if (row && row.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    deleteChallenge(db, token);
    throw gone('Too many wrong codes for this sign-in, start again');
  }
  if (row && row.expiresAt > new Date().toISOString()) return row;
  if (row) deleteChallenge(db, token);
  throw gone('This sign-in challenge has expired, start again');
}

export function recordChallengeAttempt(db: Db, token: string): void {
  run(db, `UPDATE two_factor_challenges SET attempts = attempts + 1 WHERE token = ?`, [token]);
}

export function deleteChallenge(db: Db, token: string): void {
  run(db, `DELETE FROM two_factor_challenges WHERE token = ?`, [token]);
}

export function purgeExpiredChallenges(db: Db): number {
  return run(db, `DELETE FROM two_factor_challenges WHERE expires_at < ?`, [new Date().toISOString()]).changes;
}

// ── failed-code limiters ──────────────────────────────────────────────────────
// 6 wrong codes per (source address, user) in 10 minutes → 429 for that source; 30 per user from anywhere as a backstop.

const codeBySource = new FailureLimiter(CODE_MAX_FAILURES, CODE_WINDOW_MS);
const codeByUser = new FailureLimiter(CODE_MAX_FAILURES_PER_USER, CODE_WINDOW_MS);

const sourceKey = (userId: number, source: string) => `${source}|${userId}`;

/** `429` when this source (or the user as a whole) has burned its attempts inside the window. */
export function assertCodeAttemptsLeft(userId: number, source: string, now = Date.now()): void {
  codeBySource.assertAllowed(sourceKey(userId, source), now);
  codeByUser.assertAllowed(String(userId), now);
}

export function recordCodeFailure(userId: number, source: string, now = Date.now()): void {
  codeBySource.record(sourceKey(userId, source), now);
  codeByUser.record(String(userId), now);
}

/** A correct code clears the counters for that source and the user-wide backstop. */
export function clearCodeFailures(userId: number, source: string): void {
  codeBySource.clear(sourceKey(userId, source));
  codeByUser.clear(String(userId));
}

/** Test hook: forget every recorded failure. */
export function resetCodeFailures(): void {
  codeBySource.reset();
  codeByUser.reset();
}
