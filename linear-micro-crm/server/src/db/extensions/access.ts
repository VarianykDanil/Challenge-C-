/**
 * Sign-in safety (setup codes, hashed sessions, trial mode). Rules for extensions: ./types.ts.
 *
 *  - setup_codes: one-time setup codes (lib/setupCodes.ts): only a hash of the code, who it is for, why, who made it,
 *    when it stops working and when it was used. A person's codes go with them.
 *  - users.setup_code_required: 1 after an admin reset of the person's PIN — their next sign-in needs a setup code
 *    even with two-step on. Cleared when a code is used.
 *  - setup_codes.held_by: the two-step sign-in challenge a right code waits on; the code is used up only when that
 *    challenge's two-step code is right too (lib/setupCodes.ts holdSetupCode).
 *  - sessions.via_setup_code: 1 when the sign-in that made the session used a setup code. A session of an account
 *    without two-step that is not a one-tap demo account works only with it (middleware/auth.ts authenticate): a 1.4
 *    session, or a one-tap session after the demo sign-ins were switched off, is signed out instead of letting someone
 *    set up two-step without the code. 0 for every older session.
 *
 * One-off upgrades of an existing database, each guarded by its own `ext:access:*` flag and run inside a transaction:
 *  - `sessions-hashed`: every stored session token is replaced by its SHA-256 hash (lib/sessionKey.ts), so the cookie
 *    each device holds keeps working and nobody is signed out. Done once; a hash is never hashed again. On a fresh
 *    install the table is empty and the flag is set straight away.
 *  - `trial`: a database from before trial mode gets its value once. Still the demo (the demo seed built it and its
 *    four demo staff are intact) → trial mode on, with the demo company's people (the seed's 34 staff by their fixed id
 *    and employee ID, and its demo client accounts) and the seed marks recorded for `npm run golive`, below the first
 *    record the app made since (lib/demoRecords.ts seedMarksFromEvidence: the audit trail, and when statements arrived),
 *    so a trial week already spent on it is kept; the starter team already on it is treated as real people. Anything else with people in it → off. Skipped, without the flag, while
 *    the users table is empty (a fresh install, before its seed — the seed sets trial mode itself).
 */
import { all, get, transaction } from '../connection.ts';
import { demoClientMarkers } from '../../lib/client.ts';
import { demoStaffIntact, isDemoDatabase } from '../../lib/demoTeams.ts';
import { sessionKey } from '../../lib/sessionKey.ts';
import { seedMarksFromEvidence } from '../../lib/demoRecords.ts';
import { TRIAL_MODE_KEY, addDemoPeople, setTrialMode, writeSeedMarks } from '../../lib/trialMode.ts';
import { USERS } from '../seed-data.ts';
import { addColumnIfMissing, metaFlag, setMetaFlag, type DbExtension } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS setup_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  held_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_setup_codes_user ON setup_codes(user_id);
`;

export const SESSIONS_HASHED_FLAG = 'ext:access:sessions-hashed';
export const TRIAL_FLAG = 'ext:access:trial';

/** The demo company's people on an older demo database: the seed's staff (fixed ids and IDs) and its demo clients. */
export function seededDemoPeople(db: Parameters<DbExtension['upgrade']>[0]): number[] {
  const ids: number[] = [];
  for (const u of USERS) {
    const employeeId = `LM-${String(u.no).padStart(4, '0')}`;
    const row = get<{ id: number }>(db, `SELECT id FROM users WHERE id = ? AND upper(employee_id) = ?`, [u.no, employeeId]);
    if (row) ids.push(row.id);
  }
  for (const m of demoClientMarkers(db)) if (get(db, `SELECT 1 FROM users WHERE id = ? AND role = 'client'`, [m.id])) ids.push(m.id);
  return ids;
}

export const extension: DbExtension = {
  name: 'access',
  sql: SQL,
  upgrade(db) {
    const changed: string[] = [];
    for (const col of [
      addColumnIfMissing(db, 'users', 'setup_code_required', 'INTEGER NOT NULL DEFAULT 0'),
      addColumnIfMissing(db, 'setup_codes', 'held_by', 'TEXT'),
      addColumnIfMissing(db, 'sessions', 'via_setup_code', 'INTEGER NOT NULL DEFAULT 0'),
    ]) {
      if (col) changed.push(col);
    }

    if (!metaFlag(db, SESSIONS_HASHED_FLAG)) {
      const n = transaction(db, () => {
        const rows = all<{ token: string }>(db, `SELECT token FROM sessions`);
        const update = db.prepare(`UPDATE sessions SET token = ? WHERE token = ?`);
        for (const r of rows) update.run(sessionKey(r.token), r.token);
        setMetaFlag(db, SESSIONS_HASHED_FLAG);
        return rows.length;
      });
      if (n > 0) changed.push('sessions.hashed');
    }

    if (!metaFlag(db, TRIAL_FLAG)) {
      const hasPeople = Boolean(get(db, `SELECT 1 FROM users LIMIT 1`));
      const decided = get(db, `SELECT 1 FROM meta WHERE key = ?`, [TRIAL_MODE_KEY]);
      if (decided) {
        setMetaFlag(db, TRIAL_FLAG); // the seed set it already
      } else if (hasPeople) {
        const on = isDemoDatabase(db) && Boolean(get(db, `SELECT 1 FROM pay_plans LIMIT 1`)) && demoStaffIntact(db);
        transaction(db, () => {
          if (on) {
            addDemoPeople(db, seededDemoPeople(db));
            writeSeedMarks(db, seedMarksFromEvidence(db));
          }
          setTrialMode(db, on);
          setMetaFlag(db, TRIAL_FLAG);
        });
        // a database found not to be the demo just records that, silently; turning trial mode on is worth saying
        if (on) changed.push('trial_mode.on');
      }
    }
    return changed;
  },
};
