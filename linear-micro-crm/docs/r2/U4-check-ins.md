# U4 check-ins: one-tap check-in that never creates a gauge row

A rep or leader taps **Check in** when they arrive at an event. Linear Hub records the time, says whether it was on
time with the existing 5-minute grace rule, and lets the person undo it for 2 minutes. Punctuality now reads that time.
A check-in never creates a gauge row, never counts as a day worked and never affects pay.

Not to be confused with the 1.1 **Check in with…** list, where leaders choose who to talk to (`CheckInPerson`,
`lib/smart/checkIns.ts`). The one-tap kind is called a *shift* check-in in code (`ShiftCheckIn`, `check_ins`).

## API

All three routes are mounted at `/api/checkins` behind `requireAuth`. Anonymous callers get 401. Types live in
`shared/src/types/checkins.ts` and rules in `shared/src/logic/shiftCheckIn.ts`.

### `POST /checkins`: check in

Body `ShiftCheckInInput`: `{ eventId, date?, checkedInAt?, source? }`.

- **Who:** reps and leaders at their own team's events. Admins can check in at any event (the same rule as gauges).
  Recruiters get 403.
- **Live tap** (no `checkedInAt`): the server stamps the business clock (`toBusinessISO(businessNow())`, naive London
  wall-clock time). It only works on the event's date, up to the event's end time.
- **Offline replay** (`checkedInAt` given; `source` defaults to `'offline'`): the phone sends the time it was tapped.
  That time must be on the event's date and not after the event's end. It cannot be in the future either, but a phone
  clock up to 5 minutes ahead is taken as now. The event must be no more than 7 days ago. Zoned input is converted to
  London wall-clock time, as for gauges.
- `date` defaults to the date of `checkedInAt`, or else the business date. It must be the event's date.
- `source` is one of `'button' | 'quick' | 'offline'`. `'leader'` is reserved and refused.
- **Idempotent:** the key is `(user, event, date)`. A first check-in answers **201** `ShiftCheckIn`. If one already
  exists, the answer is **200** with that row, whatever time the request carries: the first check-in stands. A phone
  that replays a tap whose answer was lost is simply told "done".
- **Errors:** 400 for validation and time rules (the messages are worded for people, e.g. "Check-in closed at 17:00,
  when the event ended"). 403 for the wrong team or a recruiter. 404 for an unknown event. 409 for a cancelled event.

### `DELETE /checkins/:id`: undo or remove

- The person can undo their own check-in within **2 minutes** of `createdAt`. The server allows 15 seconds of grace
  for a slow request. After that it answers 403 "The 2 minutes to undo a check-in have passed — ask your team leader
  to remove it".
- The leader of the person's team (themselves included) and admins can remove one at any time.
- A caller who cannot see the row gets 404, so the API never reveals that it exists. Success is 204.

### `GET /checkins?eventId=`: the event's check-ins

Answers `ShiftCheckInList` `{ eventId, checkIns }`, earliest first. 400 without `eventId`, 404 for an unknown event.

- **Scope:** an admin sees everyone. A leader sees their own team's people and themselves. Anyone else sees only their
  own. This is the same rule as check-in times on gauge entries (`canSeeEntryDetails`).
- **Not cached:** it is one indexed query, not an aggregate.

### `ShiftCheckIn`

| Field | Meaning |
| --- | --- |
| `id`, `userId`, `userName`, `eventId`, `date` | The row. |
| `checkedInAt` | Naive London wall-clock time, `YYYY-MM-DDTHH:MM:SS`. Same format as `GaugeEntry.checkedInAt`. |
| `source` | `'button'` (dashboard or event page), `'quick'` (Quick gauges), `'offline'` (sent later by the phone). |
| `createdAt` | ISO instant the row was written (business clock). |
| `minutesLate` | Whole minutes after the start, rounded up; 0 when early. |
| `onTime` | Within the 5-minute grace. |
| `undoUntil` | ISO time until which the caller can undo **their own** row; otherwise null. |
| `undoMsLeft` | New. Milliseconds of the caller's undo window left when the server answered; 0 when there is none. Clients count down from when the answer arrived, so a wrong phone clock never matters. |

Every write bumps the response cache's data version (as every write does), so `/me/dashboard` and the digest show the
new punctuality straight away.

## Logic

### Table (`server/src/db/extensions/checkins.ts`)

`check_ins(id, user_id → users ON DELETE CASCADE, event_id → events ON DELETE CASCADE, date, checked_in_at, source
CHECK IN ('button','quick','offline','leader'), created_at, UNIQUE(user_id, event_id, date))`, plus
`idx_check_ins_event(event_id, date)`.

- The table is new, so `upgrade()` has nothing to do. An existing database gets the table from `sql` on its next start.
- Demo seed: on a fresh demo only, today's started (live or completed) events get a check-in for everyone who logged
  gauges today with a check-in time, at exactly that time. Sources are 30% `quick`, the rest `button`. Absentees show
  as "not checked in" on the roll call. The seed reads `gauge_entries` but never writes a core table, so the
  `r2-contracts` hash test holds.

### On time or late

`shiftCheckInStatus(eventDate, startTime, checkedInAt)` reuses the existing `isCheckInOnTime` and `minutesLate`:

- A check-in is on time up to 5 minutes after the start, inclusive. 09:05:00 is on time; 09:05:01 is "6 min late".
- Labels read "Checked in 09:24 · on time" or "Checked in 09:36 · 6 min late".
- Inside the grace a check-in reads "on time", even when `minutesLate` is between 1 and 5.

### When the button applies (`shiftCheckInWindow`)

- **`open`:** on the event's date, from midnight until the end time inclusive. Arriving early is the point.
- **`ended`:** after the end time. The button disappears, but an existing check-in still shows.
- **`not-today` / `cancelled`:** never shown.
- **Who sees it:** reps and leaders of the event's team, plus an admin who belongs to that team.

### Time rules (`resolveShiftCheckInTime`)

See the API section above. The future check uses `SHIFT_CHECK_IN_CLOCK_SKEW_MS` (5 minutes) and the age check uses
`SHIFT_CHECK_IN_REPLAY_DAYS` (7). Naive times compare as strings. Differences between them are taken as if both were
UTC, so a daylight-saving change never shifts them.

### Punctuality (`lib/metrics.ts` `punctualityFor`, `lib/smart/digest.ts`, `lib/smart/checkIns.ts`)

- **Which time counts:** a logged day's check-in time is the one-tap check-in for the same person, event and date when
  there is one. Otherwise it is the gauge entry's own `checked_in_at`, as in 1.1. The SQL is
  `LEFT JOIN check_ins ci ON (user, event, date)` with `COALESCE(ci.checked_in_at, g.checked_in_at)`
  (`lib/shiftCheckIns.ts`: `SHIFT_CHECK_IN_JOIN`, `CHECKED_IN_AT_SQL`). The unique key makes it one index lookup per
  gauge row, and there are no extra queries.
- **What counts as a sample:** still the gauge rows. A check-in on its own (no gauges logged yet) is not a punctuality
  sample. It counts once the day is logged.
- **Removing a check-in:** punctuality falls back to the gauge entry's own time.
- **When the two disagree:** for example, the gauge says 08:55 and the tap says 09:20. The tap counts. A leader who
  wants the gauge time to count removes the check-in from the roll call.

### Pay integrity

- A check-in never writes, edits or reads into `gauge_entries` or `payroll_runs`.
- Pay counts distinct gauge dates (`weekPayFor`), so a check-in is never a day worked.
- Tested in `server/src/test/shift-checkins.test.ts`: there is no gauge row, no payroll run, `weekPayFor` is unchanged,
  and the dashboard shows `days` 0 after check-ins.

### Offline (`client/src/features/checkins/outbox.ts`)

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

### Log gauges

- **Prefill:** **Checked in at** is filled from the person's check-in when the field is empty. The check-in can be on
  Linear Hub, or waiting on this phone for the signed-in person.
- **What it never replaces:** a time that was typed, set with **Now** or the chip, or already stored on the entry.
- **Changing the selection:** picking another person or event removes the time the form filled in, or swaps it for
  the new choice's check-in.
- **Hint:** the field's hint names the check-in, e.g. "One-tap check-in 09:17 · on time — punctuality uses it".
- **Chip:** the "Checking in? Use now" chip is hidden when there is a check-in.

## User guide

**Reps and leaders**

- On the **Dashboard**, each of today's events in *Upcoming events* has a **Check in** button, with "Starts 15:30 · 5
  min grace" next to it. Tap it when you arrive. It changes to "Checked in 15:02 · on time" (green) or "· 6 min late"
  (amber). It does not log any gauges, and it is not a day worked.
- Tapped by mistake? **Undo** stays next to it for 2 minutes. After that, ask your team leader to remove it.
- On **Quick gauges**, the button sits in the event strip at the top. On a phone it is a pin icon. Once you are checked
  in it shows a tick (green on time, amber late) and, on wider screens, the time. Tap the tick to see the time again,
  with **Undo** while it is still allowed.
- **No signal?** Tap **Check in** anyway. The phone keeps the time you tapped and shows "saved on this phone". A line
  under the top bar says "1 check-in waiting to send". It sends by itself when the signal is back, or tap **Send now**.
  If Linear Hub refuses it (say the event was cancelled), the line explains why. Tap **×** to dismiss it.
- On an event's page you see **Your check-in**: the button today, or "You checked in 09:24 · on time" afterwards.
- When you **Log gauges**, **Checked in at** is already filled with your check-in time. You can still change it.
- The **Check in** button only appears on the day of the event, until the event ends.

**Team leaders and admins**

- Each event's page has a **Roll call**: who has checked in and when, earliest first, with "on time" or "11 min late".
  Today's events also list who has **not checked in yet**. The heading counts them, e.g. "6 / 8 checked in · 1 late".
- A phone icon with "sent later" marks a check-in that was tapped without signal and sent afterwards, with the time it
  was tapped.
- **Remove (×)** takes a check-in away at any time. For example, someone checked in from the wrong place. Punctuality
  for that day then goes back to the time on their gauges, if any. Gauges and pay are not affected.
- Your own **Check in** button is in the roll call's header until you have checked in.
- Punctuality on dashboards, profiles, the week in review and the **Check in with…** list now uses check-in times
  where there are any.

**Recruiters** see no check-in buttons or roll calls.
