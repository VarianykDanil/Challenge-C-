## API

Pace and streaks add no endpoint. They fill parts of two payloads p1 already serves (both cached, both switched off
by `LM_SMART=0`).

**`GET /me/insights` → `personal.baseline`, `personal.direction`, `personal.streaks`, `boardStreaks`**

| Field | Type | Who gets a value | Notes |
|---|---|---|---|
| `personal.baseline` | `PersonalBaseline \| null` | the caller only; null for recruiters, new starters (fewer than 4 worked weeks in the last 8) and anyone under 20 stops a day | `weeks`, `stopsPerDayMean` (μ), `stopsPerDaySd` (σ), `conversion` (pooled usual rate, 0..1), `current` {`days`, `stops`, `sales`, `stopsPerDay`, `conversion`}, `alerts` (0–2) |
| `personal.baseline.alerts[]` | `BaselineAlert` | — | `metric` `stopsPerDay`\|`conversion`, `tone` `warning`\|`positive`, `z` (2 dp), `current` and `usual` (stops a day, or conversion 0..1), `title`, `body` (ready-to-show sentence) |
| `personal.direction` | `TrendDirection \| null` | the caller only; null for recruiters and when either 8-week half has under 400 stops | `label` `improving`\|`declining`\|`steady`, `z`, `earlierConversion`, `recentConversion`, `earlierStops`, `recentStops` |
| `personal.streaks` | `Streaks \| null` | the caller only; null for recruiters and for anyone with no gauge rows before today | `current`, `best` (worked days in a row with ≥ 1 sale), `personalBestWeek`, `weekSales` (Monday to yesterday), `bestPreviousWeekSales` (best earlier week with ≥ 3 worked days; 0 when none) |
| `boardStreaks` | `{ userId, streak }[]` | rep / leader: their own team; admin: every active rep and leader; recruiter: `[]` | only streaks ≥ 5, longest first (ties by user id); streak counted over the last 180 days |

Nobody can read another person's baseline, direction or personal-best flag: they exist only inside the caller's own
`/me/insights.personal`. Only the streak number (≥ 5) appears for other people, on boards the caller can already see.

**`GET /leaderboard` → `row.streak`** (optional number, added by p1's wiring, filled here): every ranked row carries
its person's current streak over the last 180 days (0 when they have no selling run). Absent with `LM_SMART=0`.

Cost: one grouped SQL statement per builder — `personalPace` (one `weeklyHistory` call for 16 weeks + this week),
`personalStreaks`, `streaksForUsers` and `boardStreaks` — and no writes. On the seeded demo database (production build)
the admin's `/me/insights` answers in about 8 ms uncached and under 2 ms from the cache; `/leaderboard?period=quarter`
with streaks in about 12 ms uncached.

## Logic

Code: `shared/src/logic/baseline.ts`, `shared/src/logic/streaks.ts` (pure, unit-tested), `server/src/lib/smart/baseline.ts`,
`server/src/lib/smart/streaks.ts`. Rules: `BASELINE_RULES = { windowWeeks 8, minWeeks 4, minStopsPerDay 20, stopsZ 1.5,
minCurrentDays 2, convZ 2, minCurrentStops 100, holdingWithin 0.1 }`.

**What counts.** "Completed" weeks are the Mon–Sun weeks before this Monday; "this week" is Monday up to yesterday.
Rows dated today or later, and rows on an event still `live`, never count; rows on cancelled events do (the work was
done). Weeks with no worked day are skipped, not treated as slow weeks.

**Baseline** (`personalBaselineFrom(last 8 weeks, this week)`): null when fewer than 4 of the 8 weeks were worked or
μ < 20 stops a day. μ and σ are the mean and sample SD (n − 1) of each worked week's stops ÷ worked days; p0 is the
pooled conversion Σ sales ÷ Σ stops of those weeks.

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

**Direction** (`conversionTrend` over the 16 completed weeks, p1): oldest 8 v newest 8 with the pooled two-proportion
z; null when either half has under 400 stops; `improving` z ≥ 2, `declining` z ≤ −2, else `steady`. The card adds one
line only when it is not steady: "Steadily improving: 4.0% → 4.6% over the last 16 weeks" or "Conversion has drifted
from 4.0% to 2.5% over 16 weeks — your coaching card shows where to start". (Which stage caused a change is deferred
to a later release.)

**Streaks** (`salesStreaks(days, today)`): a worked day is a date with any gauge row (rows on one date are summed);
dates ≥ today are ignored, so a slow morning never resets a streak before the day is over. A worked day with ≥ 1 sale
extends the run; one with 0 sales resets it; calendar days without gauges (days off, weekends, holidays) never break
it. `current` is the run ending at the last worked day before today, `best` the longest run. `personalStreaks` reads
all of the caller's history; `streaksForUsers` and `boardStreaks` read the last 180 days, so a longer run shows as at
most the worked days in that window.

**Personal best week** (`personalBestWeek`): this week's sales so far beat every earlier week with ≥ 3 worked days,
and at least 4 such weeks exist (a tie is not a best). `bestPreviousWeekSales` is the week to beat.

**Positive states only.** The Sales tile shows "12-day sales streak · best 26" from 3 days, otherwise "Personal best
week so far" when that is true, otherwise nothing; flames appear from 5 days. Nothing ever says a streak was broken.
**Order and fit on the Sales tile (lead decision).** The rank (or "N days worked") comes first and the streak second,
p1's order: "#2 of 6 in your team · 24-day sales streak · best 24". The Sales tile gives its hint three lines of its own
(`KpiTile hintLines={3}`: `line-clamp-3`, on its own line under the delta without the leading "·"), so neither fragment
is cut. Two small changes make the longest real hints fit three lines on a 360 px phone: beside a streak the rank
drops its "Ranked" (on its own it still reads "Ranked #2 of 6 in your team", as in 1.0), and below 640 px the six
personal tiles use 16 px padding instead of 20 px (the whole grid, so the numbers still line up). Measured at 360, 375,
390 and 1440 px with the seed (rep, leader, admin) and with the longest the copy can produce ("#12 of 23 company-wide ·
120-day sales streak · best 120", "#12 of 23 company-wide · Personal best week so far"): three lines or fewer, nothing
clamped. "0 days worked" is left out beside a streak, so a Monday never reads "0 days worked · 21-day sales streak ·
best 21".

## User guide

### Your pace and streaks

**Your usual pace (reps, leaders and admins who log gauges).** Under the coaching tips in **Your funnel** on the
dashboard, Linear Hub compares this week (Monday to yesterday) with your own last 8 weeks — never with anyone else:

* **Off your usual pace** — you are averaging noticeably fewer stops a day than usual (after at least 2 days). When your
  conversion is holding (at least 100 stops this week, and no more than 10% under your usual), it also tells you how
  many extra stops usually make one sale.
* **Conversion below your usual** — after at least 100 stops this week, your conversion is clearly below your usual.
  It names the one funnel stage to work on first.
* **Converting above your usual** and **Ahead of your usual pace** — a well-done when you are clearly beating your own
  usual.
* **Steadily improving: 3.6% → 5.2% over the last 16 weeks**, or **Conversion has drifted from … over 16 weeks** — how
  your conversion has moved across the last 16 weeks, shown only when the change is clear.

Today and events still live never count, so the note does not change while you are on site. You need at least 4 worked
weeks in the last 8 (about 20 stops a day or more) before a pace note appears; new starters and recruiters see the
card exactly as before. These notes are private: nobody else — not your leader, not the admin — sees them.

**Streaks.** A streak is the number of days you worked in a row with at least one sale. Days off never break it, and
today only counts once it is over. From 3 days, the **Sales** tile on your dashboard shows it after your rank, for example
**#3 of 9 in your team · 12-day sales streak · best 26**; in a week where your sales so far already beat every earlier week of 3 or more worked days (once you have
at least 4 of those) it shows **Personal best week so far**.

**Flames on the leaderboard.** On the **Leaderboard** page and in the team card on the dashboard, a small flame icon
with a number marks anyone on a streak of 5 days or more (hover it, or use a screen reader, to hear "12-day sales
streak"). Flames only appear on boards you can already see: reps see their own team, the dashboard team card shows
your team, and **Top performers** (admins and recruiters) shows the company. Only the streak is ever shown for a
colleague — never their pace notes or personal bests.
