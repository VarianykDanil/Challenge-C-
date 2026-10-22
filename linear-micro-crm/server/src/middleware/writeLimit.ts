/**
 * Release 1.2 review fix (security S6): a per-person limit on the 1.2 writes any signed-in person can repeat at will.
 *
 * At most WRITE_LIMIT_PER_MINUTE (60) of these writes per person in a one-minute window, all of them together:
 *   POST /learning/*        self-check, teach-back, sign-off
 *   PUT  /pitches/*         pitch edits
 *   POST /checkins          shift check-in
 *   POST /auth/pin, /auth/pin/*   setting, changing, removing or resetting a PIN
 *   POST /gauges/bulk       bulk gauge entry
 * The next one inside the minute is refused with 429 and a plain sentence (WRITE_LIMIT_MESSAGE, `Retry-After: 60`);
 * a refused request does not count. Reads, other writes and signed-out requests pass straight through (a signed-out
 * write still gets its 401 from requireAuth). Paths match case-insensitively, as Express routes them.
 *
 * The counter is the login limiter's FailureLimiter (lib/limiter.ts: bounded map, expired entries swept), keyed by
 * the person's id, in memory, on the real clock. createApp mounts one per app, after `authenticate` and the PIN gate,
 * before the audit recorder, so a refused write is never recorded. A phone replaying its check-in queue treats 429 as
 * "stop and try again later" (shared shiftCheckInReplayOutcome), so a queued check-in is never lost to the limit.
 *
 * Release 1.3 — P9 audit-everything adds a second counter, for POST /audit/events only (below).
 */
import type { RequestHandler } from 'express';
import { AUDIT_EVENTS_PER_MINUTE } from '@lm/shared';
import { tooManyRequests } from '../lib/errors.ts';
import { FailureLimiter } from '../lib/limiter.ts';

export const WRITE_LIMIT_PER_MINUTE = 60;
export const WRITE_LIMIT_WINDOW_MS = 60_000;
export const WRITE_LIMIT_MESSAGE = 'That is more than 60 changes in a minute. Wait a minute, then try again.';

/**
 * Release 1.3 (P9): POST /audit/events (a page reporting an export or an opened record) has a counter of its own —
 * AUDIT_EVENTS_PER_MINUTE (60) per person per minute — so a burst of reports never uses up anyone's budget for the
 * writes above, and those writes never stop an export being recorded. 429 with AUDIT_EVENTS_LIMIT_MESSAGE after that
 * (the page's reportAuditEvent ignores it). Turned off with the same `perMinute: 0`, or on its own with
 * `auditEventsPerMinute: 0`.
 */
export const AUDIT_EVENTS_PATH = '/audit/events';
export const AUDIT_EVENTS_LIMIT_MESSAGE = `That is more than ${AUDIT_EVENTS_PER_MINUTE} exports and opened records in a minute. Wait a minute, then try again.`;

/** Is this request a page's audit report (POST /audit/events, any case, with or without a trailing slash)? */
export function isAuditEventReport(method: string, path: string): boolean {
  return method === 'POST' && path.toLowerCase().replace(/\/+$/, '') === AUDIT_EVENTS_PATH;
}

/** The limited writes: the method and a path prefix relative to /api (the path itself, or anything below it). */
export const WRITE_LIMITED_ROUTES: readonly { method: 'POST' | 'PUT'; path: string }[] = [
  { method: 'POST', path: '/learning' },
  { method: 'PUT', path: '/pitches' },
  { method: 'POST', path: '/checkins' },
  { method: 'POST', path: '/auth/pin' },
  { method: 'POST', path: '/gauges/bulk' },
];

/** Does the per-person write limit cover this request? `path` is relative to /api, e.g. "/checkins". */
export function isWriteLimited(method: string, path: string): boolean {
  const p = path.toLowerCase();
  return WRITE_LIMITED_ROUTES.some((r) => r.method === method && (p === r.path || p.startsWith(`${r.path}/`)));
}

export interface WriteLimitOptions {
  /** Writes allowed per person per minute (default 60); 0 turns the limit off (the audit reports' limit too). */
  perMinute?: number;
  /** Release 1.3 (P9): POST /audit/events reports per person per minute (default AUDIT_EVENTS_PER_MINUTE); 0 = off. */
  auditEventsPerMinute?: number;
  /** Test hook: the clock (ms since epoch). */
  now?: () => number;
}

/** The per-person write limit as middleware, for the /api router (one counter per call). */
export function perUserWriteLimit(opts: WriteLimitOptions = {}): RequestHandler {
  const perMinute = opts.perMinute ?? WRITE_LIMIT_PER_MINUTE;
  const reportsPerMinute = perMinute <= 0 ? 0 : (opts.auditEventsPerMinute ?? AUDIT_EVENTS_PER_MINUTE);
  const now = opts.now ?? Date.now;
  if (perMinute <= 0) return (_req, _res, next) => next();
  const counter = new FailureLimiter(perMinute, WRITE_LIMIT_WINDOW_MS);
  const reports = reportsPerMinute > 0 ? new FailureLimiter(reportsPerMinute, WRITE_LIMIT_WINDOW_MS) : null;
  return (req, res, next) => {
    if (!req.user) return next();
    const report = isAuditEventReport(req.method, req.path);
    if (!report && !isWriteLimited(req.method, req.path)) return next();
    if (report && !reports) return next();
    const limit = report ? reportsPerMinute : perMinute;
    const c = report ? reports! : counter;
    const key = String(req.user.id);
    const t = now();
    if (c.count(key, t) >= limit) {
      res.setHeader('Retry-After', String(WRITE_LIMIT_WINDOW_MS / 1000));
      throw tooManyRequests(report ? AUDIT_EVENTS_LIMIT_MESSAGE : WRITE_LIMIT_MESSAGE);
    }
    c.record(key, t);
    next();
  };
}
