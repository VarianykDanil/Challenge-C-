# P8 venue-insights and event plans

Every venue's numbers prove the law of averages; everyone booked on an event sees how many stops, tables, presentations, closes and taps make a good day there.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P8 venue-insights**.

Code: shared `logic/venues.ts` (the maths, pure, unit-tested in `logic/venues.test.ts`) and `types/venues.ts`; server
`lib/venueInsights.ts` (venue figures and plans), `lib/eventRoster.ts` (booking rules), `routes/venues.ts`,
`routes/eventPlans.ts`, `routes/events.ts` (`bookings` on events), `lib/smart/eventForecast.ts` (bookings feed
forecasts), `lib/audit/venueSpecs.ts`, `db/extensions/venues.ts` (demo bookings); client `pages/Venues.tsx`,
`pages/VenueDetail.tsx`, `features/venues/*`, `pages/Events.tsx`, `pages/EventDetail.tsx`, `features/events/*`,
`features/dashboard/UpcomingEvents.tsx`, `pages/QuickGauges.tsx`. Route tests: `server/src/test/venues.test.ts` and
`server/src/test/venues-rules.test.ts` (the booking rules after review: every forecast caller agrees, walk-ups, the
self-booking floor, leavers, scoped error messages, other teams' plans, aims on the events list, statement counts).

## API

Every endpoint needs a signed-in **staff** account: anonymous → 401, a client account → 403 `clientPortalOnly` (the
client guard, before any router). Nothing here writes a gauge row or touches pay.

### Venues (`routes/venues.ts`, every staff role, response-cached)

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

### Bookings and plans (`routes/eventPlans.ts`, mounted at `/events` before the events router)

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

### `bookings` on events (`routes/events.ts`)

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

### Audit (`lib/audit/venueSpecs.ts`, entity `event_roster`, filed under the event's id)

- `PUT /events/:id/roster` — "Bookings for BCN — Golden Square, 22 Oct: booked Jordan Lee and Sam Patel; took off Alex Kim"
- `POST /events/:id/roster/me` — "Jordan Lee is working BCN — Golden Square, 22 Oct (I'm working this)"
- `DELETE /events/:id/roster/me` — "Jordan Lee can no longer work BCN — Golden Square, 22 Oct"

Before/after snapshots: `{ event, date, booked: [names], count }`. A save that changes nothing writes no row.

### Database (`db/extensions/venues.ts`)

`event_roster (event_id → events CASCADE, user_id → users CASCADE, booked_by, booked_at, source; PK event + user)`, as
the foundation laid it down; `upgrade` adds nothing (an existing database gets the empty table: nobody is booked until
a leader books, so its forecasts are exactly as before). The fresh demo seed books the scheduled and live events of the
next 14 days from the extension's own random stream: the **coming week is the leader's roster** (nine in ten of each
team booked, most by the leader, the rest by themselves); **further out only self-bookings** (about two in five have
tapped "I'm working this"), so those forecasts keep the team's usual turnout as their floor. The demo rep Jordan Lee
is booked on his team's first three upcoming events (two by Amelia, one by himself) and not on the fourth, and Amelia
books herself on today's event. Only `event_roster` rows are written.

## Logic

All the maths is in `shared/src/logic/venues.ts` (`VENUE_RULES`), unit-tested against hand-computed fixtures.

**What counts.** A **shift** is one gauge entry: one person at one event on its day. Only **finished days** count:
entries on events dated before today (business clock) that are not live, so a half-logged day never drags an average
down (cancelled events with entries count, as everywhere else: the work was done). A **visit** is an event at the venue
with at least one counted shift. Every finished shift ever logged at a venue counts.

**The law of averages** (venue profile):

- **Fitted rate** = Σ sales ÷ Σ stops — the line through the origin fitted by weighted least squares with variance
  proportional to stops (sales from N stops behave like a Poisson count), which is the plain pooled rate.
  `stopsPerSale` = Σ stops ÷ Σ sales. `correlation` is Pearson's r of stops and sales per shift (null below 3 shifts).
- **Sentence**: "At Golden Square, every 26 stops made a sale on average, steady across 89 shifts." N = round(stops ÷
  sales). Under 5 shifts: "…made a sale so far, but 3 shifts are too few to call it a pattern yet."; no sales: "No sales
  at X yet across 4 shifts (240 stops)."; no shifts: "No shifts logged at X yet." The steadiness word is the overall
  conversion's (below 3 visits it is left out).
- **Three groups by stops** (9 shifts or more): the shifts sorted by stops and cut at round(n/3) and round(2n/3); each
  group's stop range, average stops and sales per shift. The page adds "The busiest shifts (about 80 stops) sold 1.6
  times as much as the quietest (about 54): the rate holds, so volume is the lever."
- **Stability of each ratio**, visit to visit (each visit's shifts together; visits that reached the stage, at least
  3): CV = sample SD ÷ mean of the visits' ratios; **chance CV** = √(mean over visits of p(1 − p) ÷ n_visit) ÷ p, the
  spread binomial luck alone gives at the pooled ratio p with each visit's own numbers. **Steady** when CV ≤ max(1.5 ×
  chance, 0.05); **fairly steady** when ≤ max(2.5 × chance, 0.10); otherwise it **varies**. This is the proof: a steady
  ratio means the visits differ by no more than luck would explain — the rate belongs to the place, and more stops is
  the way to more sales.

**Who an event is expected to have** (`expectedHeadcount`; the forecast's `expectedReps` and the plan's
`sharedAmong`). The habit = the mean number of people over the team's completed events in the last 8 weeks (null below
5 such events). Counting only active people booked:

- nobody booked → the habit (the 1.1 rule, unchanged; null with too little history);
- booked by a **leader or the office** (any `source: 'leader'` row) → **the people booked**: the leader has done the
  roster, and a short crew should show as a short crew (Stretch / Behind target);
- **only self-bookings** so far → the **larger** of those booked and the habit: a roster still filling up is a floor,
  not the crew (no false Stretch flags, no inflated shares);
- a **live** event with bookings → at least the people who have **logged it** so far (walk-ups, an unfinished roster),
  so the estimate never falls below what is already happening.

On the demo seed, 21–28 Oct: 9 of 26 open events are flagged Stretch against 8 with the habit alone (the extra one is
a genuinely short crew: 4 of 7 booked on a target of 19); before these fixes and the seed change below it was 14.

**The event plan** (each booked person, scheduled and live events):

1. Counts: the person's own finished shifts in the **last 8 weeks**, anywhere (`ownShifts`); every counted shift at the
   event's venue (`venueShifts`); the company's counted shifts.
2. Ratios, stage by stage (stop → table … tap → sale):
   `location = w_v × venue + (1 − w_v) × company`, `w_v = venueShifts ÷ (venueShifts + 10)`;
   `ratio = (1 − w) × own + w × location`, `w = 10 ÷ (ownShifts + 10)` = **venueWeight** (1 with no own shifts, 0.5 at
   10, about 0.24 at 32). A stage with no data on one side (its stage before is 0) takes the other side alone; a stage
   with no conversion anywhere makes the plan impossible (no steps).
3. Target from the **event's share** ⌈event target ÷ sharedAmong⌉ (sharedAmong = round(expected headcount), at least
   1) and a **good day** — round(75th percentile, type 7) of the person's sales per shift over the 8 weeks (at least 1;
   needs 5 shifts), else the venue's good day:
   - a good day above the share → the **good day** (strong people aim for their own good day);
   - a share up to 1.5 × the good day, or less than 2 sales above it → the **share** (never below the team's need; a
     tie is the share);
   - a share **more than 1.5 × the good day and at least 2 sales above it** → the **good day**, flagged
     `shareAboveGoodDay`; the page says "The event's target works out at 7 sales each for the 3 booked, well above a
     good day, so the plan aims for a good day." (An aim nobody reaches helps nobody; the forecast's Stretch flag tells
     the leader.)
4. Steps: `conv_s` = the product of the ratios from stage s down to a sale; **need = ⌈T ÷ conv_s⌉** (an epsilon keeps an
   exact multiple exact). **Range**: λ_low and λ_high solve λ ± √λ = T (one standard deviation of Poisson luck, about
   two days in three); low = round(λ_low ÷ conv_s) but never under T, high = round(λ_high ÷ conv_s) but never under need.
   For 10 sales: λ 7.30 – 13.70.
5. Sentence: "To make 5 sales at Golden Square you need about 120 stops → 42 to table → 21 presentations → 9 closes →
   6 taps." The one-line aim: "120 stops → 42 → 21 → 9 → 6 taps for 5 sales".

Worked example (route test, hand-computed and re-checked independently): own 8 shifts of 100 / 35 / 18 / 7 / 4 / 4;
venue 12 shifts of 80 / 28 / 14 / 6 / 4 / 2; company both. w = 10/18, w_v = 12/22 → ratios 0.35 · 0.5080 · 0.4063 ·
0.6138 · 0.7727. One person (a self-booking; the team usually has 1) on a target of 10: the share is 10, more than 1.5 ×
his good day of 4 and 6 above it → he aims for **4 sales: 117 stops → 41 to table → 21 presentations → 9 closes → 6
taps**, stops range 71–191. The same ratios for 10 sales give 292 → 103 → 52 → 22 → 13, stops 213–400.

**By campaign and weekday** (venue profile): each campaign's and each weekday's six gauges per shift and five stage
ratios at the venue, against the **same campaign / weekday** company-wide (from the venue index: no extra query).

**Cost.** The venue index is one grouped query over events and their gauge totals; a venue's shifts one more (its
events only). Plans for any number of events and people (one event's page, or the aims on a whole events list) cost at
most two more — the people's 8 weeks, and the venues' shift sales for anyone with fewer than 5 own shifts — plus the
forecast's headcount query, shared with the forecasts of the same list (a test counts exactly 4 statements for 12
events × 2 people, and 0 once remembered). Booking summaries on event lists are one grouped query. Everything is
memoised per database, data version and business day (every write bumps the version), and `/venues…` and
`/events/:id/plan` sit behind the response cache. On the demo seed the list and a profile answer in about 20 ms and 10
ms uncached. The forecast still runs at most 2 statements per call (the bookings ride in the habit's query).

**Kill switch.** `LM_SMART=0` empties plans (estimates) and leaves venue numbers, bookings and the roster on (figures
and workflow).

## User guide

**Venues** (sidebar, under Events; or **Venues** at the top of the Events page). Every venue the team has worked, each
with its sales a shift, shifts and visits, "a sale every N stops", the last and next visit and its campaigns. Sort by
**Sales a shift**, **Shifts** or **Last visit**, or search by venue or town. The bar under each venue compares its sales
a shift with the best listed; the tick marks the company-wide figure. Venues with fewer than 10 shifts come after the
rest when sorting by sales a shift: a handful of shifts is too few to rank. **Export CSV** downloads the list (and
**PDF** once PDF exports arrive).

**A venue's page** (tap a venue, or **Venue numbers** on an event's page):

- Four tiles: sales a shift, stops per sale, stops a shift (each against the company) and shifts.
- **The law of averages**: the sentence ("At Golden Square, every 26 stops made a sale on average, steady across 89
  shifts."), a dot for every shift (stops across, sales up) with the fitted line, the shifts in three groups by stops
  (fewest, middle, most) and how steady each step is from visit to visit — **Steady** means the visits differ by no more
  than luck alone would explain.
- **A shift here and company-wide**: each gauge per shift and each step's rate, here and across the company (▲ / ▼ when
  a step is more than 5% above or below).
- **By campaign**: each campaign's sales a shift here and company-wide; pick a campaign to see its six gauges and five
  steps here against the same campaign everywhere. **By weekday**: sales a shift by day, then pick a day for the same
  comparison (Mondays here against Mondays everywhere).
- **Your numbers here** and **Events here** (coming up, with who is booked, then earlier ones with their sales).
- **Venue report** (once PDF exports arrive): the whole page as a PDF — the law of averages, the comparisons, how
  steady each step is, the events (and, for the office and leaders, the people).
- **People here** — the office sees everyone who worked the venue; a leader sees their own team. Reps see the venue's
  numbers and their own, never a colleague's.

**Who's working** (an event's page). Everyone booked, with who booked them ("booked yourself", "booked by you",
"booked by Amelia Hart"). A leader (or the office) taps **Edit bookings**, ticks the team members working that day (or
**Tick the whole … team**) and taps **Save bookings**. Saving changes only the people ticked or unticked, so someone
who books themself while the list is open stays booked. Someone on leave stays booked, marked "on leave". A rep taps
**I'm working this** on their team's events, or **I can't make it** to come off. Bookings close once the event is over or cancelled. Once a leader has booked people, the
forecast counts the people booked ("· 3 booked"); while only people's own bookings are in, it keeps the team's usual
number as a floor ("· 3 booked, 6 expected"). Someone who leaves drops off the list.

**Your plan** (an event's page, for everyone booked). "To make 4 sales you need about: 88 stops, 33 to table, 18
presentations, 8 closes, 5 taps", where the target comes from (the event's target shared among the people expected, or
your good day when that is higher — and when the share is far above a good day, the plan aims for a good day and says
so), the range most days fall in, and how much comes from your own last 8 weeks and how much from everyone's shifts at
the venue. A leader sees every booked person's plan under their own (someone the office booked from another team: a
plan from the venue's numbers only). The same plan shows in one line as **Aim** on the event's row in Events, on the
dashboard's upcoming events and in Quick gauges, where it takes the first line under the event ("Aim 4 sales · 88
stops → 33 → 18 → 8 → 5 taps", cut short with "…" on a small phone) and the help keeps its first sentence, so all six
tiles stay on one screen. Plans are estimates: luck evens out over many shifts, not in one.

## Owner notes

- **Decisions made for you** (change any of them in `VENUE_RULES`, shared/src/logic/venues.ts):
  - A plan leans on your own numbers once you have some: 10 shifts in the last 8 weeks is half yours, half the venue's;
    a new starter's plan is all the venue's (and a new venue's all the company's).
  - The plan's target is the **higher** of the event's target shared among the people expected and the person's good
    day (their 75th-percentile day over 8 weeks) — so nobody is told to aim below what the team needs, and strong
    people aim for their own good day — **except** when the share is more than 1.5 × the good day and at least 2 sales
    above it: then the plan aims for the good day and shows the share as a note (`shareStretch`,
    `shareStretchMinGap`). Please confirm: the alternative is always to aim for the share and only add the note. In
    the demo this caps the aim of a newer rep whose good day is 1 sale on events that need 3 each.
  - **Who an event is expected to have** (forecasts and plans): the people booked once a leader or the office has
    booked anyone; while only self-bookings exist, at least the team's usual turnout; on a live day, at least the
    people who have logged. "A leader has booked" is read from the rows (any booking made by a leader or the office):
    if everyone booked themselves and the leader saves the list without adding anyone, it still counts as filling up.
    Say if you want an explicit "roster done" button instead.
  - Someone the office books from another team: their leader at that event sees a plan from the venue's numbers only
    (their own numbers stay with their own leader). **Please decide (last fix round, not changed):** that plan's aim and
    steps can differ from what the person sees on their phone, because their own good day and ratios are left out. For
    example, the leader sees "4 sales: 98 stops…" and the person sees 2. There are two ways out:
    - (a) aim that plan at the event's share only. This reveals nothing, but the steps still differ.
    - (b) work the aim and the steps out from the person's own numbers on the server and send only those (no good day,
      ratios or basis). The leader and the person then see the same numbers, but the steps hint at the person's own
      ratios.
  - The range is one standard deviation of luck either side (about two days in three). It is wide on purpose for small
    targets: that is the law of averages, and the page says so.
  - "Steady" compares the visit-to-visit spread with what luck alone would produce (within 1.5 ×).
  - Rankings ignore thin data: venues with fewer than 10 shifts and people with fewer than 3 shifts at a venue are
    listed after the rest.
- **Bookings feed every forecast** — the event row, the event page, Needs attention ("behind target") and the leader
  digest all agree. Once a leader books people, the estimate is for the people booked: book the whole crew, or the
  estimate (and the **Stretch** flag) will reflect the few booked so far — useful as a reminder to book. Self-bookings
  never lower an estimate below the team's usual number, and on the day people who turn up and log count even if
  nobody booked them.
- **People who leave** drop off every booking list and count straight away (their future bookings are hidden, not
  deleted). **People on leave** stay booked and counted, marked "on leave": take them off an event they will miss.
- **An upgraded database starts with nobody booked**, so its forecasts and pages look exactly as before until leaders
  book. The demo seed books the next two weeks.
- Venues merge by name and town however they were typed (case, spaces, punctuation), but "Trafford Centre" and "The
  Trafford Centre" are two venues: keep venue names consistent in the New event form.
- Nothing stops one person being booked on two events on the same day (a split shift, or a mistake). Say if you want
  bookings to refuse a clash.
- The venue list and a venue's events export as CSV now; P4's PDF export appears in the same **Export** button when it
  lands, and the **Venue report** button (the whole page as a PDF, built on P4's page primitives) appears beside it at
  the same time. Until then the report code is not even in the app (the build leaves it out); its builder was run
  against 60 real venue pages with a stand-in PDF writer.
- Demo data: Golden Square is in Warrington in the seed (`/venues/golden-square--warrington`).
