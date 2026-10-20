/**
 * Release 1.2 — OWNED BY U1 sign-in-pin (laid down empty by r2-foundation).
 * Planned: PIN columns on users (scrypt hash, set-at; never the PIN itself), a sessions column for the idle timeout
 * (e.g. last_seen_at), and the security settings (require a PIN for everyone, require two-step for admins, session
 * idle hours) as meta keys or a small settings table. All defaults OFF / 12 h so existing tests and the demo accounts
 * keep working. Columns on existing tables go in `upgrade` (addColumnIfMissing). Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'pin',
  sql: '',
  upgrade: () => [],
};
