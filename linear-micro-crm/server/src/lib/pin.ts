/**
 * Release 1.2 — OWNED BY U1 sign-in-pin. The sign-in PIN and the admin's sign-in settings.
 *
 *  - PINs are peppered, then hashed: HMAC-SHA256 of the PIN under a key derived from the app secret (LM_APP_SECRET or
 *    the app-secret file, lib/crypto.ts `deriveAppKey`, never stored in the database), then scrypt from node:crypto
 *    (N 2^14, r 8, p 1, a 16-byte random salt per PIN, 32-byte key) on the libuv thread pool, so a sign-in never blocks
 *    the event loop; compared in constant time. A copy of the database or a backup alone is therefore not enough to
 *    try PINs offline. Stored as `scrypt-hmac$N$r$p$salt$key`; the 1.2.0 format `scrypt$…` (no pepper) is still
 *    verified and is replaced at the person's next successful sign-in. Nothing here logs a PIN.
 *  - Wrong PINs in a row are counted on the user row (`pin_failed_attempts`), across devices and restarts. Every
 *    PIN_LOCK_AFTER_FAILURES-th wrong PIN locks the PIN until `pin_locked_until` (real clock): 15 minutes, doubled for
 *    each further run of ten while the count is not reset, 24 hours at most. A right PIN, an admin reset or
 *    `npm run pin:reset` clears the count and the lock. Callers count an attempt BEFORE awaiting the hash and clear the
 *    count on success, so a burst of parallel guesses can never slip past the lock. Tries during a lock are refused
 *    without being counted.
 *  - The security settings live in `meta` under `ext:pin:*` keys (absent → defaults), read through a tiny cache that
 *    is dropped whenever the data version moves (every write request bumps it), so a change applies on the next request.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import {
  PIN_LOCK_AFTER_FAILURES, PIN_LOCK_MAX_MINUTES, PIN_LOCK_MINUTES, SESSION_IDLE_HOURS_DEFAULT, SESSION_MAX_HOURS_DEFAULT, isPinFormatValid,
  isSessionIdleHoursValid, isSessionMaxHoursValid, type PinStatus, type Role, type SecuritySettings,
} from '@lm/shared';
import { all, get, run, transaction, type Db } from '../db/connection.ts';
import { currentDataVersion } from './cache.ts';
import { isDemoClientAccount } from './client.ts';
import { deriveAppKey } from './crypto.ts';
import { BUSINESS_TZ, diffDays, toBusinessISO } from './dates.ts';

// ── hashing ──────────────────────────────────────────────────────────────────

const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 32, saltBytes: 16 } as const;
/** The current hash format (peppered) and the 1.2.0 one (the bare PIN), still accepted. */
const PEPPERED = 'scrypt-hmac';
const LEGACY = 'scrypt';
const CURRENT_PREFIX = `${PEPPERED}$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`;

function scryptAsync(secret: BinaryLike, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** HMAC-SHA256 of the PIN under the app secret's PIN key: what scrypt hashes in the current format. */
function peppered(pin: string): Buffer {
  return createHmac('sha256', deriveAppKey('pin-pepper')).update(pin, 'utf8').digest();
}

/** `scrypt-hmac$N$r$p$<salt base64>$<key base64>`: the parameters travel with the hash so they can be raised later. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync(peppered(pin), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return [PEPPERED, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * True when `pin` matches the stored hash, in either format. A malformed PIN or an unreadable hash is simply a
 * mismatch, and so is a peppered hash checked under another app secret.
 */
export async function verifyPin(stored: string, pin: unknown): Promise<boolean> {
  if (!isPinFormatValid(pin)) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || (parts[0] !== PEPPERED && parts[0] !== LEGACY)) return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!salt.length || !expected.length) return false;
  const secret = parts[0] === PEPPERED ? peppered(pin) : pin;
  const key = await scryptAsync(secret, salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

/** True for a hash in an older format or with older parameters: it is re-hashed at the next right PIN. */
export const pinHashNeedsUpgrade = (stored: string): boolean => !stored.startsWith(CURRENT_PREFIX);

/** Swaps in a re-hash of the same PIN (keeps `pin_set_at`); does nothing if the PIN changed in the meantime. */
export function upgradePinHash(db: Db, userId: number, oldHash: string, newHash: string): void {
  run(db, `UPDATE users SET pin_hash = ? WHERE id = ? AND pin_hash = ?`, [newHash, userId, oldHash]);
}

// ── per-user PIN state ───────────────────────────────────────────────────────

export interface PinRow {
  hash: string | null;
  setAt: string | null;
  failures: number;
  /** When the latest lock ends (real clock, ISO), or null; a time in the past means that lock is over. */
  lockedUntil: string | null;
}

export function pinRow(db: Db, userId: number): PinRow | undefined {
  return get<PinRow>(
    db,
    `SELECT pin_hash AS hash, pin_set_at AS setAt, pin_failed_attempts AS failures, pin_locked_until AS lockedUntil FROM users WHERE id = ?`,
    [userId],
  );
}

/** Release 1.3 (P6): true for a client account other than the seeded demo client (one small read). */
export function clientPinRequired(db: Db, userId: number): boolean {
  const user = get<{ id: number; role: Role; email: string; employeeId: string }>(
    db,
    `SELECT id, role, email, employee_id AS employeeId FROM users WHERE id = ?`,
    [userId],
  );
  if (!user || user.role !== 'client') return false;
  return pinRequiredForRole({ role: user.role, demoClient: isDemoClientAccount(db, user) });
}

/** Locked now: the person has a PIN and its lock ends in the future (real clock). */
export const isPinLocked = (row: PinRow | undefined, now = Date.now()): boolean =>
  Boolean(row?.hash && row.lockedUntil) && Date.parse(row!.lockedUntil!) > now;

/** Wrong PINs left before the next lock (each run is PIN_LOCK_AFTER_FAILURES long). */
export const pinAttemptsLeft = (row: PinRow | undefined): number =>
  PIN_LOCK_AFTER_FAILURES - ((row?.failures ?? 0) % PIN_LOCK_AFTER_FAILURES);

/**
 * Minutes a PIN locks for when the wrong-PIN count reaches `failures` (0 when that count does not start a lock):
 * 10 → 15, 20 → 30, 30 → 60 … capped at 24 hours.
 */
export function pinLockMinutes(failures: number): number {
  if (failures < PIN_LOCK_AFTER_FAILURES || failures % PIN_LOCK_AFTER_FAILURES !== 0) return 0;
  const runs = failures / PIN_LOCK_AFTER_FAILURES;
  return Math.min(PIN_LOCK_MAX_MINUTES, PIN_LOCK_MINUTES * 2 ** Math.min(runs - 1, 16));
}

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, day: 'numeric', month: 'short' });

/**
 * "14:35", "14:35 tomorrow" or "00:00 on 22 Oct": the London wall-clock minute a lock ends, rounded up, so trying
 * at the time shown always works. Real clock (a security timer), whatever the business clock says.
 */
export function pinUnlockTime(lockedUntil: string, now = Date.now()): string {
  const end = new Date(Math.ceil(Date.parse(lockedUntil) / 60_000) * 60_000);
  const at = toBusinessISO(end);
  const time = at.slice(11, 16);
  const days = diffDays(toBusinessISO(new Date(now)).slice(0, 10), at.slice(0, 10));
  if (days <= 0) return time;
  return days === 1 ? `${time} tomorrow` : `${time} on ${DAY_MONTH.format(end)}`;
}

/** The sentence a 423 carries, at sign-in and in Settings. */
export const pinLockedMessage = (lockedUntil: string, now = Date.now()): string =>
  `Too many wrong PINs. Try again after ${pinUnlockTime(lockedUntil, now)}, or ask an administrator to reset your PIN.`;

/** PinStatus for one person (null when the user does not exist). Never the PIN or its hash. */
export function pinStatusFor(db: Db, userId: number, now = Date.now()): PinStatus | null {
  const row = pinRow(db, userId);
  if (!row) return null;
  const locked = isPinLocked(row, now);
  // Release 1.3 (P6): `required` is also true for a client account (never for the demo client), so Settings and the
  // portal's Security page offer Change PIN but not Remove.
  const required = readSecuritySettings(db).requirePin || clientPinRequired(db, userId);
  const status: PinStatus = { hasPin: Boolean(row.hash), setAt: row.hash ? row.setAt : null, required, locked };
  if (locked) status.lockedUntil = row.lockedUntil!;
  return status;
}

export interface PinAttempt {
  /** Wrong PINs in a row, counting this one. */
  failures: number;
  /** When this attempt started a lock (it holds if the PIN turns out wrong): when that lock ends; else null. */
  lockedUntil: string | null;
  /** Wrong PINs left before the next lock, if this one is wrong. */
  attemptsLeft: number;
}

/**
 * Counts one PIN attempt as failed (before the hash is checked); every PIN_LOCK_AFTER_FAILURES-th one also starts a
 * lock (pinLockMinutes). Synchronous, so parallel requests are counted one at a time.
 */
export function countPinAttempt(db: Db, userId: number, now = Date.now()): PinAttempt {
  run(db, `UPDATE users SET pin_failed_attempts = pin_failed_attempts + 1 WHERE id = ?`, [userId]);
  const failures = pinRow(db, userId)?.failures ?? 0;
  const minutes = pinLockMinutes(failures);
  const lockedUntil = minutes ? new Date(now + minutes * 60_000).toISOString() : null;
  if (lockedUntil) run(db, `UPDATE users SET pin_locked_until = ? WHERE id = ?`, [lockedUntil, userId]);
  return { failures, lockedUntil, attemptsLeft: PIN_LOCK_AFTER_FAILURES - (failures % PIN_LOCK_AFTER_FAILURES) };
}

/** A right PIN wipes the count and any lock. */
export function clearPinFailures(db: Db, userId: number): void {
  run(
    db,
    `UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ? AND (pin_failed_attempts <> 0 OR pin_locked_until IS NOT NULL)`,
    [userId],
  );
}

export function savePinHash(db: Db, userId: number, hash: string): void {
  run(db, `UPDATE users SET pin_hash = ?, pin_set_at = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?`, [
    hash, new Date().toISOString(), userId,
  ]);
}

/** Removes the PIN, its count and its lock (your own removal). */
export function clearPin(db: Db, userId: number): void {
  run(db, `UPDATE users SET pin_hash = NULL, pin_set_at = NULL, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?`, [userId]);
}

/**
 * The admin reset and `npm run pin:reset`: clears the PIN, its count and its lock, and signs the person out on every
 * device, in one transaction. Returns how many sessions ended.
 */
export function resetPinAndSignOut(db: Db, userId: number): number {
  return transaction(db, () => {
    clearPin(db, userId);
    return run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]).changes;
  });
}

// ── security settings ───────────────────────────────────────────────────────

export const SECURITY_SETTING_KEYS = {
  requirePin: 'ext:pin:require-pin',
  /** Release 1.4: still read (no data loss) but no longer decides anything: two-step is required for everyone. */
  requireAdminTwoFactor: 'ext:pin:require-admin-2fa',
  sessionIdleHours: 'ext:pin:session-idle-hours',
  /** Release 1.4 (package S): hours from sign-in to the automatic sign-out. */
  sessionMaxHours: 'ext:pin:session-max-hours',
} as const;

/** The sign-in settings as the server always answers them: every field present (sessionMaxHours included). */
export type ResolvedSecuritySettings = SecuritySettings & { sessionMaxHours: number };

export const DEFAULT_SECURITY_SETTINGS: ResolvedSecuritySettings = {
  requirePin: false, requireAdminTwoFactor: false, sessionIdleHours: SESSION_IDLE_HOURS_DEFAULT, sessionMaxHours: SESSION_MAX_HOURS_DEFAULT,
};

const settingsCache = new WeakMap<Db, { version: number; settings: ResolvedSecuritySettings }>();

/** The sign-in settings (defaults for absent or unreadable keys). Cheap: one cached read per data version. */
export function readSecuritySettings(db: Db): ResolvedSecuritySettings {
  const version = currentDataVersion();
  const hit = settingsCache.get(db);
  if (hit && hit.version === version) return hit.settings;
  const keys = Object.values(SECURITY_SETTING_KEYS);
  const rows = all<{ key: string; value: string }>(db, `SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys);
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const hours = Number(value(SECURITY_SETTING_KEYS.sessionIdleHours));
  const maxHours = Number(value(SECURITY_SETTING_KEYS.sessionMaxHours));
  const settings: ResolvedSecuritySettings = {
    requirePin: value(SECURITY_SETTING_KEYS.requirePin) === '1',
    requireAdminTwoFactor: value(SECURITY_SETTING_KEYS.requireAdminTwoFactor) === '1',
    sessionIdleHours: isSessionIdleHoursValid(hours) ? hours : SESSION_IDLE_HOURS_DEFAULT,
    sessionMaxHours: isSessionMaxHoursValid(maxHours) ? maxHours : SESSION_MAX_HOURS_DEFAULT,
  };
  settingsCache.set(db, { version, settings });
  return settings;
}

/** Writes the given settings (already validated) and returns the full set. */
export function writeSecuritySettings(db: Db, patch: Partial<SecuritySettings>): ResolvedSecuritySettings {
  const put = (key: string, value: string) =>
    run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  if (patch.requirePin !== undefined) put(SECURITY_SETTING_KEYS.requirePin, patch.requirePin ? '1' : '0');
  if (patch.requireAdminTwoFactor !== undefined) put(SECURITY_SETTING_KEYS.requireAdminTwoFactor, patch.requireAdminTwoFactor ? '1' : '0');
  if (patch.sessionIdleHours !== undefined) put(SECURITY_SETTING_KEYS.sessionIdleHours, String(patch.sessionIdleHours));
  if (patch.sessionMaxHours !== undefined) put(SECURITY_SETTING_KEYS.sessionMaxHours, String(patch.sessionMaxHours));
  settingsCache.delete(db);
  return readSecuritySettings(db);
}

/** The caller's own sign-in flags, as /auth/me and the login responses carry them. */
export interface AccountFlags {
  hasPin: boolean;
  pinSetupRequired: boolean;
  twoFactorSetupRequired: boolean;
}

/**
 * Who the flags are for. Release 1.3 (r3-foundation): `demoClient` is true only for the seeded demo client account
 * (lib/client.ts isDemoClientAccount; false for staff and for every invited client). Both callers — middleware/auth.ts
 * `authenticate` and routes/auth.ts `withFlags` — pass it, so P6's rule "a PIN is required for client accounts, except
 * the demo one" is a change to the body below only:
 *   pinSetupRequired: !who.hasPin && (settings.requirePin || (who.role === 'client' && !who.demoClient))
 */
export interface AccountFlagsSubject {
  role: Role;
  hasPin: boolean;
  twoFactorEnabled: boolean;
  demoClient: boolean;
  /**
   * Release 1.4 (package S): one of the demo sign-in accounts while Linear Hub is still the demo
   * (lib/demoTeams.ts isDemoSignInAccount): exempt from two-step verification and the 14-hour sign-out.
   */
  demoSignIn: boolean;
}

export function accountFlags(settings: SecuritySettings, who: AccountFlagsSubject): AccountFlags {
  return {
    hasPin: who.hasPin,
    // Release 1.3 (P6 client-portal): a client account always needs a PIN (its first sign-in creates it), except the
    // seeded demo client, so the demo sign-in button works; the admin's "Require a PIN for everyone" covers it too.
    pinSetupRequired: !who.hasPin && (settings.requirePin || (who.role === 'client' && !who.demoClient)),
    // Release 1.4 (package S, owner's decision): two-step verification for every account that signs in — admin,
    // leader, recruiter, rep and client — except the demo sign-in accounts while still the demo. The old
    // "Require two-step verification for administrators" switch (settings.requireAdminTwoFactor) no longer matters.
    twoFactorSetupRequired: !who.twoFactorEnabled && !who.demoSignIn,
  };
}

/**
 * Release 1.3 (P6 client-portal): a PIN is required for this account whatever the admin's settings — client accounts,
 * except the seeded demo client (lib/client.ts isDemoClientAccount). The same rule as accountFlags, for pinStatusFor.
 */
export function pinRequiredForRole(who: Pick<AccountFlagsSubject, 'role' | 'demoClient'>): boolean {
  return who.role === 'client' && !who.demoClient;
}
