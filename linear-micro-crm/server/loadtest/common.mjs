// Shared helpers for the Linear Hub load scripts. Node 22, no dependencies (uses global fetch).
// Nothing here touches the app code; these are external black-box load clients.

export const DEMO = {
  admin: { email: 'danil@linear-mcr.co.uk', employeeId: 'LM-0001' },
  leader: { email: 'amelia.hart@linear-mcr.co.uk', employeeId: 'LM-0002' },
  recruiter: { email: 'priya.shah@linear-mcr.co.uk', employeeId: 'LM-0003' },
  rep: { email: 'jordan.lee@linear-mcr.co.uk', employeeId: 'LM-0010' },
};

/** Parse `--key value` / `--flag` CLI args into an object with defaults. */
export function parseArgs(defaults = {}) {
  const out = { ...defaults };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const key = a[i].slice(2);
    const next = a[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** Date helpers over YYYY-MM-DD, done in UTC to match the server. */
const DAY = 86_400_000;
export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Log in a demo user and return the raw `lm_session=...` cookie value (throws on failure). */
export async function login(baseUrl, role) {
  const creds = DEMO[role];
  if (!creds) throw new Error(`unknown role ${role}`);
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login ${role} failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = /lm_session=[^;]+/.exec(setCookie);
  if (!m) throw new Error(`login ${role}: no session cookie in response`);
  await res.arrayBuffer(); // drain
  return m[0];
}

/** Percentile (p in 0..100) of a numeric array; returns 0 for empty. Mutates by sorting a copy. */
export function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function round(n, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }

/** Max of an array without spreading (spreading a large array overflows the call stack). */
export function maxOf(arr) { let m = 0; for (const x of arr) if (x > m) m = x; return m; }

/** Summarise a list of {ms,status,endpoint} samples into overall + per-endpoint stats. */
export function summarise(samples, wallMs) {
  const ok = samples.filter((s) => s.status > 0 && s.status < 400);
  const errs = samples.filter((s) => !(s.status > 0 && s.status < 400));
  const all = samples.map((s) => s.ms);
  const byEp = new Map();
  for (const s of samples) {
    if (!byEp.has(s.endpoint)) byEp.set(s.endpoint, []);
    byEp.get(s.endpoint).push(s);
  }
  const perEndpoint = [...byEp.entries()].map(([endpoint, list]) => {
    const ms = list.map((x) => x.ms);
    const e = list.filter((x) => !(x.status > 0 && x.status < 400)).length;
    return {
      endpoint, count: list.length, errors: e,
      p50: round(pct(ms, 50)), p95: round(pct(ms, 95)), p99: round(pct(ms, 99)),
      max: round(maxOf(ms)), avg: round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)),
    };
  }).sort((a, b) => b.p95 - a.p95);
  return {
    total: samples.length,
    ok: ok.length,
    errors: errs.length,
    errorRate: round((errs.length / (samples.length || 1)) * 100, 3),
    reqPerSec: round(samples.length / (wallMs / 1000)),
    p50: round(pct(all, 50)), p95: round(pct(all, 95)), p99: round(pct(all, 99)),
    max: round(maxOf(all)),
    statusCounts: samples.reduce((m, s) => { m[s.status] = (m[s.status] || 0) + 1; return m; }, {}),
    perEndpoint,
  };
}

/** Markdown table from rows (array of arrays) with a header row. */
export function mdTable(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map((r) => line(r))].join('\n');
}
