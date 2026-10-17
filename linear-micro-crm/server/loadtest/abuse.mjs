// Robustness / abuse suite for Linear Hub. Exercises the server's own defences against malformed and
// hostile input against an ISOLATED instance you booted yourself. It never modifies app code.
//
//   node abuse.mjs --url http://127.0.0.1:4600 [--pid <server pid>] [--ips 2000] [--hold 30] [--json out.json]
//
// Checks: login rate-limiter memory growth under many distinct X-Forwarded-For IPs; oversized JSON (expect 413,
// no hang); deeply nested JSON (expect 400); out-of-range / malformed date ranges; limit=999999 capping;
// unicode + 10 KB strings in notes/search; 500 parallel invalid-session requests; slowloris half-open sockets.

import net from 'node:net';
import { execSync } from 'node:child_process';
import { parseArgs, login, todayISO, addDays, round } from './common.mjs';

const args = parseArgs({ url: 'http://127.0.0.1:4600', ips: '2000', hold: '30' });
const BASE = String(args.url).replace(/\/$/, '');
const U = new URL(BASE);
const results = [];
const record = (name, outcome, detail) => { results.push({ name, outcome, detail }); console.log(`[${outcome}] ${name} — ${detail}`); };

function rss(pid) {
  if (!pid) return null;
  try { return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()); } catch { return null; }
}

/** Fire n tasks with a bounded concurrency pool; returns array of results from `fn(i)`. */
async function pool(n, concurrency, fn) {
  const out = new Array(n);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (true) { const i = next++; if (i >= n) break; out[i] = await fn(i); }
  });
  await Promise.all(workers);
  return out;
}

// ── 1. Login flood from many distinct IPs (rate-limiter memory) ──
async function loginFlood(pid) {
  const n = Number(args.ips);
  const before = rss(pid);
  const statuses = {};
  await pool(n, 100, async (i) => {
    const ip = `203.0.${(i >> 8) & 255}.${i & 255}`; // distinct per i (up to 65k)
    try {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: `nobody${i}@example.com`, employeeId: 'WRONG-0000' }),
      });
      statuses[res.status] = (statuses[res.status] || 0) + 1;
      await res.arrayBuffer();
    } catch (e) { statuses.err = (statuses.err || 0) + 1; }
  });
  // single-IP lockout check: 10 failures from one IP+email should flip to 429 by the 9th
  const lockStatuses = [];
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ email: 'lock@example.com', employeeId: 'WRONG' }),
    });
    lockStatuses.push(res.status); await res.arrayBuffer();
  }
  global.gc?.();
  await new Promise((r) => setTimeout(r, 300));
  const after = rss(pid);
  const grew = before != null && after != null ? after - before : null;
  record('login-flood distinct IPs', statuses['401'] === n ? 'PASS' : 'WARN',
    `${n} IPs → statuses ${JSON.stringify(statuses)}; single-IP lockout sequence ${JSON.stringify(lockStatuses)}; RSS ${before}→${after} KB (${grew != null ? (grew >= 0 ? '+' : '') + grew + ' KB' : 'n/a'})`);
  return { before, after, grew, statuses, lockStatuses };
}

// ── 2. Oversized JSON bodies → expect 413, not a hang ──
async function oversized() {
  for (const mb of [2, 20]) {
    const body = JSON.stringify({ email: 'x'.repeat(mb * 1024 * 1024), employeeId: 'y' });
    const t0 = performance.now();
    let status = 0, timedOut = false;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 15000);
      const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal });
      clearTimeout(timer); status = res.status; await res.arrayBuffer();
    } catch (e) { status = timedOut ? -1 : 0; }
    const ms = round(performance.now() - t0);
    record(`oversized body ${mb} MB`, status === 413 ? 'PASS' : (status === -1 ? 'FAIL' : 'WARN'),
      `status=${status === -1 ? 'TIMEOUT/HANG' : status} in ${ms} ms (expected 413)`);
  }
}

// ── 3. Deeply nested JSON → expect 400, not a crash ──
async function nested() {
  const depth = 100000;
  const body = '['.repeat(depth) + ']'.repeat(depth); // ~200 KB, well under the 1 MB cap
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    status = res.status; await res.arrayBuffer();
  } catch { status = 0; }
  record('deeply nested JSON', status === 400 ? 'PASS' : 'WARN', `depth=${depth} → status=${status} in ${round(performance.now() - t0)} ms (expected 400)`);
}

// ── 4. Date-range abuse (needs a session) ──
async function dateRanges(cookie) {
  const today = todayISO();
  const cases = [
    ['before 2020', `/api/gauges/summary?groupBy=day&from=2019-06-01&to=${today}`, 400],
    ['span > 400 days', `/api/gauges/summary?groupBy=week&from=2024-01-01&to=2025-12-31`, 400],
    ['from after to', `/api/events?from=${today}&to=2026-01-01`, 400],
    ['malformed date', `/api/events?from=not-a-date&to=${today}`, 400],
    ['nonsense month', `/api/events?from=2026-13-40&to=${today}`, 400],
  ];
  for (const [label, path, expect] of cases) {
    let status = 0;
    try { const res = await fetch(`${BASE}${path}`, { headers: { cookie } }); status = res.status; await res.arrayBuffer(); } catch { status = 0; }
    record(`date range: ${label}`, status === expect ? 'PASS' : 'WARN', `status=${status} (expected ${expect})`);
  }
}

// ── 5. limit=999999 should cap, not explode ──
async function hugeLimit(cookie) {
  const t0 = performance.now();
  let status = 0, len = 0;
  try {
    const res = await fetch(`${BASE}/api/gauges?limit=999999&from=${addDays(todayISO(), -84)}&to=${todayISO()}`, { headers: { cookie } });
    status = res.status; const j = await res.json(); len = Array.isArray(j) ? j.length : -1;
  } catch { status = 0; }
  record('limit=999999', status === 200 && len <= 500 ? 'PASS' : 'WARN', `status=${status} rows=${len} (cap 500) in ${round(performance.now() - t0)} ms`);
}

// ── 6. Unicode + 10 KB strings in notes/search ──
async function bigStrings(cookie) {
  const big = 'A'.repeat(10 * 1024);
  const unicode = '🔥💥🧨'.repeat(50) + 'Ω≈ç√∫˜µ≤≥÷';
  // search q (LIKE) — oversized string is allowed, should just return 200
  for (const [label, q] of [['10KB q', big], ['unicode q', unicode]]) {
    let status = 0;
    try { const res = await fetch(`${BASE}/api/users?q=${encodeURIComponent(q)}`, { headers: { cookie } }); status = res.status; await res.arrayBuffer(); } catch { status = 0; }
    record(`search ${label}`, status === 200 ? 'PASS' : 'WARN', `status=${status} (expected 200)`);
  }
  // candidate notes: schema caps notes at 5000 chars → 10 KB must be 400, unicode within limit 201/200
  for (const [label, notes, expect] of [['10KB notes', big, 400], ['unicode notes', unicode, 201]]) {
    let status = 0;
    try {
      const res = await fetch(`${BASE}/api/recruitment/candidates`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ firstName: 'Load', lastName: 'Test', email: `lt${Date.now()}${Math.random().toString(36).slice(2)}@example.com`, notes }),
      });
      status = res.status; await res.arrayBuffer();
    } catch { status = 0; }
    record(`candidate ${label}`, status === expect ? 'PASS' : 'WARN', `status=${status} (expected ${expect})`);
  }
}

// ── 7. 500 parallel requests with an invalid session cookie → all 401, no crash ──
async function invalidSessions() {
  const n = 500;
  const t0 = performance.now();
  const statuses = {};
  await pool(n, 200, async () => {
    try {
      const res = await fetch(`${BASE}/api/me/dashboard`, { headers: { cookie: 'lm_session=deadbeefdeadbeefdeadbeefdeadbeef' } });
      statuses[res.status] = (statuses[res.status] || 0) + 1; await res.arrayBuffer();
    } catch { statuses.err = (statuses.err || 0) + 1; }
  });
  record('500 invalid-session requests', statuses['401'] === n ? 'PASS' : 'WARN', `statuses ${JSON.stringify(statuses)} in ${round(performance.now() - t0)} ms`);
}

// ── 8. Slowloris: hold N half-open sockets; confirm the server still serves others ──
async function slowloris(pid) {
  const sockets = 20;
  const holdMs = Number(args.hold) * 1000;
  const held = [];
  for (let i = 0; i < sockets; i++) {
    const s = net.connect({ host: U.hostname, port: Number(U.port) });
    s.on('error', () => {});
    s.on('connect', () => {
      // partial request: method + path + one header, never the final blank line
      s.write(`GET /api/health HTTP/1.1\r\nHost: ${U.host}\r\nX-Slow: start\r\n`);
      // dribble a header byte every few seconds to keep it alive
      s._drip = setInterval(() => { try { s.write(`X-Drip-${Date.now()}: 1\r\n`); } catch {} }, 5000);
    });
    held.push(s);
  }
  // While they're held, hammer /api/health with a normal client and measure latency.
  const probe = [];
  const start = performance.now();
  while (performance.now() - start < holdMs) {
    const t0 = performance.now();
    let status = 0;
    try { const res = await fetch(`${BASE}/api/health`); status = res.status; await res.arrayBuffer(); } catch { status = 0; }
    probe.push({ ms: performance.now() - t0, status });
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const s of held) { clearInterval(s._drip); s.destroy(); }
  const ok = probe.filter((p) => p.status === 200).length;
  const maxMs = round(Math.max(...probe.map((p) => p.ms), 0));
  record('slowloris 20 half-open sockets', ok === probe.length ? 'PASS' : 'WARN',
    `held ${sockets} sockets ${args.hold}s; ${ok}/${probe.length} health probes OK, max probe ${maxMs} ms (server kept serving = ${ok > 0})`);
}

async function main() {
  const pid = args.pid ? Number(args.pid) : null;
  process.stderr.write(`[abuse] base=${BASE} pid=${pid ?? 'n/a'} ips=${args.ips} hold=${args.hold}s\n`);
  const cookie = await login(BASE, 'admin');

  await oversized();
  await nested();
  await dateRanges(cookie);
  await hugeLimit(cookie);
  await bigStrings(cookie);
  await invalidSessions();
  const flood = await loginFlood(pid);
  await slowloris(pid);

  console.log(`\n=== abuse summary: ${results.filter((r) => r.outcome === 'PASS').length}/${results.length} PASS ===`);
  if (args.json) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(String(args.json), JSON.stringify({ results, flood }, null, 2));
    process.stderr.write(`[abuse] wrote ${args.json}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
