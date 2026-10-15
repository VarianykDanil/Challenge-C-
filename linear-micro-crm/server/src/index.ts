/** Linear Hub API — bootstrap: open the SQLite database, create/seed it, run maintenance, mount the app. */
import path from 'node:path';
import { createApp } from './app.ts';
import { openDb } from './db/connection.ts';
import { createSchema, isSeeded } from './db/schema.ts';
import { materialisePayrollRuns, rollForwardEventStatuses } from './db/maintenance.ts';
import { DEFAULT_DB_PATH, seed } from './db/seed.ts';
import { purgeExpiredSessions } from './middleware/auth.ts';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const db = openDb(dbPath);
createSchema(db);
if (!isSeeded(db)) {
  const started = performance.now();
  const stats = seed(db);
  console.log(
    `Seeded ${dbPath} in ${Math.round(performance.now() - started)}ms ` +
      `(${stats.users} users, ${stats.events} events, ${stats.gauges} gauges, ${stats.payrollRuns} payroll runs, ${stats.candidates} candidates)`,
  );
}
purgeExpiredSessions(db);

/** Event statuses follow the clock (today's events go live at their start time): cheap, so every 15 minutes. */
function rollEvents(): void {
  const rolled = rollForwardEventStatuses(db);
  if (rolled.completed || rolled.live) console.log(`Rolled event statuses forward: ${rolled.completed} completed, ${rolled.live} live`);
}
/** Payroll runs for newly completed pay weeks: once a day (the finance routes also guard for it). */
function materialisePayroll(): void {
  const created = materialisePayrollRuns(db);
  if (created) console.log(`Materialised ${created} pending payroll runs for completed pay weeks`);
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
setInterval(guarded(materialisePayroll), 86_400_000).unref();

const isProduction = process.env.NODE_ENV === 'production';
const app = createApp(db, {
  staticDir: isProduction ? path.resolve(import.meta.dirname, '../../client/dist') : undefined,
});

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => {
  console.log(`Linear Hub API listening on http://localhost:${port}${isProduction ? ' (serving client/dist)' : ''}`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
