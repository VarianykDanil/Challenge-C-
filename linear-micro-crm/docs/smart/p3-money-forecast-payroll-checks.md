# p3 — Pay forecast and payroll checks

## API

### Pay forecast (`forecast` on `GET /finance/me`, `personal.payForecast` on `GET /me/insights`)

`GET /finance/me` always carries `forecast: PayForecast | null`. `GET /me/insights` carries the same object as
`personal.payForecast` (same builder, same numbers). It is `null` when the kill switch is off (`LM_SMART=0`), for
admins and recruiters, for anyone without a team, and for anyone without a pay plan. It is only ever the caller's own
estimate.

| Field | Meaning |
|---|---|
| `weekStart` | Monday of the current pay week |
| `payday` | the Friday after the week ends (`paydayForWeek`) |
| `estimate` | always `true` |
| `soFar` | `{ days, sales, gross }` logged this week so far (`weekPayFor(monday, today)`; `gross` = `estimateWeekPay` of it) |
| `remainingDays` | team event days still to come this week (see Logic) |
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

### Payroll checks (`flags` on `GET /finance/payroll` and `GET /finance/payroll/:id`)

`PayrollRunWithUser.flags?: PayrollFlag[]` with `PayrollFlag = { code, severity: 'info' | 'warning', text }`.

- **Admins only.** Leaders, reps and recruiters never get the key, not even on their own runs or payslip.
- **Unpaid runs only** (`pending` or `failed`). Paid and late runs never carry the key.
- At most **80 runs per call** are checked, newest weeks first; a checked run always has the key (`[]` when nothing
  is unusual), an unchecked one has none. `GET /finance/payroll?status=pending,failed` (the **Runs to pay** card) is
  the normal caller.
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

### Bulk "Mark paid" (no new endpoint)

The **Runs to pay** card pays a selection by calling the existing `POST /finance/payroll/:id/pay` once per run, one
after another (never in parallel), with `{ paidDate }` only when the admin picked a date other than today. Outcomes:
`200` = marked paid, `409` (already paid / late) = **skipped**, anything else = **failed**; a `401`/`403` stops the
batch and the rest are reported as failed without being sent. The client invalidates `['finance']` and `['dashboard']`
once, after the last run. While a batch runs, the single **Mark paid** buttons and the boxes are disabled, so a click
cannot race a run that is later in the batch. The server still validates every date (`weekEnd ≤ paidDate ≤ today`,
else `400`).

## Logic

### Pay forecast — `shared/src/logic/payForecast.ts` (`payForecastFrom`) and `server/src/lib/smart/payForecast.ts` (`weekPayForecast`)

Constants `PAY_FORECAST_RULES = { minHistoryDays: 5, lowQuantile: 0.1, highQuantile: 0.9, likely: 0.6, possible: 0.25,
windowWeeks: 8 }`.

**Inputs (server, one person, business "today"):**

- `soFar` = `weekPayFor(db, user, mondayOf(today), today)`: distinct gauge dates, summed sales and (override plans)
  the team's sales excluding the person, Monday to Sunday.
- `remainingDays` = distinct dates of the person's **team's** events with status `scheduled` or `live` after today up
  to Sunday, **plus today** when a team event today is `scheduled`/`live` and the person has no gauge row today yet
  (once they log today, today moves into `soFar`). It assumes the person works every one of those days.
- `dailySales` = sales on each of the person's worked dates in the **8 completed Mon–Sun weeks before this Monday**,
  rows on `live` events excluded. Their funnel totals over the same days give `ratios` (`funnelRatios`) and
  `trailingStops`.
- `teamSalesPerDay` (override plans only) = the team's sales excluding the person in the same window (live events
  excluded) ÷ the distinct dates of the team's `completed` events in that window (0 when there are none).
- `basis.weeks` = the weeks from the person's first worked week in the window to last week (8 for anyone who worked
  all window, fewer for a new starter).

**Formulas** (`d` = `remainingDays`):

| Step | Rule |
|---|---|
| History | λ = `mean(dailySales)`, p10 = `quantile(dailySales, 0.1)`, p90 = `quantile(dailySales, 0.9)` (type 7). **Fewer than 5 worked days → λ = p10 = p90 = 0 and `basis.weeks = 0`** ("not enough history for a range"). `basis.workedDays` = history length; `basis.salesPerDay` = λ |
| Days | `projectedDays = min(7, soFar.days + d)` |
| Sales | likely = soFar.sales + round(d·λ); low = soFar.sales + floor(d·p10); high = soFar.sales + ceil(d·p90) (a 1e‑9 tolerance absorbs float noise); then low ≤ likely ≤ high |
| Team sales | only when `plan.overridePerTeamSale > 0`: soFar.teamSales + round(d · teamSalesPerDay); otherwise soFar.teamSales |
| Money | each of low / likely / high = `estimateWeekPay(plan, { daysWorked: projectedDays, sales, teamSales }).gross`; then clamped so low ≤ likely ≤ high. No deductions are assumed |
| Bonus gap | `threshold > 0 ? max(0, threshold − soFar.sales) : 0` |
| Has a bonus | threshold > 0 **and** amount > 0; otherwise `bonusLikelihood = 'none'`, probability 0, `stopsForBonus = null` |
| Probability | 1 when the gap is 0; else `poissonTailAtLeast(gap, d·λ)` = P(Poisson(d·λ) ≥ gap) (0 when d = 0 or λ = 0) |
| Likelihood | `reached` (gap 0) · `likely` (≥ 0.6) · `possible` (≥ 0.25) · `unlikely` (below) · `none` (no bonus) |
| Stops | `stopsForBonus = stopsNeededFor(gap, ratios)` = ⌈gap ÷ overall conversion⌉; `null` when the gap is 0, trailing stops < `MIN_STOPS_FOR_INSIGHTS` (20) or the funnel never converts |

**Edge cases.** λ = 0 → low = likely = high (logged sales plus base pay for the days left). `d = 0` → all three equal
`estimateWeekPay(soFar).gross`, because projectedDays = soFar.days and the sales are what is logged. A rep with no
events left this week and one sale short gets probability 0 and the "would unlock" wording.

**Worked example** (field-rep plan: £60/day, £45/sale, £75 at 12 sales): 3 days and 11 sales so far, 2 team event days
left, λ = 2 (every history day 2) → likely sales 15, gross 5 × £60 + 15 × £45 + £75 = **£1,050** (low = high =
£1,050, as p10 = p90 = 2), gap 1, probability 1 − e^−4 ≈ **0.982** → `likely`.

**Cost.** The plan, `weekPayFor` (2–3 statements), one scalar statement (days left, team sales, team days) and one
grouped statement (the person's worked days): at most 6 statements, no per-row loops. Read-only.

### Payroll checks — `shared/src/logic/payrollFlags.ts` (`payrollFlags`) and `server/src/lib/smart/payrollFlags.ts` (`payrollFlagsFor`)

Constants `PAYROLL_FLAG_RULES = { highGrossMultiple: 2.5, minPriorRuns: 3, priorWindow: 8, bonusDayMultiple: 3,
minDailyHistory: 10, deductionShare: 0.5, tolerance: 0.01 }`. Flags come out in this fixed order:

| Code | Fires when |
|---|---|
| `first_payslip` (info) | the person has no earlier run at all |
| `high_gross` (warning) | at least 3 earlier runs and gross > 2.5 × the median gross of the newest 8 of them (exactly 2.5× does not fire). Text: "£780 is 2.6× the usual £305 (median of the last 4 runs)" |
| `bonus_single_day` (warning) | not a recruiter; bonus > 0; ≥ 10 worked days in the 8 weeks before the run's Monday; the week's best day ≥ 3 × max(1, median trailing daily sales); and sales − best day < the plan's threshold (the bonus would not have been reached without that day) |
| `sales_without_days` (warning) | not a recruiter; sales > 0 with 0 days worked |
| `high_deductions` (warning) | deductions > 50% of (gross + deductions), i.e. of the pay earned before deductions |
| `stale_amount` (warning) | \|`weekPayFor` gross − deductions − stored gross\| > £0.01, recomputing the run's week from today's gauges (with "today" = the day after the week ends). Text: "The gauges changed since this run was calculated: they now give £795, not £600" |
| `override_no_days` (info) | overrides > 0 with 0 days worked (a leader paid on the team's sales without logging a day — usually fine) |

Recruiter runs skip the sales-based rules (`bonus_single_day`, `sales_without_days`): their `sales` column holds hires
and they are paid Mon–Fri without gauges. The money rules (`high_gross`, `high_deductions`, `stale_amount`) still run.
"Earlier runs" are the person's runs of any status with an earlier `week_start`, newest first.

**Server.** Admin only (any other caller gets an empty Map); only `pending`/`failed` runs; at most 80 runs (newest
weeks first). Three grouped statements — earlier gross per run (one windowed query over a `VALUES` list), sales per
person per day over **each person's own window** (8 weeks before their earliest run to their latest run's Sunday, one
join over a `VALUES` list; a single window for everyone would let one old failed transfer stretch the scan to months of
gauges for the whole batch), and the people with their plan's bonus threshold — plus `weekPayFor` per run (≤ 3
statements each) for `stale_amount`. Read-only: nothing is written.

Cost (demo seed, the 31 unpaid runs of the last 12 weeks): `payrollFlagsFor` takes about 8.5 ms in-process (10.7 ms
with one shared window for everybody), so `GET /finance/payroll?status=pending,failed` takes about 14 ms against 3 ms
with `LM_SMART=0`. Roughly a third is the three grouped statements, a third the per-run `weekPayFor` (about 3 ms for
31 runs) and the rest JavaScript and garbage collection. `weekPayFor` re-reading the pay plan costs about 0.5 ms of
that, so passing the plan in (a change to `lib/pay.ts`, which this package does not own) was not worth it. Admin
only and uncached: the Company tab asks twice per load (the range list and Runs to pay); at the 80-run cap expect
roughly 30 ms per request.

Seed note: unpaid runs of the last two completed weeks are recomputed from the gauges on every gauge write and by
materialisation, so `stale_amount` mostly appears on older failed transfers or after a manual database change.

### Client copy (`client/src/features/smart/weekPayCopy.ts`)

- Headline: "This week (estimate): about £1,050 · £930–£1,140". Without a range: "· not enough history for a range"
  (basis.weeks = 0) or "· no team event days left" (d = 0). The line always carries a range or the reason there is
  none: when there is history and days left but low = high (for example every recent day had the same sales), the
  range is shown as a single figure, "£1,050–£1,050" (Finance → My pay: "range £1,050–£1,050").
- Bonus line (one per strip): reached "Bonus unlocked — 12 sales this week"; gap 1 "One more sale unlocks your £75
  bonus — about 23 stops at your rate"; gap > 1 "3 more sales unlock your £75 bonus — about 80 stops (possible)";
  no days left "3 more sales would unlock your £75 bonus — no team event days left this week". The stops part is left
  out when `stopsForBonus` is null. `unlikely` is worded "(a stretch)" — kinder than "unlikely" about a person.
- Phones (< 640 px) keep the same facts in tighter wording so the strip is **at most 2 lines at 360 px** ("~" stands
  for "about"): "This week (estimate): ~£1,095 · £570–£1,365" and "£75 bonus: 10 more sales · ~192 stops (likely)";
  gap 1 "£75 bonus: one more sale · ~23 stops"; no days left "3 more sales would unlock your £75 bonus" (the
  headline already says "no days left"); "no range yet" instead of the long history note. The stops part is left out
  when `stopsForBonus` is null. Measured in the page (Inter, tabular figures) against 302 px of room at 360 px: any
  headline with 4-digit amounts is 297 px; Amelia's bonus line ("£150 bonus: 14 more sales · ~257 stops (likely)") is
  265 px, and an extreme one ("£150 bonus: 12 more sales · ~1,253 stops (a stretch)") 294 px. Roboto, the usual
  fallback, is narrower. `truncate` stays as a safety net (5-digit amounts, enlarged text). The full sentences are the
  link's accessible name.
- Method (tooltip on **This week so far**): "your 2.1 sales a day over the last 8 weeks, for the 2 team event days
  left", always with "Estimate — Friday's payslip is the official figure".
- Bulk bar: "Mark 23 selected paid · £4,310.00" — the total in pence, the same format as the "23 runs selected" note
  beside it, the table, the confirm dialog and the summary toast.
- Bulk summary toast: "22 marked paid · 1 skipped (already paid) · 0 failed".

## User guide

### This week's pay estimate (reps and team leaders)

- **Dashboard.** Under your tiles, a strip reads **This week (estimate): about £1,050 · £930–£1,140** — what this
  week's payslip is likely to be, with a low–high range — and one line about your bonus: how many more sales unlock
  it and roughly how many stops that is at your own rate, or **Bonus unlocked** once you are there. Tap it to open
  **Finance → My pay**.
- **Finance → My pay → This week so far.** The same estimate with the workings: what you have logged so far, days and
  sales, the team event days left, and a bar towards the bonus. The **ⓘ** button explains the method, e.g. "your 2.1
  sales a day over the last 8 weeks, for the 2 team event days left".
- It is an **estimate**: it assumes you work every team event day left this week and sell at your usual rate. Friday's
  payslip is the official figure, and **Next payday** still shows the official amount. New starters see "not enough
  history for a range" until they have five worked days in the last 8 weeks.
- Only you see your estimate. Recruiters and admins do not get one.

### Payroll checks and bulk "Mark paid" (admins)

- **Finance → Company → Runs to pay** says **N runs need a look** when some unpaid runs look unusual. Those runs carry
  an amber **Check** badge; hover or focus it to read why (for example "£780 is 2.6× the usual £300"). Open the run
  for the payslip's **Checks before paying** list. Checks are advice only: you can always pay.
- **Select runs** with the boxes on the left (the box in the header selects every run you can in that list). In a long
  list grouped by week, **Mark week paid** selects that week's pending runs. Failed transfers are left out until you
  tick **Include failed transfers**.
- The bar at the bottom shows **Mark 23 selected paid · £4,310.00** and a **Paid on** date (today unless you change it;
  it cannot be before the latest selected week ends or after today). **Clear** empties the selection.
- If any selected run has a check, you see the reasons first and confirm with **Mark N paid**. The same happens when
  you press **Mark paid** on a single run with a check.
- Runs are paid one at a time while a notice says **Marking N runs paid…**; then a summary such as **22 marked paid ·
  1 skipped (already paid) · 0 failed**. A run someone already paid is skipped, not paid twice. Runs that fail stay
  selected so you can try again. While the batch runs, the single **Mark paid** buttons wait (they are greyed out).
