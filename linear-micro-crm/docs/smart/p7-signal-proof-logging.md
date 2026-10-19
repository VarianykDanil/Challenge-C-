# p7 — Signal-proof logging

Goal: never lose a rep's day to a dropped hotspot. Linear Hub says clearly when it cannot reach the server, keeps gauge
saves on the phone and replays them safely, preselects today's event so logging is two taps, and offers a live tally
counter for the shift.

## API

### Logging when the signal drops (p7)

**No endpoint was added or changed.** The outbox replays through the existing gauge routes, and every role rule, the
funnel check, the paid-week lock and the check-in rules still apply to a replayed save.

| Step | Request | Meaning |
|---|---|---|
| Look the day up | `GET /gauges?eventId=&userId=&from=<date>&to=<date>&limit=5` | The entry the server holds now for that (event, person, date), if any. A rep may only read their own (403 otherwise). |
| Send | `POST /gauges` (the upsert) | **201**: logged. **200**: the server found the day and updated it. Any other **4xx** (400 future check-in or event not started, 403 scope, 409 week paid or event cancelled): the item is marked *Not accepted* with the server's message. **401**: replay stops and the item waits for the next sign-in. **5xx**: replay stops and tries again later. |

The `(eventId, userId, date)` upsert makes a repeated send idempotent: the same body sent twice answers 201, then 200,
and leaves one row (`server/src/test/p7-outbox-replay.test.ts`).

Client contract (`client/src/api/client.ts`, additive):

| Name | What it is |
|---|---|
| `NetworkError` / `isNetworkError(e)` | Thrown when `fetch` gets no HTTP answer at all (it threw a `TypeError`: no signal, the hotspot dropped, the server is stopped). Every HTTP error response is still an `ApiError`, unchanged. An abort (`DOMException`) passes through untouched. |
| `window` event `lm:network`, `detail: { online }` | `false` when a request got no answer; `true` whenever any HTTP response arrives, whatever its status. |
| Unhandled `NetworkError` | A rejection nobody caught (for example signing out without signal) is not printed as "Uncaught (in promise)": the offline banner already reports it. Other rejections are untouched. |

Storage on the phone (per browser, never sent anywhere):

| Key | Holds |
|---|---|
| `lm-gauge-outbox:<signed-in userId>` | Up to 50 queued saves: `{ id, queuedAt, input: GaugeUpsertInput, expectedExistingId, seenSubmittedAt, eventName, userName, status: 'waiting' \| 'review' \| 'failed', error?, server? }` |
| `lm-tally:<userId>:<eventId>:<date>` | `{ counts: GaugeTotals, updatedAt }` for one shift's tally |

## Logic

### 14.7 Logging when the signal drops (p7)

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

**The outbox** (`client/src/features/gauges/outbox.ts`):

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
  sent twice in two versions.
* **When the phone can't keep it.** At most 50 items per person. If storage is unavailable (some private modes),
  full, or at the limit, nothing is queued and the form shows its usual error, so nothing is ever dropped silently.
* **Replay** (`replayAll`) is single-flight and oldest first. For each waiting item it:
  1. Looks the day up.
  2. Clears the item if `sameGaugeDay` matches.
  3. Applies `replayDecision`. **review** stores the server's version (`server: { id, submittedAt, stops, sales }`)
     and sends nothing; when the entry the form had shown was deleted meanwhile there is no `server`, and the sheet
     says **Linear Hub no longer has the entry you changed — it may have been deleted. Sending yours logs this day
     again.** **send** POSTs the upsert.

  It re-reads the list after every item, so anything queued meanwhile goes in the same run. A `NetworkError`, a 401
  or a 5xx stops the loop. After any send, every gauge-dependent query is refetched.
* **Replay triggers.** Mounting the app shell (that is, after sign-in), the browser's `online` event, `lm:network`
  turning from false to true, and **Send now**.
* **Send mine anyway** POSTs a *review* or *Not accepted* item whatever the server holds. A null check-in or note is
  left out, so a colleague's recorded check-in or note is kept, not cleared. For a deleted entry it creates the day
  again, which is the person's explicit choice.
* **Scope.** Replay only ever reads the signed-in person's key. Signing out with items asks first and deletes nothing.
  The server enforces who may write what.
* **A save from the form** for a day that is also kept on the phone replaces the kept copy, so it never comes back
  as a review.

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
* **Check-in chip.** **Checking in? Use now (09:58)** shows only when all of these hold:
  * the selected event is today;
  * there is no existing entry;
  * the check-in is empty;
  * `inCheckInWindow(start, now)` is true.

  One tap fills the check-in. It never fills itself, so an end-of-day form cannot record a punctual arrival. The form
  re-reads the clock every 30 seconds, so the chip and the "starts at" block follow the time while it is open.
* **Rep for leaders and admins.** Without a `defaultUserId`, a leader or admin starts on `firstMemberWithoutEntry`
  (taken from the event's entries), with the hint **First on the team without an entry yet**. The existing-entry
  lookup waits until that choice is made.
* **Without signal**, the event picker and a leader's rep picker fall back to the lists already loaded this session
  (the dashboard's upcoming events, event lists and pages, team lists). The hint then says so.

**The tally** (`features/gauges/TallyMode.tsx`, `tallyStore.ts`):

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

**Edge cases and limits.**

* **Browser offline, storage blocked.** The modal does not offer the phone. TanStack Query holds the save until the
  browser is back online, as in 1.0.
* **No service worker or HTTPS (out of scope).** The outbox protects saves while the page stays open. A page whose
  code was never downloaded cannot open without signal (it shows **This page hit a problem**).
* **The kill switch** (`LM_SMART=0`) does not turn the outbox off: it is a reliability feature and builds no smart
  payload.

## User guide

### If the signal drops (p7)

**Reps, leaders and admins** (anyone who logs gauges):

* **When the signal drops** — or Linear Hub itself is not running — an amber strip appears under the top bar: **Can't
  reach Linear Hub — check the hotspot. Gauges you save are kept on this phone.** It goes away by itself when the
  connection is back; **Try again** checks straight away.
* **Logging without signal.** Log gauges as normal. The button reads **Save on this phone**. You'll see **Saved on
  this phone — it will send when you're back online**, and a blue strip says **1 entry waiting to send**.
* **When the signal is back**, it sends by itself and tells you **Sent from this phone — logged** (or **— updated
  your earlier entry**). Tap **Send now** to try straight away, or **View** to see what is waiting.
* **If someone changed the same day while yours was waiting** — for example your leader corrected it — your entry is
  not sent over theirs. The strip says **1 entry needs a look**. Tap **Review** to see both versions, then choose:
  * **Send mine anyway** to replace theirs with yours;
  * **Open** to edit yours first;
  * **Discard** to keep theirs.

  The same happens if the entry you were changing was **deleted** while yours waited: the sheet says **Linear Hub no
  longer has the entry you changed — it may have been deleted.** **Send mine anyway** logs the day again;
  **Discard** leaves it deleted.

  If Linear Hub refuses an entry (for example a check-in time in the future from a phone clock that is wrong), it
  shows **Not accepted** with the reason.
* **Signing out.** If entries are still waiting, Linear Hub asks first: **1 entry hasn't been sent — it stays on this
  phone and sends next time you sign in as Jordan.** Nothing is deleted.
* **Private browsing.** Some private modes don't let Linear Hub keep anything on the phone. Then a save without signal
  shows **Could not save gauges**, as before. Keep the form open and save again when you have signal.
* **Two taps to log.** Opening **Log gauges** from the dashboard or the Gauges page on a day when your team has one
  event under way picks it for you (**Today's event selected**). Around the start of an event (from an hour before to
  an hour and a half after) a **Checking in? Use now (09:58)** button appears. Tap it to record your arrival; it never
  fills itself in.
* **Leaders and admins:** there, **Rep** starts on the first person in the team who hasn't logged that event yet. From
  an event's own page it still starts on you.

**Tally — count your shift as you go** (reps, leaders and admins):

* **Opening it.** Tap **Tally** on the Gauges page, or **Count your shift** on the dashboard's Upcoming events card.
* **Counting.** Tap the big **+1** next to Stops, To table, Presentations, Closes, Taps and Sales as it happens; the
  small **−** takes one off. The tally keeps the funnel in order: you can't add a sale before the tap that led to it,
  and it tells you why in one line.
* **Your counts are safe** on the phone through reloads and lost signal. The **Tally** button shows today's stop
  count, and the dashboard says **Carry on counting**.
* **Finish shift** opens Log gauges with your counts filled in: check them, add your check-in or notes, and save
  (without signal it is kept on the phone like any other save). The tally then clears.

**Recruiters** see the same amber strip when Linear Hub can't be reached, without the line about gauges.
