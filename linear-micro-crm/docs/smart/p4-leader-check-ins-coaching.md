# p4 — Check-ins and team coaching

Fragment for the final docs merge: `## API` → API.md "Check-ins (p4)", `## Logic` → LOGIC.md §14.4,
`## User guide` → USER_GUIDE.md "Check in with… (p4)".

## API

No new endpoint and no schema change. p4 fills the builder that p1 wired into **`GET /me/insights`**
(`server/src/lib/smart/checkIns.ts`), so `team.checkIns` and `company.checkIns` now carry people.

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
| `reasons` | `CheckInReason[]` | heaviest first; ties in a fixed order (see Logic) |

`CheckInReason` = `{ code, weight, text }`. `code` is one of `sustained_decline`, `conversion_drop`, `stops_drop`,
`attendance_drop`, `zero_week`, `earnings_drop`, `trainee_slow` and `late_often`. `text` is a finished British-English
sentence (see Logic).

- **Scoping.** The scoping rules are p1's (`routes/insights.ts`). The builder reads only people in the caller's scope,
  and their team's own calendar and check-ins. A rep's or recruiter's payload never contains a check-in list.
- **Caching.** The response is cached per user (`CACHED_PATHS`, 20 s, cleared by any write).
- **Cost.** **7 SQL statements per list, whatever the team size**: people, `weeklyHistory` (16 weeks), check-ins
  (8 weeks), team event dates (10 weeks), gauge dates (10 weeks), the payroll guard (`ensurePayrollMaterialised`, one
  `MAX(week_start)`) and payroll gross (8 weeks). It runs 1 statement when nobody is in scope and none with
  `LM_SMART=0`.
- **Writes.** Only the payroll guard can write, exactly as `/finance` does: when last completed week has no payroll
  runs yet (a server left running over the weekend, before the daily job), it creates them first, so that week is
  never read as £0. Nothing else is written, and never a gauge row.
- **Speed.** On the demo seed with the business clock at 15:00, an admin's `GET /me/insights` cache MISS takes about
  17–33 ms, and the builder alone about 18 ms. The route test asserts under 150 ms.
- **Shared API (client and tests only).** `coachingInsights(totals, ratios, benchmarks = BENCHMARK_RATIOS,
  subject = 'you')` gains an optional `subject: 'you' | 'team' | 'company'` (type `InsightSubject`). With `'you'`,
  the output is byte-for-byte what it was before.

## Logic

Rules live in `shared/src/logic/signals.ts` (pure and unit-tested: `CHECK_IN_RULES`, `CHECK_IN_GATES`,
`personSignals`, `rankCheckIns`). Each person is compared with **their own usual weeks**, or with **their own
team's calendar**, never with colleagues' results.

**Windows.** "Today" is the business date (`todayISO()`), and every window ends the day before it.
- **Weeks** are the 16 completed Mon–Sun weeks before this Monday (`weeklyHistory`). Rows on a still-`live` event are
  left out; rows on a cancelled event count.
- **This week** runs from Monday up to yesterday.
- **Check-ins** are gauge rows with `checked_in_at` set from the last 56 days, newest first.
- **Team event days** are the dates of the team's `completed` events in the last 70 days. Only days on or after the
  person's start date count towards their share.

| Code | Weight | Fires when | Text (example) |
|---|---|---|---|
| `sustained_decline` | 3 | `conversionTrend(weeks16)` is `declining`: the newest 8 weeks against the oldest 8, both halves ≥ 400 stops, two-proportion z ≤ −2 | "Conversion 2.5% over the last 8 weeks, down from 4.0% in the 8 before" |
| `conversion_drop` | 3 | the last 2 completed weeks have ≥ 150 stops; p0 is the pooled conversion of the 8 weeks before them (≥ 4 worked); `binomialZ(sales, stops, p0)` ≤ −2 | "Conversion 1.9% over the last two weeks against a usual 3.8%" |
| `stops_drop` | 2 | ≥ 4 worked weeks in the last 8 with a mean of ≥ 20 stops a day; ≥ 2 days so far this week; z of this week's stops a day against the per-week mean and SD ≤ −1.5 | "Averaging 41 stops a day this week against a usual 62" |
| `zero_week` | 2 | no gauge days last week while the team had ≥ 3 completed event days, and the person started before last Monday | "No gauges logged last week (w/c 12 Oct) while the team worked 5 event days" |
| `attendance_drop` | 2 | the team had ≥ 4 event days in the last 14 days; the person's share of the team's days in the 8 weeks before that is ≥ 0.5; and the recent share is < 0.5 × that usual share | "Worked 2 of the team's 9 event days this fortnight — usually 7 in 9" (usual = round(prior share × recent days)) |
| `earnings_drop` | 2 | `payroll_runs.gross` (any status) over the last 8 completed weeks, read after `ensurePayrollMaterialised` has created last week's runs, with 0 for a week without a run: last 4 ≤ 0.7 × the 4 before, and the 4 before ≥ £400 | "Earnings £1,640 → £720 over the last four weeks" (whole pounds, en-GB) |
| `trainee_slow` | 2 | position `trainee`, ≥ 42 days since `start_date`, ≥ 20 stops (`MIN_STOPS_FOR_INSIGHTS`) in the last 4 completed weeks, and the mean of actual ÷ benchmark over the stages reached is < 0.6 | "7 weeks in and still finding the rhythm — stop → table is 15% against the 35% benchmark, a good one to practise together" (names the weakest stage; ties go to the earliest stage) |
| `late_often` | 1 | of the last 10 recorded check-ins (or fewer, if there are fewer), ≥ 3 are more than `LATE_GRACE_MINUTES` (5) late, **and** that late share is > 2 × the team's late share. The team's share counts every check-in at the team's events over the same 8 weeks **except the person's own** (the rest of the team); when nobody else recorded one it counts as 0 | "Late for 4 of the last 10 check-ins (team: 1 in 7)" (1 in round(1 ÷ share); "none" when 0) |

**Suppressions.** `sustained_decline` drops `conversion_drop`, so a long decline is one reason, not two. `zero_week`
drops `attendance_drop`.

**Ranking.** `score` is the sum of the weights. `rankCheckIns` drops scores below 2 (so lateness alone never lists
anyone), sorts by score (highest first), then by name (en-GB collation), then by user id, and keeps the top 5.
Within a person, reasons are ordered by weight and then `sustained_decline`, `conversion_drop`, `stops_drop`,
`zero_week`, `attendance_drop`, `earnings_drop`, `trainee_slow`, `late_often`. The UI shows the first two.

**Who is never listed.** The caller, anyone whose status is `on_leave` or `left`, admins and recruiters.

**Edge cases.**
- A zero SD or a pooled rate of 0 or 1 gives no z, so the signal does not fire.
- Mondays have no "this week" yet, so `stops_drop` cannot fire on a Monday.
- People without a team can still get the history, earnings and lateness signals, but not the attendance ones.
- Every number is computed before rounding, and output is deterministic.
- On a Monday before the daily payroll job has run, last week has no runs yet; the payroll guard creates them before
  `earnings_drop` reads the 8 weeks, so the list is the same before and after the job.
- `LM_SMART=0` empties the check-in list only. Team / company coaching and the Focus chips are computed in the client
  from the dashboard and gauges summaries (like a rep's own coaching), so they stay on.

**Copy.** These are conversation starters, never verdicts: no "at risk", "underperforming", "failing" or
"struggling". Each sentence carries specific numbers. Conversion has one decimal place, stops a day are whole numbers
and money is whole pounds.

**Team and company coaching** (`shared/src/logic/insights.ts`). `coachingInsights` keeps its rules for every subject:
1–3 insights; a caveat under 20 stops; a strength, the weakest stage below benchmark, and then the next stage or the
volume lever. Only the wording changes:
- **`'you'`** (default) is unchanged, byte for byte. This was checked against 5,000 generated funnels before and
  after the change.
- **`'team'`**: "The team's stop-to-table rate is 31% vs the 35% benchmark. Run a five-minute opener drill at the
  huddle — …". The titles are "Team focus: …", "Team strength: …", "Next for the team: …" and "Volume is the team's
  lever". Each stage has one huddle-sized tip (`TEAM_COACHING_TIPS`).
- **`'company'`**: "Linear MCR's tap-to-sale rate is 80% vs the 90% benchmark. Ask the leaders to spot-check sign-up
  forms this week — …". The titles are "Company focus: …" and so on, with tips for the leaders
  (`COMPANY_COACHING_TIPS`).

Team and company insights are written in the third person: no "you" or "your" in any title or body.

**Focus chip** (Gauges → **Team** → **By person**). A row with ≥ 20 stops (`MIN_STOPS_FOR_INSIGHTS`) gets
**Focus: <stage>** from `weakestStage(row.ratios)` (lowest actual ÷ benchmark; ties go to the earliest stage). The
chip only shows when that stage is **below** benchmark (more than 10% under), so nobody gets a chip while every stage
is on track. Its tooltip shows the stage's rate against the benchmark.

**Loading.** `CheckInList` and `TeamCoaching` load on demand with the other dashboard smart slots (`LazyCheckInList`,
`LazyTeamCoaching` in `features/smart/lazy.tsx`), with a two-line placeholder; the check-in list shows nothing until
its data is known. See docs/smart/README.md, "Bundle".

## User guide

**Check in with… (leaders and the owner).** This is a short, private list of people it may be worth a word with this
week. It is a list of conversation starters, not a ranking or a verdict.
- **Leaders** find it on the dashboard, at the bottom of their team card under **Team coaching**. It covers only their
  own team and never themselves.
- **The owner** finds it in the **Company** section, next to **Company coaching**. It covers every team, and shows
  each person's team under their name.
- Each person shows their first two reasons, one per line, with the numbers behind them. For example: "Worked 2 of the
  team's 9 event days this fortnight — usually 7 in 9", or "Late for 4 of the last 10 check-ins (team: 1 in 7)" (the
  team figure is everyone else on the team). Tap **+N more** to show the rest under the first two, **Show less** to
  fold them away again, and tap the name to open their profile.
- Earnings reasons always include last week's pay: if last week's payroll has not been worked out yet, the list works
  it out first.
- At most five people appear, the ones with the most to talk about first. A single late check-in pattern on its own
  never puts anyone on the list.
- Nobody on leave, and nobody who has left, ever appears.
- When nobody stands out, the card says **Nobody needs a check-in this week**.
- Reps and recruiters never see this list, about themselves or anyone else.

**Team coaching (leaders).** Under the team's mini leaderboard, up to three sentences about the team's funnel for the
selected period, each with one thing to run at the huddle. For example: "The team's stop-to-table rate is 31% vs the
35% benchmark. Run a five-minute opener drill at the huddle".

**Company coaching (owner).** In the Company section: the same coaching for every team together, with one thing to
ask of the leaders. For example: "Linear MCR's tap-to-sale rate is 80% vs the 90% benchmark. Ask the leaders to
spot-check sign-up forms this week".

**Focus chips (leaders and the owner).** On **Gauges → Team → By person**, anyone with at least 20 stops in the
selected range whose weakest stage is below benchmark gets a chip such as **Focus: stop → table**. On a computer, hover over it to see their rate against the benchmark (the ratio cells in the same row show it too). It tells you what to practise together.

Reps keep their own coaching on the dashboard and the Gauges page exactly as before.

**With the smart features switched off (`LM_SMART=0`).** The check-in list disappears for everyone. Team coaching,
Company coaching and the Focus chips stay: they are worked out on the device from the dashboard's and the Gauges
page's own figures (the same deterministic rules reps have always had for their own coaching), not from
`/me/insights`.
