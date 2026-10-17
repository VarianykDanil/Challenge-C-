// Event-loop lag + health-latency probe. Run it alongside a load test:
//   node lag.mjs --url http://127.0.0.1:4600 --duration 300 [--json out.json]
// A setInterval fires every 20 ms; the drift (actual interval − 20 ms) is the event-loop lag. In parallel it
// polls /api/health every 1 s and records the response time. Reports max/p99 lag and max health latency.

import { parseArgs, round, pct, maxOf } from './common.mjs';

const args = parseArgs({ url: 'http://127.0.0.1:4600', duration: '60' });
const BASE = String(args.url).replace(/\/$/, '');
const DURATION_MS = Number(args.duration) * 1000;
const STEP = 20;

const lags = [];
const health = [];
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  lags.push(Math.max(0, now - last - STEP));
  last = now;
}, STEP);

let stopHealth = false;
async function pollHealth() {
  while (!stopHealth) {
    const t0 = performance.now();
    let status = 0;
    try { const res = await fetch(`${BASE}/api/health`); status = res.status; await res.arrayBuffer(); } catch { status = 0; }
    health.push({ ms: performance.now() - t0, status });
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const healthDone = pollHealth();

setTimeout(async () => {
  clearInterval(timer);
  stopHealth = true;
  await healthDone;
  const hm = health.map((h) => h.ms);
  const out = {
    durationS: Number(args.duration),
    lag: { samples: lags.length, maxMs: round(maxOf(lags)), p99Ms: round(pct(lags, 99)), p50Ms: round(pct(lags, 50)) },
    health: { polls: health.length, ok: health.filter((h) => h.status === 200).length, maxMs: round(maxOf(hm)), p99Ms: round(pct(hm, 99)), p50Ms: round(pct(hm, 50)) },
  };
  console.log(JSON.stringify(out, null, 2));
  if (args.json) { const { writeFileSync } = await import('node:fs'); writeFileSync(String(args.json), JSON.stringify(out, null, 2)); }
  process.exit(0);
}, DURATION_MS);
