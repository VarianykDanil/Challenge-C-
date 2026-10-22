# Linear Hub 1.3: notes for the owner

What Matt needs to know, set up or decide for each part of 1.3, collected from the engineers' notes. Settings named in **bold** are where you change them.

## Pay: base or commission, whichever is higher; cancellations

- **Paid weeks never change.** A client's cancellation after payday takes the difference off the person's next unpaid week, as a line they can see with its reason. Because the base is a floor, a cancellation only costs as much as it changes the week: a week paid the base loses nothing.
- **Bonuses are by hand only**, as decided. Nothing is added automatically: not a sales bonus, and not a leader's override.
- The owner's own plan is treated as salaried (no day rate and no commission), so it gets no weekly pay from the rule date. Give a plan a day rate if someone on it should be paid weekly.
- **The rule date** is Monday of the week 1.3 is installed. If Matt wants earlier unpaid weeks paid by the new rule, he can move it back in Settings → Pay; only unpaid weeks move.
- **The demo rates are illustrative** (BCN £20, CHN £18, VLT £35, FCB £15 a sub to the rep). Set the real rates with **Add a rate** before the first 1.3 payday.
- **A dispute settlement is not netted against a later statement.** If P2's office settles "I made 18, not 16" with a dispute line and the client's statement later confirms the 18, the statement's correction is worked out without that line (a dispute may be about something else, such as a missed day). Check a statement's preview against open disputes for the same week.
- Statements for a 1.2 week paid by the 1.2 code start from the run's own sales; when gauges at several campaigns of that week were changed after payment, the split of those sales per campaign is approximate (the difference is put on the campaigns with the most sales).
- An unpaid week from before the rule date that the 1.2 code worked out keeps its figures when someone's plan or team changes. Its breakdown shows those figures, and they are what **Mark paid** pays. To pay it on the new plan, change any of that week's gauges (the run is then worked out again), or settle the difference with an adjustment.
- Applying a statement of 477 rows (every person, campaign and week of 8 weeks of the demo) takes about 100 ms, a dry run about 95 ms; applying it again changes nothing.
- For the lead and the other packages:
  - The dated-rate takeover runs inside `rollForwardEventStatuses` (P1's `db/maintenance.ts`), which the foundation's 15-minute sweep in `index.ts` already calls. The lead may prefer its own call in `index.ts`: `applyDatedRates(db)`.
  - P2: a run can now be refused by **Mark paid** because it is below £0 (409, before the invoice check). Agree how a self-billed invoice shows money owed, and have the bulk **Mark week paid** skip such runs and say so.
  - P2's disputes call `addPayAdjustment`: a dispute line that would take a finished week below £0 is refused with a 400 in the same words.
  - P2's payslip and invoice still show plan hints such as "N sales × £0.00", and the foundation's UserDetail plan card still shows "Commission per sale £0.00". Both should switch to the breakdown lines, for example `lines` from `GET /pay/breakdown`.
  - `attention.ts` wording still uses `plan.basePerDay`.
  - P2 must reissue an invoice when a run's total changes: a bonus, a statement or a rate.
  - P3 may set `statement_id` on the seeded `sale_confirmations`.
  - The seed's payroll uses its own random stream, so the hours of announcement `created_at` values moved.

## Self-billing invoices: accept or dispute

- **Who is invoiced**: reps and leaders. Recruiters and administrators (you, Marcus) still get a payslip, because they
  are office roles. If recruiters are self-employed too, say so: it is a one-line change (`INVOICED_ROLES`).
- **Have your accountant read the agreement** (Settings → Company → **Agreement text**) before go-live. HMRC expects a
  self-billing agreement with each supplier, reviewed every 12 months for VAT-registered suppliers. Changing the
  wording means a new version (`SELF_BILLING_AGREEMENT_VERSION`) and everyone accepts again.
- **VAT**: Linear Hub never adds VAT. If someone is VAT registered, their invoices need VAT on top: talk to your
  accountant before paying a VAT-registered person through Linear Hub. The invoice prints their VAT number and says
  "No VAT has been added to this invoice."
- **Fill in Settings → Company** first: the postcode and company number are empty in the demo (the invoice prints
  what is there). The owner's name is the default signatory.
- **On your existing database**, the first start of 1.3 issues invoices for every unpaid field run (pending runs and
  failed transfers); already paid weeks get none. Last week's have the usual Thursday 12:00 deadline; older unpaid
  runs, whose payday has gone, get 24 hours like any late invoice (then they count as accepted). **Upgrade on a
  Monday, Tuesday or Wednesday morning**: upgrading on Thursday afternoon gives last week's invoices until Friday
  afternoon, so on Friday morning Mark paid needs each person's acceptance or your reason. Everyone is asked to accept
  the agreement on their next visit.
- **The deadline rule (lead decision, for your accountant)**: "12:00 the day before payday, or 24 hours after the
  invoice was issued, whichever is later", so nobody's invoice counts as accepted before they could see it. The cost:
  an invoice that changes on Thursday afternoon or on payday is not paid automatically on Friday morning unless the
  person accepts it (they get a notification) or you pay it with a reason. Clause 3 of the agreement says so ("You
  always get at least 24 hours…"). The agreement's version is unchanged (2026-10): nobody outside the demo has
  accepted it yet. Bump `SELF_BILLING_AGREEMENT_VERSION` if a real person accepted the earlier wording.
- **Decision for you (and your accountant): deemed acceptance without an agreement.** "Counts as accepted at the
  deadline" is a term of the self-billing agreement. Today an invoice still counts as accepted at the deadline when
  the person has not accepted the agreement yet (otherwise nobody could be paid in the first week without a reason),
  and the invoice says so: "Deemed accepted … (the self-billing agreement was not accepted yet)". If you would rather
  such invoices wait for acceptance (or a reason), say so: it is a small change.
- **Paying without acceptance** is possible with a reason (kept with the invoice and in the audit trail) for an
  invoice still waiting; never for a **disputed** one, which is held until you answer it (the lead's rule, taken
  literally). Bulk Mark paid never pays a waiting invoice for you.
- **Back up the signature image**: it lives in `server/data/uploads/`, which the nightly database backup does not
  copy (the invoices keep working without it; they just show the name).
- **A reissue keeps the invoice number** and raises the version (the earlier versions are kept and shown). If your
  accountant prefers a credit note and a new number for corrections, that is a change to make before go-live.
- **For the lead**: (1) the bulk confirm step's count is fixed with a three-line change in `pages/Finance.tsx` (P1's
  page: `payableRuns` from `features/finance/bulkPay.tsx` for `flaggedSelected` and the confirm label), and its
  description now comes from `bulkConfirmDescription` (same file, one more line); keep both when merging. (2) The self-service invoice writes have their own 60-a-minute limiter inside `routes/invoices.ts`; if P9
  adds `/invoices` prefixes to `WRITE_LIMITED_ROUTES`, drop it. (3) Removed runs leave void records in
  `invoice_voids` (no screen yet). (4) Merged with P1 the "Fix and reissue" correction moves the run's gross, and the
  lines come from P1's `weekPayBreakdown`; the P2 tests pass with and without P1. (5) Last fix round: the test server
  in `server/src/test/helpers.ts` keeps idle sockets for 120 s (`server.keepAliveTimeout`), because r3-contracts'
  "anonymous → 401" test failed with ECONNRESET ("fetch failed") in every full `npm test` run on the merged tree: the
  synchronous extension-seed test before it blocks the event loop for ~6 s, longer than Node's 5 s keep-alive timeout,
  and the next request went out on a pooled socket the server then reset (integration-trial item 5). One line, test
  only; drop it if the foundation fixes the flake another way. (6) The attention feed's 12-statement budget is met
  for the admin again (13 → 12) by P2's provider alone; the leader is exactly at 12.

## Client statements from Gmail

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
- **A listed person's days with no row count as cancelled** (they are not "kept as logged" like people the statement
  does not list at all). The statement now says so and waits for you. Tell us if you would rather such days kept the
  logged figure.
- **For the lead and P1 (merge):** (1) done in the last fix round: P1's `applyConfirmedSales` takes `replacesStatementId`
  and re-keys its own lines, and P3 no longer writes `pay_adjustments`. (2)
  When the old correction was already paid out, P1 adds a second line for the difference and its sentence reads "Paid for
  22, 2 cancelled by BCN, so +£40.00" (relative to what was paid, not to the corrected figure); P1 owns that wording. (3)
  Done in the last fix round: uploads and Check now have their own per-person limits in P3's router.
- The demo database has three statements (BCN, CHN and a CHN remittance advice) and none applied, so you can try
  Apply. An upgraded 1.2 database starts with none, no senders and no client IDs.

## PDF downloads

- PDFs are made on the phone or laptop, not on the server: nothing extra is stored, and the "Generated" time is the
  device's clock.
- The built-in PDF font covers English and Western European letters. Other accents are stripped (Polish "Ł" → "L",
  Romanian "Ș" → "S"), Cyrillic and Greek names are spelled in Latin letters ("Иван Петров" → "Ivan Petrov"), and
  emoji and other scripts (Chinese, Arabic…) print as "?". **Decide before the self-billing invoices ship (P2 draws
  them with these blocks):** is a Latin spelling acceptable on an invoice, or should we embed a font that prints every
  name exactly (each PDF about 100–300 kB larger)?
- The audit PDF holds every entry that matches the filters, up to 2,000 (filter by person, record or dates for a
  longer period) — once the Audit page passes its filters to the button (a one-line change for P9 / the lead, in API
  above); until then it is the 50 entries on screen.
- Downloads made without signal are recorded when the phone is back online (stamped then; the file name keeps the
  day). If someone clears the browser's data first, or more than 100 wait, the oldest are lost. Invoice, candidate,
  interview-sheet and venue-report PDFs made without signal are not recorded until those pages use the waiting
  queue (a one-line change each, listed under API for the lead).
- A PDF never prints a line that a spreadsheet would run as a formula: any line (also the second line of a note, or a
  line the page wrapping starts) beginning with = + - or @ and more than a number gets an apostrophe in front, as
  the CSV does.
- The Xero / Sage **Export for payroll** file is unchanged (an import file for payroll software, so no PDF).
- Decision for the owner (optional): the PDF tables use the same columns as the CSVs. If a printed version should
  leave out a column (e.g. the payroll Reference), tell us which and we'll trim the PDF only.

## Learning videos

- **Back up the media folder yourself.** The nightly backup (and `npm run backup`) copies the database only, never the
  video files. Uploaded videos live in `server/data/media/videos/` (next to the database; Settings → Learning videos
  shows the exact folder and its size). Copy `server/data/media/` when you back up or move Linear Hub. After restoring
  an older database, videos uploaded since have no row (their files can be deleted); a video whose file is missing
  says so on its page — copy the folder back or upload it again.
- A fresh `npm run seed` starts a new database but leaves files already in `server/data/media/` on disk; delete the
  folder if you do not need them.
- **The three demo videos are examples**: public TED talks on YouTube, marked Example. Delete them (Edit → Delete video)
  once you have your own. Your own upgraded database has no videos until you add some.
- Leaders cannot add videos until you turn on **Settings → Learning videos → Leaders can add videos**; a leader can
  then change or delete only the videos they added (you can change any). Turning it off keeps their videos.
- Uploads are stored as sent: nothing is converted. MP4 (H.264) plays everywhere. A MOV from an iPhone recorded in
  HEVC ("High Efficiency") may play only in Safari; set the iPhone camera to **Most Compatible** or upload an MP4 for
  Android phones. A file of 2 GB over a phone hotspot can take hours — upload big files on Wi-Fi.
- **Mark as watched** (Google Drive, or a player that does not report) is trusted: Who watched shows "Marked" for those
  rows so you can tell them from videos watched to 90%. Prefer YouTube (unlisted), Vimeo or an upload for required
  videos you want measured. Watching itself is measured by the browser; the server counts it no faster than playing
  at double speed, so a required video cannot be ticked off in one go, but a determined person could still leave a
  video playing unwatched — the numbers say a video was played, not that it was understood.
- **Disk space on Fly.io or Render.** Uploads sit on the same volume as the database and its backups. Those plans
  start with a 1 GB volume: Linear Hub refuses an upload that would leave less than a tenth of the disk free (507 with
  a plain message), but one 800 MB video would still nearly fill it. Before uploading videos there, grow the volume
  (e.g. 10 GB), or use YouTube (unlisted), Vimeo or Google Drive links instead. On the MacBook the reserve is 500 MB.
- **Lead merge note (app.ts, foundation-owned): applied in the last fix round.** The blanket bump in `server/src/app.ts`
  skips progress reports (`isVideoProgressReport`), so people watching no longer keep the cached dashboards and team
  views cold. The team view's in-progress dots lag by up to the cache's 20 s, and "watched" shows at once (the route
  clears the cache itself). `videos-trust.test.ts` expects 0 and 1 bumps.
- **A short video:** a viewing starts with 40 s of credit, so a video up to about 44 s long can still be ticked off by
  one report. Watching is measured by the browser; this only stops one request from claiming a longer video.
- YouTube plays from youtube-nocookie.com (no YouTube cookies until someone presses play) and Vimeo with Do Not Track.
  Uploaded videos are served only to signed-in staff in the video's audience, never cached by the browser.

## Client accounts and campaign pages

- **A PIN is now required for every client account** (except the seeded demo client, so the demo button keeps
  working). Whoever signs in first with the email and access code sets the PIN, so send the invite to the client
  contact directly; if anyone else might have seen it, **Reset PIN** and send it again.
- The access code is shown in the client accounts list (like an employee ID in Team); the instructions are shown once,
  right after **Invite**. Codes start at CL-0002 (CL-0001 is the demo's).
- Turning an account off signs it out at once and keeps its posts. There is no delete: a former contact stays in the
  history of what they posted.
- **Approve** needs P1's pay rule (the campaign rate history). Approving sets a new rate from the date you confirm.
  If that date is in the past, unpaid weeks from it are recalculated, but **weeks already paid keep the old rate and
  nothing corrects them automatically**: if someone should get the difference, add it yourself with **Add an
  adjustment** (Finance → Company → Bonuses and corrections). The Approve dialog warns you when the date reaches a paid
  week and the change has a new rate to the fundraiser (a payout-only change needs no pay correction, so no warning).
- Unpublishing removes the announcement for everyone and cannot be undone from the app (the text stays in the client
  post and the audit trail); ask the client to post again if it was a mistake.
- Decide: should leaders also be able to approve or decline commission changes? Today only administrators can.
- Decide: posts older than 30 days no longer count as new for the sidebar badge and Needs attention. Change
  `CLIENT_POST_UNREAD_DAYS` in `shared/src/logic/clientPortal.ts` if you want longer. (A change waiting for your
  decision stays in Needs attention until you decide it, however old.)
- Decide: the client contact's name, email and phone are now shown only to admins and leaders. Reps with a team see
  "Questions for Breast Cancer Now go through your team leader or the Linear MCR office"; recruiters and reps without a
  team see "… go to the owner or another administrator". Say if you want the field team to have the contact's
  details.
- Decide: in narrow cards (phones, and the dashboard's third column) the badge reads "From BCN"; the full "From
  Breast Cancer Now" shows where the card has room, and screen readers and the hover text always get the full name.
  Showing the full name everywhere needs the announcement title row (the foundation's `Announcements.tsx`) to wrap.

## Recruitment: date of birth, schedule, question bank, interview sheets

- **Default questions.** Your database gets the 25 default questions on the first start of 1.3 (Settings →
  Recruitment: interview questions). They are a starting point: edit them to your own words. Changing a question never changes an interview
  that already has a saved sheet.
- **Lawful questions.** The warning in Settings is a gentle check, not legal advice: interview questions should be about
  the job only (Equality Act 2010). Availability ("Which days can you work?") is fine; family plans, health, age,
  religion and nationality are not. Right-to-work checks belong in your onboarding process, not in the interview.
- **Date of birth is personal data.** Only administrators, leaders and recruiters can see it (recruitment is theirs
  already), it is not in the candidates CSV, and it is not copied to a person's account when they are hired. Recording
  it is optional; the profile warns when a candidate is under 18 so the extra rules for young workers (hours, breaks,
  supervision) can be checked before an offer. Under 14 or over 100 is refused as a likely typo in the year.
- **Interviews booked before 1.3** have no record of who booked them or of earlier interviewers; the timeline shows what
  was recorded (the stage moves always had who made them). Old interviews have no sheet until someone opens and saves
  one.
- **Leaders and recruiters can edit any sheet** (as they can edit any interview today); every save is in the audit
  trail with who wrote it, and each answer shows who last changed it (on the sheet and in the candidate's Questions
  and answers). Two devices on one sheet never overwrite each other: a clash on the same question asks the second
  person to choose. Opening a sheet is reported to the audit trail like opening the candidate's profile (once P9 fills
  `RecordOpened`).
- **For the lead / P9:** `lib/auditSpecs.ts` `candidateSnapshot` (P9's) has no `dateOfBirth`; P7 refines the two 1.2
  candidate specs from `recruitmentSpecs.ts` to add it (the same pattern as P6's campaign specs). If a 1.2 spec is not
  found it is skipped with a warning (no crash). Better: at merge, P9 adds `c.date_of_birth AS dateOfBirth` to
  `candidateSnapshot` and the refinement (`withDateOfBirth`) is dropped.
- **For the lead: a renamed label.** The plan says "Question bank: Settings → Recruitment"; the card is titled
  **Recruitment: interview questions** so both words are on screen.
- **For the lead: PUT /answers changed shape during the review fixes** (P7's own route, unreleased): questions left out
  of a save are no longer taken off (`removed: true` does it), each item may carry `base`, and a clash answers 409. No
  other package calls it. The re-review fix adds optional `device` + `version` per item and `device` on each answer
  (additive), and two columns, `interview_answers.device` and `device_version` (in the CREATE TABLE, and
  `addColumnIfMissing` for a database made by an earlier 1.3 build: its start-up line then reads "Upgraded schema:
  added recruitment:interview_answers.device, recruitment:interview_answers.device_version" once; a 1.2 database gets
  them with the new table and reports nothing extra).
- **For the lead: one test-harness line outside P7** (`server/src/test/helpers.ts`, `server.keepAliveTimeout = 0` on
  the test server): `r3-contracts` "anonymous → 401" failed with "fetch failed" (ECONNRESET) in 3 of 4 runs on the
  merged code, because the test before it blocks the shared event loop for about 5 s (a full seed) and the server's
  5 s keep-alive timer closed an idle socket as fetch reused it. With the line, 5 of 5 runs pass. The main chunk grows by 0.57 kB
  (472.19 → 472.76 kB) only for the preload map of the new lazy chunks; no P7 code is in it.

## Venues, rosters and event plans

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

## Audit of every action

- **Failed sign-ins are recorded from now on.** They are filed under the account the email belongs to, so a person's
  Activity shows attempts on their account even when it was not them typing (worded "Attempt on … account", never as
  their action). An email nobody has is recorded with the email typed — only when it is an email, never an employee
  ID, PIN or code — so you can see which addresses someone tried.
- **How much is recorded in a flood (a trade-off).** Per 15 minutes: 30 failures per account, and for emails nobody
  has 30 per address and 600 in all, each followed by one row saying recording paused. A flood of made-up emails —
  from many addresses or from the same one — can no longer hide a try on your account (each account has its own room,
  and a try on a real account never uses an address's room), but a determined attacker who sends more than 30 tries
  at one account in 15 minutes is recorded for the first 30 plus the pause row (on that person's Activity), not for
  every try; the sign-in limiter and the PIN lock still block the tries themselves. Worst case on disk: 600 + 30 ×
  accounts tried rows per 15 minutes.
- **Sign-outs by the idle timeout are recorded** ("Signed out after 12 hours without activity (last active 18:02 Wed
  21 Oct)"), when the person comes back or when the server starts. They do not count as the person being active.
- **What is still not recorded**: page views, reading a list, a session that reaches its 14-day end (the next request
  asks to sign in), a refused request other than a sign-in or security check (a rep trying to open the office pages
  gets 403 and nothing is written), and a request refused by the client guard.
- **Text that could display misleadingly is cleaned**: a page's report or an email typed at sign-in that carries
  invisible right-to-left or zero-width characters is stored without them (or, for an email, not stored), so the trail
  never shows a name or file reversed. Rows written before this release are shown as they were stored.
- **For the lead: P3's docs sentence** for a statement download now reads "Exported the BCN statement for 12–18 Oct
  2026 as PDF" (with "the"), and the row is filed under the statement; P3's code needs no change.
- **Opened records come from the page.** The phone or laptop reports them, and the server checks the person may open
  that record before writing anything. Someone using the API directly without the app could open a record without the
  "opened" row; every change they make is still recorded by the server.
- **An existing database** gets the new column on the first start (`audit:audit_log.kind`) and its rows are classified
  once: sign-ins, the payroll exports and changes. Nothing is deleted; the two-year retention is unchanged.
- The Audit page's line under the title is the page's own ("Everything done in Linear Hub: …"); `COPY.nav.audit`
  still says "Who changed what and when" (foundation copy) and the lead may want to change it there.
- **For the lead (integration I1):** the Audit page now passes `total` and `query` to P4's **Download PDF**, so the PDF
  holds every matching entry (checked: 91 of 91, not the 50 on screen). The PDF's **Who** column is P4's
  (`client/src/features/pdf/auditPdf.ts`, `userName` or "Linear Hub"), so it still prints a failed try on Jordan's
  account as "Jordan Lee"; the page's wording is `auditActorName` in `client/src/features/audit/kinds.tsx` — left to
  the P4 fix (its list has "audit … Who"), so the two branches do not edit the same line.
- **Sign-outs by the idle timeout** are written from the foundation's `middleware/auth.ts` (two calls to
  `lib/audit/sessions.ts recordIdleSignOut`: `authenticate` and `purgeExpiredSessions`), the hook P9 asked for.

## Client accounts and the foundation

- The demo client account is part of the demo data only: a **fresh** demo seed (`npm run seed`) creates it and records
  it as the demo account. It has no PIN so the demo sign-in works; P6 makes a PIN required for every other client
  account. It never appears in Team, the search palette, payroll, leaderboards or read receipts.
- **An existing 1.2 database (yours) upgrades without the demo client**: no Hannah Price, and no client button on the
  sign-in page. That is deliberate — the upgrade never adds a sign-in that needs no PIN to a database that may hold
  real data. To see the demo client, start from a fresh demo seed (a copy, not your live data); or invite a real client
  once P6 lands.
- Client accounts sign in with their email and an access code, like staff use their employee ID. The first client you
  invite gets CL-0002: CL-0001 is kept for the demo account, so a real client never shares its code.
- A client account sees only its own name, email, access code and campaign about itself: the pay plan its account is
  attached to (the owner's, because every account needs one) and team fields are never sent to it.
