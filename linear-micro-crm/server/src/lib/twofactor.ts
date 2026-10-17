/**
 * Two-step verification (TOTP) service: pending/active secrets encrypted at rest, single-use recovery codes
 * (SHA-256 hashed), five-minute login challenges and the per-user failed-code limiter. Routes stay thin; nothing in
 * here logs a code or a secret.
 */
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { TwoFactorSetup, TwoFactorStatus } from '@lm/shared';
import { get, run, transaction, type Db } from '../db/connection.ts';
import { decrypt, encrypt } from './crypto.ts';
import { conflict, gone, tooManyRequests } from './errors.ts';
import { generateSecret, otpauthUrl, verifyTotp } from './totp.ts';

export const TOTP_ISSUER = 'Linear Hub';
export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Failed codes per user before `429`, and the window they are counted in. */
export const CODE_MAX_FAILURES = 6;
export const CODE_WINDOW_MS = 10 * 60_000;

interface TotpRow {
  id: number;
  email: string;
  secretEnc: string | null;
  pendingEnc: string | null;
  enabledAt: string | null;
}

function totpRow(db: Db, userId: number): TotpRow | undefined {
  return get<TotpRow>(db, `SELECT id, email, totp_secret_enc AS secretEnc, totp_pending_enc AS pendingEnc, totp_enabled_at AS enabledAt FROM users WHERE id = ?`, [userId]);
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
 * Checks `code` against the pending secret and, when it matches, activates it, issues the recovery codes and signs
 * out every *other* session (`keepSessionToken`). Returns `null` on a wrong code so the route can answer 400 and
 * count the failure. `409` when nothing is pending or 2FA is already on.
 */
export function enableTwoFactor(db: Db, userId: number, code: string, keepSessionToken: string | undefined): string[] | null {
  const row = totpRow(db, userId);
  if (!row) throw conflict('Unknown user');
  if (row.enabledAt) throw conflict('Two-step verification is already on');
  if (!row.pendingEnc) throw conflict('No two-step setup is pending — start with setup');
  if (!verifyTotp(decrypt(row.pendingEnc), code)) return null;
  return transaction(db, () => {
    run(db, `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = ? WHERE id = ?`, [new Date().toISOString(), userId]);
    const codes = writeRecoveryCodes(db, userId);
    if (keepSessionToken) run(db, `DELETE FROM sessions WHERE user_id = ? AND token <> ?`, [userId, keepSessionToken]);
    else run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]);
    return codes;
  });
}

/** Removes the active and pending secrets and every recovery code (used by disable and the admin reset). */
export function clearTwoFactor(db: Db, userId: number): void {
  transaction(db, () => {
    run(db, `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL WHERE id = ?`, [userId]);
    run(db, `DELETE FROM recovery_codes WHERE user_id = ?`, [userId]);
    run(db, `DELETE FROM two_factor_challenges WHERE user_id = ?`, [userId]);
  });
}

// ── verification ──────────────────────────────────────────────────────────────

export type SecondFactor = 'totp' | 'recovery';

/**
 * Verifies a current authenticator code or an unused recovery code against the *active* secret. A matching
 * recovery code is marked used on the spot (every caller proceeds with its action on success). Returns which factor
 * matched, or `null`. Callers must check `isTwoFactorEnabled` first; without an active secret nothing matches.
 */
export function verifySecondFactor(db: Db, userId: number, input: { code?: string; recoveryCode?: string }): SecondFactor | null {
  const row = totpRow(db, userId);
  if (!row?.secretEnc || !row.enabledAt) return null;
  if (input.code !== undefined && verifyTotp(decrypt(row.secretEnc), input.code)) return 'totp';
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

/** The live challenge for `token`; `410` (and the row is deleted) when it is unknown, used or expired. */
export function requireChallenge(db: Db, token: string): Challenge {
  const row = get<Challenge>(db, `SELECT token, user_id AS userId, created_at AS createdAt, expires_at AS expiresAt, attempts FROM two_factor_challenges WHERE token = ?`, [token]);
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

// ── failed-code limiter: 6 wrong codes per user in 10 minutes ─────────────────

interface Failures { count: number; first: number }
const codeFailures = new Map<number, Failures>();

/** `429` when the user has burned their attempts inside the window (shared by every endpoint that checks a code). */
export function assertCodeAttemptsLeft(userId: number, now = Date.now()): void {
  const f = codeFailures.get(userId);
  if (!f) return;
  if (now - f.first >= CODE_WINDOW_MS) {
    codeFailures.delete(userId);
    return;
  }
  if (f.count >= CODE_MAX_FAILURES) {
    const minutes = Math.max(1, Math.ceil((f.first + CODE_WINDOW_MS - now) / 60_000));
    throw tooManyRequests(`Too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}`);
  }
}

export function recordCodeFailure(userId: number, now = Date.now()): void {
  if (codeFailures.size > 5000) for (const [k, f] of codeFailures) if (now - f.first >= CODE_WINDOW_MS) codeFailures.delete(k);
  const f = codeFailures.get(userId);
  if (!f || now - f.first >= CODE_WINDOW_MS) codeFailures.set(userId, { count: 1, first: now });
  else f.count += 1;
}

export function clearCodeFailures(userId: number): void {
  codeFailures.delete(userId);
}

/** Test hook: forget every recorded failure. */
export function resetCodeFailures(): void {
  codeFailures.clear();
}
