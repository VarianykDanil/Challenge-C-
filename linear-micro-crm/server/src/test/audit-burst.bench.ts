/**
 * Release 1.3 — P9 audit-everything: the audit write budget, measured. Not part of `npm test` (the name ends in
 * .bench.ts); run it by hand, against this tree or another checkout's server folder:
 *
 *   TZ=Europe/London NODE_NO_WARNINGS=1 node src/test/audit-burst.bench.ts [path/to/other/server]
 *
 * It starts the test server (the small fixture, in memory), signs everyone in, then fires bursts of 1,000 requests,
 * 10 at a time, and prints the time each burst took, the latency percentiles and the audit rows it wrote:
 *   1. audited writes   PATCH /gauges/:id (admin) — before/after snapshots, a pay-run check, one row each
 *   2. trail reads      GET /audit?limit=50 (admin)
 *   3. failed sign-ins  POST /auth/login with 1,000 different unknown emails (1.3 records them, within its budget)
 *   4. page reports     POST /audit/events from the six staff accounts (1.3 records them, 60 a minute per person)
 * Run it before and after a change on the same machine; docs/LOGIC.md §16.9 has the numbers.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(process.argv[2] ?? here);
const load = (rel: string) => import(pathToFileURL(path.join(root, 'src', rel)).href);

const helpers = await load('test/helpers.ts');
const { setBusinessClock } = await load('lib/dates.ts');

const TODAY = '2026-10-15';
setBusinessClock(new Date(`${TODAY}T15:00:00`));
const BURST = 1_000;
const CONCURRENCY = 10;

interface Result {
  name: string;
  ms: number;
  p50: number;
  p95: number;
  p99: number;
  statuses: Record<number, number>;
  rows: number;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function burst(name: string, db: { prepare(sql: string): { get(): unknown } }, fire: (i: number) => Promise<{ status: number }>): Promise<Result> {
  const rowsBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n);
  const times: number[] = [];
  const statuses: Record<number, number> = {};
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < BURST) {
        const i = next++;
        const s = performance.now();
        const r = await fire(i);
        times.push(performance.now() - s);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      }
    }),
  );
  const ms = performance.now() - t0;
  const rowsAfter = Number((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n);
  times.sort((a, b) => a - b);
  return { name, ms, p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), statuses, rows: rowsAfter - rowsBefore };
}

const srv = await helpers.startTestServer({ today: TODAY });
try {
  const f = srv.fixture;
  const admin = await srv.login('admin');
  const staff = await Promise.all(['admin', 'leader', 'recruiter', 'rep', 'repA2', 'repB'].map((r: string) => srv.login(r)));
  const entry = helpers.addGauge(srv.db, { eventId: f.events.todayA, userId: f.users.rep, date: TODAY, stops: 40, sales: 2 });
  const results: Result[] = [];
  results.push(await burst('audited writes (PATCH /gauges/:id)', srv.db, (i) => admin.patch(`/gauges/${entry}`, { stops: 40 + (i % 7), notes: `burst ${i}` })));
  results.push(await burst('trail reads (GET /audit?limit=50)', srv.db, () => admin.get('/audit?limit=50')));
  results.push(await burst('failed sign-ins (unknown emails)', srv.db, (i) => srv.anon().post('/auth/login', { email: `bench${i}@example.test`, employeeId: 'LM-0001' })));
  results.push(await burst('page reports (POST /audit/events)', srv.db, (i) => staff[i % staff.length].post('/audit/events', { kind: 'export', format: 'csv', what: 'gauges-by-team', rows: 12 })));
  console.log(`Audit burst benchmark — ${root}`);
  console.log(`${BURST} requests per burst, ${CONCURRENCY} at a time, Node ${process.version}`);
  for (const r of results) {
    const st = Object.entries(r.statuses).map(([s, n]) => `${s}×${n}`).join(' ');
    console.log(`${r.name.padEnd(38)} ${r.ms.toFixed(0).padStart(6)} ms  ${(BURST / (r.ms / 1000)).toFixed(0).padStart(5)} req/s  p50 ${r.p50.toFixed(2)}  p95 ${r.p95.toFixed(2)}  p99 ${r.p99.toFixed(2)} ms  rows +${r.rows}  [${st}]`);
  }
} finally {
  await srv.close();
  setBusinessClock(null);
}
