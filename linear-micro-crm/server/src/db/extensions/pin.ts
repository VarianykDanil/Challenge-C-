/**
 * Release 1.2 — OWNED BY U1 sign-in-pin. Columns only (no tables, no seed rows):
 *  - users.pin_hash             scrypt hash of the PIN (`scrypt$N$r$p$salt$hash`, lib/pin.ts); never the PIN itself
 *  - users.pin_set_at           when the PIN was set (real clock, ISO)
 *  - users.pin_failed_attempts  wrong PINs in a row; at PIN_LOCK_AFTER_FAILURES the PIN is locked until an admin reset
 *  - sessions.last_seen_at      the session's last request (written at most once a minute) for the idle timeout
 * The security settings (require a PIN, require two-step for admins, session idle hours) are `ext:pin:*` keys in
 * `meta`, written only by PUT /auth/security-settings; absent keys mean the defaults (off, off, 12 h), so existing
 * tests and the demo accounts work unchanged. There is no seed: the demo accounts have no PIN. Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';
import { addColumnIfMissing } from './types.ts';

export const extension: DbExtension = {
  name: 'pin',
  sql: '',
  upgrade(db) {
    const lastSeen = addColumnIfMissing(db, 'sessions', 'last_seen_at', 'TEXT');
    // Sessions opened before 1.2 count as seen at the upgrade, so the new idle timeout does not sign everyone out at
    // once (part of adding the column: it runs once, and on a fresh install the table is still empty).
    if (lastSeen) db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE last_seen_at IS NULL`).run(new Date().toISOString());
    return [
      addColumnIfMissing(db, 'users', 'pin_hash', 'TEXT'),
      addColumnIfMissing(db, 'users', 'pin_set_at', 'TEXT'),
      addColumnIfMissing(db, 'users', 'pin_failed_attempts', 'INTEGER NOT NULL DEFAULT 0'),
      lastSeen,
    ].filter((name): name is string => name !== null);
  },
};
