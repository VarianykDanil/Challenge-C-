# Linear Hub — API contract (v1)

All endpoints are prefixed with `/api`, speak JSON, and use the types in `shared/src/types.ts`.
Authentication is a session cookie (`lm_session`, httpOnly) created by `POST /api/auth/login`.
Every endpoint except `/auth/login` and `/health` requires a session and returns `401 {error}` without one.

Errors: `{ "error": string, "details?": unknown }` with 400 (validation), 401 (no session),
403 (forbidden for role), 404 (not found), 409 (conflict).

Query params for ranges: `from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive). Defaults: `from` = Monday
of the current week, `to` = today, unless stated otherwise.

## Role rules
| Role | Can see | Can write |
|---|---|---|
| `rep` | own gauges, own payroll, own team's events/leaderboard, directory | own gauges for events of own team |
| `leader` | everything a rep can + full gauges/payroll summary for own team + recruitment read | gauges for team members, events for own team, candidate stage changes |
| `recruiter` | directory, recruitment (all), own payroll | candidates, interviews, stage changes |
| `admin` | everything | everything (users, campaigns, events, payroll pay, expenses) |

## Auth
- `POST /auth/login` body `LoginInput { email, employeeId }` → `AuthResponse`. Case-insensitive match on both. Sets cookie. 401 on mismatch.
- `POST /auth/logout` → `204`.
- `GET /auth/me` → `AuthResponse`.
- `GET /auth/demo-accounts` → `{ accounts: { label: string; role: Role; email: string; employeeId: string }[] }` (one per role, for the demo "quick sign-in" buttons).

## Dashboard
- `GET /me/dashboard?range=week|month|quarter` → `Dashboard` (default `week`). `team` is null if the user has no team. `company` is non-null only for `admin` and `leader`. `upcomingEvents` = next 5 events for the user's team (admin: whole company) from today. `announcements` = latest 5, pinned first.

## People
- `GET /users?teamId&role&status&q` → `UserWithTeam[]` (default status=active; `q` matches name/email/employeeId).
- `GET /users/:id` → `UserWithTeam`.
- `GET /users/:id/performance?from&to` → `{ user: UserWithTeam; totals: GaugeTotals; ratios: FunnelRatios; days: number; salesPerDay: number; trend: TrendPoint[]; byCampaign: GaugeSummaryRow[]; recentEntries: GaugeEntryWithMeta[]; punctualityRate: number | null }`.
- `POST /users` (admin) body: `Omit<User,'id'>` minus `avatarColor` optional → `UserWithTeam` (201).
- `PATCH /users/:id` (admin) partial `User` → `UserWithTeam`.
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
- `GET /gauges?userId&eventId&teamId&campaignId&from&to&limit` → `GaugeEntryWithMeta[]` newest first. Reps are limited to their own entries.
- `POST /gauges` body `GaugeUpsertInput` → `GaugeEntryWithMeta` (201 on create, 200 on update). Upserts on `(eventId, userId, date)`. Runs `validateGaugeFunnel`; on warnings returns `400 { error: 'Invalid funnel', details: string[] }`.
- `PATCH /gauges/:id` partial `GaugeUpsertInput` → `GaugeEntryWithMeta`.
- `DELETE /gauges/:id` (leader/admin) → `204`.
- `GET /gauges/summary?groupBy=user|team|campaign|day|week&from&to&teamId&campaignId&userId` → `GaugeSummaryRow[]` sorted by sales desc (day/week: chronological). `key` is the id (or date), `label` the display name.
- `GET /leaderboard?period=week|month|quarter&metric=sales|conversion&teamId` → `LeaderboardRow[]` (top 25). `movement` compares with the previous period.

## Finance
- `GET /finance/payroll?userId&teamId&status&from&to` → `PayrollRunWithUser[]` newest first. Reps/recruiters: own only. Leaders: own team. Default range: last 12 weeks.
- `GET /finance/payroll/:id` → `PayrollRunWithUser & { plan: PayPlan; entries: GaugeEntryWithMeta[] }` (the payslip).
- `POST /finance/payroll/:id/pay` (admin) body `{ paidDate?: string }` → `PayrollRunWithUser`. Sets status to `paid` or `late` based on due date.
- `GET /finance/summary?from&to` (admin; leader gets own-team payroll view only) → `FinanceSummary`. Default range: last 12 weeks.
- `GET /finance/pay-plans` → `PayPlan[]`.
- `GET /finance/expenses?from&to&category&campaignId` (admin) → `Expense[]`. `POST /finance/expenses` (admin) → `Expense` (201). `DELETE /finance/expenses/:id` (admin) → 204.
- `GET /finance/me?weeks=12` → `{ runs: PayrollRunWithUser[]; totals: { gross: number; commission: number; onTimeRate: number | null }; nextPayday: string | null; nextPayAmount: number | null }` (the signed-in user's earnings).

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

- **Public endpoints.** `GET /auth/demo-accounts` is public (the login page needs it before a session exists), alongside `/auth/login` and `/health`. Unknown `/api/*` paths return `404 { "error": "Not found" }` whether or not a session is present.
- **Login.** Email and employee ID are matched case-insensitively; a user with status `left` gets `401`. Sessions live 14 days in the `sessions` table (32 random bytes, hex) behind the `lm_session` cookie (httpOnly, SameSite=Lax; set `COOKIE_SECURE=1` to add `Secure`).
- **Dates and times.** `from`/`to` are inclusive `BETWEEN` filters, so `from=to=<date>` is an exact-date match (used to prefill an existing gauge entry via `GET /gauges?eventId&userId&from&to`). Week keys (`groupBy=week`, `FinanceWeek.weekStart`, `RecruitmentSummary.weekly`) are Monday dates. Dashboard/leaderboard ranges end at **today** (`week` = Monday → today) and the comparison period is the preceding range of equal length (`previousRange` from `@lm/shared`); `deltas` are null when the previous value is 0. Quarter trends are weekly points, week/month trends are daily, all zero-filled.
- **Check-in timestamps.** `checkedInAt` is stored and returned as a *naive local* timestamp with no zone suffix (`2026-10-15T10:03:00`), matching `isCheckInOnTime`, which reads the event start as local time. Clients may send a zoned value; it is converted to the server's local components. Other timestamps (`submittedAt`, `createdAt`, `appliedAt`, …) are full ISO 8601 UTC.
- **Team scoping of gauges** always uses the *user's* team (`users.team_id`), so leaderboards, team dashboards, `groupBy=team` and payroll overrides agree. `GaugeEntryWithMeta.teamId/teamName` are the user's team. `GaugeSummaryRow.days` is distinct rep-days (user × date); for `groupBy=user` that equals days worked.
- **Reads by role.** Reps: `GET /events` and `GET /leaderboard` are forced to their own team, `GET /gauges` to their own entries, `GET /gauges/summary` to their own team (or own entries when `userId=me`), `GET /users/:id/performance` to themselves and their own team. Leaders, recruiters and admins read company-wide (leaders' write scope stays their own team). `GET /users` defaults to `status=active`; pass `status=all` for everyone.
- **Gauge writes.** `POST /gauges` upserts on `(eventId, userId, date)`: `201` on insert, `200` on update (an update keeps the stored `checkedInAt`/`notes` when the body omits them). Reps may only write their own entries at their own team's events; leaders for members of their team; admins anywhere. `DELETE /gauges/:id` is for admins and leaders of the entry owner's team.
- **Leaderboard** uses the shared `rankRows` competition ranking (ties share a rank; tie-break on the other metric) and `movement` (previous rank − current rank, `null` when new). Top 25.
- **Payroll.** Seeded runs are weekly (Mon–Sun) per employed user with due date = the Friday after the week ends (`paydayForWeek`), reference `PAY-<ISO year><ISO week>-<employeeId>`. `teamSales` for leaders = sales of their team members excluding their own; for the owner/assistant owner (no team) it is other reps' sales at the events they personally attended. Recruiters are paid Mon–Fri base. `POST /finance/payroll/:id/pay` derives `paid`/`late` from the due date (`payrollStatusFor`) and returns `409` if the run was already paid. `nextPayday`/`nextPayAmount` (dashboard and `/finance/me`) are the earliest not-yet-due pending run, otherwise the shared `nextPayday(today)` with a live estimate of the current week. `Dashboard.personal.earningsToDate` = gross of runs starting in the range plus a live estimate for weeks without a run yet.
- **FinanceSummary.payroll.** `runs` = all runs whose week starts in range; `paid` = money landed (status `paid` **or** `late`); `late` = the subset paid after the due date; `pending` = status `pending`; failed = `runs − paid − pending`. `onTimeRate` = `(paid − late) / paid` (0 when nothing paid), `avgDaysLate` over the late subset. `CampaignFinance.margin` is in pounds (revenue − rep commission). Leaders get the same shape scoped to their team (team members' payroll, team sales/revenue, venue fees of the team's events). `Dashboard.company.payrollOnTimeRate` uses settled runs due in the range, falling back to the last 12 weeks when none are due yet.
- **Recruitment.** `GET /recruitment/interviews` defaults to Monday of this week → today + 14 days (so upcoming interviews show); pass `candidateId` for a candidate's full list. `PATCH /recruitment/candidates/:id` rejects a `stage` field with `400`; `POST …/stage` returns `409` when the stage is unchanged or the candidate is already `hired`. Hiring creates the user with the next `LM-xxxx`, a `first.last@linear-mcr.co.uk` address (numbered if taken), role `rep`, the pay plan for the applied position and the owner's team. `RecruitmentSummary.openByStage` holds the current open pipeline for non-terminal stages and, for `hired`/`rejected`/`withdrawn`, how many reached that stage within the range.
- **Errors.** Zod failures → `400 { error: 'Validation failed', details: [{ path, message }] }`; invalid funnels → `400 { error: 'Invalid funnel', details: string[] }`; SQLite unique-constraint violations → `409`.
- **Database.** `node:sqlite` (`server/data/linear.sqlite`, WAL, foreign keys on). Override the location with `DB_PATH`. The server seeds on first start when the `meta.seeded_at` row is missing; `npm run seed -w server` deletes and rebuilds the file. Seeding is deterministic (mulberry32) but anchored to the real current date, so demo data stays "this week" whenever it is regenerated. `npm run smoke -w server` boots the API on a temporary seeded database and exercises every endpoint.
