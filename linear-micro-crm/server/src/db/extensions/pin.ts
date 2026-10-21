/**
 * Release 1.2 — OWNED BY U1 sign-in-pin. Columns only (no tables, no seed rows):
 *  - users.pin_hash             peppered scrypt hash of the PIN (`scrypt-hmac$N$r$p$salt$hash`, lib/pin.ts; 1.2.0 wrote
 *                               `scrypt$…`, still read); never the PIN itself
 *  - users.pin_set_at           when the PIN was set (real clock, ISO)
 *  - users.pin_failed_attempts  wrong PINs in a row; every PIN_LOCK_AFTER_FAILURES-th one starts a lock
 *  - users.pin_locked_until     when the latest PIN lock ends (real clock, ISO; 15 min, doubling, 24 h at most), or NULL
 *  - sessions.last_seen_at      the session's last request (written at most once a minute) for the idle timeout
 * The security settings (require a PIN, require two-step for admins, session idle hours) are `ext:pin:*` keys in
 * `meta`, written only by PUT /auth/security-settings; absent keys mean the defaults (off, off, 12 h), so existing
 * tests and the demo accounts work unchanged. There is no seed: the demo accounts have no PIN. Rules: ./types.ts.
 */
import { PIN_LOCK_AFTER_FAILURES, PIN_LOCK_MINUTES } from '@lm/shared';
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
    const added = [
      addColumnIfMissing(db, 'users', 'pin_hash', 'TEXT'),
      addColumnIfMissing(db, 'users', 'pin_set_at', 'TEXT'),
      addColumnIfMissing(db, 'users', 'pin_failed_attempts', 'INTEGER NOT NULL DEFAULT 0'),
    ];
    const lockedUntil = addColumnIfMissing(db, 'users', 'pin_locked_until', 'TEXT');
    // 1.2.0 locked a PIN for good at ten wrong in a row. Such a PIN now gets an ordinary lock that ends 15 minutes
    // after the upgrade (part of adding the column: it runs once).
    if (lockedUntil) {
      db.prepare(`UPDATE users SET pin_locked_until = ? WHERE pin_hash IS NOT NULL AND pin_failed_attempts >= ?`)
        .run(new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString(), PIN_LOCK_AFTER_FAILURES);
    }
    return [...added, lockedUntil, lastSeen].filter((name): name is string => name !== null);
  },
};
