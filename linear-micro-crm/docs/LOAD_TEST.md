# Load test report (17 Oct 2026, sandbox hardware; 1.1 update 19 Oct 2026)

Run with the scripts in `server/loadtest/` (see its README). Numbers below come from an isolated instance with the seeded sample database.

> **Read §10 first for Linear Hub 1.1.** Sections 1–9 are the 17 Oct report on the code before the response cache:
> its ~430 req/s ceiling and most of its §8 recommendations (the cache, grouped per-week queries, the
> `events.campaign_id` index, the windowed events aggregate, the limiter sweep, immutable assets) have since shipped.

# Linear Hub — load & robustness report

**Date:** 2026-10-17 · **Target:** isolated instance `:4600`, own DB `…/scratchpad/load/load.sqlite`
(seeded: 34 users, 610 events, 2,821 gauges, 696 payroll runs, 110 candidates), `NODE_ENV=production`,
`TZ=Europe/London`, serving `client/dist`. **Host:** 4 vCPU / 16 GB, Node 22.22, `node:sqlite`.
**Load client:** `server/loadtest/{mix,writes,abuse,lag}.mjs` + `autocannon` (static only). App code untouched.

> ⚠️ The machine was shared with other work running at the same time: other servers were restarted and `client/dist`
> was rebuilt mid-run (the JS chunk was renamed twice; a 2FA/TOTP schema upgrade landed between runs). Where a run was contaminated it is re-run and
> labelled. My first `:4600` server was SIGKILLed externally near the 5-min mark of the first soak (clean exit, **no
> error in its log** — not an app crash); it was restarted and the soak re-run cleanly.

---

## Headline numbers

| Metric | Result |
|---|---|
| Read-mix throughput ceiling | **~430 req/s**, flat across 10 / 50 / 150 connections (single-thread + synchronous SQLite) |
| Read-mix latency | p95 **44 ms** @10c · **155 ms** @50c · **418 ms** @150c · 0 errors at every level |
| Write path (20 clients, 20 s) | 9,185 gauge upserts (458/s) + 2,282 candidate creates · p95 77 ms · **0× 5xx** · **0 duplicate rows** |
| Static serving @100c | `/` 3,900 req/s · `/login` 3,500 req/s · 442 KB JS chunk 1,260 req/s @ **533 MB/s** · 0 errors |
| Abuse/robustness | **16/16 checks PASS** — no hang, no crash, no 5xx; limiter grew +720 KB for 2,000 IPs |
| Soak (50c, 5 min) | 106k reqs @ 354 req/s · p99 296 ms · **1 request hit 2.1 s** (tail); RSS 175→200 MB; loop lag p99 3.9 ms |
| SQLite | WAL, `synchronous=NORMAL`, FK on; DB 1.5 MB (+0.6 MB WAL). No query > 2 ms at this scale |

**Bottom line:** correctness and robustness are solid — zero 5xx, zero duplicate gauge rows under write contention,
every malformed/hostile input handled with the right 4xx, limiter and body caps work. The only ceiling is
**throughput**: the API is single-threaded and every DB call is synchronous, so the server saturates one core at
~430 req/s and added concurrency simply queues (latency rises linearly). The query-heavy aggregate endpoints
(`/me/dashboard`, `/finance/summary`, `/recruitment/summary`) fire 15–40 sequential queries each and are the first
thing to cache.

---

## 1. Read-heavy mix (30 s each, role mix 60/25/10/5, per-connection sessions)

| Connections | req/s | p50 | p95 | p99 | max | error rate | RSS before→after |
|---|---|---|---|---|---|---|---|
| 10 | 433 | 19.9 ms | 43.8 ms | 53.9 ms | 89 ms | 0% | 155→165 MB |
| 50 | 426 | 111.3 ms | 155.4 ms | 240.2 ms | 647 ms | 0% | 165→173 MB |
| 150 | 431 | 333.4 ms | 418.0 ms | 658.5 ms | **4,199 ms** | 0% | 173→179 MB |

Throughput is identical at all three levels → the server is **core-bound at ~430 req/s**. Latency scales almost
exactly linearly with concurrency (queueing): ~20 ms → ~111 ms → ~333 ms p50. At 150c the tail blows out (one 4.2 s
outlier) as requests pile up behind the single event loop. No endpoint errored. At 150c per-endpoint p95s all
converge (~400–420 ms) because queue wait dominates server work.

---

## 2. Write path (20 gauge clients + 5 candidate clients, 20 s)

| Stream | requests | req/s | statuses | 5xx | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|
| `POST /api/gauges` (upsert) | 9,185 | 458 | 9,125× 200, 60× 201 | **0** | 39 ms | 77 ms | 90 ms | 159 ms |
| `POST /api/recruitment/candidates` | 2,282 | 114 | 2,282× 201 | **0** | — | 78 ms | — | — |

- **Duplicate `(event_id,user_id,date)` rows after the run: 0** (verified across the whole table, before and after
  all phases). The `UNIQUE(event_id,user_id,date)` constraint + upsert held under heavy contention on a shared pool
  of 100 keys. (Synchronous `node:sqlite` on a single thread means two upserts cannot interleave mid-statement; an
  INSERT race would surface as a 409, not a duplicate — none occurred.)
- No 500s. Candidate creation (a 2-statement transaction) sustained 114/s with no contention errors.

---

## 3. Static serving @100 connections

| Path | req/s | p50 | p99 | max | throughput | non-2xx |
|---|---|---|---|---|---|---|
| `/` (SPA shell) | 3,903 | 23 ms | 47 ms | 72 ms | 9.3 MB/s | 0 |
| `/login` (SPA fallback → index.html) | 3,503 | 26 ms | 46 ms | 74 ms | 8.4 MB/s | 0 |
| largest JS chunk (442 KB) | 1,262 | 77 ms | 132 ms | 559 ms | **533 MB/s** | 0 |

`express.static` is an order of magnitude faster than the API and never a bottleneck. (An earlier JS run showed
2,182 4xx — an artifact of other work on the same machine rebuilding `client/dist` mid-test, renaming the chunk; the clean re-run
above is 0 non-2xx.)

---

## 4. Abuse / robustness — 16/16 PASS

| Check | Result |
|---|---|
| Oversized JSON **2 MB** | 413 in 8.6 ms (no hang) |
| Oversized JSON **20 MB** | 413 in 60 ms (no hang) |
| Deeply nested JSON (100k deep) | 400 "Invalid JSON body" in 15 ms (no stack-crash) |
| Date range before 2020 | 400 |
| Date span > 400 days | 400 |
| `from` after `to` | 400 |
| Malformed / nonsense date | 400 |
| `limit=999999` | 200, **capped to 500 rows** in 15 ms |
| 10 KB `q` search string | 200 |
| Unicode `q` search string | 200 |
| 10 KB candidate `notes` | 400 (schema cap 5,000) |
| Unicode candidate `notes` | 201 |
| 500 parallel invalid-session requests | all 401 in 234 ms, no crash |
| **Login flood, 2,000 distinct `X-Forwarded-For` IPs** | all 401; single-IP lockout flips to 429 on the 9th attempt; **limiter RSS +720 KB** (~360 B/entry, bounded) |
| Slowloris, 20 half-open sockets held 30 s | server kept serving: **60/60 health probes OK, max 2.9 ms** |

**Limiter memory:** 2,000 distinct keys cost +720 KB and the per-IP+email lockout works exactly as documented. The
in-memory map is only pruned when it exceeds **5,000 entries** (`routes/auth.ts:64`), so a slow attacker rotating
distinct IP+email pairs can hold ~5,000 entries (~1.8 MB) for up to 15 min, and the prune runs O(n) on the hot path.
Bounded and self-healing, but worth hardening (fix #5). **Slowloris:** half-open sockets don't block the event loop
(async header parsing), so other clients are unaffected.

---

## 5. Soak — 50 connections, 5 minutes

| Time | RSS |
|---|---|
| 0 min | 175 MB |
| 1 min | 185 MB |
| 3 min | 197 MB |
| 5 min | 200 MB (final 202 MB) |

- **Throughput:** 106,193 requests, 354 req/s, **0 errors**.
- **Latency:** p50 133 ms, p95 212 ms, p99 296 ms, **max 2,101 ms** → p99 well under 2 s; **exactly one request
  exceeded 2 s** over 5 min (a tail outlier, likely a GC pause on a heavy dashboard query). 99% completed ≤ 296 ms.
- **Event-loop lag (20 ms drift probe):** p50 0.15 ms, p99 3.9 ms, **max 40 ms** — no long synchronous stalls.
- **Health:** 249/249 probes OK; health p50 210 ms (queues behind the 50 busy connections, not a fault).
- **Memory:** +24 MB over 5 min, no runaway (reclaimed to ~130 MB when idle). No leak evident; a longer watch would
  give a definitive verdict.

---

## 6. SQLite configuration & size

- `server/src/db/connection.ts:12-14`: **`journal_mode = WAL`**, **`synchronous = NORMAL`**, **`foreign_keys = ON`**.
  (A read-only probe shows `synchronous=2` only because that PRAGMA is per-connection — the server's writer sets
  NORMAL=1.) WAL + NORMAL is the right durable-but-fast choice here.
- `page_size = 4096`, `page_count = 382` → **main DB ~1.5 MB** + ~0.6 MB uncheckpointed WAL. Seeded ~0.95 MB.
- The gauge/payroll hot paths are well-indexed (date, user_id+date, week_start, the UNIQUE key, etc.).

---

## 7. Top 5 heaviest endpoints + query plans

At seed scale **no single query exceeds ~2 ms**; the cost is the **number** of sequential queries, not any one plan.

1. **`GET /me/dashboard`** — **~15–20 queries/request**: personal + previous totals, `leaderboard` (current AND
   previous → 4 `fetchRows`), team block, company block (revenue + on-time payroll + candidates + hires +
   per-campaign), trend, pay estimate. Gauge aggregates use `SEARCH g USING INDEX idx_gauges_date` + PK lookups +
   `TEMP B-TREE FOR count(DISTINCT)`. Company `byCampaign` is a `CORRELATED SCALAR SUBQUERY` per campaign
   (`routes/dashboard.ts:91-96`).
2. **`GET /finance/summary`** — **12-week loop, 3 queries/week = 36+ round-trips** (`routes/finance.ts:204-219`), plus
   `byCampaign` (joins `pay_plans`), payroll list, and `estimateWeekPayroll`. All indexed, just repeated 12×.
3. **`GET /recruitment/summary`** — openByStage + reached + bySource + **12-week loop (3 queries/week)**
   (`routes/recruitment.ts:265-269`) + hired/applied/overdue; stage-change ranges `SCAN stage_changes` then PK-join.
4. **`GET /gauges/summary?groupBy=week`** — Monday-of-date is a **computed expression**, so the plan adds
   `TEMP B-TREE FOR GROUP BY` **and** `TEMP B-TREE FOR count(DISTINCT)` on top of the `idx_gauges_date` range
   (`lib/metrics.ts` `MONDAY_SQL`); `groupBy=campaign` adds a third for ORDER BY.
5. **`GET /leaderboard`** — **4 `fetchRows` aggregates** (current + previous, each `GROUP BY u.id` + temp B-tree),
   then ranks in JS (`lib/metrics.ts`).

**Flagged for growth (not slow today):**
- **Events list** (`db/queries.ts:80` `EVENT_SELECT`): the gauge-totals subquery is `MATERIALIZE`d via
  **`SCAN gauge_entries`** — it aggregates the **entire** gauge table regardless of the date window. Cost scales with
  total gauges, not the window (1.3 ms at 2.8k rows, a problem at years of data).
- **`events.campaign_id` has no index** — the only unindexed FK used in filters (`?campaignId=`, dashboard
  `byCampaign`, finance).

---

## 8. Prioritised fixes (file:line)

1. **HIGH — Short-TTL cache (15–30 s) for read-mostly aggregates.** `/me/dashboard`, `/finance/summary`,
   `/recruitment/summary`, `/leaderboard`, `/gauges/summary` only change on writes. An in-memory memo keyed by
   (userId or role+teamId, params) collapses the 15–40-query storm to one lookup — the single biggest win.
   → `routes/dashboard.ts`, `routes/finance.ts`, `routes/recruitment.ts`, `routes/leaderboard.ts`, `routes/gauges.ts`
   (or one shared cache middleware in `app.ts`).
2. **HIGH — Collapse the per-week loops into grouped queries.** Replace 12×(3 queries) with 3 `GROUP BY weekStart`
   queries stitched in JS (~36 round-trips → 3). → `routes/finance.ts:204-219`; `routes/recruitment.ts:265-269`.
3. **MEDIUM — Add `CREATE INDEX idx_events_campaign ON events(campaign_id)`.** Only unindexed FK used in filters.
   → `db/schema.ts` (near lines 72–73); used by `routes/dashboard.ts:94`, `routes/events.ts`, `routes/gauges.ts`.
4. **MEDIUM — Scope the events-list gauge aggregate to the window.** Push `e.date BETWEEN` into the `LEFT JOIN`
   subquery so it stops materialising sums over the whole `gauge_entries` table. → `db/queries.ts:80-86`.
5. **MEDIUM — Cap/prune the login-rate-limiter map proactively** (today prunes only >5,000 entries, O(n) on the hot
   path). Prune on an `unref`'d timer and/or bound with an LRU/max size. → `routes/auth.ts:43` and `:63-64`.
6. **LOW — Scale out for throughput > ~430 req/s.** `node:sqlite` is synchronous/single-threaded; run N worker
   processes (cluster/PM2) behind the proxy — WAL supports multiple reader processes; or precompute dashboard/finance
   aggregates into a summary table refreshed on write. → deployment / `index.ts`.
7. **LOW — `express.static` `immutable` + long max-age for hashed `/assets/*`** (skip revalidation). Cosmetic.
   → `app.ts`.

*(Session-table growth is already handled: a periodic purge runs every 15 min — `index.ts:52`.)*

---

## 9. Reproduce

Scripts in `server/loadtest/` (see its `README.md`). Boot an isolated `:4600` server with its own `DB_PATH`, then:

```
node server/loadtest/mix.mjs    --url http://127.0.0.1:4600 --connections 10|50|150 --duration 30
node server/loadtest/writes.mjs --url http://127.0.0.1:4600 --db <DB_PATH> --clients 20 --duration 20
node server/loadtest/abuse.mjs  --url http://127.0.0.1:4600 --pid <node pid> --ips 2000 --hold 30
node server/loadtest/lag.mjs    --url http://127.0.0.1:4600 --duration 300    # alongside a 50c mix
npx autocannon -c 100 -d 15 http://127.0.0.1:4600/            # + /login + largest /assets/*.js
node server/loadtest/plan.cjs   --db <copy of DB>             # EXPLAIN QUERY PLAN
```

---

## 10. Linear Hub 1.1 (19 Oct 2026)

**Same host as §1–9** (4 vCPU Intel Xeon 2.8 GHz / 16 GB, Node 22.22, `node:sqlite`), measured one server at a time
on an otherwise idle machine. Each server had its own freshly seeded database (34 users, ~590 events, ~2.7k gauges,
~690 payroll runs, 120 candidates), `NODE_ENV=production`, `TZ=Europe/London`, `LM_BACKUP=0`. **1.0** is commit
`76058b1` (before the smart release); **1.1** is the release branch with the review fixes. Load client:
`server/loadtest/mix.mjs`, 30 s per run, the same 60/25/10/5 role mix as §1. The first run after a start warms the JIT
and is listed but not counted in the range.

| Build · mix | Connections | req/s (runs) | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|---|
| 1.0 · 1.0 mix | 50 | **796–809** (759 first run) | 57–59 ms | 100–101 ms | 142–144 ms | 0 |
| 1.1 · 1.0 mix | 50 | **724–807** (637–677 first runs) | 58–66 ms | 105–118 ms | 139–162 ms | 0 |
| 1.1 · 1.0 mix, `LM_COMPRESSION=0` | 50 | **724–746** (653 first run) | 62–63 ms | 111–116 ms | 160–164 ms | 0 |
| 1.1 · 1.0 mix | 10 | **708** | 12.4 ms | 28.9 ms | 38.9 ms | 0 |
| 1.1 · 1.0 mix | 150 | **772** | 184 ms | 275 ms | 386 ms | 0 |
| 1.1 · smart mix (`--smart 1`) | 50 | **901** | 52 ms | 94 ms | 125 ms | 0 |

- **1.1 against 1.0:** on the same mix 1.1 is about 5–10 % slower at 50 connections (best runs 807 v 809; typical
  725–730 v 796–809). The extra time is spread evenly — every endpoint's average is 4–6 ms higher, none stands out
  (`/events` 69.9 v 63.8 ms, `/me/dashboard` 67.8 v 62.7 ms, `/gauges/summary` 68.3 v 62.2 ms in the paired runs) — so
  it is per-request work (the extra smart fields, the cache bookkeeping, security headers) rather than one slow query.
  Turning gzip off (`LM_COMPRESSION=0`) makes no measurable difference on this mix.
- **Still single-core bound:** throughput stays flat from 10 to 150 connections (708 → 772 req/s) while latency grows
  with the queue, as in §1. At 150 connections p99 is 386 ms with no outliers above 0.7 s (§1 had a 4.2 s tail).
- **The 1.1 endpoints are cheap:** with the bell, insights and the week in review added to every role's pool
  (`--smart 1`: `/me/attention`, `/me/insights`, `/me/digest`, all in the response cache), the mix answers 901 req/s;
  their p95 is 75–107 ms at 50 connections, the same as the rest of the mix.
- **Against 17 Oct:** 1.1 answers ~1.7× the requests of the pre-cache code (725–807 v ~430 req/s at 50 connections)
  with p95 105–118 ms instead of 155 ms. Zero errors in every run (about 336,000 requests over 15 runs).
- Not re-run for 1.1: the write path, static serving, abuse and soak sections (§2–5); the 1.1 changes do not touch
  their code paths beyond the response cache, which every write clears.

Reproduce (two terminals; stop each server by its pid afterwards):

```
DB_PATH=/tmp/lt11/load.sqlite PORT=4306 LM_BACKUP=0 NODE_ENV=production TZ=Europe/London node server/src/index.ts
node server/loadtest/mix.mjs --url http://127.0.0.1:4306 --connections 50 --duration 30            # 1.0 mix
node server/loadtest/mix.mjs --url http://127.0.0.1:4306 --connections 50 --duration 30 --smart 1  # + 1.1 endpoints
```
