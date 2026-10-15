# Linear Hub — API contract (v1)

All endpoints are prefixed with `/api`, speak JSON, and use the types in `shared/src/types.ts`.
Authentication is a session cookie (`lm_session`, httpOnly) created by `POST /api/auth/login`.
Every endpoint except `/auth/login`, `/auth/demo-accounts` and `/health` requires a session and returns `401 {error}` without one.
A session whose user has since been set to status `left` is also rejected with `401` (and deleted).

Errors: `{ "error": string, "details?": unknown }` with 400 (validation), 401 (no session),
403 (forbidden for role), 404 (not found), 409 (conflict).

Query params for ranges: `from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive). Defaults: `from` = Monday
of the current week, `to` = today, unless stated otherwise. Every range is bounded: `from` may not be before
`2020-01-01` and the span may not exceed **400 days** — otherwise `400 { error: 'Date range too large (max 400 days)' }`
(or `'Dates before 2020-01-01 are not supported'`). `limit` query params are capped at **500**.

## Role rules
| Role | Can see | Can write |
|---|---|---|
| `rep` | own gauges, own payroll, own team's events/leaderboard, directory (without employee IDs) | own gauges for events of own team |
| `leader` | everything a rep can + full gauges/payroll summary for own team + recruitment read (without employee IDs) | gauges for team members at own team's events, events for own team, candidate stage changes |
| `recruiter` | directory, recruitment (all), own payroll (without employee IDs) | candidates, interviews, stage changes |
| `admin` | everything, including every employee ID | everything (users, campaigns, events, payroll pay, expenses) |

**Employee IDs are credentials** (email + employee ID is the login). Every payload that embeds a user — `GET /users`,
`GET /users/:id`, `GET /users/:id/performance`, `GET /finance/payroll` rows, the payslip — returns `employeeId: ''`
unless the requester is an `admin` or the row is the requester themselves. `GET /auth/me` and the `user` inside
`Dashboard` always carry the caller's own ID. The type keeps `employeeId: string`; `''` means "hidden".

## Auth
- `POST /auth/login` body `LoginInput { email, employeeId }` → `AuthResponse`. Case-insensitive match on both. Sets cookie. 401 on mismatch or when the user has status `left`.
- `POST /auth/logout` → `204`.
- `GET /auth/me` → `AuthResponse`.
- `GET /auth/demo-accounts` → `{ accounts: { label: string; role: Role; email: string; employeeId: string }[] }` for the demo "quick sign-in" buttons. Returns the four **seeded** demo accounts (LM-0001/0002/0003/0010, in role order admin, leader, recruiter, rep) only when all four exist with those roles and none has left; otherwise, or when the server runs with `LM_DEMO_ACCOUNTS=0`, `{ accounts: [] }`. There is no "one user per role" fallback: a non-demo database never publishes a login. Clients hide the buttons when the list is empty.

## Dashboard
- `GET /me/dashboard?range=week|month|quarter` → `Dashboard` (default `week`). `team` is null if the user has no team. `company` is non-null only for `admin` and `leader`. `upcomingEvents` = next 5 events for the user's team (admin: whole company) from today. `announcements` = latest 5, pinned first. `previous` is the comparison window behind `personal.deltas` and leaderboard `movement`: the **same to-date span of the previous period** (week Mon 12 – Thu 15 Oct → Mon 5 – Thu 8 Oct; month 1–15 Oct → 1–15 Sep; quarter 1–15 Oct → 1–15 Jul). `company.payrollOnTimeWindow` says which window `company.payrollOnTimeRate` describes: `'range'` (settled runs due in the range) or `'last12Weeks'` (nothing was due in the range yet, so the runs due in the last 12 weeks up to today were used).

## People
- `GET /users?teamId&role&status&q` → `UserWithTeam[]` (default status=active; `q` matches name/email, and employeeId for admins only). `employeeId` is `''` except for admins and the caller's own row.
- `GET /users/:id` → `UserWithTeam` (same `employeeId` rule).
- `GET /users/:id/performance?from&to` → `{ user: UserWithTeam; totals: GaugeTotals; ratios: FunnelRatios; days: number; salesPerDay: number; trend: TrendPoint[]; byCampaign: GaugeSummaryRow[]; recentEntries: GaugeEntryWithMeta[]; punctualityRate: number | null }` (same `employeeId` rule on `user`).
- `POST /users` (admin) body: `Omit<User,'id'>` minus `avatarColor` optional → `UserWithTeam` (201).
- `PATCH /users/:id` (admin) partial `User` → `UserWithTeam`. Setting `status: 'left'` deletes every session of that user at once; an admin cannot set their own status to `left` (`400`).
- `GET /teams` → `Team[]` (includes `memberCount`, `leaderName`).

## Campaigns
- `GET /campaigns?active=true|false` → `Campaign[]` (default all).
- `POST /campaigns` (admin) → `Campaign` (201). `PATCH /campaigns/:id` (admin) → `Campaign`.

## Events
- `GET /events?from&to&teamId&campaignId&status` → `SalesEventWithMeta[]` sorted by date asc then startTime. Default range: 7 days ago → 21 days ahead.
- `GET /events/:id` → `SalesEventWithMeta & { entries: GaugeEntryWithMeta[]; ratios: FunnelRatios }`.
- `POST /events` (admin, leader for own team) body `Omit<SalesEvent,'id'|'status'> & { status?: EventStatus }` → `SalesEventWithMeta` (201).
- `PATCH /events/:id` (admin, leader for own team) → `SalesEventWithMeta`.
- `DELETE /events/:id` (admin) → `204`.

## Gauges
- `GET /gauges?userId&eventId&teamId&campaignId&from&to&limit` → `GaugeEntryWithMeta[]` newest first. Reps are limited to their own entries. `limit` defaults to 500 and is capped at 500.
- `POST /gauges` body `GaugeUpsertInput` → `GaugeEntryWithMeta` (201 on create, 200 on update). Upserts on `(eventId, userId, date)`. Runs `validateGaugeFunnel`; on warnings returns `400 { error: 'Invalid funnel', details: string[] }`. **Integrity rules** (checked after the role rules, before the funnel): `date` must equal the event's `date` → otherwise `400 { error: "Gauges are recorded against the event's date" }`; the event must not be `cancelled` → `409`; the event's date must not be in the future → `400`; the target user must have status `active` → `400`; and, unless the caller is an admin, the target user must belong to the event's team → `400`. Clients send the event's date, not a free date.
- `PATCH /gauges/:id` partial `GaugeUpsertInput` → `GaugeEntryWithMeta`. The same integrity rules apply to the resulting entry (the user-status rule only when `userId` changes, so leavers' history stays editable).
- `DELETE /gauges/:id` (leader/admin) → `204`.
- `GET /gauges/summary?groupBy=user|team|campaign|day|week&from&to&teamId&campaignId&userId` → `GaugeSummaryRow[]` sorted by sales desc (day/week: chronological). `key` is the id (or date), `label` the display name.
- `GET /leaderboard?period=week|month|quarter&metric=sales|conversion&teamId` → `LeaderboardRow[]` (top 25). `movement` compares with the same to-date span of the previous week/month/quarter (see Dashboard `previous`).

## Finance
- `GET /finance/payroll?userId&teamId&status&from&to` → `PayrollRunWithUser[]` newest first. Reps/recruiters: own only. Leaders: own team. Default range: last 12 weeks. Runs for every completed Mon–Sun week are materialised automatically (see *Payroll* below), so a week that has just closed always has its `pending` runs. `employeeId` is `''` on other people's rows unless the caller is an admin.
- `GET /finance/payroll/:id` → `PayrollRunWithUser & { plan: PayPlan; entries: GaugeEntryWithMeta[] }` (the payslip; same `employeeId` rule).
- `POST /finance/payroll/:id/pay` (admin) body `{ paidDate?: string }` → `PayrollRunWithUser`. Sets status to `paid` or `late` based on due date.
- `GET /finance/summary?from&to` (admin; leader gets own-team payroll view only) → `FinanceSummary`. Default range: last 12 weeks. **The window is snapped to whole Mon–Sun pay weeks** (`from` back to its Monday, `to` forward to its Sunday) and the response's `from`/`to` are the snapped dates, so revenue, payroll and expenses — per week, in `totals`, `byCampaign` and `expensesByCategory` — always cover identical days and a run is never split or double-counted across adjacent months. A week that has started but has no runs yet (the week in progress) carries the live payroll estimate and `FinanceWeek.estimated: true`. `byCampaign.commission` is the pay-plan commission the reps actually earn on that campaign's sales (it reconciles with payroll), not the campaign's nominal rate; `margin` = revenue − that commission.
- `GET /finance/pay-plans` → `PayPlan[]`.
- `GET /finance/expenses?from&to&category&campaignId` (admin) → `Expense[]`. `POST /finance/expenses` (admin) → `Expense` (201). `DELETE /finance/expenses/:id` (admin) → 204.
- `GET /finance/me?weeks=12` → `{ runs: PayrollRunWithUser[]; totals: { gross: number; commission: number; onTimeRate: number | null }; nextPayday: string | null; nextPayAmount: number | null }` (the signed-in user's earnings). `nextPayday`/`nextPayAmount` are the earliest **unpaid** run (`pending` or `failed`), even when it is overdue; only when nothing is owed do they fall back to the live estimate of the current week.

## Recruitment (recruiter, leader, admin)
- `GET /recruitment/candidates?stage&ownerId&source&q&open=true` → `CandidateWithMeta[]` (`open=true` excludes terminal stages). Sorted by `stageUpdatedAt` desc.
- `GET /recruitment/candidates/:id` → `CandidateWithMeta & { history: StageChange[]; interviews: Interview[] }`.
- `POST /recruitment/candidates` body: `Pick<Candidate,'firstName'|'lastName'|'email'> & Partial<Candidate>` → `CandidateWithMeta` (201). Creates an `applied` stage change.
- `PATCH /recruitment/candidates/:id` partial `Candidate` (not `stage`) → `CandidateWithMeta`.
- `POST /recruitment/candidates/:id/stage` body `{ stage: CandidateStage; note?: string }` → `CandidateWithMeta`. Records a `StageChange`. Moving to `hired` creates a `User` (role rep, position = positionApplied, team = owner's team or null) and sets `hiredUserId`.
- `GET /recruitment/interviews?from&to&candidateId` → `Interview[]`. `POST /recruitment/interviews` → `Interview` (201). `PATCH /recruitment/interviews/:id` → `Interview`.
- `GET /recruitment/summary?from&to` → `RecruitmentSummary`. Default range: last 12 weeks.

## Misc
- `GET /announcements` → `Announcement[]` (pinned first, newest first). `POST /announcements` (admin, leader) → `Announcement` (201).
- `GET /health` → `{ ok: true, version: string, seededAt: string }`.

## Seed & demo accounts
The server seeds `server/data/linear.sqlite` on first start (or `npm run seed` to reset) with deterministic
sample data for the last 26 weeks. Demo logins (email / employee ID):

| Role | Name | Email | Employee ID |
|---|---|---|---|
| admin | Danil Varianyk (Owner) | danil@linear-mcr.co.uk | LM-0001 |
| leader | Amelia Hart (Crew Leader) | amelia.hart@linear-mcr.co.uk | LM-0002 |
| recruiter | Priya Shah (Recruiter) | priya.shah@linear-mcr.co.uk | LM-0003 |
| rep | Jordan Lee (Field Rep) | jordan.lee@linear-mcr.co.uk | LM-0010 |

Teams: Northern Lights, Deansgate, Spinningfields, Ancoats. Campaigns: Breast Cancer Now (fundraising, private sites),
Children's Hospice North (fundraising, events), Volt Energy (B2B), FibreCity Broadband (residential).

## Implementation notes (Backend)

Behaviour that the contract above leaves open, as implemented in `server/`:

- **Public endpoints.** `GET /auth/demo-accounts` is public (the login page needs it before a session exists), alongside `/auth/login` and `/health`. It only ever lists the four seeded demo accounts (all present, with their seeded roles, none `left`) and returns `{ accounts: [] }` otherwise or when the environment variable `LM_DEMO_ACCOUNTS=0` is set — set that on any deployment with real users. Unknown `/api/*` paths return `404 { "error": "Not found" }` whether or not a session is present.
- **Login & sessions.** Email and employee ID are matched case-insensitively; a user with status `left` gets `401` on login. Sessions live 14 days in the `sessions` table (32 random bytes, hex) behind the `lm_session` cookie (httpOnly, SameSite=Lax; set `COOKIE_SECURE=1` to add `Secure`). `authenticate` rejects (and deletes) the session of any user whose status is `left`, and `PATCH /users/:id` with `status: 'left'` deletes all of that user's sessions, so deactivation revokes access immediately. An admin cannot deactivate their own account (`400`).
- **Employee IDs.** Because the employee ID is half of the credential, `redactUser`/`redactPayroll` (`server/src/lib/scope.ts`) blank it (`''`) on every user or payroll payload unless the requester is an admin or the row is their own; `q` on `GET /users` searches employee IDs for admins only.
- **Dates and times.** `from`/`to` are inclusive `BETWEEN` filters, so `from=to=<date>` is an exact-date match (used to prefill an existing gauge entry via `GET /gauges?eventId&userId&from&to`). `parseRange` rejects `from` before `2020-01-01` and spans over 400 days with `400`, so daily trends and weekly summaries are bounded; `limit` is capped at 500. Week keys (`groupBy=week`, `FinanceWeek.weekStart`, `RecruitmentSummary.weekly`) are Monday dates. Dashboard/leaderboard ranges end at **today** (`week` = Monday → today) and the comparison period is the **same to-date span of the previous period** (`previousToDateRange` in `server/src/lib/dates.ts`: week → the same weekdays last week, month → days 1..n of the previous month clamped to its length, quarter → the same day-offset into the previous quarter), returned as `Dashboard.previous`; `deltas` are null when the previous value is 0. Quarter trends are weekly points (the first point is keyed by the quarter's first day and holds that partial week), week/month trends are daily, all zero-filled.
- **Check-in timestamps.** `checkedInAt` is stored and returned as a *naive wall-clock* timestamp with no zone suffix (`2026-10-15T10:03:00`), matching `isCheckInOnTime`, which reads the event start the same way. Clients should send the naive value the user typed (`YYYY-MM-DDTHH:mm[:ss]`); a zoned value (`…Z` / `±hh:mm`) is converted to **Europe/London** wall-clock time (`toBusinessISO`), never to the container's zone. The server scripts also pin `TZ=Europe/London` so `todayISO()` is the business date; the Dockerfile should set the same `TZ`. Other timestamps (`submittedAt`, `createdAt`, `appliedAt`, …) are full ISO 8601 UTC.
- **Team scoping of gauges** always uses the *user's* team (`users.team_id`), so leaderboards, team dashboards, `groupBy=team` and payroll overrides agree. `GaugeEntryWithMeta.teamId/teamName` are the user's team. `GaugeSummaryRow.days` is distinct rep-days (user × date); for `groupBy=user` that equals days worked.
- **Reads by role.** Reps: `GET /events` and `GET /leaderboard` are forced to their own team, `GET /gauges` to their own entries, `GET /gauges/summary` to their own team (or own entries when `userId=me`), `GET /users/:id/performance` to themselves and their own team. Leaders, recruiters and admins read company-wide (leaders' write scope stays their own team). `GET /users` defaults to `status=active`; pass `status=all` for everyone.
- **Gauge writes.** `POST /gauges` upserts on `(eventId, userId, date)`: `201` on insert, `200` on update (an update keeps the stored `checkedInAt`/`notes` when the body omits them). Role rules first (`403`): reps may only write their own entries at their own team's events; leaders for themselves or members of their team, and only at their own team's events; admins anywhere. Then the integrity rules (`assertGaugeIntegrity` in `routes/gauges.ts`): the date equals the event date, the event is not cancelled (`409`) and not in the future, the user is active, and (non-admins) belongs to the event's team — every aggregate groups on the entry date, so one event can carry exactly one entry per rep on the day it ran. `DELETE /gauges/:id` is for admins and leaders of the entry owner's team.
- **Leaderboard** uses the shared `rankRows` competition ranking (ties share a rank; tie-break on the other metric) and `movement` (previous rank − current rank, `null` when new) against the same to-date span of the previous period. Top 25.
- **Payroll.** Runs are weekly (Mon–Sun) per payable user with due date = the Friday after the week ends (`paydayForWeek`), reference `PAY-<ISO year><ISO week>-<employeeId>`. The pay rules live in `server/src/lib/pay.ts` (`weekPayFor`) and are shared by the seed, the live estimates and materialisation: `daysWorked` = distinct gauge dates, `sales` = sum of gauge sales; `teamSales` for leaders = sales of their team members excluding their own; for the owner/assistant owner (no team) it is other reps' sales at the events they personally attended; recruiters are paid Mon–Fri base, clamped to their start date and, for the week in progress, to today. A user is payable for a week when they started by its Sunday and are either `active` or logged gauges that week. **Materialisation:** `materialisePayrollRuns(db, today)` (`server/src/db/maintenance.ts`) creates `pending` runs (gross > 0, no deductions) for every completed Mon–Sun week after the latest run; it runs at startup after seeding, once a day (unref'd `setInterval`), and `GET /finance/payroll`, `/finance/me` and `/finance/summary` call the cheap guard `ensurePayrollMaterialised` so a long-running process never shows a closed week without runs. `POST /finance/payroll/:id/pay` derives `paid`/`late` from the due date (`payrollStatusFor`) and returns `409` if the run was already paid; the stored status is never flipped to `late` for an unpaid run (that status means *paid late*). `nextPayday`/`nextPayAmount` (dashboard and `/finance/me`) are the earliest unpaid (`pending` or `failed`) run even when overdue, otherwise the shared `nextPayday(today)` with a live estimate of the current week. `Dashboard.personal.earningsToDate` = gross of runs starting in the range plus a live estimate for weeks without a run yet.
- **FinanceSummary.** The window is snapped to whole pay weeks (`mondayOf(from)`..`sundayOf(to)`; the response echoes the snapped `from`/`to`). Per week, revenue (gauges × campaign payout), payroll (runs with that `weekStart`) and expenses are measured over the same Mon–Sun days; a week that has started, lies after the last materialised week and has no runs is charged at `estimateWeekPayroll` and flagged `estimated`. `payroll.runs` = all runs whose week starts in the window; `paid` = money landed (status `paid` **or** `late`); `late` = the subset paid after the due date; `pending` = status `pending`; failed = `runs − paid − pending`. `onTimeRate` = `(paid − late) / paid` (0 when nothing paid), `avgDaysLate` over the late subset. `byCampaign.commission` = Σ sales × the selling rep's pay-plan `commissionPerSale` (reconciles to payroll commission for complete weeks); `CampaignFinance.margin` is in pounds (revenue − that commission). Leaders get the same shape scoped to their team (team members' payroll, team sales/revenue, venue fees of the team's events). `Dashboard.company.payrollOnTimeRate` uses settled runs due in the range; when none were due yet it uses settled runs due in the last 12 weeks up to today and reports `payrollOnTimeWindow: 'last12Weeks'` (`'range'` otherwise).
- **Seed announcements.** The leaderboard announcement (top two by sales and best conversion among people with ≥ 200 stops in the last complete calendar month, plus the crew total) and the "N candidates at interview or observation stage" line are generated from the seeded gauges/candidates, so the numbers they quote are always true for that database.
- **Recruitment.** `GET /recruitment/interviews` defaults to Monday of this week → today + 14 days (so upcoming interviews show); pass `candidateId` for a candidate's full list. `PATCH /recruitment/candidates/:id` rejects a `stage` field with `400`; `POST …/stage` returns `409` when the stage is unchanged or the candidate is already `hired`. Hiring creates the user with the next `LM-xxxx`, a `first.last@linear-mcr.co.uk` address (numbered if taken), role `rep`, the pay plan for the applied position and the owner's team. `RecruitmentSummary.openByStage` holds the current open pipeline for non-terminal stages and, for `hired`/`rejected`/`withdrawn`, how many reached that stage within the range.
- **Errors.** Zod failures → `400 { error: 'Validation failed', details: [{ path, message }] }`; invalid funnels → `400 { error: 'Invalid funnel', details: string[] }`; SQLite unique-constraint violations → `409`.
- **Database.** `node:sqlite` (`server/data/linear.sqlite`, WAL, foreign keys on). Override the location with `DB_PATH`. The server seeds on first start when the `meta.seeded_at` row is missing; `npm run seed -w server` deletes and rebuilds the file. Seeding is deterministic (mulberry32) but anchored to the real current date, so demo data stays "this week" whenever it is regenerated. `npm run smoke -w server` boots the API on a temporary seeded database and exercises every endpoint.
