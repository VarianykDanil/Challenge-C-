/**
 * Release 1.2 — U1 sign-in-pin contracts (laid down by r2-foundation; OWNED BY U1, which may add fields and types).
 * The core types carry the matching optional fields: `LoginInput.pin`, `UserWithTeam.hasPin`,
 * `UserWithTeam.pinSetupRequired` and `UserWithTeam.twoFactorSetupRequired` (shared/src/types.ts).
 *
 * Endpoints (all in server/src/routes/auth.ts, owned by U1):
 *  - POST /auth/login            { email, employeeId, pin? } — a user with a PIN must send it (see LoginPinRequired)
 *  - GET  /auth/pin              → PinStatus (self)
 *  - POST /auth/pin              PinSetInput → 204 (set, or change with currentPin)
 *  - POST /auth/pin/reset/:userId → 204 (admin; clears another person's PIN and signs them out)
 *  - GET  /auth/security-settings → SecuritySettings (admin)
 *  - PUT  /auth/security-settings  Partial<SecuritySettings> → SecuritySettings (admin)
 * The PIN gate (middleware/auth.ts `pinSetupGate`, mounted in app.ts): while `pinSetupRequired`, every API except
 * PIN setup, /auth/me and /auth/logout (and /health) answers 403 with `PinSetupRequiredError`.
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
/** Session idle timeout bounds (hours): default 12, admin may choose 1–72. */
export const SESSION_IDLE_HOURS_DEFAULT = 12;
export const SESSION_IDLE_HOURS_MIN = 1;
export const SESSION_IDLE_HOURS_MAX = 72;

/** GET /auth/pin — the caller's own PIN state (never the PIN or its hash). */
export interface PinStatus {
  hasPin: boolean;
  setAt: string | null;
  /** The admin switched on "Require a PIN for everyone". */
  required: boolean;
}

/** POST /auth/pin — 4–6 digits; `currentPin` is required to change an existing PIN. */
export interface PinSetInput {
  pin: string;
  currentPin?: string;
}

/** Admin settings for sign-in (defaults: false, false, 12). */
export interface SecuritySettings {
  requirePin: boolean;
  requireAdminTwoFactor: boolean;
  sessionIdleHours: number;
}

/**
 * POST /auth/login answers 401 with this body when the email and employee ID are right but the account has a PIN and
 * none (or a wrong one) was sent; the sign-in page then shows the PIN field. Counts against the login rate limit.
 */
export interface LoginPinRequired {
  error: string;
  requiresPin: true;
}

/** The 403 body of the PIN gate while the caller still has to create a PIN. */
export interface PinSetupRequiredError {
  error: string;
  pinSetupRequired: true;
}
