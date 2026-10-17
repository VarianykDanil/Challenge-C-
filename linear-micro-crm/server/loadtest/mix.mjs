// Read-heavy mixed-workload load generator for Linear Hub.
//
//   node mix.mjs --url http://127.0.0.1:4600 --connections 50 --duration 30 [--json out.json]
//
// Models a realistic role mix (60% rep, 25% leader, 10% recruiter, 5% admin). Each virtual
// connection logs in once (its own session cookie) and then loops, firing a random endpoint
// from its role's pool until the clock runs out. Endpoints are role-appropriate so a 403 is a
// real error, not a scripted one. Reports p50/p95/p99, req/s and error rate overall and per endpoint.
//
// Node 22, global fetch only. Keep-alive is on by default, so in-flight concurrency ≈ --connections.

import { parseArgs, login, summarise, todayISO, addDays, mdTable } from './common.mjs';

const args = parseArgs({ url: 'http://127.0.0.1:4600', connections: '50', duration: '30' });
const BASE = String(args.url).replace(/\/$/, '');
const CONNS = Number(args.connections);
const DURATION_MS = Number(args.duration) * 1000;

const today = todayISO();
const w12 = { from: addDays(today, -84), to: today }; // 12 weeks
const w3 = { from: addDays(today, -7), to: addDays(today, 14) }; // ~3 week window

// Per-role endpoint pools. Each entry is [weight, label, pathBuilder].
const RANGES = ['week', 'month', 'quarter'];
const GROUPS = ['user', 'team', 'campaign', 'day', 'week'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

const COMMON = [
  [5, 'GET /me/dashboard', () => `/api/me/dashboard?range=${rnd(RANGES)}`],
  [4, 'GET /gauges/summary', () => `/api/gauges/summary?groupBy=${rnd(GROUPS)}&from=${w12.from}&to=${w12.to}`],
  [3, 'GET /leaderboard', () => `/api/leaderboard?period=month`],
  [3, 'GET /events', () => `/api/events?from=${w3.from}&to=${w3.to}`],
  [2, 'GET /users', () => `/api/users`],
  [1, 'GET /gauges', () => `/api/gauges?from=${w12.from}&to=${w12.to}&limit=200`],
];
const POOLS = {
  rep: COMMON,
  leader: [...COMMON, [3, 'GET /finance/summary', () => `/api/finance/summary?from=${w12.from}&to=${w12.to}`], [2, 'GET /recruitment/summary', () => `/api/recruitment/summary`]],
  recruiter: [...COMMON, [4, 'GET /recruitment/summary', () => `/api/recruitment/summary`], [3, 'GET /recruitment/candidates', () => `/api/recruitment/candidates?open=true`]],
  admin: [...COMMON, [3, 'GET /finance/summary', () => `/api/finance/summary?from=${w12.from}&to=${w12.to}`], [2, 'GET /recruitment/summary', () => `/api/recruitment/summary`], [1, 'GET /finance/payroll', () => `/api/finance/payroll?from=${w12.from}&to=${w12.to}`]],
};

/** Expand a weighted pool into a flat pick list. */
function flatten(pool) {
  const out = [];
  for (const [w, label, build] of pool) for (let i = 0; i < w; i++) out.push({ label, build });
  return out;
}
const FLAT = Object.fromEntries(Object.entries(POOLS).map(([r, p]) => [r, flatten(p)]));

/** Assign roles to the N connections by the 60/25/10/5 split (at least 1 of each when N>=4). */
function assignRoles(n) {
  const mix = [['rep', 0.6], ['leader', 0.25], ['recruiter', 0.10], ['admin', 0.05]];
  const roles = [];
  for (const [role, frac] of mix) for (let i = 0; i < Math.round(frac * n); i++) roles.push(role);
  while (roles.length < n) roles.push('rep');
  return roles.slice(0, n);
}

async function worker(cookie, role, deadline, samples) {
  const pool = FLAT[role];
  while (performance.now() < deadline) {
    const pick = rnd(pool);
    const path = pick.build();
    const t0 = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      status = res.status;
      await res.arrayBuffer(); // fully drain the body (realistic client)
    } catch {
      status = 0; // connection error
    }
    samples.push({ endpoint: `${role} ${pick.label}`, status, ms: performance.now() - t0 });
  }
}

async function main() {
  const roles = assignRoles(CONNS);
  process.stderr.write(`[mix] base=${BASE} connections=${CONNS} duration=${args.duration}s roles=${JSON.stringify(countRoles(roles))}\n`);

  // One login per connection (per-connection session). Cache the cookie per role to avoid 4 logins only
  // when we want distinct sessions — here we deliberately mint a fresh session per connection.
  const cookies = await Promise.all(roles.map((r) => login(BASE, r)));

  const samples = [];
  const started = performance.now();
  const deadline = started + DURATION_MS;
  await Promise.all(roles.map((r, i) => worker(cookies[i], r, deadline, samples)));
  const wallMs = performance.now() - started;

  const sum = summarise(samples, wallMs);
  report(sum, wallMs);
  if (args.json) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(String(args.json), JSON.stringify({ connections: CONNS, durationS: Number(args.duration), wallMs, ...sum }, null, 2));
    process.stderr.write(`[mix] wrote ${args.json}\n`);
  }
}

function countRoles(roles) {
  return roles.reduce((m, r) => { m[r] = (m[r] || 0) + 1; return m; }, {});
}

function report(sum, wallMs) {
  console.log(`\n=== mix @ ${CONNS} connections for ${Math.round(wallMs / 1000)}s ===`);
  console.log(`requests=${sum.total} ok=${sum.ok} errors=${sum.errors} (${sum.errorRate}%) req/s=${sum.reqPerSec}`);
  console.log(`latency ms: p50=${sum.p50} p95=${sum.p95} p99=${sum.p99} max=${sum.max}`);
  console.log(`status counts: ${JSON.stringify(sum.statusCounts)}`);
  console.log('\nper endpoint (sorted by p95):');
  console.log(mdTable(
    ['endpoint', 'count', 'err', 'p50', 'p95', 'p99', 'max', 'avg'],
    sum.perEndpoint.map((e) => [e.endpoint, e.count, e.errors, e.p50, e.p95, e.p99, e.max, e.avg]),
  ));
}

main().catch((e) => { console.error(e); process.exit(1); });
