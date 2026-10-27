# Maintainers' guide

For a developer taking over Linear Hub, or helping with it. It says how the system fits together, where the rules
live, how to add a feature without breaking what is there, how to run everything, how releases and upgrades work, and
what the known limits are. Read it with [`TEAM_CONTRACT.md`](TEAM_CONTRACT.md) (conventions), [`LOGIC.md`](LOGIC.md)
(the business rules in words), [`API.md`](API.md) (every endpoint) and [`DEPLOY.md`](DEPLOY.md) (the server).

Linear Hub is owned by Noryn System Ltd and licensed to Linear MCR Limited ([`LICENSE`](../LICENSE)). It was built by
one developer directing AI coding agents ([`TEAM.md`](TEAM.md)), so expect consistent patterns and a lot of tests,
and expect comments that tell the story of the release that wrote them (see [Reading the code's history
comments](#reading-the-codes-history-comments)).

---

## 1. The system in one minute

- **One process, one database file.** A Node.js server (Express 5) serves the JSON API under `/api` and the built
  React app. All data is in one SQLite file (Node's built-in `node:sqlite`) plus a few folders beside it (videos,
  statement PDFs, uploads, backups). It runs as exactly one copy.
- **Phone first.** The React app (Vite, Tailwind v4, TanStack Query) is used mostly on phones. Over HTTPS a service
  worker keeps the app shell on the phone, and gauge saves wait in an outbox when the signal drops.
- **Rules in one place.** Business rules (pay, gauges, dates, permissions wording, exports) are pure TypeScript in
  `shared/`, used by both the server and the screens, and tested on their own.
- **Production** is a small Ubuntu server behind Caddy (HTTPS), set up by `deploy/install.sh`; the office Mac on Wi-Fi
  is for trials only. See [`DEPLOY.md`](DEPLOY.md).

```
linear-micro-crm/
├── shared/      pure logic and types (no I/O), node:test     → @lm/shared
├── server/      Express 5 API, node:sqlite, jobs, CLI commands, node:test
├── client/      React 19 app (Vite), service worker
├── deploy/      the VPS installer, its templates and tests
└── docs/        user guide, API, logic, deploy, owner notes, this guide
```

The server runs TypeScript directly (Node 22.18+ strips types; no build step for the server). Imports inside `shared/`
and `server/` use explicit `.ts` extensions.

## 2. Getting started

```bash
cd linear-micro-crm
npm ci                         # Node 22.18+ (24 and 26 work too)
npm run dev                    # server on :4000 and Vite on :5173, a demo database on the first start
```

The first start builds the **demo company** (trial mode) in `server/data/` (never committed). Sign in with the demo
buttons on the sign-in page. For a scratch database anywhere else, set `DB_PATH`, `LM_APP_SECRET_FILE`,
`LM_UPLOADS_DIR` and `LM_STATEMENTS_DIR` to a folder of your own.

The checks every change must pass (CI runs the same):

```bash
npm run typecheck              # shared, server and client
npm test                       # shared + server suites (TZ=Europe/London is set by the scripts)
npm run smoke -w server        # boots a temporary server and calls every endpoint as each role
npm run build                  # the client production build
bash deploy/tests/run.sh       # the installer: shellcheck, helpers and a full dry run
```

Handy for demos and tests, **never on a real server**: `LM_BUSINESS_NOW=2026-10-19T15:00:00` pins the business clock;
`LM_PAYMENTS_FAKE=1` adds test payment providers that pay nobody.

## 3. Where things live

### shared/ — the rules

| Folder | What |
| --- | --- |
| `shared/src/logic/` | One file per area, each with its own `.test.ts`: gauges and funnel checks (`gauges.ts`), the pay rule (`payRule.ts`, `payForecast.ts`, `payrollFlags.ts`), pay weeks and dates (`dates.ts`), invoices and VAT (`invoices.ts`), payments and bank files (`payments.ts`, `bankFiles.ts`), statements (`statements.ts`), the audit wording (`audit.ts`), exports (`exportFormat.ts`, `payExport.ts`), the outbox (`outbox.ts`), venues, learning, recruitment, search, digest, attention and more |
| `shared/src/types.ts`, `shared/src/types/` | Every type the API sends or receives; the contract between server and client |
| `shared/src/constants.ts` | Labels, benchmarks, limits, brand details |

**If a rule decides money, dates or who may do what, it belongs in `shared/` with a test,** and the server and client
both call it. Do not work out pay in a route or a screen.

### server/ — the API and everything that runs on the server

| Where | What |
| --- | --- |
| `server/src/index.ts` | Start-up: settings, the app key check, schema upgrades, background jobs, backups, the HTTP(S) listener |
| `server/src/app.ts` | The Express app: security headers and CSP, compression, the response cache, the audit middleware, every router (`mount('/…')`), static files |
| `server/src/routes/` | One router per area (`gauges.ts`, `pay.ts`, `payments.ts`, `users.ts`, …). Validation with Zod at the top of each handler |
| `server/src/middleware/` | `auth.ts` (sessions, `requireAuth`, `requireRole`), `clientGuard.ts` (client accounts see only their portal), `writeLimit.ts` |
| `server/src/lib/` | Everything the routes share: `scope.ts` (what each role may see, redaction), `pay.ts`, `payRule.ts`, `invoices.ts`, `markPaid.ts`, `payments/` (connections, providers, batches, bank files, the step-up code check `code.ts`), `statements/`, `videos/`, `backup.ts`, `crypto.ts` (the app key, AES-256-GCM), `pin.ts`, `twofactor.ts`, `audit.ts` and `audit/` (the audit trail), `attention/` (Needs attention providers), `cache.ts`, `dates.ts` (`businessNow`) |
| `server/src/db/connection.ts` | `node:sqlite` with small helpers: `get`, `all`, `run`, `transaction` |
| `server/src/db/schema.ts` | The core tables, and `createSchema`, which runs on every start |
| `server/src/db/extensions/` | Every later table and column, one file per area (see §4.1) |
| `server/src/db/seed.ts`, `seed-data.ts` | The demo company (invented people only) |
| `server/src/*.ts` (top level) | The npm commands: `backup.ts`, `restore.ts`, `doctor.ts`, `service.ts`, `update.ts` (`npm run latest`), `smoke.ts`, `pinReset.ts`, `twoFactorReset.ts`, and the 1.5 `golive`, `setup-code`, `key:restore` and `recovery-sheet` commands |
| `server/src/test/` | Route tests (`helpers.ts` starts a real server on a temporary database), contract tests, upgrade tests |

### client/ — the screens

| Where | What |
| --- | --- |
| `client/src/App.tsx` | Routes and the role gates |
| `client/src/pages/` | One file per page |
| `client/src/features/<area>/` | The components and hooks of each area |
| `client/src/components/ui/`, `layout/`, `charts/` | The UI kit, the app shell and navigation, chart wrappers |
| `client/src/api/` | The fetch wrapper (`ApiError`) and TanStack Query hooks |
| `client/src/content/` | Words shown on screen: copy, help text, the About page |
| `client/sw/`, `client/build/` | The service worker and the Vite plugin that builds it |

Styling uses the semantic tokens in `client/src/index.css` (`bg-surface`, `text-muted`, …), never raw colours; both
themes must work. Money is shown with `formatGBP()`.

## 4. Adding a feature

Work in this order. Each step has a test that holds the next person to it.

### 4.1 Database: an extension

New tables and columns go in **`server/src/db/extensions/<area>.ts`**, exporting
`export const extension: DbExtension = { name, sql, upgrade, seed? }`, listed in `server/src/db/extensions/index.ts`. The
full rules are at the top of `server/src/db/extensions/types.ts`; the short version:

- `sql`: `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` only. Runs on every start.
- `upgrade(db)`: columns added to existing tables with `addColumnIfMissing`, and one-off data steps guarded by a
  `meta` key so they run once. It must be safe to run again (a second run returns `[]`), and every new column is
  nullable or has a default. Since 1.5 all upgrades run inside one transaction: a failure leaves the database as it
  was.
- `seed(db, ctx)`: demo rows for a fresh demo only, using `ctx.rng`, `ctx.today` and invented people.
- **Write a test that upgrades a database of the previous release's shape** (create the old tables, put rows in, run
  `createSchema`, check the rows and the new columns), and one that runs the upgrade twice. Customers upgrade real
  databases in place; there is no "drop and re-create".
- Never rename or drop a column; never change what an old column means.

### 4.2 Rules: shared/

Add the rule as a pure function in `shared/src/logic/`, export it from `shared/src/logic/index.ts`, and test it in a
`.test.ts` beside it (worked examples, edges, rounding in pence). Types the API sends go in `shared/src/types*`.

### 4.3 The route

- A router in `server/src/routes/`, mounted in `server/src/app.ts` with `requireAuth` (and `requireRole(...)` where
  only some roles may use it). A router that shares a prefix with an older one is mounted **before** it.
- Validate the body with Zod. Answer errors in plain words (`{ error: '…' }`), with the right status.
- Use `scope.ts` for what each role may see. Never send secrets, bank numbers, codes or keys back.
- Sensitive actions (anything about money, bank details, setup codes or someone else's sign-in) need the caller's
  fresh two-step code: `assertFreshCode(db, me, req.body.code, codeSource(req), { required: true })` from
  `lib/payments/code.ts`. Money and secret routes also refuse insecure requests from other devices
  (`isSecureRequest(req)` in `server/src/lib/secureRequest.ts`).
- Business time comes from `businessNow()` (`lib/dates.ts`); real-clock times only for sessions, rate limits, codes
  and payment providers.
- Writes that should appear instantly elsewhere must clear the response cache (`lib/cache.ts`).

### 4.4 The audit trail

Every write route needs an **audit spec**: an entry in the area's file in `server/src/lib/audit/<area>Specs.ts`
(listed in `lib/audit/registry.ts`) saying which record it changes, how to load a small before/after snapshot, and the
sentence to show. `server/src/test/audit-coverage.test.ts` fails for any POST, PUT, PATCH or DELETE without one (or a
deliberate `skip: true`). Snapshots never hold secrets.

### 4.5 Needs attention (the bell)

A new kind of item for the dashboard's **Needs attention** box and the bell is a provider in
`server/src/lib/attention/<name>.ts` implementing `AttentionProvider` (`lib/attention/types.ts`), listed in
`lib/attention/index.ts`. Each provider returns only what the caller may see, from **one** SQL statement per call:
`attention.test.ts` holds every role's whole feed to a statement budget. Keys are stable and start with the kind
(`payments:failed:12`), so a resolved item disappears and "seen" sticks. Add the kind to `AttentionKind` in
`shared/src/types.ts`.

### 4.6 Tests for the route

Route tests in `server/src/test/` use `startTestServer()` from `helpers.ts` (a real server on a temporary database)
and sign in as each role. For every new route, test **every role** (owner/admin, leader, rep, recruiter, client) and
anonymous: what each may do and what each is refused. Fix a bug by first writing the test that shows it.

### 4.7 The screen

A page in `client/src/pages/`, its parts in `client/src/features/<area>/`, a hook in `client/src/api/`, a route in
`App.tsx` and, if it needs one, a navigation entry. Check it at 360–390 px and at laptop width, in light and dark, with
the keyboard. Words go in plain UK English, short sentences, no jargon (see `client/src/content/`).

### 4.8 The docs

Each change says what it means for users (`docs/USER_GUIDE.md`), the owner (owner notes), developers (`API.md`,
`LOGIC.md`) and the changelog. When several people or agents work in parallel, each writes
`docs/fragments/<release>-<package>.md` and the release step folds them in.

## 5. Running it

| Command (in `linear-micro-crm/`) | What |
| --- | --- |
| `npm run dev` | Development: server with reload, Vite with hot reload |
| `npm start` | Production mode on this machine (builds first when needed) |
| `npm run doctor` | Checks Node, the settings, the app key, backups and off-site copies, and boots a temporary server |
| `npm run backup` / `backups` / `restore -- <file>` | Backups (checked; with uploaded files; an encrypted `.lhbk` when `LM_OFFSITE_DIR` is set) |
| `npm run seed` | A fresh demo database (refuses a live one or one with your own people) |
| `npm run golive` | Ends the trial on a database |
| `npm run latest` | Update this checkout: backs up first, pulls, installs, builds |
| `npm run service:install` | Run in the background on a Mac or a Linux desktop (the VPS uses its own system service instead) |

On the production server, the same jobs go through `sudo linear-hub <job>`, which runs them as the `linear` user with
the server's settings and stops the service around the ones that need the database to themselves
([`DEPLOY.md`](DEPLOY.md) §5).

## 6. Releases and upgrades

1. **Version.** One version for the whole app: `package.json` in the top folder, `shared/`, `server/` and `client/`,
   and `APP_VERSION` in `client/src/content/about.ts`. The server reports it at `/api/health`.
2. **Changelog.** `CHANGELOG.md`, newest first, written for the owner (Added / Changed / Fixed).
3. **Checks.** The five commands in §2, green in CI.
4. **Tag.** Tag the release commit (`v1.5.0`). The server installs a tag and moves between tags with
   `sudo linear-hub update v1.5.1`.
5. **Upgrading a customer's database.** Happens by itself at the first start of the new version: `createSchema` runs
   every extension's `sql` and `upgrade` in one transaction, and the start-up log says what changed ("Upgraded schema:
   added …"). `npm run latest` and `linear-hub update` back up and check the database before anything changes, and
   print the way back (`git checkout <previous>`, `npm run setup`, `npm run restore -- <backup>`).
6. **Before telling the customer**, upgrade a copy of a real-shaped database (an older release's demo, or the
   previous backup) and start it.

## 7. Keys, secrets and data you must never lose or leak

- The **app key** (`LM_APP_SECRET_FILE`, or `LM_APP_SECRET`) encrypts bank details, payment keys and tokens, two-step
  secrets and the Gmail password, and peppers PINs. Without it they are gone for good. The server refuses to start with
  a missing or wrong key (exit code 78) and says how to put it back (`npm run key:restore`). The owner keeps it on the
  printed recovery sheet.
- The **off-site passphrase** (`LM_BACKUP_PASSPHRASE_FILE`) locks the off-site copies. It is on separate paper.
- Never commit `server/data/` (databases, keys, backups, uploads), `.env` files, real people's names, emails, phone
  numbers or bank details: the demo uses invented people and `@linearhub.example` addresses. Never log, audit, export
  or return secrets or full bank numbers.

## 8. Reading the code's history comments

Many files start with comments such as "Release 1.3 — OWNED BY P8" or "r3-foundation". They record which **work
package** of which release wrote the code, not a person and not who owns it now:

| Code | Release | Package |
| --- | --- | --- |
| `p2`–`p9` | 1.1 (the smart features) | p2 personal pace and streaks, p3 pay estimate and payroll checks, p4 leader check-ins and coaching, p5 Needs attention, p6 event forecasts and rosters, p7 saves that wait for signal (the outbox), p9 the weekly review |
| `r2-foundation`, `L1`, `L2`, `U1`–`U5` | 1.2 | foundation; L1 learning pack, L2 pitch studio; U1 PIN, U2 bulk gauge entry, U3 audit trail, U4 shift check-ins, U5 search and payroll export |
| `r3-foundation`, `P1`–`P9` | 1.3 | foundation; P1 pay rule, P2 invoices, P3 statements, P4 PDFs, P5 videos, P6 client accounts, P7 recruitment, P8 venues, P9 audit of everything |
| `F`, `P`, `A`, `S` | 1.4 | F payments foundation, P bank payment files, A API connections (Revolut, Wise, TrueLayer), S security (two-step for everyone) |
| access, keys, money, phone, docs, quality | 1.5 | sign-in and trial mode; app key and backups; money controls; phone app; docs and installer; CI and dependencies |

"Owned by the Product Designer" and similar role names in older comments come from an earlier, wrong description of
the team; they mean nothing. The [`ROADMAP.md`](ROADMAP.md) has an item to remove these comments; until then, read
them as dates.

## 9. Known limits

- **One process, synchronous SQLite.** 430 to 800 requests a second on one core in the load tests
  ([`LOAD_TEST.md`](LOAD_TEST.md)), far above Linear MCR's needs. It cannot run as two copies. A move to Postgres would
  mean a new data layer (around 700 synchronous calls in about 90 server files, with SQLite-only SQL): weeks of work,
  only worth it for several offices or hundreds of people at once ([`ROADMAP.md`](ROADMAP.md)).
- **`node:sqlite` is still marked experimental by Node.** Linear Hub pins the Node lines it is tested on (22.18+, 24,
  26) and `npm run doctor` reports the Node and SQLite versions. Test a new Node line before moving a server to it.
- **No browser tests in CI yet.** The screens are checked by scripted browser runs while building, not on every
  change (on the roadmap).
- **Outside services not yet tried for real:** Revolut, Wise and TrueLayer were built to their published APIs and
  tested against local stand-ins; the bank file layouts follow the banks' guides but were never uploaded; the statement
  reader was built on sample statements. Each has a guided first real run (see the owner notes).
- **PDFs are made on the device**, with a font that covers Western European letters only.
- **UK only:** pounds, UK dates, Europe/London business time, UK English.

## 10. Who to ask

Noryn System Ltd, hq@norynsystem.com. Security problems: security@norynsystem.com.
