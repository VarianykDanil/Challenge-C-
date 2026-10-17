// Write-path load: concurrent gauge upserts + candidate creation, then integrity verification.
//
//   node writes.mjs --url http://127.0.0.1:4600 --db /path/load.sqlite --clients 20 --duration 20 [--json out.json]
//
// Uses the ADMIN session (admins may upsert any user's gauges at any event, exempt from the team rule) so it can
// drive many valid (event,user,date) combos. A read-only connection to the DB picks valid combos and, afterwards,
// verifies that no (event_id,user_id,date) has more than one row and that no request produced a 500.
// Node 22, node:sqlite for read-only verification only.

import { DatabaseSync } from 'node:sqlite';
import { parseArgs, login, todayISO, round, pct, maxOf } from './common.mjs';

const args = parseArgs({ url: 'http://127.0.0.1:4600', clients: '20', duration: '20' });
const BASE = String(args.url).replace(/\/$/, '');
const CLIENTS = Number(args.clients);
const DURATION_MS = Number(args.duration) * 1000;
const DB = args.db;
if (!DB) { console.error('--db <path to load.sqlite> is required for combo selection + verification'); process.exit(1); }

/** A valid funnel: each stage <= previous. */
function funnel() {
  const stops = 20 + Math.floor(Math.random() * 180);
  const table = Math.floor(stops * (0.3 + Math.random() * 0.2));
  const presentations = Math.floor(table * (0.4 + Math.random() * 0.2));
  const closes = Math.floor(presentations * (0.3 + Math.random() * 0.3));
  const taps = Math.floor(closes * (0.5 + Math.random() * 0.4));
  const sales = Math.floor(taps * (0.5 + Math.random() * 0.4));
  return { stops, table, presentations, closes, taps, sales };
}

function pickCombos() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const today = todayISO();
  // Existing combos (upsert → UPDATE 200): guaranteed valid (event happened, user on team).
  const existing = db.prepare(
    `SELECT g.event_id AS eventId, g.user_id AS userId, g.date FROM gauge_entries g
     JOIN events e ON e.id = g.event_id WHERE e.status != 'cancelled' AND g.date <= ? ORDER BY g.date DESC LIMIT 40`,
  ).all(today);
  // Fresh combos (upsert → INSERT 201, or 409 under race): active user × completed event with no entry yet,
  // date = event date, on the event's team is not required because the writer is admin.
  const fresh = db.prepare(
    `SELECT e.id AS eventId, u.id AS userId, e.date AS date
     FROM events e JOIN users u ON u.status = 'active'
     WHERE e.status = 'completed' AND e.date <= ?
       AND NOT EXISTS (SELECT 1 FROM gauge_entries g WHERE g.event_id = e.id AND g.user_id = u.id AND g.date = e.date)
     LIMIT 60`,
  ).all(today);
  db.close();
  return { existing, fresh, combos: [...existing, ...fresh] };
}

function countDuplicates() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const dups = db.prepare(
    `SELECT event_id, user_id, date, COUNT(*) AS n FROM gauge_entries GROUP BY event_id, user_id, date HAVING n > 1`,
  ).all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM gauge_entries`).get().n;
  const candidates = db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get().n;
  db.close();
  return { dups, total, candidates };
}

async function main() {
  process.stderr.write(`[writes] base=${BASE} clients=${CLIENTS} duration=${args.duration}s db=${DB}\n`);
  const cookie = await login(BASE, 'admin');
  const { existing, fresh, combos } = pickCombos();
  process.stderr.write(`[writes] combos: ${existing.length} existing + ${fresh.length} fresh = ${combos.length}\n`);
  if (!combos.length) { console.error('no combos found'); process.exit(1); }

  const gaugeSamples = [];
  const candSamples = [];
  const started = performance.now();
  const deadline = started + DURATION_MS;

  // Gauge upsert workers — heavy contention: pick from the shared pool so many clients hit the same key.
  async function gaugeWorker() {
    while (performance.now() < deadline) {
      const c = combos[Math.floor(Math.random() * combos.length)];
      const body = { eventId: c.eventId, userId: c.userId, date: c.date, ...funnel() };
      const t0 = performance.now();
      let status = 0;
      try {
        const res = await fetch(`${BASE}/api/gauges`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
        status = res.status; await res.arrayBuffer();
      } catch { status = 0; }
      gaugeSamples.push({ status, ms: performance.now() - t0 });
    }
  }
  // Candidate creation workers (a quarter of the clients), each a unique email.
  async function candWorker(id) {
    let i = 0;
    while (performance.now() < deadline) {
      const t0 = performance.now();
      let status = 0;
      try {
        const res = await fetch(`${BASE}/api/recruitment/candidates`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ firstName: 'Load', lastName: `Cand${id}`, email: `load.${id}.${i++}.${Date.now()}@example.com`, source: 'website' }),
        });
        status = res.status; await res.arrayBuffer();
      } catch { status = 0; }
      candSamples.push({ status, ms: performance.now() - t0 });
    }
  }

  const gaugeClients = Math.max(1, CLIENTS);
  const candClients = Math.max(1, Math.floor(CLIENTS / 4));
  await Promise.all([
    ...Array.from({ length: gaugeClients }, gaugeWorker),
    ...Array.from({ length: candClients }, (_, i) => candWorker(i)),
  ]);
  const wallMs = performance.now() - started;

  const { dups, total, candidates } = countDuplicates();
  const g = statusBreakdown(gaugeSamples);
  const c = statusBreakdown(candSamples);
  const report = {
    wallMs: round(wallMs),
    gauge: { requests: gaugeSamples.length, reqPerSec: round(gaugeSamples.length / (wallMs / 1000)), ...g, p50: round(pct(gaugeSamples.map(s=>s.ms),50)), p95: round(pct(gaugeSamples.map(s=>s.ms),95)), p99: round(pct(gaugeSamples.map(s=>s.ms),99)), max: round(maxOf(gaugeSamples.map(s=>s.ms))) },
    candidate: { requests: candSamples.length, reqPerSec: round(candSamples.length / (wallMs / 1000)), ...c, p95: round(pct(candSamples.map(s=>s.ms),95)) },
    duplicates: dups.length,
    dupRows: dups,
    gaugeRowsAfter: total,
    candidateRowsAfter: candidates,
  };
  console.log(`\n=== write path @ ${gaugeClients} gauge + ${candClients} candidate clients for ${Math.round(wallMs/1000)}s ===`);
  console.log(`gauge POSTs: ${report.gauge.requests} (${report.gauge.reqPerSec}/s) statuses=${JSON.stringify(g.statuses)} p50=${report.gauge.p50} p95=${report.gauge.p95} p99=${report.gauge.p99} max=${report.gauge.max} ms`);
  console.log(`candidate POSTs: ${report.candidate.requests} (${report.candidate.reqPerSec}/s) statuses=${JSON.stringify(c.statuses)} p95=${report.candidate.p95} ms`);
  console.log(`5xx responses: gauge=${g.s5xx} candidate=${c.s5xx}`);
  console.log(`DUPLICATE (event_id,user_id,date) rows: ${dups.length} ${dups.length ? JSON.stringify(dups) : '(none — integrity held)'}`);
  console.log(`gauge rows after: ${total}; candidate rows after: ${candidates}`);
  if (args.json) { const { writeFileSync } = await import('node:fs'); writeFileSync(String(args.json), JSON.stringify(report, null, 2)); process.stderr.write(`[writes] wrote ${args.json}\n`); }
}

function statusBreakdown(samples) {
  const statuses = {};
  let s5xx = 0;
  for (const s of samples) { statuses[s.status] = (statuses[s.status] || 0) + 1; if (s.status >= 500) s5xx++; }
  return { statuses, s5xx };
}

main().catch((e) => { console.error(e); process.exit(1); });
