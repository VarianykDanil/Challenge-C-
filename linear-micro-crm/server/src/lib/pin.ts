/**
 * Release 1.2 — OWNED BY U1 sign-in-pin. The sign-in PIN and the admin's sign-in settings.
 *
 *  - PINs are hashed with scrypt from node:crypto (N 2^14, r 8, p 1, a 16-byte random salt per PIN, 32-byte key) on the
 *    libuv thread pool, so a sign-in never blocks the event loop; compared in constant time. Nothing here logs a PIN.
 *  - Wrong PINs in a row are counted on the user row (`pin_failed_attempts`), across devices and restarts; at
 *    PIN_LOCK_AFTER_FAILURES the PIN is locked until an admin resets it. Callers count an attempt BEFORE awaiting the
 *    hash and clear the count on success, so a burst of parallel guesses can never slip past the lock.
 *  - The security settings live in `meta` under `ext:pin:*` keys (absent → defaults), read through a tiny cache that
 *    is dropped whenever the data version moves (every write request bumps it), so a change applies on the next request.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import {
  PIN_LOCK_AFTER_FAILURES, SESSION_IDLE_HOURS_DEFAULT, isPinFormatValid, isSessionIdleHoursValid,
  type PinStatus, type Role, type SecuritySettings,
} from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { currentDataVersion } from './cache.ts';

// ── hashing ──────────────────────────────────────────────────────────────────

const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 32, saltBytes: 16 } as const;

function scryptAsync(secret: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt base64>$<key base64>`: the parameters travel with the hash so they can be raised later. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync(pin, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** True when `pin` matches the stored hash. A malformed PIN or an unreadable hash is simply a mismatch. */
export async function verifyPin(stored: string, pin: unknown): Promise<boolean> {
  if (!isPinFormatValid(pin)) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!salt.length || !expected.length) return false;
  const key = await scryptAsync(pin, salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

// ── per-user PIN state ───────────────────────────────────────────────────────

export interface PinRow {
  hash: string | null;
  setAt: string | null;
  failures: number;
}

export function pinRow(db: Db, userId: number): PinRow | undefined {
  return get<PinRow>(db, `SELECT pin_hash AS hash, pin_set_at AS setAt, pin_failed_attempts AS failures FROM users WHERE id = ?`, [userId]);
}

export const isPinLocked = (row: PinRow | undefined): boolean => Boolean(row?.hash) && (row?.failures ?? 0) >= PIN_LOCK_AFTER_FAILURES;

/** Wrong PINs left before the lock. */
export const pinAttemptsLeft = (row: PinRow | undefined): number => Math.max(0, PIN_LOCK_AFTER_FAILURES - (row?.failures ?? 0));

/** PinStatus for one person (null when the user does not exist). Never the PIN or its hash. */
export function pinStatusFor(db: Db, userId: number): PinStatus | null {
  const row = pinRow(db, userId);
  if (!row) return null;
  return { hasPin: Boolean(row.hash), setAt: row.hash ? row.setAt : null, required: readSecuritySettings(db).requirePin, locked: isPinLocked(row) };
}

/** Counts one PIN attempt as failed (before the hash is checked) and returns the new count. */
export function countPinAttempt(db: Db, userId: number): number {
  run(db, `UPDATE users SET pin_failed_attempts = pin_failed_attempts + 1 WHERE id = ?`, [userId]);
  return pinRow(db, userId)?.failures ?? 0;
}

/** A right PIN wipes the count. */
export function clearPinFailures(db: Db, userId: number): void {
  run(db, `UPDATE users SET pin_failed_attempts = 0 WHERE id = ? AND pin_failed_attempts <> 0`, [userId]);
}

export function savePinHash(db: Db, userId: number, hash: string): void {
  run(db, `UPDATE users SET pin_hash = ?, pin_set_at = ?, pin_failed_attempts = 0 WHERE id = ?`, [hash, new Date().toISOString(), userId]);
}

/** Removes the PIN and its lock (your own removal, and the admin reset). */
export function clearPin(db: Db, userId: number): void {
  run(db, `UPDATE users SET pin_hash = NULL, pin_set_at = NULL, pin_failed_attempts = 0 WHERE id = ?`, [userId]);
}

// ── security settings ───────────────────────────────────────────────────────

export const SECURITY_SETTING_KEYS = {
  requirePin: 'ext:pin:require-pin',
  requireAdminTwoFactor: 'ext:pin:require-admin-2fa',
  sessionIdleHours: 'ext:pin:session-idle-hours',
} as const;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { requirePin: false, requireAdminTwoFactor: false, sessionIdleHours: SESSION_IDLE_HOURS_DEFAULT };

const settingsCache = new WeakMap<Db, { version: number; settings: SecuritySettings }>();

/** The sign-in settings (defaults for absent or unreadable keys). Cheap: one cached read per data version. */
export function readSecuritySettings(db: Db): SecuritySettings {
  const version = currentDataVersion();
  const hit = settingsCache.get(db);
  if (hit && hit.version === version) return hit.settings;
  const rows = all<{ key: string; value: string }>(db, `SELECT key, value FROM meta WHERE key IN (?, ?, ?)`, Object.values(SECURITY_SETTING_KEYS));
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const hours = Number(value(SECURITY_SETTING_KEYS.sessionIdleHours));
  const settings: SecuritySettings = {
    requirePin: value(SECURITY_SETTING_KEYS.requirePin) === '1',
    requireAdminTwoFactor: value(SECURITY_SETTING_KEYS.requireAdminTwoFactor) === '1',
    sessionIdleHours: isSessionIdleHoursValid(hours) ? hours : SESSION_IDLE_HOURS_DEFAULT,
  };
  settingsCache.set(db, { version, settings });
  return settings;
}

/** Writes the given settings (already validated) and returns the full set. */
export function writeSecuritySettings(db: Db, patch: Partial<SecuritySettings>): SecuritySettings {
  const put = (key: string, value: string) =>
    run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  if (patch.requirePin !== undefined) put(SECURITY_SETTING_KEYS.requirePin, patch.requirePin ? '1' : '0');
  if (patch.requireAdminTwoFactor !== undefined) put(SECURITY_SETTING_KEYS.requireAdminTwoFactor, patch.requireAdminTwoFactor ? '1' : '0');
  if (patch.sessionIdleHours !== undefined) put(SECURITY_SETTING_KEYS.sessionIdleHours, String(patch.sessionIdleHours));
  settingsCache.delete(db);
  return readSecuritySettings(db);
}

/** The caller's own sign-in flags, as /auth/me and the login responses carry them. */
export interface AccountFlags {
  hasPin: boolean;
  pinSetupRequired: boolean;
  twoFactorSetupRequired: boolean;
}

export function accountFlags(settings: SecuritySettings, who: { role: Role; hasPin: boolean; twoFactorEnabled: boolean }): AccountFlags {
  return {
    hasPin: who.hasPin,
    pinSetupRequired: settings.requirePin && !who.hasPin,
    twoFactorSetupRequired: settings.requireAdminTwoFactor && who.role === 'admin' && !who.twoFactorEnabled,
  };
}
