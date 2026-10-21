# Linear Hub — business logic reference

Owned by the Logic Builder. Everything described here lives in `shared/src/logic/**` (pure TypeScript,
no I/O, no React) and is unit-tested with `node:test` (`npm run test -w shared`). Constants live in
`shared/src/constants.ts`. Import from `@lm/shared`.

| Module | What it covers |
|---|---|
| `logic/gauges.ts` | funnel sums, ratios, benchmarks, projections, performance score, period deltas |
| `logic/finance.ts` | weekly pay, payroll status, paydays, on-time rate, margins |
| `logic/punctuality.ts` | check-in vs event start |
| `logic/recruitment.ts` | pipeline stages, stage conversion, time to hire, overdue actions |
| `logic/leaderboard.ts` | stable ranking with ties, rank movement |
| `logic/dates.ts` | DST-safe `YYYY-MM-DD` arithmetic, dashboard ranges, ISO weeks |
| `logic/insights.ts` | coaching messages |
| `logic/stats.ts` | 1.1: mean, sample SD, z-scores, binomial and two-proportion z, Poisson tail, quantiles, weekly series |
| `logic/baseline.ts` · `streaks.ts` · `payForecast.ts` · `payrollFlags.ts` · `signals.ts` · `attention.ts` · `eventForecast.ts` · `outbox.ts` · `digest.ts` | 1.1 smart release modules — see section 14 (recruitment SLAs and the outcome rule are in `logic/recruitment.ts`, §14.8) |

---

## 1. The funnel and the six gauges

Every rep records six whole-number gauges per event day, in funnel order. Each stage is a subset of
the one before it, so a valid entry satisfies

```
stops ≥ table ≥ presentations ≥ closes ≥ taps ≥ sales
```

| Gauge | Meaning |
|---|---|
| `stops` | people stopped |
| `table` | people brought to the table |
| `presentations` | full pitches delivered |
| `closes` | times the rep asked for the sale |
| `taps` | cards tapped / forms signed |
| `sales` | confirmed sales |

* `sumGauges(rows)` adds any gauge-shaped rows (missing keys count as 0) into one `GaugeTotals`.
* `validateGaugeFunnel(totals, max = GAUGE_MAX_PER_DAY)` returns human-readable warnings for non-integers
  (including `NaN`/`Infinity`), negatives, any gauge above the daily plausibility ceiling (**2000** — one rep cannot
  stop more people than that in a day) and any stage larger than the one before it. An empty array means valid. The
  server applies the same ceiling in its validators and as `CHECK` constraints on new databases.
* `EMPTY_TOTALS` is the all-zero record (always copy it, never mutate it).

## 2. Ratios — the "law of averages"

`funnelRatios(totals)` returns the five stage-to-stage ratios plus two derived figures. Every ratio
is `next / previous`; **a zero denominator yields 0, never `NaN`**.

| Key | Formula | Company benchmark |
|---|---|---|
| `stopToTable` | table / stops | 0.35 |
| `tableToPresentation` | presentations / table | 0.50 |
| `presentationToClose` | closes / presentations | 0.40 |
| `closeToTap` | taps / closes | 0.60 |
| `tapToSale` | sales / taps | 0.90 |
| `overallConversion` | sales / stops | (product of the five ≈ 0.0378) |
| `stopsPerSale` | stops / sales | **`null`** when sales = 0 (typed `number \| null`; JSON cannot carry `Infinity`) |

`ratioKeys` is the ordered list `{ key, from, to, label }` (e.g. `stopToTable` goes from `stops` to
`table`, label "Stop → table"). `RATIO_KEYS`, `RATIO_LABELS` and `RATIO_SHORT_LABELS` are the matching
constants.

### Benchmark rules

`compareToBenchmark(ratios, benchmarks = BENCHMARK_RATIOS, tolerance = BENCHMARK_TOLERANCE)` returns
one row per stage, in funnel order:

```ts
{ key, label, actual, benchmark, delta, relativeDelta, status }
// delta         = actual − benchmark            (ratio points, e.g. −0.10)
// relativeDelta = (actual − benchmark) / benchmark
// status        = 'above' | 'on_track' | 'below'
```

* **on_track** when the relative difference is within ±10% of the benchmark
  (`BENCHMARK_TOLERANCE = 0.1`; for the 0.50 benchmark that is 0.45–0.55 inclusive).
* **above** when more than 10% over; **below** when more than 10% under.
* A zero benchmark never divides by zero: 0 is on track, anything positive is above.

`benchmarkSeverity(comparison)` grades a row for traffic-light colouring: `good` (above or on track),
`watch` (below by up to 25%), `poor` (below by more than `BENCHMARK_DANGER_THRESHOLD = 0.25`). The
funnel chart maps these to the success / warning / danger tokens and always adds a glyph (▲ ● ▼) and a
tooltip, so colour is never the only signal.

`weakestStage(ratios)` is the row with the lowest `relativeDelta` (ties go to the earliest stage —
fixing the top of the funnel lifts everything below it). `strongestStage` is the mirror. Both return
`null` when there is no activity at all.

> A stage nobody has reached yet (e.g. 4 closes but 0 taps makes `tapToSale` = 0/0) has an *undefined*
> ratio, not a poor one. `coachingInsights` and the funnel chart skip such stages; `compareToBenchmark`
> itself only sees ratios, so callers with totals should check `totals[step.from] > 0`.

### Projections

* `funnelConversion(ratios)` — product of the five stage ratios (equals `overallConversion` when the
  ratios came from one set of totals, but lets you edit one ratio for a "what if").
* `projectSales(stops, ratios)` = `stops × funnelConversion` (not rounded).
* `stopsNeededFor(targetSales, ratios)` = `ceil(targetSales / funnelConversion)`; 0 for a non-positive
  target, `Infinity` when the funnel never converts.
* `salesPerDay(totals, days)` = `sales / days`, 0 when no days were worked.
* `relativeChange(current, previous)` → fraction (0.12 = +12%) or `null` when `previous` is 0;
  `periodDeltas(current, previous)` builds the dashboard's `{ sales, conversion, stops }` deltas.

## 3. Performance score (leaderboard & coaching)

`performanceScore(ratios, salesPerDay, { benchmarks?, targetSalesPerDay? })` → integer 0–100.

```
funnel  = mean over the five stages of min(actual / benchmark, 1)      (0..1)
volume  = min(salesPerDay / TARGET_SALES_PER_DAY, 1)                   (0..1, target = 2 sales/day)
score   = round(100 × (0.6 × funnel + 0.4 × volume))                    (PERFORMANCE_WEIGHTS)
```

Each stage is capped at 1 so one brilliant stage cannot hide a weak one. Being at benchmark on every
stage and selling two a day scores 100; a perfect funnel with no volume scores 60; volume alone
scores 40.

**Example.** Totals 100 / 40 / 20 / 8 / 5 / 4 over 4 days. Ratios 0.40, 0.50, 0.40, 0.625, 0.80.
Stage scores 1, 1, 1, 1, 0.889 → funnel 0.978 → 58.7. Sales per day 1.0 → volume 0.5 → 20.
Score = 79.

## 4. Pay

`calculatePayroll(plan, { daysWorked, sales, teamSales, deductions? })` (alias `estimateWeekPay` for
projections) returns `{ basePay, commission, bonus, overrides, deductions, gross }`, each rounded to
pence with `round2`:

```
basePay    = basePerDay × daysWorked
commission = commissionPerSale × sales
bonus      = bonusAmount if bonusThreshold > 0 and sales ≥ bonusThreshold, else 0
overrides  = overridePerTeamSale × teamSales        (leaders only; team sales exclude their own)
gross      = basePay + commission + bonus + overrides − deductions
```

Negative inputs — `daysWorked`, `sales`, `teamSales` **and `deductions`** — are clamped to 0 (a negative deduction
can never add money); deductions larger than the week's pay produce a negative gross rather than being hidden.

**Worked example.** Plan: £50/day, £25 per sale, £100 bonus at 10 sales, £5 per team sale.
Week: 5 days, 12 sales, team made 30 sales, £20 advance to recover.

| Component | Working | £ |
|---|---|---|
| Base | 50 × 5 | 250.00 |
| Commission | 25 × 12 | 300.00 |
| Bonus | 12 ≥ 10 | 100.00 |
| Overrides | 5 × 30 | 150.00 |
| Deductions | | −20.00 |
| **Gross** | | **780.00** |

`round2` shifts the decimal point in string form before rounding, so 1.005 → 1.01 and 10.555 → 10.56
(plain `Math.round(n * 100) / 100` gets both wrong). `sumMoney(values)` adds a list without drift.
`margin(revenue, cost)` is the fraction `(revenue − cost) / revenue` (0 when revenue is 0, negative
when loss-making); `marginAmount` is the same in pounds.

### Office recruiter plan (server seed)

The `recruiter` position (added to `Position`/`POSITIONS` for office staff) is paid through the same
`calculatePayroll` maths with a different meaning for `sales`: for a recruiter the server passes the number of
**hires** they closed in the week (candidates they own moved to `hired`) as `sales`, so the plan's
`commissionPerSale` is 0 and `bonusThreshold` = 2 pays a £100 bonus in any week with two or more hires.
`daysWorked` is Mon–Fri (clamped to the start date and, for the week in progress, to today). The payroll
`sales` column therefore reads "hires" on a recruiter's payslip.

## 5. Paydays and on-time payment

* Pay weeks run **Monday to Sunday**.
* Pay is **due on the Friday after the week ends**: `weekEnd (Sunday) + 5 days`
  (`PAYDAY_DAYS_AFTER_WEEK_END = 5`). `paydayForWeek(anyDateInWeek)` gives that Friday.
* `nextPayday(today)` is the payday of the week containing `today`. On Wed 14 Oct 2026 the week ends
  Sun 18 Oct, so payday is **Fri 23 Oct 2026**. On Mon 19 Oct it becomes Fri 30 Oct; on the payday
  itself (Fri 23 Oct) the current week pays on Fri 30 Oct.
* `isPaidOnTime(dueDate, paidDate)` → `true` when `paidDate ≤ dueDate` (calendar days; a timestamp on
  the due day counts), `false` when later, `null` when unpaid.
* `payrollStatusFor(dueDate, paidDate, today)` derives `PayrollStatus`:

  | paidDate | relation | status |
  |---|---|---|
  | set | ≤ due | `paid` |
  | set | > due | `late` |
  | null | today ≤ due | `pending` |
  | null | today > due | `late` |

  `failed` is never derived — finance sets it by hand when a transfer bounces.

  The server never writes the `null / today > due → late` branch back to the database: a stored run stays
  `pending` (or `failed`) until an admin marks it paid, because the stored `late` status means *paid late* everywhere
  else (on-time rates, "money landed" counts, the 409 guard on paying twice). That branch is a display derivation only —
  clients use it to badge an unpaid run as overdue. `nextPay` (server) keeps returning the earliest unpaid run even
  when it is overdue, so money owed never drops off the "Next payday" tile.
* `daysLate(dueDate, paidDate, today?)` → whole days after the due date (0 when on time); pass `today`
  to measure an unpaid run.
* `onTimeRate(runs)` → share (0..1) of **paid** runs paid on time; unpaid runs are excluded; 0 when
  nothing has been paid. `avgDaysLate(runs)` → mean days late over the late-paid runs.

## 6. Punctuality

* Event start = `eventDate + startTime` ("HH:MM", read in the runtime's local timezone — the business
  and server run in Europe/London). `checkedInAt` is a full ISO timestamp.
* `isCheckInOnTime(eventDate, startTime, checkedInAt, graceMinutes = LATE_GRACE_MINUTES)` → on time
  when `checkIn ≤ start + 5 min` (inclusive); `null` when no check-in was recorded.
* `minutesLate(...)` → whole minutes after the scheduled start, rounded **up**, 0 when early. It ignores
  the grace period, so `minutesLate > 5` ⇔ late. (5 min 30 s after start = 6 minutes late.)
* `punctualityRate(entries)` → on-time share of entries **with** a check-in; `null` when none recorded.
  `punctualitySummary` adds counts and the average minutes late across late entries.

## 7. Recruitment metrics

Pipeline: `applied → screening → interview → observation → offer → hired`. `hired`, `rejected` and
`withdrawn` are terminal; the rest are **open**.

* `stageIndex(stage)` → 0–5 on the happy path, −1 for rejected/withdrawn.
* `isOpenStage` / `isTerminalStage`; `nextStage(stage)` / `previousStage(stage)` walk the happy path
  and return `null` at the ends and from terminal stages.
* `stageConversion(counts)` — pass either `{ stage: count }` or the summary's `funnel` rows (how many
  candidates **reached** each stage). Returns five `{ from, to, fromCount, toCount, rate }` rows;
  `rate = toCount / fromCount`, 0 when nobody reached `from`.
* `hireRate(applied, hired)` = hired / applied.
* `timeToHireDays(appliedAt, hiredAt)` → whole days, never negative; two dates compare as calendar
  days, timestamps round to the nearest day. `daysInPipeline(appliedAt, until = now)` is the same for a
  candidate still open. `avg(values)` → mean, 0 for an empty list.
* `isOverdue(nextActionAt, now)` → a date-only deadline is overdue once `now` is a **later calendar
  day** (due today is not overdue); a timestamp is overdue once `now` is past it; null is never overdue.

## 8. Leaderboard

* `rankRows(rows, metric, { direction = 'desc', tieBreak? })` sorts by a property name or accessor and
  assigns **competition ranks**: equal values of `metric` share a rank and the next distinct value skips ahead
  (1, 2, 2, 4) — *whatever the tie-break says*. `tieBreak` only decides the **order** of the rows inside a tie
  (bigger secondary first; the leaderboard uses the other metric), it never splits the shared rank. The sort is
  stable; input order breaks remaining ties. Returns new objects.
* `movement(prevRank, currentRank)` = `prevRank − currentRank` (positive = moved up, 5 → 2 gives +3);
  `null` for a new entrant.
* `topN(rows, n)`, `rankOf(rows, predicate)` are small conveniences.
* Leaderboards rank on `sales` by default; `performanceScore` (section 3) is the recommended metric for
  a fairer "who is working their funnel best" view, with `conversion` as a tie-break.

## 9. Dates and dashboard ranges

All date maths uses plain `YYYY-MM-DD` strings and `Date.UTC`, so adding days across the March/October
clock changes never drifts, and results do not depend on the server's timezone. Only `toISODate(Date)`
and `todayISO()` read the local clock (so "today" is the user's calendar day).

* `addDays`, `addMonths` (clamps 31 Jan + 1 month to 28/29 Feb), `daysBetween` (signed), `eachDay`
  (inclusive), `eachWeek` (Mondays overlapping the range), `isValidISODate`.
* `startOfWeekISO` / `endOfWeekISO` → Monday / Sunday; `startOfMonthISO`, `endOfMonthISO`,
  `startOfQuarterISO`, `endOfQuarterISO`, `quarterOf`.
* `rangeFor(range, today)` → the **calendar** period containing today: Mon–Sun week, calendar month or
  calendar quarter (`to` may lie in the future).
* `previousRange({ from, to })` → whole-month ranges shift by whole months (Oct → Sep, Q4 → Q3); anything
  else shifts back by its own length in days.
* `isoWeek(iso)` / `isoWeekLabel(iso)` → ISO-8601 week ("W42"); week 1 is the week containing 4 January,
  so 1 Jan 2027 is W53 of 2026.

## 10. Coaching insights

`coachingInsights(totals, ratios, benchmarks?)` → 1–3 `{ tone, title, body, key? }` messages in British
English, encouraging and specific ("Your tap-to-sale rate is 80% vs the 90% benchmark — slow down at
the tap…"):

1. No stops → one neutral prompt to log gauges.
2. Fewer than `MIN_STOPS_FOR_INSIGHTS` (20) stops → an "Early days" caveat plus the single weakest stage.
3. Otherwise: the strongest stage above benchmark (or "Every stage on track"), the weakest stage below
   benchmark with its tip (`COACHING_TIPS`), then either the next-weakest stage or a volume tip built
   from `stopsPerSale` ("about 25 stops per sale").

Stages nobody has reached yet are skipped (see section 2).

## 11. Charts (`client/src/components/charts`)

All charts read colours from the theme tokens (`var(--color-chart-1…6)`, `--color-fg`, `--color-muted`,
`--color-border`, `--color-surface`) so both themes work; values are formatted en-GB; each chart has
`role="img"` with a generated `aria-label` (override with `ariaLabel`), a hidden data table where
useful, and renders `EmptyChart` when there is nothing to plot.

| Component | Notes |
|---|---|
| `TrendChart` | line / area / bar, multi-series, `stacked`, `xFormatter` / `yFormatter`, `referenceY` + `referenceLabel`, `showLegend`, `yDomain`, `syncId`. Legend only for ≥ 2 series; dots only on hover. |
| `FunnelChart` | custom HTML/CSS: six proportional bars (one hue, light → dark towards the sale), ratio chips between stages, `showBenchmarks` grades chips via `benchmarkSeverity`; `orientation`, `compact`, `benchmarks`, `barHeight`. |
| `BarsChart` | vertical or `horizontal`, per-bar `color`, optional `secondary` series, value labels (`showValues`). |
| `DonutChart` | centre value (defaults to the total) + `centerLabel`, legend with values and shares, folds slices past `maxSlices` into "Other". |
| `Sparkline` | inline SVG, 2px line, end dot with surface ring, optional area `fill`; stretches without the stroke scaling. |
| `ChartTooltip`, `ChartLegend`, `EmptyChart`, `theme` | shared building blocks (`seriesColor`, `formatNumber`, `formatCompact`, `formatPercent`, `wash`). |

## 12. Constants added to `shared/src/constants.ts`

`RatioKey` (type), `RATIO_KEYS`, `RATIO_LABELS`, `RATIO_SHORT_LABELS`, `GAUGE_SHORT_LABELS`,
`BENCHMARK_TOLERANCE` (0.1), `BENCHMARK_DANGER_THRESHOLD` (0.25), `TARGET_SALES_PER_DAY` (2),
`PERFORMANCE_WEIGHTS` ({ funnel: 0.6, volume: 0.4 }), `MIN_STOPS_FOR_INSIGHTS` (20),
`PAYDAY_DAYS_AFTER_WEEK_END` (5), `DASHBOARD_RANGE_LABELS`.

## 13. Two-step verification (server-side, `server/src/lib/totp.ts`)

Not domain logic, but rules worth stating once. The server implements RFC 4226 (HOTP) and RFC 6238 (TOTP)
with Node's `crypto` only — no third-party OTP library:

* **Secret**: 20 random bytes, shown as RFC 4648 base32 without padding (32 characters, `A–Z2–7`).
* **Code**: `HOTP(secret, T)` where `T = floor(unixSeconds / 30)`; HMAC-SHA1, dynamic truncation
  (`offset = last nibble`, 31-bit big-endian word), `mod 10^6`, zero-padded to 6 digits.
* **Verification** accepts `T−1`, `T` and `T+1` (±30 s of clock drift or a code typed just before
  roll-over), compares every candidate in constant time and always checks all three. `matchTotpCounter` returns the
  step that matched; the server stores it (`users.totp_last_counter`) and refuses any code whose step is not greater,
  so **a code is accepted once** (RFC 6238 §5.2) — a replay inside the window is treated as a wrong code.
* **Recovery codes**: 10 × `xxxx-xxxx`, lower-case `a–z0–9` drawn uniformly from `crypto.randomBytes`
  (rejection sampling), stored as SHA-256 hashes, single use; typed codes are lower-cased and the
  hyphen/spaces are optional.
* **Limits**: 6 wrong codes per user in 10 minutes → `429`; wrong codes at login also count towards the
  8-per-IP+email login limiter. A login challenge lives 5 minutes and is deleted after one successful use.
* **At rest**: secrets are AES-256-GCM encrypted (`lib/crypto.ts`) with a key derived from `LM_APP_SECRET`.

Reference vectors (RFC 6238 appendix B, secret `12345678901234567890`): T = 59 → `94287082` (8 digits) /
`287082` (6); 1111111109 → `081804`; 1234567890 → `005924`; 2000000000 → `279037` — all covered by
`npm test -w server`.

## 14. Smart release (1.1)

Rule-based "smart" features: no model, no API key, deterministic (the same data always gives the same sentence).
Every builder is switched off by `LM_SMART=0` (`server/src/lib/smart/enabled.ts`, read on every call): it then
returns null, `[]` or an empty Map, routes attach nothing (the optional keys are absent, the 1.0 shapes exactly), and
every card fed by a builder renders nothing. Every payload is built from data the caller may
already see; nobody ever sees another person's alerts, pace, forecast or check-in reasons.

The switch turns off estimates and generated advice, not workflow rules. **Recruitment SLAs stay on with
`LM_SMART=0`** (lead decision): the stage targets, the next-action deadline a create or stage move sets from them, the
**Idle** badges and the candidate page's **Record the outcome** card (§14.8) are workflow rules, not estimates, and the
client already names the deadline a move will set. The offline outbox and the tally (§14.7) stay on too: they are
reliability features. Team and company coaching and the **Focus** chips (§14.4) are worked out in the browser from the
dashboard and Gauges summaries, like a rep's own coaching, so they stay. Backups and compression (§14.10) have their own
switches (`LM_BACKUP`, `LM_COMPRESSION`). The Needs-attention feed, including its outcome reminders, is a smart builder
and is emptied.

### 14.0 Copy style guide (every generated sentence)

* **British English** ("colour", "organise", "programme"); dates like "Thu 15 Oct"; weeks "w/c 12 Oct".
* **Money is GBP via en-GB** (`Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })`): "£1,050",
  "£412.50". Never "GBP 1050" or "1,050£".
* **Specific numbers.** "41 stops a day against your usual 62", not "fewer stops than usual". Stops per day are whole
  numbers; conversion has one decimal place ("2.1%").
* **Every warning names exactly one lever** — the one thing to do next: "your conversion is holding, so volume is the
  lever: every extra 26 stops is about one sale". Never a list of five things.
* **Forecasts are estimates and show a range**: "This week (estimate): about £1,050 · £930–£1,140". The word
  "estimate" (or "about" plus a range) is always there; Friday's payslip is the official figure.
* **Kind, never judgemental about people.** Never "at risk", "underperforming", "failing", "struggling" or "poor"
  about a person. Check-in reasons are conversation starters, not verdicts. Events (never people) may be "behind
  target".
* **Positive states only for streaks**: "12-day sales streak · best 26", "Personal best week so far" — never
  "streak broken".
* **Private stays private.** Shareable text (the WhatsApp digest) never contains colleague names from check-in lists
  or anyone's pay; names appear only where the leaderboard already shows them.
* **Deterministic.** No randomness, no "now" in the wording except through the business date passed in; ties sort by
  name.

### 14.1 Foundation: statistics, weekly history and the kill switch (p1)

`logic/stats.ts` (pure):

| Function | Rule |
|---|---|
| `mean(xs)` | arithmetic mean; `[]` → 0 |
| `sampleSd(xs)` | √(Σ(x − μ)² ÷ (n − 1)); 0 when n < 2. `[2,4,4,4,5,5,7,9]` → 2.1381 |
| `zScore(x, μ, σ)` | (x − μ) ÷ σ; null when σ ≤ 0 or the result is not finite |
| `binomialZ(k, n, p0)` | (k − n·p0) ÷ √(n·p0·(1 − p0)); null when n = 0 or p0 ∉ (0, 1). (30, 1000, 0.04) → −1.6137 |
| `twoProportionZ(k1, n1, k2, n2)` | pooled p = (k1 + k2) ÷ (n1 + n2); z = (k1/n1 − k2/n2) ÷ √(p(1 − p)(1/n1 + 1/n2)); null when n1 or n2 is 0 or p ∈ {0, 1}. (20, 1000, 40, 1000) → −2.6216 |
| `poissonTailAtLeast(k, λ)` | P(X ≥ k) = 1 − Σ_{i<k} e^−λ λ^i / i!, summed iteratively in log space; k ≤ 0 → 1; λ ≤ 0 with k > 0 → 0. (1, 2) → 0.8647, (3, 2) → 0.3233 |
| `quantile(xs, q)` | linear interpolation between order statistics (type 7); `[]` → 0. ([1,2,3,4], 0.9) → 3.7 |
| `weekSeriesStats(weeks)` | over weeks with days > 0 only (a week off is not a slow week): count, mean and sample SD of each week's stops ÷ days, pooled conversion Σ sales ÷ Σ stops, totals |
| `conversionTrend(weeks, { minStops = 400, z = 2 })` | oldest half v newest half (16 weeks → 8 v 8; an odd middle week is left out); null when either half has < 400 stops; z = twoProportionZ(recent, earlier); `improving` z ≥ 2, `declining` z ≤ −2, else `steady` (also when nobody sold anything) |

`WeekStat` = `GaugeTotals & { weekStart; days }` (days = distinct worked dates).

`server/src/lib/history.ts` — `weeklyHistory(db, scope, weeks, today)` → `Map<userId, { weeks, current }>`:
`weeks` are the N completed Mon–Sun weeks before `mondayOf(today)`, oldest first and zero-filled; `current` is
Monday ≤ date < today. Rows dated today or later and rows on an event still `live` never count; rows on cancelled
events do. Scope is `{ userIds }` (every id present, zero-filled), `{ teamId }` (the user's current team) or
`{ all: true }` (people with rows only). One grouped SQL statement per call; the caller decides visibility.

Client slots: every component another package fills or edits is mounted inside its own `ErrorBoundary`
(`features/common/ErrorBoundary.tsx`) at the mount site, so a throw replaces only that slot with **This card hit a
problem · Try again** and the page (and the **Log gauges** button) keeps working. Slots too small for that box pass
`fallback` (a node, or `({ error, reset }) => node`; `null` hides the slot): the topbar bell becomes a 40 px
crossed-out bell that retries, the Gauges **Tally** button becomes **Tally · try again**. A plain function used inside
props (the Sales tile's `streakHint()`) is called through `safeStreakHint()`, which logs a throw and drops the
fragment. The tally is reachable from the dashboard through p7's `TodayTallyLink({ events })` slot at the top of the
**Upcoming events** card (gauge roles only).

### 14.2 Personal pace and streaks (p2)

Code: `shared/src/logic/baseline.ts`, `shared/src/logic/streaks.ts` (pure, unit-tested), `server/src/lib/smart/baseline.ts`,
`server/src/lib/smart/streaks.ts`. Rules: `BASELINE_RULES = { windowWeeks 8, minWeeks 4, minStopsPerDay 20, stopsZ 1.5,
minCurrentDays 2, convZ 2, minCurrentStops 100, holdingWithin 0.1 }`.

**What counts.** "Completed" weeks are the Mon–Sun weeks before this Monday; "this week" is Monday up to yesterday.
Rows dated today or later, and rows on an event still `live`, never count; rows on cancelled events do (the work was
done). Weeks with no worked day are skipped, not treated as slow weeks.

**Baseline** (`personalBaselineFrom(last 8 weeks, this week)`): null when fewer than 4 of the 8 weeks were worked or
μ < 20 stops a day (and always for recruiters). μ and σ are the mean and sample SD (n − 1) of each worked week's
stops ÷ worked days; p0 is the pooled conversion Σ sales ÷ Σ stops of those weeks.

| Alert | Needs | z | Warning | Positive |
|---|---|---|---|---|
| Stops per day | ≥ 2 worked days this week and σ > 0 | (this week's stops ÷ days − μ) ÷ σ | z ≤ −1.5 | z ≥ +1.5 |
| Conversion | ≥ 100 stops this week | binomialZ(sales, stops, p0) = (k − n·p0) ÷ √(n·p0·(1 − p0)) | z ≤ −2 | z ≥ +2 |

The shown figures must also differ (stops a day as whole numbers, conversion to 1 dp), so a tiny σ never produces
"41 against your usual 41". At most 2 alerts: warnings first, conversion before stops.

Copy (deterministic, British English, one lever per warning, praise without projections):

* Stops warning, conversion holding — tested (≥ 100 stops this week) and at least 90% of the usual rate
  (`holdingWithin` 0.1), or better: "You are averaging 41 stops a day this week against your usual 62 — a slow site or a
  short day? Your conversion is holding, so volume is the lever: every extra 26 stops is about one sale."
  (26 = ⌈1 ÷ p0⌉.)
* Stops warning in every other case — fewer than 100 stops (conversion untested), a rate under 90% of usual that is
  not a conversion warning (e.g. 2 sales on 135 stops against a usual 4.4%), or no usual sales at all: "… a slow site
  or a short day? More stops mean more chances to sell, so volume is the lever." No "holding" and no per-sale figure:
  the coaching card beside the note gives its own figure from this period's rate, and two figures would clash.
* Conversion warning: "Your conversion is 2.1% this week against your usual 3.9% (140 stops). Presentation → close is
  furthest below benchmark — start there." The stage is `weakestStage(funnelRatios(this week))`, worded by how far
  under its benchmark it is (`BENCHMARK_TOLERANCE` 10%): more than 10% under → "… is furthest below benchmark — start
  there."; under but within 10% → "No stage is more than 10% under benchmark, and presentation → close is the furthest
  under it — start there."; every stage at benchmark or better (the person's usual is simply higher) → "Every stage is
  at benchmark or better, and close → tap is the closest to slipping under — start there."
* Both warnings: one combined alert, led by conversion, titled "Below your usual this week": "Your conversion is …
  (120 stops), and you are averaging 40 stops a day against your usual 60. <stage sentence>".
* Positive: "Converting above your usual · Your conversion is 7.7% this week against your usual 4.2% (194 stops).
  Lovely work — whatever you are doing, keep doing it." and "Ahead of your usual pace · You are averaging 80 stops a
  day this week, up on your usual 60. Great energy — keep it going."

**Direction** (`conversionTrend` over the 16 completed weeks, §14.1): oldest 8 v newest 8 with the pooled
two-proportion z; null when either half has under 400 stops; `improving` z ≥ 2, `declining` z ≤ −2, else `steady`. The
card adds one line only when it is not steady: "Steadily improving: 4.0% → 4.6% over the last 16 weeks" or
"Conversion has drifted from 4.0% to 2.5% over 16 weeks — your coaching card shows where to start". (Which stage caused
a change is left to a later release.)

**Streaks** (`salesStreaks(days, today)`): a worked day is a date with any gauge row (rows on one date are summed);
dates ≥ today are ignored, so a slow morning never resets a streak before the day is over. A worked day with ≥ 1 sale
extends the run; one with 0 sales resets it; calendar days without gauges (days off, weekends, holidays) never break
it. `current` is the run ending at the last worked day before today, `best` the longest run. `personalStreaks` reads
all of the caller's history; `streaksForUsers` (leaderboard rows) and `boardStreaks` read the last 180 days
(`STREAK_WINDOW_DAYS`), so a longer run shows as at most the worked days in that window. `boardStreaks` keeps streaks
≥ 5 (`BOARD_STREAK_MIN`), longest first, ties by user id.

**Personal best week** (`personalBestWeek`): this week's sales so far beat every earlier week with ≥ 3 worked days,
and at least 4 such weeks exist (a tie is not a best). `bestPreviousWeekSales` is the week to beat (0 when none).

**Positive states only.** The Sales tile shows "12-day sales streak · best 26" from 3 days, otherwise "Personal best
week so far" when that is true, otherwise nothing; flames appear from 5 days. Nothing ever says a streak was broken.

**Order and fit on the Sales tile (lead decision).** The rank (or "N days worked") comes first and the streak second:
"#2 of 6 in your team · 24-day sales streak · best 24". The Sales tile gives its hint three lines of its own
(`KpiTile hintLines={3}`: `line-clamp-3`, on its own line under the delta without the leading "·"), so neither fragment
is cut. Two small changes make the longest real hints fit three lines on a 360 px phone: beside a streak the rank
drops its "Ranked" (on its own it still reads "Ranked #2 of 6 in your team", as in 1.0), and below 640 px the six
personal tiles use 16 px padding instead of 20 px (the whole grid, so the numbers still line up). Measured at 360, 375,
390 and 1440 px with the seed (rep, leader, admin) and with the longest the copy can produce ("#12 of 23 company-wide ·
120-day sales streak · best 120", "#12 of 23 company-wide · Personal best week so far"): three lines or fewer, nothing
clamped. "0 days worked" is left out beside a streak, so a Monday never reads "0 days worked · 21-day sales streak ·
best 21".

**Privacy.** Baseline, direction and the personal-best flag exist only inside the caller's own `/me/insights.personal`.
Only the streak number (≥ 5 for flames) is ever shown for other people, on boards the caller can already see.

**Loading.** The pace note (`BaselineNote`) loads on demand with the other dashboard smart slots (`LazyBaselineNote`,
§14.11); it shows nothing while it loads, as it often does anyway. The Sales tile hint and the flames are not lazy.

### 14.3 Pay forecast and payroll checks (p3)

#### Pay forecast — `shared/src/logic/payForecast.ts` (`payForecastFrom`) and `server/src/lib/smart/payForecast.ts` (`weekPayForecast`)

Constants `PAY_FORECAST_RULES = { minHistoryDays: 5, lowQuantile: 0.1, highQuantile: 0.9, likely: 0.6, possible: 0.25,
windowWeeks: 8 }`. Only reps and leaders with a team and a pay plan get a forecast; it is only ever the caller's own.

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

**Never written.** The forecast creates no payroll run and no gauge row; `nextPayday` / `nextPayAmount` stay the
official figures. Cost: the plan, `weekPayFor` (2–3 statements), one scalar statement (days left, team sales, team
days) and one grouped statement (the person's worked days) — at most 6 statements, no per-row loops.

#### Payroll checks — `shared/src/logic/payrollFlags.ts` (`payrollFlags`) and `server/src/lib/smart/payrollFlags.ts` (`payrollFlagsFor`)

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

**Server.** Admin only (any other caller gets an empty Map); only `pending`/`failed` runs; at most 80 runs
(`MAX_FLAGGED_RUNS`, newest weeks first). Every checked run gets an entry (`[]` when nothing is unusual). Three grouped
statements — earlier gross per run (one windowed query over a `VALUES` list), sales per person per day over **each
person's own window** (8 weeks before their earliest run to their latest run's Sunday, one join over a `VALUES` list; a
single window for everyone would let one old failed transfer stretch the scan to months of gauges for the whole batch),
and the people with their plan's bonus threshold — plus `weekPayFor` per run (≤ 3 statements each) for
`stale_amount`. Read-only: nothing is written. On the demo seed (31 unpaid runs of the last 12 weeks) `payrollFlagsFor`
takes about 8.5 ms in-process, so `GET /finance/payroll?status=pending,failed` takes about 14 ms against 3 ms with
`LM_SMART=0`; at the 80-run cap expect roughly 30 ms per request. Unpaid runs of the last two completed weeks are
recomputed from the gauges on every gauge write and by materialisation, so `stale_amount` mostly appears on older
failed transfers or after a manual database change.

#### Client copy (`client/src/features/smart/weekPayCopy.ts`)

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
  headline already says "no days left"); "no range yet" instead of the long history note. `truncate` stays as a
  safety net (5-digit amounts, enlarged text); the full sentences are the link's accessible name.
- Method (tooltip on **This week so far**): "your 2.1 sales a day over the last 8 weeks, for the 2 team event days
  left", always with "Estimate — Friday's payslip is the official figure".
- Bulk bar: "Mark 23 selected paid · £4,310.00" — the total in pence, the same format as the "23 runs selected" note
  beside it, the table, the confirm dialog and the summary toast. Bulk summary toast: "22 marked paid · 1 skipped
  (already paid) · 0 failed". The batch rules (one run at a time, 409 = skipped) are in API.md, "Pay forecast and
  payroll checks".
- **Loading.** The dashboard strip (`WeekPayStrip`) loads with the other dashboard smart slots; the sticky bulk bar
  (`BulkPayBar`) loads the first time an admin selects a run (§14.11).

### 14.4 Check-ins and team coaching (p4)

Rules live in `shared/src/logic/signals.ts` (pure and unit-tested: `CHECK_IN_RULES`, `CHECK_IN_GATES`,
`personSignals`, `rankCheckIns`); the server builder is `server/src/lib/smart/checkIns.ts` (`checkInList`). Each person
is compared with **their own usual weeks**, or with **their own team's calendar**, never with colleagues' results.

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

**Who is listed.** Active reps and leaders only, never the caller: a leader's list covers their own team, the owner's
(admin's) list every team. Anyone `on_leave` or `left`, admins and recruiters are never listed.

**Edge cases.**
- A zero SD or a pooled rate of 0 or 1 gives no z, so the signal does not fire.
- Mondays have no "this week" yet, so `stops_drop` cannot fire on a Monday.
- People without a team can still get the history, earnings and lateness signals, but not the attendance ones.
- Every number is computed before rounding, and output is deterministic.
- On a Monday before the daily payroll job has run, last week has no runs yet; the payroll guard creates them before
  `earnings_drop` reads the 8 weeks, so the list is the same before and after the job. That guard is the builder's only
  possible write (the same one `/finance` makes); it never writes a gauge row.
- `LM_SMART=0` empties the check-in list only. Team / company coaching and the Focus chips are computed in the client
  from the dashboard and gauges summaries (like a rep's own coaching), so they stay on.

**Cost.** 7 SQL statements per list whatever the team size: people, `weeklyHistory` (16 weeks), check-ins (8 weeks),
team event dates (10 weeks), gauge dates (10 weeks), the payroll guard (one `MAX(week_start)`) and payroll gross
(8 weeks); 1 statement when nobody is in scope, none with `LM_SMART=0`.

**Copy.** These are conversation starters, never verdicts: no "at risk", "underperforming", "failing" or
"struggling". Each sentence carries specific numbers. Conversion has one decimal place, stops a day are whole numbers
and money is whole pounds.

**Team and company coaching** (`shared/src/logic/insights.ts`). `coachingInsights(totals, ratios, benchmarks =
BENCHMARK_RATIOS, subject = 'you')` gains an optional `subject: 'you' | 'team' | 'company'` (`InsightSubject`) and keeps
its rules for every subject: 1–3 insights; a caveat under 20 stops; a strength, the weakest stage below benchmark, and
then the next stage or the volume lever (§10). Only the wording changes:
- **`'you'`** (default) is unchanged, byte for byte (checked against 5,000 generated funnels before and after).
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
`LazyTeamCoaching`, §14.11), with a two-line placeholder; the check-in list shows nothing until its data is known.

### 14.5 Needs attention (p5)

Shared, pure and deterministic: `attentionItems(input, now)` in `shared/src/logic/attention.ts` (thresholds in
`ATTENTION_RULES`); the route `server/src/routes/attention.ts` gathers the role-scoped inputs. `now` is the business
clock (`todayISO()`, `nowHHMM()`, `nowISO()`, Europe/London). An event is **over** when it is completed, or scheduled /
live with its end time passed; cancelled events are never over. An event is **running** when it is today, not
completed or cancelled, and start ≤ now < end. Items sort danger → warning → info, then newest `at` first (items
without `at` last), then by key; at most 20 (`ATTENTION_MAX_ITEMS`). Keys are deterministic, so a resolved item simply
disappears.

| Key | Who | Severity | Fires when |
|---|---|---|---|
| `gauges:event` | rep, leader | warning | An own-team event dated **this pay week** (Monday of today's week … today; `attentionOwnGapWindow`) is over (today's only once it has ended), and I have **no gauge row at all on that date** (a row at another event counts). **One item per date**: when the team ran two events that day the item is keyed on the earlier one (start time, then id) and names the other ("If you worked it or Volt — MediaCity: …"), because a day pays one base. Skipped before my start date and for a week whose run is already paid (the server would refuse the entry with 409). |
| `events:tomorrow` | rep, leader | info | An own-team event tomorrow that is not cancelled. Title: campaign, venue and start ("Tomorrow: BCN — Asda Hulme at 10:00"); body: city, times and the notes cut to 140 characters (the venue is not repeated). |
| `pay:overdue` | anyone with runs | danger | My pending / failed run is past its due date. "Your pay for w/c 5 Oct is 2 days overdue" · "£412.50 (PAY-…) was due Fri 16 Oct. The office sees this too." The last sentence only when the run is on the office's **Runs to pay** card (`inRunsToPay`: a pending run whose week is inside the 12-week window, or a **failed** run of any age — the set `payroll:to-pay` counts); an older pending run (own runs go back 52 weeks) says instead "It is older than the 12 weeks the office's pay list shows, so please mention it to them." An admin's own run has neither. |
| `pay:due-tomorrow` | anyone with runs | info | My pending / failed run is due tomorrow. |
| `pay:paid` | anyone with runs | info | My run was paid (paid or late) with `paid_date` in today − 6 … today: "You've been paid £412.50 for w/c 5 Oct". |
| `gauges:gap` | leader (own team), admin | warning | The event ended ≥ 2 h and ≤ 48 h ago, has ≥ 1 entry, and active rep / leader members who had started by that date have no row on that date at all. The count covers the whole team (a leader and the admin read the same "3 of 7"); the viewer is never chased by name (they get their own `gauges:event`), and a gap that is only the viewer is no gap item. Up to 5 first names. Exactly one other person missing → `/gauges?log=1&eventId&userId` with **Log for Jordan**; otherwise `/events/<id>`. |
| `events:empty` | leader (own team), admin | warning | An over event dated today − 2 … today (ended ≥ 2 h ago when it is today) with zero rows: "did it run? Log it or mark it cancelled." |
| `events:behind` | leader (own team), admin | info | **One rule with the event row's "Behind target" pill** (`eventBehindTarget`): a running event with a positive target whose forecast flag is `at_risk` (sales so far + E × the share of the day still to come < 70 % of the target, §14.6 `liveFlag`; the route attaches today's live forecasts with the GET /events builder). Only an event with **no forecast** (too little history) falls back to "after 13:00 with sales < 50 % of the target". "4 of 12 sales so far with 3 h 30 min to go. More stops in that time is the lever." |
| `gauges:odd` | leader (own team), admin | info | A row dated today − 2 … today with stops ≥ 30 and table 0, or stops ≥ 50 and sales ÷ stops > 20 %. Links to Log gauges for that row. |
| `recruitment:overdue` | recruiter, leader, admin | warning | One summary: open candidates in scope whose follow-up is overdue (a date-only follow-up the day after, by the business date; a timestamp once passed), oldest first, up to 3 names. The sentence says whose they are: admin "8 recruitment follow-ups are overdue" (the whole pipeline); leader "2 of your recruitment follow-ups are overdue" (candidates they own); recruiter "8 of your recruitment follow-ups are overdue" with "(yours or unassigned; 11 across the pipeline)" in the body — the pipeline figure is the **Overdue actions** tile (`countOverdueActions`, `pipelineOverdue` in the input), quoted only when larger. |
| `recruitment:interview` | recruiter, leader, admin | warning | **The shared outcome rule** (`outcomesToRecord` in `shared/src/logic/recruitment.ts`, §14.8): a pending interview of an open candidate that started at least 120 minutes ago and no more than 56 days ago, where I am the interviewer or own the candidate (admin: all): "Record the outcome of Aisha Khan's first interview (Tue 10:00)". On the recruiter dashboard this is the only outcome prompt. |
| `recruitment:today` | recruiter, leader, admin | info | My pending interviews in the next 24 h (I am the interviewer, or nobody is and I own the candidate), up to 3 listed. |
| `payroll:to-pay` | admin | danger if any run is overdue, else warning | `inRunsToPay`: pending runs with `week_start` in GET /finance/payroll's default window (Monday of this week − 12 weeks … today) plus **failed runs of any age** (a failed transfer is wages still owed), so the number matches **Runs to pay** (`?status=pending,failed` with no range lists exactly these): "29 runs to pay · £24,540 · 6 failed transfers". Body: "1 is overdue: it was due Fri 28 Aug. Paying it first is the lever." / "3 are overdue: the oldest was due … Paying those first is the lever." / "The next one is due …". Pending runs older than the window are not counted here (they are not on Runs to pay either); their owner's `pay:overdue` says so. |
| `payroll:due-today` | admin | warning | On a Friday with runs due that day. |
| `security:2fa` | admin | info | The admin's own two-step verification is off. |

**Own-gap window (lead decision).** `gauges:event` covers THIS PAY WEEK: from `mondayOf(today)` to yesterday, and today
once today's event has ended. An unlogged Monday is therefore still asked for on Thursday, Friday and over the weekend,
while it still counts towards Friday-week's pay (the pending run follows the gauges until it is paid). A day before
Monday is never asked for: it belongs to a week that may already be paid (and once paid the server refuses the entry
with 409). So on a Monday only today's ended event can appear; Saturday and Sunday of the week before do not. The route
loads events and rows from `attentionLookbackFrom(today)` = the earlier of today − 3 and Monday, so on Friday to Sunday
it reaches back up to 6 days; the team rules (`gauges:gap`, `events:empty`, `gauges:odd`) keep their own 2-day windows.
The attendance look-back (pay-cost wording) is the 28 days before `from`, so this week's unlogged days never count
against "usually works their team's days".

**Pay-cost wording** (`gauges:event`). The base comes from my own pay plan through
`estimateWeekPay(plan, { daysWorked: 1 })`; "plus commission" is added when the plan pays commission. The payday is
named (`paydayForWeek`, the Friday after the week ends), because on a Thursday a bare "Friday" reads as tomorrow.
- I usually work my team's event days (a row on ≥ 50 % of the team's completed event dates in the 28 days before the
  window, with at least 3 such dates): "Thursday not logged yet: that day's £60 base plus commission is missing from
  Friday's pay (23 Oct). Log it before the week is paid."
- Otherwise: "If you worked it: that day's £60 base plus commission is not in Friday's pay (23 Oct) until it is logged."
- A plan with no daily base drops the money sentence. Nobody else's pay is ever estimated.

**Client rules** (`client/src/lib/attentionSeen.ts`, `NotificationsBell.tsx`):
- **What loads when.** The bell is global (main chunk), and so are the item pieces it shares with the card
  (`features/smart/AttentionRow.tsx`). The dashboard card (`AttentionCard.tsx`) loads on demand with the other
  dashboard smart slots (`LazyAttentionCard`, §14.11), with its own h-14 loading line as the placeholder.
- **Unread** = items this device's seen set (`lm-attention-seen:<userId>` in localStorage) does not account for. The
  token is the key, plus `!` while the item is a danger, plus `#<count>` on a summary item: `gauges:gap:522#3`,
  `payroll:to-pay!#31`. An item that escalates (Runs to pay turning overdue) counts as new once more, and so does a
  summary whose count **grows** (a third person missing from a gap, another overdue follow-up); one that shrinks or
  comes back to a count already seen stays read. Opening the bell marks everything it shows as seen. Each set keeps the
  300 most recently touched tokens, and every fetch touches the tokens of items still in the feed (one write, only when
  the order changes), so only items that have left the feed are ever evicted. Every storage call is wrapped in
  try/catch; with storage blocked the sets live in memory for the page.
- **Toasts**: only for tokens not yet in `lm-attention-toasted:<userId>` and not already seen. Info items never toast,
  except `pay:paid`. The first fetch after a page load toasts at most 1 item (the most severe), each later fetch at most
  3. Nothing toasts while a dialog is open (a Modal, the page search, the bell itself; the closed mobile drawer does not
  count). Every candidate of a fetch is recorded as toasted, so whatever was not shown waits in the bell instead of
  popping up a minute later. A toast's action marks the item seen and opens its link.
- **Polling**: every 60 s while the tab is visible, plus on focus and reconnect (`useAttention({ poll: true })`).
- **Bell states**: loading shows a placeholder; a failed first fetch shows "Could not check just now" with a **Try
  again** button (never the all-clear); the all-clear "Nothing needs your attention right now" only after a successful
  empty answer.
- **Tab title**: `setTitleBadge(n)` (`lib/usePageTitle`) shows the unread count, "(2) Dashboard · Linear Hub".
- No Notification API or Web Push: both need HTTPS and the hotspot serves plain http.

### 14.6 Event forecasts and roster gaps (p6)

Rules in `shared/src/logic/eventForecast.ts` (pure, unit-tested) and `EVENT_FORECAST_RULES`:
`attendanceWeeks 8, rateWeeks 12, minBasisDays 5, z 1.64, stretch 1.3, atRisk 0.7, targetPercentile 0.6`; the server
builders are `eventForecasts`, `eventRosters` and `forecastFor` in `server/src/lib/smart/eventForecast.ts`.

There is no roster table, so attendance is inferred from the team's habits:

- **expectedReps**: the mean number of distinct reps over the team's **completed** events from the last 8 weeks
  (today excluded) that have at least one gauge entry. It is `null`, and so is the forecast, when there are fewer
  than 5 such events. The count is the number of gauge rows per event: `UNIQUE(event_id, user_id, date)`, and an
  entry's date is always its event's date.
- **Rate buckets**: completed events with entries over the last 12 weeks (today excluded), as sales and rep-days per
  event. The fallback chain is **team** (same team, campaign and type) → **company** (campaign and type, every team)
  → **campaign** (the campaign alone). `pickRate` takes the first bucket with **≥ 5 distinct completed events**;
  `basisDays` is that bucket's event count.
- **E** = expectedReps × (bucket sales ÷ bucket rep-days). **Range** = E ± 1.64√E (a Poisson band), with the low end
  floored at 0. All outputs are rounded only at the end.
- **repsNeeded** = ⌈target ÷ perRepRate⌉ (null without a rate). A tiny epsilon keeps exact multiples exact.
- **Flags**. A **scheduled** event gets `stretch` when target > 1.3 × E. A **live** event gets `at_risk` when
  salesSoFar + E × remainingFraction < 0.7 × target, where remainingFraction = clamp((end − now) ÷ (end − start),
  0, 1): it is 1 before the start, 0 after the end and 0 for a bad window. "Now" is the business clock
  (`nowHHMM()`). A live event is never a stretch. Completed and cancelled events get no forecast at all.
- **suggestedTarget** = round(60th percentile, type-7 `quantile`) of the team's per-event sales for that campaign and
  type over 12 weeks when there are ≥ 5 such events, else round(E). It is clamped to 0…500. It is a suggestion only:
  the server never applies it.
- **Copy** (§14.0): the chip reads "expect ≈ 14 (9–20) · 5 reps usually". The range is always visible, because a
  phone has no hover and tapping a row opens the event. The tooltip and the event page read "Estimate from 23 similar
  days (Deansgate team, BCN private sites, last 12 weeks) · range 9–20 · target 17 needs about 7 reps". The team is
  named, never "this team", so the line reads right for anyone looking at another team's event; a name already ending
  in "team" is not doubled. The basis reads "all teams, …" for the company bucket and "all teams, every BCN day" for
  the campaign bucket. Type words: private sites, events, B2B sites, residential patches, retail sites. The `at_risk`
  pill reads **Behind target**, the wording the copy guide allows for events (never people); `stretch` reads
  **Stretch**. Output is deterministic.

**Roster counts** (`eventRosters`). On **completed** and **live** events dated **today − 2 … today**
(`inRosterWindow`, `EVENT_ROSTER_LOOKBACK_DAYS = 2`): `members` = the event team's **active** members who had
**started by the event date**; `logged` = how many of **them** have an entry. Admins with no team, and people from
other teams who logged at the event, are not counted, so `logged ≤ members` always (`repCount` still counts everyone
with an entry).

**Cost.** At most **3 grouped SQL statements** per request, whatever the number of events: forecast attendance,
forecast rates and roster counts (each skipped when no listed event needs it). The grouped results are **memoised** per
database, data version, business day and id set (64 sets per slot, with the 20 s cache TTL as a backstop); every
mutating API request and maintenance job bumps the data version, so a saved gauge shows on the very next read. Repeated
reads run only the per-event maths (including the live flag, which moves with the clock). The rates query pins
`idx_events_date`, so its cost follows the 12-week window, not the campaigns' whole history. Nothing is ever written.

Event rows (client):

- **Tone**. Scheduled events, and live ones whose start time has not come, show **Target N** with a neutral grey
  bar. Live events after their start and completed events keep green (≥ 100 %), primary (≥ 50 %) or amber (< 50 %).
  Cancelled events stay red.
- **"N / M logged"** replaces the rep count on **completed or live events dated today − 2 … today**, from the
  server's `roster`. It is amber while N < M, never reads N > M, and agrees with the event page's list. Older gaps are
  history and are not tinted. Without `roster` (`LM_SMART=0`), the row shows the plain rep count as before.
- **Not logged yet** (event page): shown to the admin, or to that team's leader (the same rule as managing gauges),
  on live or completed events in the same window. The list is the team's active members who had started by the
  event date, minus everyone with an entry, sorted by name. Recruiters and other teams' people never get the list,
  and the users query does not even run for them.
- **Log today's gauges**: a rep with no entry on today's live (or just-ended) team event sees this label on the
  event page's main button.
- **Dashboard Log gauges**: shown for today's events that have started, to people who may log there (admin; a
  leader or rep at their own team's event). It links to `/gauges?log=1&eventId=<id>`.
- **Directions**: every event row (Events page and dashboard) has a 40 px icon link, and the event page has a text
  link, built in the browser as `https://www.google.com/maps/search/?api=1&query=<encodeURIComponent("venue, city")>`.
  Both open in a new tab with `rel="noopener noreferrer"`.

**Edge cases.** A team with fewer than 5 attended days in 8 weeks gets no forecast and its rows look exactly as before.
When there is no suggestion (thin history, a team that rarely works, or `LM_SMART=0`), the **New event** form says
"No suggested target for this team, campaign and type. Set the target as usual." It gives no reason, because the
browser cannot tell which case applies. On a Sunday the seed has no events, so there is simply nothing to forecast.
The **New event** form asks for the forecast without a target (one cached request per campaign, team and type) and
works out "needs about N reps" and the Stretch pill in the browser with the same shared rules, so typing never sends a
request.

### 14.7 Logging when the signal drops (p7)

Goal: never lose a rep's day to a dropped hotspot. Linear Hub says clearly when it cannot reach the server, keeps gauge
saves on the phone and replays them safely, preselects today's event so logging is two taps, and offers a live tally
counter for the shift. No endpoint was added: the outbox replays through the existing gauge routes, so every role
rule, the funnel check, the paid-week lock and the check-in rules still apply to a replayed save.

`shared/src/logic/outbox.ts` (pure, tested in `outbox.test.ts`):

| Function | Rule |
|---|---|
| `replayDecision({ queuedAt, expectedExistingId }, existing)` | `existing` null: **send** for a new day (`expectedExistingId` null); **review** when the form had shown an entry (`expectedExistingId` set) that is now gone, because someone deleted it while the save waited and sending would quietly create the day again (a gauge row pays a day's base). `expectedExistingId` null with an entry, or a different id → **review**. Same id: **review** when `existing.submittedAt` is after `queuedAt`, otherwise **send**. Timestamps are compared as instants; an unreadable one gives **review** (when in doubt the phone never overwrites). |
| `sameGaugeDay(existing, input)` | True when the server already holds exactly what was queued: the six counts match, and so do the check-in (to the minute) and the notes (trimmed; empty = null) wherever the queued save carries them. That is a save whose answer was lost: nothing is sent and the item is cleared ("it was already on Linear Hub"). |
| `replayOutcome(status)` | 201 `logged`, 200 `updated`, 401 `stop`, other 4xx `failed`, anything else `stop`. |
| `inCheckInWindow(start, now)` | `now` within [start − 60 min, start + 90 min], both ends included; no wrap past midnight. |
| `preselectTodayEvent(events, today, teamId)` | The one own-team event dated today whose status is `live` or `completed`; null when there are none or several, or no team. |
| `firstMemberWithoutEntry(members, loggedIds)` | The first member in list order who is active, not a recruiter and has no entry for the event. |
| `tallyPerson(counts, key, ±1)` | One tap counts **one person at the furthest stage they reached**. +1 on stage K adds 1 to every stage from Stops down to K; the stages after K never move. So Stops +1 adds a stop only, Presentations +1 adds a stop, a table and a presentation, Taps +1 adds one to Stops through Taps, and Sales +1 adds one to all six. −1 on K takes that person off again (every stage from Stops to K down by 1), so it is the exact inverse of the +1. A −1 is refused when K is 0 ("Sales is already 0.") or when K equals the stage after it: then nobody's furthest stage was K (everyone counted on K went further), so there is no such person to take off. The hint names the tile that does lower K: the first stage J after K whose count is above the next stage's (Sales counts as above the 0 after it), so somebody's furthest stage was J. A −1 on J is always accepted and takes that person off Stops through J, K included: "Can't take one off Closes: all 2 people who got to closes went on to taps. Take one off Taps instead (Closes comes down with it)." With [9, 6, 5, 3, 2, 2] a −1 on Taps names Sales (both taps went on to a sale). Following the hint once lowers K by exactly 1 (tested over 400 funnels), and J is the nearest tile that can, so it takes off as little as possible. A +1 is refused only when a stage it would raise is at the daily maximum (2,000), naming that stage: "Stops is at the daily maximum of 2,000." A refused tap returns the same counts and one hint. Every accepted tap keeps the funnel (stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales) by construction, and every valid funnel is a sum of people's outcomes, so no order of taps is ever needed and no +1 is ever blocked for order. Counts that are not a funnel (never stored: `normaliseTally`) never go below 0. Pure and deterministic; the input is never changed. Replaces 1.1.0's `tallyStep` (a +1 changed only its own row and was refused above the stage before it), `tallyStepThrough` and `tallyThroughOffer` (**Count it through**). Stored tallies are funnels already, so they carry over unchanged. |
| `normaliseTally(raw)` | Stored counts → whole numbers 0…2,000, then each stage lowered to the one above if needed. Never throws. |

**The outbox** (`client/src/features/gauges/outbox.ts`; one localStorage key per signed-in person,
`lm-gauge-outbox:<userId>`, at most `OUTBOX_LIMIT` = 50 items):

* **When a save is kept on the phone.** Log gauges keeps the save on the phone instead of sending it when the browser
  reports offline, or when the existing-entry lookup could not reach the server (it is paused or failed with a
  `NetworkError`). The button then reads **Save on this phone**. A save that throws a `NetworkError` mid-request is
  kept too. A lookup that fails with an `ApiError` still pauses saving, exactly as before.
* **What is stored.** The body the form would have sent; `expectedExistingId` = the id of the entry the form showed
  (null for a new day); and `seenSubmittedAt` = that entry's `submittedAt` as the form saw it.
* **Clock skew.** Replay compares against `seenSubmittedAt` when it is known, not `queuedAt`. Both timestamps then
  come from the server's clock, so a phone clock that is minutes out cannot turn a colleague's later edit into a send.
  `queuedAt` (the phone's clock) is only the fallback, and is shown to the person.
* **One version per day.** A newer save for the same (event, person, date) replaces the waiting one, so a day is never
  sent twice in two versions. A save from the form for a day that is also kept on the phone replaces the kept copy.
* **When the phone can't keep it.** At most 50 items per person. If storage is unavailable (some private modes),
  full, or at the limit, nothing is queued and the form shows its usual error, so nothing is ever dropped silently.
* **Replay** (`replayAll`) is single-flight and oldest first. For each waiting item it looks the day up
  (`GET /gauges?eventId&userId&from=<date>&to=<date>&limit=5`), clears the item if `sameGaugeDay` matches, then applies
  `replayDecision`: **review** stores the server's version (`server: { id, submittedAt, stops, sales }`) and sends
  nothing (when the entry the form had shown was deleted meanwhile there is no `server`, and the sheet says **Linear Hub
  no longer has the entry you changed — it may have been deleted. Sending yours logs this day again.**); **send** POSTs
  the upsert. It re-reads the list after every item, so anything queued meanwhile goes in the same run. A
  `NetworkError`, a 401 or a 5xx stops the loop. After any send, every gauge-dependent query is refetched.
* **Replay triggers.** Mounting the app shell (that is, after sign-in), the browser's `online` event, `lm:network`
  turning from false to true, and **Send now**.
* **Send mine anyway** POSTs a *review* or *Not accepted* item whatever the server holds. A null check-in or note is
  left out, so a colleague's recorded check-in or note is kept, not cleared. For a deleted entry it creates the day
  again, which is the person's explicit choice.
* **Scope.** Replay only ever reads the signed-in person's key. Signing out with items asks first and deletes nothing.
  The server enforces who may write what.

**Offline banner** (`features/common/OfflineBanner.tsx`):

* **Shows** on the browser's `offline` event, or on `lm:network` false (that is, after one request without an answer).
* **Clears** on `online`, or on the next HTTP response of any kind.
* **While it shows**, it asks `GET /health` every 30 seconds while the page is visible, so a hotspot that comes back
  clears it and replays the outbox without a tap.
* **Try again** asks `/health` and refetches every active query.
* **Placement.** It and the outbox strip share one sticky band under the top bar. The band has an opaque page
  background, because the strips' soft tints are translucent in dark mode, so scrolled content never shows through.

**Smart defaults in Log gauges.** These apply only when the modal is opened with no event and no entry; with an event
or an entry it behaves exactly as in 1.0.

* **Today's event.** It is preselected by `preselectTodayEvent` for the person's own team, with the hint **Today's
  event selected**. A scheduled event that has not started is not preselected.
* **Check-in chip.** **Checking in? Use now (09:58)** shows only when the selected event is today, there is no existing
  entry, the check-in is empty and `inCheckInWindow(start, now)` is true. One tap fills the check-in. It never fills
  itself, so an end-of-day form cannot record a punctual arrival. The form re-reads the clock every 30 seconds, so the
  chip and the "starts at" block follow the time while it is open.
* **Rep for leaders and admins.** Without a `defaultUserId`, a leader or admin starts on `firstMemberWithoutEntry`
  (taken from the event's entries), with the hint **First on the team without an entry yet**. The existing-entry
  lookup waits until that choice is made.
* **Without signal**, the event picker and a leader's rep picker fall back to the lists already loaded this session
  (the dashboard's upcoming events, event lists and pages, team lists). The hint then says so. A leader or admin
  finishing their own tally (`defaultUserId` = themselves) with no team list loaded is offered just themselves, so
  their own day can still be kept on the phone, as a rep's can.

**The tally** (`features/gauges/TallyMode.tsx`, `tallyStore.ts`; key `lm-tally:<userId>:<eventId>:<date>`):

* **Counts.** They are kept per (person, event, date), survive reloads and dropped signal, and never leave the phone
  until **Finish shift**. Unfinished tallies older than 14 days are dropped.
* **Several tabs.** An open counter follows the store: it reads the stored counts again on every change (the storage
  event, for another tab) and whenever its tab comes back into view or gets focus. A tap in a tab left open all shift
  therefore adds to the counts taken in another tab, and never writes older ones over them. Without working storage
  the counts in memory stay as they are.
* **Which event.** The tally offers today's events (own team for reps and leaders; any team for admins) plus any
  event with an unfinished tally. It picks the event under way, then the one live event, then the only event;
  otherwise it asks.
* **Finish shift** opens Log gauges prefilled with the counts. Saving goes through the same validation and the
  outbox. When the day already has an entry, the counts update it, and the stored check-in and notes are kept. The
  tally is cleared once the save succeeds or is kept on the phone.
* **Counting.** Each tap goes through `tallyPerson`: one person at the furthest stage they reached, the earlier stages
  with it. Under the event: **Tap the furthest stage each person reached. Earlier stages count too.** (`TallyHelp.tsx`,
  one unbreakable run per sentence, so a narrow screen breaks between them). Labels say what a tap does: "Add one
  person who reached Presentations (also adds a stop and a table), now 5"; Stops reads "Add one person who just
  stopped, now 5"; a −1 reads "Take one person off Presentations (also takes off a stop and a table), now 5"
  (`addPersonLabel`, `takePersonLabel`).
* **Highlight.** Every stage the last +1 raised flashes for 300 ms: a primary ring and a light tint over its row (the
  card) or tile (Quick gauges) fade out, and the count gives a small scale pulse. Each tap restarts it. It uses the Web
  Animations API (`useRaiseFlash`), so the shared stylesheet needs no keyframes for it. With `prefers-reduced-motion: reduce`
  only the fade runs (no movement); without Web Animations nothing happens. A −1 does not flash.
* **Buttons.** +1 buttons are 56 px tall; −1 buttons are 44 px. A +1 is greyed only when it would take a stage past the
  daily maximum. A refused tap shows its hint for 5 seconds.
* **Loading.** The full-screen counter loads the first time the tally opens (`LazyTallyMode`, §14.11); the Gauges
  header's **Tally** button and the dashboard's **Count your shift** link are light pieces in `TallyLinks.tsx`.
* **Shared code.** The counting lives in `useTallyCounter(event)` (`features/gauges/useTallyCounter.ts`: counts,
  `tap(key, ±1)` on `tallyPerson`, `raised` (the stages the last +1 raised, for the highlight), reset with a confirm,
  the finish handlers, the persisted flag and the hint),
  with `useTallyEvents` and `defaultEvent`; the event list is `TallyEventPicker.tsx`. The Tally card and Quick gauges
  both use them, so they count, refuse and finish the same way. The card also has **Full screen** (an icon on a phone),
  a link to `/quick?eventId=<id>`.

**Quick gauges** (`pages/QuickGauges.tsx`, route `/quick`, its own lazy chunk; admin, leader and rep only):

* **Same tally.** It reads and writes the same store as the Tally card, per (signed-in person, event, date). A tally
  started on the Gauges page shows the same numbers on `/quick`, and the other way round. Leaders and administrators
  count their own shift (`defaultUserId` = themselves), exactly as on the card.
* **Which event.** The same rule as the card (`defaultEvent`). **Change** shows when there is more than one; the same
  event list, empty line and no-signal line when none is picked. `/quick?eventId=<id>` preselects that event (read on
  the first render, then stripped by `useActionParam`); an event the person can't count today shows **That event isn't
  one you can count today.** above the list.
* **Tiles.** Six, in funnel order. The whole tile is the +1 button (label, the count in tabular figures, a stripe in
  the campaign's colour). The −1 is its own 44 px button in the top-right corner, a sibling of the tile (not nested),
  so it never adds. Both are labelled with what they do and the current count, as on the card ("Add one person who
  reached Sales (also adds a stop, a table, a presentation, a close and a tap), now 2"), reachable with Tab, and work
  with Enter or Space. Under the stage's name a second line says what a tap adds (`TALLY_ADDS`): Stops **just a
  stop**, To table **+ stop**, Presentations **+ stop, table**, Closes **+ 3 earlier**, Taps **+ 4 earlier**, Sales
  **+ all 5 earlier** (11 px on a phone, 12 px from 640 px; "+ stop, table, pres." would need 97 px where a 360 px
  phone's tile leaves 91, so Closes counts instead of naming). It keeps clear of the −1 like the label; held sideways
  it sits in the tile's bottom-right corner, beside the count. The **+1** chip is grey only at the daily maximum. The
  chip sits at the right end of the count's row; in a narrow, short tile (a container query: content at most 13rem wide and 8.75rem tall, so a phone
  held upright with tiles up to about 164 px tall) it moves to the left of the count and the row sits at the bottom,
  so the chip is never within about 30 px of the −1 (58 px at 360×640, 65 px at 375×667). Taps buzz briefly where the
  phone supports vibration (`navigator.vibrate`), and `touch-action: manipulation` stops quick double taps zooming the
  page.
* **Layout.** 2 columns × 3 rows on a phone held upright, with the rows sharing the height under the header (tiles
  ≥ 88 px). 3 × 2 from 640 px wide (tiles ≥ 96 px) or held sideways. When the screen is under 481 px tall (a phone held
  sideways), the tiles go down to 80 px and the header and bar get tighter, so all six fit without scrolling. So do a
  small phone held upright (`tiny`: portrait and at most 600 px tall, e.g. 320×568). The help line sits just under the
  event header (11 px, two lines on a phone); held sideways it moves into the header, to the right of the event, so it
  takes no height. To make room for it, the phone header is 48 px (56 px from 640 px) and tiles on a phone held upright
  have the 88 px floor (not 96 px), so all six still fit on a 360×640 screen. There is never a horizontal scroll: the
  hint wraps inside the bar. The count is sized to its tile in container units: up to half the tile's height, no taller
  than the room left under the label and the "what a tap adds" line (`(100cqh − --tile-head) / 1.05`, with `--tile-head`
  set per layout: 2.25 rem in a cramped phone tile, 2.5 rem otherwise on a phone, 2.375 / 2.625 rem from 640 px, 1.5 rem
  held sideways), and narrow enough for its digits plus the chip (`(100cqw − 3.5rem) / (0.66 × digits)`), between
  1.5 rem and 9 rem. All six are sized for the largest count, at least two digits, so they stay one size and step down
  together once, when a count reaches 100. Checked at 320×568, 360×640, 375×667, 375×812, 390×844, 412×915, 667×375,
  844×390, 768×1024, 1024×768, 1024×1366 and 1440×900, light and dark. At 320 px "Presentations" is cut short with an
  ellipsis (it was before; every "what a tap adds" line fits).
* **Refused taps.** Only a −1 that later stages still need, or a +1 at the daily maximum. The hint replaces the bottom
  bar for 8 seconds, in the same box, so the tiles never move under a thumb. It is also announced to screen readers,
  and × dismisses it. Any accepted tap clears it.
* **Bottom bar** (sticky, above the iPhone home indicator via `env(safe-area-inset-bottom)`): "N sales from M stops ·
  1 in X", **Reset** (asks first) and a large **Finish shift**. Finish shift opens Log gauges prefilled exactly as on the
  card: same validation, same outbox, and the tally clears once it is saved or kept on the phone.
* **Reset's confirm** takes the bar's place at the same height, so the tiles do not move: the safe **Keep counting**
  where **Finish shift** was (and focused), the red **Reset to 0** at the far left where the summary was ("Clears all
  six counts."), and nothing where the small **Reset** was. A second tap on either familiar spot never wipes the shift.
* **Screen awake.** While the page is open it asks for a Screen Wake Lock where the browser has one (secure contexts
  only), takes it again when the tab comes back into view, and releases it on leaving. Without one (plain http over a
  hotspot) nothing happens and nothing is said. Errors are swallowed.
* **Entry points.** A primary **Quick gauges** button pinned at the top of the sidebar, above **Workspace** (an icon
  button with a tooltip when collapsed, the same button at the top of the phone drawer). A nav item with
  `variant: 'action'` in `nav.ts` places it there and keeps it in ⌘K quick navigation. While a tally is under way today
  it shows the running stop count (`useStoredTallies`). Below `lg` the topbar has an icon button next to the bell
  (40 px, "Quick gauges"), hidden on `/quick` itself. Recruiters see none of it, and `/quick` gives them the usual
  not-allowed page.
* **Opens without signal.** For admins, leaders and reps the shell fetches the page's code (with Log gauges') once
  the app is idle after sign-in (`requestIdleCallback`, a 2-second timer in Safari; only when the browser is online).
  Quick gauges then opens even when the signal has dropped since, with the events already loaded this session.

**Edge cases and limits.**

* **Browser offline, storage blocked.** The modal does not offer the phone. TanStack Query holds the save until the
  browser is back online, as in 1.0.
* **No service worker or HTTPS (out of scope).** The outbox protects saves while the page stays open. A page whose
  code was never downloaded cannot open without signal (it shows **This page hit a problem**). Quick gauges is the
  exception: its code is fetched ahead, on idle, after sign-in.
* **The kill switch** (`LM_SMART=0`) does not turn the outbox off: it is a reliability feature and builds no smart
  payload.

### 14.8 Recruitment SLAs (p8)

Next-action deadlines now mean something: every open stage has a target number of days, moving a candidate sets the
new stage's deadline from it, candidates who sit in a stage past its target are badged **Idle**, and interviews that
have happened but still say *pending* ask for their outcome. Everything lives in `shared/src/logic/recruitment.ts`
(pure, tested in `recruitment.test.ts`; the constants live there too, not in `constants.ts`). These are workflow rules,
not estimates, so they **stay on with `LM_SMART=0`** (§14).

#### Stage targets and the default deadline

```
STAGE_SLA_DAYS = { applied: 3, screening: 5, interview: 7, observation: 7, offer: 7 }   // calendar days
```

`stageSlaDays(stage)` → the number, or `null` for `hired`, `rejected` and `withdrawn`.

`defaultNextActionAt(stage, today)` = `addDays(today, STAGE_SLA_DAYS[stage])` as a **date-only** `YYYY-MM-DD`; `null`
for closed stages. Being date-only, the shared `isOverdue` rule (§7) treats it as due **on** that day and overdue
**from the next calendar day**: `defaultNextActionAt('screening', '2026-10-19')` = `'2026-10-24'`, not overdue on the
24th, overdue on the 25th. A timestamp passed as `today` keeps its own day. UTC date arithmetic, so DST changes never
shift it (Offer from Thu 22 Oct → Thu 29 Oct across the 25 Oct clock change). The server applies it on create (Applied
target) and on every stage move whose body leaves `nextActionAt` out; this replaces 1.0's carrying of the previous
stage's deadline forward, which is why most open candidates used to show as overdue.

#### Idle

- `businessDateOf(value)` → the **Europe/London** calendar date of an instant, whatever zone the machine runs in
  (`Intl.DateTimeFormat` with `timeZone: 'Europe/London'`). A `YYYY-MM-DD` is already a business date; a naive
  timestamp (no `Z`/offset) is London wall-clock time and keeps its own day; an impossible day (`2026-02-31`, which
  `Date` would roll over to 3 Mar) or garbage → `null`.
- `candidateIdleDays({ stage, stageUpdatedAt }, now)` = whole London calendar days from the day of `stageUpdatedAt`
  to the day of `now`: `0` on the day of the move, never negative (a clock behind the stage change gives 0), `null`
  for closed stages or an unreadable date. Calendar days, not 24-hour blocks: moved 23:30 on 1 Dec, it is 2 days at
  00:30 on 3 Dec. Moved 23:30 UTC on 13 Oct (00:30 BST on the 14th) counts from the 14th.
- `isIdle(c, now)` = `candidateIdleDays > STAGE_SLA_DAYS[stage]` — **exactly the target is still on target**; one day
  more is idle. Screening moved Wed 14 Oct: 5 days on Mon 19 Oct (not idle), 6 on Tue 20 Oct (idle). Closed stages are
  never idle.
- **The counter restarts on every stage change**, because a move rewrites `stageUpdatedAt` (and starts a new
  deadline).
- `daysPastTarget(c, now)` = `candidateIdleDays − STAGE_SLA_DAYS[stage]`: positive = idle by that many days, `0` =
  exactly on target, negative = days left; `null` for closed stages or an unreadable date.
- `compareLongestIdle(a, b, now)` — the "Longest idle first" comparator: `daysPastTarget` descending (so every idle
  candidate sorts before every on-target one), then earlier `stageUpdatedAt`, then id; `null`s last.
- "Idle" and "overdue" are independent: overdue is about the next-action date (which a person may push back), idle is
  about time in the stage (which only a move resets).

#### Outcomes to record — one rule, one place (lead decision)

- `needsOutcome(interview, now)` = `outcome === 'pending'`, `scheduledAt ≤ now − OUTCOME_PROMPT_HOURS` (**2 h**, the
  120-minute grace after the scheduled time) **and** `scheduledAt ≥ now − OUTCOME_LOOKBACK_DAYS` (**56 days** of 24 h).
  Exactly two hours and exactly 56 days count; future, recorded (`passed`/`failed`/`no_show`), older or unreadable
  interviews never do. `outcomeLookbackFrom(now)` is that earliest instant (ISO).
- `outcomesToRecord(interviews, me, ownerOf, now)` keeps the `needsOutcome` ones whose candidate is still in the open
  pipeline (when the interview carries `candidateStage`; a forgotten outcome on a hired, rejected or withdrawn
  candidate is no longer anything to act on) and where `me` is the **interviewer** or **owns the candidate**
  (`ownerOf(candidateId) === me.id`); an **admin** gets them all. Oldest first, then by id. A candidate `ownerOf` does
  not know counts as not owned.
- **Call sites.** The Needs-attention feed (`recruitment:interview` items, §14.5) calls `outcomesToRecord`; its route
  loads pending interviews of open candidates from `outcomeLookbackFrom(now)` to 2 days ahead. The candidate page's
  **Record the outcome** card and **Outcome due** badge (`client/src/pages/CandidateDetail.tsx`) call `needsOutcome`.
  The week in review's recruiter line (§14.9) uses `outcomesToRecord` too. Nothing else carries a copy.
- **Shown once on the recruiter dashboard**: in the **Needs attention** card at the top (and the bell). The recruiter
  section has no **Outcomes to record** card of its own, and reads interviews with the server default (Monday of this
  week → today + 14) for **Interviews this week** and **Upcoming interviews**.
- **Recruiter dashboard tiles**: six KPI tiles (including **Idle beyond target**), one row of six only from 1536 px
  (`2xl`); 2 columns on phones and 3 columns (two rows) from 768 px, so no label is cut off at 1280–1535 px.

#### Client rules

- **Idle badge**: `Idle {days}d` (warning tone, hourglass icon), with the full sentence for screen readers and as a
  tooltip: "22 days in Interview, target 7 days".
- **Longest idle first** (`compareLongestIdle`, within each board column and over the whole list): every idle
  candidate comes before every on-target one, idle ones furthest past their target first, then on-target ones nearest
  to their target first. Ties: longer in the stage first, then by id. Closed candidates (list with **Include closed**)
  and unreadable dates go last. Example: Applied for 5 days (target 3, +2, idle) comes before Interview for 5 days
  (target 7, −2), whichever moved first.
- **Order select**. Board: *Recently moved first* (the server's order, `stage_updated_at` newest first) or *Longest idle
  first*. List: *Newest applicants first* (the default, the Applied column descending), *Recently moved first* (no
  column sort: the server's order) or *Longest idle first*. The list's sorting is controlled by the page, so the select
  always names the order on screen: a column header sort shows "Sorted by column", and clicking that header until its
  sort clears shows *Recently moved first*. The choice carries across views (*Newest applicants first* has no board
  equivalent, so the board stays on *Recently moved first*).
- **Filter row** (search, source, owner, order): 40 px tall on phones (below 640 px) for tap targets, the compact 32 px
  from 640 px up.
- **Move to…** option labels: `{Stage} · due {EEE d MMM}` from `defaultNextActionAt(stage, today)` for open targets;
  closed targets keep the bare label. After a move the toast reads the deadline the server returned: "Next action due
  Sat 24 Oct (5-day target)" — the target is named only when the stored date is the stage default.
- **Due field** (candidate page): a date-only deadline shows as 23:59 on that day (due by the end of it) instead of
  01:00 in summer time, and the deadline is only sent when the field was changed, so saving notes never turns a
  date-only deadline into a timestamp.
- Deterministic: the same data and day give the same badges, order and sentences.

### 14.9 Week in review (p9)

Code: `shared/src/logic/digest.ts` (pure wording: `plural`, `gbp`, `deltaPhrase`, `digestTitle`, `buildDigest`,
`digestText`) and `server/src/lib/smart/digest.ts` (`weekDigest`: gathers the facts). The server only **gathers**
figures, and only from the functions behind the tiles, so a digest can never contradict a tile; the shared module only
**words** them. No LLM step in this release.

**Helpers.**

| Function | Rule |
|---|---|
| `plural(n, noun, pluralNoun?)` | `1 sale`, `2 sales`, `0 sales`, `1,240 stops`, `3 people` (en-GB grouping) |
| `gbp(n)` | Intl en-GB GBP, rounded to pence: `£1,050` (no pence when whole), `£412.50`; `-0` and NaN → `£0` |
| `deltaPhrase(cur, prev, format?)` | `up 3 on the week before` · `down 2 on the week before` · `the same as the week before` · `no comparison yet` when `prev` is null, 0 or not a number (never NaN). `format = gbp` for money: `up £2,760 on the week before` |
| conversion phrase | one decimal place; `up from 1.9% the week before` · `down from …` · `the same as the week before` (equal to one decimal place, or `periodDeltas().conversion` = 0) · `no comparison yet` (no stops either week, or `periodDeltas().conversion` is null) |
| `digestText(d)` | `title + '\n' + '• ' + line` for each shareable bullet; markup characters (`<`, `>`, `*`, `#`, `_`, `~`, backticks) stripped; `''` when no line is shareable |

**Where every figure comes from** (the week = `monday … sunday`; the week before = `monday − 7 … monday − 1`):

| Figure | Source |
|---|---|
| sales, stops, conversion and their change | `totalsFor` on the week and the week before + `periodDeltas` (rep: `g.user_id = me`; leader: `u.team_id = my team`; admin: everyone) — the dashboard tiles' functions |
| rank, movement, top seller, movers | `rankedBoard({ from: monday, to: sunday, previous, teamId })` — the team board GET /leaderboard shows (shared competition ranking; movement = previous rank − rank, null for someone not ranked the week before) |
| bonus outcome | the plan's `bonusThreshold` / `bonusAmount`; reached = the stored run's `bonus > 0` (or, with no run yet, sales ≥ threshold); the sales count is the run's (else the gauges') |
| the rep's pay (private) | the stored payroll run for the week (`gross`, `status`, `due_date`, `paid_date`); with no run yet, `weekPayFor(...).pay.gross` worded as an **estimate** |
| tip | `coachingInsights(totals, ratiosOf(totals))` on the week: the first `warning` (the weakest stage below benchmark), else the first `neutral` tip, else the first insight |
| late check-ins | `punctualitySummary` over the team's gauge rows in the week with a recorded check-in (late = more than `LATE_GRACE_MINUTES` = 5 after the event start) |
| next week | the team's non-cancelled events in the week after; `eventForecasts(db, upcoming, today)` for the scheduled / live ones dated today or later |
| check-in count (private) | `checkInList(db, { teamId, excludeUserId: me }, today).length` — the same list as the dashboard; names never leave the server builder |
| revenue | `Σ g.sales × GAUGE_PAYOUT_SQL` over the week, rounded to pence — equal to `totals.revenue` of GET /finance/summary for that week |
| campaigns | one grouped query: each campaign's sales this week and the week before |
| hires, applications | `recruitmentSummary(db, monday, sunday)` (`hired`, `applied`); the recruiter's interviews = its `weekly[].interviews` |
| payroll (private) | `payroll_runs` with `week_start = monday`: count, gross, and the unpaid (`pending` / `failed`) part; payday = `paydayForWeek(monday)` |
| failed transfers (private) | every run with status `failed`, whatever its age — the same runs as **Runs to pay** and the bell (`inRunsToPay`) |
| overdue actions | `recruitmentSummary.overdueActions` — the recruiter's **Overdue actions** tile (open candidates past their next action, whole pipeline) |
| outcomes to record | the shared `outcomesToRecord` (§14.8) over pending interviews the recruiter runs or owns, from `outcomeLookbackFrom(now)` to now |
| open pipeline | Σ `recruitmentSummary.openByStage` over the open stages (applied … offer) |

**Bullets by role** (in this order; a line is left out only where noted; 5–8 lines, never more than 8; 🔒 = private):

- **Rep** (also a leader without a team, on their own figures):
  1. `You made 20 sales — up 6 on the week before.` (a week with no gauges: `No gauges logged this week — 0 sales.`)
  2. `322 stops (up 37 on the week before) at 6.2% conversion — up from 4.9% the week before.` When sales fell but
     conversion held (or rose), one lever is added: `Your conversion is holding, so the volume is the lever: about 43
     stops make a sale.` (stops ÷ sales, rounded up). A week with no gauges shows the week before instead
     (`The week before: 9 sales from 500 stops.` or `Nothing logged the week before either, so there is no comparison
     yet.`).
  3. `You finished 2nd of 7 on Northern Lights — the same place as the week before.` (`joint 2nd` on a shared rank;
     `not ranked the week before`; no rows: `You are not on the Northern Lights board this week — it starts with your
     first logged day.`; no team: `You are not on a team board yet, so there is no rank this week.`)
  4. Bonus — only when the plan has one and the rep worked: `You reached the £75 bonus — 14 sales against the 12
     needed.` · `You finished one sale short of the £75 bonus.` (threshold − 1) · `You finished 4 sales short of the
     £75 bonus (12 needed).` The threshold and amount are the plan's rule (the same for everyone on it), not pay.
  5. `Tip: …` (the coaching sentence).
  6. 🔒 `Your pay for the week: £1,275 gross, due Fri 23 Oct.` · `…, paid Thu 15 Oct.` · `…, due Fri 23 Oct — the first
     transfer did not go through and will be sent again.` · `about £640 gross (an estimate until the payroll run is
     made; paid Fri 23 Oct).` · `No pay for w/c 12 Oct.`
- **Leader:**
  1. `Northern Lights made 91 sales — up 20 on the week before.`
  2. `Team conversion 4.4% from 2,074 stops — up from 4.1% the week before.` (+ the same volume lever, worded "The
     team's conversion is holding …")
  3. `Top seller: Amelia Hart with 22 sales.` / `Joint top sellers: A and B with 12 sales each.` Left out when nobody
     sold, or when anyone sharing the top spot is on the leader's check-in list.
  4. `Biggest move up: X, 2 places to 1st.` (shareable) and `Biggest move down: Y, 2 places to 3rd.` (**private**:
     naming one person's fall in the team group would not be kind, so it never reaches the WhatsApp text). New
     entrants (movement null) and unchanged places are ignored; ties go to the bigger move, then the better rank, then
     the name. Either line is left out (never swapped for the next person, so it stays true) when that person is on
     the check-in list.
  5. `4 of 31 recorded check-ins were late (more than 5 minutes after the start).` · `All 12 recorded check-ins were on
     time.` · `No check-in times were recorded this week.` (a count only, never names)
  6. Next week — `Next week (w/c 19 Oct): 5 events, expect about 85 sales (estimate 70–100) against targets of 84.`
     E = Σ expectedSales of the events with a forecast; the range is E ± 1.64√E (the per-event Poisson band, applied to
     the sum), rounded, low ≥ 0; targets are summed over the same events. Variants: `… 4 events still to come; the 3
     with a forecast expect about …` (part of that week has passed or some events have no forecast), `… 3 events with
     targets of 36 sales.` (no forecast), `… no events booked yet.`, and for a week whose following week is already
     over: `The week after (w/c 19 Oct): 5 events made 91 sales against targets of 80.`
  7. 🔒 `2 people on your check-in list — the dashboard shows who.` / `Nobody is on your check-in list this week.`
- **Admin:**
  1. `Linear MCR made 281 sales — down 5 on the week before.`
  2. `Revenue £32,455 — down £395 on the week before.`
  3. `Biggest rise: Volt Energy, up 15 sales to 30.` 4. `Biggest fall: Breast Cancer Now, down 28 sales to 114.` (ties:
     the bigger change, then the name; `Every campaign sold the same as the week before.` when nothing moved)
  5. `Recruitment: 0 hires and 4 applications.`
  6. 🔒 `Payroll due Fri 23 Oct: £24,437.50 across 29 runs.` (`(2 already paid)` when some are; `Payroll for w/c 12 Oct:
     £… across N runs, all paid.`; a payday already passed: `… £615 across 1 run still to pay (due Fri 21 Aug; 27 already
     paid).`; `No payroll runs for w/c 12 Oct yet.`)
  7. 🔒 `2 failed transfers to send again, £2,320 in all.` (only when there are any)
- **Recruiter** (never a gauge, sales, revenue or pay line):
  1. `4 applications — down 1 on the week before.` 2. `8 interviews — the same as the week before.`
  3. `0 hires — no comparison yet.`
  4. `11 open candidates are past their next action — clearing the oldest first keeps them warm.` / `No open candidate is
     past their next action — every one has a next step in date.`
  5. `2 interview outcomes to record now.` / `No interview outcomes are waiting to be recorded.`
  6. `17 candidates in the open pipeline.`

**Privacy and scoping.** Every query is limited to what the caller already sees (own rows; the leader's own team; the
admin everything; the recruiter recruitment only). Names appear only on the leader's lines 3–4, which come from their
own team's leaderboard (already public to them and the team); a rep's digest names nobody, an admin's names campaigns
only. Anyone on the leader's private check-in list is never named in any line (the line or half-line is dropped), so the
shared text cannot hint at the list; the count line is private and carries no names. Pay — anyone's — is only ever in
private lines. `DigestBullet.private` is `true` for the rep's own pay, the leader's check-in count, and the admin's
payroll and failed-transfer lines, nothing else; private lines are never in `text`.

**Determinism.** No randomness and no "now" in the wording. The lines about the week itself depend only on the stored
data for that week and the week before; the "now" figures (next week's forecast, the check-in count, overdue actions,
outcomes to record, failed transfers, whether the payday has passed) are computed for the business date, as on the
tiles. Ties sort by size, rank, then name.

**Edge cases.** The week before had nothing → `no comparison yet` (never NaN or `undefined`). A week with no gauges →
the kind week-off wording, no bonus line. A plan without a bonus → no bonus line. A leader without a team → the rep
bullets on their own figures. `LM_SMART=0` → `bullets: []`, `text: ''`.

**Performance.** Rep ≈ 8 statements, leader ≈ 16 (7 of them `checkInList`; `eventForecasts` is memoised per data
version), admin ≈ 16 (10 of them `recruitmentSummary`), recruiter ≈ 21 (two `recruitmentSummary` calls and one
interviews query). Every one is a grouped or keyed query (no per-row loops), and the response is cached for 20 s per
user and URL. The only possible write is `ensurePayrollMaterialised` (last week's pending runs, if the daily job has
not made them yet), never a gauge row.

**Bundle.** `WeekInReview` lives in the on-demand dashboard chunk (§14.11).

### 14.10 Backups, restore, the background service and compression (p10)

Not smart logic (none of it is switched by `LM_SMART`), but rules worth stating once. The operator's view is in
README.md ("Backups and restore", "Run it in the background"); the switches are `LM_BACKUP`, `LM_BACKUP_DIR`,
`LM_BACKUP_HOUR` and `LM_COMPRESSION`.

**Backup** (`server/src/lib/backup.ts`, `backupNow`)
1. `backup(db, '<dir>/.<name>.<pid>.partial')` from `node:sqlite` (online backup API; `doctor` warns when a Node build
   lacks it, Node 22.16+ has it). The staging name carries the process id, so `npm run backup` in the same minute as
   the server's own backup never writes into the other's file (both finish; the second rename wins, and both copies are
   consistent).
2. The copy is switched from WAL to `journal_mode = DELETE`, so it is one self-contained file that opens anywhere
   without growing `-wal`/`-shm` files, then `PRAGMA quick_check` must say `ok`.
3. Only then is it renamed to `linear-YYYY-MM-DD-HHmm.sqlite` (Europe/London wall clock, from `Intl`, so the process
   TZ does not matter). A failed or half-written copy never carries the name. Two backups in one minute: the second
   replaces the first.
4. The app-secret is copied to `<dir>/app-secret` (mode 0600, written to a temp file and renamed) only when it is
   missing there or different. Skipped when `LM_APP_SECRET` is set (the key is not in a file).
5. `meta.last_backup_at` (ISO) and `meta.last_backup_file` are upserted. Nothing else is written; no gauge row, no
   payroll row.
6. Rotation runs. A second call while one runs for the same database shares the running one; shutdown waits for it
   before closing the database. (Node 26.8.1 can leave the copy's completion unprocessed until something else wakes the
   event loop — a 30 s stall was measured under the test runner — so a 25 ms ref'd tick runs while the copy is in
   flight. Node 22.22 does not show it.)
7. The backup folder is created with mode 0700. Backups run on the **real** clock: a pinned `LM_BUSINESS_NOW` never
   changes their names or the schedule.

**Rotation** (`planRotation(names, today)`, `today` = London date)
- Day window: `today − 29 … today` (30 days). The newest file of each day in it is kept.
- Week window: the 8 ISO weeks (Mon–Sun) going back from the week that contains `today − 30`. In each, the newest file
  dated before the day window is kept.
- The newest file overall is always kept (so a laptop unused for months never loses its last copy).
- `rotate` never deletes a file written (mtime) in the last **24 hours**, even when a newer one replaces it for that
  day: after a mistake at 10:50, a panicked `npm run backup` at 11:00 must not delete the good 02:00 copy from the same
  morning. It goes at the first rotation a day later.
- Only names matching `^linear-YYYY-MM-DD-HHmm\.sqlite$` (valid month, day, hour and minute) are ever deleted as
  backups; `app-secret`, `linear.sqlite`, `*.bak` and anything else are left alone.
- Staging files a killed backup left behind (`.linear-….sqlite[.<pid>].partial`, with any `-wal`/`-shm`/`-journal`)
  are deleted once they are **1 hour** old (mtime); younger ones may belong to a backup running in another process.

**Schedule** (`scheduleBackups`, unref'd timers, every failure logged and retried at the next check)
- Start-up: after 10 minutes, back up if `lastAt` is null or ≥ 24 h ago.
- Hourly: back up if the London hour ≥ `LM_BACKUP_HOUR` (default 2) and the London date of `lastAt` is not today.
- `LM_BACKUP=0`: no timers (logged at start-up); `npm run backup` still works.

**Restore** (`restoreDatabase`, `npm run restore -- <file> [--yes]`)
1. Refuse while the live database is open in another process, on whatever port or address that server listens
   (`databaseInUse`: open the file with busy timeout 0, `PRAGMA locking_mode = EXCLUSIVE`, `BEGIN EXCLUSIVE`; a running
   server keeps a WAL connection open, which holds a shared lock, so this fails with SQLITE_BUSY: "The database is open
   in another process, so it was not touched", plus the pid and command `lsof` reports, and "Stop it first, with the
   PORT it runs on"). Any other error opening it (a damaged file) is not "in use". Then, as an extra hint, refuse while
   `findPortHolder(PORT)` finds anything ("Linear Hub is running on port N … Stop it first: npm run stop"). When a
   service file is installed either message adds "npm run service:uninstall first".
2. Refuse a missing file, the live database itself, or a file without the SQLite header.
3. Copy the candidate to a private staging file next to the database (`<db>.restoring-<time>`; a raw copy of a live
   WAL database has its `-wal` folded in). The backup itself is never modified.
4. Open the staging copy read-only: `PRAGMA integrity_check` must return exactly `ok` and the tables `users, teams,
   pay_plans, campaigns, events, gauge_entries, payroll_runs, meta` must exist; otherwise refuse and delete staging.
5. Print current v backup: users, gauge entries, payroll runs, latest gauge date.
6. Ask (`--yes`, or a typed `y`/`yes` in a terminal; no terminal and no `--yes` = cancel).
7. Check the lock and the port again, move `<db>`, `<db>-wal`, `<db>-shm`, `<db>-journal` to
   `<db>.before-restore-<YYYY-MM-DD-HHmmss>` (+ suffix), rename staging to `<db>`.
8. Key (the app secret: it encrypts two-step secrets and, since 1.2, peppers every PIN; `restoreKeyNotes`): if
   `<backup folder>/app-secret` exists and the live key file is missing, install it (0600); if both exist and differ,
   change nothing and say so, as a warning naming how many people have a peppered PIN (`pin_hash` starting
   `scrypt-hmac$`; 1.2.0's bare `scrypt$` hashes do not depend on the key) or two-step sign-in, with the fix (put the
   backups folder's copy next to the database). If neither exists (and `LM_APP_SECRET` is not set) and the restored
   database has people with a peppered PIN or two-step sign-in, warn: a right PIN gets "That PIN is not right" (and
   locks after ten tries) and two-step codes fail until the kept `app-secret` is put next to the database; if it is
   lost, PINs are reset (`npm run pin:reset -- <email>` for an administrator, then Reset PIN), and two-step users use
   a recovery code and an administrator resets their two-step sign-in (Team › Edit › Reset two-step verification).
   Nobody depending on the key: nothing is said.

**Health status for admins** (`GET /health` → `backup`): `count` = matching files in the folder; `lastAt`/`file` from
meta unless the newest file is more than a minute newer (after a restore the meta table is the backup's own, older
record); `enabled` = the schedule this server started with.

**Warnings** (Settings › Backups and `npm run doctor`)
- Stale: last backup more than **36 h** ago → amber card / doctor `▲`.
- No backup yet: Settings shows a neutral "None yet — the first runs 10 minutes after the server starts" until the
  install is 36 h old, then amber; doctor shows `ℹ` (info, not a warning) for an install seeded under 24 h ago, else
  `▲`. `LM_BACKUP=0` always makes the doctor line a warning.
- Schedule off (`backup.enabled === false`): the card reads "Automatic backups are off on this server." with an amber
  **Off** badge (instead of **Up to date**), an amber box says "Automatic backups are off (LM_BACKUP=0)" and points at
  `npm run backup`.
- Disk: free space on the backup folder's disk under **1 GB** → `▲`.
- Service: the installed plist/unit runs a Node that no longer exists, or a different one from this terminal → `▲`
  ("run npm run service:install again"). With the service installed and answering, the doctor's port check passes
  ("held by Linear Hub running as the background service") instead of failing.

**Service files** (`server/src/service.ts`)
- Label `uk.co.linear-mcr.hub`; `ProgramArguments [node, <abs>/server/src/index.ts]`; `WorkingDirectory server/`;
  `EnvironmentVariables` `TZ=Europe/London`, `NODE_ENV=production`, `NODE_NO_WARNINGS=1`, plus when set: `PORT`,
  `HOST`, `DB_PATH`, `LM_APP_SECRET_FILE`, `LM_BACKUP`, `LM_BACKUP_DIR`, `LM_BACKUP_HOUR`, `TRUST_PROXY`, `LM_SMART`,
  `LM_COMPRESSION` (relative paths resolved from `server/`, as `npm start` resolves them). `LM_APP_SECRET` is never
  written into the file (it would sit there in plain text): install warns and suggests `LM_APP_SECRET_FILE`.
- `node` is `process.execPath`, except a Homebrew Cellar path (deleted by the next `brew upgrade`) becomes its stable
  `<prefix>/opt/node/bin/node` link when that link points at the same binary.
- Install (macOS): refuse without `client/dist/index.html` ("run npm run build first") → `bootout` an earlier install
  → run `src/stop.ts` for a terminal copy (abort if the port is held by something else) → write the plist and create
  the log folder → `launchctl enable`, `bootstrap gui/<uid>` (fallback `load -w`) → wait up to 20 s for `/api/health`.
- Uninstall: `bootout` (fallback `unload -w`), delete the plist, wait for the port to free. Status: `launchctl print`
  (state, pid, last exit code, runs), health, Node check, last 20 log lines.
- Linux unit: values quoted for systemd (`\` and `"` escaped and `%` → `%%` everywhere; `$` → `$$` only in
  `ExecStart=`); `Restart=always`, `RestartSec=2`, `WantedBy=default.target`. `systemd-analyze verify` accepts the
  printed unit.
- macOS privacy (TCC): install (and `--print`, as a `# warning:` line) and status warn when the checkout, `DB_PATH`,
  `LM_BACKUP_DIR` or `LM_APP_SECRET_FILE` resolves (as written or through links, ignoring case) into `~/Desktop`,
  `~/Documents`, `~/Downloads` or `~/Library/Mobile Documents` (iCloud Drive). Install still goes ahead.
- Windows: the printed `.cmd` creates `%LOCALAPPDATA%\LinearHub` before redirecting the log there.
- `npm run service:install -- --print` (optionally `--platform=darwin|linux|win32`) is a dry run: it prints the file
  and the commands and changes nothing. The printed files for all three platforms are covered by
  `server/src/test/service.test.ts`.

**Compression** (`server/src/lib/compress.ts`, mounted first in `app.ts` after the security headers)
- `gzip` (level 6) for JSON, HTML, JavaScript, CSS and SVG responses of **1 KB or more** when `Accept-Encoding` allows
  it; `br` (brotli quality 4) only when the client **prefers** it (ranks `br` above `gzip` with q-values, or accepts
  only `br`). Browsers send `gzip, deflate, br, zstd` without q-values and get gzip: brotli at quality 4 is no smaller
  than gzip 6 here and costs more CPU.
- The body is collected and compressed in one piece, so `Content-Length` is exact; bodies up to 16 KB are compressed
  synchronously, larger ones on the libuv thread pool.
- Compressed bytes are remembered in two small LRUs keyed by encoding, path and ETag: immutable `/assets/*` bundles
  (64 entries / 12 MB) and everything else with an ETag (512 entries / 4 MB). An equal key means equal bytes, so a
  response-cache replay or the same JSON fetched again is not compressed twice, and nobody can be sent bytes other than
  the ones the route produced for them. Nothing is precompressed at build time.
- Measured on the wire (Chrome's `Accept-Encoding`): the SPA shell 2,112 B → 908 B (57% saved), the main JS bundle
  449,035 B → 138,725 B (69%), an admin `/api/me/dashboard?range=week` 6,302 B → 2,250 B (64%). Under the 50-connection
  load mix (`server/loadtest/mix.mjs`) compression-specific work is about 2% of the server's busy time.

### 14.11 What loads when: the client bundle (lead decision)

The smart release grew the main JS chunk from 445 kB to 511 kB (gzip 137 → 158 kB) and Vite warned about it. Measured
with `npm run build` (minified, before gzip):

| | main chunk | gzip | Vite warning |
|---|---|---|---|
| 1.0 (before the smart release) | 445.3 kB | 137.6 kB | no |
| after p2–p8 and p10 were merged | 510.8 kB | 158.3 kB | yes (> 500 kB) |
| 1.1.0 | 432.8 kB | 134.5 kB | no |

- **Global, in the main chunk** (needed on every screen): the bell (`NotificationsBell` and the item pieces it shares
  with the dashboard card, `features/smart/AttentionRow.tsx`), the gauge outbox (`OutboxBanner`, `outbox.ts`) and the
  offline banner. `OutboxBanner` formats its few dates itself, so it does not pull date-fns and `lib/format` (27 kB)
  into the main chunk; its text is unchanged ("14 Oct", "saved Sun 18 Oct, 14:02").
- **Dashboard-only smart components load on demand** (`React.lazy` + `Suspense`), all in one small chunk
  (`features/smart/dashboardSlots.ts`, 17.3 kB, gzip 5.6 kB) fetched after the dashboard page: `AttentionCard`,
  `BaselineNote`, `WeekPayStrip`, `TeamCoaching`, `CheckInList` and `WeekInReview`. Pages use the wrappers in
  `features/smart/lazy.tsx` (`LazyAttentionCard`, …). While the chunk arrives each slot shows a quiet placeholder
  shaped like what it will render (the card's own h-14 loading line, a strip-sized block), or nothing when the slot
  would render nothing anyway (no data yet, `LM_SMART=0`). Every slot keeps its own ErrorBoundary, so a chunk that
  cannot be fetched blanks only those slots: the KPI tiles and the rest of the page stay.
- **Finance-only**: the sticky bulk-pay bar (`features/finance/BulkPayBar.tsx`) loads the first time an admin selects a
  run, through `LazyBulkPayBar` (`bulkPay.tsx` keeps `useBulkMarkPaid`, the helpers and `FlaggedRunsList`); a rep on
  **My pay** never downloads it.
- **The tally**: the full-screen counter (`features/gauges/TallyMode.tsx`) loads the first time it opens, through
  `LazyTallyMode`; the light entry points (`TallyButton`, `TodayTallyLink`) live in `TallyLinks.tsx`.
- **Quick gauges** (`pages/QuickGauges.tsx`) is its own page chunk. It shares a small `useTallyCounter` chunk with
  `TallyMode`. The sidebar's stop-count pill puts `tallyStore.ts` in the main chunk (imported by file path). Its day is
  worked out with `localDayISO()`, not `lib/dates`, so date-fns stays out of the shell. The shell fetches the page's
  chunk on idle after sign-in (see Quick gauges, §14.7), through a dynamic import, so it stays out of the main chunk.
  Cost: main chunk 432.8 → 439.2 kB (134.5 → 136.4 kB gzip).
- `EventForecastChip` is 2.3 kB and renders inside every event row, so it stays where it is.
- Lazy-loading the smart components alone brought the main chunk to 481.6 kB, still over the 460 kB target, so the
  **sign-in page** and **About** are split too: someone already signed in, the usual case on a phone, never downloads
  the sign-in page (15 kB), and About (8 kB) is rarely opened. The sign-in page loads behind the same full-page spinner
  as the session check.
- Rule for later work: import a dashboard- or finance-only component through its `Lazy…` wrapper, never directly and
  never through a barrel that re-exports it, or it moves back into that page's chunk (or the main one). Measure with
  `npx vite build --sourcemap` and a source-map breakdown of `dist/assets/index-*.js`.

## 15. Release 1.2

Learning (the COD pack and campaign pitches) and field and office upgrades. The foundation (r2-foundation) laid down
the contracts each package fills: database extensions run by `createSchema` and the seed (`server/src/db/extensions`),
shared types (`shared/src/types/*.ts`) and pure logic modules (`shared/src/logic`), stub routes, client pages and
slots. Every new payload is built from data the caller may already see; nothing in 1.2 creates a gauge row or a
payroll run as a side effect.

### 15.0 Database extensions (`server/src/db/extensions/`)

Each package with tables owns one file exporting `export const extension: DbExtension = { name, sql, upgrade, seed? }`
(contract in `extensions/types.ts`): `learning.ts` (L1), `pitches.ts` (L2), `pin.ts` (U1), `audit.ts` (U3),
`checkins.ts` (U4). `extensions/index.ts` (foundation) lists them in the fixed order learning, pitches, pin, audit,
checkins.

- `createSchema(db)` runs the core schema and core column upgrades, then for every extension its `sql`
  (`CREATE TABLE IF NOT EXISTS …`) and `upgrade(db)`. It returns the core column names followed by the extensions'
  changes as `<extension>:<name>` (e.g. `pin:users.pin_hash`). A second run returns `[]`. The smoke test's schema
  upgrade check compares core columns only (names without a colon).
- `upgrade(db)` adds columns to existing tables with `addColumnIfMissing(db, table, column, ddl)` and runs one-off data
  steps an already-seeded database needs, guarded with `metaFlag` / `setMetaFlag` (`ext:<name>:<step>`).
- **Order on a fresh install.** `index.ts` and `resetAndSeed` both call `createSchema(db)` before `seed(db)`, so on a
  new database every `upgrade()` runs on EMPTY core tables (no users, campaigns or events yet) and `seed()` runs
  after. A data step in `upgrade` therefore skips, without setting its meta flag, when the rows it needs are missing
  (L2: no BCN campaign yet), and sets the flag only after it has run against them; writes with `INSERT OR IGNORE` /
  `ON CONFLICT DO NOTHING` on a unique key so it never conflicts with `seed()`; and reports a name only when it
  actually inserted or changed rows, so the first restart after a fresh seed returns `[]`. Rows that both an existing
  and a fresh database need (the BCN pitch) go in both `upgrade` and `seed`.
- `seed(db, ctx)` runs at the end of a fresh demo seed, inside the seed transaction, after every core row exists.
  `ctx` (`SeedContext`): `today`, `nowIso`, `users`, `teams`, `campaigns` (with `code`, e.g. 'BCN'), `events`, and
  `rng(salt)` — a random stream of the extension's own, so the core demo data stays byte-for-byte the same: never
  insert, update or delete a row of a core table (an extension may write its own `ext:%` keys in `meta`). Never
  insert gauge rows or payroll runs.

### 15.1 Learning pack: COD pack lessons, the Learn / Teach checklist and the progression tracker (L1)

`shared/src/logic/learning.ts` and `learningQuiz.ts` (pure, tested in `learning.test.ts` and `learningQuiz.test.ts`):

- **Lesson state** (`lessonStateOf`): signed off → `taught`; a written teach-back → `teachback_sent`; the self-check
  passed → `learned`; else `new`. A sign-off counts even with nothing written (the leader heard it at the whiteboard).
- **A sign-off also counts as learned**: signing off a lesson that is not learned yet sets `learned_at` to the
  sign-off time (the answer says `markedLearned: true`), so the checklist never shows Teach ✓ with Learn ☐.
  `quiz_passed_at` (`quizPassedAt`) records the first pass of the self-check and is never cleared, so "passed" does
  not depend on the last score. `selfCheckPassed(row)`: `quizPassedAt` is set (or, for a row without it, the last
  score passes). `learnedBySignOff(row)`: learned and the self-check never passed, so a sign-off counted it (the
  checklist says "Learned …, at the sign-off"). **Withdrawing the sign-off** (`withdrawTakesBackLearned(row)`, the
  same rule in the route's SQL) takes "learned" back only when the sign-off was the only reason for it: `learned_at` is
  the sign-off time, the self-check was never passed and no teach-back has been written since. A self-check passed at
  any point (before or after the sign-off, whatever a later retake scored) keeps it learned, and so does a teach-back
  written after the sign-off: the teach-back stays, waiting for a sign-off, and since a teach-back can only be written
  on a learned lesson the row never shows "teach-back sent" with Learn ☐. The withdraw dialog says which of these
  applies. On every start the learning extension's `upgrade` repairs any older row signed off without `learned_at`
  (learned at its sign-off time); a no-op once done. The same `upgrade` adds `quiz_passed_at` to a table made before
  it and, only on that step, fills it in from the older rows: `learned_at` when it was not the sign-off time (a pass
  set it) or when the last score passes.
- **Self-check, graded by the server** (`gradeQuiz(lessonKey, answers)`): the phone sends the option picked for each
  question (0-based) and the server marks them against `QUIZ_ANSWER_KEY`; a score sent by the phone is refused (400).
  Every question must be answered (else 400 "Answer all 3 questions"). Learned only when every answer is right
  (`quizPassed`: `score === total`, total ≥ 1). The first pass sets `learned_at`; a later retake records the new score
  but never takes "learned" or the pass (`quiz_passed_at`) away. The answer says which questions were right (`correct`, one boolean per question),
  never which option is right: after a miss the page marks only the options picked (right or wrong) and says
  "Have another look at question 2 in the lesson"; the explanations show once all three are right. **Try again** keeps
  the right answers and clears the wrong ones. The two practical tasks ("Run an impact", "Go on a roadtrip") have no
  questions: **I've done this** sends no answers and records 1 of 1.
- **Answer key** (`QUIZ_ANSWER_KEY`, `quizQuestionCount`): the right option per question for each lesson, a copy of the
  `answer` written next to each question in `client/src/content/learning/*.ts`. `learningQuiz.test.ts` loads the
  lessons (Node runs them with the types stripped, which is why those files import with `.ts` extensions) and fails if
  the two ever differ, so a question's options and its answer are always changed in both places.
- **The answers are not secret, by design.** The lessons ship to the phone with each question's `answer` and its
  explanation (`why`, which names the right option in most questions), so anyone who opens the browser's developer
  tools can read them, and `correct` lets a person find every answer in a few tries. Server grading stops one thing:
  marking a lesson learned by sending a made-up score. The self-check is a learning aid; the check that counts is the
  teach-back, read or heard and signed off by a leader. (The grading code itself, `gradeQuiz`, is not in the client
  bundle; the answer data is.)
- **Groups** (`LESSON_GROUP_OF`, `LESSON_GROUPS`): the pack checklist's blocks — fundamentals (5 steps, working habits,
  law of averages, impulse factors), in the field (green light, gumball + ABC days, can / can't controls, buying signs,
  strategic pause, pre-emptive strike), attitude (bamboo, attitude regain + attitude muscle), objections (bullet
  theory, straight line theory), leadership (3 core principles, pre- and post-management criteria, direct vs indirect,
  assuming the role, theory of teachback) and tasks. Checklist rows that share a lesson: ABC days → gumball theory,
  attitude muscle → attitude regain, pre- / post-management criteria → progression structure.
- **Career level from position** (`careerLevelFor`): trainee and field rep → entry level; team leader → leadership;
  crew leader → campaign manager; assistant owner → assistant director; owner → senior director; recruiter → none (the
  office sits outside the field ladder). The ladder continues to promoting owner, regional and national consultant.
- **Progression** (`progressionFrom`, rules in `PROGRESSION_RULES`): the server gathers the person's own sales and their
  current team's sales per Mon–Sun week for the last **12 weeks** (this week so far last, rows dated up to today, one
  grouped query), their learned / taught counts and the office's ticks. A requirement is met when **any** of its
  options is; the next level needs **every** requirement.
  - Entry → leadership: **sales** — 14 sales in any one week of the window, **or** 12+ in two consecutive weeks;
    **learn the COD pack** — 21 of 21 learned; **teach it back** — 21 of 21 signed off.
  - Leadership → campaign manager: **3 people trained from entry level to leadership** — met by either the active
    people on their team (other than them) at Team Leader or above (an approximation: there is no promotion history),
    or the count the office confirms; **prove you can train different personalities** — office tick.
  - Campaign manager → assistant director: **"4 + 1 or 3 + 2"** — office tick; **team generates 100 sales two weeks
    in a row** — two consecutive weeks of 100+ sales logged by everyone on their current team (no team → not met, "No
    team yet"); **show consistency** — office tick.
  - Assistant director → senior director: team is profitable, you're ready (office ticks). Senior director → promoting
    owner: mentor someone to their own office. Then 4 first-generation offices and a £50,000 wire 4 weeks running; 7
    offices and £75,000 8 weeks running (office counts and ticks).
  - Details carry the numbers: "12 of 14 sales this week; best recent week 13", "Reached: 15 sales the week of 5 Oct",
    "Last week 8, this week 12 of 12 sales", "Reached: 12 then 13 sales (weeks of 5 Oct and 12 Oct)", "2 of 3
    confirmed by the office". Option progress (`current` / `target`): this week's sales; the run of qualifying weeks
    (0–2) ending this week, or last week while this week is still short.
  - **Headline** (the dashboard card): unmet data requirements first, then the office ones, at most two phrases:
    "Your next level: 12 of 14 sales this week; 9 of 21 lessons learned" (a leader looking at someone reads "Next
    level: …"). Everything met: "Every criterion for Leadership is met: time to talk about the step up." Top of the
    ladder: "You're at the top of the ladder: …". Recruiters: "Recruiters sit outside the field ladder; every lesson is
    still open to you." Deterministic; never NaN / undefined.
- **Kill switch**: the tracker is a smart builder. With `LM_SMART=0`, `GET /learning/progression` answers the level and
  next level with `requirements: []`, `weeks: []`, `headline: ''`, `enabled: false`; the dashboard card hides and the
  Progress page says the tracker is switched off. Lessons, self-checks, teach-backs and the checklist keep working.

Content (`client/src/content/learning/*.ts`): every lesson keeps the pack's wording and adds nothing the pack does
not say; only obvious typos are fixed (excitment, consolodation, uou / omn, sgns, postitve, garuntee, arrises, minimim,
politcs, compeition, dependant, liason, comission, buyers remorse → buyer's remorse, footflow → footfall, and the
consolidation step printed as "3."). Where the pack is too short to stand alone, the lesson says so and sends the
person to their leader instead of explaining it: "SW3 = N is usually read as “some will, some won’t, so what… next”:
check with your leader"; the law of averages keeps its numbers as printed ("00/50/40/30/10 = 3–5") with "Ask your
leader to walk you through the pack's numbers for your campaign"; "Run an impact" and "Go on a roadtrip" (listed on
the checklist, never described) say "The COD pack lists this task but does not describe it" and invent no steps. One
deliberate change of the pack's words: **Assuming the role** has one dress code for everyone ("A professional image in
the office: smart and well presented, for example a clean ironed shirt and tie, or equivalent smart office wear")
instead of the pack's separate rules for women and men (heels, makeup), as UK guidance on equivalent dress codes
expects. The app's own sentences write "teach-back"; the pack's names keep "teachback" (the lesson title, "3 rules of
the teachback"). The pack prints no overturn for **direct debit**; the lesson says so and asks for the campaign's own.
The illustrations are cropped from 220 dpi renders (white turned to transparency, framed panels kept opaque, 7–67 kB
each, 360 kB in all; all 14 are used, the single bullet beside C.O.W.S as on page 15) into `client/public/cod-pack/` —
not `public/learning/`, because a folder named like the `/learning` page makes the production server redirect
`/learning` to `/learning/` on a reload. Section anchors match `LESSON_ANCHORS`
(`/learning/pack/bullet-theory#no-time`), so L2's annotation chips and the field cards land on the right part.

### 15.2 Pitch studio: campaign pitches, annotations and practice modes (L2)

Pure, in `shared/src/logic/pitchScript.ts` and `shared/src/logic/pitchAnnotations.ts` (tests in
`shared/src/logic/pitchScript.test.ts`, on the owner's BCN pitch word for word and on synthetic scripts).
The modules have no top-level calls, so the client bundles them with the pitch page only (main chunk unchanged).

#### Script format (`parsePitchScript(body)` → `PitchScript`)

Plain text, one spoken line per line; a blank line separates paragraphs (`break` blocks, never two in a row, none at
either end). Line numbers are the 1-based source lines.

- A line that is only brackets is a **stage direction** (`direction` block): `(Slow smile and cautious)`.
- `(Pause)`, `(Pause - 1 Second)`, `(Pause 2s)`, `(Long pause)`, `(Pause for effect)` is a **pause beat** (`pause`
  block); its length is the first number (seconds), or null (counted as 1 s, `PITCH_DEFAULT_PAUSE_SECONDS`).
- `(Name)` is the person's **name slot**; `(Close)` is the **close marker**.
- Brackets inside a spoken line become inline segments in order (`text`, `name`, `close`, `pause`, `direction`):
  `Pretty amazing right!! (Close)` → text + close; `… have you got some for me? (Smile and laugh)` → text + direction.
  An unbalanced bracket stays text.
- `(Introduction)`, `(Short story)`, `(Presentation)`, `(Consolidation)` (or `(Step 3: presentation)`) on its own line
  **starts that step**; the page shows a step heading instead of the direction (`stepMarker`). A lone `(Close)` line is
  a close beat and starts the close step.
- A line starting **`Yes -`** or **`No -`** (also `Yes:`, en/em dash; never `No-one`) starts a **branch** for the
  answer to the previous question (`branch` block with `question` = the last spoken line, `branches` Yes/No). A branch
  runs until the other answer's line, or until an end line `(Both)` / `(Back to the pitch)` / `(End of branch)` (not
  shown). The last branch otherwise ends at the end of its first paragraph. The same answer again starts a new
  question's branches. Text after `No -` on the same line is the branch's first line.

#### Steps and timing

- The five steps of the COD pack (`PITCH_STEP_TARGETS`): Introduction 7–10 s, Short story 10–15 s, Presentation,
  Close, Consolidation (no set time for the last three).
- Each spoken line is tagged with a step. The first spoken line is always the Introduction. After that a step starts at
  an explicit marker, or at a cue (`PITCH_STEP_CUES`): Short story at "what we do", "who we are", "we're from", "we
  help/support/fund/provide/raise"; Presentation at "survival rate", "as of 19xx/20xx", "since 19xx/20xx", "the
  problem", "the solution", "unfortunately", "obviously"; Close at the `(Close)` marker, "I'm sure we can count on",
  "can we count on", "shall we get you", "let's get you signed up"; Consolidation at "welcome call", "welcome pack",
  "thank you for signing/joining", "at least 2 years". **Cues only move forward**: a later "unfortunately" never takes
  the close back to the presentation. Branches start at the step before them; after them the furthest step wins.
- Read-aloud estimate: words at **150 words a minute** (`PITCH_WORDS_PER_MINUTE`; numbers count as words, emoji and
  punctuation do not) plus every pause, along the **longest path** (per Yes/No question only the longer branch).
  `steps[]` gives each step's whole seconds, spoken lines and first line; `estimatedSeconds` the total;
  `lineCount`/`wordCount` count every spoken line with words (both branches).
- `pitchStepVerdict(seconds, target)`: `under` / `within` / `over` against the target (inclusive), `none` without a
  target or when the step is empty.
- The seeded BCN pitch: 19 spoken lines; Introduction (lines 1, 4, 9) about 22 s, Short story (from "What we do",
  line 11, through the Yes/No and "Our mission") about 25 s, Presentation (from "As of 1980", line 24) about 14 s,
  Close (from the owner's "(Close)" on line 28) about 52 s, no Consolidation: about 1 min 52 s in all. The page shows
  the introduction and short story as "Longer than 7–10 s" / "Longer than 10–15 s" (an estimate; the step timer
  measures the real thing).

#### Annotations (`PITCH_ANNOTATION_RULES`, `annotatePitchLine`)

Phrase patterns → the COD pack theory, a one-line why and the L1 lesson it links to
(`/learning/pack/:lessonKey#anchor`; every key and anchor is checked against `LESSON_KEYS` / `LESSON_ANCHORS`).
Matching is case-insensitive on the line as written (brackets included), with curly quotes straightened; a theory
appears once per line, in rule order.

| Chip | Matches (examples) | Lesson |
| --- | --- | --- |
| Hook | a line opening "Over/Nearly/About 1000 …", "every 43 minutes" | five-steps#introduction |
| Strategic pause | `(Pause …)` | strategic-pause |
| Pre-emptive strike | "I know that's …", "I know you're …", "I can see you're …" | pre-emptive-strike |
| Indifference | "no pressure", "take it or leave it" | impulse-factors#indifference |
| Short story | "what we do", "who we are", "our mission", "why we are here" | five-steps#short-story |
| Problem and solution | "survival rate", "our goal", "this close" | five-steps#presentation |
| Close | `(Close)` | five-steps#close |
| Buzzwords | "unfortunately", "obviously", "however" | five-steps#presentation |
| Past tense | "said they'd love", "who have stopped" | five-steps#presentation |
| Group effect | "people like yourself", "everyone", "we all", "as well" | impulse-factors#group-effect |
| Greed | "something small", "wouldn't miss", "a few quid", "a tenner", "£10 a month" | impulse-factors#greed |
| Power of suggestion | "I'm sure" | impulse-factors#power-of-suggestion |
| Fear of loss | "I would need to check", "if you qualify" | impulse-factors#fear-of-loss |
| Qualifying question | "You live/bank in the UK", "over the age of", "cheeky question" | impulse-factors#fear-of-loss |
| Consolidation | "welcome call", "at least 2 years" | five-steps#consolidation |
| Smile (directions only) | a stage direction with "smile" | five-steps#introduction |

#### Fact-check notes (`parsePitchFacts(facts, body)` → `PitchFact[]`)

- One note per bullet (`- `, `* `, `• `, `1.`); wrapped lines join their bullet; without bullets each paragraph is a
  note.
- Leading quotes (`"…"` or `“…”`, several joined by "and") are what the note is about (`quotes`, `quote` = the first);
  the note is the rest after the colon. URLs become `sources` and leave the note ("Source:" and empty brackets go
  too); `Suggested wording: "…"` becomes `suggestion`. The first letter is capitalised.
- `tone`: `info` without a quote (a general note), `verified` when the note starts "Matches", "Confirmed", "Correct",
  "Verified", "Accurate" or "True", else `check`.
- `lines`: the body lines a quote matches, ignoring case, punctuation, apostrophes and emoji; `...`/`…` in a quote
  stands for left-out words (fragments in order); a quote may span up to three lines.
- The script itself is never changed to match a note: the notes sit beside it ("Check the figures"), and the office
  approves final figures (the BCN general note quotes the Fundraising Regulator's code).

#### Flashcards (`pitchCards(script)`)

One card per spoken line with words, in reading order: the cue is the line said just before (a branch line's cue is
the question, never the other branch), branch lines carry their answer. Keys are `pitchLineKey(text)` (FNV-1a of the
straightened, lower-cased words, base 36; `:2`, `:3` for repeats), so editing one line resets only that card.
Progress lives on the device: `localStorage['lm-pitch-memorise:<userId>:<CAMPAIGN>'] = { v: 1, known: [keys] }`
(every storage call wrapped). Other per-device choices: `lm-pitch-mode`, `lm-pitch-theory`, `lm-pitch-prompter-wpm`.

### 15.3 Sign-in PIN, stronger sessions and the deploy guide (U1)

**Hashing** (`server/src/lib/pin.ts`). The PIN is first peppered: HMAC-SHA256 of the PIN under a key derived from the
app secret (`LM_APP_SECRET`, else the `app-secret` file next to the database; `deriveAppKey('pin-pepper')` in
`lib/crypto.ts`, a separate key from the one that encrypts two-step secrets). That digest goes through scrypt from
`node:crypto`, N = 2^14, r = 8, p = 1, a fresh 16-byte random salt, 32-byte key, stored as
`scrypt-hmac$16384$8$1$<salt>$<key>` (base64) so the cost can be raised later without a migration. It runs on the libuv
thread pool (no event-loop stall) and is compared with `timingSafeEqual`. A malformed PIN or hash is a mismatch.
Nothing logs or returns a PIN or hash.

Why the pepper: a PIN has at most a million values, so scrypt alone (about 40 ms a guess) lets anyone holding a copy of
the database try every 4-digit PIN in minutes. The secret never sits in the database, so a copy of the database file
**on its own** cannot be tested at all. Whether a backup is protected depends on where the key lives:
- `LM_APP_SECRET` set: Linear Hub never writes the key to disk, so its backups do not hold it and are protected too.
- the `app-secret` file (the default): the built-in backups folder keeps a copy of it next to the database copies
  (§14.10, so a restore on a new laptop keeps two-step and PINs working). Whoever has that whole folder can still try
  every 4-digit PIN in minutes, so the folder must be kept private (or only leave the machine encrypted, like the
  rclone `crypt` remote in DEPLOY.md) as a whole, exactly like the key itself.

1.2.0 stored `scrypt$…` (no pepper); those still verify, and the next right PIN at sign-in replaces the hash with a
peppered one (`pin_set_at` unchanged; a compare-and-swap, so a PIN changed meanwhile is never overwritten).
**Back up the app secret with the database**: for the `app-secret` file the backups folder does it; keep
`LM_APP_SECRET` in a password manager. If it is lost, no PIN matches any more: each person's PIN must be reset
(`npm run pin:reset -- <email>`, or the admin reset for everyone else once an admin can sign in). `npm run restore`
warns when the restored database has peppered PINs and there is no key, or a different one (§14.10).

**PIN rules** (`shared/src/logic/pin.ts`, the same on the phone and the server, checked in this order):
`format` 4–6 ASCII digits → `repeated` one digit only (0000, 777777) → `sequence` a run up or down by one (0123, 9876,
543210; 7890 is not a run) → `common` one of 27 most-guessed PINs that the first rules miss (1212, 1004, 2000, 6969,
2580, 123123, 159753, …) → `employee-id` the PIN contains, or is contained in, the digits of your employee ID when
they are at least four long (LM-0042 refuses 0042 and 004299). The first broken rule's message is the refusal.

**Sign-in with a PIN.** After the email and employee ID match (and the account is not `left`):

1. The PIN is locked (`pin_locked_until` is in the future, real clock) → `423 locked`, whatever was sent, and not
   counted towards the PIN count (counted against the login limiter).
2. No PIN sent → `200 { requiresPin: true, attemptsLeft }`, no cookie (counted against the login limiter, so the
   answer cannot be used to test email and employee ID pairs faster than a wrong ID).
3. Otherwise the attempt is counted **before** the hash is awaited — a login-limiter failure and `pin_failed_attempts + 1`
   — so a burst of parallel guesses meets both limits one request at a time. A right PIN resets the count and the lock
   (and the login counters once the sign-in completes, after the two-step code if the account has one); a wrong one
   answers `401 wrong` with `attemptsLeft = 10 − (count mod 10)`, or `423` when the count reaches a multiple of 10.

**The PIN lock** (`pinLockMinutes`). It ends by itself. When the count of wrong PINs in a row reaches 10, 20, 30 … the
PIN locks for 15 minutes × 2^(count ÷ 10 − 1), at most 24 hours: 10 → 15 min, 20 → 30 min, 30 → 1 h, 40 → 2 h,
50 → 4 h, 60 → 8 h, 70 → 16 h, 80 and beyond → 24 h. The count survives the end of a lock (that is what doubles it) and
is only reset by a right PIN, an admin reset, `npm run pin:reset` or setting a new PIN. The end is stored in
`users.pin_locked_until` (real clock, like sessions and the limiters; the business clock never moves it). Wrong current
PINs in Settings (change or remove your PIN) count towards the same lock, plus 6 per user in 15 minutes → `429`.

Every `423` says when it ends: "Too many wrong PINs. Try again after 14:35, or ask an administrator to reset your PIN."
The time is the London wall-clock minute the lock ends, rounded **up** (so trying at the time shown always works), with
"tomorrow" when it ends on the next London day, and "on 23 Oct" in the rare case rounding carries it past that.
`details.lockedUntil` and `PinStatus.lockedUntil` carry the exact instant.

An administrator cannot reset their own PIN in the app (`400`, which now names the way out: wait for the time shown,
or run `npm run pin:reset -- <their email>` on the server). That command (`server/src/pinReset.ts`, honours `DB_PATH`)
clears one person's PIN, count and lock, signs them out on every device and writes an audit row (no person, action
`npm run pin:reset`, "Reset PIN from the server command: …"). Someone with no PIN gets "nothing to reset" and no audit
row. Exit code 1 for no email, no database or no such person. It works while the server runs (one small write,
`busy_timeout` 5 s). A PIN locked by 1.2.0 (10 or more wrong) gets an ordinary lock ending 15 minutes after the upgrade.

**Login rate limits** are the login's own: 8 failures per (source address, email) in 15 minutes, 20 per email from
anywhere, then `429`. The source is the TCP peer, or `req.ip` when `TRUST_PROXY` is set: Express then reads
X-Forwarded-For through the trusted hops only, so behind the reverse proxy of DEPLOY.md each client has its own count
instead of everyone sharing the proxy's. Without `TRUST_PROXY` the header is ignored, so it cannot be forged to dodge
the limit. The same source keys the two-step code limiter.

Worked example: a stranger who knows a rep's email and employee ID gets 10 guesses, then waits 15 minutes, 10 more,
30 minutes, and so on: about 70 guesses in the first day (locks of 15 + 30 + 60 + 120 + 240 + 480 minutes, then 16
hours), then 10 a day. Against a 4-digit PIN that passes the rules (about 9,960 left) that is roughly a 1-in-140 chance
on the first day. If the rep signs in with the right PIN in between, the count resets and the stranger is back to
15-minute locks, so a long campaign against someone who signs in daily could reach about 70 guesses a day. A 6-digit
PIN (a million values) makes the same campaign about a 1-in-14,000 chance a day. The rep sees the lock message when it
happens, which is the cue to change the PIN and tell an administrator.

**Require a PIN for everyone.** `pinSetupRequired = requirePin && !hasPin`, recomputed on every request from the
session's user row (no stale flag). Sign-in still succeeds for someone without a PIN; the gate then holds them at
"Create your PIN". An open session meets the gate on its next request. Setting a PIN lifts it at once.

**Require two-step for administrators.** `twoFactorSetupRequired = requireAdminTwoFactor && role = admin && two-step
not on`. Switching it on needs your own two-step on (409 otherwise) and signs out the other administrators without it,
so they meet the setup step at their next sign-in. While it holds, an administrator cannot turn two-step off (409); an
administrator's lost-device reset (`POST /users/:id/2fa/reset`) still works and they set it up again at sign-in.

**Sessions.** A session ends when it is 14 days old (unchanged) **or** idle for longer than the admin's
`sessionIdleHours` (default 12, 1–72), measured on the real clock from `sessions.last_seen_at` (else `created_at`). The
check is strict (exactly on the limit is still alive). `authenticate` deletes an idle session on sight (→ 401) and
refreshes `last_seen_at` at most once a minute (`LAST_SEEN_RESOLUTION_MS`), so the timeout costs one small write a
minute per active session, not one per request. The 15-minute sweep (`purgeExpiredSessions`) also deletes idle
sessions. Setting or changing a PIN signs out your other sessions; an admin PIN reset signs the person out everywhere.
When the column is first added, sessions opened before 1.2 count as seen at the upgrade, so the new timeout does not
sign everyone out at once.

**Settings reads** are cached per database and dropped whenever the data version moves (every write request bumps
it), so a change applies on the very next request and a read-only request costs no extra query.

**Client.**
- `pages/Login.tsx`: a PIN step between the credentials and the two-step code (masked digits-only field with a show
  button, password-manager friendly). Wrong PIN → "That PIN isn't right" plus "N tries left before your PIN locks for a
  while" when 3 or fewer remain; locked → the server's own sentence with the unlock time; locked or `429` → the field
  stays disabled with the reason until Back.
- `auth/PinSetupGate.tsx` (around the signed-in shell) shows the lazy full-screen steps from `auth/PinSetupStep.tsx`:
  "Create your PIN" (PIN twice, the shared rules as you go) and, for administrators, "Set up two-step verification"
  (the Settings setup modal). Once that modal opens, the step stays until it closes, so the recovery codes are never
  swept away when /auth/me stops asking. It listens for `PIN_SETUP_REQUIRED_EVENT` and re-reads /auth/me (one request
  at a time).
- `auth/AuthProvider.tsx`: a signed-in tab coming back to the front re-reads /auth/me (at most once a minute), so an
  idle-expired or reset session shows the sign-in page straight away.
- `features/settings/PinSettings.tsx` (Settings → Security) and `PinResetSection.tsx` (Team → edit person). A locked
  PIN shows "Locked" with the unlock time ("Try again after 14:35, or ask an administrator to reset it"; the admin's
  view says "until 14:35"), and the card reads its status again at that minute, so Change and Remove come back by
  themselves. A `423` inside the Change or Remove dialog shows the server's sentence and refreshes the card.
- Main chunk 445 kB, under the 460 kB budget: the gate is small and the steps, Settings and Login are lazy chunks.

### 15.4 Bulk gauge entry with WhatsApp paste (U2)

#### Server (`routes/bulkGauges.ts`)

A bulk row is exactly a `POST /gauges` row. The rules are the single-entry functions, imported, not copied:
`gaugeBody` (field validation), `assertCanWriteGauge` (scope), `assertGaugeIntegrity` (event started, not cancelled,
date = event date, active member of the event's team — admins exempt from the team rule), `validateGaugeFunnel`
(stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales, each ≤ 2,000), `assertWeekUnpaidFor` (paid-week lock,
admins pass), `checkInFor` (a check-in can never be in the future, on the business clock) and `rateSnapshot`.

1. The event-wide rules run once (a stand-in member of the event's team, so only the event rules can fail).
2. Every row is then checked and its problems collected: field errors ("Stops: Number must be less than or equal to
   2000"), the same person twice ("This person is already on row 1"), "Person not found", the first scope refusal,
   the funnel warnings, the paid-week message and a future check-in. One grouped query loads the people.
3. Any problem → 400 with every row's problems; nothing is written.
4. Otherwise, in **one transaction**: existing entries for the event and date (one query) are updated in place
   (submitted time refreshed, rate snapshot kept), new ones inserted with the campaign payout and pay-plan commission
   snapshot (`rateSnapshot`, memoised per pay plan), then the week's payroll runs follow: the people affected by every
   row (`affectedPayUsers`: the rows' owners, their team's leaders for the override, no-team seniors at the event) are
   collected and `syncPayrollRun(…, { flagPaid: true })` runs **once per person** — the same result as one
   `syncPayrollForEntry` per row (a test compares the runs with the same rows sent one by one). A week still in
   progress is left alone; a paid run is never recomputed but is flagged "adjusted after payment" when an admin
   changes it. No forecast, no extra gauge row.

#### The WhatsApp parser (`shared/src/logic/bulkPaste.ts`, pure and deterministic)

`parseBulkPaste(text, members)` → `{ lines: ParsedPasteLine[], ignored }`; `resolvePaste(lines, choices, members)`
applies the leader's choices; `pasteFills(lines)` gives one row per person; `pasteFunnelIssues(totals)` words the
funnel rule in plain English.

- **WhatsApp exports.** `[20/10/2026, 17:42:13] Jordan Lee: …` (iOS), `20/10/2026, 17:42 - Jordan Lee: …` (Android) and
  `[17:42, 20/10/2026] Jordan Lee: …` (desktop copy) lose their prefix; the sender is remembered for the following
  lines of the same message (until the next prefix). A system line ("Messages and calls are end-to-end encrypted")
  has no sender. Bidi marks, zero-width characters, every kind of space, emojis (with skin tones and flags) and
  WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`) are dropped; keycap digits read as digits (4️⃣0️⃣ → 40).
- **Check-in time.** The first time on the line is the check-in, as "HH:mm": `9:58`, `09:58`, `9.58am`, `10am`,
  `12:30pm`. A dot needs am/pm ("9.55" alone is two numbers). Without am/pm, 1:00–6:59 is the afternoon (`1:05` →
  13:05: nobody checks in for a field shift then). A run like `65:22:11:5:3:3` is never a time.
- **Dates** (`20/10`, `20/10/26`, `20.10.2026`, `2026-10-20`) are dropped. A run of four or more numbers
  (`65/22/11/5/3/3`) is never a date.
- **Not gauges:** numbers stuck to letters (`2nd`, `x2`), money (`£10`), percentages (`14%`), numbers longer than six
  digits (phone numbers).
- **Chatter.** A line with fewer than three gauge numbers is ignored and counted in `ignored` (blank lines are not).
- **Several people on a line** (`Jordan 65 22 11 5 3 3, Amelia 40 12 6 2 1 1`) split where a team member's first or last
  name follows three or more numbers, but only when the numbers already had a name in front (`65 22 11 5 3 3 Jordan`
  is one person named at the end). Keys: `4.1`, `4.2`.
- **Numbers.** Exactly six → funnel order. With three or more gauge words (`stops`, `table`/`tbl`, `pres`/`pitch`,
  `closes`/`cls`, `taps`, `sales`/`dd`/`signups`, singular or plural, glued or not: `65stops`), each number goes to its
  word, number-first (`65 stops`) or word-first (`stops: 65`), whichever pairs more, skipping filler (`22 to table`).
  If the words do not account for all six but six plain numbers are there, the plain order wins (the words were chat).
  Otherwise "Found 5 numbers, need 6" or "Missing taps".
- **Funnel problems** are kept on the line with its numbers: "To table (22) is more than stops (10)", "Stops (2500) is
  over the 2,000 a day limit".
- **The name** is the words before the numbers (after them when the line starts with numbers), with filler such as
  "gauges", "for", "today", "in", "checked" left out. No name at all → the WhatsApp sender. A name that matches nobody is
  never swapped for the sender: the leader chooses ("No one called “Jrdn” on this team — choose who it is").
- **Matching** (accents, apostrophes and hyphens ignored: Zoë = Zoe, O'Brien = OBrien, Mary Jane = Mary-Jane). Each
  member is scored and the top score wins: 100 first + last name · 90 first name + last initial (`Jordan L`) · 85 first
  + near-miss last · 70 first name · 65 near-miss first + last · 60 last name only · 55 near-miss first + last initial ·
  40 near-miss first. A near miss is a typo or swap (one edit, names of four letters or more: Jordon, Aemlia) or a short
  form of at least three letters (Sam → Samuel, Jord → Jordan); filler words never near-miss ("the" is not Theo).
  Several members on the top score → ambiguous ("2 people match “Jordan” — choose one"); a single near-miss match is
  flagged `guess` ("Best guess for “Calum”").
- **Repeats.** The last complete line for a person wins (`replacedBy` marks the earlier ones); an incomplete line
  replaces nothing. `resolvePaste` accepts a choice for an ambiguous line only among its matches, and anyone on the
  team for an unknown name; `null` goes back to the parser's own match.

#### Client (`/gauges/bulk`)

- Event picker: the Log gauges list (last three weeks up to today, not cancelled; own team for a leader, every team for
  an admin, with the team name). Today's own-team event is preselected when there is exactly one
  (`preselectTodayEvent`); `?eventId=` deep-links one (own team for a leader). A future or not-started event shows why
  and cannot be saved.
- Rows: the event team's active members (no recruiters), first name order, prefilled from the entries already logged
  for that date. Statuses: **Logged** (saved, unchanged), **Update** (saved, changed), **New** (not saved, has a number),
  **Not logged**. Blank cells count as 0. Only New and Update rows are sent; an Update sends its check-in only when it
  changed (so a stored one is never cleared by accident) and never touches notes. Funnel problems and a check-in later
  than now (today's event) are shown on the row before saving and block Save; the server's answer is mapped back to
  the rows by index.
- Unsaved numbers are kept on the phone per person and event (`localStorage` `lm-bulk-draft:<userId>:<eventId>`, every
  call wrapped, kept 3 days) and come back after a reload or a lost signal, with **Discard them**. A save without
  signal keeps them and says nothing was saved.
- After a save the page waits for the event's entries, then clears the edits and the draft and closes the paste box.

### 15.5 Audit trail and announcement read receipts (U3)

#### What is recorded

- **Every successful write**: when (`at`, the real clock, not the business clock: an audit row says when it really
  happened), who (the signed-in person; for a sign-in, the person who has just signed in), the method and Express
  route pattern, the IP, and a summary. Routes the registry does not describe are recorded with the action as the
  summary (`POST /things/:id/zap`) and no snapshots.
- **Registered routes** (`server/src/lib/auditSpecs.ts`) load a "before" snapshot just before the handler runs and an
  "after" snapshot at the moment the response is sent (synchronously, so nothing can slip in between):

| Entity | Routes | Summary, for example |
| --- | --- | --- |
| Pay run | `POST /finance/payroll/:id/pay` | Marked paid: Jordan Lee w/c 5 Oct, £945 (· "Marked paid (late)" when the money landed after the due date) |
| Pay run (side effect) | any gauge write | Recalculated after a gauge change: Jordan Lee w/c 12 Oct, £675 → £795 · Pay run created / removed after a gauge change · Adjusted after payment: Jordan Lee w/c 5 Oct, paid £945; the gauges changed |
| Gauge entry | `POST /gauges` (create or edit), `PATCH /gauges/:id`, `DELETE /gauges/:id`, `POST /gauges/bulk` (one row per entry created or changed) | Logged gauges: Jordan Lee, 15 Oct at Arndale, 2 sales · Edited gauges: …: taps 2 → 3, sales 2 → 3 · Deleted gauges: … (3 sales) · Logged gauges in bulk: … |
| Person | `POST /users`, `PATCH /users/:id`, `POST /users/:id/2fa/reset`, `POST /auth/pin/reset/:userId`, sign-in, sign-out, the caller's own two-step and PIN changes | Added Sam Brown: Representative, Trainee, Team North · Updated Daisy Holt: position trainee → field rep · Deactivated Rita Rep · Reactivated … · Reset two-step verification: … · Reset PIN: … · Signed in · Signed out · Turned on two-step verification · Set a PIN |
| Candidate | `POST /recruitment/candidates`, `PATCH …/:id`, `POST …/:id/stage` (a hire also records the new person), `POST /recruitment/interviews`, `PATCH /recruitment/interviews/:id` (filed under the candidate) | Moved Elliot Bradley: Applied → Phone screen · Booked first interview: Sam Brown, 21 Oct, 14:00 |
| Event | `POST /events`, `PATCH /events/:id`, `DELETE /events/:id` | Updated event: Castlefield Bowl, 21 Oct: target 14 → 16 · Cancelled event: … · Restored event: … |
| Campaign | `POST /campaigns`, `PATCH /campaigns/:id` | Updated campaign Breast Cancer Now (BCN): payout per sale £120 → £130 |
| Pitch | `PUT /pitches/:campaignCode` (entity id = the campaign's id) | Wrote the BCN pitch · Edited the BCN pitch: script |
| Settings | `PUT /auth/security-settings` | Changed sign-in settings: require a PIN for everyone no → yes |
| Announcement | `POST /announcements` | Posted announcement: “Saturday rota is up” |
| Expense | `POST /finance/expenses`, `DELETE /finance/expenses/:id` | Added expense: £42.60 travel, 20 Oct |
| Learning | `POST /learning/progress/:lessonKey/quiz`, `…/teachback`, `…/:userId/:lessonKey/signoff` (entity id = the learner) | Learned Feel felt found: self-check passed · Signed off a teach-back: Jordan Lee, Bullet theory · Took back a teach-back sign-off: … |
| Check-in | `POST /checkins`, `DELETE /checkins/:id` | Checked in: Jordan Lee at Arndale, 20 Oct 09:24 · Removed check-in: … |

- **Pay runs moved by a gauge write.** Before the handler, the trail notes everyone whose run the entry can move (the
  same rule as `affectedPayUsers`: the person, override earners on their team, no-team seniors who logged at the same
  event, for the old and the new key when an entry is moved) and their runs for the weeks concerned, in two queries.
  Afterwards it reloads those runs and writes a pay-run row for each one that changed: recalculated (gross changed, or
  other figures with the gross the same), created, removed, or flagged "adjusted after payment" (a paid run whose
  `adjustedAt` was set by an admin's change). So a payslip's history explains every change to its figures.
- Snapshots carry readable names next to ids (`userName` with `userId`). Tables of other 1.2 packages
  (`campaign_pitches`, `learning_progress`, `check_ins`, `users.pin_hash`) are read defensively: until they exist the
  snapshot is empty and the row is still written.
- **Settings**: the before of a change is the settings as they are stored when the request arrives (U1's keys in
  `meta`), so a change made outside the app still reads true. Only when they cannot be read is it what the last
  recorded settings change left, or the documented defaults (PIN not required, two-step for administrators not
  required, 12 hours).
- **Not recorded**: reads, failed requests, step one of a two-step sign-in (no session yet), announcement read
  receipts (their own table), and **writes that changed nothing**:
  - a check-in replay answered "already recorded" (the first check-in stands): the route's answer decides (`201` new,
    `200` the one already there), whatever date, time or extra fields the replay carries;
  - a teach-back saved with the same text (compared after trimming; the text itself is never put in a snapshot);
  - a pitch saved with the same title, script and fact-check notes (whoever saves it);
  - sign-in settings saved with the values they already have;
  - a self-check retake that changes no stored field (the same score, the lesson already learned or still not);
  - a second sign-off of a teach-back (the first signer stands), or a sign-off taken back where there was none.
  So nobody can fill the trail with rows that say nothing. Every other write is recorded, even when it changed
  nothing (for example an admin saving a person unchanged: "Updated Rita Rep (no changes)").

#### Secrets never stored

Request bodies and responses are never stored, only snapshots the registry loads itself, and those never select
PINs, PIN hashes, two-step secrets, recovery codes or session tokens. As a second guard every snapshot is redacted
before storage (shared `redactAuditSnapshot`): any key, at any depth, named `pin`, `currentPin`, `newPin`, `pinHash`,
`pin_hash`, `pinSalt`, `password`, `token`, `sessionToken`, `challengeToken`, `secret`, `totp_secret_enc`,
`totp_pending_enc`, `code`, `recoveryCode(s)`, `code_hash`, `otpauthUrl`, `qrDataUrl`, `manualKey`, or containing
`secret`, `password`, `token`, `pinhash`, `pin_hash` or `recovery`, is stored as `[redacted]`. (A campaign's code is
therefore stored as `campaignCode`.) A snapshot larger than 64,000 characters is replaced by a short note; summaries
are capped at 500 characters.

#### Long text

Any text in a snapshot longer than 2,000 characters (a pitch script, its fact-check notes, a long announcement) is
stored as `{ length, sha256, head }`: its length in characters, the SHA-256 of the whole text (hex) and its first 200
characters (`compactLongText` in `server/src/lib/audit.ts`, after redaction, at any depth). Two versions compare equal
exactly when their text is the same, so the diff still lists the field as changed, and a save of the same text is
not a change. Text of 2,000 characters or fewer is stored as it is. A 19,000-character script therefore costs a few
hundred bytes per row instead of 38 KB. The summary names the field ("Edited the BCN pitch: script": a pitch's text is
its script; an announcement's stays "text"). The audit page and the record histories show it under the field's label
("Script") as "Changed · 19,204 characters (was 18,950)", then the first 200 characters of
each version, marked "First 200 of 19,204 characters"; "added" and "removed" when one side is empty. Rows written
before this change keep the whole text and show it as before.

#### What a leader sees in a gauge entry's history

A leader may open the history of a gauge entry of their own team (or their own). An entry can be moved between
people and teams, so every snapshot is judged on its own, by the rule `GET /gauges` uses (`canSeeEntryDetails`):
the check-in time and notes of a snapshot whose person is not on the leader's team (their team now) are blanked; the
numbers and names stay. When anything was blanked, the row's diff and summary are rebuilt from the blanked
snapshots, so neither can quote what was hidden: after Bo's entry (team B) is moved to Remy (team A), team A's leader
sees "Edited gauges: Bo Rep, 14 Oct at …: person Bo Rep → Remy Rep, event … → …" with no trace of Bo's note or
check-in time. Admins always see everything. IP addresses are for admins only.

#### Per-person write limit

The 1.2 writes anyone signed in can repeat at will share a budget of 60 per person per minute (the real clock, a
one-minute window from the first of them): `POST /learning/*` (self-check, teach-back, sign-off), `PUT /pitches/*`,
`POST /checkins`, `POST /auth/pin` and the routes below it, and `POST /gauges/bulk`. The next one inside the minute
is refused with 429 "That is more than 60 changes in a minute. Wait a minute, then try again." and
`Retry-After: 60`; refused requests do not count and nothing is recorded for them. Reads, other writes and
signed-out requests are not affected. The counter is in memory (`server/src/middleware/writeLimit.ts`, on the login
limiter's bounded map), so a restart forgets it. A phone replaying its queued check-ins stops at a 429 and tries
again later; nothing queued is lost.

#### The diff

`auditDiff(before, after)` (shared, pure): the fields whose values differ, compared as JSON for nested values; empty
and `''` count as null; a create lists every filled field, a delete every field it had. The record's `id` and the
reference ids that travel with a name (`userId`, `eventId`, `teamId`, `campaignId`, `payPlanId`, `ownerId`,
`referredById`, `interviewerId`, `candidateId`, `hiredUserId`, `authorId`, `signedOffById`) are never listed, so a move
shows once, as names; `employeeId` is a value and is listed. Summaries name at most three changes ("… and 2 more");
long text fields are named, not quoted. Values read the British way: £945 / £412.50, 12 Oct, wall-clock check-ins
"12 Oct 09:24", zoned times in London time, enums as words ("field rep").

#### Read receipts

- The dashboard reports an announcement as read once at least half of its card has been on screen for 1.2 seconds;
  never for the author's own announcement. Several cards are sent together, then the stats refresh once. Each
  person's reported ids are remembered on the device (`localStorage` `lm-announcement-reads:<userId>`, newest 200; a
  blocked store only means a harmless repeat), so a visit does not post again.
- **Audience** = everyone whose status is `active`, except the author. **Read count** = reads by people in that
  audience (a reader who has since left or gone on leave no longer counts; the author's own read never counts).
- The demo seed marks a plausible share of the active people as having read each seeded announcement (35% just after
  posting, rising to 90% after a week, at times between the post and now; its own random stream, so the core demo
  data is unchanged). An existing database starts with no reads.

#### Retention

`purgeAuditLog` deletes rows older than 730 days (two years, real clock) at start-up and every 24 hours
(`index.ts`). Read receipts live as long as their announcement.

#### Database (`server/src/db/extensions/audit.ts`)

- `audit_log(id, at, user_id, action, entity, entity_id, summary, before_json, after_json, ip)`, indexed on `at`,
  `(user_id, at)` and `(entity, entity_id, at)`. No foreign key on `user_id`, so a row outlives anything.
- `announcement_reads(announcement_id, user_id, read_at, PRIMARY KEY (announcement_id, user_id))`, cascading with the
  announcement and the person; indexed on `user_id`.
- `upgrade` has no data steps (returns `[]`); `seed` writes `announcement_reads` only.

#### Performance

Reads are untouched (the middleware returns at once for `GET`). A write costs one or two snapshot queries before the
handler and one to three after it, plus one insert per row; a gauge write adds two queries for the pay runs. `GET
/audit` is two queries (count and page), `GET /announcements/reads` two; a leader's gauge entry history adds one
query for the teams of the people in its snapshots.

### 15.6 One-tap shift check-in (U4)

#### Table (`server/src/db/extensions/checkins.ts`)

`check_ins(id, user_id → users ON DELETE CASCADE, event_id → events ON DELETE CASCADE, date, checked_in_at, source
CHECK IN ('button','quick','offline','leader'), created_at, UNIQUE(user_id, event_id, date))`, plus
`idx_check_ins_event(event_id, date)`.

- The table is new. An existing database gets it from `sql` on its next start.
- `upgrade()` adds one nullable column, `gauge_entries.checked_in_by`: who set the gauge entry's check-in time. There
  is no data step. Rows written before it, and seeded rows, are "not known", which the punctuality rule below treats
  like the person's own time.
- Demo seed: on a fresh demo only, today's started (live or completed) events get a check-in for everyone who logged
  gauges today with a check-in time, at exactly that time. Sources are 30% `quick`, the rest `button`. Absentees show
  as "not checked in" on the roll call. The seed reads `gauge_entries` but never writes a core table, so the
  `r2-contracts` hash test holds.

#### On time or late

`shiftCheckInStatus(eventDate, startTime, checkedInAt)` reuses the existing `isCheckInOnTime` and `minutesLate`:

- A check-in is on time up to 5 minutes after the start, inclusive. 09:05:00 is on time; 09:05:01 is "6 min late".
- Labels read "Checked in 09:24 · on time" or "Checked in 09:36 · 6 min late".
- Inside the grace a check-in reads "on time", even when `minutesLate` is between 1 and 5.

#### When the button applies (`shiftCheckInWindow`)

- **`open`:** on the event's date, from midnight until the end time inclusive. Arriving early is the point.
- **`ended`:** after the end time. The button disappears, but an existing check-in still shows.
- **`not-today` / `cancelled`:** never shown.
- **Who sees it:** reps and leaders of the event's team, plus an admin who belongs to that team.

#### Time rules (`resolveShiftCheckInTime`)

- **Live tap** (no time sent): the business clock now. Only on the event's date, up to its end time. There is no early
  bound: arriving early is the point.
- **Sent later from a phone** (a time sent), checked in this order:
  1. The time must be on the event's date.
  2. It must reach Linear Hub within `SHIFT_CHECK_IN_REPLAY_HOURS` (24) hours of the event's end. An event ending
     17:00 on Tuesday accepts it until 17:00 on Wednesday. Later, the answer is 400 "This check-in reached Linear Hub
     more than 24 hours after the event ended at 17:00, so it cannot be recorded. Ask your team leader to record your
     arrival time." (It was 7 days in the first 1.2 build.)
  3. It cannot be in the future. A phone clock up to `SHIFT_CHECK_IN_CLOCK_SKEW_MS` (5 minutes) ahead is taken as now.
  4. It cannot be after the event's end.
  5. It is never earlier than `SHIFT_CHECK_IN_EARLY_MINUTES` (60) minutes before the start. An earlier time is
     recorded as that bound: a 09:00 start records a 07:10 tap (or a made-up 00:00:01) as 08:00, which is still on
     time. If the phone sends it before the bound has come round (tapped 07:00, sent 07:30), the business clock now is
     recorded. An event starting before 01:00 is bounded by its own date. Recording the bound instead of refusing
     means that arriving early without signal never costs anyone their check-in.
- Naive times compare as strings. Differences between them, the 24 hours included, are taken as if both were UTC, so
  a daylight-saving change never shifts them.

#### Punctuality (`lib/metrics.ts` `punctualityFor`, `lib/smart/digest.ts`, `lib/smart/checkIns.ts`)

- **Which time counts**, for a logged day:
  1. The gauge entry's own `checked_in_at`, when a leader or admin recorded it on the person's behalf
     (`checked_in_by` is someone other than the entry's person; only leaders and admins may write another person's
     gauges).
  2. Otherwise the one-tap check-in for the same person, event and date, when there is one.
  3. Otherwise the gauge entry's own `checked_in_at`, as in 1.1.
- **The SQL:** `LEFT JOIN check_ins ci ON (user, event, date)` with
  `CASE WHEN g.checked_in_at IS NOT NULL AND g.checked_in_by IS NOT NULL AND g.checked_in_by <> g.user_id THEN
  g.checked_in_at ELSE COALESCE(ci.checked_in_at, g.checked_in_at) END` (`lib/shiftCheckIns.ts`:
  `SHIFT_CHECK_IN_JOIN`, `CHECKED_IN_AT_SQL`). The unique key makes it one index lookup per gauge row, and there are
  no extra queries.
- **Who set the time** (`stampCheckInAuthor`, called in the same transaction by `POST /gauges`, `PATCH /gauges/:id`
  and `POST /gauges/bulk`):
  1. No time: no author.
  2. A write that keeps the time (leaves it out, the form sends it back unchanged, or the entry moves to another
     event or day without its time changing): its author stays. A rep who edits their counts never takes over a time
     their leader recorded, a leader who edits or moves a rep's entry never takes over the rep's own time, and a
     time the leader recorded stays the leader's when they move the entry.
  3. A new or changed time that equals the person's own one-tap check-in for that event and day, to the minute: the
     person's. Log gauges fills the field with the check-in without its seconds, so a leader saving that is not
     recording a different time. The precise check-in keeps counting: a 09:05:40 tap stays 6 minutes late.
  4. Any other new or changed time, or an entry re-pointed at another person: the person saving it.
- **The person cannot undo a time recorded for them** (`assertCheckInNotLocked`, review 1.2 S3). On their own entry,
  when someone else recorded the time, the person (any role but admin) gets 403 for changing or clearing the time,
  moving the entry to another event, day or person, or deleting it (leaders may delete their own days): "Your team
  leader recorded your arrival time on these gauges. Ask them to change it." ("An admin…" when an admin did; "…Ask
  them to move the entry." / "…Ask them to delete the entry."). Counts and notes stay editable, and sending the same
  time back is not a change. Without this, a rep could retype the time by a minute, become its author and let their
  own check-in count again. `POST /gauges/bulk` reports it as a row error, so a leader's own row cannot undo an
  admin's time either. Gauge entries answer `checkInOnBehalf` (`CHECK_IN_ON_BEHALF_SQL`), stripped with
  `checkedInAt` by `redactEntry`.
- **What counts as a sample:** still the gauge rows. A check-in on its own (no gauges logged yet) is not a punctuality
  sample. It counts once the day is logged.
- **Removing a check-in:** punctuality falls back to the gauge entry's own time.
- **When the two disagree:**
  - The leader logged the rep's day with 10:30 and the rep's phone later sent a check-in at 08:55: the leader's 10:30
    counts. The roll call still shows the check-in, marked "sent later".
  - The rep logged their own day with 08:55 and tapped at 09:20: the tap counts. A leader who wants a different time
    to count records it on the rep's gauge entry, or removes the check-in from the roll call.
- **A rep's own gauge time** is still theirs to change, as in 1.1. A time their leader recorded is not (see above).
- **Source:** a check-in that carries a time from the phone is always recorded as `'offline'`, whatever the request
  says, so leaders see "sent later" on every time the phone supplied (an online phone cannot pass a back-dated time
  off as a live tap). Without a time it is `'quick'` when sent, else `'button'`.

#### Pay integrity

- A check-in never writes, edits or reads into `gauge_entries` or `payroll_runs`.
- Pay counts distinct gauge dates (`weekPayFor`), so a check-in is never a day worked.
- Tested in `server/src/test/shift-checkins.test.ts`: there is no gauge row, no payroll run, `weekPayFor` is unchanged,
  and the dashboard shows `days` 0 after check-ins.
- The time rules and which time counts are tested in `shared/src/logic/shiftCheckIn.test.ts` and
  `server/src/test/checkins-precedence.test.ts` (the review's probe: a leader's 10:30 against the rep's 08:55 tap).

#### Offline (`client/src/features/checkins/outbox.ts`)

- **Storage:** the localStorage key is `'lm-checkin-outbox:<userId>'`, with at most 20 items. Every storage call is
  wrapped. When the phone cannot keep a tap, the button says so rather than dropping it. Signing out keeps the queue:
  it sends the next time the same person signs in on that phone.
- **Items:** each one is a `ShiftCheckInInput` with the tapped `checkedInAt` (the phone's wall-clock time, as Log
  gauges' **Now** uses) and `source: 'offline'`. It also holds the event name and start time, so the phone can show
  "on time" or "6 min late" before the tap is sent.
- **One per event and day:** a second tap keeps the earlier time (`addToShiftCheckInQueue`).
- **When the button queues:** when the browser reports it is offline, or when `POST /checkins` throws a `NetworkError`.
- **When it replays:** `CheckInOutboxReplay` replays one item at a time (single-flight). It runs on mount, on the window
  `online` event, and when `NETWORK_EVENT` goes from offline to online. It does not replay on every answer, so a server
  error can never loop.
- **Replay outcomes** (`shiftCheckInReplayOutcome`):
  - 201: sent.
  - 200: already there, and Linear Hub's check-in stands.
  - No answer, 401, 408, 429, 5xx, or a 403 from the PIN gate (detected through `PIN_SETUP_REQUIRED_EVENT`): stop and
    keep the item.
  - Any other 4xx: the item becomes `failed`, with Linear Hub's reason, until the person dismisses it.

#### Log gauges

- **Prefill:** **Checked in at** is filled from the person's check-in when the field is empty. The check-in can be on
  Linear Hub, or waiting on this phone for the signed-in person.
- **What it never replaces:** a time that was typed, set with **Now** or the chip, or already stored on the entry.
- **Changing the selection:** picking another person or event removes the time the form filled in, or swaps it for
  the new choice's check-in.
- **Hint:** the field's hint names the check-in and says which time will count once saved, e.g. "One-tap check-in
  09:17 · on time — punctuality uses it". Logging for someone else (a leader or admin):
  - the field is empty, or holds the check-in's own minute (as filled in): "— punctuality uses it";
  - a new entry, or a time changed from the stored one: "— the time you save here counts instead";
  - an update that leaves a stored time alone: "— the time recorded here counts instead" when a leader or admin
    recorded it (`checkInOnBehalf`), else "— punctuality uses it unless you change the time here".
- **Locked time:** on the person's own entry whose time a leader or admin recorded, the field and **Now** are
  disabled, the update never sends the time, and the hint says "recorded for you by a leader or admin, so this time
  counts — ask them if it needs changing" (admins are never locked).
- **Chip:** the "Checking in? Use now" chip is hidden when there is a check-in.

### 15.7 Search palette, payroll export and the Gauges layout fix (U5)

- **Search ranking.** Every word of the query must appear somewhere in a row's searchable text. Within a kind, rows
  whose title starts with the whole query come first, then rows where a word of the title starts with it, then the
  rest in the kind's natural order. The palette shows the group with the best-ranked result first.
- **Palette.** Actions and pages are filtered in the browser (every word must appear in the label or its keywords);
  the server is asked 200 ms after the last key. Actions: Log gauges (`/gauges?log=1`, reps, leaders, admin), New event
  (`/events?new=1`, admin and leaders with a team), Mark week paid (`/finance?tab=company#runs`, admin).
- **Pay export columns** (shared `PayExportRow`, both formats in this order): employee name, employee ID, period start,
  period end, gross, base, commission, bonus, overrides, deductions, reference. Dates dd/mm/yyyy, money two
  decimals. Xero and Sage differ only in their header names (`PAY_EXPORT_HEADERS`).
- **Formula guard.** A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe
  (plain negative numbers excepted), then is quoted when it holds a comma, quote or line break.
- **Pay integrity.** Before reading, the export runs the same guard as `GET /finance/payroll`
  (`ensurePayrollMaterialised`), so the file always matches what the Finance page lists: when the last closed week has
  no runs yet, it creates that week's pending runs and brings the week before's unpaid runs back in line with the
  gauges, exactly as that page would on its next load. It never changes a paid run. When the guard changes runs it
  moves the data version, so every cached view (dashboards, summaries) is rebuilt on its next read, the same as after
  the Finance page. Otherwise the export only reads.
- **Layout fix.** On Gauges the tabs and the date-range presets share a row only when both fit; otherwise the presets
  wrap onto their own line, and the picker itself may shrink (its pills scroll inside it). At 1024 px the admin's
  Gauges page no longer scrolls sideways.
