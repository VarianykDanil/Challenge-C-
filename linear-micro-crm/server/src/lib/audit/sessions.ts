/**
 * Release 1.3 — OWNED BY P9 audit-everything (integration I1). A sign-out nobody tapped: a session that ended by the
 * admin's idle timeout (Settings → Security, 12 hours by default). The lead decision is that every sign-in and sign-out
 * is recorded, so it gets a row like POST /auth/logout's: kind `sign_in`, filed under its owner, real clock, London
 * time — "Signed out after 12 hours without activity (last active 18:02 Wed 21 Oct)". Written by the foundation's
 * middleware/auth.ts when the person comes back to an idle session (authenticate), and at start-up for sessions that
 * went idle while the server was off (purgeExpiredSessions). It is not the person being active: GET /audit/person
 * leaves it out of `lastActiveAt`.
 *
 * Its own file, not lib/audit/signIns.ts: lib/auditSpecs.ts imports signIns.ts, and lib/audit.ts imports the specs
 * (through ./registry.ts), so signIns.ts importing lib/audit.ts would close an import cycle.
 */
import type { Db } from '../../db/connection.ts';
import { recordAudit } from '../audit.ts';
import { formatShort, toBusinessISO } from '../dates.ts';

/** The action of a sign-out by the session idle timeout. */
export const IDLE_SIGN_OUT_ACTION = 'SESSION idle';

/** Records one idle sign-out. Never throws: a failed audit write never stops the request or the start-up. */
export function recordIdleSignOut(db: Db, s: { userId: number; lastSeenAt: string; idleHours: number; ip: string | null }): void {
  try {
    const seen = Date.parse(s.lastSeenAt);
    const at = Number.isFinite(seen) ? toBusinessISO(new Date(seen)) : null;
    const when = at ? ` (last active ${at.slice(11, 16)} ${formatShort(at.slice(0, 10))})` : '';
    recordAudit(db, {
      userId: s.userId,
      action: IDLE_SIGN_OUT_ACTION,
      kind: 'sign_in',
      summary: `Signed out after ${s.idleHours} ${s.idleHours === 1 ? 'hour' : 'hours'} without activity${when}`,
      ip: s.ip,
    });
  } catch (err) {
    console.error('Audit trail: the idle sign-out was not recorded', err);
  }
}

/**
 * Release 1.4 (package S): the other sign-out nobody tapped — the session reached the admin's hours-from-sign-in limit
 * (Settings → Sign-in rules, 14 hours by default), whatever the activity. Same shape as the idle one: kind `sign_in`,
 * filed under its owner, real clock, London time — "Signed out 14 hours after signing in (signed in 07:02 Fri 23 Oct)".
 * Written by middleware/auth.ts when the request that finds the session over the limit ends it, and by the start-up /
 * 15-minute sweep (purgeExpiredSessions) for sessions whose limit and cookie ran out unused: one row per person. Not
 * the person being active: GET /audit/person leaves it out of `lastActiveAt`.
 */
export const MAX_AGE_SIGN_OUT_ACTION = 'SESSION max-age';

/** Records one automatic sign-out at the hours-from-sign-in limit. Never throws, like recordIdleSignOut. */
export function recordMaxAgeSignOut(db: Db, s: { userId: number; signedInAt: string; maxHours: number; ip: string | null }): void {
  try {
    const signedIn = Date.parse(s.signedInAt);
    const at = Number.isFinite(signedIn) ? toBusinessISO(new Date(signedIn)) : null;
    const when = at ? ` (signed in ${at.slice(11, 16)} ${formatShort(at.slice(0, 10))})` : '';
    recordAudit(db, {
      userId: s.userId,
      action: MAX_AGE_SIGN_OUT_ACTION,
      kind: 'sign_in',
      summary: `Signed out ${s.maxHours} ${s.maxHours === 1 ? 'hour' : 'hours'} after signing in${when}`,
      ip: s.ip,
    });
  } catch (err) {
    console.error('Audit trail: the automatic sign-out was not recorded', err);
  }
}
