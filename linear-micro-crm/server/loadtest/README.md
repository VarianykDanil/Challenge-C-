# Linear Hub — load & robustness test kit

Reusable, dependency-light load scripts for the Linear Hub API. They are **black-box external clients**: they talk
to a running server over HTTP and never import or modify application code. Node 22 only (global `fetch`,
`node:sqlite`, `node:net`); the single optional dependency is `autocannon`, used **only** for the static-asset
throughput test.

> ⚠️ Always point these at an **isolated** instance with its **own database** — never the dev server on `:4000`
> or `server/data/linear.sqlite`. The write and abuse scripts create rows and hammer the login limiter.

## 1. Boot an isolated server

```bash
cd <repo root>
DB_PATH=/tmp/loadtest/load.sqlite PORT=4600 NODE_ENV=production TZ=Europe/London NODE_NO_WARNINGS=1 \
  npx -w server tsx src/index.ts
```

It seeds `DB_PATH` on first start (≈35 users, ≈610 events, ≈2.8k gauges) and serves `client/dist` in production
mode. Note the **node pid** (the process that holds `load.sqlite` open) for the RSS / abuse arguments:

```bash
for d in /proc/[0-9]*/fd; do ls -l "$d" 2>/dev/null | grep -q load.sqlite && \
  { p=${d%/fd}; p=${p#/proc/}; ps -o comm= -p "$p" | grep -q node && echo "$p"; }; done
```

## 2. Demo logins used

Each script logs in with the seeded demo accounts (one session per virtual connection):
admin `danil@linear-mcr.co.uk`/`LM-0001`, leader `amelia.hart@…`/`LM-0002`, recruiter `priya.shah@…`/`LM-0003`,
rep `jordan.lee@…`/`LM-0010`.

## 3. Scripts

| Script | What it does |
|---|---|
| `mix.mjs` | Read-heavy mixed workload. Role mix 60% rep / 25% leader / 10% recruiter / 5% admin, per-connection sessions, role-appropriate endpoint pools (dashboard, gauges summary, leaderboard, events, finance/recruitment summary, users, gauges). Reports p50/p95/p99, req/s, error rate overall and per endpoint. |
| `writes.mjs` | Write path. Concurrent `POST /api/gauges` upserts (admin, so any user×event) over a shared pool of valid `(event,user,date)` combos to force contention, plus concurrent `POST /api/recruitment/candidates`. Afterwards verifies **no duplicate `(event_id,user_id,date)` rows** and counts any 5xx. Needs `--db` for combo selection + verification (read-only). |
| `abuse.mjs` | Robustness suite: oversized JSON (2/20 MB → 413), deeply nested JSON (→ 400), out-of-range/malformed dates, `limit=999999` capping, 10 KB + unicode strings in search/notes, 500 parallel invalid-session requests, login flood from N distinct `X-Forwarded-For` IPs (rate-limiter memory, pass `--pid` to sample RSS), and slowloris half-open sockets (does the server keep serving?). |
| `lag.mjs` | Event-loop lag probe: a 20 ms `setInterval` measures drift while polling `/api/health`. Reports max/p99 lag and health latency. Run alongside any load test. |
| `plan.cjs` | Read-only `EXPLAIN QUERY PLAN` + timing of the heaviest reconstructed queries; flags non-index full scans. Point `--db` at a **copy** of the DB. |
| `common.mjs` | Shared helpers (login, percentiles, arg parsing, markdown tables). Imported by the `.mjs` scripts. |

## 4. Running them

```bash
LT=server/loadtest ; URL=http://127.0.0.1:4600 ; PID=<node pid> ; DB=/tmp/loadtest/load.sqlite

# Read mix at several concurrency levels (30 s each)
node $LT/mix.mjs --url $URL --connections 10  --duration 30 --json /tmp/mix_10.json
node $LT/mix.mjs --url $URL --connections 50  --duration 30 --json /tmp/mix_50.json
node $LT/mix.mjs --url $URL --connections 150 --duration 30 --json /tmp/mix_150.json

# Write path (20 clients, 20 s) + duplicate check
node $LT/writes.mjs --url $URL --db $DB --clients 20 --duration 20 --json /tmp/writes.json

# Static serving at 100 connections (needs autocannon)
BIG=$(ls -S client/dist/assets/*.js | head -1)
npx autocannon -c 100 -d 15 "$URL/"            # SPA shell
npx autocannon -c 100 -d 15 "$URL/login"       # SPA fallback
npx autocannon -c 100 -d 15 "$URL/assets/$(basename $BIG)"   # largest JS chunk

# Robustness / abuse (pass --pid to measure limiter RSS growth)
node $LT/abuse.mjs --url $URL --pid $PID --ips 2000 --hold 30 --json /tmp/abuse.json

# Soak: 50 connections for 5 min + lag probe in parallel
node $LT/lag.mjs --url $URL --duration 300 --json /tmp/soak_lag.json &
node $LT/mix.mjs --url $URL --connections 50 --duration 300 --json /tmp/soak_mix.json

# Query plans against a copy of the DB
cp $DB /tmp/copy.sqlite && node $LT/plan.cjs --db /tmp/copy.sqlite
```

`autocannon` install (isolated, no repo dependency change):

```bash
mkdir -p /tmp/loadtools && cd /tmp/loadtools && npm init -y && npm i autocannon
# then call /tmp/loadtools/node_modules/.bin/autocannon
```

All `.mjs` scripts take `--url`, most take `--duration`/`--connections` (or `--clients`), and write a JSON summary
with `--json <path>`. They print a human-readable summary to stdout regardless.
