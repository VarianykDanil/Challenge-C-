# Linear Hub — API contract (v1)

All endpoints are prefixed with `/api`, speak JSON, and use the types in `shared/src/types.ts`.
Authentication is a session cookie (`lm_session`, httpOnly) created by `POST /api/auth/login`.
Every endpoint except `/auth/login`, `/auth/demo-accounts` and `/health` requires a session and returns `401 {error}` without one.
A session whose user has since been set to status `left` is also rejected with `401` (and deleted).

Errors: `{ "error": string, "details?": unknown }` with 400 (validation), 401 (no session),
403 (forbidden for role), 404 (not found), 409 (conflict), 410 (a sign-in challenge is gone), 429 (rate limited).

**Numbers are strict.** Every numeric body field must be a finite JSON number (no `"5"`, `true`, `null` coercion).
Gauge counts are whole numbers from 0 to **2000** per entry (`GAUGE_MAX_PER_DAY`), an event's `targetSales` tops out
at **500**, and money amounts (expense `amount`, campaign `payoutPerSale`) are **> 0 and ≤ 1,000,000** (`MONEY_MAX`,
`repCommissionPerSale` may be 0). Out-of-range values are `400 Validation failed`. Aggregates are therefore always
finite; the one ratio that has no value without sales, `FunnelRatios.stopsPerSale`, is **`null`** (typed
`number | null`), never `Infinity`.

**Security headers** on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
`Content-Security-Policy` (`default-src 'self'`; scripts same-origin plus the SHA-256 of the inline theme script in
the built `index.html`; styles inline or Google Fonts; fonts gstatic; `frame-ancestors 'none'`) and
`Strict-Transport-Security` whenever the request arrived over HTTPS. `GET /assets/*` (hashed Vite bundles) is served
with `Cache-Control: public, max-age=31536000, immutable`; `index.html` with `no-cache`.

**Compression** (1.1): JSON, HTML, JavaScript, CSS and SVG responses of 1 KB or more are sent `gzip`-encoded when
`Accept-Encoding` allows it (`br` only when the client ranks it above gzip), with an exact `Content-Length` and
`Vary: Accept-Encoding`. `LM_COMPRESSION=0` turns it off. Details under *Smart endpoints → Backups, health and
compression*.

**Response cache.** `GET /me/dashboard`, `/finance/summary`, `/recruitment/summary`, `/leaderboard`,
`/gauges/summary` and (1.1) `/me/insights`, `/me/attention`, `/me/digest` and `/events/forecast` are cached for 20 s per (user, URL) and invalidated by **every** write (`POST`/`PATCH`/`DELETE`
on `/api/*`) and by the maintenance jobs. The header `X-Cache: HIT | MISS` (exposed through CORS) says which it was.

Query params for ranges: `from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive). Defaults: `from` = Monday
of the current week, `to` = today, unless stated otherwise. Every range is bounded: `from` may not be before
`2020-01-01` and the span may not exceed **400 days** — otherwise `400 { error: 'Date range too large (max 400 days)' }`
(or `'Dates before 2020-01-01 are not supported'`). `limit` query params are capped at **500**.

## Role rules
| Role | Can see | Can write |
|---|---|---|
| `rep` | own gauges, own payroll, own team's leaderboard, directory, and every event detail / profile performance read-only (other people's check-in times and notes hidden; no employee IDs) | own gauges for events of own team |
| `leader` | everything a rep can + full gauges/payroll summary for own team (check-in times and notes of own team) + recruitment read (without employee IDs) | gauges for team members at own team's events, events for own team, candidate stage changes |
| `recruiter` | directory, recruitment (all), own payroll (without employee IDs) | candidates, interviews, stage changes |
| `admin` | everything, including every employee ID | everything (users, campaigns, events, payroll pay, expenses) |

**Employee IDs are credentials** (email + employee ID is the login). Every payload that embeds a user — `GET /users`,
`GET /users/:id`, `GET /users/:id/performance`, `GET /finance/payroll` rows, the payslip — returns `employeeId: ''`
unless the requester is an `admin` or the row is the requester themselves. `GET /auth/me` and the `user` inside
`Dashboard` always carry the caller's own ID. The type keeps `employeeId: string`; `''` means "hidden".

## Auth
- `POST /auth/login` body `LoginInput { email, employeeId }` → `AuthResponse`. Case-insensitive match on both. Sets cookie. **`401 { error: 'Invalid email or employee ID' }`** for an unknown email, a wrong ID *and* a deactivated (`left`) account alike — the response never confirms whether a credential exists. **Rate limit:** failed attempts are counted per **source address + email** (8 in 15 minutes → `429 { error: 'Too many attempts, try again in N minutes' }` for that address) and per **email from any address** (20 in 15 minutes). The source is the TCP peer address — never `X-Forwarded-For`, which a client can forge — so rotating headers does not bypass the limit. A successful sign-in resets both counters.
- `POST /auth/logout` → `204`.
- `GET /auth/me` → `AuthResponse` (`user.twoFactorEnabled` says whether two-step verification is on).
- When the account has two-step verification on, `POST /auth/login` answers with a `TwoFactorChallenge` instead and no cookie; see *Two-step verification* at the end of this document for `POST /auth/login/2fa` and the `/auth/2fa*` settings endpoints.
- `GET /auth/demo-accounts` → `{ accounts: { label: string; role: Role; email: string; employeeId: string }[] }` for the demo "quick sign-in" buttons. Returns the four **seeded** demo accounts (LM-0001/0002/0003/0010, in role order admin, leader, recruiter, rep) only when all four exist with those roles and none has left; otherwise, or when the server runs with `LM_DEMO_ACCOUNTS=0`, `{ accounts: [] }`. There is no "one user per role" fallback: a non-demo database never publishes a login. Clients hide the buttons when the list is empty. Release 1.3 adds `clientAccounts?` (the seeded demo client) and 1.3.1 `demoTeams?: DemoTeamAccounts[]` (team Sapiens' seven blank accounts; see [1.3.1](#131-endpoints)). Since 1.3.1 a `clientAccounts` item is labelled with its organisation (`"Hannah Price (Breast Cancer Now)"`, was `"Hannah Price (Client)"`) and adds `name`, `organisation` and `sector` (additive).

## Dashboard
- `GET /me/dashboard?range=week|month|quarter` → `Dashboard` (default `week`). `team` is null if the user has no team. `company` is non-null only for `admin` and `leader`. `upcomingEvents` = next 5 events for the user's team (admin: whole company) from today. `announcements` = latest 5, pinned first; `olderAnnouncements` (release 1.2, optional) = how many there are beyond those five (`GET /announcements?offset=5` lists them). `previous` is the comparison window behind `personal.deltas` and leaderboard `movement`: the **same to-date span of the previous period** (week Mon 12 – Thu 15 Oct → Mon 5 – Thu 8 Oct; month 1–15 Oct → 1–15 Sep; quarter 1–15 Oct → 1–15 Jul). `company.payrollOnTimeWindow` says which window `company.payrollOnTimeRate` describes: `'range'` (settled runs due in the range) or `'last12Weeks'` (nothing was due in the range yet, so the runs due in the last 12 weeks up to today were used). `personal.rank`/`rankOutOf` are **team-scoped for reps** (the same population as their `GET /leaderboard`) and company-wide for leaders and admins.

## People
- `GET /users?teamId&role&status&q` → `UserWithTeam[]` (default status=active; `q` matches name/email, and employeeId for admins only). `employeeId` is `''` except for admins and the caller's own row.
- `GET /users/:id` → `UserWithTeam` (same `employeeId` rule).
- `GET /users/:id/performance?from&to` → `{ user: UserWithTeam; totals: GaugeTotals; ratios: FunnelRatios; days: number; salesPerDay: number; trend: TrendPoint[]; byCampaign: GaugeSummaryRow[]; recentEntries: GaugeEntryWithMeta[]; punctualityRate: number | null }` (same `employeeId` rule on `user`). Readable by every signed-in user; `recentEntries[].checkedInAt` and `.notes` are `null` unless the requester is an admin, the person themselves or a leader of that person's team.
- `POST /users` (admin, recruiter, leader) body: `Omit<User,'id'>` minus `avatarColor` optional → `UserWithTeam` (201). Release 1.3.1: recruiters and leaders may add field people, `employeeId` is optional for everyone, and the answer is an `AddPersonResult` — see [1.3.1 endpoints](#131-endpoints).
- `PATCH /users/:id` (admin) partial `User` → `UserWithTeam`. Setting `status: 'left'` deletes every session of that user at once; an admin cannot set their own status to `left` (`400`).
- `POST /users/:id/2fa/reset` (admin) → `204`. Switches that person's two-step verification off without a code (lost device) and signs them out everywhere; `400` for the admin's own account (use `POST /auth/2fa/disable`). See *Two-step verification*.
- `GET /teams` → `Team[]` (includes `memberCount`, `leaderName`).

## Campaigns
- `GET /campaigns?active=true|false` → `Campaign[]` (default all).
- `POST /campaigns` (admin) → `Campaign` (201). `PATCH /campaigns/:id` (admin) → `Campaign`.

## Events
- `GET /events?from&to&teamId&campaignId&status` → `SalesEventWithMeta[]` sorted by date asc then startTime. Default range: 7 days ago → 21 days ahead.
- `GET /events/:id` → `SalesEventWithMeta & { entries: GaugeEntryWithMeta[]; ratios: FunnelRatios }`. Readable by every role (read-only); `entries[].checkedInAt`/`.notes` are `null` for other people's entries unless the requester is an admin or a leader of that person's team.
- `POST /events` (admin, leader for own team) body `Omit<SalesEvent,'id'|'status'> & { status?: EventStatus }` → `SalesEventWithMeta` (201). Default `status`: `completed` for past dates, `live` for today once `startTime` has passed, otherwise `scheduled`. `targetSales` is a whole number ≤ 500.
- `PATCH /events/:id` (admin, leader for own team) → `SalesEventWithMeta`. Once the event has gauge entries its `date`, `teamId` and `campaignId` are frozen: changing any of them answers **`409 { error: 'This event has recorded gauges — its date cannot change; cancel it and create a new event instead' }`** (other fields stay editable). A new `date`/`startTime` re-derives `status` by the same rule as `POST` unless the event is `cancelled` or the body sets `status` itself.
- `DELETE /events/:id` (admin) → `204` for an event without gauge entries; **`409 { error: 'This event has recorded gauges and cannot be deleted — mark it cancelled instead' }`** otherwise (recorded gauges are pay and revenue history).

## Gauges
- `GET /gauges?userId&eventId&teamId&campaignId&from&to&limit&offset` → `GaugeEntryWithMeta[]` newest first, with the response header **`X-Total-Count`** = number of entries matching the filters (before `limit`/`offset`; exposed through CORS) so clients can page. `limit` defaults to 500 and is capped at 500; `offset` (default 0) skips that many rows (`400` when negative, not a whole number or above 2^53 − 1). Reps are limited to their own entries. `checkedInAt` and `notes` are **`null` on other people's entries** unless the requester is an admin or the leader of that person's team — the same redaction as `GET /events/:id`.
- `POST /gauges` body `GaugeUpsertInput` → `GaugeEntryWithMeta` (201 on create, 200 on update). Upserts on `(eventId, userId, date)`. Runs `validateGaugeFunnel`; on warnings returns `400 { error: 'Invalid funnel', details: string[] }`. **Integrity rules** (checked after the role rules, before the funnel): `date` must equal the event's `date` → otherwise `400 { error: "Gauges are recorded against the event's date" }`; the event must not be `cancelled` → `409`; the event's date must not be in the future → `400`; **an event today accepts gauges only once its `startTime` has passed** → `400 { error: 'Gauges can be recorded once the event has started (HH:MM)' }`; the target user must have status `active` → `400`; and, unless the caller is an admin, the target user must belong to the event's team → `400`. `checkedInAt` may never be later than now → `400 { error: 'Check-in time cannot be in the future' }`. Clients send the event's date, not a free date. On an update, `checkedInAt`/`notes` **omitted** keep the stored values and an explicit **`null` clears** them. The body may carry `id` (the entry the client is editing): when `(eventId, userId, date)` resolves to a different entry — or to none — the request is refused with `409` so a second entry is never created behind an "update"; the edit path is `PATCH`.
- **Paid weeks.** Every gauge write (`POST`, `PATCH`, `DELETE`) first checks the target person's payroll run for that pay week: when it is already `paid`/`late` the write is refused with **`409 { error: 'This week has already been paid — ask an administrator to adjust' }`** unless the caller is an admin. An admin's write goes through, the paid run's figures stay frozen and the run is flagged **`adjustedAt`** (`PayrollRun.adjustedAt`, ISO timestamp) so payslips can say "adjusted after payment". Unpaid runs (`pending`/`failed`) are recomputed from the gauges inside the same transaction (see *Payroll*).
- Each entry **snapshots the money rates** in force when it is first logged (the campaign's `payoutPerSale`, the person's plan `commissionPerSale`); revenue, commission and margin aggregates read those snapshots, so editing a campaign payout or a pay plan only affects days logged from then on (an entry moved to another event/person takes fresh rates).
- `PATCH /gauges/:id` partial `GaugeUpsertInput` → `GaugeEntryWithMeta` — **the edit path** for an existing entry (moving it to another event/user is rejected with `400` when that key is taken; `null` clears `checkedInAt`/`notes`; an `id` in the body is ignored). The same integrity rules apply to the resulting entry (the user-status rule only when `userId` changes, so leavers' history stays editable); both the week the entry leaves and the week it lands in must be unpaid (or the caller an admin).
- `DELETE /gauges/:id` (leader/admin) → `204`; `409` when the week is paid (unless admin).
- **Arrival time recorded on someone's behalf** (release 1.2, review S3). `GaugeEntry.checkInOnBehalf` (optional,
  additive) is `true` when a leader or admin recorded the entry's `checkedInAt` for the person: that time then counts
  for punctuality over the person's own one-tap check-in (see `POST /checkins`). It is `false` otherwise, and wherever
  `checkedInAt` is withheld from the viewer. The person themself (unless an admin) may still edit the entry's counts
  and notes, but cannot change or clear that time, move the entry to another event, day or person, or delete it:
  **`403 { error: 'Your team leader recorded your arrival time on these gauges. Ask them to change it.' }`** ("An
  admin recorded…" when an admin did; "…Ask them to move the entry." / "…Ask them to delete the entry." for a move or
  a delete). Sending the same time back, in any spelling, or leaving it out is not a change. `POST /gauges/bulk`
  reports the same sentence as a row error.
- `GET /gauges/summary?groupBy=user|team|campaign|day|week&from&to&teamId&campaignId&userId` → `GaugeSummaryRow[]` sorted by sales desc (day/week: chronological). `key` is the id (or date), `label` the display name.
- `GET /leaderboard?period=week|month|quarter&metric=sales|conversion&teamId` → `LeaderboardRow[]` (up to 200 rows, i.e. everyone ranked) with the response header `X-Total-Count` = number of people ranked (exposed through CORS). **Competition ranking:** everyone with the same value of the chosen metric shares one rank and the next distinct value skips ahead (1, 2, 2, 4); the other metric only decides the order of the rows inside a tie. `movement` compares with the same to-date span of the previous week/month/quarter (see Dashboard `previous`).

## Finance
- `GET /finance/payroll?userId&teamId&status&from&to` → `PayrollRunWithUser[]` newest first. Reps/recruiters: own only. Leaders: own team. Default range: last 12 weeks. `status` is one status or a comma list (`status=pending,failed` = everything still to pay). When `status` includes `failed` and neither `from` nor `to` is given, failed runs are listed **whatever their week** (a failed transfer is still owed) while every other status keeps the 12-week default; with `from`/`to` the range applies to all. Runs for every completed Mon–Sun week are materialised automatically (see *Payroll* below), so a week that has just closed always has its `pending` runs. `employeeId` is `''` on other people's rows unless the caller is an admin.
- `GET /finance/payroll/:id` → `PayrollRunWithUser & { plan: PayPlan; entries: GaugeEntryWithMeta[] }` (the payslip; same `employeeId` rule). `adjustedAt` (also on every `PayrollRun`) is set when an admin changed the week's gauges after the run was paid; the stored figures are the ones that were paid, `entries` are the gauges as they are now.
- `POST /finance/payroll/:id/pay` (admin) body `{ paidDate?: string }` → `PayrollRunWithUser`. Accepts `pending` **and** `failed` runs and sets status to `paid` or `late` based on due date; `409` only when the run is already `paid`/`late`. `paidDate` (default today) must lie between the pay week's end (`weekEnd`, inclusive) and today → otherwise `400`.
- `GET /finance/summary?from&to` (admin; leader gets own-team payroll view only) → `FinanceSummary`. Default range: last 12 weeks. **The window is snapped to whole Mon–Sun pay weeks** (`from` back to its Monday, `to` forward to its Sunday) and the response's `from`/`to` are the snapped dates, so revenue, payroll and expenses — per week, in `totals`, `byCampaign` and `expensesByCategory` — always cover identical days and a run is never split or double-counted across adjacent months. A week that has started but has no runs yet (the week in progress) carries the live payroll estimate and `FinanceWeek.estimated: true`. Revenue is Σ sales × the **payout snapshotted on each entry** when it was logged, and `byCampaign.commission` Σ sales × the **pay-plan commission snapshotted on each entry** — what the reps actually earned on that campaign's sales (it reconciles with payroll for complete weeks), not the campaign's nominal rate; `margin` = revenue − that commission. Changing a campaign payout or a pay plan therefore never restates past weeks.
- `GET /finance/pay-plans` → `PayPlan[]`: admins get every plan; everyone else gets only the plan they are on (an array of one).
- `GET /finance/expenses?from&to&category&campaignId` (admin) → `Expense[]`. `POST /finance/expenses` (admin) → `Expense` (201). `DELETE /finance/expenses/:id` (admin) → 204.
- `GET /finance/me?weeks=12` → `{ runs: PayrollRunWithUser[]; totals: { gross: number; commission: number; onTimeRate: number | null }; nextPayday: string | null; nextPayAmount: number | null }` (the signed-in user's earnings). `nextPayday`/`nextPayAmount` are the earliest **unpaid** run (`pending` or `failed`), even when it is overdue; only when nothing is owed do they fall back to the live estimate of the current week.

## Recruitment (recruiter, leader, admin)
- `GET /recruitment/candidates?stage&ownerId&source&q&open=true` → `CandidateWithMeta[]` (`open=true` excludes terminal stages). Sorted by `stageUpdatedAt` desc.
- `GET /recruitment/candidates/:id` → `CandidateWithMeta & { history: StageChange[]; interviews: Interview[] }`.
- `POST /recruitment/candidates` body: `Pick<Candidate,'firstName'|'lastName'|'email'> & Partial<Candidate>` → `CandidateWithMeta` (201). Creates an `applied` stage change. `nextActionAt` omitted → today + 3 days (the Applied target, 1.1); `null` → no deadline; any other value must be a valid deadline (see *Recruitment SLAs*), else `400`. **`409 { error: 'A candidate with that email is already in the pipeline (#id)' }`** when an open (non-terminal) candidate has the same email (case-insensitive); a closed candidate may re-apply.
- `PATCH /recruitment/candidates/:id` partial `Candidate` (not `stage`) → `CandidateWithMeta`. Changing `email` onto one that is open in the pipeline → `409`. The deadline changes only when the body sets `nextActionAt`, and it must be a valid deadline (1.1).
- `POST /recruitment/candidates/:id/stage` body `{ stage: CandidateStage; note?: string; teamId?: number | null; position?: 'trainee' | 'field_rep'; nextActionAt?: string | null }` → `CandidateWithMeta`. Records a `StageChange`. The new stage's next-action deadline is today + that stage's target unless the body sets `nextActionAt` (1.1; closed stages always get `null`; see *Recruitment SLAs*). **Stage machine** (anything else → `409`): from an open stage a candidate may move **forward** any number of steps along `applied → screening → interview → observation → offer`, **back one step**, or to `rejected`/`withdrawn`; **`hired` only from `offer`**. Terminal stages are immutable, except that an **admin may reopen a `rejected`/`withdrawn` candidate to `offer`**; `hired` is final. Moving to `hired` creates a `User` and sets `hiredUserId`: role `rep`, `teamId` from the body (default: the owner's team, else none; unknown team → `400`), `position` from the body (default: the application's position when it is `trainee`/`field_rep`, else `trainee`), the server's default pay plan for that position (a `payPlanId` in the body is ignored), `startDate` = today, the next free `LM-xxxx`, and a `first.last@linear-mcr.co.uk` address built from the name with accents transliterated to ASCII (`Łukasz Żółć` → `lukasz.zolc@…`; an untranslatable part is dropped, `staff@…` when nothing is left; a taken address gets a number). The hire is refused with **`409`** when a user with the candidate's email already exists or another candidate with that email was already hired. Leaders and owners cannot be minted through recruitment.
- `GET /recruitment/interviews?from&to&candidateId` → `Interview[]`. `POST /recruitment/interviews` → `Interview` (201). `PATCH /recruitment/interviews/:id` → `Interview`.
- `GET /recruitment/summary?from&to` → `RecruitmentSummary`. Default range: last 12 weeks. `weekly` buckets are **clipped to the requested range** (the first bucket is keyed by `from` when the range starts mid-week, the last ends at `to`), so the bars add up to `applied`/`hired`. `overdueActions` uses the shared `isOverdue` rule: a date-only `nextActionAt` is overdue from the next calendar day, a timestamp once now is past it.

## Misc
- `GET /announcements[?limit=&offset=]` → `Announcement[]` (pinned first, newest first, the id breaking a tie). Every signed-in role reads every announcement. Without `limit`, all of them (as before); `limit` (1–50, a larger number is capped at 50) and `offset` (≥ 0) page through the same order, so `?offset=5&limit=20` is the twenty after the dashboard's latest five (its **Older announcements** list). `limit` of 0, a negative number or not a whole number → 400; the same for `offset`, which must also be a safe integer (at most 2^53 − 1, as on `GET /audit` and `GET /gauges`); empty values are ignored. `POST /announcements` (admin, leader) → `Announcement` (201).
- `GET /health` → `{ ok: true, version: string, seededAt: string }` (`version` is read from `server/package.json`, `"1.1.0"`). An admin session also gets `backup` (see *Backups, health and compression*).

## Smart endpoints

Release 1.1 ("smart release"). Every change is **additive**: no response field was renamed or removed, and every new
field on an existing payload is optional. Role scoping is unchanged and every smart payload is built from data the
caller may already see. **Kill switch:** with `LM_SMART=0` every smart part below is null / empty, and the optional
keys on existing payloads are absent (the 1.0 shapes exactly). Recruitment SLAs are not switched off: they are
workflow rules, not estimates, so `POST /recruitment/candidates` and `POST /recruitment/candidates/:id/stage` still set
the stage's default `nextActionAt` when the body leaves it out (send `nextActionAt: null` for no deadline). Backups
(`LM_BACKUP`) and compression (`LM_COMPRESSION`) have their own switches, and the phone outbox adds no endpoint.
Types are in `shared/src/types.ts` ("Smart release 1.1"). The rules behind every field are in LOGIC.md §14.

| Endpoint | Who | Answer | Cached |
|---|---|---|---|
| `GET /me/insights` | every signed-in role | `SmartInsights` | yes |
| `GET /me/attention` | every signed-in role | `AttentionFeed` | yes |
| `GET /me/digest?week=YYYY-MM-DD` | every signed-in role | `WeekDigest` | yes |
| `GET /events/forecast?campaignId&teamId&type&targetSales` | admin, leader (own team) | `{ forecast: EventForecast \| null }` | yes |

- `GET /me/insights` → `SmartInsights { generatedFor, personal: { baseline, direction, streaks, payForecast }, boardStreaks, team, company }`.
  `personal` is always the caller's own (each part null when it does not apply). `boardStreaks` (`{ userId, streak }[]`,
  streaks ≥ 5 only): rep and leader with a team — their own team; admin — every active rep and leader; recruiter and
  anyone without a team — `[]`.
  `team` = `{ checkIns: CheckInPerson[] }` **only for a leader with a team** (own team, never the leader); `company` =
  `{ checkIns }` **only for an admin** (every team, never the admin). Reps and recruiters always get `team: null` and
  `company: null`.
- `GET /me/attention` → `AttentionFeed { items: AttentionItem[], generatedAt, disabled? }`, sorted danger → warning →
  info, then newest first, at most 20. Keys are deterministic, so a resolved item disappears by itself. `disabled: true`
  appears only with `LM_SMART=0` (then `items` is `[]`).
- `GET /me/digest?week=YYYY-MM-DD` → `WeekDigest { weekStart, weekEnd, role, title, bullets, text }`. Any date
  normalises to its Monday; the default is the last completed week; a week that has not finished yet, or one before
  2020, → `400`. `text` holds only the shareable bullets (plain text, no markdown or HTML).
- `GET /events/forecast?campaignId&teamId&type&targetSales` (admin; leader for their own team, otherwise `403`; rep and
  recruiter `403`) → `{ forecast: EventForecast | null }`. `campaignId`, `teamId` and `type` are required (`400`
  otherwise); `targetSales` is optional, a whole number 0–500. `null` when there is not enough comparable history.

New fields on existing payloads (optional keys are absent when not computed and with `LM_SMART=0`; the two exceptions
are noted in their rows: `/finance/me`'s `forecast` is always present, and `backup` does not depend on `LM_SMART`):

| Field | On | Rule |
|---|---|---|
| `forecast?: EventForecast` | `GET /events`, `GET /events/:id` (`SalesEventWithMeta`) | scheduled and live events with enough history only; otherwise the key is absent (the type allows `null`, the server never sends it) |
| `roster?: EventRosterCount` (`{ members, logged }`) | `GET /events`, `GET /events/:id` (`SalesEventWithMeta`) | completed and live events dated today − 2 … today only; counts, no names |
| `streak?: number` | `GET /leaderboard` rows (`LeaderboardRow`) | every ranked row: the person's current sales streak in worked days over the last 180 days (0 when none) |
| `flags?: PayrollFlag[]` | `GET /finance/payroll`, `GET /finance/payroll/:id` (`PayrollRunWithUser`) | **admins only**, pending / failed runs only (at most 80 per call, newest weeks first; `[]` when a checked run looks normal); advisory, never blocks paying |
| `forecast: PayForecast \| null` | `GET /finance/me` | always present; null for recruiters, admins, anyone without a team or a pay plan, and with `LM_SMART=0`; an estimate — `nextPayAmount` stays the official figure |
| `backup?: BackupStatus & { enabled? }` | `GET /health` | admins only, whatever `LM_SMART` says; not cached |

Request bodies (Recruitment SLAs, not switched off by `LM_SMART=0`): `nextActionAt` on `POST /recruitment/candidates`,
`PATCH /recruitment/candidates/:id` and the new optional `nextActionAt` on `POST /recruitment/candidates/:id/stage`.

### Pace and streaks (p2)

No new endpoint. Pace and streaks fill parts of two cached payloads (both switched off by `LM_SMART=0`).

**`GET /me/insights` → `personal.baseline`, `personal.direction`, `personal.streaks`, `boardStreaks`**

| Field | Type | Who gets a value | Notes |
|---|---|---|---|
| `personal.baseline` | `PersonalBaseline \| null` | the caller only; null for recruiters, new starters (fewer than 4 worked weeks in the last 8) and anyone under 20 stops a day | `weeks`, `stopsPerDayMean` (μ), `stopsPerDaySd` (σ), `conversion` (pooled usual rate, 0..1), `current` {`days`, `stops`, `sales`, `stopsPerDay`, `conversion`}, `alerts` (0–2) |
| `personal.baseline.alerts[]` | `BaselineAlert` | — | `metric` `stopsPerDay`\|`conversion`, `tone` `warning`\|`positive`, `z` (2 dp), `current` and `usual` (stops a day, or conversion 0..1), `title`, `body` (ready-to-show sentence) |
| `personal.direction` | `TrendDirection \| null` | the caller only; null for recruiters and when either 8-week half has under 400 stops | `label` `improving`\|`declining`\|`steady`, `z`, `earlierConversion`, `recentConversion`, `earlierStops`, `recentStops` |
| `personal.streaks` | `Streaks \| null` | the caller only; null for recruiters and for anyone with no gauge rows before today | `current`, `best` (worked days in a row with ≥ 1 sale), `personalBestWeek`, `weekSales` (Monday to yesterday), `bestPreviousWeekSales` (best earlier week with ≥ 3 worked days; 0 when none) |
| `boardStreaks` | `{ userId, streak }[]` | rep / leader with a team: their own team; admin: every active rep and leader; recruiter (and anyone without a team): `[]` | only streaks ≥ 5, longest first (ties by user id); counted over the last 180 days |

Nobody can read another person's baseline, direction or personal-best flag: they exist only inside the caller's own
`/me/insights.personal`. Only the streak number appears for other people, on boards the caller can already see.

**`GET /leaderboard` → `row.streak`** (optional number): every ranked row carries its person's current streak over the
last 180 days (0 when they have no selling run). Absent with `LM_SMART=0`.

Cost: one grouped SQL statement per builder (`personalPace` is one `weeklyHistory` call for 16 weeks + this week;
`personalStreaks`, `streaksForUsers`, `boardStreaks`) and no writes. On the seeded demo database
`/leaderboard?period=quarter` with streaks answers in about 12 ms uncached; a cached `/me/insights` in under 2 ms.

### Pay forecast and payroll checks (p3)

**Pay forecast** — `forecast` on `GET /finance/me`, `personal.payForecast` on `GET /me/insights` (same builder, same
numbers). `GET /finance/me` always carries the key; it is `null` with `LM_SMART=0`, for admins and recruiters, for
anyone without a team, and for anyone without a pay plan. It is only ever the caller's own estimate. `/finance/me` is
not in the response cache; `/me/insights` is.

| Field | Meaning |
|---|---|
| `weekStart` | Monday of the current pay week |
| `payday` | the Friday after the week ends (`paydayForWeek`) |
| `estimate` | always `true` |
| `soFar` | `{ days, sales, gross }` logged this week so far (`weekPayFor(monday, today)`; `gross` = `estimateWeekPay` of it) |
| `remainingDays` | team event days still to come this week (LOGIC §14.3) |
| `low`, `likely`, `high` | GBP gross for the whole week, `low ≤ likely ≤ high` |
| `bonusThreshold`, `bonusAmount` | from the person's plan |
| `bonusGap` | sales still needed for the bonus (0 when reached, or when the plan has no threshold) |
| `bonusProbability` | 0–1 chance of reaching the bonus this week |
| `bonusLikelihood` | `'reached' \| 'likely' \| 'possible' \| 'unlikely' \| 'none'` |
| `stopsForBonus` | stops needed at the person's own conversion to close the gap, or `null` |
| `basis` | `{ weeks, workedDays, salesPerDay }` — the history the estimate rests on (`weeks = 0` → no range) |
| `sales` (optional) | `{ low, likely, high }` projected week sales behind the three money figures |

The forecast is never written anywhere: no payroll run, no gauge row. `nextPayday` / `nextPayAmount` are unchanged and
stay the official figures.

**Payroll checks** — `flags` on `GET /finance/payroll` and `GET /finance/payroll/:id`:
`PayrollRunWithUser.flags?: PayrollFlag[]` with `PayrollFlag = { code, severity: 'info' | 'warning', text }`.

- **Admins only.** Leaders, reps and recruiters never get the key, not even on their own runs or payslip.
- **Unpaid runs only** (`pending` or `failed`). Paid and late runs never carry the key.
- At most **80 runs per call** are checked, newest weeks first; a checked run always has the key (`[]` when nothing
  is unusual), an unchecked one has none. `GET /finance/payroll?status=pending,failed` (the **Runs to pay** card) is
  the normal caller. Not cached: about 14 ms for the seed's 31 unpaid runs (3 ms with `LM_SMART=0`), roughly 30 ms at
  the 80-run cap.
- Advisory only: `POST /finance/payroll/:id/pay` never looks at flags.

| `code` | `severity` | Example `text` |
|---|---|---|
| `first_payslip` | info | First payslip for this person — check their bank details and pay plan before paying |
| `high_gross` | warning | £780 is 2.6× the usual £305 (median of the last 4 runs) |
| `bonus_single_day` | warning | The £75 bonus rests on one day: 9 sales against a usual 2 sales a day — worth checking that day's gauges |
| `sales_without_days` | warning | 2 sales with no days worked — a gauge row may be missing its date |
| `high_deductions` | warning | Deductions of £300 take 60% of the £500 earned |
| `stale_amount` | warning | The gauges changed since this run was calculated: they now give £795, not £600 |
| `override_no_days` | info | £120 of team overrides with no days worked this week |

**Bulk "Mark paid"** (no new endpoint). The **Runs to pay** card pays a selection by calling the existing
`POST /finance/payroll/:id/pay` once per run, one after another (never in parallel), with `{ paidDate }` only when the
admin picked a date other than today. Outcomes: `200` = marked paid, `409` (already paid / late) = **skipped**,
anything else = **failed**; a `401`/`403` stops the batch and the rest are reported as failed without being sent. The
client invalidates `['finance']` and `['dashboard']` once, after the last run. While a batch runs, the single
**Mark paid** buttons and the boxes are disabled, so a click cannot race a run that is later in the batch. The server
still validates every date (`weekEnd ≤ paidDate ≤ today`, else `400`).

### Check-ins (p4)

No new endpoint and no schema change: `team.checkIns` and `company.checkIns` on **`GET /me/insights`** carry people
(`server/src/lib/smart/checkIns.ts`).

| Caller | `team` | `company` |
|---|---|---|
| leader with a team | `{ checkIns }`: their own team, never the leader | `null` |
| admin | `null` | `{ checkIns }`: every team, never the admin |
| rep, recruiter, leader without a team | `null` | `null` |
| anyone with `LM_SMART=0` | `null` | `null` |

`checkIns` is `CheckInPerson[]`, at most **5** people, each with a score of at least **2**, highest score first and
then by name:

| Field | Type | Meaning |
|---|---|---|
| `userId`, `userName`, `position`, `avatarColor` | | the person (status `active`, role `rep` or `leader` only) |
| `teamId`, `teamName` | number \| null, string \| null | their current team |
| `score` | integer ≥ 2 | sum of the reason weights |
| `reasons` | `CheckInReason[]` | heaviest first; ties in a fixed order (LOGIC §14.4) |

`CheckInReason` = `{ code, weight, text }`. `code` is one of `sustained_decline`, `conversion_drop`, `stops_drop`,
`attendance_drop`, `zero_week`, `earnings_drop`, `trainee_slow` and `late_often`. `text` is a finished British-English
sentence.

- **Scoping.** The builder reads only people in the caller's scope, and their team's own calendar and check-ins. A
  rep's or recruiter's payload never contains a check-in list.
- **Caching.** Part of `/me/insights`: cached per user (20 s, cleared by any write).
- **Cost.** 7 SQL statements per list, whatever the team size; 1 when nobody is in scope, none with `LM_SMART=0`. On
  the demo seed an admin's uncached `GET /me/insights` takes about 17–33 ms (the route test asserts under 150 ms).
- **Writes.** Only the payroll guard can write, exactly as `/finance` does: when last completed week has no payroll
  runs yet (a server left running over the weekend, before the daily job), it creates them first, so that week is
  never read as £0. Nothing else is written, and never a gauge row.
- **Shared API (client and tests).** `coachingInsights(totals, ratios, benchmarks = BENCHMARK_RATIOS, subject = 'you')`
  gains an optional `subject: 'you' | 'team' | 'company'` (`InsightSubject`). With `'you'` the output is byte-for-byte
  what it was before. Team and company coaching and the Focus chips are worked out in the browser, so they need no
  endpoint and stay on with `LM_SMART=0`.

### Needs attention (p5)

**`GET /me/attention` → `AttentionFeed`.** Every signed-in role. Cached per user through `CACHED_PATHS` (20 s, cleared
by any write), so a repeat call within 20 s answers `X-Cache: HIT`. No query parameters. There is no table behind it:
the feed is derived on every uncached request from rows the caller may already see.

```jsonc
{
  "items": [
    {
      "key": "gauges:gap:516",            // deterministic: the same thing always has the same key
      "kind": "gauges",                   // gauges | pay | payroll | events | recruitment | security
      "severity": "warning",              // danger | warning | info
      "title": "1 of 7 has not logged BCN — MediaCity Piazza",
      "body": "Noah has no gauges for Sat 17 Oct yet: a quick message usually sorts it.",
      "href": "/gauges?log=1&eventId=516&userId=23",
      "actionLabel": "Log for Noah",      // optional
      "at": "2026-10-17T17:00",           // optional: what the item is about (date, wall time or ISO timestamp)
      "count": 1                          // optional: how many a summary covers (gap, follow-ups, runs, interviews)
    }
  ],
  "generatedAt": "2026-10-19T14:00:11.794Z",
  "disabled": true                        // optional, only with LM_SMART=0 (then items is always [])
}
```

- Sorted danger → warning → info, then newest `at` first (items without `at` last), then by key. At most 20 items.
- **Role scoping** (applied in the route before any rule runs; the rules only ever narrow):

  | Role | Events / gauge rows | Members | Pay runs | Recruitment |
  |---|---|---|---|---|
  | rep | own team's events; **own** rows only | themself | own | none |
  | leader | own team's events and rows | own team (active) | own | candidates they own; interviews they run or own |
  | recruiter | none | themself | own | open candidates they own or nobody owns; interviews they run or own |
  | admin | every team | everyone active | own, plus every pending / failed run in the to-pay window | everything |

  A rep never receives `gauges:gap`, `gauges:odd`, `events:empty`, `events:behind`, `payroll:*`, `recruitment:*` or
  `security:*` items, and never anything about another person's rows or pay.
- **Queries**: `ensurePayrollMaterialised(db, today)` first (as the finance routes do, so last week's runs exist before
  they are counted), then at most 8 statements (admin 6, leader 8, recruiter 3, rep 5): pay plan; events dated
  `from` … tomorrow and gauge rows dated `from` … today (`from` = `attentionLookbackFrom(today)`: today − 3, or this
  week's Monday when that is earlier); active members; runs (unpaid, or paid in the last 7 days; admin also the to-pay
  window); open candidates with a follow-up already due; pending interviews of open candidates from
  `outcomeLookbackFrom(now)` (56 days back) to 2 days ahead; and the caller's usual attendance over the 28 days before
  the window. Events, gauge rows, runs and the attendance count are date-bounded and use their indexes; open
  candidates, interviews and the admin's member list are small full scans (there is no index on
  `interviews.scheduled_at`; worth adding in `db/schema.ts` if the interview table grows). Uncached it answers in a
  few milliseconds on the seed. Nothing is written except the payroll materialisation the finance routes already do;
  no gauge row is ever created.
- `count` (optional, additive) is set on the summary items `gauges:gap` (people missing), `recruitment:overdue`
  (follow-ups), `recruitment:today` (interviews) and `payroll:to-pay` (runs); the client uses it so a summary that
  grows counts as new again.
- Item keys: `gauges:event:<eventId>:user:<userId>`, `gauges:gap:<eventId>`, `gauges:odd:<entryId>`,
  `events:tomorrow:<eventId>`, `events:empty:<eventId>`, `events:behind:<eventId>`, `pay:overdue:<runId>`,
  `pay:due-tomorrow:<runId>`, `pay:paid:<runId>`, `payroll:to-pay`, `payroll:due-today:<date>`, `recruitment:overdue`,
  `recruitment:interview:<interviewId>`, `recruitment:today`, `security:2fa`. What fires each one is in LOGIC §14.5.
- `LM_SMART=0` → `{ "items": [], "generatedAt": …, "disabled": true }` (the client hides the card and the bell count).

### Event forecasts (p6)

No schema change. Two optional fields on the event payloads and one new endpoint
(`server/src/lib/smart/eventForecast.ts`: `eventForecasts`, `eventRosters`, `forecastFor`).

**`forecast?: EventForecast` on `GET /events` and `GET /events/:id`** (`SalesEventWithMeta`)

- Present only on **scheduled** and **live** events that have enough history (LOGIC §14.6). Completed and cancelled
  events never carry the key; neither does any event with `LM_SMART=0`. Every role that can list an event gets its
  forecast: it is a team-level estimate, never anyone's personal figure. Reps only ever list their own team's
  calendar, as before.

| Field | Type | Meaning |
|---|---|---|
| `expectedSales` | number (1 dp) | E = expectedReps × perRepRate |
| `low` / `high` | number (1 dp) | max(0, E − 1.64√E) / E + 1.64√E |
| `expectedReps` | number (1 dp) | mean distinct reps over the team's recent completed events |
| `perRepRate` | number (2 dp) | sales per rep-day in the chosen bucket |
| `repsNeeded` | integer \| null | ⌈targetSales ÷ perRepRate⌉ |
| `basisDays` | integer ≥ 5 | completed event days in the chosen bucket |
| `basis` | `'team' \| 'company' \| 'campaign'` | which bucket supplied the rate |
| `flag` | `'stretch' \| 'at_risk' \| null` | scheduled: `stretch`; live: `at_risk` (shown as **Behind target**) |
| `suggestedTarget` | integer | a suggestion only; never applied by the server |

**`roster?: { members, logged }` on `GET /events` and `GET /events/:id`** (`EventRosterCount`)

- Present on **completed** and **live** events dated **today − 2 … today** (business clock), absent otherwise and
  with `LM_SMART=0`. `members` is the event team's **active** members who had **started by the event date**;
  `logged` is how many of **them** have an entry. Admins with no team, and people from other teams who logged at the
  event, are not counted, so `logged ≤ members` always. `repCount` is unchanged and still counts everyone with an
  entry, so it can be larger than `logged`. Counts only (no names), for events the caller can already list.

**`GET /events/forecast?campaignId&teamId&type[&targetSales]`** → `{ forecast: EventForecast | null }`

- Admin for any team; a leader for their own team only (another team → `403 { error: 'Leaders can only forecast events
  for their own team' }`); reps and recruiters `403`. `campaignId` and `teamId` (positive integers) and `type`
  (`private_site | event | b2b | residential | retail`) are required, `targetSales` is optional (a whole number
  0–500); anything else is `400 Validation failed`. Cached (`CACHED_PATHS`).
- The forecast is for a new **scheduled** event of that team, campaign and type. Without `targetSales`, `repsNeeded`
  and `flag` are `null`. The answer is `{ forecast: null }` when the team has fewer than 5 attended days in 8 weeks,
  when no bucket has 5 completed days in 12 weeks (a brand-new campaign, for example), or with `LM_SMART=0`.

**Cost.** `GET /events` and `GET /events/:id` are not in the response cache, so one request makes at most **3
grouped SQL statements** whatever the number of events (forecast attendance, forecast rates, roster counts), each
skipped when no listed event needs it, and memoised per data version and business day (LOGIC §14.6). Nothing is ever
written. Measured on the demo seed (business clock pinned at 15:00, 300 sequential requests, 2 rounds), before 1.1 →
1.1.0:

| Request | Mean ms | Req/s at 50 connections |
|---|---|---|
| admin `GET /events` (89 events) | 4.6–5.8 → 5.6–6.1 | 237–272 → 205–247 |
| admin, next 2 weeks (47 events) | 3.3–3.5 → 4.0–4.5 | — |
| leader, next 2 weeks | 3.6–3.8 → 4.2–4.3 | 426–460 → 377–392 |
| rep `GET /events` | 2.9–3.4 → 3.0 | — |
| admin `GET /events/527` | 4.1–4.5 → 4.3–4.9 | — |

The remaining gap is mostly payload: the admin list grows from 43 to 55 kB with the two new fields.

**Client only (no API).** Directions links are built in the browser as
`https://www.google.com/maps/search/?api=1&query=<encodeURIComponent("venue, city")>`. The dashboard's
**Upcoming events** card fetches `GET /events?from=<first upcoming date>&to=<last>[&teamId]` and matches forecasts
by event id; `/me/dashboard` is unchanged. The event page's "Not logged yet" list uses
`GET /users?teamId&status=active`, which only runs for the admin or that team's leader.

### Logging when the signal drops (p7)

**No endpoint was added or changed.** The phone's outbox replays through the existing gauge routes, and every role
rule, the funnel check, the paid-week lock and the check-in rules still apply to a replayed save. Not affected by
`LM_SMART=0`.

| Step | Request | Meaning |
|---|---|---|
| Look the day up | `GET /gauges?eventId=&userId=&from=<date>&to=<date>&limit=5` | The entry the server holds now for that (event, person, date), if any. A rep may only read their own (403 otherwise). |
| Send | `POST /gauges` (the upsert) | **201**: logged. **200**: the server found the day and updated it. Any other **4xx** (400 future check-in or event not started, 403 scope, 409 week paid or event cancelled): the item is marked *Not accepted* with the server's message. **401**: replay stops and the item waits for the next sign-in. **5xx**: replay stops and tries again later. |

The `(eventId, userId, date)` upsert makes a repeated send idempotent: the same body sent twice answers 201, then 200,
and leaves one row (`server/src/test/p7-outbox-replay.test.ts`). While the offline banner shows, the client asks
`GET /health` every 30 seconds to notice the connection coming back.

Client contract (`client/src/api/client.ts`, additive):

| Name | What it is |
|---|---|
| `NetworkError` / `isNetworkError(e)` | Thrown when `fetch` gets no HTTP answer at all (it threw a `TypeError`: no signal, the hotspot dropped, the server is stopped). Every HTTP error response is still an `ApiError`, unchanged. An abort (`DOMException`) passes through untouched. |
| `window` event `lm:network`, `detail: { online }` | `false` when a request got no answer; `true` whenever any HTTP response arrives, whatever its status. |
| Unhandled `NetworkError` | A rejection nobody caught (for example signing out without signal) is not printed as "Uncaught (in promise)": the offline banner already reports it. Other rejections are untouched. |

Storage on the phone (per browser, never sent anywhere):

| Key | Holds |
|---|---|
| `lm-gauge-outbox:<signed-in userId>` | Up to 50 queued saves: `{ id, queuedAt, input: GaugeUpsertInput, expectedExistingId, seenSubmittedAt, eventName, userName, status: 'waiting' \| 'review' \| 'failed', error?, server? }` |
| `lm-tally:<userId>:<eventId>:<date>` | `{ counts: GaugeTotals, updatedAt }` for one shift's tally |
| `lm-attention-seen:<userId>`, `lm-attention-toasted:<userId>` | Needs-attention tokens already seen in the bell / already shown as a pop-up (p5) |

### Recruitment SLAs (p8)

No new endpoints and no response-shape changes: two write routes gain **defaults**, one gains an **optional body
field**, and all three that take a deadline now **validate it the same way**. `GET` payloads are untouched (idle days
are worked out by the client from `stageUpdatedAt`; outcome prompts come from the shared `needsOutcome` rule, on the
candidate page and in `GET /me/attention`'s `recruitment:interview` items). "Today" is the server's business date
(`todayISO()`, Europe/London, honouring the business clock).

**`POST /recruitment/candidates`**

- `nextActionAt` **omitted** → `today + 3 days` as a date-only `YYYY-MM-DD` (the Applied target), e.g. created on
  Mon 19 Oct → `"2026-10-22"`.
- `nextActionAt: null` → stays `null` (no deadline).
- An explicit value is stored as given, if it is a valid deadline (below).

**`POST /recruitment/candidates/:id/stage`** — body `{ stage; note?; teamId?; position?; nextActionAt?: string | null }`
→ `CandidateWithMeta` (unchanged).

| `nextActionAt` in the body | Open target stage (`applied` … `offer`) | Closed target stage (`hired`, `rejected`, `withdrawn`) |
|---|---|---|
| omitted | `today + STAGE_SLA_DAYS[stage]`, date-only (`screening` on 19 Oct → `"2026-10-24"`) | `null` |
| `null` | `null` (no deadline) | `null` |
| `"YYYY-MM-DD"` or an ISO 8601 timestamp | stored as given | `null` (ignored) |

- This **replaces 1.0's behaviour of carrying the previous stage's deadline forward**: a move now starts the new
  stage's clock. Targets: applied 3, screening 5, interview 7, observation 7, offer 7 days.
- An admin reopening a `rejected`/`withdrawn` candidate to `offer` gets the Offer target (`today + 7`).
- `nextAction` (the text) still follows the stage (`Book first interview`, …) and is `null` for closed stages.
- `PATCH /recruitment/candidates/:id` never touches the deadline unless the body sets it.
- Effect on `GET /recruitment/summary`: a candidate moved without an explicit date is never overdue, so
  `overdueActions` drops as people are moved on.

**Valid deadlines** (create, patch and stage move alike). `nextActionAt` accepts `null`, a real calendar date
`YYYY-MM-DD` (due that day, overdue from the next), or an ISO 8601 timestamp starting `YYYY-MM-DDT…` whose calendar day
exists (`2026-10-24T17:00:00Z`, `2026-10-24T09:15:00+01:00`, `2026-10-24T09:15`). Anything else — `"garbage"`,
`"2026-02-31"` (which `Date` would quietly roll over to 3 Mar), `"Oct 24 2026"`, `"24/10/2026"`, `""`, a number, a
boolean — is **`400 { error: 'Validation failed', details: [{ path: 'nextActionAt', message: 'Expected a date
(YYYY-MM-DD) or an ISO 8601 timestamp' }] }`** and nothing changes. This
tightens create and patch, which in 1.0 took anything `Date.parse` could read; every value the app and the smoke test
send is still accepted.

**Kill switch.** `LM_SMART=0` does not turn these off (lead decision): the deadline defaults, the **Idle** badges and
the candidate page's **Record the outcome** card are workflow rules, not estimates, and the client states the deadline
it expects a move to set ("Phone screen · due Sat 24 Oct"); switching the server default off behind the client's back
would make that line wrong. With `LM_SMART=0` the dashboard's outcome reminders are off with the rest of the
Needs-attention feed. A caller that wants no deadline sends `nextActionAt: null`.

### Week in review (p9)

**`GET /me/digest?week=YYYY-MM-DD` → `WeekDigest`.** Every signed-in role (`401` without a session). Answers the
caller's own "Your week in review" for one completed Monday–Sunday week. Cached per user and URL through
`CACHED_PATHS` (20 s, cleared by any write; `X-Cache: MISS`, then `HIT`).

| Query | Rule |
|---|---|
| `week` (optional) | Any date in the week; it is normalised to its Monday. Default: the **last completed week** (the Monday before this week's). |
| errors | `400 { error: 'That week has not finished yet' }` when its Sunday is today or later (this week and every future week); `400 { error: 'Weeks before 2020-01-01 are not supported' }` when it starts before 2020; `400 Validation failed` when `week` is not a `YYYY-MM-DD` date. |

| Field | Type | Meaning |
|---|---|---|
| `weekStart`, `weekEnd` | string | Monday and Sunday of the week |
| `role` | `Role` | the caller's role (decides which bullets are built) |
| `title` | string | `Your week in review · w/c 12 Oct` |
| `bullets` | `DigestBullet[]` | 5–8 lines `{ text, private }`; shareable lines first, private lines last |
| `text` | string | WhatsApp-ready plain text: the title, a newline, then one `• ` line per **shareable** bullet. Private bullets are never in it. No markdown, no HTML (`<`, `>`, `*`, `#`, `_`, `~` and backticks are stripped from names and lines). `''` when nothing is shareable. |

`DigestBullet.private` is `true` for: the rep's own pay for the week, the leader's check-in count, and the admin's
payroll and failed-transfer lines. Nothing else. Which lines each role gets is in LOGIC §14.9.

With `LM_SMART=0` the endpoint still answers `200` with the title, `bullets: []` and `text: ''` (the dashboard card then
stays hidden). The route never writes, apart from `ensurePayrollMaterialised` — the finance routes' guard that creates
last week's pending payroll runs if the daily job has not yet (never a gauge row).

Example (leader):

```json
{
  "weekStart": "2026-10-12", "weekEnd": "2026-10-18", "role": "leader",
  "title": "Your week in review · w/c 12 Oct",
  "bullets": [
    { "text": "Northern Lights made 91 sales — up 20 on the week before.", "private": false },
    { "text": "Team conversion 4.4% from 2,074 stops — up from 4.1% the week before.", "private": false },
    { "text": "Top seller: Amelia Hart with 22 sales.", "private": false },
    { "text": "Biggest move up: Amelia Hart, 2 places to 1st.", "private": false },
    { "text": "Biggest move down: Oliver Bennett, 2 places to 3rd.", "private": true },
    { "text": "4 of 31 recorded check-ins were late (more than 5 minutes after the start).", "private": false },
    { "text": "Next week (w/c 19 Oct): 5 events, expect about 85 sales (estimate 70–100) against targets of 84.", "private": false },
    { "text": "Nobody is on your check-in list this week.", "private": true }
  ],
  "text": "Your week in review · w/c 12 Oct\n• Northern Lights made 91 sales — up 20 on the week before.\n• …\n• Next week (w/c 19 Oct): 5 events, expect about 85 sales (estimate 70–100) against targets of 84."
}
```

**Version.** `GET /api/health` reports `"version": "1.1.0"` (read from `server/package.json`). The root, shared,
server and client `package.json` files (and the workspace entries in `package-lock.json`) are 1.1.0, and **About**
shows **Version 1.1.0** (`client/src/content/about.ts`, `APP_VERSION`).

### Backups, health and compression (p10)

Not switched by `LM_SMART`. The operator's side (scripts, the backups folder, the background service) is in README.md;
the rules are in LOGIC §14.10.

**`GET /api/health` — `backup` for administrators (additive).** Unchanged for everyone else: `{ ok, version, seededAt }`.
When the request carries an **admin** session, the response also has `backup` (`BackupStatus` in
`shared/src/types.ts`, plus `enabled`):

| Field | Type | Meaning |
|---|---|---|
| `backup.lastAt` | `string \| null` | ISO time of the last backup; `null` when there has been none |
| `backup.file` | `string \| null` | its file name, e.g. `linear-2026-10-19-0200.sqlite` |
| `backup.count` | `number` | backup files kept in the folder now |
| `backup.dir` | `string` | absolute path of the backup folder on the server |
| `backup.enabled` | `boolean` (optional) | `false` when this server was started with `LM_BACKUP=0`, so it makes no automatic backups (`npm run backup` still works); `true` otherwise |

- The health router runs after `authenticate`, so `req.user` is set for a signed-in request. Leaders, recruiters,
  reps and anonymous probes (`npm run stop`, `npm run share`, `npm run doctor`, `loadtest/lag.mjs`) never see the key.
  Covered by `server/src/test/backups.test.ts`.
- `lastAt`/`file` are the newer of the meta record (`last_backup_at`, `last_backup_file`) and the newest file in the
  folder (after a restore the meta table is the backup's own, older record).
- Not cached (not in `CACHED_PATHS`); one `readdir` of the backup folder per admin request.
- `enabled` is declared next to the route (`BackupStatus & { enabled?: boolean }`), so `shared/src/types.ts` is
  unchanged; Settings reads it the same way.

**HTTP compression (every response).**

- `gzip` (level 6) for JSON, HTML, JavaScript, CSS and SVG responses of **1 KB or more** when `Accept-Encoding`
  allows it; `br` (brotli quality 4) only when the client **prefers** it (ranks `br` above `gzip` with q-values, or
  accepts only `br`). Browsers send `gzip, deflate, br, zstd` without q-values and get gzip.
- Headers: `Content-Encoding`, an exact `Content-Length` (the compressed size), `Vary: Accept-Encoding` on every
  compressible response (compressed or not), and no `Accept-Ranges` on a compressed one.
- Left alone: `HEAD`, `204`, `206` (ranges), `304`, any non-2xx, responses that already have a `Content-Encoding`,
  `Cache-Control: no-transform`, bodies under 1 KB, other types (PNG, fonts…), and clients without a usable
  `Accept-Encoding`.
- ETags are unchanged (Express's are weak, so one ETag for both encodings is correct); `If-None-Match` still gives a
  `304` with no body. `X-Cache: HIT` replays from the response cache are compressed exactly like a fresh response.
- `LM_COMPRESSION=0` turns it off (for example behind a reverse proxy that compresses already).
- On the wire: the SPA shell 2,112 B → 908 B, the main JS bundle 449 kB → 139 kB, an admin
  `/api/me/dashboard?range=week` 6,302 B → 2,250 B (57–69% fewer bytes over the hotspot). The load mix at 50
  connections stays at 0 errors (smoke 82/82); compression-specific work is about 2% of the server's busy time.

## 1.2 endpoints

Release 1.2. Every change is **additive**: no response field was renamed or removed; new fields on existing payloads are
optional (`LoginInput.pin`, `UserWithTeam.hasPin`, `UserWithTeam.pinSetupRequired`, `UserWithTeam.twoFactorSetupRequired`).
Every route is mounted behind `requireAuth` (anonymous → 401). Types: `shared/src/types/{learning,pitches,pin,bulk,audit,checkins,search}.ts`.
Cached per user (20 s, cleared by any write): `/learning/progress`, `/learning/team`, `/learning/progression`, `/pitches`, `/search`.

| Package | Endpoints |
| --- | --- |
| L1 learning-pack | `GET /learning/progress[?userId=]`, `POST /learning/progress/:lessonKey/quiz`, `POST /learning/progress/:lessonKey/teachback`, `POST /learning/progress/:userId/:lessonKey/signoff`, `GET /learning/team`, `GET /learning/progression/:userId` |
| L2 learning-pitch | `GET /pitches`, `GET /pitches/:campaignCode`, `PUT /pitches/:campaignCode` (admin, leader) |
| U1 sign-in-pin | `POST /auth/login` (+ `pin`), `GET /auth/pin`, `POST /auth/pin`, `POST /auth/pin/reset/:userId` (admin), `GET` / `PUT /auth/security-settings` (admin) |
| U2 bulk-entry | `POST /gauges/bulk` (leader: own team; admin) |
| U3 audit-trail | `GET /audit` (admin), `GET /audit/:entity/:entityId`, `POST /announcements/:id/read`, `GET /announcements/reads` |
| U4 check-ins | `POST /checkins`, `DELETE /checkins/:id`, `GET /checkins?eventId=` |
| U5 office-tools | `GET /search?q=`, `GET /finance/payroll/export?weekStart=&format=xero\|sage[&runs=unpaid\|all]` (admin) |

### Learning pack: COD pack lessons, the Learn / Teach checklist and the progression tracker (L1)

All under `/api/learning`, mounted with `requireAuth` (anonymous → 401). The three GET prefixes are in `CACHED_PATHS`
(20 s per user and URL, cleared by any write). Lesson keys are the 21 `LESSON_KEYS`; an unknown key → 404 "Lesson not
found". Validation errors → 400 `{ error: 'Validation failed', details }`.

| Method and path | Who | Body → answer |
| --- | --- | --- |
| `GET /learning/progress[?userId=]` | everyone (own); `?userId`: a leader for their own team, an admin for anyone; others 403. Unknown person 404, bad id 400 | `LearningProgress`: one `LessonProgress` per lesson in checklist order, `learned`, `taught`, `total` (21) |
| `POST /learning/progress/:lessonKey/quiz` | everyone, for themselves | `{ answers }`: the option picked for each question, 0-based, in question order (`[]` for the two practical tasks). **The server grades** against `QUIZ_ANSWER_KEY` → `LessonQuizResult { passed, progress, score, total, correct }`, `correct` one boolean per question (never the right option). 400 for a body without `answers` (a `{ score, total }` body is refused), a missing or extra answer ("Answer all 3 questions"), a non-whole or negative option, or answers to a task |
| `POST /learning/progress/:lessonKey/teachback` | everyone, for themselves, once the self-check passed (else 409 "Pass the self-check first, then teach it back") | `{ text }` (trimmed, 20–4000 characters) → `LessonProgress` (state `teachback_sent`) |
| `POST /learning/progress/:userId/:lessonKey/signoff` | the leader of that person's team, or an admin; never your own (403 "Someone else signs off your own teach-back"); another team 403 | `{ signedOff?: boolean = true }` → `TeachbackSignoffResult` (the `LessonProgress`, plus `markedLearned: true` when the sign-off also marked a not-yet-learned lesson learned: `learnedAt` = the sign-off time). `false` withdraws the sign-off, and with it a "learned" that only the sign-off gave; a lesson stays learned when its self-check was ever passed (`quizPassedAt`, whatever a later retake scored) or a teach-back was written since (it goes back to waiting for a sign-off) |
| `GET /learning/team` | leader (own team, active people) or admin (everyone active, recruiters included); rep / recruiter 403 | `TeamLearning { rows, total, pending }` — `pending` (new, optional): teach-backs waiting for a sign-off, never the viewer's own, newest first, with the text |
| `GET /learning/progression/:userId` | self; a leader for their own team; an admin for anyone | `Progression` (see Logic), plus the new optional `weeks`, `learned`, `taught`, `total`, `enabled` |
| `PUT /learning/milestones/:userId/:key` (new) | admin only | `{ value }` (whole number 0–99) → the person's updated `Progression`. Unknown key 404 |

Teach-back text only ever reaches the person, the leader of their team and admins: those are the only callers these
routes let read a person's progress or the team queue. Nothing here writes a gauge row or a payroll run (tested).

New shared types (additive): `LESSON_GROUPS`, `TeachbackAwaiting`, `TeamLearning.pending?`, `ProgressionMilestoneKey`,
`PROGRESSION_MILESTONE_KEYS`, `ProgressionMilestoneInput`, `ProgressionWeek`, `Progression.weeks? / learned? / taught? /
total? / enabled?`, `LessonQuizResult.score? / total? / correct?`, `TeachbackSignoffResult` (`markedLearned?`),
`LessonProgress.quizPassedAt?` (when the self-check was first passed; never cleared by a retake), and the grading
helpers `QUIZ_ANSWER_KEY`, `gradeQuiz`, `quizQuestionCount`, `selfCheckPassed`, `learnedBySignOff`,
`withdrawTakesBackLearned`, `LEARNING_LIMITS.quizMaxOptions`. The answer key is not secret: the lessons the phone
loads carry each question's answer and explanation (see Logic §15.1); the server grading only refuses a made-up score.
Changed before release: `LessonQuizInput` is `{ answers: number[] }` (it was `{ score, total }`, which let the phone
mark itself learned). Client hook added: `useSetMilestone()` in `client/src/api/learning.ts`.

Database (`extensions/learning.ts`, two new tables; `upgrade` adds `quiz_passed_at` to a table made before it, filling
it in once from the older rows, and repairs a row signed off without `learned_at`, from before a sign-off counted as
learned; it reports `learning:learning_progress.quiz_passed_at` / `learning:learning_progress.learned_at` only when it
changed something):

- `learning_progress(user_id, lesson_key, learned_at, quiz_score, quiz_total, quiz_passed_at, teachback_text, teachback_at,
  taught_signed_off_by, taught_signed_off_at, updated_at, PRIMARY KEY(user_id, lesson_key))`, with a partial index on
  teach-backs waiting for a sign-off.
- `learning_milestones(user_id, milestone_key, value, set_by, set_at, PRIMARY KEY(user_id, milestone_key))`: the
  criteria the office ticks by hand.
- Demo seed (fresh demo databases only, its own random stream, never a core table): every active person gets progress
  by position — leaders, crew leaders, assistant owners and owners have the whole pack learned and taught; field reps
  6–16 learned with some taught and up to two teach-backs waiting; trainees 2–6; recruiters 3. The demo rep Jordan
  Lee (LM-0010) has 9 learned, 4 taught and 2 teach-backs waiting for Amelia. Crew leaders have "Show consistency"
  ticked; about half the team leaders have one person confirmed as trained to leadership.

### Pitch studio: campaign pitches, annotations and practice modes (L2)

All three routes are mounted behind `requireAuth` (anonymous → 401). Pitches are company-wide training material
(campaigns are not team-scoped), so **every signed-in role reads every pitch**; only admins and leaders write.
Types: `shared/src/types/pitches.ts`. Both GETs go through the response cache (`/pitches` is in `CACHED_PATHS`, which
covers `/pitches/:campaignCode` too); every PUT bumps the data version, so the next read is fresh.

| Method and path | Who | Answer |
| --- | --- | --- |
| `GET /pitches` | every role | `PitchListItem[]`: one row per campaign, active campaigns first, then by name: `{ campaignId, campaignCode, campaignName, campaignColor, campaignActive, hasPitch, title, updatedAt }` (`title` and `updatedAt` null without a pitch) |
| `GET /pitches/:campaignCode` | every role | `CampaignPitch`: `{ id, campaignId, campaignCode, campaignName, campaignColor, title, body, facts, updatedBy, updatedByName, updatedAt }`. The code is case-insensitive. **404 `Campaign not found`** for an unknown or malformed code (not 2–6 letters or digits), **404 `Pitch not found`** when the campaign has no pitch yet |
| `PUT /pitches/:campaignCode` | admin, leader (others 403) | Body `PitchUpsertInput` `{ title, body, facts? }`. **201** with the `CampaignPitch` when it creates the pitch, **200** when it replaces it. 404 `Campaign not found`; 400 `Validation failed` with details; **403 `Only the office can change the fact-check notes`** when a leader's `facts` would change the stored notes (nothing is saved) |

PUT rules:

- `title`: inner whitespace collapsed, trimmed, 1–120 characters (`PITCH_TITLE_MAX`).
- `body`: CRLF/CR become LF, trimmed, 1–20,000 characters (`PITCH_BODY_MAX`). Stored exactly as written otherwise: the
  server never rewrites the script.
- `facts`: CRLF normalised, trimmed, at most 10,000 characters (`PITCH_FACTS_MAX`). **Left out keeps the saved notes**;
  `null` or blank clears them.
- **Only admins (the office) change `facts`.** A leader may leave `facts` out, or send the stored notes back unchanged
  (after the normalising above; `null`/blank equals "no notes"), and the title and script save. Any other `facts` from
  a leader (new or changed notes, clearing them, or notes on a pitch they create) is **403** with the error
  `Only the office can change the fact-check notes` (`PITCH_FACTS_OFFICE_ONLY` in `@lm/shared`), and nothing is saved.
  The client editor shows the notes read-only to leaders and leaves `facts` out of their save.
- `updated_by` is the caller, `updated_at` the business clock (`nowISO()`). One row per campaign (`campaign_id` is
  unique): a PUT is an upsert. U3's audit middleware records each edit; nothing here writes the audit log itself.
- A pitch never creates gauge rows or payroll runs (route test).

Database (`server/src/db/extensions/pitches.ts`):

```sql
CREATE TABLE IF NOT EXISTS campaign_pitches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  facts TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
```

The BCN pitch (title "The BCN pitch", `BCN_PITCH_BODY`, `BCN_PITCH_FACTS`, saved by the owner) goes in:

- on a **fresh demo seed** by the extension's `seed` (BCN campaign from `ctx.campaigns`, owner from `ctx.users`,
  `ctx.nowIso`), which also records the meta flag `ext:pitches:bcn`;
- on an **existing database** by `upgrade`, once: when the flag is missing and a campaign with code BCN exists, it
  inserts with `INSERT OR IGNORE` (an office-edited pitch is never replaced), sets the flag and reports
  `pitches:campaign_pitches.bcn` only when a row went in. On a fresh install `upgrade` runs before the seed on an empty
  campaigns table, finds no BCN campaign and skips without setting the flag, so the first restart after a fresh seed
  reports nothing (r2-contracts test). Other campaigns get no pitch.

`BCN_PITCH_FACTS` has one note per quoted line (LOGIC §15.2). A database seeded by 1.2.0 holds the old merged notes
(`BCN_PITCH_FACTS_V1`). A second one-off `upgrade` step (meta flag `ext:pitches:facts-v2`) replaces them with the new
notes **only on a pitch nobody has edited**: title, script and notes exactly as seeded, and `updated_by` empty or the
owner (the seed's saver). It leaves `updated_by` and `updated_at` alone and reports `pitches:campaign_pitches.bcn-facts-v2`
only when it changed the row. A pitch a person edited is never touched. Without a BCN pitch it skips without setting the
flag; a fresh `seed` writes the new notes and sets both flags.

### Sign-in PIN, stronger sessions and the deploy guide (U1)

All in `server/src/routes/auth.ts`; types in `shared/src/types/pin.ts`.

| Method | Path | Who | Body → answer |
| --- | --- | --- | --- |
| POST | `/auth/login` | anyone | `{ email, employeeId, pin? }` → `200 { user }` / `200 TwoFactorChallenge` as before. For an account **with a PIN**: no PIN → `200 LoginPinChallenge { requiresPin: true, attemptsLeft }` and no cookie (step two, like the two-step challenge); wrong PIN → `401`, locked → `423`, both with `LoginPinRequired` (below). A PIN sent for an account without one is ignored. |
| GET | `/auth/pin` | signed in | → `PinStatus { hasPin, setAt, required, locked, lockedUntil? }` (yours; `lockedUntil`, the ISO instant the lock ends, only while locked) |
| POST | `/auth/pin` | signed in | `{ pin, currentPin? }` → `204`. Sets a first PIN, or changes it (`currentPin` required once you have one). Signs out every **other** session of yours. `400` with `details: [{ path: 'pin' \| 'currentPin', message }]` for a refused PIN, a missing or wrong current PIN, or the same PIN again; `423` while your PIN is locked (the `error` says until when, as below); `429` after 6 wrong current PINs in 15 minutes. |
| POST | `/auth/pin/remove` | signed in | `{ currentPin }` → `204`. `409` while a PIN is required for everyone, or when you have none; wrong PIN as above. |
| GET | `/auth/pin/:userId` | admin | → `PinStatus` of anyone (never the PIN or hash); `404` unknown user, `400` bad id |
| POST | `/auth/pin/reset/:userId` | admin | → `204`: clears the PIN and its lock, signs the person out everywhere. `400` for yourself (the message points at Settings and at `npm run pin:reset -- <your email>` on the server), `404` unknown. |
| GET | `/auth/security-settings` | admin | → `SecuritySettings { requirePin, requireAdminTwoFactor, sessionIdleHours }` (defaults `false, false, 12`) |
| PUT | `/auth/security-settings` | admin | `Partial<SecuritySettings>` (strict: unknown keys `400`; `sessionIdleHours` a whole number 1–72) → the full settings. `409` when switching on `requirePin` without your own PIN, or `requireAdminTwoFactor` without your own two-step verification. Switching `requireAdminTwoFactor` on signs out every other administrator who has not set up two-step verification. |
| POST | `/auth/2fa/disable` | signed in | unchanged, plus `409` for an administrator while two-step verification is required for administrators |

`LoginPinRequired` (401 / 423):

```json
{ "error": "That PIN is not right", "requiresPin": true,
  "details": { "requiresPin": true, "reason": "wrong", "attemptsLeft": 9 } }

{ "error": "Too many wrong PINs. Try again after 14:35, or ask an administrator to reset your PIN.", "requiresPin": true,
  "details": { "requiresPin": true, "reason": "locked", "lockedUntil": "2026-10-20T13:34:10.512Z" } }
```

`reason` is `wrong` or `locked`. On `wrong`, `attemptsLeft` counts down to the next lock; on `locked`, `lockedUntil` is
when the lock ends (real clock) and `error` says it in London time, rounded up to the minute ("14:35", "14:35
tomorrow"). Ten wrong PINs in a row lock the PIN for 15 minutes, each further ten double it (30 min, 1 h … 24 h at
most); a right PIN or a reset clears the count (LOGIC §15.3). Tries during a lock answer `423` and are not counted.
The flags are repeated in `details` because the client's `ApiError` keeps only `error` and `details`. A wrong employee
ID still answers the plain
`401 Invalid email or employee ID` and never mentions a PIN. The PIN challenge is a 200 so the everyday sign-in of a
person with a PIN logs no failed request in the browser console.

`/auth/me` and the login responses' `user` now carry the caller's own `hasPin`, `pinSetupRequired` and
`twoFactorSetupRequired` (the optional fields the foundation added to `UserWithTeam`). No other user row carries them.

**The gate** (`pinSetupGate` in `server/src/middleware/auth.ts`, mounted after `authenticate`):

- While `pinSetupRequired`: every `/api` request answers `403 { "error": "Create your PIN to carry on", "pinSetupRequired": true }`
  except `/health`, `/auth/me`, `/auth/logout`, `/auth/login`, `/auth/login/2fa`, `/auth/demo-accounts` and
  `/auth/pin` (GET and POST). The client's `PIN_SETUP_REQUIRED_EVENT` fires on that body.
- Then, while `twoFactorSetupRequired` (an admin, when required): the same list plus `/auth/2fa`, `/auth/2fa/setup`
  and `/auth/2fa/enable`; everything else answers `403 { "error": "Set up two-step verification to carry on", "twoFactorSetupRequired": true }`.
- Anonymous requests pass through (requireAuth answers them). Paths are compared lower-cased without trailing slashes,
  and anything not listed stays closed.

**Sign-in limits behind a proxy.** The login limiter (8 per source and email, 20 per email in 15 minutes) and the
two-step code limiter key on the TCP peer, or on `req.ip` when `TRUST_PROXY` is set, so behind the reverse proxy of
DEPLOY.md each client is counted on its own. Without `TRUST_PROXY`, `X-Forwarded-For` is ignored.

**Server command.** `npm run pin:reset -- <email>` (`server/src/pinReset.ts`, honours `DB_PATH`) clears one person's
PIN and lock and signs them out everywhere, with an audit row (no person; action `npm run pin:reset`). For the only
administrator's own locked or forgotten PIN, or after losing the app secret. Exit code 0 when done or there was nothing
to reset, 1 for no email, no database or no such person.

Database (`server/src/db/extensions/pin.ts`, columns only): `users.pin_hash` (`scrypt-hmac$…`, peppered with the app
secret; 1.2.0's `scrypt$…` is still read and replaced at the next sign-in), `users.pin_set_at`,
`users.pin_failed_attempts` (default 0), `users.pin_locked_until` (when the latest lock ends, or null),
`sessions.last_seen_at`. Settings are the `meta` keys `ext:pin:require-pin`, `ext:pin:require-admin-2fa` and
`ext:pin:session-idle-hours`, written only by the PUT above (absent → default). No seed rows: the demo accounts have no
PIN.

### Bulk gauge entry with WhatsApp paste (U2)

#### `POST /gauges/bulk` (admin, leader)

Body `BulkGaugeInput`:

```json
{
  "eventId": 523,
  "date": "2026-10-20",
  "rows": [
    { "userId": 10, "stops": 65, "table": 22, "presentations": 11, "closes": 5, "taps": 3, "sales": 3, "checkedInAt": "2026-10-20T09:58" },
    { "userId": 13, "stops": 33, "table": 11, "presentations": 6, "closes": 3, "taps": 2, "sales": 2 }
  ]
}
```

- `rows`: 1–100 (`BULK_MAX_ROWS`). Each row is a `POST /gauges` body without `id`, `eventId` and `date`: the six
  counts (whole numbers 0–2,000), optional `checkedInAt` (same format and rule as a single entry; omitted keeps a stored
  value, `null` clears it) and optional `notes` (same: omitted keeps, `null` clears).
- **200** `BulkGaugeResult` `{ created, updated, entries: GaugeEntryWithMeta[] }` — the saved entries in row order.
  An existing entry for (event, person, date) is updated in place, never duplicated.
- **400** `{ error: "2 rows need fixing — nothing was saved", details: { rows: BulkRowError[] } }` when any row is
  refused. `BulkRowError` is `{ index, userId, errors: string[] }` (`index` into `rows`); every bad row is reported,
  not just the first. Nothing is written.
- Event-wide problems answer once, with the status a single entry gets: **404** no such event; **403** a leader and
  another team's event ("Leaders can only record gauges at their own team's events"); **409** a cancelled event;
  **400** an event that has not started yet, or a `date` that is not the event's date; **400** `Validation failed`
  for a malformed body (no rows, more than 100, a missing `eventId`).
- Reps and recruiters get **403**; anonymous **401**.
- Role scoping: a leader may write their own team's events, for members of their own team and themselves; an
  administrator any event and anyone (same as `assertCanWriteGauge`).
- Not cached (a write). The write middleware bumps the data version once per request, so every cached aggregate
  (`/me/dashboard`, `/leaderboard`, `/gauges/summary` …) refreshes once.

### Audit trail and announcement read receipts (U3)

All routes are behind `requireAuth` (anonymous → 401). Types: `shared/src/types/audit.ts`. None is in the response
cache (they are admin views or per-author lists, and any write clears the cache anyway).

#### `GET /audit` (admin; everyone else 403) → `AuditPage`

`{ rows: AuditEntryDetail[], total }`, newest first (`at DESC, id DESC`). Query parameters, all optional:

| Param | Meaning |
| --- | --- |
| `userId` | Only rows made by this person. |
| `entity` | One of `payroll_run`, `gauge_entry`, `user`, `candidate`, `event`, `campaign`, `pitch`, `settings`, `announcement`, `expense`, `learning`, `check_in` (400 otherwise). |
| `entityId` | Only rows about this record (use with `entity`). |
| `from`, `to` | `YYYY-MM-DD`, inclusive London calendar days (`from` after `to` → 400). |
| `q` | Words in the summary, case-insensitive; `%` and `_` are literal. Up to 100 characters. Apostrophes are ignored on both sides and curly quotes match straight ones, so `can't`, `can’t` and `cant` all find “Can’t controls”. |
| `signIns` | `0` leaves out sign-ins and sign-outs (`POST /auth/login`, `/auth/login/2fa`, `/auth/logout`); `1` or absent keeps them. Anything else → 400. |
| `limit`, `offset` | Paging: `limit` 1–200 (default 50; 0 or negative → 400), `offset` ≥ 0 (a whole number up to 2^53 − 1, else 400). `total` counts every matching row. |

`AuditEntryDetail`: `id`, `at` (UTC ISO, real clock), `userId`, `userName` (null for a row without a person),
`action` (method and route pattern, e.g. `POST /finance/payroll/:id/pay`), `entity` and `entityId` (null for routes
the registry does not describe), `summary`, `ip` (admins only, null for anyone else), `before` and `after` (the stored
snapshots, or null) and `diff` (`AuditFieldChange[]`, computed when read by the shared `auditDiff`).

Long text: in `before`, `after` and `diff`, a text value longer than 2,000 characters is
`{ length: number, sha256: string, head: string }` (its length, the SHA-256 of the whole text in hex, its first 200
characters) instead of the text. Two versions differ exactly when their `sha256` differs. Rows written before this
change may still hold the whole text.

#### `GET /audit/:entity/:entityId` → `AuditEntryDetail[]`

The newest 100 rows about one record. Admin: any entity. Leader: `gauge_entry` only, and only entries of a person on
their own team or their own entries (a deleted entry is judged by the person in its last snapshot); anything else 403.
Reps and recruiters 403. Unknown entity or non-numeric id → 400. `ip` is null for leaders. An id with no rows → `[]`.
For a leader every snapshot is redacted like `GET /gauges`: `checkedInAt` and `notes` are null in a snapshot whose
person is not on the leader's team (an entry moved onto the team keeps its earlier owner's details hidden), and that
row's `diff` and `summary` are rebuilt from the redacted snapshots.

#### `POST /announcements/:id/read` → 204

Marks the announcement read by the caller. Idempotent: the first read time is kept. 404 for an unknown announcement,
400 for a non-numeric id. Any signed-in role. Read receipts are not audit rows (they have their own table).

#### `GET /announcements/reads[?ids=1,2,3]` → `AnnouncementReadStats[]`

Admins get every announcement, everyone else only the ones they wrote (a rep gets `[]`). Without `ids`: the 50 newest,
pinned first, the order the dashboard lists them (enough for its latest five and the twenty under **Older
announcements**, so one request serves both); with `ids` (up to 100, positive integers, else 400) only those.
Each item: `announcementId`, `readCount`, `audience`, and `readers` (`{ userId, name, readAt }`, newest read first).
Names are always included because only the author and admins ever receive a row. Two queries in all.

#### Recording (no new endpoint)

`auditMiddleware(db)` (`server/src/lib/audit.ts`) sits on the `/api` router after `authenticate` and the PIN gate.
For every `POST`, `PUT`, `PATCH` and `DELETE` that is answered 2xx it writes one row (more for gauge writes, see
Logic). Reads (`GET`, `HEAD`, `OPTIONS`) pass straight through, so read throughput is unchanged. Failed requests
(4xx, 5xx) write nothing. An audit failure is logged to the console and never changes the response.
`recordAudit(db, entry)` writes an explicit row (e.g. from a maintenance job). Route files were not edited.
A write that changed nothing writes no row: a check-in replay answered "already recorded" (`200`, whatever the body
carries), a teach-back saved with the same text, a pitch saved unchanged, sign-in settings saved with the same values,
a self-check retake that changes no stored field, a repeated sign-off or one taken back where there was none (see
Logic §15.5).

#### Per-person write limit (429)

At most 60 a minute per signed-in person, all together, of `POST /learning/*`, `PUT /pitches/*`, `POST /checkins`,
`POST /auth/pin` (and `/auth/pin/*`) and `POST /gauges/bulk`. The next one inside the minute answers
`429 { "error": "That is more than 60 changes in a minute. Wait a minute, then try again." }` with `Retry-After: 60`
and is not recorded; refused requests do not count. Reads, other writes and signed-out requests (401 as before) are
not limited. `createApp(db, { writeLimitPerMinute })` sets the number (0 turns it off).

### One-tap shift check-in (U4)

All three routes are mounted at `/api/checkins` behind `requireAuth`. Anonymous callers get 401. Types live in
`shared/src/types/checkins.ts` and rules in `shared/src/logic/shiftCheckIn.ts`.

#### `POST /checkins`: check in

Body `ShiftCheckInInput`: `{ eventId, date?, checkedInAt?, source? }`.

- **Who:** reps and leaders at their own team's events. Admins can check in at any event (the same rule as gauges).
  Recruiters get 403.
- **Live tap** (no `checkedInAt`): the server stamps the business clock (`toBusinessISO(businessNow())`, naive London
  wall-clock time). It only works on the event's date, up to the event's end time.
- **Offline replay** (`checkedInAt` given): the phone sends the time it was tapped. It is always recorded with
  `source: 'offline'` (the roll call's "sent later"), whatever `source` the request carries.
  - The time must be on the event's date and not after the event's end.
  - It cannot be in the future, but a phone clock up to 5 minutes ahead is taken as now.
  - It must arrive within **24 hours of the event's end** (it was 7 days in the first 1.2 build). Later, the answer is
    400 "This check-in reached Linear Hub more than 24 hours after the event ended at 17:00, so it cannot be
    recorded. Ask your team leader to record your arrival time."
  - It is never earlier than **60 minutes before the event's start**: an earlier time is recorded as that bound (still
    on time), or as the business clock now if the request arrives before the bound. The answer's `checkedInAt` is the
    time recorded.
  - Zoned input is converted to London wall-clock time, as for gauges.
- `date` defaults to the date of `checkedInAt`, or else the business date. It must be the event's date.
- `source` is one of `'button' | 'quick' | 'offline'`. `'leader'` is reserved and refused. The recorded source is
  `'offline'` exactly when the request carries `checkedInAt`; otherwise `'quick'` when sent, else `'button'` (a live
  tap sent with `'offline'` is recorded as `'button'`). So a time supplied by the phone is never shown to a leader as
  a live tap (review 1.2 S3).
- **Idempotent:** the key is `(user, event, date)`. A first check-in answers **201** `ShiftCheckIn`. If one already
  exists, the answer is **200** with that row, whatever time the request carries: the first check-in stands. A phone
  that replays a tap whose answer was lost is simply told "done".
- **Errors:** 400 for validation and time rules (the messages are worded for people, e.g. "Check-in closed at 17:00,
  when the event ended"). 403 for the wrong team or a recruiter. 404 for an unknown event. 409 for a cancelled event.
- **Punctuality:** a check-in counts over the gauge entry's own check-in time, unless a leader or admin recorded that
  time on the person's behalf (`POST /gauges`, `PATCH /gauges/:id` or `POST /gauges/bulk` for someone else): then
  their time counts. The gauge routes record who set the time in `gauge_entries.checked_in_by`, and gauge entries
  answer it as `checkInOnBehalf`. A time saved for someone that equals their check-in to the minute (Log gauges fills
  the field with it, without the seconds) stays theirs, so the precise check-in still counts. Moving an entry to
  another event or day keeps its time's author.

#### `DELETE /checkins/:id`: undo or remove

- The person can undo their own check-in within **2 minutes** of `createdAt`. The server allows 15 seconds of grace
  for a slow request. After that it answers 403 "The 2 minutes to undo a check-in have passed — ask your team leader
  to remove it".
- The leader of the person's team (themselves included) and admins can remove one at any time.
- A caller who cannot see the row gets 404, so the API never reveals that it exists. Success is 204.

#### `GET /checkins?eventId=`: the event's check-ins

Answers `ShiftCheckInList` `{ eventId, checkIns }`, earliest first. 400 without `eventId`, 404 for an unknown event.

- **Scope:** an admin sees everyone. A leader sees their own team's people and themselves. Anyone else sees only their
  own. This is the same rule as check-in times on gauge entries (`canSeeEntryDetails`).
- **Not cached:** it is one indexed query, not an aggregate.

#### `ShiftCheckIn`

| Field | Meaning |
| --- | --- |
| `id`, `userId`, `userName`, `eventId`, `date` | The row. |
| `checkedInAt` | Naive London wall-clock time, `YYYY-MM-DDTHH:MM:SS`. Same format as `GaugeEntry.checkedInAt`. |
| `source` | `'button'` (dashboard or event page), `'quick'` (Quick gauges), `'offline'` (sent later by the phone: always when the phone supplied the time). |
| `createdAt` | ISO instant the row was written (business clock). |
| `minutesLate` | Whole minutes after the start, rounded up; 0 when early. |
| `onTime` | Within the 5-minute grace. |
| `undoUntil` | ISO time until which the caller can undo **their own** row; otherwise null. |
| `undoMsLeft` | New. Milliseconds of the caller's undo window left when the server answered; 0 when there is none. Clients count down from when the answer arrived, so a wrong phone clock never matters. |

Every write bumps the response cache's data version (as every write does), so `/me/dashboard` and the digest show the
new punctuality straight away.

### Search palette and payroll export (U5)

`GET /search?q=` → `SearchResponse { q, results: SearchResult[] }` (shared/src/types/search.ts). Any signed-in role.
A query shorter than 2 characters (after trimming, at most 60 kept, at most 5 words) answers no results and runs no
SQL. At most 20 results: people 6, events 6, candidates 5, campaigns 3. Each result has `kind`, `id`, `title`,
`subtitle`, `href` (the in-app page it opens), optional `color` and `rank` (0 the title starts with the whole query,
1 a word of it does, 2 it only contains the words). Cached per user for 20 s; any write clears it.

Scoping, the same rules as the pages a result opens:

| Kind | admin | leader | recruiter | rep |
| --- | --- | --- | --- | --- |
| People | everyone, including leavers; also matches the employee ID | active people | active people | active people |
| Events | every team | every team | every team | own team only |
| Candidates | yes | yes | yes | none |
| Campaigns | all → /campaigns | all → /campaigns | active → the campaign's pitch | active → the campaign's pitch |

E-mail matches on the part before the @ only. LIKE wildcards in the query are escaped.

`GET /finance/payroll/export?weekStart=YYYY-MM-DD&format=xero|sage[&runs=unpaid|all]` → `text/csv` attachment, admin
only (others 403). `weekStart` must be a Monday (400 otherwise); `runs=unpaid` (default) exports pending runs and
failed transfers, `runs=all` every run of the week. Sorted by surname then first name. `X-Total-Count` = rows;
`Cache-Control: no-store`. A week without runs answers the header line alone. Each export is written to the audit trail.
Like `GET /finance/payroll`, it first creates the pending runs of a week that has just closed when that week has none
yet (it never changes a paid run); when it does, the response cache is cleared as it is after that route.

## 1.3 endpoints

Release 1.3. Every change is additive: no response field was renamed or removed; new fields on existing payloads are optional. Every route is mounted behind `requireAuth` (anonymous → 401). A **client** session (role `client`, new) may call only `/auth/*` (me, logout, PIN), `/health` and `/client/*`; every other route answers `403 { clientPortalOnly: true }`.

### Pay: base or commission, whichever is higher; cancellations (P1)

All routes are under `/api/pay` (`server/src/routes/pay.ts`). Types are in `shared/src/types/pay.ts`. Every route
needs a signed-in session: an anonymous caller gets **401**, and a client account gets **403** with code
`clientPortalOnly` from the client guard before the router runs. "Own team" means the leader's `teamId`; a leader with no
team sees only their own pay.

| Method and path | Body / query | Answer | admin | leader | rep / recruiter |
| --- | --- | --- | --- | --- | --- |
| `GET /pay/settings` | — | `PayRuleSettings` `{ dayRate, ruleFrom }` | ✓ | 403 | 403 |
| `PUT /pay/settings` | `PayRuleSettingsInput` `{ dayRate?, ruleFrom? }` (strict) | `PayRuleSettings` | ✓ | 403 | 403 |
| `GET /pay/rates?campaignId=` | optional campaign | `CampaignRate[]`, newest first | ✓ | ✓ | 403 |
| `POST /pay/rates` | `CampaignRateInput` `{ campaignId, repRate, payoutRate, effectiveFrom }` | **201** `CampaignRate` (source `admin`) | ✓ | 403 | 403 |
| `GET /pay/breakdown?userId=&weekStart=` | default: the caller, this week | `WeekPayBreakdown` | anyone | own team | own only |
| `GET /pay/adjustments?userId=&weekStart=` | `weekStart` = the week a line lands on | `PayAdjustment[]` (newest week first, up to 200) | everyone (no `userId`) | own team | own only |
| `POST /pay/bonuses` | `BonusInput` `{ userId, weekStart, amount > 0, note }` | **201** `PayAdjustment` (kind `bonus`) | ✓ | 403 | 403 |
| `POST /pay/adjustments` | `ManualAdjustmentInput` `{ userId, targetWeekStart, sourceWeekStart?, amount ≠ 0, note }` | **201** `PayAdjustment` (kind `manual`); its `targetWeekStart` is the week it landed on (see below) | ✓ | 403 | 403 |
| `DELETE /pay/adjustments/:id` | — | **204** | ✓ | 403 | 403 |

**Status codes:**

- **400**:
  - a day rate that is not more than £0 or is over £500;
  - a rule date that is not a Monday or is after this week;
  - unknown keys in the settings body;
  - a breakdown more than 28 days ahead;
  - a bonus or adjustment more than four weeks ahead, or before the person started;
  - a £0 amount, or a note that is missing or over 300 characters;
  - a person on a salaried plan, which is not paid weekly;
  - a rate dated more than a year ahead;
  - a line taking off more than a finished week pays: "That would take Bo's pay for w/c 5 Oct below £0 (−£36.50). Take off at most £63.50 here and put the rest on a later week." Nothing is written.
- **201 on another week**: a line put on a past week the person did not work lands on their next open week (see Logic), and the answer's `targetWeekStart` says which.
- **403**: the role is not allowed, or the person is outside the caller's scope ("You can only see your own pay", "Leaders can only see their own team's pay").
- **404**: an unknown person, a client account as `userId`, an unknown campaign or an unknown adjustment.
- **409**:
  - the week is already paid: "The week w/c 5 Oct has already been paid. Choose the next unpaid week.";
  - removing a line that came from a statement or a dispute;
  - `POST /finance/payroll/:id/pay` for a run below £0: "Bo's pay for w/c 5 Oct comes to −£36.50, below £0, so it cannot be marked paid. Add an adjustment to carry part of a correction to a later week first." (before P2's invoice check).

**`WeekPayBreakdown`**:

- The STABLE fields from the foundation: `rule`, `daysWorked`, `dayRate`, `baseAmount`, `commissionAmount`, `paidAs`, `lines[]`, `salesLogged`, `salesConfirmed`, `salesCancelled`, `perCampaign[]`, `adjustments[]`, `explanation[]`, `runId`, `status`.
- The additive optional fields:
  - `adjustmentsTotal`, `userName`, `dueDate` and `paidDate`;
  - `corrections[]`: the lines this week's statement figures put on later weeks;
  - `asCalculated`: true when the figures are the run's stored calculation, or a paid 1.2 run's own stored columns;
  - `salaried`;
  - `awaiting[]`: campaign codes whose statement for the week has not arrived.
- `status` is `estimate` when the week has no run yet.
- The explanation says "you" to the person and uses their first name for anyone else: "Jordan worked 4 days".

**Caching:**

- `GET /pay/breakdown` goes through the response cache (`X-Cache: HIT` / `MISS`), keyed on user, role and URL. `GET /pay/adjustments` is a plain list (newest week first, at most 200 lines) and is not cached.
- Every write route above, and every recalculation, bumps the data version, so the next read is fresh.

**Audit.** Each write route has a spec in `server/src/lib/audit/paySpecs.ts`. Examples:

- "Changed pay settings: day rate £63.50 → £65"
- "Added a rate for FXC: £45 a sub to the rep, £125 payout, from 2026-10-05"
- "Added a bonus: Remy Rep w/c 5 Oct, £50 — Top seller in October", followed by a second row "Recalculated after a bonus: … £127 → £177" on the run
- "Added an adjustment …"
- "Removed a bonus …"
- A settings change or a new rate adds one summary row for the unpaid runs it recalculated (none when nothing moved): "Recalculated 7 unpaid pay runs after the pay settings change: £1,778 → £1,960 in all", "Recalculated 1 unpaid pay run after the rate change: £128 → £181 in all".
- The automatic takeover of a dated rate is recorded as Linear Hub (`SYSTEM pay.rates`, entity `campaign`): "FXC rate from Fri 16 Oct in effect: £31 a sub to the rep (was £30), £130 payout (was £120)"

**Changes to existing responses (additive only):**

- `PayrollRun` (`GET /finance/payroll`, `/finance/me`, CSV) fills `paidAs`, `salesLogged`, `salesConfirmed`, `salesCancelled` and `adjustmentsTotal`. The stored calculation (`payroll_runs.breakdown_json`) is never returned.
- `GET /finance/me` → `forecast` and `GET /me/insights` → `personal.payForecast` gain a `rule` block (`PayForecastWithRule`) in a 1.3 week: `{ dayRate, projectedDays, baseLikely, commissionSoFar, commissionLikely, paidAsLikely, ratePerSub, subsToBeatBase, stopsToBeatBase, beatBaseProbability, extras }`. In that case the bonus fields are 0 and `none`. A salaried plan gets no forecast.
- `GET /finance/summary` → `byCampaign[].commission` for 1.3 weeks is subs × the campaign's rep rate on each sale's date (the plan maths before the rule date).

**Server helpers for other packages** (`server/src/lib/payRule.ts`, STABLE):

- `applyConfirmedSales(db, rows, { statementId, actorId, dryRun })` → `ApplyResult` `{ people[], totalDifference }` for P3's statements. Each person gets `{ before, after, difference, effect: 'recalculated' | 'adjustment' | 'no-change', targetWeekStart, adjustmentId, sentence }`. `dryRun` writes nothing.
  - Last fix round: `replacesStatementId` (the applied statement this one replaces) hands that statement's correction lines still on unpaid weeks to `statementId` first, in the same savepoint, so each is updated in place. P3 no longer writes `pay_adjustments` itself. It must be another statement's id (400 otherwise).
  - A row with `notOnStatement: true` (P3's "dropped" people: on the replaced statement, not on this one) is worded "Not on BCN's corrected statement: back to the 22 subs logged, so the earlier correction is withdrawn." (also "…; the week's pay goes from £90.00 to £135.00 (not paid yet)." and "…: no change.").
- `DELETE /pay/adjustments/:id` now answers 400 when removing a bonus (or another positive line) would take a finished unpaid week below £0. The answer is "Removing this would take Bo's pay for w/c 5 Oct below £0 (−£40.00), so it could not be paid. Remove or reduce the lines that take money off that week first." Nothing is removed.
- `addCampaignRate(db, input, actorId)` for P6's approved client changes (`source: 'client'`, `clientPostId`). A missing `repRate` or `payoutRate` keeps the one in effect on the date.
- `recordCampaignRateChange(db, id, before, after, actorId)` is called by the Campaigns routes when a rate changes in the Campaigns form.
- Breakdown, adjustments and recalculation: `weekPayBreakdown`, `addPayAdjustment` (P2's disputes), `recalculateUnpaidRuns` and `nextUnpaidWeek`.
- Rates and settings: `campaignRateOn`, `listCampaignRates`, `payRuleSettings` and `updatePaySettings`.

### Self-billing invoices: accept or dispute (P2)

All routes are under `/api/invoices`, behind `requireAuth`; anonymous → 401, a client portal account → 403
`clientPortalOnly` (the foundation's client guard). Types: `shared/src/types/invoices.ts`.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /invoices/agreement` | every staff role | `SelfBillingAgreement` `{ version, title, body, acceptedAt }` (the text names the company's legal name) |
| `POST /invoices/agreement/accept` | reps and leaders (others 403) | `SelfBillingAgreement`; records version, time and IP once (a second call changes nothing) |
| `GET /invoices/profile` · `PUT /invoices/profile` | the signed-in person | `InvoiceProfile` (+ `invoiced`, `agreement { version, acceptedAt }`); PUT takes `InvoiceProfileInput` (strict: only the address lines, town, postcode, UTR, VAT number; `null`/empty clears) |
| `GET /invoices/profile/:userId` · `PUT …` | admin | the same for anyone (404 for an unknown id or a client account) |
| `GET /invoices/company` | every staff role | `CompanySettings` (defaults: the brand's legal name and address, the owner as signatory) |
| `PUT /invoices/company` | admin | `CompanySettings`; `CompanySettingsInput.signatureImage` is a `data:image/png;base64,…` (a complete PNG: IHDR first with a width and height of 1–4000 px, every chunk's CRC right, IEND last with nothing after it; ≤ 200 KB) or `null` to remove. 400 otherwise, and nothing is written |
| `GET /invoices/signatures/:file` | every staff role | the signature PNG an invoice prints (content-addressed `<16 hex>.png`, cached privately) |
| `GET /invoices?from=&to=&userId=&weekStart=&status=` | rep/recruiter own; leader own team + self; admin all | `InvoiceListRow[]` (an `InvoiceSummary` plus `payrollRunId, userId, userName, weekStart, weekEnd, dueDate, runStatus`), newest week first; default range the last 12 weeks |
| `GET /invoices/by-run/:runId` · `GET /invoices/:id` | admin, the person, their team leader (others 403; none 404 "Invoice not found") | `Invoice` with `runStatus`, `paidDate`, `paidOverride`, `previousVersions` (after a reissue), `actions { accept, dispute, resolve, markPaidWithReason }` for the viewer, `agreementAccepted` for the supplier only, and `runTotal` + `figuresChanged` for the admin. A team leader's view has `supplier { name, vatNumber, withheld: true }` with no address, postcode or UTR. A deemed acceptance of someone who had not accepted any self-billing agreement by then has `acceptance.withoutAgreement: true`. An invoice whose run changed since is brought up to date first (see Logic) |
| `POST /invoices/:id/accept` | the supplier only (403 otherwise) | `Invoice`. 409 `{ details.code: 'agreement_required' }` until the agreement is accepted; idempotent once accepted or deemed accepted; also from disputed (the person changed their mind) or resolved |
| `POST /invoices/:id/dispute` `{ reason (3–1000), lines: [{ line, note? }] }` | the supplier only | `Invoice` (status `disputed`). 400 for a line that is not on the invoice or picked twice; 409 once paid, already disputed or already answered, or past the deadline ("The time to dispute this invoice passed at 12:00 Thu 22 Oct. Speak to the office: a correction can go on a later week.") |
| `GET /invoices/disputes` | admin | `InvoiceDisputeRow[]` oldest first, with `disputedLines` (description, amount, the person's note), `ours { total, salesLogged, salesConfirmed? }`, `payrollRunId`, `dueDate`, `teamName`, `figuresChanged`, `runTotal`, and `statements [{ id, campaignCode }]`: the client statements that confirmed the person's sales for that week (P1's `sale_confirmations`) |
| `POST /invoices/:id/resolve` `{ action: 'reissue' \| 'keep', note (3–1000), adjustment?: { amount, note? } }` | admin | `Invoice`. Disputed only (else 409). `keep` → `resolved` (payable); `reissue` (unpaid runs only) → optional correction, then version + 1, status `issued` |

`PUT /invoices/profile`, `POST /invoices/agreement/accept`, `POST /invoices/:id/accept` and `/dispute` share a
per-person limit of 60 a minute (the numbers and wording of `middleware/writeLimit.ts`, a counter of their own inside
the router): the next one is 429 "That is more than 60 changes in a minute. Wait a minute, then try again." with
`Retry-After: 60`, and is not audited.

Changes to the finance routes (through the foundation's hooks, no edit to `routes/finance.ts`):

- `GET /finance/payroll`, `GET /finance/me` (runs) and `GET /finance/payroll/:id`: each run with an invoice carries
  `invoice: InvoiceSummary` (status as it stands now, so an issued invoice past its deadline already reads
  `deemed_accepted`, and the invoice of a run that changed is brought up to date first); runs without one gain no key.
- `POST /finance/payroll/:id/pay` (admin): **409** when the run's invoice is issued and before its deadline —
  `"This invoice is not accepted yet. Open the run to mark it paid with a reason."` (`details.code
  'invoice_not_accepted'`); body `{ overrideReason }` (3–500 characters) pays it anyway and the reason is stored on the
  invoice. A **disputed** invoice is held until the office resolves it: 409 `'invoice_disputed'` *even with a reason* —
  `"This invoice is disputed, so it is held until the office answers. Resolve it first in Finance → Company → Disputed
  invoices: Keep as it is, or Fix and reissue."` (named as the card is). A run whose pay changed since its invoice was
  issued gets a new version first; while that version waits for the person, 409 `'invoice_reissued'` (or pay it with
  a reason). `details.deemedAcceptedAt` is the version's deadline. A run without an invoice (office roles, weeks before
  1.3) is unchanged.

Audit (`server/src/lib/audit/invoiceSpecs.ts`): accept the agreement (entity `agreement`, once), save invoice details
(own / admin, entity `user`, the changed fields named), save company details (entity `settings`; the signature as a
file name, never its bytes), accept / dispute / resolve an invoice (entity `invoice`), and a refinement of Mark paid
(same row and wording as 1.2, plus "without an accepted invoice (LM-SB-…). Reason: "…"" when overridden). Automatic
steps are `SYSTEM invoices.issue` / `invoices.reissue` / `invoices.refresh` / `invoices.deem` rows (actor "Linear
Hub"): one per week for issue and deem, one per reissued invoice, one per batch of refreshed ones. Unchanged saves write nothing. The client reports "Print invoice" and "Download PDF" as exports
(`reportAuditEvent`, formats `print` / `pdf`).

Attention (`lib/attention/invoices.ts`, kind `invoices`, read-only):

- reps and leaders: `invoices:open:<id>:v<version>` "Check and accept your invoice" ("… by 12:00 Thu 22 Oct" once
  the deadline is under 24 hours away); for a new version "Your invoice changed: £300.00 (was £345.00)" when the total
  moved, "Your invoice was reissued" when only the paid lines did, "The office fixed your invoice" after Fix and
  reissue. The body names the deadline: "w/c 12 Oct, £300.00. Accept it or say what's wrong by 08:30 Sat 24 Oct;
  after that it counts as accepted." A deadline at 00:00 reads "midnight on Thu 22 Oct", never "00:00 Fri 23 Oct";
  `invoices:resolved:<id>:<at>` "The office replied about your invoice" for 7 days. All severity `info`: they sit in
  the bell and the top box and never pop up as a toast (a warning toast covered the open invoice's own Accept / Send
  buttons on phones, and offered "Open My pay" on My pay);
- admin: `invoices:dispute:<id>:v<version>` "Harry Donnelly says something's wrong" → `/finance?tab=company#disputes`,
  and on the day before and the day of a deadline `invoices:waiting:<date>` "12 invoices not accepted yet" (count).

One SQL statement per caller (the person's own invoices, with the replaced version's total from a sub-select; the
admin's disputes and the waiting count in one `UNION ALL`). Measured on the merged demo: the whole feed takes the
admin 12 statements (was 13 with P2's two admin queries, over the 1.1 budget of 12), a leader 12, a rep 6, a
recruiter 4.

### Client statements from Gmail (P3)

Every `/statements` path is **admin only** (router-wide). Anonymous → 401; a client account → 403
`{ clientPortalOnly: true }` (the client guard); leader, recruiter, rep → 403. Types: `shared/src/types/statements.ts`.

| Route | Answer |
| --- | --- |
| `GET /statements?campaignId=&status=` | `StatementSummary[]`, newest first (`status` one of `parsed`, `needs_review`, `applied`, `failed`; 400 otherwise). Adds `unmatchedCount`, `campaignColor`, `appliedByName`, `sender`, `senderVerified` (email only: Gmail confirmed the sender; `null` for an upload) and `supersededBy` (the later statement for the same period that replaced an applied one). |
| `GET /statements/:id` | `StatementDetail`: the rows (with `userName`), `table` (headers, body cells, the column mapping and whether it came from the campaign's saved columns, the layout `totals` / `per-sub`), `people` (per matched person and pay week: logged, confirmed, cancelled, and `weekConfirmed`, the whole-week figure sent to pay), `notListed` (people who logged sales for the campaign in the period but are on no row — worked out once every row is matched), `blockers` (why Apply is refused, in plain words), `warnings`, `effect` (P1's `applyConfirmedSales` dry run while nothing blocks; the stored real result once applied), `template`, `subject`, `replaces` / `replacedBy` (`StatementLink { id, receivedAt, appliedAt, periodStart, periodEnd }`: the applied statement for exactly the same period this one replaces — or replaced, once applied — and the later one that replaced it), `dropped` (`StatementDropped { userId, userName, logged, confirmedBefore }`: people on the statement being replaced who are not on this one) and `outsidePeriodCount` (rows dated outside the period). An applied statement shows the figures as applied (from `statement_allocations`), whatever the gauges say later. |
| `GET /statements/:id/file[?download=1]` | The PDF (`inline`, or `attachment` with `download=1`), `Cache-Control: private, no-store`, `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` so the statement page can frame it (every other response keeps `DENY` / `'none'`). A demo statement's PDF is drawn the first time it is asked for. 404 "Statement PDF not found" when the file is missing; a stored path outside the statements folder is never read. **Audited** (the PDF lists people's earnings) through P9's `recordClientEvent`: an inline open as "Opened the statement PDF: BCN 12–18 Oct 2026" (the same person again within a few minutes adds no row), a download as "Exported BCN statement for 12–18 Oct 2026 as PDF". |
| `POST /statements/upload?fileName=&campaignId=` | **The body is the PDF itself** (`Content-Type: application/pdf`), read on this route only with `express.raw` (limit `STATEMENT_MAX_BYTES`, 20 MB). 415 another content type, 400 empty, 413 "This PDF is over 20 MB", 422 "This file is not a PDF", 404 unknown campaign, 409 with `details.statementId` when the same bytes are already stored ("This PDF is already here: the BCN statement for 5–11 Oct 2026, received Wed 14 Oct."). → **201** `StatementSummary`. A PDF that cannot be read is still stored, with status `failed` and the reason in `error`. The stored file name never keeps a path. |
| `PATCH /statements/:id` `{ campaignId?, periodStart?, periodEnd? }` | → `StatementDetail`. Both period ends or neither; start ≤ end; at most 92 days. A new campaign re-reads the rows with that campaign's saved columns and matches them again (picks by hand are kept). 409 once applied. |
| `DELETE /statements/:id` | 204; the rows go too, and the file when no other statement uses it. 409 once applied. |
| `POST /statements/:id/apply` | → `StatementDetail` (status `applied`, `appliedAt`, `appliedByName`, the stored `effect`). 409 with the first blocker in plain words ("1 row is not matched to anyone yet: …"), or "This statement is already applied." |
| `PUT /statements/:id/rows/:rowId` `{ userId: number \| null }` | → `StatementRow` + `rememberedRef` + `alsoMatched`. `null` = "not one of ours" (left out of Apply). The pick also goes to every other unmatched row of the statement written the same way (same name and fundraiser ID — a per-sign-up statement lists a person once per sub); `alsoMatched` says how many. When the row has a fundraiser ID that nobody has at that campaign and the person has none there yet, it is saved as theirs (`rememberedRef`) and the campaign's unapplied statements match again. 404 an unknown row or person (client accounts are not people here), 409 once applied. |
| `GET /statements/templates/:campaignId` | `StatementTemplate` (404 until saved). |
| `PUT /statements/templates/:campaignId` `StatementColumnMapping` | → `StatementTemplate`. Each field a header text (what the page sends) or a column index; `null` leaves it out. Needs the name or ID column and a count, date or status column (400 otherwise). Re-reads the campaign's unapplied statements with it (picks kept). |
| `GET /statements/client-refs?userId=` | `ClientRef[]` (everyone's without `userId`). |
| `PUT /statements/client-refs/:userId` `ClientRef[]` (or `{ campaignId, ref }[]`) | → that person's `ClientRef[]`. Replaces all of them; a blank `ref` removes one; at most 40 characters. 409 "FR-2041 is already Jordan Lee’s fundraiser ID at BCN." 404 unknown person or campaign, or a client account. Unapplied statements of the campaigns concerned match again. |
| `GET /statements/senders`, `PUT /statements/senders` `StatementSender[]` | The whole list (PUT replaces it; addresses lower-cased, duplicates dropped; 400 a bad address, 404 an unknown campaign). |
| `GET /statements/mail` | `MailSettings` + `lastFetchAt`, `checkEveryMinutes` (15). Never the app password, only `hasPassword`. |
| `PUT /statements/mail` `{ address?, appPassword?, enabled? }` | → `MailSettings`. The app password is 16 letters (Google shows four groups of four; spaces are fine; 400 otherwise), stored encrypted (`lib/crypto.ts` `encrypt`, the app-secret key); `''` removes it. `enabled: true` needs an address and a password (400). Removing either turns the check off. A new address forgets where the last check got to. |
| `POST /statements/mail/test` | `MailTestResult` `{ ok, message }` — "Connected to Gmail as matt@… (read-only). 2 emails from your statement senders in the last 60 days." or the failure in plain words (also kept as `lastError`). 409 when no address / password is saved. One test at a time (presses while one runs share it) and at most one connection every 10 seconds: a quicker press answers the last result, so the button can never get the account throttled by Google; a new address or app password is tested afresh. |
| `POST /statements/check-now` | `CheckNowResult` `{ checked, fetched, parsed, applied, errors[] }` — one check now (a check already running is shared). 409 when Gmail is not set up. 429 after 12 checks by the same person in 10 minutes: "That is more than 12 Gmail checks in 10 minutes. Linear Hub also checks by itself every 15 minutes, so wait a few minutes before you press Check now again." A press that shares a running check, and a 409, do not count. The 15-minute job is not limited. |

**Last fix round:**

- **Upload limit.** `POST /statements/upload` answers 429 after 30 PDFs read for the same person in 10 minutes: "That is more than 30 statement uploads in 10 minutes. Wait a few minutes, then upload the rest." A duplicate, refused before reading, does not count. The counters are in P3's router (`STATEMENT_CHECKS_PER_WINDOW`, `STATEMENT_UPLOADS_PER_WINDOW`), not `middleware/writeLimit.ts`.
- **A failed PDF can be uploaded again.** The same bytes as a statement with status `failed` (a reader that timed out or stopped) are no longer refused with 409. The failed copy is discarded and the PDF is read afresh: 201, with `replacedFailedId` in the answer. Its audit row ends "(it replaces the copy received before, which could not be read either)" when it fails again. A statement that was read is still a duplicate (409).
- **`StatementDetail.dropped` stays on an applied replacement** (kept with the effect in `effect_json`; `effect` is still P1's `ApplyResult` as it was). Its warning reads "1 person was on the statement this replaced but not on this one (Oliver Bennett): their weeks went back to the subs they logged." Their pay lines are sent with `notOnStatement: true`, so P1 words them "Not on BCN's corrected statement: back to the 22 subs logged, …".
- **The Apply audit row counts them:** "Applied the BCN statement for 28 Sep – 4 Oct 2026: 1 person, 1 person back to the subs they logged, 0 cancelled subs, +£40.00 on the next pay runs". The automatic `SYSTEM statements.apply` row does the same.
- **New blockers** (409 on Apply, listed in `blockers`): "A sign-up for Rhys Morgan is dated Thu 14 Oct 2027, after today. Check the dates with the PDF, or mark the row as not one of ours." and "… more than 31 days outside the statement's period (12–18 Oct 2026). …". Several rows: "3 sign-ups are dated after today (the first: …)". A totals row with its own period reads "A row for … covers …".
- **New warning (holds the statement in Needs review):** "Rhys Morgan logged 4 FCB sales on days this statement has no row for them (w/c 28 Sep): they count as cancelled. Check with the PDF before you press Apply." It appears for a totals statement whose rows for a person each have their own period and leave some of the statement's days out.

Audit (`server/src/lib/audit/statementSpecs.ts`): every write above has a spec — "Changed the Gmail statements settings:
address matt@gmail.com, app password saved, automatic check on" (never the password, and nothing when nothing
changed), "Tested the Gmail connection: failed (IMAP is off …)", "Checked Gmail for statements: 2 new statements, 1
applied automatically", "Changed the statement senders: added BCN commissions@…", "Saved the statement columns for
BCN: …", "Changed Jordan Lee’s client IDs: BCN FR-2065", "Uploaded a statement: BCN statement for 5–11 Oct 2026 (20
rows, 20 matched)", "Applied the BCN statement for 5–11 Oct 2026: 20 people, 4 cancelled subs, −£40.00 on the next pay
runs", "Matched “J. Lee” (and 15 more rows written the same way) on the CHN statement for September 2026 to Jordan Lee",
"Changed …: campaign BCN, period …", "Discarded …". Automatic steps are recorded as "Linear Hub" (`recordSystemEvent`):
`SYSTEM statements.fetch` ("Fetched 2 statements from Gmail: BCN 5–11 Oct 2026, CHN September 2026; 1 applied
automatically"), `SYSTEM statements.apply`, and `SYSTEM statements.mail_error` (once per new failure, not every 15
minutes).

Needs attention (`server/src/lib/attention/statements.ts`, admins only, one SQL statement, the last 60 days, at most 6
statement items): `statements:review:<id>` (warning, "BCN statement for 12–18 Oct 2026 needs a look" — the period tells
two statements of one client apart — with what to do: rows to pick, no campaign, no period, it replaces an applied
statement, rows dated outside its period, Gmail could not confirm the sender, or the client's columns not saved yet),
`statements:failed:<id>` (warning, "A statement could not be read", with the reason), `statements:ready:<id>` (info, "…
ready to apply"), `statements:mail:<hash>` (danger, "The Gmail check for statements is failing", while the check is on).
Each links to `/finance/statements?statement=<id>` (or `/settings#integrations`).

### PDF downloads (P4)

P4 adds no server routes and no tables. Everything runs in the browser; the only server call is the audit report.

#### POST /audit/events (P9's route, called by every export)

Each download sends one event (`features/pdf/report.ts` `reportExport(format, filename, rows, what?, ownerId?)`); the
file is already on the device, so a report never blocks or fails it. A report Linear Hub could not take — no signal,
a 5xx, 408, 429 (P9's 60 a minute), or 401 (the session ended) — waits on the device and is sent later (see Logic,
"Exports made without signal"); a 400 or 403 is dropped, since it would be refused again:

| Export | Body |
| --- | --- |
| Export ▾ CSV | `{ kind: 'export', format: 'csv', what, rows, filename }` |
| Export ▾ PDF | `{ kind: 'export', format: 'pdf', what, rows, filename }` (the file name ends in `.pdf`) |
| Audit → Download PDF | `{ kind: 'export', format: 'pdf', what: 'audit-trail', rows: <entries>, filename }` |
| Learning → Progress → Download PDF | `{ kind: 'export', format: 'pdf', what: 'learning-progress', rows: <lessons>, filename }` |

Release 1.3 fix round (I3): `reportExportEvent(event, ownerId?)` in the same file takes a whole
`ClientAuditEventInput` (so a PDF of ONE record can name it: `entity`, `entityId`) and uses the same outbox when
`ownerId` (the signed-in person's id) is given; without it, it is sent once, like `reportAuditEvent`.
**For the lead (one line each, outside P4's files):** P2's `features/invoices/invoicePdf.ts` (PDF) and
`features/finance/PayslipModal.tsx` (print), P7's `features/recruitment/pdf.ts` (profile, interview sheet) and P8's
`features/venues/venueReport.ts` still call `reportAuditEvent`, so those PDFs made without signal are not recorded;
switching each to `reportExportEvent({ …same event… }, user.id)` gives them the outbox (the caller needs the signed-in
person's id).

`what` is the page's `auditWhat` prop, else the CSV file name's section (shared `exportWhatFor`): e.g.
`gauges-by-team-deansgate`, `leaderboard-week-sales`, `payslips` — lower case, hyphens, at most 80 characters.
`server/src/test/pdf-export.test.ts` sends exactly these bodies: 204 for admin, leader, recruiter and rep; 403
(`clientPortalOnly`) for a client portal session; 401 anonymous. P9's validation must keep accepting them (checked
against P9's branch: its zod schema accepts them and drops unknown keys, so a replayed report carries no extra field).
Waiting reports also call `GET /auth/me` once before they are sent, to check the session is still that person's.

#### Client: `client/src/lib/pdf` (STABLE; additions marked "Release 1.3 (P4)")

- `PDF_EXPORTS_READY = true`.
- `exportTablePdf(TablePdfOptions)` → downloads the file. Options as laid down (`title`, `subtitle?`, `filters?`,
  `columns` = the CSV `CsvColumn`s, `rows`, `totals?`, `filename`, `orientation?` 'auto') plus `generatedBy?` (name after
  "Generated …") and `now?` (the clock, for tests).
- `pdfDocument(PdfDocumentOptions)` → `PdfDoc`. Options: `orientation?`, `title?` (metadata and the running header of
  later pages), `generatedBy?`, `now?`. Chainable blocks, each drawn once:
  - `header({ title, subtitle?, meta?, filters? })` — the brand band, then the title; `meta` pairs on the right
    (`[['Invoice', 'LM-SB-2026-000123'], ['Due', 'Fri 23 Oct 2026']]`), `filters` lines under the subtitle.
  - `addressBlocks(left, right)`, `heading(text)`, `paragraph(text, { muted?, size? })`, `keyValues(rows)`,
    `lineTable(columns, rows)` (`width` relative, `align`, `muted` rows in grey), `table(csvColumns, rows)`,
    `totals(rows)` (`strong` = the bold total with a rule above), `signatureBlock(left, right?)` (`imageDataUrl` a PNG
    or JPEG data URL; an unreadable image leaves the line blank), `footer(text)`.
  - New: `space(mm?)`, `pageBreak()`, `needs(mm)` (start a new page unless that much room is left — keep a heading with
    its table), `bytes()` (the file as `Uint8Array`).
  - `save(filename)` / `blob()` / `bytes()` finish the file once (running headers, "Page x of y"); later calls return
    the same bytes.
- `preloadPdf()` starts loading the PDF chunk (ExportButton calls it when its menu opens).
- `PdfUnavailableError` when the chunk cannot load ("You are offline. Connect and try the PDF again — the CSV works
  offline." or "Could not load the PDF maker … Reload the page and try again.").
- `PdfLineRow` is now `{ [key: string]: string | boolean | undefined; muted?: boolean }` (the laid-down
  `Record<string, string> & { muted?: boolean }` could not be written as a literal with `muted: true`). Cells are
  strings; anything else prints empty.
- `render.ts` (the drawing, `buildTablePdf`, `createPdfDoc`, `prepareTable`, `tableFontSize`, `PDF_COLOURS`) and
  `engine.ts` (jsPDF + jspdf-autotable, the lazy chunk) are internal: import `@/lib/pdf`.

#### Client: `client/src/lib/csv.ts`

- `CsvColumn.kind?: PdfCellKind` ('text' | 'number' | 'money' | 'date' | 'datetime' | 'percent') — how the PDF writes
  the column. Without it the formatter says (`csvMoney` → money, `csvDate` → date, `csvDateTime` → datetime,
  `csvPct(n)` → percent, `csvDecimal(n)` → number), else a column of plain numbers without a formatter is 'number',
  else 'text'. CSV output is unchanged (byte for byte).
- New helpers: `csvColumnKind(column, sample?)`, `csvCellText(row, column)` (the exact CSV cell text before quoting),
  `downloadBlob(filename, blob)` (`downloadCsv` uses it).

#### Client: `ExportButton` (`features/common/ExportButton.tsx`)

Every call site is unchanged. With `PDF_EXPORTS_READY` and `pdf !== false` it is an **Export ▾** menu: **CSV**
("Spreadsheet · opens in Excel") and **PDF** ("To print or share"). The default label "Export CSV" now reads "Export";
a custom label keeps its words ("Export hired candidates"). `pdfTitle`, `pdfFilters`, `pdfTotals`, `auditWhat` refine
the PDF and the audit name. While nothing is on screen the button is disabled with the old hint.

- Filter lines: without `pdfFilters`, the PDF prints what the file name says (status, team, dates) plus the filters
  set in the button's own filter bar (`report.ts` `screenFiltersNear`): drop-downs with an "all" choice that are set
  ("Team: Northern Lights", "Position: Field Representative", "Source: Indeed", "Owner: Priya Shah") and search boxes
  with words in them ("Search: “Zed”"). That covers Team, Recruitment's list and Gauges with no call-site change. A
  page whose filters are not beside its button (or not drop-downs / search boxes) passes them in words.
- Release 1.3 fix round (I3): `pdfScreenFilters?: string[]` — the filters set on screen, in words, used instead of
  what is read beside the button and printed the same way (with the file name's lines, a line with the same label
  giving way to it, the date range last). `pdfFilters` still replaces every filter line. Two call sites pass it (the
  only call-site changes, outside P4's files): Recruitment's board **Hired** column (`pages/Recruitment.tsx`: "Source:
  Indeed", "Owner: Priya Shah", "Search: “…”" from the same state its query uses) and a rep's **Leaderboard**
  (`pages/Leaderboard.tsx`: "Team: Northern Lights", shown on screen as a badge, not a picker).
- The menu opens above the toast stack (`Dropdown aboveToasts`, see below), so a toast never covers CSV / PDF.
- Each mounted button sends any export reports that waited on this device for its signed-in person.

#### Client: `components/ui/Dropdown.tsx` (outside P4's files: one additive prop)

`aboveToasts?: boolean` (default false): the menu panel uses `z-[90]` instead of `z-[70]`, above the toasts
(`z-[80]`). Only ExportButton passes it; every other menu is unchanged. Needed because near the foot of the window
the Export menu opens upwards into the toast corner, where an attention toast ("34 runs to pay · …") or an export
toast covered the items and took the click.

#### Client: slots filled

- `features/pdf/AuditPdfButton` `{ entries, filters, total?, query? }` — **Download PDF** in the Audit header (When,
  Who, What happened, Record, Changes) under P9's filter lines. New optional props: `total` (GET /audit `total`) and
  `query` (the view's GET /audit query without `limit` / `offset`). With both, the PDF holds every matching entry,
  newest first, up to 2,000 (read 200 at a time, the server's most), and says "The newest 2,000 of 2,550 matching
  entries" when capped; without them it is the page on screen and says so ("The 50 entries on screen (more may match
  the filters)", fix round I3). The Who column names a row as the Audit page does (`features/pdf/auditPdfText.ts`
  `auditPdfWho`, from the shared rules behind `kinds.tsx` `auditActorName`): "Attempt on Jordan Lee's account" for a
  failed try on the sign-in page, "Unknown person" for an email nobody has, "Linear Hub" for an automatic step.
  **P9 / the lead: wire it in
  `pages/Audit.tsx`:** `total={total}` and `query={{ userId, entity: entity || undefined, entityId, from: from ||
  undefined, to: to || undefined, q: q || undefined, kind: kind || undefined }}` (on the foundation's page:
  `signIns: signIns ? undefined : 0` instead of `kind`).
- `features/pdf/ProgressPdfButton` `{ userId? }` — **Download PDF** on Learning → Progress (own view and a person's):
  the COD pack checklist, the next level's requirements and the required videos (P5's `GET /videos` for oneself,
  `GET /videos/team?userId=` for someone else; left out while none apply). `features/pdf/progressVideos.ts` (pure,
  node-tested) picks them: the own view lists the required videos that apply to the person's role (`videoRequiredOf`,
  the same rule as P5's shared `videoRequiredFor`, which can replace it once P5 lands); another person's view says
  "2 of 2 required videos watched" from that person's `requiredTotal` (not the body's `required`, which counts every
  audience's videos) and lists them from `cells` / `videos`.

#### Shared: `shared/src/logic/exportFormat.ts`

`PDF_PORTRAIT_MAX_COLUMNS`, `PdfOrientation`, `pdfOrientationFor` (as laid down) plus `PdfCellKind`,
`PDF_WINANSI_EXTRAS`, `toPdfText`, `pdfSafeText` (per line since fix round I3), `pdfGuardLine` (I3: the guard for a
line exactly as drawn), `pdfInfoText`, `pdfMoney`, `pdfNumber`, `pdfDate`, `pdfDateShort`,
`pdfDateTime`, `pdfDateRange`, `pdfPageLabel`, `pdfCellText`, `isNumericCell`, `isNumericColumn`, `parseExportFilename`,
`pdfFilenameFor`, `exportWhatFor`, `pdfHeadingFor` (now also takes `screenFilters`), `pdfGeneratedLine`, and
`asciiFold` (re-exported from the new `shared/src/logic/textFold.ts`, which holds the fold and transliteration tables
so the main chunk, which names every CSV file, does not pull in the rest). Unit tests: `exportFormat.test.ts` (22).

#### For the packages that draw page PDFs (P2, P7, P8)

```ts
import { PDF_EXPORTS_READY, pdfDocument, exportTablePdf } from '@/lib/pdf';
import { reportExport, reportExportEvent } from '@/features/pdf/report';

const doc = await pdfDocument({ title: `Self-billed invoice ${inv.number}`, generatedBy: fullName(me) });
doc.header({ title: 'Self-billed invoice', subtitle: weekLabel, meta: [['Invoice', inv.number], ['Due', due]] })
  .addressBlocks(supplier, customer)
  .lineTable(columns, lines)        // muted: true for "not paid" lines
  .totals([{ label: 'Total due', value: '£234.00', strong: true }])
  .signatureBlock(office, person)
  .footer(`Linear MCR Limited · Self-billed invoice ${inv.number}`)
  .save(`linear-hub-invoice-${inv.number}.pdf`);
reportExport('pdf', filename, lines.length, 'invoice');
// or, naming the one record the PDF is of (I3):
reportExportEvent({ kind: 'export', format: 'pdf', what: `invoice ${inv.number}`, filename, entity: 'invoice', entityId: inv.id }, me.id);
```

P8's venue report: `exportTablePdf({ title, subtitle, filters, columns, rows, totals, filename })`, or a
`pdfDocument` with `heading` + `table(columns, rows)` per section. Money passed to `lineTable` / `totals` is already
text ("£1,234.50"); in `table`/`exportTablePdf` use the CSV formatters (or `kind`) and the PDF writes it as on screen.

### Learning videos (P5)

All under `/api/videos` (`server/src/routes/videos.ts`), behind `requireAuth`: anonymous → 401; a client portal
account → 403 `{ clientPortalOnly: true }` on every one of them (the foundation's client guard). Types in
`shared/src/types/videos.ts`. A video outside the caller's audience answers **404 "Video not found"**, exactly like one
that does not exist.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /videos` | staff | `LearningVideo[]` the caller's role sees, newest first, each with `my` (their own progress or null) |
| `GET /videos/access` | staff | `{ canAdd, uploadRoomBytes? }`: `canAdd` is true for admins always, and for leaders while Settings → Learning videos allows it. `uploadRoomBytes` (only for admins and leaders who may add videos) is the bytes an upload may use now: free space, less the reserve, less what the uploads already arriving will still write. It is null when the server cannot tell |
| `GET /videos/settings` · `PUT /videos/settings { leadersCanAdd }` | admin | `VideoSettings { leadersCanAdd, storage: { uploads, bytes, folder } }` (`storage` on GET and PUT answers only) |
| `GET /videos/team[?userId=]` (cached) | admin (everyone), leader (own team) | `TeamVideoProgress { required, rows, videos }`; `?userId=` one person (a leader: themself or their team, else 403; a client account or unknown id 404) |
| `POST /videos` `VideoLinkInput` | admin; leader when allowed | 201 `LearningVideo`. 400 for anything but a YouTube, Vimeo or Google Drive video link; 409 "This video is already in Learning as “…”" for the same video in any form of link |
| `POST /videos/upload` (multipart) | admin; leader when allowed | 201 `LearningVideo`. See *Uploads* below |
| `GET /videos/:id` | staff in its audience | `LearningVideo` |
| `GET /videos/:id/stream` (+ `HEAD`) | staff in its audience | the file: 200, or 206 for a `Range: bytes=…` request, 416 past the end; `Accept-Ranges: bytes`, `Cache-Control: private, no-store`, `ETag`, `If-Range`. 404 for a link; 404 "The video file is missing on the server: restore the media folder from your backup, or upload the video again" when the row's file is gone |
| `GET /videos/:id/poster` | staff in its audience | the upload's still (JPEG, `private, max-age=86400`); 404 without one |
| `POST /videos/:id/poster { image, durationS? }` | whoever may edit it | `LearningVideo`. `image` = `data:image/jpeg;base64,…` of at most 600 KB (fits the 1 MB JSON limit); `durationS` fills a missing length only (and then counts everyone who has already seen 90% of it as watched). 400 for a link or anything but a JPEG |
| `GET /videos/:id/views` | admin | `VideoViewRow[]`: everyone who started it (never client accounts), watched first, with `marked` when **Mark as watched** made it watched (stored when it happened) |
| `PATCH /videos/:id` `VideoUpdateInput` | admin; the leader who added it while leaders may add | `LearningVideo`. Title, description, topic, audience, required, `durationS` (the link itself never changes; a new length counts everyone who has already seen 90% of it as watched, and never takes "watched" back); 400 "Nothing to change" for `{}` |
| `DELETE /videos/:id` | same | 204; an upload's file and still are deleted too; everyone's progress goes (CASCADE) |
| `POST /videos/:id/progress` `VideoProgressInput` | staff in its audience | `VideoProgress` (their own row only), with `marked` and `owedS`: seconds the report showed as seen that are not counted yet (over the watch credit). 429 after 30 reports by the same person for the same video in a minute: "That is more than 30 progress reports for this video in a minute. What you watch is kept and counted from your next report." The player sends about 4 a minute |

`LearningVideo` adds to the foundation's fields: `provider` ('youtube' \| 'vimeo' \| 'drive'), `thumbnailUrl`
(YouTube's still from i.ytimg.com, or `/api/videos/:id/poster`), `canEdit`; `VideoProgress` (and so `LearningVideo.my`)
adds `marked`. File paths are never sent. `embedUrl` is
the plain embed; the page builds the tracking one (`videoEmbedUrl(url, { startS, origin })`).

**Uploads** (`POST /videos/upload`, the app's only multipart route; `lib/videos/upload.ts`, busboy 1.6.0). Parts in
the order `VIDEO_UPLOAD_FIELDS`: `title`, `description`, `topic`, `audience`, `required` ("true"/"false"),
`durationS` (whole seconds, optional), `poster` (optional JPEG ≤ 600 KB; one that is not a JPEG is left out), then
`video` last. The fields are validated when the video part starts, so a missing title fails at once, not after 2 GB.
The file streams straight to `media/videos/<uuid>.upload` and is renamed to `<uuid>.mp4|webm|mov` once complete.
Refusals: 400 not multipart / no file / empty file / cut off; 413 over 2 GB (a declared `Content-Length` over the cap
is refused before reading; the counter stops a lying one) or too many parts; 415 "Upload an MP4, WebM or MOV video"
when the first bytes are not an ISO media (MP4 / MOV) or WebM container, whatever the name says; **507 before the
file is read** when the disk has no room for it: an upload may use the disk's free space less a reserve of a tenth of
the disk, at most 500 MB (a 1 GB cloud volume keeps 100 MB for the database and its backups): "The server has room for
420 MB more and this video is 1.3 GB. Free some disk space on the server, or add the video as a YouTube, Vimeo or
Google Drive link." (or "The server is almost out of disk space. …" without a declared size). The room counts the
uploads already arriving: each holds its declared size, less what it has written, until it ends (last fix round). So
two uploads that each fit, but not together, are never both let in. 507 also if the disk fills while it arrives:
"The server ran out of disk space while this video arrived. Free some disk space on the server, or add the video as a
YouTube, Vimeo or Google Drive link." Any failure removes the partial file and answers with `Connection: close`. While at least one upload is
arriving the HTTP server's `requestTimeout` is raised from Node's 5 minutes to 3 hours (a 2 GB file over a hotspot)
and put back once the last one ends.

**Progress** (`POST /videos/:id/progress`): `{ watchedS, positionS?, ended?, ranges?, durationS?, markWatched? }`.
`ranges` (≤ 200 per report) are the parts seen since the page opened; the server merges them with the stored ones and
counts each second once (`watched_s` never goes down). Without `ranges` a link keeps the larger of `watchedS` and what
it had; for an upload a bare `watchedS` adds nothing (its player always sends the parts it showed). What one report
adds is limited by the **watch credit** (below), so "watched" cannot be claimed with one request. `ended` puts the
resume position back to 0. `markWatched` is for links only (400 for an upload: "An uploaded video counts as watched
once you have seen 90% of it"). A video without a length takes `durationS` from a report by someone who may edit it
(and then everyone who has already seen 90% of it counts as watched); anyone else's reported length only limits their
own ranges, and decides their own "watched" for a link only — **an upload without a length of its own counts as
watched only once it has one**. A link watched to 90% of a length only the viewer's own player reported is stored as
**Marked** (their own word, like Mark as watched). Once the link has a length, a viewing measured at 90% of it becomes a
watch (last fix round). A report that makes a video watched clears the response cache itself. The others no longer
clear it either: the blanket "every write clears the cache" step in `app.ts` skips progress reports (the P5 merge
note, applied in the last fix round).

**Audit** (`lib/audit/videoSpecs.ts`): "Added video: “…” (YouTube link)" / "(upload, 312 MB)"; "Updated video “…”:
required no → yes" (nothing when nothing changed; a description is named, never quoted); "Deleted video “…”"; "Added a
still to video “…” (length 0:42)" / "Replaced the still of video “…”"; "Changed learning video settings: leaders can
add videos no → yes". Progress writes a row only when it makes the video watched for that person ("Watched “…”" or
"Marked “…” as watched"). The report every 15 s writes nothing. Last fix round: a report from an editor's player that
gives the video its length writes "Set the length of video “Team talk” to 1:04 (from Danil Varianyk’s player);
counted 1 person as watched". Edit video and the still step add "; counted N people as watched" when a new length
counts people. Snapshots never hold a file path.

### Client accounts and campaign pages (P6)

Every route is behind `requireAuth` (anonymous → 401). A client session reaches **only** `/client/*` (and its own
`/auth/me`, `/auth/pin(/*)`, `/auth/logout`, `/health`): the foundation's client guard answers 403
`{ error: 'This account can only use the client portal', clientPortalOnly: true }` everywhere else, `/client-posts`,
`/client-accounts` and `/campaigns/:id/page` included (P6's test walks every route of the app).

#### The client's portal (`routes/client.ts`, client accounts only — staff 403)

| Route | Answer |
| --- | --- |
| `GET /client/portal` | `ClientPortal { campaign: { id, code, name, color }, me: { id, name, email }, posts }` — the client's own campaign only, posts newest first (at most 200). |
| `GET /client/posts` | `ClientPost[]`, the same list. |
| `POST /client/posts` `ClientPostInput` | **201** `ClientPost`. `update` / `announcement`: published straight away — an `announcements` row authored by the client account (so it carries `fromClient`, the badge "From Breast Cancer Now"), `status: 'published'`, `announcementId` set. `commission`: `status: 'pending'`, no announcement; `rateRep` (£ per sub to the fundraiser) and / or `ratePayout` (£ per sub to Linear), `effectiveFrom` today … today + 366 days (business clock), kept as `requestedFrom` too; title and message optional (default title "Commission change from Mon 2 Nov"). **400** `{ error: <first problem>, details: [{ path, message }] }` from the shared `clientPostProblems` (the portal form's own rules); **429** after 20 posts in 24 hours; the same post again within two minutes (a double tap) answers **200** with the first post and writes nothing. Both windows count on the **real clock** (`client_posts.posted_at`), like every rate limit; `created_at`, what everyone reads, is the business clock. The campaign always comes from the session, never the body. |

The client's copy of a post never names the office: `decidedBy` is `null` and `decidedByName` / `unread` are absent.
`decisionNote` reaches the client **only on a declined change** (the reason, written for them); the note Matt may add
when he approves or unpublishes is the office's own and is always `null` in `GET /client/portal` and `GET /client/posts`.

#### The office (`routes/clientOffice.ts`)

| Route | Roles | Answer |
| --- | --- | --- |
| `GET /client-posts?status=&campaignId=` | admin, leader | `ClientPost[]` newest first, each with `unread` for the caller (no read receipt and newer than 30 days, not unpublished). 400 for an unknown status. |
| `GET /client-posts/unread` | admin, leader | `{ count }` — the sidebar Campaigns badge. |
| `POST /client-posts/read` `{ ids: number[] }` | admin, leader | 204: the caller's receipts for every listed post in **one** statement (at most 200 ids, unknown ids ignored, idempotent; not audited). The campaign page sends one of these per visit instead of one request per post. 400 for a missing or bad list. |
| `POST /client-posts/:id/read` | admin, leader | 204, idempotent (the caller's own receipt; not audited, like announcement reads). |
| `POST /client-posts/:id/approve` `{ effectiveFrom?, note? }` | admin | `ClientPost` (`status: 'approved'`, `effectiveFrom` = the date Matt confirmed, default the client's; `requestedFrom` keeps the client's; `note` is an office note, never shown to the client). Adds the campaign rate through **P1's `addCampaignRate`** (`source: 'client'`, `clientPostId`), which recalculates unpaid weeks from that date; a rate the change leaves out keeps the one in effect on that date. The post and the rate are written in one transaction: if P1's call fails (the foundation stub answers 501), nothing changes. 409 unless a pending commission change; 400 for a date that is not a date, more than a year ahead, or before the campaign started. |
| `POST /client-posts/:id/decline` `{ note }` | admin | `ClientPost` (`status: 'declined'`, `decisionNote` shown to the client). The reason is required (400). 409 unless pending. |
| `POST /client-posts/:id/unpublish` `{ note? }` | admin | `ClientPost` (`status: 'unpublished'`, `announcementId: null`): the Announcements row is deleted (its read receipts with it). The note stays in the office. 409 unless published. |
| `PATCH /client-accounts/:id` `ClientAccountUpdateInput { status?, firstName?, lastName?, email? }` | admin | `ClientAccount`. `status: 'left'` signs the client out everywhere at once. 400 with nothing to change, 409 for an email in use, 404 for an unknown id **or a staff member**. |
| `POST /client-accounts/:id/reset-pin` | admin | `ClientAccount` (`hasPin: false`): PIN, failed count and lock cleared, every session ended; they create a new PIN at the next sign-in. 404 for staff. |

#### The campaign page (`routes/campaignPages.ts`, mounted before `/campaigns`)

| Route | Roles | Answer |
| --- | --- | --- |
| `GET /campaigns/:id/page` (cached per person) | every staff role | `CampaignPage`. **Admin, leader** (`full: true`): the campaign with its money, brief and client contact, `rates` (P1's `listCampaignRates`), every post with its status and `unread`; admin also `clientAccounts` and `paidThrough` (the last day of the latest pay week with a paid run, or `null`: the Approve dialog's warning). **Recruiter, rep** (`full: false`): no `payoutPerSale` / `repCommissionPerSale`, no rates, no accounts, `contactName` / `contactEmail` / `contactPhone` are `null` (the client contact's details are for the office), only published posts (never a commission change). Everyone: the client's announcements (authored by this campaign's client accounts, newest 50), this calendar month's events (a rep: own team only, as `GET /events`) and `sales: { thisMonth, lastMonth }` (gauge sales of this campaign's events). 404 for an unknown campaign. |
| `GET /campaigns/:id/client-accounts` | admin | `ClientAccount[]`, active first. |
| `POST /campaigns/:id/client-accounts` `ClientInviteInput { firstName, lastName, email, signInUrl? }` | admin | **201** `ClientInviteResult { account, accessCode, instructions }`: a `client` user (no team, the owner's pay plan, no PIN) with the next access code (`nextClientAccessCode`: CL-0002 onwards, never a demo code). `instructions` is the plain text to email (it names `signInUrl` when sent, an http(s) address). 409 for an email that already has an account (staff included). |

#### Changed 1.0 routes

- `POST /campaigns` and `PATCH /campaigns/:id` (`routes/campaigns.ts`) also take `longDescription`, `brief`,
  `contactName`, `contactEmail`, `contactPhone` (each optional; `''` or `null` clears it, a field left out keeps its
  value; `contactEmail` must be an email) and answer the campaign **plus** those five fields. P1's
  `recordCampaignRateChange` calls are unchanged.
- `GET /auth/pin` (`lib/pin.ts pinStatusFor`): `required` is also `true` for a client account (never for the demo client).

#### Needs attention (`lib/attention/clientPosts.ts`, kind `client`, the bell's "Client updates")

- Admin: `client:commission:<id>` (warning) for every pending commission change, until it is decided — "Breast Cancer
  Now asks to change commission", **Review** → `/campaigns/<id>?post=<id>`.
- Admin and leader: `client:post:<id>` (info) for every other post they have not read, from the last 30 days —
  "Update from Breast Cancer Now", **Read it**. A leader sees a pending change as info ("Waiting for the office").
- Every other role: nothing. One statement per caller, so the feed's 1.1 budget (12 statements) holds with P2's and
  P3's providers merged: for an admin a `UNION ALL` of the pending changes, **all of them** up to the feed's 20 (a
  change to approve is never pushed out by newer posts; the feed keeps warnings ahead of info items), and at most 8
  unread posts, newest first, each part with its own `ORDER BY` and `LIMIT`; for a leader the unread posts alone. Reading a client's announcement in Announcements does not clear its item; opening the campaign page does.

#### Audit (`lib/audit/clientSpecs.ts`)

Every write is recorded: the client's posts with the **client account as the actor** ("Breast Cancer Now posted an
update: “New welcome pack”", "… asked for a commission change: £22.00 per sub to the fundraiser, from Mon 2 Nov"),
approve (plus the `campaign_rate` row it added), decline (with the reason), unpublish (plus the removed announcement and
its text), invite ("Invited Jo Bloggs (CL-0002) to the Breast Cancer Now client portal"), deactivate / reactivate /
edit an account, reset a PIN. Reactivating with nothing else changed reads "Reactivated the client account of Rachel
Okafor (Children's Hospice North)". Read receipts are skipped. `POST /campaigns` and `PATCH /campaigns/:id` are refined from
the 1.2 specs (same wording) so the snapshot holds the brief too. Snapshots never hold a PIN or its hash (`pinSet` only).

### Recruitment: date of birth, schedule, question bank, interview sheets (P7)

Every route is for the recruitment roles only (admin, leader, recruiter; reps 403, a client account 403
`clientPortalOnly`, anonymous 401). The question bank is the admin's and the recruiter's (leaders 403).

| Route | Body / query | Answer |
| --- | --- | --- |
| `GET /recruitment/schedule` | `from`, `to` (YYYY-MM-DD, Europe/London days; default today … today + 6; `from` alone is one day; at most 93 days), `interviewerId` (a person, or `none` for "no interviewer yet"), `type` (`phone` · `first` · `observation` · `final`) | `InterviewScheduleItem[]` by time: the interview, `candidateName`, `candidateStage`, `positionApplied`, `day` (its London date), `sheetQuestions` / `sheetAnswered` (the saved sheet's counts, else the bank's draft count for the type and position) |
| `GET /recruitment/candidates/:id/timeline` | — | `CandidateTimelineItem[]`, newest first (see Logic); 404 "Candidate not found" |
| `GET /recruitment/candidates/:id/sheets` | — | `CandidateSheet[]`: every interview of the candidate with a saved sheet — its type, time, interviewer, outcome, the answers as asked and `summary` |
| `GET /recruitment/questions` | `type` (optional) | `InterviewQuestion[]` in interview order (phone, first, observation, final), then the bank's order |
| `POST /recruitment/questions` | `InterviewQuestionInput { interviewType, text (5–300 characters, whitespace tidied), position? (null = every position), sort? (default: the end of its type), active? }` | 201 `InterviewQuestion`; 409 "That question is already in the final interview list" when the same words (ignoring case and spaces) are already in that type's list for the same position or for every position (a sheet would show it twice) — "…, turned off. Turn it back on instead" when that one is turned off |
| `PATCH /recruitment/questions/:id` | any of the above | `InterviewQuestion` (moving it to another type puts it at the end there); a save of the same values changes nothing; the same 409 when the new words, type or position clash with another question |
| `PUT /recruitment/questions/order` | `{ interviewType, ids }` — every question of that type, once each, in the new order | `InterviewQuestion[]` of that type |
| `GET /recruitment/interviews/:id/sheet` | — | `InterviewSheet { interview (+ candidateName), answers, saved, candidate { id, name, stage, positionApplied, dateOfBirth }, summary, changes }`; a read never writes |
| `PUT /recruitment/interviews/:id/answers` | `InterviewAnswerInput[]` (1–30 items) — the first save sends every question on screen, in order; later saves only **what this device changed**: `{ questionId (a bank question) or null (a question of their own), questionText (required for their own; for a bank question, the words on screen), answer (≤ 4,000 characters), score? (1–5 or null), base? { answer, score } (what this device started from), removed? (true: take the question off), device? + version? (both or neither: the sending browser tab's made-up id, 8–64 letters, digits, `-` or `_`, and its save number, a whole number rising with each save) }` | `InterviewSheet` (each stored answer also says `device`: the tab whose save last wrote it, or null); **409** `{ error: "Question 3 was changed by Rhys Morgan on another device. Choose which answer to keep.", details: InterviewSheetConflictDetails { conflicts: [{ questionId, questionText }], sheet } }` when another device changed (or answered) the same question since this one saw it — nothing is written then; 400 for an unknown bank question, a question twice, their own question without words, an empty list, a bad score, a long answer, or a sheet left with no question or more than 30 |

Changes to the 1.0 routes (`routes/recruitment.ts`, P7's in 1.3):

- `POST /recruitment/candidates` and `PATCH /recruitment/candidates/:id` take `dateOfBirth` (YYYY-MM-DD; `null` or `""`
  clears it). It must be a real date, not in the future, giving an age of 14 to 100 (400 with the reason, e.g. "That
  makes them 11. Check the year: candidates are at least 14"). Every candidate payload carries `dateOfBirth` only when
  it is recorded (`db/queries.ts` mapCandidate, the foundation's hook).
- `POST /recruitment/interviews` also records who booked it, for when (`interview_changes` field `booked`).
- `PATCH /recruitment/interviews/:id` also records each field that really changed — the interviewer (ids), the time
  (compared as instants, so the same moment written another way is no change), the type, the outcome — with who and
  when, in the same transaction. Notes are not logged there (the audit trail has them). It refuses to move an
  interview to another candidate (400 "An interview stays with its candidate. Book a new interview for the other
  candidate"): its bookings, interviewers and sheet belong to its candidate. Sending its own `candidateId` is fine.

Audit (`lib/audit/recruitmentSpecs.ts`): "Added a phone screen question: “…”", "Edited a first interview question:
text …", "Turned off / on a … question", "Reordered the … questions", "Started / Updated the first interview sheet for
Sam Brown: 4 of 6 answered, average score 4.5" (filed under the candidate, the snapshot holds the questions as asked and
the answers). A save that changes nothing writes no row. `POST /recruitment/candidates` and `PATCH
/recruitment/candidates/:id` are refined from the 1.2 specs (same rows, same wording) so a date of birth change is
explained — "Updated candidate Sam Brown: date of birth set to 12 Mar 2001" / "changed from … to …" / "removed (was …)"
— instead of "(no changes)"; when the date of birth does not change the 1.2 rows pass through untouched. If a 1.2
spec is ever not found (P9's file changed), only this refinement is lost, with a warning at start-up; the server still
starts. A refused (409) save writes no audit row.

### Venues, rosters and event plans (P8)

Every endpoint needs a signed-in **staff** account: anonymous → 401, a client account → 403 `clientPortalOnly` (the
client guard, before any router). Nothing here writes a gauge row or touches pay.

#### Venues (`routes/venues.ts`, every staff role, response-cached)

**`GET /venues?sort=sales_per_shift|shifts|last_visit`** → `VenueSummary[]` (default `sales_per_shift`; anything else
→ 400 "Invalid sort"). One row per venue key (`venueKey(venue, city)`, so "Golden Square" and "golden  square" are one
venue), for every venue with a counted shift or an upcoming event (a venue only ever cancelled is left out).

| Field | Meaning |
|---|---|
| `key`, `venue`, `city` | the key; the name as typed on the venue's latest event |
| `eventCount` | **visits**: events at the venue with at least one counted shift |
| `shifts`, `sales`, `stops` | counted shifts (person-days) and their sales and stops |
| `salesPerShift` | sales ÷ shifts, 2 dp (0 without shifts) |
| `lastVisit` | the latest counted visit's date, or null |
| `nextVisit` | the next scheduled or live event dated today or later, or null |
| `campaigns` | campaign codes worked or booked there, most shifts first |

Sorts: sales per shift (highest first; venues with **fewer than 10 shifts** after the rest, venues without a shift
last), shifts (most first), last visit (latest first). Ties: more shifts, then the name.

**`GET /venues/:key`** → `VenueProfile`: 400 "Invalid venue" unless `isVenueKey(key)`; 404 "Venue not found" when no
event was ever held there. Everything in the summary, plus:

- `perShift` (six gauges per shift, 1 dp) and `ratios` (`funnelRatios` of the venue's totals); `company` — the same for
  every counted shift in the company, with `shifts` and `salesPerShift`.
- `byCampaign[]` `{ campaignId, code, name, color, sector, shifts, perShift, salesPerShift, ratios, company }`, most
  shifts first. `company` (`VenueGroupFigures { shifts, perShift, ratios, salesPerShift }`) is the **same campaign
  everywhere** in the company (this venue included).
- `byWeekday[]` `{ weekday (ISO 1 = Monday … 7 = Sunday), shifts, salesPerShift, stopsPerShift, perShift, ratios,
  company }`, days with shifts only; `company` is the **same weekday everywhere**.
- `events[]` — every event at the venue, newest first: `{ id, name, date, type, status, teamName, campaignCode,
  campaignColor, sales, people, booked? }` (`people` = who logged it; `booked` on upcoming events somebody is booked on).
- `lawOfAverages` `{ points, pointsCapped, fittedRate, stopsPerSale, correlation, bands, visits, sentence, stability,
  steadiness, chanceCv }` — see Logic. `points` are anonymous person-days `{ stops, sales, date }` (the 400 most recent;
  every figure uses them all).
- `you?` — the caller's own numbers at the venue `{ shifts, sales, salesPerShift, perShift, ratios }` (absent without a
  shift there).
- `people?` — named rows `{ userId, name, avatarColor, shifts, sales, salesPerShift, stopsPerSale, lastVisit }`: the
  **admin** gets everyone who worked there; a **leader** gets their own (current) team and themself; **reps and
  recruiters never get the key**. Sorted by sales per shift, people with fewer than 3 shifts there after the rest.

#### Bookings and plans (`routes/eventPlans.ts`, mounted at `/events` before the events router)

| Route | Who | Answer |
|---|---|---|
| `GET /events/:id/roster` | every staff role | `EventBooking[]` `{ eventId, userId, userName, avatarColor, bookedBy, bookedByName, bookedAt, source, onLeave? }`, by first name (`onLeave: true` only for someone on leave) |
| `PUT /events/:id/roster` `{ userIds }` or `{ add?, remove? }` | the admin; the leader of the event's team | the roster after the change |
| `POST /events/:id/roster/me` | the admin (any event); a leader or rep of the event's team | the roster ("I'm working this") |
| `DELETE /events/:id/roster/me` | the admin, leaders, reps | the roster ("I can't make it") |
| `GET /events/:id/plan[?userId=]` | every staff role (response-cached) | `EventPlan[]` |

- **PUT `{ add, remove }`** (last fix round; what Edit bookings sends): the changes from the list the page loaded.
  `add` is booked by the caller, `remove` is taken off, and everyone else stays as they are now. So someone who taps
  **I'm working this** while the leader has Edit bookings open stays booked, and the audit row names only the changes.
  It follows the same rules as below. Send at least one of the two; mixing them with `userIds` is a 400.
- **PUT `{ userIds }`** replaces the roster with exactly `userIds` (deduplicated, at most 200; a bad body → 400): people already
  booked keep their row (who booked them, when, how — a self-booking stays `self`); people left out come off; new
  people are booked by the caller with `source: 'leader'`. A new person must be an **active** member of staff in a
  field role (rep, leader or admin; recruiters work in the office) — for a leader, a member of the event's team or the
  leader themself. Another team's event → 403. Unknown event → 404.
- **Error messages name a person only inside the caller's scope.** An unknown id or a client portal account → 400
  "Unknown person (id 35)" (for the admin too: a client account is nobody on the staff side). A leader adding anyone
  outside their team (another team's rep, a recruiter) → 400 "That person is not on the Team A team (id 16)". Inside
  the scope the name helps: "Ben Ashworth cannot be booked on an event" (left, or an office role).
- **People who have left** (`users.status = 'left'`) drop off everything: the roster, `bookings.booked`, the plans,
  the forecasts' headcount and the venue page's booked counts. Their row stays as it was (back at work, they are
  booked again), and a leader's save neither keeps nor removes it (the audit trail sees no change).
- **People on leave** (`users.status = 'on_leave'`) stay booked and counted, as the rule above says only people who
  have left drop off. Until the last fix round they vanished from every list and count as well. The roster marks them
  `onLeave`, and the page shows "· on leave", so the leader can take them off. They cannot be newly booked until they
  are back ("Rita Rep cannot be booked on an event").
- **Bookings are open** while the event is **scheduled or live and dated today or later** (business clock); otherwise
  409 "This event has finished, so its bookings are closed" / "This event is cancelled, so its bookings are closed".
  That applies to coming off too, so the roster of a finished day stays as it was.
- **POST /me** twice changes nothing; **DELETE /me** when not booked changes nothing (200, no audit row). Anyone booked
  may take themself off, whoever booked them. Another team's event → 403 for a leader or rep; recruiters → 403.
- **GET /plan**: the admin and the event team's leader get everyone booked (or `?userId=`'s plan); anyone else gets
  their own plan when booked, `[]` otherwise, and 403 for another person's `userId`. Scheduled and live events only (a
  finished or cancelled event → `[]`); `[]` with `LM_SMART=0` (a plan is an estimate). `EventPlan`:
  `{ eventId, userId, userName, avatarColor, targetSales, targetSource ('event' | 'good-day' | 'venue-good-day'),
  eventShare, sharedAmong, goodDay, shareAboveGoodDay?, limited?, steps: [{ key, need, low, high }] (stops → taps),
  sentence, venueWeight, basis: { ownShifts, venueShifts }, venueName, ratios }`. `steps` is empty (and the sentence
  says so) when there is no conversion at some stage anywhere to plan from. `sharedAmong` is the headcount the event's
  target is divided by (see Logic); `shareAboveGoodDay` marks a plan that aims for the good day because the share is
  far above it.
- **Someone booked from another team** (the admin can book anyone): their own numbers stay with their own leader. The
  event's leader gets a plan built from the venue's numbers alone — `limited: true`, `basis.ownShifts` 0, venueWeight
  1, the venue's good day — never their ratios or good day. The person and the admin see the full plan.

#### `bookings` on events (`routes/events.ts`)

`GET /events` and `GET /events/:id` attach `bookings: { booked, me, aim? }` to every event somebody (active) is booked
on (one grouped query); an event nobody is booked on carries no key, so 1.2 payloads are unchanged. Bookings are a
workflow rule, not an estimate: `booked` and `me` stay with `LM_SMART=0`. `/me/dashboard` is not changed (P1's file):
the dashboard's upcoming list reads `bookings` from the `/events` list it already fetches for forecasts.

**`aim`** `{ targetSales, steps }` — the caller's **own** plan, only where `me` is true, the event is still open
(scheduled or live, today or later), there is something to plan from and `LM_SMART` is on. The same numbers as
`GET /events/:id/plan` (one `eventPlans` call for the whole list: at most two queries, memoised), so the Events rows,
the dashboard and Quick gauges make **no request per row**; only the event page asks for plans.

**Forecasts** (`forecast` on the same payloads, and **every** other caller of `eventForecasts`: the Needs-attention
"behind target" item and the leader digest's next week). `lib/smart/eventForecast.ts` reads the bookings itself, in
the same grouped query as the team's habit, so all of them agree. `expectedReps` = shared `expectedHeadcount` (Logic).
The chip reads "expect ≈ 9 (4–14) · 3 booked", or "· 3 booked, 5 expected" when the estimate counts more people than
are booked; the event page "Estimate: about 9 sales · for the 3 booked".

#### Audit (`lib/audit/venueSpecs.ts`, entity `event_roster`, filed under the event's id)

- `PUT /events/:id/roster` — "Bookings for BCN — Golden Square, 22 Oct: booked Jordan Lee and Sam Patel; took off Alex Kim"
- `POST /events/:id/roster/me` — "Jordan Lee is working BCN — Golden Square, 22 Oct (I'm working this)"
- `DELETE /events/:id/roster/me` — "Jordan Lee can no longer work BCN — Golden Square, 22 Oct"

Before/after snapshots: `{ event, date, booked: [names], count }`. A save that changes nothing writes no row.

#### Database (`db/extensions/venues.ts`)

`event_roster (event_id → events CASCADE, user_id → users CASCADE, booked_by, booked_at, source; PK event + user)`, as
the foundation laid it down; `upgrade` adds nothing (an existing database gets the empty table: nobody is booked until
a leader books, so its forecasts are exactly as before). The fresh demo seed books the scheduled and live events of the
next 14 days from the extension's own random stream: the **coming week is the leader's roster** (nine in ten of each
team booked, most by the leader, the rest by themselves); **further out only self-bookings** (about two in five have
tapped "I'm working this"), so those forecasts keep the team's usual turnout as their floor. The demo rep Jordan Lee
is booked on his team's first three upcoming events (two by Amelia, one by himself) and not on the fourth, and Amelia
books herself on today's event. Only `event_roster` rows are written.

### Audit of every action (P9)

All routes are behind `requireAuth` (anonymous → 401). A client portal session gets 403 `clientPortalOnly` from the
client guard on every one of them. Types: `shared/src/types/audit.ts`.

#### `POST /audit/events` → 204 (any staff role)

What a page reports itself: an export it built, or a sensitive record it opened (`ClientAuditEventInput`).

| Field | Rule |
| --- | --- |
| `kind` | `export` or `opened`; anything else → 400 |
| `what` | required text; control characters and runs of spaces become one space; invisible format characters (bidi overrides such as U+202E, zero-width characters, the BOM: Unicode `Cf`) are removed, so a row never displays reversed or disguised; cut at 80 characters (`"gauges-by-team"`, `"candidate profile"`, `"invoice LM-SB-2026-000123"`, `"audit trail"`) |
| `format` | exports: `csv`, `pdf`, `xero`, `sage`, `print` (optional; anything else → 400) |
| `rows` | exports: a whole number 0–1,000,000 (optional; anything else → 400) |
| `filename` | exports: the file's name, cleaned like `what` (so `invoice\u202Efdp.exe` is stored as `invoicefdp.exe`, never displayed as "invoiceexe.pdf"), cut at 120 characters; a path keeps its last part only (optional) |
| `entity`, `entityId` | an `AuditEntity` and a positive id. **Opened**: the record; leave both out (or `null`) for the audit trail itself. **Export**: an export of ONE record — P7's candidate profile and interview sheet PDFs (`candidate`), P2's invoice PDF and print (`invoice`); leave both out (or `null`, or `export`) for an export of a table |

Unknown keys are dropped, not refused (a newer page reporting an extra detail still gets its event recorded).
An opened record **and an export of a record** are checked against the rule of the record's own page: a candidate —
admin, leader, recruiter (`GET /recruitment/candidates/:id`); a pay run — admin, the person, their team's leader
(`GET /finance/payroll/:id`); an invoice — the same rule through its pay run; the audit trail — administrators; any
other record — administrators. Not allowed → **403** "You cannot open that record"; no such record, or an entity
without its id → **404**. The row keeps the record (entity and id) and names it:

| Report | Summary |
| --- | --- |
| P7 `{kind:'export', format:'pdf', what:'candidate profile', entity:'candidate', entityId}` | "Exported the candidate profile as PDF: Mia Parker" |
| P7 interview sheet (`what:'interview sheet'`) | "Exported the interview sheet as PDF: Mia Parker" |
| P2 `{kind:'export', format:'pdf', what:'invoice LM-SB-2026-000123', entity:'invoice', entityId}` | "Exported the invoice LM-SB-2026-000123 as PDF: Jordan Lee w/c 12 Oct" |
| P2 print (`format:'print'`) | "Printed the invoice LM-SB-2026-000123: Jordan Lee w/c 12 Oct" |
| P3 (server side, `recordClientEvent` with the label "BCN 5–11 Oct 2026") | "Exported the BCN statement for 5–11 Oct 2026 as PDF" (a `what` that names the record already is not followed by the name again) |
| a table (P4, no record) | "Exported Gauges by team as CSV: 124 rows" (entity `export`, as before) |

So an export of a record shows under the Record filter (`GET /audit?entity=candidate&entityId=…`) and a name search
finds it; the record's History panel still lists its changes only. The same person opening the same record again
within 5 minutes (`AUDIT_OPENED_REPEAT_MINUTES`; `what` compared without case, so "Candidate Profile" and "candidate
profile" are one opening) answers 204 and adds no row. Exports are never merged: each is a file.

Rate limit: at most `AUDIT_EVENTS_PER_MINUTE` (60) reports per person per minute, on a counter of its own
(`middleware/writeLimit.ts`); the next one is **429** "That is more than 60 exports and opened records in a minute.
Wait a minute, then try again." with `Retry-After: 60`. A refused report does not count and is not recorded. The 1.2
write limit (learning, pitches, check-ins, PINs, bulk gauges) keeps its own 60. `writeLimitPerMinute: 0` (createApp)
turns both off; `auditEventsPerMinute: 0` (perUserWriteLimit) only this one.

The audit middleware skips this route (`lib/audit/auditEventSpecs.ts` `skip: true`): the route writes its own row, so
there is never a second, generic `POST /audit/events` row.

#### `GET /audit` (admin) — new parameters

| Param | Meaning |
| --- | --- |
| `kind` | One `AuditEventKind` (`change`, `sign_in`, `export`, `opened`, `automatic`, `client`) or a comma list (`kind=export,opened`); an empty value is no filter; any other value → 400. |
| `view` | `everything` (the default) or `changes` (= `kind=change`, the 1.2 view). Anything else → 400; `view=changes` together with `kind` → 400. |
| `entity` | Now also takes the 1.3 entities (`campaign_rate`, `pay_adjustment`, `invoice`, `agreement`, `statement`, `video`, `client_post`, `client_account`, `interview_question`, `event_roster`, `export`). |

`signIns=0` keeps working exactly as before (it leaves out the three sign-in actions). Every row now carries
`kind: AuditEventKind` and `userRole` (the role of the person who acted; `null` for "Linear Hub" and an unknown person).
Both are new optional fields; nothing was renamed or removed.

#### `GET /audit/people` (admin) → `AuditPerson[]`

Everyone the trail can name, for the Audit page's Person filter: `{ id, name, role, status }` for every user, staff
and client accounts, any status, by name — no employee IDs or client access codes (the page never shows them; review
fix: `employeeId` was dropped before any other package used it). (`GET /users` leaves client accounts out, so it cannot serve this
filter any more.) Leader, recruiter, rep → 403.

#### `GET /audit/person/:userId?kind=&view=&limit=&offset=` (admin) → `AuditPersonActivity`

Team → person → Activity: `{ person: AuditPerson, rows, total, lastSignInAt, lastActiveAt, failedSignIns }` — the rows
**made by** that person (their own changes, sign-ins, exports and openings, plus the failed attempts on their account,
which are filed under it, and Linear Hub's note when it paused recording those attempts — no actor, entity `user` and
the account's id), newest first, paged like `GET /audit` (limit 1–200, default 50). `lastSignInAt` is their
latest successful sign-in, `lastActiveAt` their latest row **not counting failed tries on the sign-in page** (those are
filed under the account but may be somebody else's: shared `isAuditAttemptOnAccount`) nor a sign-out by the idle timeout, `failedSignIns` the failed
sign-ins, wrong PINs and wrong two-step codes on their account in the last 30 days. Unknown person → 404, bad id or kind → 400; leader,
recruiter, rep (their own included) → 403. Registered before `/audit/:entity/:entityId`, which would otherwise read
"person" as an entity. Two indexed queries plus the count.

#### `GET /audit/:entity/:entityId` — new parameter

`kind=` (and `view=`) as on `GET /audit`. The History panels (payslip, gauge entry) ask for
`kind=change,automatic,client`, so "Opened the payslip" never reads as a change of it.

#### What the recorder writes now (no new endpoint)

- **Failed attempts** (kind `sign_in`, filed under the account the email or the challenge belongs to; never the PIN,
  the employee ID typed, the code or the challenge token):

| Route | Answer | Summary |
| --- | --- | --- |
| `POST /auth/login` | 401 | "Failed sign-in: wrong employee ID" · "Failed sign-in: the account is deactivated" · "Failed sign-in with an unknown email: jo@example.com" (no person; the email typed is kept only when it is an email — the Login page's test, and no control or invisible character, so an address disguised with a right-to-left override is never stored — so "Failed sign-in with an unknown email" and `typedEmail: null` for an employee ID typed into the email box) · "Failed sign-in: wrong PIN (4 tries left before a lock)" |
| `POST /auth/login` | 423 | "PIN locked after 10 wrong PINs in a row, until 14:35" (this try started the lock) · "Sign-in refused: the PIN is locked until 14:35" |
| `POST /auth/login`, `/auth/login/2fa` | 429 | "Sign-in refused: too many attempts, try again in 12 minutes" |
| `POST /auth/login/2fa` | 401 / 410 | "Failed sign-in: wrong two-step code" · "Sign-in stopped: too many wrong two-step codes" · "Sign-in stopped: the two-step code was not entered within 5 minutes" (an unknown challenge writes nothing) |
| `POST /auth/pin`, `/auth/pin/remove` | 400 / 423 / 429 | "Wrong current PIN while changing their PIN" · "… while removing their PIN" · "PIN locked after wrong current PINs while changing their PIN, until 14:35" |
| `POST /auth/2fa/enable`, `/disable`, `/recovery-codes` | 400 / 429 | "Wrong two-step code while turning on two-step verification" · "… turning off …" · "… making new recovery codes" |

  Every row's snapshot has a `reason` (shared `AUDIT_SIGN_IN_REASONS`: `wrong_employee_id`, `deactivated`,
  `unknown_email`, `wrong_pin`, `pin_locked_now`, `pin_locked`, `too_many_attempts`, `wrong_code`, `too_many_codes`,
  `challenge_expired`, `wrong_current_pin`), which the trail says in words (`AUDIT_SIGN_IN_REASON_LABELS`).
  Validation answers (a missing field, a PIN that breaks the rules) and step one of a sign-in (the PIN or two-step
  challenge) write nothing. **The failure budget**, per 15 minutes (`FAILED_ROWS_*` in `lib/audit.ts`):
  - 30 rows per account a try is filed under — and only that: every real account has room of its own, so a flood of
    made-up emails, from many addresses or from the same one, can never use up the room for a try on Matt's account
    (a signed-in person's own wrong PIN or code counts against their account too);
  - for emails nobody has: 30 rows per address of the sign-in page, and 600 rows in all.

  The row that reaches a cap is followed by one that says so (no person): "Stopped recording failed sign-ins with
  unknown emails from 203.0.113.7 after 30 in 15 minutes; recording starts again within 15 minutes" · "… on Jordan
  Lee's account after 30 in 15 minutes; …" (entity `user` and that account's id, so it shows on Jordan's Activity as
  Linear Hub's note) · "… with unknown emails after 600 in 15 minutes from many addresses; …". Worst case per 15
  minutes: 600 + 30 × the accounts tried. Successful sign-ins are never held back.
- **Sign-outs by the idle timeout** (kind `sign_in`, action `SESSION idle`, filed under the person, real clock):
  "Signed out after 12 hours without activity (last active 18:02 Wed 21 Oct)" — written once, when the person comes
  back to the idle session (`middleware/auth.ts authenticate`), or at start-up for a session that went idle while the
  server was off (`purgeExpiredSessions`). A session that reaches its 14-day end, and one of a deactivated account
  (the deactivation is the admin's recorded change), write nothing. `lib/audit/signIns.ts recordIdleSignOut`.
- **New 1.2 specs** (found by the coverage test): `POST /auth/pin/remove` → "Removed their PIN" (was a bare route
  name); `PUT /learning/milestones/:userId/:key` → "Updated a progression milestone for Jordan Lee: “Trained 3
  personalities” 2 → 3" (a save of the same value writes nothing).
- **Exports and openings**: action `EVENT export` / `EVENT opened` (see `POST /audit/events`); an export is filed
  under the record it is of, or under entity `export` for a table.
- **Automatic steps**: `recordSystemEvent` rows (action `SYSTEM <name>`) are kind `automatic`.
- **The payroll export** (`GET /finance/payroll/export`, Xero / Sage CSV; its own route writes the row) is kind
  `export` — classified in P9's code, neither file edited.

## 1.3.1 endpoints

The Sapiens team's demo logins, and recruiters and leaders can add people. Types in `shared/src/types/people.ts`, rules
in `shared/src/logic/people.ts` (`addPersonRefusal`, `staffSignInInstructions`, `personName`).

### Adding people: `POST /users`

| Caller | May add | Team |
| --- | --- | --- |
| admin | as before: any role, position, team (or none), pay plan, status, avatar colour, employee ID | any, or `null` |
| recruiter | role `rep` only, position `trainee` or `field_rep` | any team; `teamId` required (`400 "Choose a team for them."`) |
| leader (Team Leader or Crew Leader) | role `rep` only, position `trainee` or `field_rep` | their own team (the default); another team or `null` → `403 "You can add people to your own team (Sapiens) only."`; a leader with no team → `403` |
| rep, client | nobody: `403` | |
| signed out | `401` | |

Body (`createBody`): `firstName`, `lastName` (still required for a new person: `400 "Enter their last name"`), `email`,
`position`, `teamId?`, `startDate?` (default business today), `phone?`, `city?`; admin only: `role` (required for an
admin), `payPlanId?` (default: the plan for the position), `status?`, `avatarColor?`, `employeeId?`. Optional for every
caller: `signInUrl` (an `http(s)` address, at most 300 characters; the sign-in page as the caller opened it — it goes
into the instructions in the answer and is never stored).

- **Refused, never ignored.** A recruiter or leader who sends `role` other than `rep`, a `position` other than
  `trainee` / `field_rep`, any `payPlanId`, a `status` other than `active`, an `avatarColor` or an `employeeId` gets
  `403 { error, details: [{ path, message }] }` with a plain sentence (e.g. "Only an administrator can choose a pay plan.
  New people get the standard plan for their position."), checked before anything else; nothing is written. Empty
  values (`null`, `''`) are not attempts.
- **Employee ID.** Missing → the next free `LM-` number (`lib/people.ts nextEmployeeId`). `409` for a used employee ID or
  email (case-insensitive), as before.
- **201 → `AddPersonResult`** = `UserWithTeam` + `signInInstructions?: string`. The new person's `employeeId` is filled
  in **this once**, for a recruiter or leader too, so they can pass on the sign-in details; every later read
  (`GET /users`, `/users/:id`, `/users/:id/performance`, payslips) blanks it for anyone but an administrator and the
  person, as before. `signInInstructions` is plain text: hello, the team, "Open `<signInUrl>`" (or "the Linear Hub
  sign-in page"), the email and employee ID, and — only while **Require a PIN for everyone** is on — the first-time PIN
  step.
- **Audit**: the 1.2 spec (`entity user`, action `POST /users`) records the caller as the actor; summary "Added Sam
  Smith: Representative, Trainee, Sapiens". The snapshot holds the employee ID (the audit trail is admin only); the
  instructions are never stored.
- **Write limit**: `POST /users` (and below it) counts towards the per-person limit of 60 writes a minute
  (`middleware/writeLimit.ts`), `429` with the sentence after that.
- `PATCH /users/:id` and `POST /users/:id/2fa/reset` stay admin only. Release 1.3.1: `lastName: ''` is accepted only
  while the person's last name is already empty (the Sapiens accounts); clearing a surname → `400 "Enter their last
  name"`.
- `GET /users` sorts by surname, then first name, with the first name standing in for a missing surname (Theo sorts
  among the T surnames).

### Demo teams on the sign-in page: `GET /auth/demo-accounts`

`{ accounts, clientAccounts?, demoTeams? }`. `demoTeams: { name, color, accounts: DemoAccountItem[] }[]` — each item
`{ label: "Theo (Team Leader)", name: "Theo", role, position, email, employeeId }`, in employee-ID order. Listed only:

- when the four demo accounts are listed (same conditions; `LM_DEMO_ACCOUNTS=0` → `{ accounts: [] }`);
- for the accounts the demo seed or its start-up step **recorded** (meta `seed_demo_teams`: team id and each account's
  id, employee ID and email) whose id, employee ID and email still match, that are staff and not `left`. Never matched by
  email or ID pattern alone: an account Matt gives a real email, or anyone made by hand, is never offered here.

`clientAccounts` items: `{ label: "Hannah Price (Breast Cancer Now)", name: "Hannah Price", organisation: "Breast Cancer
Now", sector: "charity", role: "client", email, employeeId }` — the same conditions as in 1.3 (the demo seed's marker
`seed_demo_clients`, active, no PIN). An older demo database gains that account once on start-up (LOGIC §16.10).

### Names without a surname

Every sentence or label the server builds from a person's name uses `personName` (or `TRIM(first_name || ' ' ||
last_name)` in SQL): "Theo", never "Theo " or a double space. `leaderName` on `GET /teams` is "Theo".

## Seed & demo accounts
The server seeds `server/data/linear.sqlite` on first start (or `npm run seed` to reset) with deterministic
sample data for the last 26 weeks. Demo logins (email / employee ID):

| Role | Name | Email | Employee ID |
|---|---|---|---|
| admin | Danil Varianyk (Owner) | danil@linear-mcr.co.uk | LM-0001 |
| leader | Amelia Hart (Crew Leader) | amelia.hart@linear-mcr.co.uk | LM-0002 |
| recruiter | Priya Shah (Recruiter) | priya.shah@linear-mcr.co.uk | LM-0003 |
| rep | Jordan Lee (Field Rep) | jordan.lee@linear-mcr.co.uk | LM-0010 |

Release 1.3.1: team **Sapiens** (Theo leads it) with seven blank accounts — no gauges, events, pay, invoices,
agreements, learning, check-ins, bookings or audit rows — first names only (`last_name ''`), active, started on the
business date of the seed, Manchester, the default plan for the position, no PIN:

| Role | Name | Email | Employee ID |
|---|---|---|---|
| leader | Theo (Team Leader, leads Sapiens) | theo@linear-mcr.co.uk | LM-0101 |
| leader | Daniel (Team Leader) | daniel@linear-mcr.co.uk | LM-0102 |
| leader | Ridwan (Team Leader) | ridwan@linear-mcr.co.uk | LM-0103 |
| leader | Jamie (Team Leader) | jamie@linear-mcr.co.uk | LM-0104 |
| rep | Olivia (Trainee) | olivia@linear-mcr.co.uk | LM-0105 |
| rep | Owens (Trainee) | owens@linear-mcr.co.uk | LM-0106 |
| rep | Yasmin (Trainee) | yasmin@linear-mcr.co.uk | LM-0107 |

A fresh seed inserts them at its very end, after every extension seed; an existing demo database gains them once on
start-up (`db/extensions/sapiens.ts`, docs/LOGIC.md §16.10). The next person added gets LM-0108.

Teams: Northern Lights, Deansgate, Spinningfields, Ancoats (and Sapiens). Campaigns: Breast Cancer Now (fundraising, private sites),
Children's Hospice North (fundraising, events), Volt Energy (B2B), FibreCity Broadband (residential).

Priya has the position `recruiter` (a `Position` value added for office staff) on the **Office recruiter plan**: £95/day
Mon–Fri, no sales commission, £100 bonus in a week with ≥ 2 hires — for recruiters the payroll `sales` column holds the
hires they closed that week (candidates they own moved to `hired`), not sales. The seed keeps the demo believable:
one crew per venue per day, Volt Energy (B2B) on weekdays only, the owner/assistant owner at one event a day, interviews
Mon–Fri 09:00–17:30 and never left `pending` for closed candidates, no offer open for more than 21 days, today's events
`live` (with gauges) only once their start time has passed, the demo leader and rep always on time this week (Jordan
also never has a zero-sales day this week), and an avatar palette with ≥ 4.5:1 contrast under white initials.

## Implementation notes (Backend)

Behaviour that the contract above leaves open, as implemented in `server/`:

- **Public endpoints.** `GET /auth/demo-accounts` is public (the login page needs it before a session exists), alongside `/auth/login` and `/health`. It only ever lists the four seeded demo accounts (all present, with their seeded roles, none `left`) and returns `{ accounts: [] }` otherwise or when the environment variable `LM_DEMO_ACCOUNTS=0` is set — set that on any deployment with real users. Unknown `/api/*` paths return `404 { "error": "Not found" }` whether or not a session is present.
- **Login & sessions.** Email and employee ID are matched case-insensitively; an unknown email, a wrong ID and a user with status `left` all get the same `401 Invalid email or employee ID` (the distinction is never disclosed). Failed attempts are counted in memory (`lib/limiter.ts`, bounded LRU maps of 10,000 keys, expired entries swept every 5 minutes off the request path) under two keys: **source address + email** (8 in 15 minutes → `429`) and **email alone** (20 in 15 minutes → `429`, a backstop against rotating addresses). The source is `req.socket.remoteAddress`, never `req.ip`/`X-Forwarded-For`. Sessions live 14 days in the `sessions` table (32 random bytes, hex) behind the `lm_session` cookie (httpOnly, SameSite=Lax). **`TRUST_PROXY`** (env, default off): with it unset the app ignores `X-Forwarded-*` entirely, so `req.secure` is false behind a TLS terminator — set `TRUST_PROXY=1` (one proxy hop), the proxy's IP or CIDR (`10.0.0.0/8`, `loopback`) or a comma list, which makes `req.secure` follow `X-Forwarded-Proto` (Secure cookies, HSTS); the proxy must overwrite inbound `X-Forwarded-For`. `COOKIE_SECURE=1` forces the Secure flag regardless. `authenticate` rejects (and deletes) the session of any user whose status is `left`, and `PATCH /users/:id` with `status: 'left'` deletes all of that user's sessions, so deactivation revokes access immediately. An admin cannot deactivate their own account (`400`).
- **Employee IDs.** Because the employee ID is half of the credential, `redactUser`/`redactPayroll` (`server/src/lib/scope.ts`) blank it (`''`) on every user or payroll payload unless the requester is an admin or the row is their own; `q` on `GET /users` searches employee IDs for admins only.
- **Dates and times.** `from`/`to` are inclusive `BETWEEN` filters, so `from=to=<date>` is an exact-date match (used to prefill an existing gauge entry via `GET /gauges?eventId&userId&from&to`). `parseRange` rejects `from` before `2020-01-01` and spans over 400 days with `400`, so daily trends and weekly summaries are bounded; `limit` is capped at 500. Week keys (`groupBy=week`, `FinanceWeek.weekStart`, `RecruitmentSummary.weekly`) are Monday dates. Dashboard/leaderboard ranges end at **today** (`week` = Monday → today) and the comparison period is the **same to-date span of the previous period** (`previousToDateRange` in `server/src/lib/dates.ts`: week → the same weekdays last week, month → days 1..n of the previous month clamped to its length, quarter → the same day-offset into the previous quarter), returned as `Dashboard.previous`; `deltas` are null when the previous value is 0. Quarter trends are weekly points (the first point is keyed by the quarter's first day and holds that partial week), week/month trends are daily, all zero-filled.
- **Check-in timestamps.** `checkedInAt` is stored and returned as a *naive wall-clock* timestamp with no zone suffix (`2026-10-15T10:03:00`), matching `isCheckInOnTime`, which reads the event start the same way. Clients should send the naive value the user typed (`YYYY-MM-DDTHH:mm[:ss]`); a zoned value (`…Z` / `±hh:mm`) is converted to **Europe/London** wall-clock time (`toBusinessISO`), never to the container's zone. The server scripts also pin `TZ=Europe/London` so `todayISO()` is the business date; the Dockerfile should set the same `TZ`. Other timestamps (`submittedAt`, `createdAt`, `appliedAt`, …) are full ISO 8601 UTC.
- **Team scoping of gauges** always uses the *user's* team (`users.team_id`), so leaderboards, team dashboards, `groupBy=team` and payroll overrides agree. `GaugeEntryWithMeta.teamId/teamName` are the user's team. `GaugeSummaryRow.days` is distinct rep-days (user × date); for `groupBy=user` that equals days worked.
- **Reads by role.** Reps: `GET /events` and `GET /leaderboard` are forced to their own team, `GET /gauges` to their own entries, `GET /gauges/summary` to their own team (or own entries when `userId=me`). `GET /events/:id` and `GET /users/:id/performance` are readable by everyone, but `redactEntry` (`lib/scope.ts`) nulls `checkedInAt` and `notes` on entries that belong to someone else unless the requester is an admin or the leader of that person's team. Leaders, recruiters and admins otherwise read company-wide (leaders' write scope stays their own team). `GET /users` defaults to `status=active`; pass `status=all` for everyone.
- **Gauge writes.** `POST /gauges` upserts on `(eventId, userId, date)`: `201` on insert, `200` on update (an update keeps the stored `checkedInAt`/`notes` when the body omits them). Role rules first (`403`): reps may only write their own entries at their own team's events; leaders for themselves or members of their team, and only at their own team's events; admins anywhere. Then the integrity rules (`assertGaugeIntegrity` in `routes/gauges.ts`): the date equals the event date, the event is not cancelled (`409`), not in the future and — today — has started (`start_time <= now`), the user is active, (non-admins) belongs to the event's team, and the check-in is not in the future (`toBusinessISO(now)`) — every aggregate groups on the entry date, so one event can carry exactly one entry per rep on the day it ran. Then the pay-week rule (`assertWeekUnpaidFor` in `db/maintenance.ts`): `409` when the target's run for that week is `paid`/`late` and the caller is not an admin. The write and the payroll sync (`syncPayrollForEntry`) run in **one transaction**: the entry's owner, the leaders of the owner's team (overrides) and the no-team seniors who attended the event have their unpaid run for that week recomputed with `weekPayFor` (created when the week is complete and had none, removed when nothing is payable any more), and their paid runs flagged `adjusted_at`. Values are strict (`lib/validate.ts`: `z.number().finite().int().min(0).max(2000)`), mirrored by the shared `validateGaugeFunnel` ceiling and by `CHECK` constraints on `gauge_entries` in new databases (SQLite cannot add a CHECK to an existing table, so older databases rely on the code). Each insert stores `payout_per_sale`/`commission_per_sale` from the campaign and the person's plan; `upgradeSchema` backfills older rows from the current rates. `DELETE /gauges/:id` is for admins and leaders of the entry owner's team.
- **Leaderboard** uses the shared `rankRows` competition ranking: people with the same value of the ranked metric share one rank (1, 2, 2, 4) and the other metric only orders the rows inside that tie; `movement` is previous rank − current rank (`null` when new) against the same to-date span of the previous period. Everyone who logged sales is listed (up to 200 rows).
- **Payroll.** Runs are weekly (Mon–Sun) per payable user with due date = the Friday after the week ends (`paydayForWeek`), reference `PAY-<ISO year><ISO week>-<employeeId>`. The pay rules live in `server/src/lib/pay.ts` (`weekPayFor`) and are shared by the seed, the live estimates and materialisation: `daysWorked` = distinct gauge dates, `sales` = sum of gauge sales; `teamSales` for leaders = sales of their team members excluding their own; for the owner/assistant owner (no team) it is other reps' sales at the events they personally attended; recruiters are paid Mon–Fri base, clamped to their start date and, for the week in progress, to today, and their `sales` figure is the number of hires they closed that week (`RECRUITER_HIRES_SQL`: candidates they own moved to `hired`), which is what the recruiter plan's bonus threshold counts. A user is payable for a week when they started by its Sunday and are either `active` or logged gauges that week. **Materialisation:** `materialisePayrollRuns(db, today)` (`server/src/db/maintenance.ts`) creates `pending` runs (gross > 0, no deductions) for every completed Mon–Sun week after the latest run **and recomputes the unpaid runs (`pending`/`failed`) of the last two completed weeks from the gauges** (an idempotent upsert that keeps status, due date, reference and any deductions; paid runs are never touched); it runs at startup after seeding, once a day (unref'd `setInterval`), and `GET /finance/payroll`, `/finance/me` and `/finance/summary` call the cheap guard `ensurePayrollMaterialised` so a long-running process never shows a closed week without runs. **Runs also follow every gauge write** (`syncPayrollForEntry`, same transaction as the write — see *Gauge writes*), so a Monday-morning entry for Sunday's event or a correction reaches pay at once; a week whose run is already paid is refused to non-admins (`409`) and an admin's change flags the run `adjusted_at` while its figures stay frozen. `POST /finance/payroll/:id/pay` derives `paid`/`late` from the due date (`payrollStatusFor`), requires `weekEnd ≤ paidDate ≤ today` (`400`) and returns `409` if the run was already paid; the stored status is never flipped to `late` for an unpaid run (that status means *paid late*). `nextPayday`/`nextPayAmount` (dashboard and `/finance/me`) are the earliest unpaid (`pending` or `failed`) run even when overdue, otherwise the shared `nextPayday(today)` with a live estimate of the current week. `Dashboard.personal.earningsToDate` = gross of the runs whose pay week **starts inside the range** (`week_start ≥ from`; a week straddling the period start belongs to the previous period, so adjacent months/quarters never count the same run twice) plus a live estimate for weeks in the range without a run yet.
- **FinanceSummary.** The window is snapped to whole pay weeks (`mondayOf(from)`..`sundayOf(to)`; the response echoes the snapped `from`/`to`). Per week, revenue (Σ sales × the entry's snapshotted `payout_per_sale`), payroll (runs with that `weekStart`) and expenses are measured over the same Mon–Sun days — each series is one `GROUP BY` pay-week query over the window, stitched per Monday — and a week that has started, lies after the last materialised week and has no runs is charged at `estimateWeekPayroll` and flagged `estimated`. `payroll.runs` = all runs whose week starts in the window; `paid` = money landed (status `paid` **or** `late`); `late` = the subset paid after the due date; `pending` = status `pending`; failed = `runs − paid − pending`. `onTimeRate` = `(paid − late) / paid` (0 when nothing paid), `avgDaysLate` over the late subset. `byCampaign.commission` = Σ sales × the entry's snapshotted `commission_per_sale` (the selling rep's plan rate when the day was logged; reconciles to payroll commission for complete weeks as long as the plan did not change in between); `CampaignFinance.margin` is in pounds (revenue − that commission). Leaders get the same shape scoped to their team (team members' payroll, team sales/revenue, venue fees of the team's events). `Dashboard.company.payrollOnTimeRate` uses settled runs due in the range; when none were due yet it uses settled runs due in the last 12 weeks up to today and reports `payrollOnTimeWindow: 'last12Weeks'` (`'range'` otherwise). `Dashboard.company.revenue` and `byCampaign` use the same snapshots (one grouped query).
- **Seed announcements.** The leaderboard announcement (top two by sales and best conversion among people with ≥ 200 stops in the last complete calendar month, plus the crew total) and the "N candidates at interview or observation stage" line are generated from the seeded gauges/candidates, so the numbers they quote are always true for that database.
- **Recruitment.** `GET /recruitment/interviews` defaults to Monday of this week → today + 14 days (so upcoming interviews show); pass `candidateId` for a candidate's full list. `PATCH /recruitment/candidates/:id` rejects a `stage` field with `400`; `POST …/stage` enforces the stage machine (`assertStageTransition` in `routes/recruitment.ts`: forward, one back, reject/withdraw, `hired` only from `offer`, admin-only reopen to `offer`; `409` otherwise). Duplicates: one open candidate per email (`409`), one employee account per person (hire → `409` when a user with that email exists or the email was hired already). Hiring creates the user with the next `LM-xxxx`, a `first.last@linear-mcr.co.uk` address (`staffEmailLocalPart`: NFD, combining marks stripped, `ł/ø/æ/œ/ß/đ/þ/ð` folded by hand, ASCII letters/digits only, `staff` when nothing is left, numbered if taken), role `rep`, the pay plan for the applied position and the owner's team. `RecruitmentSummary.openByStage` holds the current open pipeline for non-terminal stages and, for `hired`/`rejected`/`withdrawn`, how many reached that stage within the range; `weekly` is one `GROUP BY` week query per series, clipped to `[from, to]`; `overdueActions` is computed in JS with the shared `isOverdue` over the open candidates.
- **Errors.** Zod failures → `400 { error: 'Validation failed', details: [{ path, message }] }`; invalid funnels → `400 { error: 'Invalid funnel', details: string[] }`; SQLite unique-constraint violations → `409`; CHECK-constraint violations → `400`.
- **Event statuses.** `rollForwardEventStatuses` (`db/maintenance.ts`) runs at startup and every 15 minutes: past `scheduled`/`live` events become `completed`, and today's `scheduled` events become `live` only once `start_time` has passed, matching the seed and `POST /events` defaults.
- **Runtime.** The server runs on plain Node (**≥ 22.18**, which strips TypeScript types natively): `npm start` / `npm run dev` are `node src/index.ts` / `node --watch src/index.ts`, `npm run seed`, `npm run smoke` and `npm test` (`node --test "src/**/*.test.ts"`) likewise; `start:tsx`/`dev:tsx` remain as fallbacks. `server/src` and `shared/src` are kept to erasable syntax (`erasableSyntaxOnly` + `verbatimModuleSyntax` in both tsconfigs: no parameter properties, enums, namespaces or `import x = require`, and type-only imports marked `type`), so typecheck fails on anything Node could not strip.
- **Database.** `node:sqlite` (`server/data/linear.sqlite`, WAL, foreign keys on). Override the location with `DB_PATH`. The server seeds on first start when the `meta.seeded_at` row is missing; `npm run seed -w server` deletes and rebuilds the file. Seeding is deterministic (mulberry32) but anchored to the real current date, so demo data stays "this week" whenever it is regenerated. **Schema upgrades:** `createSchema` (`db/schema.ts`) runs `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` for every table and index and then `upgradeSchema`, which adds any column listed in `COLUMN_UPGRADES` that `PRAGMA table_info` does not report (guarded `ALTER TABLE … ADD COLUMN`) and runs its backfill (`gauge_entries.payout_per_sale`/`commission_per_sale` from the current campaign and plan rates), so a database created by an earlier release is upgraded in place at start-up (the log says `Upgraded schema: added …`). Later columns so far: `users.totp_*`, `users.totp_last_counter`, `gauge_entries.payout_per_sale`, `gauge_entries.commission_per_sale`, `payroll_runs.adjusted_at`; later index: `idx_events_campaign`. `npm run smoke -w server` boots the API on a temporary seeded database and exercises every endpoint (including the upgrade of a first-release database); `npm test -w server` (also run by the root `npm test`) runs the unit and route tests (`src/**/*.test.ts`: RFC 4226/6238 vectors, base32, AES-GCM, weekly history, backups and the service files, and the 1.1 routes on an in-memory database with role scoping and `LM_SMART=0`).
- **Two-step verification (TOTP).** Lives in `server/src/lib/totp.ts` (pure RFC 4226/6238: HMAC-SHA1, 6 digits, 30 s, base32 without padding, constant-time compare, ±1 step), `lib/crypto.ts` (AES-256-GCM, key = SHA-256 of `LM_APP_SECRET`, payload `v1:<iv>:<tag>:<ciphertext>` base64) and `lib/twofactor.ts` (secrets, recovery codes, challenges, limiter). Storage: `users.totp_secret_enc` (active), `users.totp_pending_enc` (set by `/auth/2fa/setup`, replaced by every new setup, promoted by `/auth/2fa/enable`), `users.totp_enabled_at`; `recovery_codes (user_id, code_hash, used_at)` holds SHA-256 hashes of the normalised `xxxx-xxxx` codes; `two_factor_challenges (token, user_id, created_at, expires_at, attempts)` holds the five-minute login challenges (32 random bytes hex). `USER_SELECT` never selects the secret columns, so no user payload can carry them; `qrSvg` is rendered with the `qrcode` package (`toString`, `type: 'svg'`, margin 1) from the `otpauth://totp/Linear%20Hub:<email>?secret=…&issuer=Linear%20Hub&algorithm=SHA1&digits=6&period=30` URL. **Codes** are accepted with spaces (`123 456`), recovery codes case-insensitively with or without the hyphen; a matching recovery code is marked `used_at` at once (login or disable). **Enable** promotes the pending secret, issues 10 recovery codes and deletes every other session of the user (`DELETE FROM sessions WHERE user_id = ? AND token <> ?`). **Disable** and the **admin reset** clear both secret columns, every recovery code and any open challenge; the admin reset also deletes all sessions, and an admin cannot reset their own account through it (`400`). `GET /auth/2fa` reports `recoveryCodesLeft` as the unused codes (0 while off) and `pendingSetup` only while off with a pending secret. **Login:** with 2FA on, `/auth/login` creates a challenge and returns `{ requiresTwoFactor: true, challengeToken, method: 'totp' }` without a cookie; `/auth/login/2fa` answers `410 { error: 'This sign-in challenge has expired, start again' }` for an unknown, used or expired token (the row is deleted), `401 { error: 'That code is not valid' }` for a wrong code, and on success deletes the challenge, sets the cookie and returns `AuthResponse` with `twoFactorEnabled: true`. The settings endpoints answer `400 { error: 'That code is not valid' }` for a wrong code and `409` for state errors (`setup`/`enable` while on, `enable` with nothing pending, `disable`/`recovery-codes` while off). **Limits:** every wrong code counts in two in-memory counters (`lib/twofactor.ts`, bounded LRU maps): per **source address + user** — the 7th within 10 minutes gets `429 { error: 'Too many attempts, try again in N minutes' }` on every code-checking endpoint (`/auth/login/2fa`, `/auth/2fa/enable|disable|recovery-codes`) from that address until the window passes — and per **user from any address** (30 in 10 minutes) as a backstop against distributed guessing; a correct code clears both. Keying on the source means a stranger who can reach the second step cannot lock the real person out from another device. A wrong code at `/auth/login/2fa` also counts towards the login limiter (8 per source + email in 15 minutes), and that counter is only reset once the second step succeeds. Expired challenges are purged at start-up, every 15 minutes and whenever a new challenge is created; nothing logs a code or a secret. **Client sequence:** `POST /auth/login` → if `requiresTwoFactor`, keep the `challengeToken` and `POST /auth/login/2fa { challengeToken, code }` (or `{ challengeToken, recoveryCode }`) → `AuthResponse`; on `410` return to step one, on `401` let the user retry, on `429` show the message. Settings: `POST /auth/2fa/setup` → show `qrSvg` + `secret` → `POST /auth/2fa/enable { code }` → show `recoveryCodes` once → `GET /auth/2fa` for the card; `POST /auth/2fa/recovery-codes { code }` and `POST /auth/2fa/disable { code | recoveryCode }` as labelled; admins use `POST /users/:id/2fa/reset`. **Codes are single use:** the time-step counter of the last accepted authenticator code is stored in `users.totp_last_counter` and any code whose counter is not greater — a replay of a code already used, even inside the ±1-step window — is refused like a wrong code (login, enable, disable, recovery-code regeneration; RFC 6238 §5.2). **Challenges** are consumed after `CHALLENGE_MAX_ATTEMPTS` = 6 wrong codes (`410 { error: 'Too many wrong codes for this sign-in, start again' }`, row deleted). **Encryption key:** `LM_APP_SECRET` (a long random string) when set; otherwise the server generates 32 random bytes once and keeps them in `app-secret` next to the database (`server/data/app-secret` by default, `LM_APP_SECRET_FILE` relocates it; mode 0600; logged once at start-up as "LM_APP_SECRET is not set: … key in <file>"). Back that file up with the database. There is no usable built-in default key any more; rows written by earlier releases under the old development key are re-encrypted under the real key at start-up (`reencryptLegacySecrets`, logged when it did anything). Changing the secret afterwards makes existing TOTP secrets undecryptable (those users fall back to the admin reset).

## Two-step verification (TOTP, authenticator apps) — contract v1

Optional second factor using RFC 6238 TOTP (6 digits, 30-second step, SHA-1, ±1 step tolerance) compatible with
Google Authenticator, Microsoft Authenticator, 1Password, Authy. Secrets are stored encrypted at rest
(AES-256-GCM with a key derived from env `LM_APP_SECRET`, or from a random key the server generates once and keeps in
`server/data/app-secret` when the variable is unset). Recovery codes are stored as SHA-256 hashes and are single use.

### Status & setup (signed in)
- `GET /auth/2fa` → `TwoFactorStatus { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number; pendingSetup: boolean }`.
- `POST /auth/2fa/setup` → `TwoFactorSetup { secret: string; otpauthUrl: string; qrSvg: string }` (201). Creates a *pending* secret (not active); calling it again replaces the pending secret. `qrSvg` is an inline SVG string of the otpauth URL (issuer "Linear Hub", label `Linear Hub:<email>`). 409 if 2FA is already enabled.
- `POST /auth/2fa/enable` body `{ code: string }` → `TwoFactorEnabled { recoveryCodes: string[] }` (10 codes, format `xxxx-xxxx`, shown once). Verifies the code against the pending secret, activates it, and signs out every *other* session of the user. 400 `{error:'That code is not valid'}` on mismatch; 409 if nothing pending.
- `POST /auth/2fa/disable` body `{ code?: string; recoveryCode?: string }` → `204`. Requires a valid current code or an unused recovery code. Admin may disable another user's 2FA with `POST /users/:id/2fa/reset` (no code; for lost devices) → `204`, which also signs that user out everywhere.
- `POST /auth/2fa/recovery-codes` body `{ code: string }` → `{ recoveryCodes: string[] }` regenerates a fresh set (invalidates old ones). 400 `{error:'That code is not valid'}` on mismatch (an authenticator code is required here, not a recovery code); 409 while 2FA is off.
- `POST /auth/2fa/disable` answers 400 `{error:'That code is not valid'}` on a mismatch, 400 `Validation failed` when neither field is sent, 409 while 2FA is off.
- 2FA verification endpoints are rate limited: 6 failed codes per 10 minutes per **source address + user** → `429 { error: 'Too many attempts, try again in N minutes' }` (shared across `/auth/login/2fa`, `/auth/2fa/enable`, `/auth/2fa/disable`, `/auth/2fa/recovery-codes`; a correct code resets it), plus 30 per user from any address. An authenticator code is accepted **once**: presenting the same code again (within its validity window) is refused like a wrong code.

### Login flow
- `POST /auth/login` → when the user has 2FA enabled the response is `200 { requiresTwoFactor: true, challengeToken: string, method: 'totp' }` and **no session cookie is set**. The challenge token is single purpose, bound to the user, expires after 5 minutes and is deleted after use.
- `POST /auth/login/2fa` body `{ challengeToken: string; code?: string; recoveryCode?: string }` → `AuthResponse` with the session cookie set (`user.twoFactorEnabled: true`). 401 `{error:'That code is not valid'}` on a wrong (or already used) code, 410 when the challenge expired — or is unknown / already used / has absorbed 6 wrong codes — (client returns to step one), 429 after 6 failures from the same address. Wrong codes also count towards the login limiter (8 per source address + email), which is only reset when this step succeeds.
- `GET /auth/demo-accounts` is unchanged; the seeded demo accounts have 2FA **off** so the demo sign-in keeps working.
- `AuthResponse.user` gains optional `twoFactorEnabled?: boolean`.

### Client (Settings → Security)
- Card "Two-step verification" with status (On since <date> · N recovery codes left / Off). "Set up" opens a modal: step 1 QR code (the SVG) with the manual key and the otpauth link, step 2 six-digit input (auto-advance, paste-friendly) → "Turn on", step 3 recovery codes with Copy and Download (.txt) and a "I have saved these" confirmation. "Turn off" asks for a current code (or a recovery code). "New recovery codes" asks for a code. Admin view of a person (Team → person → Edit) gets "Reset two-step verification" with confirmation.
- Login page: after email + ID, if `requiresTwoFactor` show step two: "Enter the 6-digit code from your authenticator app", with "Use a recovery code instead", and "Back to email and employee ID" (step one); handle 401/410/429 messages.
