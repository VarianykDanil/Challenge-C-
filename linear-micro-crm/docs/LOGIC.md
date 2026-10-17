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
* `validateGaugeFunnel(totals)` returns human-readable warnings for non-integers, negatives and any
  stage larger than the one before it. An empty array means valid.
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
| `stopsPerSale` | stops / sales | `Infinity` when sales = 0 |

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

Negative inputs are clamped to 0; deductions larger than the week's pay produce a negative gross
rather than being hidden.

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
  assigns **competition ranks**: equal values share a rank and the next distinct value skips ahead
  (1, 2, 2, 4). The sort is stable; input order breaks remaining ties. Returns new objects.
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
  roll-over), compares every candidate in constant time and always checks all three.
* **Recovery codes**: 10 × `xxxx-xxxx`, lower-case `a–z0–9` drawn uniformly from `crypto.randomBytes`
  (rejection sampling), stored as SHA-256 hashes, single use; typed codes are lower-cased and the
  hyphen/spaces are optional.
* **Limits**: 6 wrong codes per user in 10 minutes → `429`; wrong codes at login also count towards the
  8-per-IP+email login limiter. A login challenge lives 5 minutes and is deleted after one successful use.
* **At rest**: secrets are AES-256-GCM encrypted (`lib/crypto.ts`) with a key derived from `LM_APP_SECRET`.

Reference vectors (RFC 6238 appendix B, secret `12345678901234567890`): T = 59 → `94287082` (8 digits) /
`287082` (6); 1111111109 → `081804`; 1234567890 → `005924`; 2000000000 → `279037` — all covered by
`npm test -w server`.
