import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  SESSION_MAX_HOURS_MAX, isSessionIdle, isSessionPastMaxAge, sessionEndsAtMs, sessionMaxAgeMessage,
  type PinSetupRequiredError, type Role, type SessionEndedDetails, type SessionInfo, type TwoFactorSetupRequiredError, type UserWithTeam,
} from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { USER_SELECT } from '../db/queries.ts';
import { recordIdleSignOut, recordMaxAgeSignOut } from '../lib/audit/sessions.ts';
import { HttpError, forbidden, unauthorized } from '../lib/errors.ts';
import { clientSafeUser, isDemoClientAccount } from '../lib/client.ts';
import { isDemoSignInAccount, type DemoSignInSubject } from '../lib/demoTeams.ts';
import { accountFlags, readSecuritySettings } from '../lib/pin.ts';
import { sessionKey } from '../lib/sessionKey.ts';

export { sessionKey } from '../lib/sessionKey.ts';

export const SESSION_COOKIE = 'lm_session';
/** Sessions made before 1.4 lasted 14 days; a request finds such a session over the hours limit and ends it. */
const LEGACY_SESSION_MS = 14 * 86_400_000;

/**
 * Release 1.2 (U1): `sessions.last_seen_at` is refreshed at most this often, so the idle timeout costs one small write a
 * minute per active session rather than one per request (the API serves 1000+ req/s). The timeout is therefore exact
 * to the minute.
 */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

/** What a new session is: its token, the cookie's Max-Age, and when it ends (for the sign-in answers). */
export interface NewSession {
  token: string;
  maxAgeMs: number;
  info: SessionInfo;
}

/**
 * Owner's decision "every 14 hours everyone gets signed out": a session ends the admin's `sessionMaxHours` (default 14)
 * after sign-in, whatever the activity, and its cookie's Max-Age is the same — the one-tap demo accounts too (they
 * used to keep 14 days). The cookie carries the token; the table keeps only its hash (lib/sessionKey.ts).
 */
export function createSession(db: Db, user: DemoSignInSubject, opts: { viaSetupCode?: boolean } = {}): NewSession {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const settings = readSecuritySettings(db);
  const maxHours = settings.sessionMaxHours;
  const maxAgeMs = maxHours * 3_600_000;
  const signedInAt = now.toISOString();
  const endsAt = new Date(now.getTime() + maxAgeMs).toISOString();
  run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at, via_setup_code) VALUES (?, ?, ?, ?, ?, ?)`, [
    sessionKey(token), user.id, signedInAt, endsAt, signedInAt, opts.viaSetupCode ? 1 : 0,
  ]);
  // idleHours: a phone opened with no signal stops acting as this person when the inactivity sign-out would apply
  return { token, maxAgeMs, info: { signedInAt, endsAt, maxHours, idleHours: settings.sessionIdleHours } };
}

/** Ends the session whose cookie carries `token`. */
export function destroySession(db: Db, token: string): void {
  run(db, `DELETE FROM sessions WHERE token = ?`, [sessionKey(token)]);
}

/** Revoke every live session of one user (used when an admin deactivates them). */
export function destroyUserSessions(db: Db, userId: number): number {
  return run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]).changes;
}

/** Revoke every session of one user except `keepToken` (a PIN change keeps the device that made it signed in). */
export function destroyOtherSessions(db: Db, userId: number, keepToken: string | undefined): number {
  return keepToken
    ? run(db, `DELETE FROM sessions WHERE user_id = ? AND token <> ?`, [userId, sessionKey(keepToken)]).changes
    : destroyUserSessions(db, userId);
}

/**
 * Sessions past their expiry, and (1.2) sessions idle for longer than the admin's session idle timeout. Runs at start-up
 * and every 15 minutes (index.ts). Release 1.3 (P9): each idle one of a current account is recorded as that person's
 * sign-out (one grouped read first). Release 1.4 (package S): a session made by 1.4 for an account that must sign in
 * again after `sessionMaxHours` (a lifetime of at most SESSION_MAX_HOURS_MAX, so never a demo account's 14 days or a
 * 1.3 session) whose limit — and cookie — ran out while nobody used it is recorded as that person's automatic sign-out:
 * one row per person, however many devices. A session still within its expiry but past the limit (a 1.3 session, or
 * the admin shortened the limit) is left for its next request, which ends it with the sentence the sign-in page shows.
 */
export function purgeExpiredSessions(db: Db): void {
  const now = Date.now();
  const { sessionIdleHours: idleHours, sessionMaxHours } = readSecuritySettings(db);
  const nowIso = new Date(now).toISOString();
  const idleCutoff = new Date(now - idleHours * 3_600_000).toISOString();
  const idle = all<{ userId: number; seenAt: string }>(
    db,
    `SELECT s.user_id AS userId, COALESCE(s.last_seen_at, s.created_at) AS seenAt FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.expires_at >= ? AND COALESCE(s.last_seen_at, s.created_at) < ? AND u.status <> 'left'`,
    [nowIso, idleCutoff],
  );
  // MAX(created_at) picks each person's latest such session (SQLite takes the bare columns from that row).
  const maxAged = all<{ userId: number; signedInAt: string; hours: number }>(
    db,
    `SELECT s.user_id AS userId, MAX(s.created_at) AS signedInAt, ROUND((julianday(s.expires_at) - julianday(s.created_at)) * 24) AS hours
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.expires_at < ? AND s.expires_at > s.created_at AND (julianday(s.expires_at) - julianday(s.created_at)) * 24 <= ? AND u.status <> 'left'
     GROUP BY s.user_id`,
    [nowIso, SESSION_MAX_HOURS_MAX + 0.01],
  );
  run(db, `DELETE FROM sessions WHERE expires_at < ? OR COALESCE(last_seen_at, created_at) < ?`, [nowIso, idleCutoff]);
  for (const s of idle) recordIdleSignOut(db, { userId: s.userId, lastSeenAt: s.seenAt, idleHours, ip: null });
  for (const s of maxAged) {
    recordMaxAgeSignOut(db, { userId: s.userId, signedInAt: s.signedInAt, maxHours: Math.min(Number(s.hours) || sessionMaxHours, sessionMaxHours), ip: null });
  }
}

/** `Secure` whenever the request arrived over HTTPS (behind the trusted proxy) or `COOKIE_SECURE=1` forces it. */
export function cookieSecure(req: Request): boolean {
  return req.secure || process.env.COOKIE_SECURE === '1';
}

/** Release 1.4: `maxAgeMs` is the new session's lifetime (createSession), so the cookie ends with the session. */
export function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number = LEGACY_SESSION_MS): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    path: '/',
    maxAge: maxAgeMs,
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
 * Release 1.4 (package S): and a session older than the admin's `sessionMaxHours` (default 14) counted from sign-in,
 * whatever the activity (the one-tap demo accounts too). The cookie's token is looked up by its hash
 * (lib/sessionKey.ts). That request learns why: `req.sessionEnded` makes the 401
 * of requireAuth / requireRole carry the sentence and `details: { sessionEnded: 'max_age', maxHours }`; the cookie is
 * cleared and the sign-out recorded in the audit trail, like the idle one. `req.sessionInfo` says when a live session
 * ends (GET /auth/me answers it). A longer setting applies from the next sign-in: a session signed in under a shorter
 * one keeps its own expires_at and cookie, so its `maxHours` and its ending name its own hours.
 */
export function authenticate(db: Db): RequestHandler {
  return (req, res, next) => {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (!token) return next();
    const row = get<UserWithTeam & { createdAt: string; expiresAt: string; seenAt: string; totpOn: number; pinOn: number; clientCampaign: number | null; viaSetupCode: number }>(
      db,
      `${USER_SELECT.replace(
        'SELECT ',
        'SELECT s.created_at AS createdAt, s.expires_at AS expiresAt, COALESCE(s.last_seen_at, s.created_at) AS seenAt, (u.totp_enabled_at IS NOT NULL) AS totpOn, (u.pin_hash IS NOT NULL) AS pinOn, u.client_campaign_id AS clientCampaign, s.via_setup_code AS viaSetupCode, ',
      )} JOIN sessions s ON s.user_id = u.id WHERE s.token = ?`,
      [sessionKey(token)],
    );
    if (!row) return next();
    const now = Date.now();
    const settings = readSecuritySettings(db);
    const seenMs = Date.parse(row.seenAt);
    const signedInMs = Date.parse(row.createdAt);
    const left = row.status === 'left';
    const demoSignIn = !left && isDemoSignInAccount(db, row);
    const expired = row.expiresAt < new Date(now).toISOString();
    // The session's own lifetime, fixed at sign-in (expires_at and the cookie's Max-Age): 4–24 hours, or 14 days for a
    // session made before 1.4 or a demo session made before this release.
    const ownHours = Math.round((Date.parse(row.expiresAt) - signedInMs) / 3_600_000);
    const idle = Number.isFinite(seenMs) && isSessionIdle(seenMs, now, settings.sessionIdleHours);
    // The hours-from-sign-in limit, whatever the activity (last_seen_at never moves it), for every session the demo ones
    // included — the current setting, or the session's own 4–24 hours when it was signed in under a shorter limit than
    // today's (the admin raised it since) and has run out. A 14-day session older than the limit ends here, with the
    // sentence, at its next request.
    const ranOutOwnLimit = expired && ownHours > 0 && ownHours <= SESSION_MAX_HOURS_MAX;
    const maxAged = isSessionPastMaxAge(signedInMs, now, settings.sessionMaxHours) || ranOutOwnLimit;
    if (expired || left || !Number.isFinite(seenMs) || idle || maxAged) {
      destroySession(db, token);
      if (!left && maxAged) {
        // The 14 hours come first: a session both idle and past the limit is said to have ended for the limit.
        // The hours named are the ones that ended it: the shorter of its own and the current setting (as the sweep does).
        const hours = ranOutOwnLimit ? Math.min(ownHours, settings.sessionMaxHours) : settings.sessionMaxHours;
        recordMaxAgeSignOut(db, { userId: row.id, signedInAt: row.createdAt, maxHours: hours, ip: req.ip ?? null });
        req.sessionEnded = { sessionEnded: 'max_age', maxHours: hours };
        clearSessionCookie(req, res);
      } else if (idle && !expired && !left) {
        // Release 1.3 (P9, every sign-out is recorded): the idle timeout signed this person out
        recordIdleSignOut(db, { userId: row.id, lastSeenAt: row.seenAt, idleHours: settings.sessionIdleHours, ip: req.ip ?? null });
      }
      return next(); // requireAuth answers 401
    }
    // Release 1.5 check: an account without two-step that is not a one-tap demo account signs in only with its setup
    // code, so its session must have been made with one. Any other (a 1.4 session, or a one-tap session after the demo
    // sign-ins were switched off) could otherwise set up two-step without the code: it is signed out, and the person
    // signs in again with a setup code from an administrator.
    if (!row.totpOn && !demoSignIn && !row.viaSetupCode) {
      destroySession(db, token);
      clearSessionCookie(req, res);
      return next(); // requireAuth answers 401
    }
    if (now - seenMs >= LAST_SEEN_RESOLUTION_MS) run(db, `UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [new Date(now).toISOString(), sessionKey(token)]);
    const { createdAt, expiresAt, seenAt: _seen, totpOn, pinOn, clientCampaign, viaSetupCode: _via, ...user } = row;
    const twoFactorEnabled = Boolean(totpOn);
    // The caller's own flags ride on req.user so /auth/me and the dashboard's `user` carry them; other users' rows never do.
    // Release 1.3 (r3-foundation): a client portal session also carries its campaign (staff sessions never do), leaves
    // out the office's fields (lib/client.ts clientSafeUser), and tells accountFlags whether it is the seeded demo client
    // (lib/client.ts isDemoClientAccount: one meta read, client sessions only) for P6's client PIN rule.
    const client = user.role === 'client';
    req.user = clientSafeUser({
      ...user,
      twoFactorEnabled,
      ...accountFlags(settings, { role: user.role, hasPin: Boolean(pinOn), twoFactorEnabled, demoClient: client && isDemoClientAccount(db, user), demoSignIn }),
      ...(client ? { clientCampaignId: clientCampaign ?? null } : {}),
    });
    req.sessionToken = token;
    const limitEnd = new Date(sessionEndsAtMs(signedInMs, settings.sessionMaxHours)).toISOString();
    // A session signed in under a shorter limit (the admin raised it since) still ends at its own expires_at and
    // cookie: say its own hours, so the sign-in page's sentence names the hours that really applied.
    const ownEnd = expiresAt < limitEnd;
    req.sessionInfo = {
      signedInAt: createdAt,
      endsAt: ownEnd ? expiresAt : limitEnd,
      maxHours: ownEnd ? ownHours : settings.sessionMaxHours,
      idleHours: settings.sessionIdleHours,
    };
    next();
  };
}

/** API paths a signed-in person may still use while the gate holds them at "Create your PIN" (relative to /api). */
const GATE_OPEN_PATHS = new Set(['/auth/me', '/auth/logout', '/auth/login', '/auth/login/2fa', '/auth/demo-accounts', '/auth/pin']);
/** … and, once the PIN is in place, while they still have to set up two-step verification. */
const GATE_TWO_FACTOR_PATHS = new Set(['/auth/2fa', '/auth/2fa/setup', '/auth/2fa/enable']);

export const PIN_SETUP_REQUIRED_MESSAGE = 'Create your PIN to carry on';
export const TWO_FACTOR_SETUP_REQUIRED_MESSAGE = 'Set up two-step verification to carry on';

/**
 * Release 1.2 — OWNED BY U1 sign-in-pin. Mounted in app.ts on the /api router right after `authenticate`. While the
 * admin requires a PIN and the signed-in caller has none (`req.user.pinSetupRequired`), every API except PIN setup,
 * /auth/me, /auth/logout, the sign-in endpoints and /health answers 403 `{ error, pinSetupRequired: true }` (shared
 * PinSetupRequiredError). Once the PIN is set, a person who must use two-step verification and has not set it up
 * (`twoFactorSetupRequired`) may also reach the two-step setup endpoints, and everything else answers 403
 * `{ error, twoFactorSetupRequired: true }`. Release 1.4 (package S): that is every account except the demo sign-in
 * accounts — client accounts included, so the client portal (/client/*) is held too (the client guard runs first and
 * lets a client session reach /auth/2fa). Never blocks anonymous requests (requireAuth answers those). Paths are
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

/**
 * The 401 for a request without a signed-in user. Release 1.4: when this very request found the session past its
 * hours-from-sign-in limit, the sentence the sign-in page shows and `details: SessionEndedDetails`.
 */
function signedOutError(req: Request): HttpError {
  const ended: SessionEndedDetails | undefined = req.sessionEnded;
  return ended ? new HttpError(401, sessionMaxAgeMessage(ended.maxHours), ended) : unauthorized();
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(signedOutError(req));
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(signedOutError(req));
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}

/** The signed-in user; throws 401 if the route forgot `requireAuth`. */
export function currentUser(req: Request): UserWithTeam {
  if (!req.user) throw signedOutError(req);
  return req.user;
}
