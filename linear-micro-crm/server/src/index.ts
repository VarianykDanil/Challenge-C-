/** Linear Hub API — bootstrap: open the SQLite database, create/seed it, mount the app. */
import path from 'node:path';
import { createApp } from './app.ts';
import { openDb } from './db/connection.ts';
import { createSchema, isSeeded } from './db/schema.ts';
import { rollForwardEventStatuses } from './db/maintenance.ts';
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
const rolled = rollForwardEventStatuses(db);
if (rolled.completed || rolled.live) console.log(`Rolled event statuses forward: ${rolled.completed} completed, ${rolled.live} live`);

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
