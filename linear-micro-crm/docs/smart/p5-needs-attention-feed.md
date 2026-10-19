# p5 — Needs attention

## API

### `GET /api/me/attention` → `AttentionFeed`

Every signed-in role. Cached per user through `CACHED_PATHS` (20 s, cleared by any write), so a repeat call within
20 s answers `X-Cache: HIT`. No query parameters. There is no table behind it: the feed is derived on each (uncached)
request from rows the caller may already see.

```jsonc
{
  "items": [
    {
      "key": "gauges:gap:516",            // deterministic: the same thing always has the same key
      "kind": "gauges",                   // gauges | pay | payroll | events | recruitment | security
      "severity": "warning",              // danger | warning | info
      "title": "1 of 7 has not logged BCN — MediaCity Piazza",
      "body": "Noah has no gauges for Sat 17 Oct yet: a quick message usually sorts it.",
      "href": "/gauges?log=1&eventId=516&userId=23",
      "actionLabel": "Log for Noah",      // optional
      "at": "2026-10-17T17:00",           // optional: what the item is about (date, wall time or ISO timestamp)
      "count": 1                          // optional: how many a summary covers (gap, follow-ups, runs, interviews)
    }
  ],
  "generatedAt": "2026-10-19T14:00:11.794Z",
  "disabled": true                        // optional, only with LM_SMART=0 (then items is always [])
}
```

- Sorted danger → warning → info, then newest `at` first (items without `at` last), then by key. At most 20 items.
- **Role scoping** (applied in the route before any rule runs; the rules only ever narrow):

  | Role | Events / gauge rows | Members | Pay runs | Recruitment |
  |---|---|---|---|---|
  | rep | own team's events; **own** rows only | themself | own | none |
  | leader | own team's events and rows | own team (active) | own | candidates they own; interviews they run or own |
  | recruiter | none | themself | own | open candidates they own or nobody owns; interviews they run or own |
  | admin | every team | everyone active | own, plus every pending / failed run in the to-pay window | everything |

  A rep never receives `gauges:gap`, `gauges:odd`, `events:empty`, `events:behind`, `payroll:*`, `recruitment:*` or
  `security:*` items, and never anything about another person's rows or pay.
- **Queries**: `ensurePayrollMaterialised(db, today)` first (as the finance routes do, so last week's runs exist before
  they are counted), then at most 8 statements (admin 6, leader 8, recruiter 3, rep 5): pay plan, events dated
  `from` … tomorrow and gauge rows dated `from` … today (`from` = `attentionLookbackFrom(today)`: today − 3, or this
  week's Monday when that is earlier, so the own-gauge rule sees the whole pay week), active members, runs (unpaid, or paid in the last 7 days;
  admin also the to-pay window), open candidates with a follow-up already due, pending interviews within ± 2 days, and
  the caller's usual attendance over the 28 days before the window. Events, gauge rows, runs and the attendance count
  are date-bounded and use their indexes; open candidates, interviews and the admin's member list are small full scans
  (there is no index on `interviews.scheduled_at`; worth adding in `db/schema.ts` if the interview table grows).
  Uncached it answers in a few milliseconds on the seed. Nothing is written except the payroll materialisation the
  finance routes already do; no gauge row is ever created.
- `LM_SMART=0` → `{ "items": [], "generatedAt": …, "disabled": true }` (the client hides the card and the bell count).
- `count` (optional, additive) is set on the summary items `gauges:gap` (people missing), `recruitment:overdue`
  (follow-ups), `recruitment:today` (interviews) and `payroll:to-pay` (runs); the client uses it so a summary that
  grows counts as new again.
- Item keys: `gauges:event:<eventId>:user:<userId>`, `gauges:gap:<eventId>`, `gauges:odd:<entryId>`,
  `events:tomorrow:<eventId>`, `events:empty:<eventId>`, `events:behind:<eventId>`, `pay:overdue:<runId>`,
  `pay:due-tomorrow:<runId>`, `pay:paid:<runId>`, `payroll:to-pay`, `payroll:due-today:<date>`, `recruitment:overdue`,
  `recruitment:interview:<interviewId>`, `recruitment:today`, `security:2fa`.

## Logic

Shared, pure and deterministic: `attentionItems(input, now)` in `shared/src/logic/attention.ts` (thresholds in
`ATTENTION_RULES`). `now` is the business clock (`todayISO()`, `nowHHMM()`, `nowISO()`, Europe/London). An event is
**over** when it is completed, or scheduled / live with its end time passed; cancelled events are never over. An event is
**running** when it is today, not completed or cancelled, and start ≤ now < end.

| Key | Who | Severity | Fires when |
|---|---|---|---|
| `gauges:event` | rep, leader | warning | An own-team event dated **this pay week** (Monday of today's week … today; `attentionOwnGapWindow`) is over (today's only once it has ended), and I have **no gauge row at all on that date** (a row at another event counts). **One item per date**: when the team ran two events that day the item is keyed on the earlier one (start time, then id) and names the other ("If you worked it or Volt — MediaCity: …"), because a day pays one base. Skipped before my start date and for a week whose run is already paid (the server would refuse the entry with 409). |
| `events:tomorrow` | rep, leader | info | An own-team event tomorrow that is not cancelled. Title: campaign, venue and start ("Tomorrow: BCN — Asda Hulme at 10:00"); body: city, times and the notes cut to 140 characters (the venue is not repeated). |
| `pay:overdue` | anyone with runs | danger | My pending / failed run is past its due date. "Your pay for w/c 5 Oct is 2 days overdue" · "£412.50 (PAY-…) was due Fri 16 Oct. The office sees this too." The last sentence only when the run's week is inside the office's 12-week **Runs to pay** window (the one `payroll:to-pay` counts); an older run (own runs go back 52 weeks) says instead "It is older than the 12 weeks the office's pay list shows, so please mention it to them." An admin's own run has neither. |
| `pay:due-tomorrow` | anyone with runs | info | My pending / failed run is due tomorrow. |
| `pay:paid` | anyone with runs | info | My run was paid (paid or late) with `paid_date` in today − 6 … today: "You've been paid £412.50 for w/c 5 Oct". |
| `gauges:gap` | leader (own team), admin | warning | The event ended ≥ 2 h and ≤ 48 h ago, has ≥ 1 entry, and active rep / leader members who had started by that date have no row on that date at all. The count covers the whole team (a leader and the admin read the same "3 of 7"); the viewer is never chased by name (they get their own `gauges:event`), and a gap that is only the viewer is no gap item. Up to 5 first names. Exactly one other person missing → `/gauges?log=1&eventId&userId` with **Log for Jordan**; otherwise `/events/<id>`. |
| `events:empty` | leader (own team), admin | warning | An over event dated today − 2 … today (ended ≥ 2 h ago when it is today) with zero rows: "did it run? Log it or mark it cancelled." |
| `events:behind` | leader (own team), admin | info | A running event after 13:00 with sales < 50 % of a positive target: "4 of 12 sales so far with 3 h 30 min to go. More stops in that time is the lever." |
| `gauges:odd` | leader (own team), admin | info | A row dated today − 2 … today with stops ≥ 30 and table 0, or stops ≥ 50 and sales ÷ stops > 20 %. Links to Log gauges for that row. |
| `recruitment:overdue` | recruiter, leader, admin | warning | One summary: open candidates in scope whose follow-up is overdue (a date-only follow-up the day after, by the business date; a timestamp once passed), oldest first, up to 3 names. |
| `recruitment:interview` | recruiter, leader, admin | warning | A pending interview that started ≥ 2 h ago, where I am the interviewer or own the candidate (admin: all): "Record the outcome of Aisha Khan's first interview (Tue 10:00)". |
| `recruitment:today` | recruiter, leader, admin | info | My pending interviews in the next 24 h (I am the interviewer, or nobody is and I own the candidate), up to 3 listed. |
| `payroll:to-pay` | admin | danger if any run is overdue, else warning | Pending + failed runs with `week_start` in GET /finance/payroll's default window (Monday of this week − 12 weeks … today), so the number matches **Runs to pay**: "29 runs to pay · £24,540 · 6 failed transfers". Body: "1 is overdue: it was due Fri 28 Aug. Paying it first is the lever." / "3 are overdue: the oldest was due … Paying those first is the lever." / "The next one is due …". Unpaid runs older than the window are not counted here (they are not on Runs to pay either); their owner's `pay:overdue` says so. |
| `payroll:due-today` | admin | warning | On a Friday with runs due that day. |
| `security:2fa` | admin | info | The admin's own two-step verification is off. |

**Own-gap window (lead decision).** `gauges:event` covers THIS PAY WEEK: from `mondayOf(today)` to yesterday, and today
once today's event has ended. An unlogged Monday is therefore still asked for on Thursday, Friday and over the weekend,
while it still counts towards Friday-week's pay (the pending run follows the gauges until it is paid). A day before
Monday is never asked for: it belongs to a week that may already be paid (and once paid the server refuses the entry
with 409). So on a Monday only today's ended event can appear; Saturday and Sunday of the week before do not. The route
loads events and rows from `attentionLookbackFrom(today)` = the earlier of today − 3 and Monday, so on Friday to Sunday it
reaches back up to 6 days; the team rules (`gauges:gap`, `events:empty`, `gauges:odd`) keep their own 2-day windows.
The attendance look-back (pay-cost wording) is the 28 days before `from`, so this week's unlogged days never count
against "usually works their team's days".

**Pay-cost wording** (`gauges:event`, the lead's addition). The base comes from my own pay plan through
`estimateWeekPay(plan, { daysWorked: 1 })`; "plus commission" is added when the plan pays commission. The payday is named
(`paydayForWeek`, the Friday after the week ends), because on a Thursday a bare "Friday" reads as tomorrow.
- I usually work my team's event days (a row on ≥ 50 % of the team's completed event dates in the 28 days before the
  window, with at least 3 such dates): "Thursday not logged yet: that day's £60 base plus commission is missing from
  Friday's pay (23 Oct). Log it before the week is paid."
- Otherwise: "If you worked it: that day's £60 base plus commission is not in Friday's pay (23 Oct) until it is logged."
- A plan with no daily base drops the money sentence. Nobody else's pay is ever estimated.

**Client rules** (`client/src/lib/attentionSeen.ts`, `NotificationsBell.tsx`):
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
- **Tab title**: `setTitleBadge(n)` (lib/usePageTitle) shows the unread count, "(2) Dashboard · Linear Hub".
- No Notification API or Web Push: both need HTTPS and the hotspot serves plain http.

## User guide

### Needs attention

Linear Hub now tells you what needs doing instead of waiting for you to look. Everything comes from one list, shown in
three places:

- **The bell** at the top right shows a number when something new needs you. Tap it to see the list, grouped (**Your
  pay**, **Gauges**, **Events**, **Payroll**, **Recruitment**, **Security**). Each line has a button that takes you straight
  to the right screen, for example **Log gauges** or **Log for Jordan**. Opening the bell clears the number on this
  device; a line you have read comes back as new only if it gets bigger (for example a second person has not logged
  yet). The browser tab shows the same number, like "(2) Dashboard · Linear Hub". If Linear Hub cannot be reached, the
  bell says so and offers **Try again**.
- **Pop-up notes** appear at the bottom of the screen for new, important things (at most one when you open the app). They
  never interrupt you while a window such as **Log gauges** is open; those wait in the bell. You will not see the same
  pop-up twice on the same phone or computer.
- **The Needs attention card** at the top of the dashboard shows the first five, with **Show all** for the rest. When
  nothing needs you it simply says **All caught up**.

The list checks again every minute while Linear Hub is open, and clears itself: log the gauges and that line disappears.

What each person sees:
- **Reps**: event days this pay week (from Monday, and today once the event has finished) that you have not logged yet,
  one line per day,
  with what that day is worth from your own pay plan so it is not missing from Friday's pay; tomorrow's event with its
  start time and notes; and your own pay: due tomorrow, overdue, or just paid. If an overdue payment is older than the
  12 weeks the office's pay list shows, the line asks you to mention it to the office. Only ever about you and your own
  team's events.
- **Crew leaders**: the same for yourself, plus your team: who has not logged an event that finished (with **Log for …**
  when it is one person), events with nothing logged ("did it run?"), today's events that are behind target after 1 pm,
  and numbers that look mistyped. Also the candidates you own: overdue follow-ups and interviews that need an outcome.
- **Recruiters**: overdue follow-ups for your candidates and unassigned ones, interviews that need an outcome, your
  interviews in the next 24 hours, and your own pay.
- **Owner / admin**: every team's gaps and events, **Runs to pay** with the total and any failed transfers (red when a run
  is overdue), a payday reminder on Fridays, the whole recruitment pipeline, and a reminder to turn on two-step
  verification if it is off.
