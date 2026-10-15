# The squad

Linear Hub was built by five people working in parallel on one repository. Each owns a slice of the codebase, agreed up front in [`TEAM_CONTRACT.md`](TEAM_CONTRACT.md); nobody edits another member's files without asking, and an integrator merges the slices and resolves conflicts.

| # | Name | Role | Slice | Owns |
|---|---|---|---|---|
| 1 | **Tomasz Nowak** | Backend Developer | API, database and maintenance, seed data, auth, role rules and redaction, pay rules | `server/**` — in particular `server/src/routes/**`, `server/src/middleware/**`, `server/src/lib/**`, `server/src/db/**` (schema, seed, maintenance), `server/src/smoke.ts`; `docs/API.md` |
| 2 | **Aisha Rahman** | Frontend Developer | Pages, feature components, data hooks, routing, auth flow | `client/src/pages/**` (except `Login.tsx`, `About.tsx`), `client/src/features/**`, `client/src/api/**`, `client/src/auth/**`, `client/src/lib/**`, `client/src/App.tsx`, `client/src/main.tsx` |
| 3 | **Callum Reid** | Product Designer (Brand & UI) | Design tokens, themes, UI kit, app shell, sign-in | `client/src/index.css`, `client/index.html`, `client/public/**`, `client/src/components/ui/**`, `client/src/components/layout/**`, `client/src/components/brand/**`, `client/src/pages/Login.tsx`, `docs/DESIGN.md` |
| 4 | **Mei-Ling Chen** | Logic Builder (Data & Charts) | Funnel and payroll logic, benchmarks, coaching insights, charts | `shared/src/logic/**`, `shared/src/constants.ts`, `client/src/components/charts/**`, `docs/LOGIC.md` |
| 5 | **Sophie Whitfield** | Marketing & Content | Product story, microcopy, user guide, pitch, About page | `README.md`, `docs/TEAM.md`, `docs/PITCH.md`, `docs/USER_GUIDE.md`, `docs/ROADMAP.md`, `client/src/content/**`, `client/src/pages/About.tsx` |

---

## Tomasz Nowak — Backend Developer

**Responsibilities.** Implements the API contract in [`API.md`](API.md) exactly and appends implementation notes where the contract leaves behaviour open: Express 5 routes, Zod validation, the httpOnly session cookie with its 14-day sessions, the login rate limit, and role enforcement on every endpoint — reps write only their own gauges at their own team's events, leaders write only for their own team, recruiters run recruitment, administrators do everything. Owns the redaction that blanks employee IDs and other people's check-in times and notes (`server/src/lib/scope.ts`), the pay rules shared by the seed, the live estimates and payroll materialisation (`server/src/lib/pay.ts`), and the maintenance jobs that create pending pay runs for closed weeks and roll event statuses forward (`server/src/db/maintenance.ts`). Owns the SQLite schema behind `node:sqlite`, the deterministic 26-week seed, and the smoke test that boots a temporary database and checks every endpoint.

**Owns.** `server/**` — routes, middleware, `server/src/lib/**`, `server/src/db/**`, `server/src/smoke.ts` — and `docs/API.md` (implements it exactly; may append notes).

## Aisha Rahman — Frontend Developer

**Responsibilities.** Builds every route page except the sign-in and About pages — dashboard, events and event detail, gauges, leaderboard, recruitment and candidate detail, finance, campaigns, team and profile, settings — and the domain components they compose from `client/src/features/**`: the **Log gauges** form with its live funnel validation and event-date rule, the payroll runs table and payslip, the recruitment board, the **Move to…** control and hire dialog, the event, campaign, candidate, expense and user forms, the range picker and the shared status badges. Owns the data layer — the `fetch` wrapper that throws `ApiError`, the TanStack Query hooks per endpoint, and `AuthProvider` / `useAuth()` — plus routing, the auth and role gates in `App.tsx`, and the formatting helpers (`formatGBP`, dates, labels).

**Owns.** `client/src/pages/**` (except `Login.tsx` and `About.tsx`), `client/src/features/**`, `client/src/api/**`, `client/src/auth/**`, `client/src/lib/**`, `client/src/App.tsx`, `client/src/main.tsx`.

## Callum Reid — Product Designer (Brand & UI)

**Responsibilities.** Defines the semantic design tokens (`bg-surface`, `text-fg`, `text-muted`, `bg-primary`, chart colours and the rest) so that light and dark themes both work from one set of class names and nobody hard-codes a colour. Builds the UI kit (`Button`, `Card`, `Badge`, `Avatar`, `DataTable`, `Modal`, `Tabs`, `SegmentedControl`, `Stepper`, `Switch`, `KpiTile`, `PageHeader`, `Toast` and friends), the `AppShell` with role-filtered navigation, the quick "Go to page…" search, the Linear MCR logo mark and wordmark, and the sign-in page. Keeps accessibility honest: keyboard reach, labelled inputs, visible focus, colour never the only signal.

**Owns.** `client/src/index.css`, `client/index.html`, `client/public/**`, `client/src/components/ui/**`, `client/src/components/layout/**`, `client/src/components/brand/**`, `client/src/pages/Login.tsx`, `docs/DESIGN.md`.

## Mei-Ling Chen — Logic Builder (Data & Charts)

**Responsibilities.** Writes the pure business logic shared by server and client so the numbers always agree: `funnelRatios`, `validateGaugeFunnel` (each stage ≤ the previous), `compareToBenchmark` and `performanceScore`, `calculatePayroll` (base per day, commission, weekly bonus, leader overrides, deductions), `paydayForWeek` and `payrollStatusFor`, `isCheckInOnTime` with the five-minute grace period, `rankRows` with shared ranks and movement, and `coachingInsights` — the sentences on the dashboard that turn a weak ratio into something to work on. Owns the company benchmark ratios (the law of averages) and the brand constants, the Recharts wrappers (funnel, trend, bars, donut, sparkline) that consume the chart tokens, and the `node:test` suites that keep all of it true.

**Owns.** `shared/src/logic/**`, `shared/src/constants.ts`, `client/src/components/charts/**`, `docs/LOGIC.md`.

## Sophie Whitfield — Marketing & Content

**Responsibilities.** Owns the words. The product story and positioning, every piece of user-facing microcopy (page descriptions, empty states, gauge help, greetings, motivation lines) in `client/src/content/`, the About page, the README, this file, the business case for Linear MCR's owner, the user guide per role and the roadmap. Keeps everything in British English, specific and free of hype — and true to the shipped product: every button, tab and rule in the user guide is checked against the client source.

**Owns.** `README.md`, `docs/TEAM.md`, `docs/PITCH.md`, `docs/USER_GUIDE.md`, `docs/ROADMAP.md`, `client/src/content/**`, `client/src/pages/About.tsx`.

---

## Shared and frozen

`shared/src/types.ts` is the contract between all five slices. Existing fields are frozen; anyone may add an **optional** field, and must say so when they do (the `recruiter` position, `Dashboard.previous`, `FinanceWeek.estimated` and `payrollOnTimeWindow` arrived this way).

## How we worked

We agreed the contracts first and the code second. Before anyone wrote a feature, the API (`API.md`), the shared types, the UI kit prop names, the chart component props, the layout shell and the auth hook were all pinned down in writing, so each of us could build against a stable interface rather than against each other's half-finished work. From there the five slices were built in parallel: the backend implemented the contract against a deterministic seed; the frontend built pages and feature components against the typed hooks; the designer shipped tokens and the kit that pages compose; the logic builder kept the maths pure and tested; and content filled every string from one place.

The integrator pulled the slices together, ran `npm run typecheck`, `npm run build` and the server smoke test, checked both themes, and resolved the handful of conflicts that come from five people touching one repo. Three rounds of QA followed, each fixing what the pilot-style walkthrough found — gauge integrity rules, payroll materialisation, employee-ID redaction, the recruiter role — and the documentation was then re-checked line by line against the final UI. The definition of done was the same for everyone: typecheck and build pass from the root, the smoke test passes, both themes look right, no console errors.
