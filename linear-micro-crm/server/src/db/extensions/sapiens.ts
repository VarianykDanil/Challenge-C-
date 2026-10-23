/**
 * Release 1.3.1: team Sapiens and its seven blank demo accounts on an EXISTING demo database (the owner's Mac after
 * `npm run latest`). A fresh demo seed adds them itself, at its very end (db/seed.ts → lib/demoTeams.ts addDemoTeams)
 * and marks this step done, so this extension has no seed.
 *
 * The one-off step (`ext:sapiens:accounts`): only from the server's own start (createSchema `{ demoSteps: true }` in
 * index.ts, never a maintenance command such as npm run pin:reset), and only while the database is still the demo
 * (lib/demoTeams.ts demoStepAllowed): one the demo seed created (meta `seeded_at` and `seed_today`, so never the
 * route-test fixture) whose four demo staff accounts are intact, on a server not run with LM_DEMO_ACCOUNTS=0. Every
 * Linear Hub database starts from the demo seed, so a database in real use (a demo staff account left, removed, or given
 * another role) is done without gaining anyone. On a fresh install (the upgrade runs before the seed, on empty tables)
 * and with LM_DEMO_ACCOUNTS=0 it skips WITHOUT the flag. A "Sapiens" team someone made by hand is reused (only the
 * accounts missing by email are added). Reports `team.sapiens` only when it inserted something, so the first restart
 * after a fresh seed reports nothing.
 */
import { transaction } from '../connection.ts';
import { todayISO } from '../../lib/dates.ts';
import { addDemoTeams, DEMO_TEAMS_DONE_KEY, demoStepAllowed } from '../../lib/demoTeams.ts';
import { metaFlag, setMetaFlag, type DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'sapiens',
  sql: '',
  upgrade(db, opts) {
    // only from the server's own start, never a maintenance command (types.ts UpgradeOptions)
    if (!opts?.demoSteps || metaFlag(db, DEMO_TEAMS_DONE_KEY)) return [];
    // only while it is still the demo (lib/demoTeams.ts demoStepAllowed): LM_DEMO_ACCOUNTS=0, not a demo database, or
    // core rows missing → ask again next start; a demo staff account left, removed or given another role → done, nothing added
    const allowed = demoStepAllowed(db);
    if (allowed === 'later') return [];
    if (allowed === 'never') {
      setMetaFlag(db, DEMO_TEAMS_DONE_KEY);
      return [];
    }
    const r = transaction(db, () => {
      const added = addDemoTeams(db, todayISO());
      setMetaFlag(db, DEMO_TEAMS_DONE_KEY);
      return added;
    });
    return r.inserted.length > 0 || r.teamsCreated > 0 ? ['team.sapiens'] : [];
  },
};
