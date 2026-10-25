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
/**
 * Release 1.4 (package S): a session ends this many hours after sign-in, whatever the activity (the owner: "every 14
 * hours everyone gets signed out and they have to do log in and 2fa"). Default 14; the admin may choose 4–24 whole
 * hours in Settings → Sign-in rules. Real clock, like the idle timeout. The demo sign-in accounts are exempt while
 * Linear Hub is still the demo (they keep the 14-day session).
 */
export const SESSION_MAX_HOURS_DEFAULT = 14;
export const SESSION_MAX_HOURS_MIN = 4;
export const SESSION_MAX_HOURS_MAX = 24;

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

/** Admin settings for sign-in (defaults: false, false, 12, 14). */
export interface SecuritySettings {
  requirePin: boolean;
  /**
   * Release 1.4: no longer decides anything — two-step verification is required for every account (the demo sign-in
   * accounts aside). Still read and returned, so nothing stored is lost; PUT still accepts it.
   */
  requireAdminTwoFactor: boolean;
  sessionIdleHours: number;
  /** Release 1.4: hours from sign-in to the automatic sign-out (SESSION_MAX_HOURS_*). Always sent by a 1.4 server. */
  sessionMaxHours?: number;
}

/** Release 1.4: why a session ended without anyone signing out — 'max_age': the hours-from-sign-in limit. */
export type SessionEndReason = 'max_age';

/**
 * Release 1.4: the `details` of the 401 the request that finds a session past its limit gets (the `error` is
 * sessionMaxAgeMessage). The session is gone and the cookie cleared, so later requests get a plain 401.
 */
export interface SessionEndedDetails {
  sessionEnded: SessionEndReason;
  maxHours: number;
}

/**
 * Release 1.4: when the signed-in session ends (GET /auth/me and the sign-in responses carry it as `session`), so the
 * sign-in page can say why even after the browser dropped the cookie. `maxHours` is null for the demo sign-in
 * accounts, whose sessions last 14 days.
 */
export interface SessionInfo {
  signedInAt: string;
  endsAt: string;
  maxHours: number | null;
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

/**
 * The 403 body of the gate while the caller still has to set up two-step verification. Release 1.4: every account
 * except the demo sign-in accounts (while still the demo), client accounts included.
 */
export interface TwoFactorSetupRequiredError {
  error: string;
  twoFactorSetupRequired: true;
}
