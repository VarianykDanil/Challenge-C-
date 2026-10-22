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
