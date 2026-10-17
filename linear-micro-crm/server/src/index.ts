/** Linear Hub API — bootstrap: open the SQLite database, create/seed it, run maintenance, mount the app. */
import path from 'node:path';
import { createApp, parseTrustProxy } from './app.ts';
import { openDb } from './db/connection.ts';
import { createSchema, isSeeded } from './db/schema.ts';
import { materialisePayrollRuns, rollForwardEventStatuses } from './db/maintenance.ts';
import { DEFAULT_DB_PATH, seed } from './db/seed.ts';
import { findPortHolder, installExitDiagnostics, listeningUrl, portBusyMessage } from './lib/boot.ts';
import { announceAppSecret, configureAppSecret } from './lib/crypto.ts';
import { purgeExpiredChallenges, reencryptLegacySecrets } from './lib/twofactor.ts';
import { purgeExpiredSessions } from './middleware/auth.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
// The encryption key for two-step secrets: LM_APP_SECRET, else a generated key kept next to the database
// (server/data/app-secret by default; LM_APP_SECRET_FILE relocates it).
configureAppSecret(process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret'));
const db = openDb(dbPath);
const upgraded = createSchema(db);
if (upgraded.length) console.log(`Upgraded schema: added ${upgraded.join(', ')}`);
announceAppSecret();
const rekeyed = reencryptLegacySecrets(db);
if (rekeyed) console.log(`Re-encrypted ${rekeyed} two-step secret(s) written under the old development key`);
if (!isSeeded(db)) {
  const started = performance.now();
  const stats = seed(db);
  console.log(
    `Seeded ${dbPath} in ${Math.round(performance.now() - started)}ms ` +
      `(${stats.users} users, ${stats.events} events, ${stats.gauges} gauges, ${stats.payrollRuns} payroll runs, ${stats.candidates} candidates)`,
  );
}
/** Expired sessions and two-step login challenges: at startup and with the 15-minute sweep below. */
function purgeExpired(): void {
  purgeExpiredSessions(db);
  purgeExpiredChallenges(db);
}
purgeExpired();

/** Event statuses follow the clock (today's events go live at their start time): cheap, so every 15 minutes. */
function rollEvents(): void {
  const rolled = rollForwardEventStatuses(db);
  if (rolled.completed || rolled.live) console.log(`Rolled event statuses forward: ${rolled.completed} completed, ${rolled.live} live`);
}
/** Payroll runs for newly completed pay weeks + a recompute of the last two weeks' unpaid runs: once a day (the finance routes also guard for it). */
function materialisePayroll(): void {
  const r = materialisePayrollRuns(db);
  if (r.created || r.updated || r.deleted) console.log(`Payroll runs: ${r.created} created, ${r.updated} recomputed from late gauges, ${r.deleted} removed`);
}
const guarded = (fn: () => void) => () => {
  try {
    fn();
  } catch (err) {
    console.error('Maintenance failed', err);
  }
};
rollEvents();
materialisePayroll();
setInterval(guarded(rollEvents), 15 * 60_000).unref();
setInterval(guarded(purgeExpired), 15 * 60_000).unref();
setInterval(guarded(materialisePayroll), 86_400_000).unref();

const isProduction = process.env.NODE_ENV === 'production';
const app = createApp(db, {
  staticDir: isProduction ? path.resolve(import.meta.dirname, '../../client/dist') : undefined,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
});

const port = Number(process.env.PORT ?? 4000);
// Refuse to start behind something that already answers on the port: macOS lets a second listener bind the
// dual-stack wildcard next to an IPv4 one, so "listening" would be printed while the browser talks to the old process.
const holder = await findPortHolder(port);
if (holder) {
  console.error(portBusyMessage(port, holder));
  db.close();
  process.exit(1);
}
const server = app.listen(port, () => {
  console.log(
    `Linear Hub API listening on ${listeningUrl(server, port)}${isProduction ? ' (serving client/dist)' : ''}. Press Ctrl+C to stop.`,
  );
});

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000);
}
// Every way the process can end is reported (signal, drained event loop, crash, stray process.exit), so a server
// that "stops for no reason" says why on the terminal.
installExitDiagnostics({ server, shutdown });
