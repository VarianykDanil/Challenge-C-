# p6 — Event forecasts and roster gaps

Fragment for the final docs merge: `## API` → API.md "Event forecasts (p6)", `## Logic` → LOGIC.md §14.6,
`## User guide` → USER_GUIDE.md "Event forecasts and who has not logged yet (p6)".

## API

No new endpoint and no schema change. p6 fills two builders that p1 wired (`server/src/lib/smart/eventForecast.ts`)
and adds a third, `eventRosters`, attached by the same p1 helper in `routes/events.ts` (two optional fields in all).

**`forecast?: EventForecast` on `GET /events` and `GET /events/:id`** (`SalesEventWithMeta`)

- Present only on **scheduled** and **live** events that have enough history (see Logic). Completed and cancelled
  events never carry the key; neither does any event with `LM_SMART=0`. Every role that can list an event gets its
  forecast. It is a team-level estimate, never anyone's personal figure. Reps only ever list their own team's
  calendar, as before.
- Shape:

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

- Present on **completed** and **live** events dated **today − 2 … today** (business clock), and absent otherwise and
  with `LM_SMART=0`. `members` is the event team's **active** members who had **started by the event date**.
  `logged` is how many of **them** have an entry. Admins with no team, and people from other teams who logged at
  the event, are not counted, so `logged ≤ members` always. `repCount` is unchanged and still counts everyone with
  an entry, so it can be larger than `logged`. These are the same people as the event page's "Not logged yet" list.
- It holds counts only (no names), for events the caller can already list.

**Cost.** One request makes at most **3 grouped SQL statements**, whatever the number of events: forecast
attendance, forecast rates and roster counts. A statement is skipped when no listed event needs it. The grouped
results are **memoised** per database, data version, business day and id set (64 sets per slot, and the 20 s cache
TTL as a backstop). Every mutating API request and every maintenance job bumps the data version, so a saved gauge
shows on the very next read. Repeated reads run no forecast or roster SQL; only the per-event maths runs, including
the live flag, which moves with the clock. The rates query pins `idx_events_date`, so its cost follows the 12-week
window, not the campaigns' whole history. Nothing is ever written.

Measured on the demo seed (business clock pinned at 15:00, same seed, 300 sequential requests, 2 rounds; baseline
9315647 → first p6 → p6 now):

| Request | Mean ms | Req/s at 50 connections |
|---|---|---|
| admin `GET /events` (89 events) | 4.6–5.8 → 8.5–9.6 → 5.6–6.1 | 237–272 → 142–161 → 205–247 |
| admin, next 2 weeks (47 events) | 3.3–3.5 → 6.9–7.0 → 4.0–4.5 | — |
| leader, next 2 weeks | 3.6–3.8 → 7.4–8.2 → 4.2–4.3 | 426–460 → 182–183 → 377–392 |
| rep `GET /events` | 2.9–3.4 → 5.5–5.9 → 3.0 | — |
| admin `GET /events/527` | 4.1–4.5 → 5.6–5.9 → 4.3–4.9 | — |

The remaining gap is mostly payload: the admin list grows from 43 to 55 kB with the two new fields.

**`GET /events/forecast?campaignId&teamId&type[&targetSales]`** → `{ forecast: EventForecast | null }`

- Role rules and validation are p1's: admin for any team, a leader for their own team only. Every other case answers
  `403`, and bad parameters answer `400`. The response is cached (`CACHED_PATHS`).
- The forecast is for a new **scheduled** event of that team, campaign and type. Without `targetSales`, `repsNeeded`
  and `flag` are `null`. The answer is `{ forecast: null }` when the team has fewer than 5 attended days in 8 weeks,
  or when no bucket has 5 completed days in 12 weeks (a brand-new campaign, for example).

**Client only (no API):** directions links are built in the browser as
`https://www.google.com/maps/search/?api=1&query=<encodeURIComponent("venue, city")>`. The dashboard's
**Upcoming events** card fetches `GET /events?from=<first upcoming date>&to=<last>[&teamId]` and matches forecasts
by event id. `/me/dashboard` is unchanged (lead's decision). The "Not logged yet" list uses
`GET /users?teamId&status=active`, which only runs for the admin or that team's leader.

## Logic

Rules in `shared/src/logic/eventForecast.ts` (pure, unit-tested) and `EVENT_FORECAST_RULES`:
`attendanceWeeks 8, rateWeeks 12, minBasisDays 5, z 1.64, stretch 1.3, atRisk 0.7, targetPercentile 0.6`.

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
  type over 12 weeks when there are ≥ 5 such events, else round(E). It is clamped to 0…500.
- **Copy** (LOGIC §14.0): the chip reads "expect ≈ 14 (9–20) · 5 reps usually". The range is always visible,
  because a phone has no hover and tapping a row opens the event. The tooltip and the event page read "Estimate
  from 23 similar days (Deansgate team, BCN private sites, last 12 weeks) · range 9–20 · target 17 needs about 7
  reps". The team is named, never "this team", so the line reads right for anyone looking at another team's event.
  A name already ending in "team" is not doubled. The basis reads "all teams, …" for the company bucket and "all
  teams, every BCN day" for the campaign bucket. Type words: private sites, events, B2B sites, residential patches, retail sites. The `at_risk` pill reads
  **Behind target**, the wording the copy guide allows for events (never people); `stretch` reads **Stretch**.
  Output is deterministic.

Event rows (client):

- **Tone**. Scheduled events, and live ones whose start time has not come, show **Target N** with a neutral grey
  bar. Live events after their start and completed events keep green (≥ 100 %), primary (≥ 50 %) or amber (< 50 %).
  Cancelled events stay red.
- **"N / M logged"** replaces the rep count on **completed or live events dated today − 2 … today**. It comes from
  the server's `roster`: M = the event team's active members who had started by the event date, N = how many of
  them have logged. It is amber while N < M. It never reads N > M, and it agrees with the event page's list. An
  admin or someone from another team who logged there counts in `repCount`, not in N. Older gaps are history and
  are not tinted. Without `roster` (`LM_SMART=0`), the row shows the plain rep count as before. The window rule
  is shared (`inRosterWindow`, `EVENT_ROSTER_LOOKBACK_DAYS = 2`).
- **Not logged yet** (event page): shown to the admin, or to that team's leader (the same rule as managing gauges),
  on live or completed events in the same window. The list is the team's active members who had started by the
  event date, minus everyone with an entry, sorted by name. Recruiters and other teams' people never get the list,
  and the users query does not even run for them.
- **Log today's gauges**: a rep with no entry on today's live (or just-ended) team event sees this label on the
  event page's main button.
- **Dashboard Log gauges**: shown for today's events that have started, to people who may log there (admin; a
  leader or rep at their own team's event). It links to `/gauges?log=1&eventId=<id>`.
- **Directions**: every event row (Events page and dashboard) has a 40 px icon link, and the event page has a text
  link. Both open in a new tab with `rel="noopener noreferrer"`.

Edge cases: a team with fewer than 5 attended days in 8 weeks gets no forecast and its rows look exactly as before.
When there is no suggestion (thin history, a team that rarely works, or `LM_SMART=0`), the New event form says
"No suggested target for this team, campaign and type. Set the target as usual." It gives no reason, because the
browser cannot tell which case applies.
On a Sunday the seed has no events, so there is simply nothing to forecast. The **New event** form asks for the
forecast without a target (one cached request per campaign, team and type) and works out "needs about N reps" and
the Stretch pill in the browser with the same shared rules, so typing never sends a request.

## User guide

**Event forecasts.** Upcoming and live events now show what to expect, for example
**expect ≈ 14 (9–20) · 5 reps usually**: an estimate of about 14 sales, likely between 9 and 20, with the 5 people
who usually turn up. It is based on the team's own similar days over the last 12 weeks. Hover over it, or open the
event, to see what it is based on and how many people the target needs: "Estimate from 23 similar days (Deansgate
team, BCN private sites, last 12 weeks) · range 9–20 · target 17 needs about 7 reps". An amber **Stretch** pill means the target is
well above what the team usually sells on days like this. A red **Behind target** pill on a live event means the day
is unlikely to reach 70 % of its target at the usual pace. Events without enough history show no estimate.

**Upcoming days are neutral.** Events that have not started show **Target 17** with a grey bar instead of an amber
"0 / 17". Colour starts once the day is under way.

**Suggested target (admins and leaders).** In **New event**, once you have picked the campaign, team and type, you
see **Suggested target: 14** with a **Use** button. It is only a suggestion: tap **Use** to put it in the
**Sales target** box, or type your own. Nothing is changed for you. It also tells you how many reps the typed target
needs. When there is no suggestion for that choice, the form says so and you set the target as usual.

**Who has not logged yet (admins and team leaders).** On the Events page, today's and the last two days' events read
**4 / 7 logged**, in amber while someone on that team is missing. The 7 is the team's active members who had started
by that day. Someone from outside the team who logged there (an admin helping out, say) does not count towards the
4, so the row always matches the event's own list. Open the event to see **Not logged yet** with one button per
person. Tap **Log for Sophie** to open **Log gauges** with Sophie already chosen. Once you save, her button goes.
Reps, recruiters and other teams never see this list.

**Reps.** If you have not logged today's event yet, its page says **Log today's gauges**. On the dashboard, today's
event (once it has started) has a **Log gauges** button that opens the form for that event.

**Directions.** Every event row has a directions button (the arrow icon), and the event page has a **Directions**
link. It opens Google Maps (the Maps app on a phone) at the venue.
