/**
 * Release 1.3 (r3-foundation, STABLE): the client guard — deny by default. Mounted in app.ts on the /api router right
 * after `authenticate`, before everything else. A `client` session (a campaign's client in the client portal) may call
 * ONLY these API paths (relative to /api, compared lower-cased without trailing slashes, the way Express routes them):
 *
 *   /health and /health/*
 *   /auth/me, /auth/logout, /auth/login, /auth/login/2fa, /auth/demo-accounts
 *   /auth/pin and /auth/pin/*          (their own PIN: status, set, change, remove — admin-only PIN routes still
 *                                       answer 403 from their own role check)
 *   /auth/2fa and /auth/2fa/*          (release 1.4, package S: their own two-step verification — status, setup,
 *                                       turning it on, new recovery codes — which client accounts must use too)
 *   /client and /client/*              (P6's portal router; NOT /client-posts or /client-accounts, the office's)
 *
 * Everything else answers 403 ClientPortalOnlyError `{ error, clientPortalOnly: true }`, whatever the method, before any
 * router, cache or audit middleware runs. Staff sessions and anonymous requests pass straight through (requireAuth and
 * each route's role checks apply as before). r3-contracts.test.ts checks a sample of existing routes; P6's
 * client-guard test enumerates every route in the app (lib/routeTable.ts).
 */
import type { RequestHandler } from 'express';
import type { ClientPortalOnlyError } from '@lm/shared';
import { CLIENT_ROLE } from '../lib/client.ts';

export const CLIENT_PORTAL_ONLY_MESSAGE = 'This account can only use the client portal';

const OPEN_PATHS = new Set(['/health', '/auth/me', '/auth/logout', '/auth/login', '/auth/login/2fa', '/auth/demo-accounts', '/auth/pin', '/auth/2fa', '/client']);
const OPEN_PREFIXES = ['/health/', '/auth/pin/', '/auth/2fa/', '/client/'];

/** True when a client session may call `path` (relative to /api). */
export function clientMayCall(path: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, '') || '/';
  return OPEN_PATHS.has(p) || OPEN_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function clientGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.user?.role !== CLIENT_ROLE || clientMayCall(req.path)) return next();
    const body: ClientPortalOnlyError = { error: CLIENT_PORTAL_ONLY_MESSAGE, clientPortalOnly: true };
    res.status(403).json(body);
  };
}
