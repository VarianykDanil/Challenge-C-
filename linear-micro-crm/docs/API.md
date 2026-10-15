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
