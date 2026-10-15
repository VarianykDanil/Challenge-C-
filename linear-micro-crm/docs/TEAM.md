# The squad

Linear Hub was built by five people working in parallel on one repository. Each owns a slice of the codebase, agreed up front in [`TEAM_CONTRACT.md`](TEAM_CONTRACT.md); nobody edits another member's files without asking, and an integrator merges the slices and resolves conflicts.

| # | Name | Role | Slice |
|---|---|---|---|
| 1 | **Tomasz Nowak** | Backend Developer | API, database, seed data, auth and role rules |
| 2 | **Aisha Rahman** | Frontend Developer | Pages, data hooks, routing, auth flow |
| 3 | **Callum Reid** | Product Designer (Brand & UI) | Design tokens, themes, UI kit, app shell, sign-in |
| 4 | **Mei-Ling Chen** | Logic Builder (Data & Charts) | Funnel and payroll logic, benchmarks, charts |
| 5 | **Sophie Whitfield** | Marketing & Content | Product story, microcopy, user guide, pitch, About page |

---

## Tomasz Nowak — Backend Developer

**Responsibilities.** Implements the API contract in [`API.md`](API.md) exactly: Express 5 routes, Zod validation, the httpOnly session cookie, and role enforcement on every endpoint (reps see their own data, leaders their team, admins everything). Owns the SQLite schema behind `node:sqlite`, the deterministic 26-week seed that gives every fresh install the same sample teams, campaigns, events, gauges, candidates and pay runs, and the smoke test that checks the running server against the contract. Serves the built client in production.

**Owns.** `server/**`, `docs/API.md` (implements it exactly; may append notes).

## Aisha Rahman — Frontend Developer

**Responsibilities.** Builds every route page except the sign-in and About pages: dashboard, events, gauges, leaderboard, recruitment, finance, campaigns, team and settings. Owns the data layer — the `fetch` wrapper that throws `ApiError`, the TanStack Query hooks per endpoint, and `AuthProvider` / `useAuth()` — plus routing and the auth gate in `App.tsx`. The gauge-entry form with live funnel validation is hers, as are the formatting helpers (`formatGBP`, dates).

**Owns.** `client/src/pages/**` (except `Login.tsx` and `About.tsx`), `client/src/api/**`, `client/src/auth/**`, `client/src/lib/**`, `client/src/App.tsx`, `client/src/main.tsx`.

## Callum Reid — Product Designer (Brand & UI)

**Responsibilities.** Defines the semantic design tokens (`bg-surface`, `text-fg`, `text-muted`, `bg-primary`, chart colours and the rest) so that light and dark themes both work from one set of class names and nobody hard-codes a colour. Builds the UI kit (`Button`, `Card`, `Badge`, `Avatar`, `DataTable`, `Modal`, `Tabs`, `KpiTile`, `PageHeader`, `Toast` and friends), the `AppShell` with role-filtered navigation, the Linear MCR logo mark and wordmark, and the sign-in page. Keeps accessibility honest: keyboard reach, labelled inputs, visible focus, colour never the only signal.

**Owns.** `client/src/index.css`, `client/index.html`, `client/public/**`, `client/src/components/ui/**`, `client/src/components/layout/**`, `client/src/components/brand/**`, `client/src/pages/Login.tsx`, `docs/DESIGN.md`.

## Mei-Ling Chen — Logic Builder (Data & Charts)

**Responsibilities.** Writes the pure business logic shared by server and client so the numbers always agree: `funnelRatios`, `validateGaugeFunnel` (each stage ≤ the previous), `calculatePayroll` (base per day, commission, weekly bonus, leader overrides, deductions), `isPaidOnTime` and `isCheckInOnTime` with the five-minute grace period. Owns the company benchmark ratios — the law of averages — and the brand constants, the Recharts wrappers (funnel, trend, bars, donut, sparkline) that consume the chart tokens, and the tests that keep all of it true.

**Owns.** `shared/src/logic/**`, `shared/src/constants.ts`, `client/src/components/charts/**`, `docs/LOGIC.md`.

## Sophie Whitfield — Marketing & Content

**Responsibilities.** Owns the words. The product story and positioning, every piece of user-facing microcopy (page descriptions, empty states, gauge help, greetings, motivation lines) in `client/src/content/`, the About page, the README, this file, the business case for Linear MCR's owner, the user guide per role and the roadmap. Keeps everything in British English, specific and free of hype.

**Owns.** `README.md`, `docs/TEAM.md`, `docs/PITCH.md`, `docs/USER_GUIDE.md`, `docs/ROADMAP.md`, `client/src/content/**`, `client/src/pages/About.tsx`.

---

## Shared and frozen

`shared/src/types.ts` is the contract between all five slices. Existing fields are frozen; anyone may add an **optional** field, and must say so when they do.

## How we worked

We agreed the contracts first and the code second. Before anyone wrote a feature, the API (`API.md`), the shared types, the UI kit prop names, the chart component props, the layout shell and the auth hook were all pinned down in writing, so each of us could build against a stable interface rather than against each other's half-finished work. From there the five slices were built in parallel: the backend implemented the contract against a deterministic seed; the frontend built pages against the typed hooks; the designer shipped tokens and the kit that pages compose; the logic builder kept the maths pure and tested; and content filled every string from one place. The integrator pulled the slices together, ran `npm run typecheck`, `npm run build` and the server smoke test, checked both themes, and resolved the handful of conflicts that come from five people touching one repo. The definition of done was the same for everyone: typecheck and build pass from the root, the smoke test passes, both themes look right, no console errors.
