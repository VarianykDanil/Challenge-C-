/** Linear Hub API — bootstrap: open the SQLite database, create/seed it, run maintenance, mount the app. */
import http from 'node:http';
import path from 'node:path';
import { createApp, parseTrustProxy } from './app.ts';
import { openDb } from './db/connection.ts';
import { createSchema, isSeeded } from './db/schema.ts';
import { materialisePayrollRuns, payrollRunsLogLine, rollForwardEventStatuses } from './db/maintenance.ts';
import { DEFAULT_DB_PATH, seed } from './db/seed.ts';
import { findPortHolder, installExitDiagnostics, listeningUrl, networkUrls, portBusyMessage } from './lib/boot.ts';
import { backupDirFor, backupHour, backupsEnabled, configureBackupDir, configureOffsite, foldersOutsideBackup, scheduleBackups, whenBackupIdle } from './lib/backup.ts';
import { backupVideos } from './lib/backupFiles.ts';
import { configureSystemHealth } from './lib/attention/system.ts';
import { configureErrorLog, logServerError } from './lib/errorLog.ts';
import { offsiteConfig, offsiteProblem } from './lib/offsite.ts';
import { clientBuildStatus, staleBuildMessage } from './lib/buildStatus.ts';
import { KEY_REFUSAL_EXIT_CODE, appKeyRefusal, checkCurrentAppKey, recordFingerprint } from './lib/appKey.ts';
import { announceAppSecret, appKeyFingerprint, appSecretFile, configureAppSecret, setKeyCreation } from './lib/crypto.ts';
import { warnIfUnsupportedNode } from './lib/nodeSupport.ts';
import { businessClockPinned, businessNow } from './lib/dates.ts';
import { purgeExpiredChallenges, reencryptLegacySecrets } from './lib/twofactor.ts';
import { purgeAuditLog } from './lib/audit.ts';
// Release 1.3: background jobs (invoices: issue on week close and deem accepted; statements: the Gmail check).
import { startInvoiceJobs } from './lib/invoices.ts';
import { startStatementJob } from './lib/statements/job.ts';
import { startPaymentsJob } from './lib/payments/job.ts';
import { purgeExpiredSessions } from './middleware/auth.ts';
import { appVersion } from './routes/health.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
// The app key (two-step secrets, bank details, payment connections, PIN pepper): LM_APP_SECRET, else a generated key
// kept next to the database (server/data/app-secret by default; LM_APP_SECRET_FILE relocates it).
const keyFile = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
configureAppSecret(keyFile);
if (businessClockPinned()) {
  console.warn(`LM_BUSINESS_NOW is set: "today" for events, gauges and pay is ${businessNow().toString()}, not the real date. Unset it for real use.`);
}
warnIfUnsupportedNode();
// Server errors also go to <data dir>/logs/errors.log (rotated), and the admins' Needs-attention bell counts them.
configureErrorLog(path.dirname(dbPath));
const db = openDb(dbPath);
// The key and the database must belong together (lib/appKey.ts). Checked before anything reads or makes a key: a
// missing or different key for a database with locked data stops the start with the recovery steps.
const keyCheck = checkCurrentAppKey(db);
if (keyCheck.status === 'missing' || keyCheck.status === 'mismatch') {
  console.error(appKeyRefusal(keyCheck, { dbPath, keyFile: process.env.LM_APP_SECRET ? null : keyFile, backupDir: backupDirFor(dbPath) }));
  db.close();
  process.exit(KEY_REFUSAL_EXIT_CODE);
}
// Only a database with nothing locked yet may get a new key.
setKeyCreation(keyCheck.status === 'create');
const upgraded = createSchema(db, { demoSteps: true }); // the server's start: the demo-account steps may run (UpgradeOptions)
if (upgraded.length) console.log(`Upgraded schema: added ${upgraded.join(', ')}`);
const keyFingerprint = appKeyFingerprint(); // makes the key here on a brand-new database
setKeyCreation(false);
if (keyCheck.status === 'create' || keyCheck.record) recordFingerprint(db, keyFingerprint);
if (keyCheck.note) console.log(keyCheck.note);
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
  const line = payrollRunsLogLine(materialisePayrollRuns(db));
  if (line) console.log(line);
}
const guarded = (fn: () => void) => () => {
  try {
    fn();
  } catch (err) {
    logServerError('Maintenance failed', err);
  }
};
/** Release 1.2 (U3): audit entries older than two years (lib/audit.ts): at start-up and daily. */
function purgeAudit(): void {
  const removed = purgeAuditLog(db);
  if (removed) console.log(`Audit log: removed ${removed} entries older than two years`);
}
rollEvents();
materialisePayroll();
guarded(purgeAudit)();
setInterval(guarded(rollEvents), 15 * 60_000).unref();
setInterval(guarded(purgeExpired), 15 * 60_000).unref();
setInterval(guarded(materialisePayroll), 86_400_000).unref();
setInterval(guarded(purgeAudit), 86_400_000).unref();
// Release 1.3: self-billing invoices issued as weeks close and deemed accepted at 12:00 the day before payday (P2), and
// the commission statements read from Gmail every 15 minutes (P3). Each starts its own unref'd timers; a failure to
// start is logged and the server carries on.
guarded(() => void startInvoiceJobs(db))();
guarded(() => void startStatementJob(db))();
// Release 1.4 (F): payments still on their way are checked every 5 minutes (LM_PAYMENTS_JOB=0 turns it off).
guarded(() => void startPaymentsJob(db))();

// Backups (p10): dated copies of the database in <data dir>/backups (LM_BACKUP_DIR relocates it): 10 minutes after
// start-up when the last one is over 24 h old, and nightly from LM_BACKUP_HOUR (default 02:00 London) when none is
// dated today, so a laptop asleep at 02:00 catches up when it wakes. LM_BACKUP=0 turns the schedule off.
// Each backup carries the uploaded files (statement PDFs, the signature image; learning videos with
// LM_BACKUP_VIDEOS=1) and, with LM_OFFSITE_DIR, an encrypted off-site copy (lib/offsite.ts).
const backupDir = backupDirFor(dbPath);
const offsite = offsiteConfig();
configureBackupDir(backupDir, { scheduled: backupsEnabled() });
configureOffsite(offsite);
configureSystemHealth({ dataDir: path.dirname(dbPath), offsite });
if (backupsEnabled()) {
  scheduleBackups(db, {
    dir: backupDir,
    secretFile: process.env.LM_APP_SECRET ? null : appSecretFile(),
    files: { folders: foldersOutsideBackup(dbPath), includeVideos: backupVideos() },
    offsite,
    version: appVersion(),
    error: (line, err) => logServerError(line, err),
  });
  console.log(`Backups: nightly from ${String(backupHour()).padStart(2, '0')}:00 (London) into ${backupDir}; npm run backup makes one now.`);
} else {
  console.log(`Automatic backups are off (LM_BACKUP=0). npm run backup still makes one into ${backupDir}.`);
}
if (offsite) {
  const problem = offsiteProblem(offsite);
  console.log(problem ? `▲ Off-site copies are switched on but cannot run: ${problem}` : `Off-site copies (encrypted) go to ${offsite.dir} after each backup.`);
} else {
  console.log('Off-site copies are off: the backups stay on this computer (set LM_OFFSITE_DIR, docs/DEPLOY.md).');
}

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  // Started some other way than `npm start` (which builds when needed): say so if the screens are older than the code.
  const stale = staleBuildMessage(clientBuildStatus(path.resolve(import.meta.dirname, '../..')));
  if (stale) console.warn(stale);
}
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

// Plain node:http rather than app.listen(port, cb): Express 5 registers that callback as the server's 'error'
// listener too, so a failed bind (EADDRINUSE) would call it with the error, print "listening", swallow the error and
// let the process end with exit code 0 and nothing on the terminal. Here the server's 'error' event is reported
// by installExitDiagnostics and the callback only ever runs on 'listening'.
const server = http.createServer(app);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    // a backup in progress finishes first (it takes milliseconds; the 2 s guard below still applies)
    void whenBackupIdle(db).then(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 2000);
}
// Every way the process can end is reported (signal, bind failure, drained event loop, crash, stray process.exit),
// so a server that "stops for no reason" says why on the terminal.
installExitDiagnostics({ server, shutdown });

// HOST limits where the server is reachable: unset = every interface (phones and laptops on the same Wi-Fi or hotspot
// can open it); HOST=127.0.0.1 keeps it to this machine only.
const host = process.env.HOST?.trim() || undefined;
server.listen(port, host, () => {
  console.log(
    `Linear Hub API listening on ${listeningUrl(server, port)}${isProduction ? ' (serving client/dist)' : ''}. Press Ctrl+C to stop.`,
  );
  const urls = networkUrls(port, host);
  if (urls.length) {
    console.log(`On your network (same Wi-Fi or hotspot): ${urls.map((u) => u.url).join('  ')}`);
    console.log('Run  npm run share  in another terminal for a QR code to open it on a phone.');
  } else if (host) {
    console.log(`Bound to ${host} only: other devices cannot reach it (unset HOST to allow them).`);
  }
});
