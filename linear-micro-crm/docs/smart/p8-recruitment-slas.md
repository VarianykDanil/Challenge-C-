# p8 — Recruitment SLAs

Next-action deadlines now mean something: every open stage has a target number of days, moving a candidate sets the
new stage's deadline from it, candidates who sit in a stage past its target are badged **Idle**, and interviews that
have happened but still say *pending* ask for their outcome.

## API

No new endpoints and no response-shape changes: two write routes gain **defaults**, one gains an **optional body
field**, and all three that take a deadline now **validate it the same way**. `GET` payloads are untouched (idle days
and outcome prompts are worked out by the client from `stageUpdatedAt` and the interview list it already has). The
demo seed is unchanged; seeded rows keep their dates.

"Today" below is the server's business date (`todayISO()`, Europe/London, honouring the business clock).

### `POST /recruitment/candidates`

- `nextActionAt` **omitted** → `today + 3 days` as a date-only `YYYY-MM-DD` (the Applied target), e.g. created on Mon 19 Oct
  → `"2026-10-22"`.
- `nextActionAt: null` → stays `null` (no deadline).
- An explicit value is stored as given, if it is a valid deadline (below).

### `POST /recruitment/candidates/:id/stage`

Body: `{ stage; note?; teamId?; position?; nextActionAt?: string | null }` → `CandidateWithMeta` (unchanged).

| `nextActionAt` in the body | Open target stage (`applied` … `offer`) | Closed target stage (`hired`, `rejected`, `withdrawn`) |
|---|---|---|
| omitted | `today + STAGE_SLA_DAYS[stage]`, date-only (`screening` on 19 Oct → `"2026-10-24"`) | `null` |
| `null` | `null` (no deadline) | `null` |
| `"YYYY-MM-DD"` or an ISO 8601 timestamp | stored as given | `null` (ignored) |

- This **replaces 1.0's behaviour of carrying the previous stage's deadline forward**, which is why most open
  candidates showed as overdue: a move now starts the new stage's clock.
- Accepted values: see **Valid deadlines** below.
- An admin reopening a `rejected`/`withdrawn` candidate to `offer` gets the Offer target (`today + 7`).
- `nextAction` (the text) still follows the stage (`Book first interview`, …) and is `null` for closed stages.
- `PATCH /recruitment/candidates/:id` never touches the deadline unless the body sets it.
- Effect on `GET /recruitment/summary`: a candidate moved without an explicit date is never overdue, so
  `overdueActions` drops as people are moved on.

### Valid deadlines (create, patch and stage move alike)

`nextActionAt` on `POST /recruitment/candidates`, `PATCH /recruitment/candidates/:id` and
`POST /recruitment/candidates/:id/stage` accepts `null`, a real calendar date `YYYY-MM-DD` (due that day, overdue from
the next), or an ISO 8601 timestamp starting `YYYY-MM-DDT…` whose calendar day exists (`2026-10-24T17:00:00Z`,
`2026-10-24T09:15:00+01:00`, `2026-10-24T09:15`). Anything else — `"garbage"`, `"2026-02-31"` (which `Date` would
quietly roll over to 3 Mar), `"Oct 24 2026"`, `"24/10/2026"`, `""`, a number, a boolean — is **`400 { error: 'Expected
a date (YYYY-MM-DD) or an ISO 8601 timestamp' }`** and nothing changes. This tightens create and patch, which in 1.0
took anything `Date.parse` could read; every value the app and the smoke test send is still accepted.

### Kill switch

`LM_SMART=0` does not turn p8 off: the deadline defaults, idle badges and outcome prompts all stay on. They are
write-time defaults on an existing field and client-side readings of fields every 1.0 payload already has, not smart
builders, and the client states the deadline it expects a move to set ("Phone screen · due Sat 24 Oct"); switching the
server default off behind the client's back would make that line wrong. A caller that wants no deadline sends
`nextActionAt: null`.

**Lead decision at merge** (the release notes say everything switches off with `LM_SMART=0`). Restoring 1.0 exactly
would take: in `server/src/routes/recruitment.ts`, when `!smartEnabled()`, create with an omitted `nextActionAt` → `null`
and a stage move with an omitted one → carry `candidate.nextActionAt` forward (closed stages still `null`); and a flag
the client can read (none exists today) so it can drop the `· due …` option labels, the toast's target, the Idle badges
and order, and the outcome prompts. The deadline validation above is not a smart feature and stays either way.

## Logic

Section §14.8. Everything lives in `shared/src/logic/recruitment.ts` (pure, tested in `recruitment.test.ts`; the
constants live there too, not in `constants.ts`).

### Stage targets

```
STAGE_SLA_DAYS = { applied: 3, screening: 5, interview: 7, observation: 7, offer: 7 }   // calendar days
```

`stageSlaDays(stage)` → the number, or `null` for `hired`, `rejected` and `withdrawn`.

### Default deadline

`defaultNextActionAt(stage, today)` = `addDays(today, STAGE_SLA_DAYS[stage])` as a **date-only** `YYYY-MM-DD`; `null`
for closed stages. Being date-only, the shared `isOverdue` rule treats it as due **on** that day and overdue **from the
next calendar day**: `defaultNextActionAt('screening', '2026-10-19')` = `'2026-10-24'`, not overdue on the 24th,
overdue on the 25th. A timestamp passed as `today` keeps its own day. UTC date arithmetic, so DST changes never shift
it (Offer from Thu 22 Oct → Thu 29 Oct across the 25 Oct clock change).

### Idle

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

### Outcomes to record

- `needsOutcome(interview, now)` = `outcome === 'pending'` and `scheduledAt ≤ now − OUTCOME_PROMPT_HOURS` (**2 h**).
  Exactly two hours counts; future, recorded (`passed`/`failed`/`no_show`) or unreadable interviews never do.
- `outcomesToRecord(interviews, me, ownerOf, now)` keeps the `needsOutcome` ones where `me` is the **interviewer** or
  **owns the candidate** (`ownerOf(candidateId) === me.id`); an **admin** gets them all. Oldest first, then by id.
  A candidate `ownerOf` does not know counts as not owned.
- The recruiter dashboard reads interviews from `today − OUTCOME_LOOKBACK_DAYS` (**56 days**) to `today + 14` (one
  request, replacing the default Monday → +14 window; the existing tiles filter by date exactly as before) and only
  lists interviews of candidates **still in the open pipeline**: a forgotten outcome on a rejected or withdrawn
  candidate is no longer anything to act on and would otherwise nag for eight weeks.
- **Recruiter dashboard tiles**: six KPI tiles, one row of six only from 1536 px (`2xl`); 2 columns on phones and
  3 columns (two rows) from 768 px, so no label is cut off at 1280–1535 px.

### Merge note: p5's Needs-attention feed (lead to reconcile)

p5's `recruitment:interview` attention item and this card ask for the same thing with two copies of the rule: p5 uses
its own `ATTENTION_RULES.interviewOutcomeAfterMinutes: 120` (same 2 h) and its route only loads pending interviews
within **±2 days**, while this card looks back **56 days**. Both skip closed candidates and both count interviewer or
candidate owner (admin: all). After merge a recruiter would see a fresh one twice on the dashboard (AttentionCard and
**Outcomes to record**), and an interview 3+ days old only in the card, so the bell can show fewer than the card.
Suggested: p5 imports `needsOutcome`, `OUTCOME_PROMPT_HOURS` and `OUTCOME_LOOKBACK_DAYS` from
`shared/src/logic/recruitment.ts` and widens its interview window to the same lookback; and pick one prompt for the
recruiter dashboard (e.g. the AttentionCard skips `recruitment:interview` items when **Outcomes to record** is shown,
keeping them in the bell for every role).

### Client rules

- **Idle badge**: `Idle {days}d` (warning tone, hourglass icon), with the full sentence for screen readers and as a
  tooltip: "22 days in Interview, target 7 days".
- **Longest idle first** (`compareLongestIdle`, within each board column and over the whole list): by
  `daysPastTarget = candidateIdleDays − STAGE_SLA_DAYS[stage]`, largest first. So **every idle candidate comes before
  every on-target one**, idle ones furthest past their target first, then on-target ones nearest to their target first.
  Ties: longer in the stage first (earlier `stageUpdatedAt`), then by id. Closed candidates (list with **Include
  closed**) and unreadable dates go last. Example: Applied for 5 days (target 3, +2, idle) comes before Interview for
  5 days (target 7, −2), whichever moved first.
- **Order select**. Board: *Recently moved first* (the server's order, `stage_updated_at` newest first) or *Longest idle
  first*. List: *Newest applicants first* (the default, the Applied column descending), *Recently moved first* (no
  column sort: the server's order) or *Longest idle first*. The list's sorting is controlled by the page, so the select
  always names the order on screen: a column header sort shows "Sorted by column", and clicking that header until its
  sort clears shows *Recently moved first*, which is the order the rows are then in. The choice carries across views
  (*Newest applicants first* has no board equivalent, so the board stays on *Recently moved first*).
- **Filter row** (search, source, owner, order): 40 px tall on phones (below 640 px) for tap targets, the compact 32 px
  from 640 px up.
- **Move to…** option labels: `{Stage} · due {EEE d MMM}` from `defaultNextActionAt(stage, today)` for open targets;
  closed targets keep the bare label. After a move the toast reads the deadline the server returned: "Next action due
  Sat 24 Oct (5-day target)" — the target is named only when the stored date is the stage default.
- **Due field** (candidate page): a date-only deadline shows as 23:59 on that day (due by the end of it) instead of
  01:00 in summer time, and the deadline is only sent when the field was changed, so saving notes never turns a
  date-only deadline into a timestamp.
- Deterministic: the same data and day give the same badges, order and sentences.

## User guide

### Recruitment deadlines

**Every candidate now gets a real deadline.** A new candidate is due a **Phone screen** within 3 days. Each time you
move someone to a new stage, their next-action date is set from that stage's target:

| Stage | Target |
|---|---|
| Applied | 3 days |
| Phone screen | 5 days |
| Interview | 7 days |
| Observation day | 7 days |
| Offer | 7 days |

The **Move to…** list shows the date each stage would set ("Phone screen · due Sat 24 Oct"), and the confirmation
says it again: "Next action due Sat 24 Oct (5-day target)". You can still change the date under **Notes & next
action → Due** on the candidate's page. Hiring, rejecting or withdrawing someone clears their deadline.

**Idle badges.** When someone has been in the same stage for longer than its target, an amber **Idle 9d** badge
appears on their board card, under their stage in the list view, and on the **Pipeline** card of their page. Moving
them on resets the count. To see who needs moving most, choose **Longest idle first** in the order menu next to
**Any owner** (it works on the board and in the list): everyone past their target comes first, the furthest past at
the top, then everyone else, the nearest to their target first. The same menu has **Recently moved first** and, in the
list, **Newest applicants first**.

**Record the outcome.** Two hours after an interview's start time, if its outcome still says *Pending*, the
candidate's page shows a **Record the outcome** card at the top with the outcome menu right there — pick **Passed**,
**Failed** or **No show** and it saves straight away. The interview also carries an **Outcome due** badge in the
**Interviews** list.

**Recruiter dashboard.** Recruiters get two additions:

- an **Idle beyond target** tile — how many open candidates have been in a stage longer than its target;
- an **Outcomes to record** card (only when there is something to record) listing interviews that have happened but
  still say pending — the ones **you ran or whose candidate you own** — oldest first, each with the outcome menu
  inline. Once you save an outcome the row disappears.

**Who sees what.** Recruitment pages are for recruiters, team leaders and the owner, as before; reps never see them.
The **Idle beyond target** tile and the **Outcomes to record** card are on the **recruiter** dashboard only, and the
card lists only your own interviews and candidates. Team leaders and the owner, whose dashboards lead with sales, see
idle badges on the Recruitment pages and the **Record the outcome** card on each candidate's page (and, from the
Needs-attention bell, interviews from the last two days that they ran or whose candidate they own; the owner sees them
all).
