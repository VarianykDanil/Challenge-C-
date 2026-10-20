import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role, UserWithTeam } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { USER_SELECT } from '../db/queries.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';

export const SESSION_COOKIE = 'lm_session';
const SESSION_DAYS = 14;
const SESSION_MS = SESSION_DAYS * 86_400_000;

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, [
    token, userId, now.toISOString(), new Date(now.getTime() + SESSION_MS).toISOString(),
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

export function purgeExpiredSessions(db: Db): void {
  run(db, `DELETE FROM sessions WHERE expires_at < ?`, [new Date().toISOString()]);
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
 */
export function authenticate(db: Db): RequestHandler {
  return (req, _res, next) => {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (!token) return next();
    const row = get<UserWithTeam & { expiresAt: string; totpOn: number }>(
      db,
      `${USER_SELECT.replace('SELECT ', 'SELECT s.expires_at AS expiresAt, (u.totp_enabled_at IS NOT NULL) AS totpOn, ')} JOIN sessions s ON s.user_id = u.id WHERE s.token = ?`,
      [token],
    );
    if (!row) return next();
    if (row.expiresAt < new Date().toISOString() || row.status === 'left') {
      destroySession(db, token);
      return next(); // requireAuth answers 401
    }
    const { expiresAt: _ignored, totpOn, ...user } = row;
    // The caller's own flag rides on req.user so /auth/me and the dashboard's `user` carry it; other users' rows never do.
    req.user = { ...user, twoFactorEnabled: Boolean(totpOn) };
    req.sessionToken = token;
    next();
  };
}

/**
 * Release 1.2 — OWNED BY U1 sign-in-pin (laid down by r2-foundation as a pass-through). Mounted in app.ts on the /api
 * router right after `authenticate`. While the admin requires a PIN and the signed-in caller has none
 * (`req.user.pinSetupRequired`), every API except PIN setup, /auth/me, /auth/logout and /health answers 403 with
 * `{ error, pinSetupRequired: true }` (shared PinSetupRequiredError). Never blocks anonymous requests (requireAuth
 * answers those).
 */
export function pinSetupGate(db: Db): RequestHandler {
  void db;
  return (_req, _res, next) => next();
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
