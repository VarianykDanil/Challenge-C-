# U2 bulk-entry: the whole team's gauges in one go, or pasted from WhatsApp

A leader (or an administrator) logs every team member's day for one event on one page, typed or pasted straight
from the team's WhatsApp group, and saves it once. Every row follows exactly the rules of a single **Log gauges**
save; the save is all or nothing.

Files: `shared/src/logic/bulkPaste.ts` (+ `bulkPaste.test.ts`), `shared/src/types/bulk.ts`,
`server/src/routes/bulkGauges.ts`, `server/src/test/bulk-gauges.test.ts`, `client/src/pages/BulkGauges.tsx`,
`client/src/features/bulk/{bulkRows.ts,BulkGrid.tsx,PastePanel.tsx}`, `client/src/features/gauges/BulkEntryLink.tsx`,
`client/src/api/bulk.ts` (unchanged from the foundation).

## API

### `POST /gauges/bulk` (admin, leader)

Body `BulkGaugeInput`:

```json
{
  "eventId": 523,
  "date": "2026-10-20",
  "rows": [
    { "userId": 10, "stops": 65, "table": 22, "presentations": 11, "closes": 5, "taps": 3, "sales": 3, "checkedInAt": "2026-10-20T09:58" },
    { "userId": 13, "stops": 33, "table": 11, "presentations": 6, "closes": 3, "taps": 2, "sales": 2 }
  ]
}
```

- `rows`: 1–100 (`BULK_MAX_ROWS`). Each row is a `POST /gauges` body without `id`, `eventId` and `date`: the six
  counts (whole numbers 0–2,000), optional `checkedInAt` (same format and rule as a single entry; omitted keeps a stored
  value, `null` clears it) and optional `notes` (same: omitted keeps, `null` clears).
- **200** `BulkGaugeResult` `{ created, updated, entries: GaugeEntryWithMeta[] }` — the saved entries in row order.
  An existing entry for (event, person, date) is updated in place, never duplicated.
- **400** `{ error: "2 rows need fixing — nothing was saved", details: { rows: BulkRowError[] } }` when any row is
  refused. `BulkRowError` is `{ index, userId, errors: string[] }` (`index` into `rows`); every bad row is reported,
  not just the first. Nothing is written.
- Event-wide problems answer once, with the status a single entry gets: **404** no such event; **403** a leader and
  another team's event ("Leaders can only record gauges at their own team's events"); **409** a cancelled event;
  **400** an event that has not started yet, or a `date` that is not the event's date; **400** `Validation failed`
  for a malformed body (no rows, more than 100, a missing `eventId`).
- Reps and recruiters get **403**; anonymous **401**.
- Role scoping: a leader may write their own team's events, for members of their own team and themselves; an
  administrator any event and anyone (same as `assertCanWriteGauge`).
- Not cached (a write). The write middleware bumps the data version once per request, so every cached aggregate
  (`/me/dashboard`, `/leaderboard`, `/gauges/summary` …) refreshes once.

## Logic

### Server (`routes/bulkGauges.ts`)

A bulk row is exactly a `POST /gauges` row. The rules are the single-entry functions, imported, not copied:
`gaugeBody` (field validation), `assertCanWriteGauge` (scope), `assertGaugeIntegrity` (event started, not cancelled,
date = event date, active member of the event's team — admins exempt from the team rule), `validateGaugeFunnel`
(stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales, each ≤ 2,000), `assertWeekUnpaidFor` (paid-week lock,
admins pass), `checkInFor` (a check-in can never be in the future, on the business clock) and `rateSnapshot`.

1. The event-wide rules run once (a stand-in member of the event's team, so only the event rules can fail).
2. Every row is then checked and its problems collected: field errors ("Stops: Number must be less than or equal to
   2000"), the same person twice ("This person is already on row 1"), "Person not found", the first scope refusal,
   the funnel warnings, the paid-week message and a future check-in. One grouped query loads the people.
3. Any problem → 400 with every row's problems; nothing is written.
4. Otherwise, in **one transaction**: existing entries for the event and date (one query) are updated in place
   (submitted time refreshed, rate snapshot kept), new ones inserted with the campaign payout and pay-plan commission
   snapshot (`rateSnapshot`, memoised per pay plan), then the week's payroll runs follow: the people affected by every
   row (`affectedPayUsers`: the rows' owners, their team's leaders for the override, no-team seniors at the event) are
   collected and `syncPayrollRun(…, { flagPaid: true })` runs **once per person** — the same result as one
   `syncPayrollForEntry` per row (a test compares the runs with the same rows sent one by one). A week still in
   progress is left alone; a paid run is never recomputed but is flagged "adjusted after payment" when an admin
   changes it. No forecast, no extra gauge row.

### The WhatsApp parser (`shared/src/logic/bulkPaste.ts`, pure and deterministic)

`parseBulkPaste(text, members)` → `{ lines: ParsedPasteLine[], ignored }`; `resolvePaste(lines, choices, members)`
applies the leader's choices; `pasteFills(lines)` gives one row per person; `pasteFunnelIssues(totals)` words the
funnel rule in plain English.

- **WhatsApp exports.** `[20/10/2026, 17:42:13] Jordan Lee: …` (iOS), `20/10/2026, 17:42 - Jordan Lee: …` (Android) and
  `[17:42, 20/10/2026] Jordan Lee: …` (desktop copy) lose their prefix; the sender is remembered for the following
  lines of the same message (until the next prefix). A system line ("Messages and calls are end-to-end encrypted")
  has no sender. Bidi marks, zero-width characters, every kind of space, emojis (with skin tones and flags) and
  WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`) are dropped; keycap digits read as digits (4️⃣0️⃣ → 40).
- **Check-in time.** The first time on the line is the check-in, as "HH:mm": `9:58`, `09:58`, `9.58am`, `10am`,
  `12:30pm`. A dot needs am/pm ("9.55" alone is two numbers). Without am/pm, 1:00–6:59 is the afternoon (`1:05` →
  13:05: nobody checks in for a field shift then). A run like `65:22:11:5:3:3` is never a time.
- **Dates** (`20/10`, `20/10/26`, `20.10.2026`, `2026-10-20`) are dropped. A run of four or more numbers
  (`65/22/11/5/3/3`) is never a date.
- **Not gauges:** numbers stuck to letters (`2nd`, `x2`), money (`£10`), percentages (`14%`), numbers longer than six
  digits (phone numbers).
- **Chatter.** A line with fewer than three gauge numbers is ignored and counted in `ignored` (blank lines are not).
- **Several people on a line** (`Jordan 65 22 11 5 3 3, Amelia 40 12 6 2 1 1`) split where a team member's first or last
  name follows three or more numbers, but only when the numbers already had a name in front (`65 22 11 5 3 3 Jordan`
  is one person named at the end). Keys: `4.1`, `4.2`.
- **Numbers.** Exactly six → funnel order. With three or more gauge words (`stops`, `table`/`tbl`, `pres`/`pitch`,
  `closes`/`cls`, `taps`, `sales`/`dd`/`signups`, singular or plural, glued or not: `65stops`), each number goes to its
  word, number-first (`65 stops`) or word-first (`stops: 65`), whichever pairs more, skipping filler (`22 to table`).
  If the words do not account for all six but six plain numbers are there, the plain order wins (the words were chat).
  Otherwise "Found 5 numbers, need 6" or "Missing taps".
- **Funnel problems** are kept on the line with its numbers: "To table (22) is more than stops (10)", "Stops (2500) is
  over the 2,000 a day limit".
- **The name** is the words before the numbers (after them when the line starts with numbers), with filler such as
  "gauges", "for", "today", "in", "checked" left out. No name at all → the WhatsApp sender. A name that matches nobody is
  never swapped for the sender: the leader chooses ("No one called “Jrdn” on this team — choose who it is").
- **Matching** (accents, apostrophes and hyphens ignored: Zoë = Zoe, O'Brien = OBrien, Mary Jane = Mary-Jane). Each
  member is scored and the top score wins: 100 first + last name · 90 first name + last initial (`Jordan L`) · 85 first
  + near-miss last · 70 first name · 65 near-miss first + last · 60 last name only · 55 near-miss first + last initial ·
  40 near-miss first. A near miss is a typo or swap (one edit, names of four letters or more: Jordon, Aemlia) or a short
  form of at least three letters (Sam → Samuel, Jord → Jordan); filler words never near-miss ("the" is not Theo).
  Several members on the top score → ambiguous ("2 people match “Jordan” — choose one"); a single near-miss match is
  flagged `guess` ("Best guess for “Calum”").
- **Repeats.** The last complete line for a person wins (`replacedBy` marks the earlier ones); an incomplete line
  replaces nothing. `resolvePaste` accepts a choice for an ambiguous line only among its matches, and anyone on the
  team for an unknown name; `null` goes back to the parser's own match.

### Client (`/gauges/bulk`)

- Event picker: the Log gauges list (last three weeks up to today, not cancelled; own team for a leader, every team for
  an admin, with the team name). Today's own-team event is preselected when there is exactly one
  (`preselectTodayEvent`); `?eventId=` deep-links one (own team for a leader). A future or not-started event shows why
  and cannot be saved.
- Rows: the event team's active members (no recruiters), first name order, prefilled from the entries already logged
  for that date. Statuses: **Logged** (saved, unchanged), **Update** (saved, changed), **New** (not saved, has a number),
  **Not logged**. Blank cells count as 0. Only New and Update rows are sent; an Update sends its check-in only when it
  changed (so a stored one is never cleared by accident) and never touches notes. Funnel problems and a check-in later
  than now (today's event) are shown on the row before saving and block Save; the server's answer is mapped back to
  the rows by index.
- Unsaved numbers are kept on the phone per person and event (`localStorage` `lm-bulk-draft:<userId>:<eventId>`, every
  call wrapped, kept 3 days) and come back after a reload or a lost signal, with **Discard them**. A save without
  signal keeps them and says nothing was saved.
- After a save the page waits for the event's entries, then clears the edits and the draft and closes the paste box.

## User guide

**Leaders** — open **Gauges** and press **Bulk entry** (next to **Tally**).

1. Today's event for your team is already chosen; pick another from **Event** if you need to (the last three weeks).
2. Everyone on your team has a row. People who already logged show their numbers with a green **Logged** badge.
   Type the six numbers for anyone else (a blank counts as 0) and their check-in time. **Enter** jumps down to the
   next person in the same column on a keyboard. Use **Not saved yet** to see only the people still to do.
3. Or press **Paste from WhatsApp** and paste the numbers from the team chat — one person per line, like
   `Jordan 65 22 11 5 3 3`, `Jordan L - 65/22/11/5/3/3` or `amelia: 40 12 6 2 1 1 in 9:58`. You can paste a whole chunk
   of the chat: timestamps, emojis and chat lines are skipped, and a message with no name uses the sender. Each line
   shows what was read. If a name matches two people, or nobody, choose the person from the list. Lines with a problem
   (say, more to table than stops) are marked in amber. Press **Fill N rows** to put them in the table.
4. Check the rows: anything marked in red needs fixing first. The bar at the bottom says how many are new and how
   many will update. Press **Save N people**. Everything saves together, or nothing does — if Linear Hub refuses a
   row, it is marked with the reason and nothing is saved until it is fixed.

If the signal drops, your numbers stay on this phone; open **Bulk entry** again and they are back on the sheet
(**Discard them** throws them away). A week that has already been paid cannot be changed by a leader — ask an
administrator.

**Administrators** — the same page, for any team's events (the event list shows the team), and for paid weeks: the
change goes through and the payslip is marked "adjusted after payment".

**Reps and recruiters** do not see **Bulk entry**; reps keep logging their own day with **Log gauges** or the tally.
