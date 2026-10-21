/**
 * Release 1.2 — U1 sign-in-pin contracts (laid down by r2-foundation; OWNED BY U1, which may add fields and types).
 * The core types carry the matching optional fields: `LoginInput.pin`, `UserWithTeam.hasPin`,
 * `UserWithTeam.pinSetupRequired` and `UserWithTeam.twoFactorSetupRequired` (shared/src/types.ts).
 *
 * Endpoints (all in server/src/routes/auth.ts, owned by U1):
 *  - POST   /auth/login             { email, employeeId, pin? } — a user with a PIN must send it (LoginPinChallenge,
 *                                    LoginPinRequired)
 *  - GET    /auth/pin               → PinStatus (self)
 *  - POST   /auth/pin               PinSetInput → 204 (set, or change with currentPin; other sessions are signed out)
 *  - POST   /auth/pin/remove        PinRemoveInput → 204 (remove your own PIN; 409 while a PIN is required)
 *  - GET    /auth/pin/:userId       → PinStatus (admin; anyone's PIN state, never the PIN)
 *  - POST   /auth/pin/reset/:userId → 204 (admin; clears another person's PIN and lock, and signs them out; for
 *                                    your own, `npm run pin:reset -- <email>` on the server)
 *  - GET    /auth/security-settings → SecuritySettings (admin)
 *  - PUT    /auth/security-settings Partial<SecuritySettings> → SecuritySettings (admin)
 * The PIN gate (middleware/auth.ts `pinSetupGate`, mounted in app.ts): while `pinSetupRequired` (or, for an admin,
 * `twoFactorSetupRequired`), every API except PIN / two-step setup, /auth/me, /auth/logout and /health answers 403
 * with `PinSetupRequiredError` (or `TwoFactorSetupRequiredError`).
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
/**
 * Wrong PINs in a row (across every device) before the PIN locks. The lock ends by itself: PIN_LOCK_MINUTES the first
 * time, doubling for each further run of PIN_LOCK_AFTER_FAILURES wrong while the count is not reset, up to
 * PIN_LOCK_MAX_MINUTES. A right PIN, an admin's reset or `npm run pin:reset` clears the count and the lock.
 */
export const PIN_LOCK_AFTER_FAILURES = 10;
export const PIN_LOCK_MINUTES = 15;
export const PIN_LOCK_MAX_MINUTES = 24 * 60;
/** Session idle timeout bounds (hours): default 12, admin may choose 1–72. */
export const SESSION_IDLE_HOURS_DEFAULT = 12;
export const SESSION_IDLE_HOURS_MIN = 1;
export const SESSION_IDLE_HOURS_MAX = 72;

/** GET /auth/pin — the caller's own PIN state (never the PIN or its hash). Also GET /auth/pin/:userId (admin). */
export interface PinStatus {
  hasPin: boolean;
  setAt: string | null;
  /** The admin switched on "Require a PIN for everyone". */
  required: boolean;
  /** Too many wrong PINs in a row: sign-in with the PIN is refused until the lock ends or an admin resets it. */
  locked?: boolean;
  /** While locked: when the lock ends (real clock, ISO). Absent when not locked. */
  lockedUntil?: string;
}

/** POST /auth/pin — 4–6 digits; `currentPin` is required to change an existing PIN. */
export interface PinSetInput {
  pin: string;
  currentPin?: string;
}

/** POST /auth/pin/remove — removing your own PIN asks for it first. */
export interface PinRemoveInput {
  currentPin: string;
}

/** Admin settings for sign-in (defaults: false, false, 12). */
export interface SecuritySettings {
  requirePin: boolean;
  requireAdminTwoFactor: boolean;
  sessionIdleHours: number;
}

/**
 * POST /auth/login answers 200 with this (and no session cookie) when the email and employee ID are right, the account
 * has a PIN and none was sent: step two of the sign-in, like `TwoFactorChallenge`. The page then asks for the PIN and
 * sends the same body again with `pin`. Counts against the login rate limit. `attemptsLeft`: wrong PINs left before
 * the PIN locks.
 */
export interface LoginPinChallenge {
  requiresPin: true;
  attemptsLeft: number;
}

/** Why a sign-in with a PIN failed: a wrong PIN, or the PIN is locked. */
export type LoginPinReason = 'wrong' | 'locked';

/**
 * Carried in `details` too, because the client's ApiError keeps `error` and `details` only.
 * `attemptsLeft`: wrong PINs left before the lock (on 'wrong'). `lockedUntil`: when the lock ends (on 'locked').
 */
export interface LoginPinDetails {
  requiresPin: true;
  reason: LoginPinReason;
  attemptsLeft?: number;
  lockedUntil?: string;
}

/**
 * POST /auth/login answers 401 with this body when the account has a PIN and a wrong one was sent, and 423 with
 * `reason: 'locked'` while the PIN is locked (whatever was sent); the 423's `error` says when it unlocks ("Too many
 * wrong PINs. Try again after 14:35, or ask an administrator to reset your PIN."). Both count against the login rate
 * limit.
 */
export interface LoginPinRequired {
  error: string;
  requiresPin: true;
  details?: LoginPinDetails;
}

/** The 403 body of the PIN gate while the caller still has to create a PIN. */
export interface PinSetupRequiredError {
  error: string;
  pinSetupRequired: true;
}

/** The 403 body of the gate while an administrator still has to set up two-step verification (when required). */
export interface TwoFactorSetupRequiredError {
  error: string;
  twoFactorSetupRequired: true;
}
