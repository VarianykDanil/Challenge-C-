# p9 — Week in review (and the 1.1 close-out)

Fragment for the final docs merge: `## API` → API.md "Week in review (p9)", `## Logic` → LOGIC.md §14.9,
`## User guide` → USER_GUIDE.md: its first part is the **introduction** of "What's new in 1.1" (the
`<!-- p9-week-in-review-digest writes the introduction here. -->` slot), the rest goes under "Your week in review (p9)".
p9 also closes the release, so this fragment carries two extra parts for the merge step: **Roadmap 1.1** (replaces the
Now / Next / Later tables in docs/ROADMAP.md) and **Version 1.1.0** (the strings in the docs that still say 1.0.0).

## API

### `GET /me/digest?week=YYYY-MM-DD` → `WeekDigest`

Every signed-in role (`401` without a session). Answers the caller's own "Your week in review" for one completed
Monday–Sunday week. Cached per user and URL through `CACHED_PATHS` (20 s, cleared by any write; `X-Cache: MISS`, then
`HIT`).

| Query | Rule |
|---|---|
| `week` (optional) | Any date in the week; it is normalised to its Monday. Default: the **last completed week** (the Monday before this week's). |
| | `400` when the week has not finished yet (its Sunday is today or later — this week and every future week), when it starts before 2020, or when `week` is not a `YYYY-MM-DD` date. |

| Field | Type | Meaning |
|---|---|---|
| `weekStart`, `weekEnd` | string | Monday and Sunday of the week |
| `role` | `Role` | the caller's role (decides which bullets are built) |
| `title` | string | `Your week in review · w/c 12 Oct` |
| `bullets` | `DigestBullet[]` | 5–8 lines `{ text, private }`; shareable lines first, private lines last |
| `text` | string | WhatsApp-ready plain text: the title, a newline, then one `• ` line per **shareable** bullet. Private bullets are never in it. No markdown, no HTML (`<`, `>`, `*`, `#`, `_`, `~` and backticks are stripped from names and lines). `''` when nothing is shareable. |

`DigestBullet.private` is `true` for: the rep's own pay for the week, the leader's check-in count, and the admin's
payroll and failed-transfer lines. Nothing else.

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
    { "text": "Biggest move up: Amelia Hart, 2 places to 1st; biggest move down: Oliver Bennett, 2 places to 3rd.", "private": false },
    { "text": "4 of 31 recorded check-ins were late (more than 5 minutes after the start).", "private": false },
    { "text": "Next week (w/c 19 Oct): 5 events, expect about 85 sales (estimate 70–100) against targets of 84.", "private": false },
    { "text": "Nobody is on your check-in list this week.", "private": true }
  ],
  "text": "Your week in review · w/c 12 Oct\n• Northern Lights made 91 sales — up 20 on the week before.\n• …\n• Next week (w/c 19 Oct): 5 events, expect about 85 sales (estimate 70–100) against targets of 84."
}
```

### Version

`GET /api/health` now reports `"version": "1.1.0"` (read from server/package.json). The root, shared, server and
client `package.json` files (and the workspace entries in `package-lock.json`) are 1.1.0, and **About** shows
**Version 1.1.0** (`client/src/content/about.ts`, `APP_VERSION`).

## Logic

### §14.9 Week in review (p9)

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
| `digestText(d)` | `title + '\n' + '• ' + line` for each shareable bullet; markup characters stripped; `''` when no line is shareable |

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
| failed transfers (private) | runs with status `failed` in the to-pay window (`attentionPayrollWindow`: week_start in the last 12 weeks) — the same runs as **Runs to pay** and the bell |
| overdue actions | `recruitmentSummary.overdueActions` — the recruiter's **Overdue actions** tile (open candidates past their next action, whole pipeline) |
| outcomes to record | the shared `outcomesToRecord` (the one interview-outcome rule) over pending interviews the recruiter runs or owns, from `outcomeLookbackFrom(now)` to now |
| open pipeline | Σ `recruitmentSummary.openByStage` over the open stages (applied … offer) |

**Bullets by role** (in this order; a line is left out only where noted; never more than 8):

- **Rep** (also a leader without a team, on their own figures):
  1. `You made 20 sales — up 6 on the week before.` (a week with no gauges: `No gauges logged this week — 0 sales.`)
  2. `322 stops (up 37 on the week before) at 6.2% conversion — up from 4.9% the week before.` When sales fell but
     conversion held (or rose), one lever is added: `Your conversion is holding, so the volume is the lever: about 43
     stops make a sale.` (stops ÷ sales, rounded up). A week with no gauges shows the week before instead
     (`The week before: 9 sales from 500 stops.` or `Nothing logged the week before either, so there is no comparison yet.`).
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
  4. `Biggest move up: X, 2 places to 1st; biggest move down: Y, 2 places to 3rd.` New entrants (movement null) and
     unchanged places are ignored; ties go to the bigger move, then the better rank, then the name. Either half is
     left out (never swapped for the next person, so the line stays true) when that person is on the check-in list.
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
private lines.

**Determinism.** No randomness and no "now" in the wording. The lines about the week itself depend only on the stored
data for that week and the week before; the "now" figures (next week's forecast, the check-in count, overdue actions, outcomes
to record, failed transfers, `paydayPassed`) are computed for the business date, as on the tiles. Ties sort by size,
rank, then name.

**Edge cases.** The week before had nothing → `no comparison yet` (never NaN or `undefined`). A week with no gauges →
the kind week-off wording, no bonus line. A plan without a bonus → no bonus line. A leader without a team → the rep
bullets on their own figures. `LM_SMART=0` → `bullets: []`, `text: ''`.

**Performance.** Rep ≈ 8 statements, leader ≈ 16 (7 of them `checkInList`; `eventForecasts` is memoised per data
version), admin ≈ 16 (10 of them `recruitmentSummary`), recruiter ≈ 21 (two `recruitmentSummary` calls and one
interviews query). Every one is a grouped or keyed query (no per-row loops), and the response is cached for 20 s per
user and URL.

**Bundle.** `WeekInReview` lives in the on-demand dashboard chunk (`features/smart/dashboardSlots.ts`), which grows
from 10.7 kB to 17.3 kB (gzip 5.6 kB); the main chunk is unchanged (432.8 kB).

## User guide

### What's new in 1.1 (introduction)

Linear Hub 1.1 is the **smart release**. It does not add new screens so much as make the existing ones notice things
for you: how your week is going against your own usual pace, what this week's pay is likely to be, who on a team might
welcome a chat, what needs doing next, how an event is likely to go, and — every Monday — a short review of last week
you can paste straight into WhatsApp. Everything is worked out from the same numbers you already see on your tiles, by
fixed rules (no outside service and no AI), so the same week always reads the same way, and every forecast is labelled
an **estimate** with its range. Nothing private leaves your screen: pay and the check-in list are only ever shown to
the person they belong to. If the office ever wants the plain 1.0 behaviour back, the smart features can be switched
off on the server in one setting.

### Your week in review (p9)

At the bottom of the **Dashboard**, under the team, events and announcements, the **Your week in review · w/c 12 Oct**
card sums up the last full week (Monday to Sunday) in five to eight short lines.

- **‹ / ›** step back and forward a week. **›** is greyed out on the latest finished week: a week has no review until
  it is over.
- Lines with a **lock** are private to you — your pay, the payroll figures, the size of your check-in list. They are
  never copied.
- **Copy as text** copies the other lines, with the title, as plain text, ready for the team WhatsApp group. You will
  see **Copied — paste it into WhatsApp**. It works on the office Wi-Fi and over a phone hotspot (on plain
  `http://` addresses too). If a phone refuses, the text appears selected under the card so you can copy it by hand.

What each role sees:

- **Reps** — your sales, stops and conversion against the week before; where you finished on your team's board and
  whether you moved; how you did against the bonus (for example **You finished one sale short of the £75 bonus**); one
  coaching tip for the stage that most needs it; and, with a lock, your pay for the week. Nobody else's name appears in
  your review.
- **Leaders** — your team's sales and conversion against the week before; the top seller and the biggest moves up and
  down on your team's board; how many recorded check-ins were late (a number, never names); next week's events with an
  estimate of the sales they should bring against their targets; and, with a lock, how many people are on your
  **Check in with…** list — the card never names them, and nobody on that list is named in the lines you can copy.
- **Administrators** — company sales and revenue against the week before; the campaign with the biggest rise and the
  one with the biggest fall; hires and applications; and, with a lock, the payroll due on Friday and any failed
  transfers still to send again (the same runs as **Runs to pay**).
- **Recruiters** — applications, interviews and hires against the week before; how many open candidates are past their
  next action (the **Overdue actions** tile); interview outcomes to record now; and the size of the open pipeline.

The numbers are the same ones as on your tiles, the leaderboard and the finance and recruitment pages for that week —
if the review and a tile ever disagree, the tile is looking at a different period.

## Roadmap 1.1 (replaces the Now / Next / Later tables in docs/ROADMAP.md)

Intro line for ROADMAP.md: "Version 1.1.0 adds the smart release to what 1.0 did — pace notes, pay estimates, check-in
lists, the Needs-attention feed, event forecasts, signal-proof logging, recruitment deadlines, nightly backups and the
weekly review."

**Already in 1.1 (or shipped since 1.0), so not on the list.** CSV export on every data table and a printable payslip;
two-step verification (in place of the sign-in PIN); payday notifications ("You've been paid …" in **Needs attention**);
gauge saves that survive a dropped signal and replay safely, with today's event preselected and a live tally; nightly
backups with a guarded restore; bulk **Mark paid**; event forecasts and suggested targets; recruitment deadlines that set
themselves; the weekly review.

#### Now — the first weeks of 1.1

| Item | Why | Notes |
|---|---|---|
| **Optional assistant on the weekly review** | 1.1 deferred the LLM step. Owners and leaders want to ask "why was Tuesday quiet?" and get an answer in the same voice as the review. | Opt-in per company, behind its own switch; numbers still come only from the rule-based facts (the model words them, never calculates); private lines and check-in names never sent; works without it. |
| **Leader bulk gauge entry** | Leaders often collect the whole team's numbers at the end of the day. One screen, one row per rep, one save. | Validates every row against the funnel rule; same event-date and own-team rules as the single form; goes through the 1.1 outbox when the signal drops. |
| **Marking a transfer as failed from the app** | A bounced payment shows up in **Runs to pay** and the review, but flagging it as failed is still not a button. | One action on the run, with a reason; keeps the on-time maths unchanged. |
| **Audit trail for pay and stage changes** | When a payslip is queried, show who changed what and when. | Stage changes already keep history; extend to payroll (who marked it paid, bulk or single) and gauge edits. |
| **Announcement read receipts** | Leaders want to know the message landed. | Count of people who opened it, no names on the public view. |

#### Next — the following quarter

| Item | Why | Notes |
|---|---|---|
| **Installable app** (PWA) | 1.1 already keeps saves on the phone; an icon on the home screen and a cached shell make it feel like an app on a hotspot. | Manifest and service worker for the shell only; the outbox stays the source of truth for saves. |
| **The review, delivered on Monday** | The review is ready on Monday morning; people should not have to open the app to see it. | In-app first; push or email once we have consent. Private lines only to their owner. |
| **New-starter documents with e-signing** | Hiring ends with paperwork in a folder. | Triggered when a candidate is hired; store signed PDFs, not just a flag. |
| **Interview scheduling with calendar invites** | Observation days get missed when they live only in a message thread. | `.ics` to candidate and interviewer; outcomes recorded from the same screen (the 1.1 outcome prompt already asks). |
| **Client reporting portal** | Clients ask for weekly numbers on their campaign. | Scoped to one campaign, no personal data about reps, revocable link; can reuse the campaign lines of the review. |
| **Progression tracker** | Make the ladder visible: what a trainee needs to reach field rep. | Criteria defined by the business; distance to target, never a verdict (same copy rules as §14.0). |

#### Later — when the business asks for it

| Item | Why | Notes |
|---|---|---|
| **Single sign-on** (Microsoft 365 or Google Workspace) | Replaces email + employee ID once the company has managed accounts. | Keep employee ID as the display identifier; two-step stays for anyone outside SSO. |
| **Off-site backup copies** | 1.1 takes nightly backups on the same machine; a second copy elsewhere protects against losing the machine. | Encrypted copy to cloud storage; the guarded restore already exists. |
| **Accounting export** (Xero or Sage) | Push approved pay runs and expenses straight into the ledger. | Only after the audit trail is in place. |
| **Multi-office support** | If Linear opens a second city, teams and events need an office dimension. | Mostly a data-model change plus filters. |
| **Partner API tokens** | Let a client or a payroll provider pull data without a user session. | Scoped, expiring tokens; rate-limited. |

The "Not planned" list stays as it is.

## Version 1.1.0 (for the merge step)

Code and packages are bumped (see API → Version). Strings in the main docs that p9 did not edit and that still say
1.0.0: `docs/USER_GUIDE.md` footer (`*Linear Hub v1.0.0 — …*`), `docs/PITCH.md` footer, and the first line of
`docs/ROADMAP.md` (replaced by the intro line above). `client/src/content/about.ts` keeps `releaseDate: '2026-10-15'`
(not shown anywhere in the app); set it to the 1.1 release day when it ships.
