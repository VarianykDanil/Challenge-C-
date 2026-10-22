# P3 statements: Gmail (app password) → PDF → corrected pay

The clients' commission statements arrive in Matt's Gmail as PDFs; Linear Hub reads them, matches each row to a person and corrects their next payment.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P3 statements**.

## API

Every `/statements` path is **admin only** (router-wide). Anonymous → 401; a client account → 403
`{ clientPortalOnly: true }` (the client guard); leader, recruiter, rep → 403. Types: `shared/src/types/statements.ts`.

| Route | Answer |
| --- | --- |
| `GET /statements?campaignId=&status=` | `StatementSummary[]`, newest first (`status` one of `parsed`, `needs_review`, `applied`, `failed`; 400 otherwise). Adds `unmatchedCount`, `campaignColor`, `appliedByName`, `sender`, `senderVerified` (email only: Gmail confirmed the sender; `null` for an upload) and `supersededBy` (the later statement for the same period that replaced an applied one). |
| `GET /statements/:id` | `StatementDetail`: the rows (with `userName`), `table` (headers, body cells, the column mapping and whether it came from the campaign's saved columns, the layout `totals` / `per-sub`), `people` (per matched person and pay week: logged, confirmed, cancelled, and `weekConfirmed`, the whole-week figure sent to pay), `notListed` (people who logged sales for the campaign in the period but are on no row — worked out once every row is matched), `blockers` (why Apply is refused, in plain words), `warnings`, `effect` (P1's `applyConfirmedSales` dry run while nothing blocks; the stored real result once applied), `template`, `subject`, `replaces` / `replacedBy` (`StatementLink { id, receivedAt, appliedAt, periodStart, periodEnd }`: the applied statement for exactly the same period this one replaces — or replaced, once applied — and the later one that replaced it), `dropped` (`StatementDropped { userId, userName, logged, confirmedBefore }`: people on the statement being replaced who are not on this one) and `outsidePeriodCount` (rows dated outside the period). An applied statement shows the figures as applied (from `statement_allocations`), whatever the gauges say later. |
| `GET /statements/:id/file[?download=1]` | The PDF (`inline`, or `attachment` with `download=1`), `Cache-Control: private, no-store`, `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` so the statement page can frame it (every other response keeps `DENY` / `'none'`). A demo statement's PDF is drawn the first time it is asked for. 404 "Statement PDF not found" when the file is missing; a stored path outside the statements folder is never read. **Audited** (the PDF lists people's earnings) through P9's `recordClientEvent`: an inline open as "Opened the statement PDF: BCN 12–18 Oct 2026" (the same person again within a few minutes adds no row), a download as "Exported BCN statement for 12–18 Oct 2026 as PDF". |
| `POST /statements/upload?fileName=&campaignId=` | **The body is the PDF itself** (`Content-Type: application/pdf`), read on this route only with `express.raw` (limit `STATEMENT_MAX_BYTES`, 20 MB). 415 another content type, 400 empty, 413 "This PDF is over 20 MB", 422 "This file is not a PDF", 404 unknown campaign, 409 with `details.statementId` when the same bytes are already stored ("This PDF is already here: the BCN statement for 5–11 Oct 2026, received Wed 14 Oct."). → **201** `StatementSummary`. A PDF that cannot be read is still stored, with status `failed` and the reason in `error`. The stored file name never keeps a path. |
| `PATCH /statements/:id` `{ campaignId?, periodStart?, periodEnd? }` | → `StatementDetail`. Both period ends or neither; start ≤ end; at most 92 days. A new campaign re-reads the rows with that campaign's saved columns and matches them again (picks by hand are kept). 409 once applied. |
| `DELETE /statements/:id` | 204; the rows go too, and the file when no other statement uses it. 409 once applied. |
| `POST /statements/:id/apply` | → `StatementDetail` (status `applied`, `appliedAt`, `appliedByName`, the stored `effect`). 409 with the first blocker in plain words ("1 row is not matched to anyone yet: …"), or "This statement is already applied." |
| `PUT /statements/:id/rows/:rowId` `{ userId: number \| null }` | → `StatementRow` + `rememberedRef` + `alsoMatched`. `null` = "not one of ours" (left out of Apply). The pick also goes to every other unmatched row of the statement written the same way (same name and fundraiser ID — a per-sign-up statement lists a person once per sub); `alsoMatched` says how many. When the row has a fundraiser ID that nobody has at that campaign and the person has none there yet, it is saved as theirs (`rememberedRef`) and the campaign's unapplied statements match again. 404 an unknown row or person (client accounts are not people here), 409 once applied. |
| `GET /statements/templates/:campaignId` | `StatementTemplate` (404 until saved). |
| `PUT /statements/templates/:campaignId` `StatementColumnMapping` | → `StatementTemplate`. Each field a header text (what the page sends) or a column index; `null` leaves it out. Needs the name or ID column and a count, date or status column (400 otherwise). Re-reads the campaign's unapplied statements with it (picks kept). |
| `GET /statements/client-refs?userId=` | `ClientRef[]` (everyone's without `userId`). |
| `PUT /statements/client-refs/:userId` `ClientRef[]` (or `{ campaignId, ref }[]`) | → that person's `ClientRef[]`. Replaces all of them; a blank `ref` removes one; at most 40 characters. 409 "FR-2041 is already Jordan Lee’s fundraiser ID at BCN." 404 unknown person or campaign, or a client account. Unapplied statements of the campaigns concerned match again. |
| `GET /statements/senders`, `PUT /statements/senders` `StatementSender[]` | The whole list (PUT replaces it; addresses lower-cased, duplicates dropped; 400 a bad address, 404 an unknown campaign). |
| `GET /statements/mail` | `MailSettings` + `lastFetchAt`, `checkEveryMinutes` (15). Never the app password, only `hasPassword`. |
| `PUT /statements/mail` `{ address?, appPassword?, enabled? }` | → `MailSettings`. The app password is 16 letters (Google shows four groups of four; spaces are fine; 400 otherwise), stored encrypted (`lib/crypto.ts` `encrypt`, the app-secret key); `''` removes it. `enabled: true` needs an address and a password (400). Removing either turns the check off. A new address forgets where the last check got to. |
| `POST /statements/mail/test` | `MailTestResult` `{ ok, message }` — "Connected to Gmail as matt@… (read-only). 2 emails from your statement senders in the last 60 days." or the failure in plain words (also kept as `lastError`). 409 when no address / password is saved. One test at a time (presses while one runs share it) and at most one connection every 10 seconds: a quicker press answers the last result, so the button can never get the account throttled by Google; a new address or app password is tested afresh. |
| `POST /statements/check-now` | `CheckNowResult` `{ checked, fetched, parsed, applied, errors[] }` — one check now (a check already running is shared). 409 when Gmail is not set up. |

Audit (`server/src/lib/audit/statementSpecs.ts`): every write above has a spec — "Changed the Gmail statements settings:
address matt@gmail.com, app password saved, automatic check on" (never the password, and nothing when nothing
changed), "Tested the Gmail connection: failed (IMAP is off …)", "Checked Gmail for statements: 2 new statements, 1
applied automatically", "Changed the statement senders: added BCN commissions@…", "Saved the statement columns for
BCN: …", "Changed Jordan Lee’s client IDs: BCN FR-2065", "Uploaded a statement: BCN statement for 5–11 Oct 2026 (20
rows, 20 matched)", "Applied the BCN statement for 5–11 Oct 2026: 20 people, 4 cancelled subs, −£40.00 on the next pay
runs", "Matched “J. Lee” (and 15 more rows written the same way) on the CHN statement for September 2026 to Jordan Lee",
"Changed …: campaign BCN, period …", "Discarded …". Automatic steps are recorded as "Linear Hub" (`recordSystemEvent`):
`SYSTEM statements.fetch` ("Fetched 2 statements from Gmail: BCN 5–11 Oct 2026, CHN September 2026; 1 applied
automatically"), `SYSTEM statements.apply`, and `SYSTEM statements.mail_error` (once per new failure, not every 15
minutes).

Needs attention (`server/src/lib/attention/statements.ts`, admins only, one SQL statement, the last 60 days, at most 6
statement items): `statements:review:<id>` (warning, "BCN statement for 12–18 Oct 2026 needs a look" — the period tells
two statements of one client apart — with what to do: rows to pick, no campaign, no period, it replaces an applied
statement, rows dated outside its period, Gmail could not confirm the sender, or the client's columns not saved yet),
`statements:failed:<id>` (warning, "A statement could not be read", with the reason), `statements:ready:<id>` (info, "…
ready to apply"), `statements:mail:<hash>` (danger, "The Gmail check for statements is failing", while the check is on).
Each links to `/finance/statements?statement=<id>` (or `/settings#integrations`).

## Logic

**Files.** PDFs are kept as `<sha256>.pdf` in `statements/` next to the database (`server/data/statements/` by default,
git-ignored; `LM_STATEMENTS_DIR` moves it; an in-memory test database uses a temp folder). The same bytes are stored
once; the database keeps the path relative to that folder.

**Reading a PDF** (`lib/statements/pdf.ts`, `pdfWorker.ts`, `store.ts`, shared `logic/statements.ts`). pdfjs-dist
(legacy build, no fonts, no XFA, the first 40 pages) runs in a **worker thread**, started on first use and kept for the
next PDF (it never keeps the process alive while idle). A read that takes more than 30 s ends that thread outright — the
only way to stop a parser that is stuck — and the next PDF gets a fresh one, so a hostile PDF can never stall the
server. (pdfjs-dist 6 has no `isEvalSupported` option any more: it removed the code path it guarded and never compiles
code from a PDF.) It gives each piece of text with its position.
`statementLines` groups pieces on the same baseline into lines and cuts a line into cells at gaps wider than half the
font size. `findStatementTable` takes the line with the most header words (it must have a name or ID column, a count,
date, status or amount column, and no numbers) as the header, joins a header split over two lines, then places every
later line's cells into the header's columns by horizontal overlap; a header repeated on a later page re-anchors the
columns, "Page 2 of 3" lines are skipped, and a "Total" line ends the table (kept to check the sum). The period comes
from the lines: "Period: 05/10/2026 to 11/10/2026", "Week ending 11 October 2026", "w/c 5 Oct 2026", "1–31 October
2026", "28 Sep – 4 Oct 2026", "Statement for October 2026" (UK day/month order; at most 92 days); else from the rows'
own periods or sign-up dates. A PDF with no text ("it may be a scan"), no table, a password, or damage is stored as
`failed` with that reason.

**Columns.** `detectStatementColumns` reads the header words: fundraiser ID (`Fundraiser ID`, `Agent no.`, `ID`, `Ref` —
never a donor's or supporter's), name (`Fundraiser name`, `Fundraiser`, `Name`), sign-ups before cancellations
(`Sign-ups`, `Subs`, `Sales`), confirmed (`Paid subs`, `Successful`, `Net`, `Confirmed`), cancelled (`Cancelled`,
`Lapsed`, `Refunded`, `Attrition`), amount (`£`, `Amount`, `Commission`; a "Paid" column whose cells are money is the
amount), sign-up date, status and period. A campaign's saved columns (its template, by header text, so a new column
elsewhere does not break it) win over detection. **Totals layout** (a row per fundraiser): confirmed = the paid count,
else sign-ups − cancelled. **Per-sub layout** (a row per sign-up): each row counts 1, or 0 when its status reads as
cancelled (cancel, lapse, refund, decline, fail, reverse, reject, void, charge-back, claw-back, not paid, bounced,
returned, withdrawn, stopped).

**The campaign** is the one given at upload, else the sender's (Settings → Integrations), else the one whose name (or
code, as literal text — a code like `C++` is fine) the PDF mentions; otherwise the page asks for it.

**Matching** (`autoMatch`): the person's client fundraiser ID for that campaign (Team → person → Client IDs, case
aside), else their exact full name (case and punctuation aside; "Lee, Jordan" works; initials do not), and only when
exactly one person has it. Client portal accounts are never matched. Picks made by hand are never overwritten.

**Status.** `failed` (unreadable), `needs_review`, `parsed` ("Ready to apply"), `applied`. `parsed` needs all of:
nothing blocks Apply, the campaign's columns are saved, every row is inside the statement's period, for an email
Gmail's confirmation that it came from the sender (below), and no applied statement for exactly the same period (a
replacement always waits for the office). Anything else is `needs_review`, with a warning saying why. A statement **from
email** that reaches `parsed` is applied straight away by "Linear Hub"; an **upload** waits for the admin's Apply.
Applying a statement whose columns were detected saves them as the campaign's template, so the client's next statements
in the same layout apply themselves.

**From rows to pay weeks** (`statementPlan`, shared `allocateConfirmedToWeeks`). Logged subs are the person's gauge
`sales` at events of the statement's campaign on the period's days. Per-sub rows count in their own sign-up week. A
totals row covers its period: every pay week keeps what was logged in it, and when the client confirmed fewer the
cancellations come off the **latest week first**, then the one before (decided in the plan); when it confirmed more,
the extra subs go on the latest week. Hand-computed: logged 5, 6, 2 over three weeks, confirmed 9 → cancel 4: the last
week 2 → 0, then 6 → 4 → 5, 4, 0. Each person-week goes to P1's `applyConfirmedSales` as a **whole-week**
`ConfirmedSalesRow`: this statement's confirmed subs for its days of the week, plus the week's other days — what another
applied statement of the same client confirmed for them (`statement_allocations`), else as logged — so a monthly
statement that splits a pay week keeps the other month's confirmation. People not on the statement are left alone (and
listed).

*Which days a statement speaks for* (the review's blocker). For each person: the statement's period, plus that person's
own rows' days outside it (a sign-up dated the day before the period; a row whose own Period column is longer). So a
sign-up dated Monday on a Tue–Sun statement counts on Monday **in place of** what that person logged on Monday — never on
top of it — and says nothing about anyone else's Monday. Hand-computed (a test): logged 4 on Monday and 3 on Wednesday;
the Tue–Sun statement lists the 4 Monday sign-ups and the 3 Wednesday ones, one cancelled → the week sends 6 (it sent
10 before the fix). Rows dated outside the period keep the statement in **Needs review** with a warning, so an emailed
one never applies itself. Another applied statement of the client that speaks for any of the same days (by its period
or its rows' dates) blocks Apply: "Some of its dates are already covered by the BCN statement for …, which is applied, so
they would count twice." A period that overlaps another's only in part is refused as before. A week where the statement
has nothing for a person (nothing logged and nothing confirmed on its days for them) is **not sent** — no "All 0
confirmed: no change" lines — unless the statement it replaces sent it.

*A statement sent again for exactly the same period* **replaces** the applied one (`superseded_by`). Every (person,
week) the old one sent is sent again; people only the old one listed (`dropped`) go back to their logged subs. Before
calling P1, P3 hands the old statement's correction lines that still wait on an unpaid week
(`pay_adjustments.statement_id`, kind cancellation / statement) to the new statement, so P1's
`applyConfirmedSales` updates each line in place: one line per person, week and campaign ("2 cancelled by BCN: paid for
22, confirmed 20", −£X), not a −£80 line plus a contradictory +£40 one. A line already paid out stays with the statement
it was paid for. The preview does the same inside a savepoint that is rolled back, so it shows exactly what Apply does.

**Applying** makes sure last week's pay runs exist (`ensurePayrollMaterialised`, which P1 only does outside a
transaction), then in **one savepoint**: the hand-over of a replaced statement's waiting corrections, P1's
`applyConfirmedSales(db, rows, { statementId, actorId })` (P1 nests its own savepoint and is idempotent per statement:
unpaid weeks are recalculated; for paid weeks the difference becomes an adjustment on the next unpaid run), and P3's
per-week allocation, the replacement link, the effect, the status and the template. A failure anywhere leaves nothing
half done. Paid runs are never touched by P3. The response cache is bumped.

**The mail job** (`lib/statements/mail.ts`, `job.ts`). One minute after start-up and every 15 minutes while the server
runs, when the check is on: connect to `imap.gmail.com:993` (TLS) with the address and the decrypted app password, open
Gmail's All Mail (the `\All` special-use folder, else INBOX) with **EXAMINE — read-only**: nothing is marked read,
flagged, moved or deleted; search for messages FROM the listed senders with a UID above the last one seen (the first
time: the last 60 days); download at most 40 per check; parse each with mailparser; every PDF attachment (up to 20 MB)
goes through the same path as an upload, keyed `<Message-ID>#<n>` so it is stored once; a message whose From is not a
listed sender — or that has no From at all — is skipped. The mailbox, its UIDVALIDITY and the last UID are kept (a new
UIDVALIDITY or address starts again from 60 days back; Message-IDs keep it from storing anything twice). An email that
fails to process (a full disk, a bug) stops the cursor just before it, so the next check tries it again; after 3 failed
checks it is skipped with "One email (UID n) could not be read after 3 tries, so it was skipped. Open it in Gmail and
upload its PDF in Finance → Statements."

*Is it really from the client?* A From address can be faked, so an email statement applies itself only when Gmail
confirmed the sender (`senderAuthenticated`, stored as `statements.sender_verified`): the **topmost**
`Authentication-Results` header — the one Gmail's own servers (`mx.google.com`) add on arrival; a lower one could have
been written by the sender — says `dmarc=pass` with `header.from` aligned to the From address's domain, or `dkim=pass`
signed (`header.d` / `header.i`) by an aligned domain (the same domain or a subdomain; never a bare `.com`). SPF alone
is not enough. Otherwise it waits in **Needs review** with "Gmail could not confirm that this email really came from
Breast Cancer Now …". Failures become sentences: "Wrong app
password: …", "Gmail wants an app password, not your normal Google password …", "IMAP is off in Gmail …", "Google
stopped the sign-in …", "Could not reach Gmail (imap.gmail.com) …". `LM_STATEMENTS_JOB=0` turns the job off. Tests
use a fake mail source (`setMailSource`) and .eml messages; nothing in the tests talks to Gmail.

**Demo seed** (`lib/statements/demo.ts`, a fresh demo seed only): the senders for BCN and CHN, BCN fundraiser IDs
(`FR-2041`…) for everyone who has worked BCN, and three statements built from the seeded gauges and **lined up with P1's
seeded pay** (`sale_confirmations`, only read), so applying one never contradicts what pay already says — BCN for **last
week** (P1's demo has not had BCN's statement for it yet and its runs are unpaid; one row per fundraiser with IDs; at
least three people with cancellations; all matched; "Needs review" because BCN's columns are not saved yet; Apply
recalculates those weeks: "1 cancelled by BCN: the week's pay goes from £360.00 to £340.00 (not paid yet)"), CHN for
**the four pay weeks before last week** (one row per sign-up; each person's cancellations per week are exactly what
P1's seed confirmed, so Apply reads "no change"; one rep written with an initial, "J. Lee", so those rows wait for a
pick), and a CHN remittance advice with no table ("Couldn't read"). Where P1's seed has no confirmation for a person and
week, the cancellations are drawn. The demo emails count as confirmed by Gmail. Their PDFs are
drawn with jsPDF the first time someone opens one (the specs are in meta `ext:statements:demo`), so seeding writes no
files; a test checks each PDF reads back exactly as the seed stored it. Nothing is applied in the demo (applying would
change payroll runs, which a seed must not).

**Tables and columns** (P3 adds to its own `statements` table: `table_json`, `mapping_json`, `mapping_source`,
`layout`, `effect_json`, `sender`, `subject`, `superseded_by`, `sender_verified`; new table `statement_allocations
(statement_id, user_id, campaign_id, week_start, logged, confirmed, week_confirmed)`). Nothing is added to core tables.
The one write outside P3's tables is the hand-over above: `UPDATE pay_adjustments SET statement_id` for a replaced
statement's lines still waiting on an unpaid week.

## User guide

**Finance → Statements** (administrators). Every commission statement the clients emailed you (once Gmail is connected)
or that you uploaded, newest first: the campaign, the period, when it arrived, how many rows matched a person, and its
status — **Needs review**, **Ready to apply**, **Applied** or **Couldn't read** (on a phone the status sits under the
campaign). An applied statement that a corrected copy replaced also says **Replaced**. The top of the page says whether Gmail
is being checked. **Check Gmail now** looks straight away; **Upload statement** takes a PDF from your computer or phone.

Open a statement to check it:

- **Before you can apply it** lists what is left, in plain words: rows nobody is matched to, a missing campaign or
  period, a column the client's saved columns expect but this statement does not have, or dates another applied
  statement already covers.
- The blue box says what is worth a look: Gmail could not confirm the email came from the client, some sign-ups are
  dated outside the statement's period (they count on their own days, in place of what was logged), or **This replaces
  the BCN statement for … applied on …** — applying the corrected copy puts pay right to its figures, and a correction
  already waiting on an unpaid week is changed rather than added to. Anyone on the old copy but not the new one goes back
  to the subs they logged (listed under Pay).
- **Pay** shows, for each person on the statement, the subs they logged in the period, what the client confirmed, and
  how many were cancelled, with the pay effect: Linear Hub works out what applying would change before you press
  anything.
- **Rows** shows the statement's rows and who each one is. For a row nobody matched, choose the person in **Pick the
  person…** (or **Not one of ours**). Every other row written the same way gets the same choice, and if the row had the
  client's fundraiser ID, Linear Hub remembers it as that person's ID for next time.
- **Details**: fix the campaign or the period if the PDF did not say them, then **Save campaign and period**.
- **Columns**: which column holds what. Linear Hub reads the headings itself; if it got one wrong, change it and press
  **Save columns for BCN**. Applying the first statement from a client saves its columns too, so the client's next
  statements in the same layout **apply themselves** as soon as they arrive, when every row matches.
- **Apply** corrects pay: weeks not paid yet are recalculated with the confirmed subs; for a week already paid, the
  difference goes on that person's next unpaid pay run with a line saying why. Paid runs never change. A statement for a
  period longer than a week takes cancellations off its latest week first.
- **Discard** removes a statement that is not applied (a remittance advice, a wrong file). **Open PDF** shows the PDF;
  on a laptop or tablet **Show it here** shows it in the page. Opening or downloading a statement PDF is on the audit
  trail.
- A statement that was replaced says **Replaced by the statement received …** with a link; pay follows the newer one.

**Settings → Integrations** (administrators): your Gmail address and an **app password**, **Save**, **Test
connection**, and **Check for statements every 15 minutes**; below, **Statement senders**: for each campaign, the
address its statements come from (only those emails are read). **How to make an app password** explains the steps.

**Team → a person → Client IDs** (administrators): the person's fundraiser ID at each client, exactly as the client's
statements write it. A statement row with that ID matches them even if the name is spelt differently.

The dashboard's **Needs attention** box (and the bell) shows a statement that needs a look ("BCN statement for 12–18
Oct 2026 needs a look", with what to do), one that could not be read, one ready to apply, and a Gmail check that keeps
failing.

## Owner notes

- **Making the app password.** Sign in to the Google account of the Gmail address. Turn on 2-Step Verification (Google
  account → Security) if it is not on; app passwords need it. Open **myaccount.google.com/apppasswords**, name it
  "Linear Hub", press **Create**, and paste the 16 letters into Settings → Integrations → App password, then **Save**
  and **Test connection**. In Gmail, Settings → See all settings → Forwarding and POP/IMAP: **IMAP** must be on. If
  Google says app passwords are not available, 2-Step Verification is off, or (for a work Google account) the
  administrator does not allow them, or Advanced Protection is on.
- **What Linear Hub reads.** Only emails FROM the sender addresses you list, and only their PDF attachments. It opens
  the mailbox read-only: it never marks anything read, never moves, labels, flags or deletes mail, and never sends any.
  The app password is stored encrypted with the app secret (`server/data/app-secret` or `LM_APP_SECRET`), is never
  shown again or sent by any page, and never appears in the audit trail.
- **Removing access.** Press **Remove app password** in Settings → Integrations, or delete the "Linear Hub" app password
  at myaccount.google.com/apppasswords (that stops it at once, wherever Linear Hub runs). Changing your Google password
  also revokes every app password.
- **Back up `server/data/statements/`** with the database: the nightly backup copies the database only. A statement
  whose PDF is missing still opens; only its PDF is gone.
- **Please send a real (redacted) statement from each client** (BCN, CHN, Volt Energy, FibreCity — names and IDs can be
  blacked out, the layout matters): the reader is built and tested on statements made to look like the usual layouts,
  and a real one lets us check its headings, its period line and the way it marks cancellations. Until then, the first
  statement from each client waits for you to check its columns once.
- **Decisions you may want to change:** uploads never apply themselves (you are there to check them). Emailed
  statements apply themselves only when the client's columns are saved, every row matches, every row is inside the
  period, **Gmail confirmed the email came from the client** (DKIM / DMARC), and it does not replace one already applied;
  otherwise they wait in Needs review. A period total's cancellations come off the latest week first. People who logged
  sales but are not on a statement keep their logged figure (the statement may be partial). A corrected copy for the
  same period replaces the old one completely: people only the old copy listed go back to their logged subs. A statement
  that overlaps an applied one only in part, or whose rows are dated in another applied statement's days, is refused
  rather than guessed.
- **For the lead and P1 (merge):** (1) replacing a statement moves the old statement's correction lines that still wait
  on an unpaid week to the new statement (`pay_adjustments.statement_id`) so P1's `applyConfirmedSales` updates them in
  place — the only write P3 makes outside its own tables; P1 may prefer an explicit `replacesStatementId` option. (2)
  When the old correction was already paid out, P1 adds a second line for the difference and its sentence reads "Paid for
  22, 2 cancelled by BCN, so +£40.00" (relative to what was paid, not to the corrected figure); P1 owns that wording. (3)
  Statement uploads (admin only, 20 MB each) are not in `middleware/writeLimit.ts`'s limited routes; the lead may add
  `/statements/upload` there.
- The demo database has three statements (BCN, CHN and a CHN remittance advice) and none applied, so you can try
  Apply. An upgraded 1.2 database starts with none, no senders and no client IDs.
