# Linear Hub

**Every stop counts.** The team platform for Linear MCR Limited: every rep sees their own gauges, pay and progression and their team's board; leaders read the whole company and run their own team; the recruiter runs the pipeline; the office sees finance — all behind one sign-in with a work email and employee ID.

> Linear MCR runs face-to-face sales campaigns — B2B, B2C, private-site events and charity fundraising — from Manchester. The six gauges a rep records at every event (stops → to table → presentations → closes → taps → sales) are the heartbeat of the business. Linear Hub is built around them.

---

## Why

Today the business has no CRM, and it shows in small ways every day:

- **Gauges live on paper and in WhatsApp.** Leaders collect six numbers from each rep at the end of each event, retype them, and tally them by hand. Nobody can see a ratio until someone works it out.
- **Coaching starts from a hunch.** Without stage-by-stage ratios against the law of averages, it is hard to say *which* part of the pitch a rep should work on.
- **Recruitment is tracked ad hoc.** Candidates move from applied to observation day to hired in notes and messages; nobody knows the conversion by source or how long a hire takes.
- **Pay and punctuality questions take time to answer.** "What am I being paid this week, and when?" and "Was I paid late?" should be a glance, not a phone call.

Linear Hub fixes those four things without asking the business to change how it works. The gauges are the same six. The benchmarks are the company's own. The pay plan is the one already on the wall.

---

## What it does

| Area | What you get |
|---|---|
| **Dashboard** | Your period at a glance (**This week / This month / This quarter**): sales, stops and conversion with the change against the same days of the previous period; your rank; earnings to date and next payday (red when overdue); punctuality; your trend and funnel with coaching notes; your team's top five; upcoming events; announcements. Leaders and administrators also get a **Company** section; recruiters get a recruitment-first dashboard. |
| **Events & Gauges** | Leaders schedule events for their team against a campaign (venue, date, times, sales target); statuses roll forward by themselves (today's events go **Live** at their start time). Reps **Log gauges** for an event in under a minute: the date is the event's date, the event must be today or earlier and not cancelled, and the funnel rule (each stage ≤ the previous) is checked as you type. Everything rolls up by person, team, campaign, day and week. |
| **Leaderboard** | Everyone who logged sales, ranked by **Sales** or **Conversion** for the week, month or quarter, with movement against the same days of the previous period. Reps see their own team; everyone else can filter by team. |
| **Recruitment** | A board from Applied → Phone screen → Interview → Observation day → Offer → Hired, with interviews, owners, sources, ratings, next actions and overdue flags. Hiring asks for the **Team** and **Position** (Trainee or Field Representative) and creates the rep's account on the spot. |
| **Finance & Pay** | **My pay** for everyone: twelve weeks of itemised payslips (base per day, commission, bonus, leader overrides, deductions) and the next payday. **Team pay** for leaders. **Company** for administrators: revenue, payroll, expenses and profit per pay week, **Runs to pay** with one-click **Mark paid**, payroll punctuality, expenses and margin by campaign. |
| **Team** | The directory: who is on which team, their position on the ladder (Trainee → Field Representative → Team Leader → Crew Leader → Assistant Owner → Owner, plus the office **Recruiter** position), and a performance view per person. |
| **Campaigns** | The clients Linear represents, with sector, type, payout per sale, default rep commission and active/inactive status. |
| **Public page** | Signed-out visitors land on an outward-facing page about Linear MCR and Linear Hub (what we do, the six gauges, the careers ladder) with **Sign in**; staff can review it any time at `/welcome`. The logo and colours come from one config (`client/src/content/brand.ts` and the `--brand-*` block in `client/src/index.css`). |
| **Export & print** | Every table has **Download as CSV** (Excel-ready, exactly the rows on screen, filters in the file name), and each payslip has **Print payslip** for a clean A4 copy. |

### Roles

| Role | Sees | Can change |
|---|---|---|
| `rep` | Own gauges and pay; own team's events, leaderboard and gauges summary; the directory; any event or profile **read-only** (other people's check-in times and notes are hidden) | Own gauges, at own team's events |
| `leader` | Company-wide reads — every team's events, the full leaderboard, any profile — plus the check-in times and notes of their own team, their own team's payroll, and recruitment | Events for own team; gauges for own team's members at own team's events; candidates, interviews and stage changes; announcements |
| `recruiter` | The whole recruitment pipeline, the directory, own pay; events and the leaderboard read-only | Candidates, interviews, stage changes (hiring creates the rep's account) |
| `admin` | Everything, including every employee ID | Everything — people, campaigns, events, any gauges, payroll payments, expenses, announcements |

**Signing in and security, honestly.** Sign-in is a work email plus an employee ID — there is no password yet, so the employee ID is half of the credential and the API only returns it to administrators and to the person themselves (everyone else sees it blank on the Team page, payslips and profiles). Sessions are httpOnly cookies that last 14 days; after eight failed attempts for the same email in fifteen minutes the login is paused for that window; setting a person's status to **Left** deletes their sessions at once, so they are signed out everywhere. A sign-in PIN and single sign-on are on the [roadmap](docs/ROADMAP.md).

---

## Screenshots

| | |
|---|---|
| ![Sign in](docs/screenshots/login.png) *Sign in — work email and employee ID, with demo accounts on a demo database* | ![Dashboard](docs/screenshots/dashboard.png) *Dashboard — the period at a glance, with coaching from the funnel* |
| ![Dashboard, dark theme](docs/screenshots/dashboard-dark.png) *The same dashboard in the dark theme* | ![Events](docs/screenshots/events.png) *Events — today first, then what is coming, then last week under "Earlier"* |
| ![Gauges](docs/screenshots/gauges.png) *Gauges — ratios tinted against the law of averages* | ![Leaderboard](docs/screenshots/leaderboard.png) *Leaderboard — podium, movement and "You're #N of M"* |
| ![Recruitment](docs/screenshots/recruitment.png) *Recruitment — the board from Applied to Hired* | ![Finance](docs/screenshots/finance.png) *Finance — pay runs, Runs to pay and payroll punctuality* |
| ![Team](docs/screenshots/team.png) *Team — the directory by team, position and status* | |

---

## Quick start

Requires **Node.js ≥ 22.13** (`.nvmrc` says `22`). The server uses the built-in `node:sqlite`, so there is nothing else to install.

```bash
npm install
npm run dev
```

- Client: <http://localhost:5173> (Vite dev server; proxies `/api` to the server)
- API: <http://localhost:4000>

The database is created and seeded automatically on first start. Production build on one port:

```bash
npm run build && npm start      # API + built client on http://localhost:4000
```

### Scripts

Every command below exists in `package.json` (root) or `server/package.json`.

| Command | What it does |
|---|---|
| `npm run dev` | Server (`tsx watch`, `TZ=Europe/London`) and client (Vite) together |
| `npm run build` | Typecheck and build the client into `client/dist` |
| `npm start` | Serve the API **and** the built client on <http://localhost:4000> (`NODE_ENV=production`) |
| `npm run seed` | Delete and rebuild the database with fresh sample data |
| `npm run typecheck` | Typecheck `shared`, `server` and `client` |
| `npm test` | Run the shared domain-logic tests (`node:test`) |
| `npm run smoke -w server` | Boot the API on a temporary seeded database and exercise every endpoint against the contract |

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Port the API (and, in production, the client) listens on |
| `DB_PATH` | `server/data/linear.sqlite` | Where the SQLite file lives; the directory is created if needed |
| `LM_DEMO_ACCOUNTS` | unset | Set to `0` on any deployment with real users: the sign-in page then shows no demo accounts and the API never publishes a login |
| `COOKIE_SECURE` | unset | Set to `1` to force the `Secure` flag on the session cookie; it is set automatically when the request arrived over HTTPS (`X-Forwarded-Proto: https`, `trust proxy` is on) |
| `TZ` | `Europe/London` | The business time zone — "today" for events and pay weeks. The npm scripts and the Dockerfile pin it; keep it if you run the server another way |
| `NODE_ENV` | — | `production` makes the server serve `client/dist`; `npm start` sets it |

### Docker

```bash
docker build -t linear-hub .
docker run -p 4000:4000 -v linear-data:/app/server/data linear-hub
```

The image builds the client, installs production dependencies only, sets `TZ=Europe/London`, exposes port 4000 and keeps the database in the `/app/server/data` volume. Add `-e LM_DEMO_ACCOUNTS=0` when the database holds real people.

### Demo accounts

Sign in with the email and employee ID (matching is case-insensitive). On a freshly seeded database the sign-in page also has one-click buttons for these four.

| Role | Name | Email | Employee ID |
|---|---|---|---|
| admin | Danil Varianyk (Owner) | danil@linear-mcr.co.uk | LM-0001 |
| leader | Amelia Hart (Crew Leader) | amelia.hart@linear-mcr.co.uk | LM-0002 |
| recruiter | Priya Shah (Recruiter) | priya.shah@linear-mcr.co.uk | LM-0003 |
| rep | Jordan Lee (Field Rep) | jordan.lee@linear-mcr.co.uk | LM-0010 |

Sample teams: Northern Lights, Deansgate, Spinningfields, Ancoats. Sample campaigns: Breast Cancer Now (fundraising, private sites), Children's Hospice North (fundraising, events), Volt Energy (B2B), FibreCity Broadband (residential).

---

## Architecture

Three npm workspaces in one repository, all TypeScript (strict, ESM):

- **`client`** — React 19, Vite 6, Tailwind CSS v4 (semantic design tokens, light and dark themes), TanStack Query 5, React Router 7, Recharts, lucide-react. Pages compose domain components from `src/features/**`, the UI kit from `src/components/ui`, and charts from `src/components/charts`.
- **`server`** — Express 5 with SQLite through `node:sqlite` (no native build step), Zod validation, httpOnly session cookie, role rules and employee-ID redaction in `src/lib/scope.ts`, pay rules in `src/lib/pay.ts`. Seeds deterministic sample data on first run, materialises weekly payroll runs and rolls event statuses forward (`src/db/maintenance.ts`), and serves the built client in production.
- **`shared`** — `@lm/shared`: the domain types, brand constants, benchmark ratios and pure business logic (funnel ratios and validation, payroll calculation, paydays, punctuality, ranking, coaching insights) used by both sides so the numbers always agree.

The API contract is in [`docs/API.md`](docs/API.md). Design tokens and the UI kit are described in [`docs/DESIGN.md`](docs/DESIGN.md); the maths behind ratios, payroll and charts in [`docs/LOGIC.md`](docs/LOGIC.md).

```
linear-micro-crm/
├── client/                          # React 19 + Vite 6 + Tailwind v4 (dev on :5173)
│   ├── index.html
│   ├── public/                      # favicon, logo
│   └── src/
│       ├── api/                     # fetch wrapper (client.ts) + TanStack Query hooks (hooks.ts)
│       ├── auth/                    # AuthProvider, RequireAuth, RequireRole
│       ├── components/
│       │   ├── brand/               # Logo
│       │   ├── charts/              # Funnel, Trend, Bars, Donut, Sparkline (Recharts)
│       │   ├── layout/              # AppShell, Sidebar, Topbar, nav.ts, theme
│       │   └── ui/                  # Button, Card, Badge, DataTable, Modal, Tabs, Stepper, …
│       ├── content/                 # copy.ts, about.ts, team.ts — all microcopy
│       ├── features/                # the bulk of the UI, by domain
│       │   ├── campaigns/           #   campaign form
│       │   ├── common/              #   range picker, status badges, confirm dialog, loading/error states
│       │   ├── dashboard/           #   announcements, company section, recruiter section, upcoming events
│       │   ├── events/              #   event form, event row
│       │   ├── finance/             #   payroll runs table, payslip, add expense
│       │   ├── gauges/              #   Log gauges modal, summary and entries tables, performance panel, coaching
│       │   ├── recruitment/         #   candidate card, "Move to…" control, schedule interview, stage stepper
│       │   └── team/                #   user form
│       ├── lib/                     # formatGBP, dates, labels, ratios
│       └── pages/                   # one file per route
├── server/                          # Express 5 + node:sqlite (:4000)
│   ├── data/                        # linear.sqlite (generated, git-ignored)
│   └── src/
│       ├── app.ts                   # Express app factory (routes, static client in production)
│       ├── index.ts                 # bootstrap: open DB, seed, maintenance timers, listen
│       ├── db/                      # connection, schema, seed, seed-data, queries
│       │   └── maintenance.ts       # payroll materialisation, event status roll-forward
│       ├── lib/                     # dates, pay rules, metrics, scope (role rules + redaction), validation, errors
│       ├── middleware/              # session authentication
│       ├── routes/                  # one file per API area
│       └── smoke.ts                 # boots a temporary DB and exercises every endpoint
├── shared/                          # @lm/shared — types, constants, pure logic (+ node:test suites)
│   └── src/
│       ├── types.ts
│       ├── constants.ts
│       └── logic/
├── docs/                            # API, LOGIC, DESIGN, TEAM_CONTRACT, TEAM, PITCH, USER_GUIDE, ROADMAP, screenshots/
├── Dockerfile
└── package.json                     # npm workspaces + root scripts
```

---

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — step-by-step for reps, leaders, recruiters and administrators, using the app's own button and tab names
- [`docs/PITCH.md`](docs/PITCH.md) — the business case and rollout plan for Linear MCR
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what comes next
- [`docs/API.md`](docs/API.md) — the API contract and implementation notes
- [`docs/LOGIC.md`](docs/LOGIC.md) and [`docs/DESIGN.md`](docs/DESIGN.md) — the maths and the design system
- [`docs/TEAM.md`](docs/TEAM.md) and [`docs/TEAM_CONTRACT.md`](docs/TEAM_CONTRACT.md) — who built it and how

---

## Built by

A five-person squad, each owning one slice of the codebase, merged by an integrator (see [`docs/TEAM.md`](docs/TEAM.md)):

| Name | Role | Slice |
|---|---|---|
| **Tomasz Nowak** | Backend Developer | API, database and maintenance, seed data, auth, role rules and redaction, pay rules |
| **Aisha Rahman** | Frontend Developer | Pages, feature components, data hooks, routing, auth flow |
| **Callum Reid** | Product Designer (Brand & UI) | Design tokens, themes, UI kit, app shell, sign-in |
| **Mei-Ling Chen** | Logic Builder (Data & Charts) | Funnel and payroll logic, benchmarks, coaching insights, charts |
| **Sophie Whitfield** | Marketing & Content | Product story, microcopy, user guide, pitch, About page |

---

## A note on the data

All sample data is **illustrative**. People, candidates, events, gauges, pay runs and expenses are generated deterministically for the last 26 weeks — but anchored to the date the seed runs, so a fresh install always looks like "this week" and every chart has something to show. Regenerate it with `npm run seed`; the figures will differ from an earlier run only because the calendar has moved. The demo names are not real employees, and the figures are not Linear MCR's actual results. Facts about the company itself (what it does, where it is registered, how its ladder works) come from public sources.

---

© Linear MCR Limited — internal use.
