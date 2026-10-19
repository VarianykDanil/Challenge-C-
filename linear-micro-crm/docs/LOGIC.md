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
| `tallyStep(counts, key, ±1)` | A +1 changes only its own row and is refused when the row already equals the stage above it, or is at the daily maximum (2,000). A −1 is refused at 0, or when the row already equals the stage below it. A refused tap returns the counts unchanged and one hint, e.g. "Sales can't go above taps (0) — add one to Taps first." |
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
  (the dashboard's upcoming events, event lists and pages, team lists). The hint then says so.

**The tally** (`features/gauges/TallyMode.tsx`, `tallyStore.ts`; key `lm-tally:<userId>:<eventId>:<date>`):

* **Counts.** They are kept per (person, event, date), survive reloads and dropped signal, and never leave the phone
  until **Finish shift**. Unfinished tallies older than 14 days are dropped.
* **Which event.** The tally offers today's events (own team for reps and leaders; any team for admins) plus any
  event with an unfinished tally. It picks the event under way, then the one live event, then the only event;
  otherwise it asks.
* **Finish shift** opens Log gauges prefilled with the counts. Saving goes through the same validation and the
  outbox. When the day already has an entry, the counts update it, and the stored check-in and notes are kept. The
  tally is cleared once the save succeeds or is kept on the phone.
* **Buttons.** +1 buttons are 56 px tall; −1 buttons are 44 px. A tap that the funnel refuses greys its +1 and shows
  the hint for 5 seconds.
* **Loading.** The full-screen counter loads the first time the tally opens (`LazyTallyMode`, §14.11); the Gauges
  header's **Tally** button and the dashboard's **Count your shift** link are light pieces in `TallyLinks.tsx`.

**Edge cases and limits.**

* **Browser offline, storage blocked.** The modal does not offer the phone. TanStack Query holds the save until the
  browser is back online, as in 1.0.
* **No service worker or HTTPS (out of scope).** The outbox protects saves while the page stays open. A page whose
  code was never downloaded cannot open without signal (it shows **This page hit a problem**).
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
8. Key: if `<backup folder>/app-secret` exists and the live key file is missing, install it (0600); if both exist and
   differ, say so and change nothing. If neither exists (and `LM_APP_SECRET` is not set) and the restored database has
   people with two-step sign-in on, warn: they cannot finish signing in with a code until the kept `app-secret` is put
   next to the database; otherwise they use a recovery code and an administrator resets their two-step sign-in
   (Team › Edit › Reset two-step verification).

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
- `EventForecastChip` is 2.3 kB and renders inside every event row, so it stays where it is.
- Lazy-loading the smart components alone brought the main chunk to 481.6 kB, still over the 460 kB target, so the
  **sign-in page** and **About** are split too: someone already signed in, the usual case on a phone, never downloads
  the sign-in page (15 kB), and About (8 kB) is rarely opened. The sign-in page loads behind the same full-page spinner
  as the session check.
- Rule for later work: import a dashboard- or finance-only component through its `Lazy…` wrapper, never directly and
  never through a barrel that re-exports it, or it moves back into that page's chunk (or the main one). Measure with
  `npx vite build --sourcemap` and a source-map breakdown of `dist/assets/index-*.js`.
