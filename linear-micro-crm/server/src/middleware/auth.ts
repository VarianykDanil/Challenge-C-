import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isSessionIdle, type PinSetupRequiredError, type Role, type TwoFactorSetupRequiredError, type UserWithTeam } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { USER_SELECT } from '../db/queries.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { accountFlags, readSecuritySettings } from '../lib/pin.ts';

export const SESSION_COOKIE = 'lm_session';
const SESSION_DAYS = 14;
const SESSION_MS = SESSION_DAYS * 86_400_000;

/**
 * Release 1.2 (U1): `sessions.last_seen_at` is refreshed at most this often, so the idle timeout costs one small write a
 * minute per active session rather than one per request (the API serves 1000+ req/s). The timeout is therefore exact
 * to the minute.
 */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
    token, userId, now.toISOString(), new Date(now.getTime() + SESSION_MS).toISOString(), now.toISOString(),
  ]);
  return token;
}

export function destroySession(db: Db, token: string): void {
  run(db, `DELETE FROM sessions WHERE token = ?`, [token]);
}

/** Revoke every live session of one user (used when an admin deactivates them). */
export function destroyUserSessions(db: Db, userId: number): number {
  return run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]).changes;
}

/** Revoke every session of one user except `keepToken` (a PIN change keeps the device that made it signed in). */
export function destroyOtherSessions(db: Db, userId: number, keepToken: string | undefined): number {
  return keepToken
    ? run(db, `DELETE FROM sessions WHERE user_id = ? AND token <> ?`, [userId, keepToken]).changes
    : destroyUserSessions(db, userId);
}

/** Sessions past their 14-day expiry, and (1.2) sessions idle for longer than the admin's session idle timeout. */
export function purgeExpiredSessions(db: Db): void {
  const now = Date.now();
  const idleCutoff = new Date(now - readSecuritySettings(db).sessionIdleHours * 3_600_000).toISOString();
  run(db, `DELETE FROM sessions WHERE expires_at < ? OR COALESCE(last_seen_at, created_at) < ?`, [new Date(now).toISOString(), idleCutoff]);
}

/** `Secure` whenever the request arrived over HTTPS (behind the trusted proxy) or `COOKIE_SECURE=1` forces it. */
export function cookieSecure(req: Request): boolean {
  return req.secure || process.env.COOKIE_SECURE === '1';
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    path: '/',
    maxAge: SESSION_MS,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), path: '/' });
}

/**
 * Attaches `req.user` when a valid session cookie is present; never rejects. Expired sessions and sessions of users
 * whose status is `left` are deleted on sight, so a deactivated account loses access immediately, not at expiry.
 * Release 1.2 (U1): so is a session idle for longer than the admin's timeout (default 12 h, measured on the real clock
 * from its last request); `req.user` also carries the caller's own `hasPin`, `pinSetupRequired` and
 * `twoFactorSetupRequired`, which the PIN gate below and the client read.
 */
export function authenticate(db: Db): RequestHandler {
  return (req, _res, next) => {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (!token) return next();
    const row = get<UserWithTeam & { expiresAt: string; seenAt: string; totpOn: number; pinOn: number; clientCampaign: number | null }>(
      db,
      `${USER_SELECT.replace(
        'SELECT ',
        'SELECT s.expires_at AS expiresAt, COALESCE(s.last_seen_at, s.created_at) AS seenAt, (u.totp_enabled_at IS NOT NULL) AS totpOn, (u.pin_hash IS NOT NULL) AS pinOn, u.client_campaign_id AS clientCampaign, ',
      )} JOIN sessions s ON s.user_id = u.id WHERE s.token = ?`,
      [token],
    );
    if (!row) return next();
    const now = Date.now();
    const settings = readSecuritySettings(db);
    const seenMs = Date.parse(row.seenAt);
    if (row.expiresAt < new Date(now).toISOString() || row.status === 'left' || !Number.isFinite(seenMs) || isSessionIdle(seenMs, now, settings.sessionIdleHours)) {
      destroySession(db, token);
      return next(); // requireAuth answers 401
    }
    if (now - seenMs >= LAST_SEEN_RESOLUTION_MS) run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [new Date(now).toISOString(), token]);
    const { expiresAt: _expires, seenAt: _seen, totpOn, pinOn, clientCampaign, ...user } = row;
    const twoFactorEnabled = Boolean(totpOn);
    // The caller's own flags ride on req.user so /auth/me and the dashboard's `user` carry them; other users' rows never do.
    // Release 1.3 (r3-foundation): a client portal session also carries its campaign (staff sessions never do).
    req.user = {
      ...user,
      twoFactorEnabled,
      ...accountFlags(settings, { role: user.role, hasPin: Boolean(pinOn), twoFactorEnabled }),
      ...(user.role === 'client' ? { clientCampaignId: clientCampaign ?? null } : {}),
    };
    req.sessionToken = token;
    next();
  };
}

/** API paths a signed-in person may still use while the gate holds them at "Create your PIN" (relative to /api). */
const GATE_OPEN_PATHS = new Set(['/auth/me', '/auth/logout', '/auth/login', '/auth/login/2fa', '/auth/demo-accounts', '/auth/pin']);
/** … and, once the PIN is in place, while an administrator still has to set up two-step verification. */
const GATE_TWO_FACTOR_PATHS = new Set(['/auth/2fa', '/auth/2fa/setup', '/auth/2fa/enable']);

export const PIN_SETUP_REQUIRED_MESSAGE = 'Create your PIN to carry on';
export const TWO_FACTOR_SETUP_REQUIRED_MESSAGE = 'Set up two-step verification to carry on';

/**
 * Release 1.2 — OWNED BY U1 sign-in-pin. Mounted in app.ts on the /api router right after `authenticate`. While the
 * admin requires a PIN and the signed-in caller has none (`req.user.pinSetupRequired`), every API except PIN setup,
 * /auth/me, /auth/logout, the sign-in endpoints and /health answers 403 `{ error, pinSetupRequired: true }` (shared
 * PinSetupRequiredError). Once the PIN is set, an administrator who must use two-step verification and has not set it
 * up (`twoFactorSetupRequired`) may also reach the two-step setup endpoints, and everything else answers 403
 * `{ error, twoFactorSetupRequired: true }`. Never blocks anonymous requests (requireAuth answers those). Paths are
 * compared lower-cased without trailing slashes, the way Express routes them; anything not listed stays closed.
 */
export function pinSetupGate(_db: Db): RequestHandler {
  return (req, res, next) => {
    const user = req.user;
    if (!user || (!user.pinSetupRequired && !user.twoFactorSetupRequired)) return next();
    const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if (p === '/health' || p.startsWith('/health/') || GATE_OPEN_PATHS.has(p)) return next();
    if (user.pinSetupRequired) {
      const body: PinSetupRequiredError = { error: PIN_SETUP_REQUIRED_MESSAGE, pinSetupRequired: true };
      return void res.status(403).json(body);
    }
    if (GATE_TWO_FACTOR_PATHS.has(p)) return next();
    const body: TwoFactorSetupRequiredError = { error: TWO_FACTOR_SETUP_REQUIRED_MESSAGE, twoFactorSetupRequired: true };
    res.status(403).json(body);
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}

/** The signed-in user; throws 401 if the route forgot `requireAuth`. */
export function currentUser(req: Request): UserWithTeam {
  if (!req.user) throw unauthorized();
  return req.user;
}
