# Linear Hub

**Every stop counts.** The team platform for Linear MCR Limited: every rep sees their own gauges, pay and progression; leaders see their teams; the office sees recruitment and finance — all behind one sign-in with a work email and employee ID.

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
| **Dashboard** | Your week at a glance: sales, stops, conversion and the change since last period; your rank; earnings to date and next payday; punctuality; upcoming events; announcements. Leaders and admins also see team and company panels. |
| **Events & Gauges** | Leaders create events against a campaign (venue, date, times, target). Reps log their six gauges per event in under a minute; the funnel rule (each stage ≤ the previous) is enforced as you type. Every entry rolls up by rep, team, campaign, day and week. |
| **Leaderboard** | Top performers by sales or conversion for the week, month or quarter, with movement against the previous period and a team filter. |
| **Recruitment** | A pipeline from Applied → Phone screen → Interview → Observation day → Offer → Hired, with interviews, owners, sources, ratings, next actions and overdue flags. Moving a candidate to *Hired* creates their employee record. |
| **Finance & Pay** | Weekly pay runs itemised against the pay plan (base per day, commission per sale, weekly bonus, leader overrides, deductions). Payslips for everyone; on-time rate and late-payment tracking; expenses and campaign margin for the office. |
| **Team** | The directory: who is on which team, their position on the ladder (Trainee → Field Rep → Team Leader → Crew Leader → Assistant Owner → Owner), and a performance view per person. |
| **Campaigns** | The clients Linear represents, with sector, type, payout per sale, default rep commission and live/paused status. |

### Roles

| Role | Sees | Can change |
|---|---|---|
| `rep` | Own gauges, own pay, own team's events and leaderboard, the directory | Own gauges for own team's events |
| `leader` | Everything a rep sees, plus full team gauges and payroll summary, and recruitment | Gauges for team members, events for own team, candidate stages, announcements |
| `recruiter` | Directory, the whole recruitment pipeline, own pay | Candidates, interviews, stage changes |
| `admin` | Everything | Everything — users, campaigns, events, payroll payments, expenses |

---

## Screenshots

| | |
|---|---|
| ![Sign in](docs/screenshots/login.png) | ![Dashboard](docs/screenshots/dashboard.png) |
| ![Events and gauges](docs/screenshots/events.png) | ![Recruitment pipeline](docs/screenshots/recruitment.png) |
| ![Finance and pay](docs/screenshots/finance.png) | |

---

## Quick start

Requires **Node.js ≥ 22.13** (the server uses the built-in `node:sqlite`, so there is nothing else to install).

```bash
npm install
npm run dev
```

- Client: <http://localhost:5173> (Vite dev server, proxies `/api` to the server)
- API: <http://localhost:4000>

The database is created and seeded automatically on first start. Other useful commands:

| Command | What it does |
|---|---|
| `npm run seed` | Reset the database to fresh sample data |
| `npm run build` | Typecheck and build the client into `client/dist` |
| `npm start` | Serve the API **and** the built client on <http://localhost:4000> |
| `npm run typecheck` | Typecheck `shared`, `server` and `client` |
| `npm test` | Run the shared domain-logic tests |
| `npm run smoke -w server` | Server smoke test against the API contract |

### Demo accounts

Sign in with the email and employee ID. Matching is case-insensitive. The sign-in page also has one-click buttons for each of these.

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

- **`client`** — React 19, Vite 6, Tailwind CSS v4 (semantic design tokens, light and dark themes), TanStack Query 5, React Router 7, Recharts, lucide-react.
- **`server`** — Express 5 with SQLite through `node:sqlite` (no native build step), Zod validation, httpOnly session cookie. Seeds deterministic sample data on first run and serves the built client in production.
- **`shared`** — `@lm/shared`: the domain types, brand constants, benchmark ratios and pure business logic (funnel ratios and validation, payroll calculation, punctuality) used by both sides so the numbers always agree.

The API contract is in [`docs/API.md`](docs/API.md). Design tokens and the UI kit are described in `docs/DESIGN.md`; the maths behind ratios, payroll and charts in `docs/LOGIC.md`.

```
linear-micro-crm/
├── client/                      # React 19 + Vite + Tailwind v4 (dev on :5173)
│   ├── index.html
│   ├── public/
│   └── src/
│       ├── api/                 # fetch wrapper + TanStack Query hooks
│       ├── auth/                # AuthProvider, useAuth()
│       ├── components/
│       │   ├── brand/           # Logo
│       │   ├── charts/          # Funnel, Trend, Bars, Donut, Sparkline (Recharts)
│       │   ├── layout/          # AppShell, navigation
│       │   └── ui/              # Button, Card, Badge, DataTable, Modal, …
│       ├── content/             # copy.ts, team.ts, about.ts — all microcopy
│       ├── lib/                 # formatGBP and other helpers
│       └── pages/               # one file per route
├── server/                      # Express 5 + node:sqlite (:4000)
│   ├── data/                    # linear.sqlite (generated, git-ignored)
│   └── src/
├── shared/                      # @lm/shared — types, constants, pure logic
│   └── src/
│       ├── types.ts
│       ├── constants.ts
│       └── logic/
├── docs/                        # API, TEAM_CONTRACT, DESIGN, LOGIC, TEAM, PITCH, USER_GUIDE, ROADMAP
└── package.json                 # npm workspaces + root scripts
```

---

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — step-by-step for reps, leaders, recruiters and admins
- [`docs/PITCH.md`](docs/PITCH.md) — the business case and rollout plan for Linear MCR
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what comes next
- [`docs/API.md`](docs/API.md) — the API contract
- [`docs/TEAM.md`](docs/TEAM.md) and [`docs/TEAM_CONTRACT.md`](docs/TEAM_CONTRACT.md) — who built it and how

---

## Built by

A five-person squad, each owning one slice of the codebase, merged by an integrator (see [`docs/TEAM.md`](docs/TEAM.md)):

| Name | Role | Slice |
|---|---|---|
| **Tomasz Nowak** | Backend Developer | API, database, seed data, auth and role rules |
| **Aisha Rahman** | Frontend Developer | Pages, data hooks, routing, auth flow |
| **Callum Reid** | Product Designer (Brand & UI) | Design tokens, themes, UI kit, app shell, sign-in |
| **Mei-Ling Chen** | Logic Builder (Data & Charts) | Funnel and payroll logic, benchmarks, charts |
| **Sophie Whitfield** | Marketing & Content | Product story, microcopy, user guide, pitch, About page |

---

## A note on the data

All sample data is **illustrative**. People, candidates, events, gauges, pay runs and expenses are generated deterministically for the last 26 weeks so that every fresh install looks the same and every chart has something to show. The demo names are not real employees, and the figures are not Linear MCR's actual results. Facts about the company itself (what it does, where it is registered, how its ladder works) come from public sources.

---

© Linear MCR Limited — internal use.
