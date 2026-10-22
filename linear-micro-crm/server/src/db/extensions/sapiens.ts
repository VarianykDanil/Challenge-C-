/**
 * Release 1.3.1: team Sapiens and its seven blank demo accounts on an EXISTING demo database (the owner's Mac after
 * `npm run latest`). A fresh demo seed adds them itself, at its very end (db/seed.ts → lib/demoTeams.ts addDemoTeams)
 * and marks this step done, so this extension has no seed.
 *
 * The one-off step (`ext:sapiens:accounts`): only on a database the demo seed created (meta `seeded_at` and
 * `seed_today`; lib/demoTeams.ts isDemoDatabase) — never on a real one, nor on the route-test fixture. On a fresh install
 * the upgrade runs before the seed, on empty tables: it then skips WITHOUT setting the flag. A "Sapiens" team someone
 * made by hand is reused (only the accounts missing by email are added). Reports `team.sapiens` only when it inserted
 * something, so the first restart after a fresh seed reports nothing.
 */
import { get, transaction } from '../connection.ts';
import { todayISO } from '../../lib/dates.ts';
import { addDemoTeams, DEMO_TEAMS_DONE_KEY, isDemoDatabase } from '../../lib/demoTeams.ts';
import { metaFlag, setMetaFlag, type DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'sapiens',
  sql: '',
  upgrade(db) {
    if (metaFlag(db, DEMO_TEAMS_DONE_KEY)) return [];
    if (!isDemoDatabase(db)) return [];
    // the core rows it needs (people and the pay plans) are missing: try again on the next start
    if (!get(db, `SELECT 1 FROM users LIMIT 1`) || !get(db, `SELECT 1 FROM pay_plans LIMIT 1`)) return [];
    const r = transaction(db, () => {
      const added = addDemoTeams(db, todayISO());
      setMetaFlag(db, DEMO_TEAMS_DONE_KEY);
      return added;
    });
    return r.inserted.length > 0 || r.teamsCreated > 0 ? ['team.sapiens'] : [];
  },
};
