# Changelog

All notable changes to Linear Hub are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). API changes are additive within a major version: no
response field is renamed or removed, and new fields are optional.

## [Unreleased]

What comes next is in [docs/ROADMAP.md](docs/ROADMAP.md).

### Changed

- The public page (`/welcome`, and `/` when signed out) no longer shows anything about pay or the internal playbook.
  Gone: the six gauges, the law of averages and its benchmarks, weekly pay and paydays, the sample payday figure and
  sales funnel, and the "One sign-in per person" section with its sign-in instructions. In their place: "How we work"
  (training, teach-backs, coaching and planned events), the training pack's three core principles and its full
  eight-level career ladder (what you learn at each level and what it takes to move up, with no pay, incentives or
  targets), and a "Private and secure" section. A new test (`server/src/test/public-page.test.ts`) fails if pay,
  money amounts, the gauges, the benchmarks or the sign-in details ever come back.

### Fixed

- `npm run build`, `npm start`, `npm run latest` and the other commands now also work from the top folder of the
  repository, the folder above `linear-micro-crm`. Run there, they failed with "Could not read package.json"; now each
  one changes into `linear-micro-crm` and runs the same command, and `npm install` there installs Linear Hub.

## [1.4.0] - 2026-10-25

Two-step verification for everyone, a sign-out 14 hours after sign-in, and paying people from Linear Hub in four ways.
Details: [docs/USER_GUIDE.md](docs/USER_GUIDE.md) ("What's new in 1.4"), [docs/LOGIC.md](docs/LOGIC.md) §17,
[docs/API.md](docs/API.md) ("1.4 endpoints") and what the owner must set up or decide in
[docs/OWNER_NOTES_1.4.md](docs/OWNER_NOTES_1.4.md).

### Added

- **Two-step verification for everyone.** Every account that signs in — administrators, team leaders, recruiters,
  field reps, and charity and client accounts — uses a 6-digit code from an authenticator app at every sign-in (no
  "remember this device", no email or text codes). Anyone without it sets it up at their next sign-in; a charity or
  client account does it after its PIN. The demo sign-in accounts are left out while Linear Hub is still the demo, so
  one-click demo sign-in keeps working; anyone added or invited is not, even on the demo.
- **Signed out 14 hours after signing in**, whatever you are doing; you sign in again with your code, and the sign-in
  page says why ("For security you are signed out 14 hours after signing in. Sign in again to carry on."). The
  administrator can choose 4 to 24 hours in **Settings → Security → Sign-in rules → Sign out after**. Each automatic
  sign-out is in the audit trail under the person.
- **Nothing lost when you are signed out in the field.** **Log gauges** keeps counts typed but not saved for 24 hours
  and offers them the next time; a save or a one-tap check-in answered "signed out" waits on the phone and sends after
  the next sign-in; the gauge and check-in outboxes also wait while two-step is being set up.
- **Two-step on the client portal**: the **Security** page shows it (status, recovery codes left, **New recovery
  codes**, **Set up**), and the campaign page's **Client accounts** card shows whether each account has it, with
  **Reset two-step** for a lost phone (`POST /client-accounts/:id/reset-2fa`).
- **`npm run 2fa:reset -- <email>`** on the server switches off one person's two-step verification and signs them out
  everywhere (they set it up again at their next sign-in), for when no administrator can do it in the app.
- **Pay people from Linear Hub.** Finance → Company → Runs to pay → **Pay from Linear Hub** opens **Pay people**: choose
  the weeks and how to pay, check the total, each person with the last four digits of their account and who is left out
  and why, approve with a fresh code from your authenticator app, then follow each payment on its page (it updates by
  itself; **Check now**, **Cancel the rest**). Runs to pay shows **In a draft payment**, **Payment on its way** or
  **Payment failed** with the reason. Paid weeks are marked paid exactly as **Mark paid** marks them; failed ones stay
  on Runs to pay.
- **Four ways to pay**, each with its logo and what it can and cannot do, in **Settings → Payments**:
  - **Bank payment file** for any UK business bank: Linear Hub makes the bulk payment file (Starling Bank bulk payments,
    Revolut Business bulk transfer, or a general Faster Payments file); you upload and approve it in your online
    banking, then tick who the bank paid in **Mark as paid** (anyone it rejected stays on Runs to pay with your reason).
    References of at most 18 characters ("LINEAR 05OCT JL"), names folded to plain letters, no cell that a spreadsheet
    could run as a formula, and anyone the bank would refuse left out with a plain reason.
  - **Revolut Business**: Linear Hub pays each person from your GBP account and marks the week paid when Revolut
    completes it.
  - **Wise Business**: Linear Hub creates the transfers and you pay them in Wise (Wise does not let an API token pay them
    for UK businesses); each week is marked paid once Wise has sent the money, and transfers not yet paid can be
    cancelled from Linear Hub.
  - **Open Banking through TrueLayer**: signed payouts from your TrueLayer merchant account. A payout TrueLayer did not
    answer is sent again for 5 hours at most (TrueLayer recognises a repeat for 6); after that it fails with "Linear Hub
    does not know whether TrueLayer made this payout: … Check the payouts in the TrueLayer Console before paying this
    week again.", never sent blind.
- **Test mode first.** Revolut, Wise and TrueLayer connections start in the provider's sandbox; **Switch to live** needs
  PAY FOR REAL typed and a new test against the live service. Each API provider's Connect form starts with **How to
  connect**, every field says where to find its value, and **Save and test** tests an API connection straight away;
  **Edit** on a live connection says it moves real money. A draft made in test mode says plainly that it cannot be
  approved once the connection is live. A test-mode payment
  reads "Test done: nobody paid".
- **Bank details**: everyone adds their own in **Settings → Bank details** (a code from their app to change them);
  administrators see them masked on Team → the person, can type them in, and confirm changed ones with **Confirm
  details**, which confirms exactly the details on screen (if the person changed them again meanwhile, it says so and
  they stay waiting). A payment to changed details waits until an administrator confirms them, and Needs attention says
  so.
- **Needs attention → Payments** (administrators): changed bank details to check, failed payments, bank files waiting
  for your bank (with the people and the money in the file; never the test bank file), a connection whose test failed,
  and a week whose pay changed while its payment was on its way. A bank file that left someone out shows **In the file
  £…** under its total, and its download is audited with what the file holds (a line cancelled later is still in the
  downloaded file, so it still counts).
- **A payment the provider has not confirmed says so**: **Waiting to send** (not "Sent"); the approve message says
  what really happened ("has not confirmed it yet: Linear Hub tries again every 5 minutes", a refused payment counted
  as failed and never as sent, "Payment not made" when every one was refused), and the provider's "pay the transfers
  now" note waits until something was really sent. While Linear Hub does not know whether the provider made a
  payment, Cancel and **Mark paid** by hand wait and say why: with Wise, **Cancel the rest** shows greyed out until
  **Check now** gets an answer; Revolut and TrueLayer payments cannot be stopped from Linear Hub once sent. A live
  payment holds the week meanwhile (TrueLayer for 5 hours after the approval at most); a test-mode one never does. A
  network failure reads "Linear Hub could not reach Wise: check this computer’s internet connection, or Wise may be
  down." instead of "fetch failed".
- **Every payment is safe to send again**: each carries the provider's idempotency key and the account it was approved
  with, so a payment resent after a timeout is never made twice; Linear Hub checks payments on their way every 5
  minutes on its own (`LM_PAYMENTS_JOB=0` turns that off). `LM_PAYMENTS_FAKE=1` adds test providers that pay nobody (they
  stay in test mode, so Mark as paid on the test bank file marks no week paid; the test file says TEST FILE, masks the
  bank details and is never to be uploaded), for trying the screens — never on a real server.
- Bank and payment logos from the CC0 `simple-icons` package (16.34.0); TrueLayer, which it lacks, shows a "TL"
  monogram. Logos belong to their owners and only identify the service.

### Changed

- "Require two-step verification for administrators" is replaced by the line "Two-step verification is required for
  everyone"; its stored setting is kept but no longer decides anything. Two-step can no longer be turned off (except
  on the demo sign-in accounts): **Settings → Security** marks it **Required**.
- Resetting someone's two-step verification now means they set it up again at their next sign-in (not that they sign
  in without it). An administrator's own reset points at a recovery code or `npm run 2fa:reset`.
- The sign-in instructions for a new person (Team → **Add person**) and a client invite (**Client accounts** →
  **Invite**) end with setting up two-step verification and keeping the recovery codes safe; the **Invite** and **Turn
  on** dialogs say so too. A charity or client account's code and PIN steps say "Back to email and access code", and a
  forgotten client PIN points at Linear MCR and the access code.
- Sessions last 14 hours from sign-in (they lasted 14 days), with the cookie's lifetime the same; sessions from before
  1.4 that are older than 14 hours end at their next request. The demo sign-in accounts keep 14 days while it is the
  demo.
- `POST /auth/login`, `POST /auth/login/2fa` and `GET /auth/me` add `session { signedInAt, endsAt, maxHours }`;
  `GET /auth/2fa` adds `required`; `SecuritySettings` adds `sessionMaxHours`; `ClientAccount` adds `twoFactorEnabled`
  (all additive).
- **Mark paid** by hand waits while a week is in a payment from Linear Hub that is on its way (409), so nobody is paid
  twice. Such a week is paid as approved: a change to it meanwhile goes on a later week as an adjustment.
- With two-step required for everyone, every bank details change and every payment approval needs a current code from
  the authenticator app; the demo admin sets two-step up in **Settings → Security** before paying anyone.
- The app secret (`LM_APP_SECRET` or `server/data/app-secret`) now also encrypts bank details, payment keys, tokens and
  bank files: back it up with the database, and keep it apart from off-site copies.

### Fixed

- **Two server tests no longer fail at weekends.** The demo seed could give an interview that had already happened an
  outcome while moving it on to the next Monday (a weekend slot moves to Monday; seeded on a Saturday or Sunday, that
  Monday is still to come), so its change log lacked the outcome. Such an interview now moves back to the last weekday
  since the candidate entered the stage instead (interviews still to come move on to Monday as before). The check-ins
  test seeded the demo on a Sunday, when the demo has no shifts (it works Monday to Saturday); on a Sunday it now
  seeds as of the Saturday before.
- **Tests no longer fail when the business clock is pinned** (`LM_BUSINESS_NOW`, for example to a Saturday): the
  client portal's 30-day read check aged a post by the real clock while the unread count uses the business clock
  (it failed on 1.3.1 already), the client portal's "a change to approve is never pushed out" check stamped its unread
  posts by the real clock (it failed with the business clock ahead of real time), and the payments tests dated
  bank-detail changes by the real clock. All now use the business clock, as the app does. No product code changed.

## [1.3.1] - 2026-10-23

The Sapiens team's demo sign-ins, and leaders and recruiters can add people. Details:
[docs/USER_GUIDE.md](docs/USER_GUIDE.md) ("What's new in 1.3.1"), [docs/LOGIC.md](docs/LOGIC.md) §16.10 and
[docs/API.md](docs/API.md) ("1.3.1 endpoints").

### Added

- **Team Sapiens on the demo, with seven blank accounts.** Theo (leads the team), Daniel, Ridwan and Jamie as Team
  Leaders; Olivia, Owens and Yasmin as trainees (LM-0101 to LM-0107, `<first name>@linear-mcr.co.uk`). Every page works
  for them, with nothing logged: no gauges, events, pay, invoices, learning, check-ins or audit rows. First names only
  until Matt adds surnames. A fresh demo seed adds them at its very end; an existing demo database gains them once on
  its next start (a "Sapiens" team made by hand is reused, and only the missing accounts are added); a database the
  demo seed did not create never does.
- **Sapiens team (7) on the sign-in page**, under the four demo buttons: one tap signs in as any of the seven. Listed
  only from what the seed recorded, like the demo client, and hidden with `LM_DEMO_ACCOUNTS=0`.
- **Charity accounts on the sign-in page.** The demo charity account, **Hannah Price — Breast Cancer Now** (CL-0001),
  now has its own group under the demo buttons with a **Charity** tag. A demo database first made before 1.3 gains the
  account once on its next start, with her demo posts (a declined and a pending commission change, an announcement and
  an update), so the portal is not empty. Only while the database is still the demo: the four demo staff accounts are
  intact and the server is not run with `LM_DEMO_ACCOUNTS=0`; never when someone already holds that access code or
  email, or Breast Cancer Now already has a client account. Both demo-account steps (this one and Sapiens) run only
  when the server itself starts, never from `npm run pin:reset`. The go-live checklist asks you to turn every seeded
  demo person off (`LM_DEMO_ACCOUNTS=0` only hides the buttons), and `npm run service:install` now passes
  `LM_DEMO_ACCOUNTS` on to the service.
- **Team → Add person for recruiters and leaders.** Recruiters add trainees and field representatives to any team;
  Team Leaders and Crew Leaders to their own team. Afterwards **Sign-in details** shows the new person's employee ID —
  the only time a recruiter or leader sees it — with instructions to copy and send; a tap beside it does not close it,
  and an administrator can still find the ID on the Team page. The role, pay plan, status, avatar colour and employee ID
  stay the office's to set; trying to set them is refused with a sentence that says why.

### Changed

- `POST /users`: open to recruiters and leaders under those rules; `employeeId` is optional for everyone (the next free
  ID is given); the answer adds `signInInstructions`. A missing last name answers `400 "Enter their last name"`. It
  counts towards the per-person limit of 60 writes a minute.
  `PATCH /users/:id` stays admin only and accepts an empty last name only while it is still empty.
- `GET /auth/demo-accounts` adds `demoTeams` (additive). A `clientAccounts` item is labelled with its organisation
  ("Hannah Price (Breast Cancer Now)", was "Hannah Price (Client)") and adds `name`, `organisation` and `sector`.
- `client/tsconfig.json` no longer sets the deprecated `baseUrl` (the `@/*` path is relative to the file), so editors stop
  warning about it.
- Names without a surname read well everywhere: "Theo", never "Theo " in a sentence, a label, a CSV or the audit trail;
  initials from the first name alone; the Team list, Finance's payroll runs, the pay export, invoices, a campaign's
  client accounts and "Read by" sort Theo among the T surnames.
- The administrator's form is called **Add person** (was **Add member**), and its employee ID may be left blank.
- `npm run build` installs new dependencies first (`npm ci` when `package-lock.json` changed), so `git pull` followed
  by `npm run build` no longer fails with "Cannot find module 'jspdf'".

### Fixed

- `npm run service:install` passes `LM_STATEMENTS_JOB`, `LM_STATEMENTS_DIR`, `LM_UPLOADS_DIR` and `COOKIE_SECURE` on
  to the background service (the two folders resolved from `server/`, like `DB_PATH`) and warns when either folder is
  in Desktop, Documents, Downloads or iCloud Drive. Before, a service installed with the Gmail reader off still read
  Gmail every 15 minutes, and moved statement or upload folders read as missing.
- `npm run backup` ends by naming the folders it does not copy (`media` for learning videos, `statements` for client
  statement PDFs, `uploads` for the signature image), and `npm run restore` says that those folders are not in the
  backups and were left as they are, and that videos uploaded after the backup stay in `media/videos` with no
  row.
- Plainer messages on the upgrade path: `npm start` and `npm run latest` say "the dependencies were installed after
  the last build" when only the packages changed (was "the app's screens changed"); the start-up line reads "Payroll
  runs: 0 created, 29 brought up to date, 0 removed" (was "recomputed from late gauges", printed also when only a
  week's stored breakdown was added); and a restore without `--yes` and without a terminal says why once, not twice.
- README and DEPLOY.md: the database file no longer "holds everything". Moving to a server copies `media`,
  `statements` and `uploads` with the database, the nightly off-site job copies them too (`rclone copy`, which never
  deletes off-site), Fly.io says how to bring and save them and Render that they need saving too, and the go-live
  checklist asks for it.
- USER_GUIDE: an invoice's **Download PDF** is described as always there (no longer "once PDFs are switched on").
- README "What it does": **Finance & Pay** describes the base-or-commission rule and invoices (not 1.2's base per day,
  commission and leader overrides), and **Export & print** the **Export** menu (CSV or PDF) and the invoice's
  **Print invoice** and **Download PDF**.
- API.md: `GET /health`'s version is no longer given as "1.1.0" (it is read from `server/package.json`), and the 1.1
  version paragraph is marked as history.
- API.md: the public-endpoints note now lists the demo client and team Sapiens that `GET /auth/demo-accounts` returns
  besides the four demo staff.
- CHANGELOG [1.3.0]: the 24-hour rule applies to any invoice issued late, not only a reissue; the settings bullet no
  longer reads as if `npm run pin:reset` were new, and names all three kinds of file the nightly backup leaves out.
- OWNER_NOTES_1.3.md: five build-time notes now describe what shipped: the audit PDF holds every matching entry (up to
  2,000), opening an interview sheet is audited, venues export as PDF with **Venue report**, the audit PDF prints
  "Attempt on Jordan Lee's account", and the test server turns keep-alive off.
- Code comments in `shared/src/types` (client, pay, invoices), `server/src/index.ts` and the client's PDF and payslip
  files no longer promise stubs that answer empty or 501.

- **Bookings and interview sheets have the per-person write limit.** "I'm working this" / "I can't make it" (`POST` /
  `DELETE /events/:id/roster/me`), Edit bookings (`PUT /events/:id/roster`) and the interview sheet's saves (`PUT
  /recruitment/interviews/:id/answers`) had no limit, and each call wrote an audit row and cleared the whole response
  cache: a rep could repeat a booking 200 times a minute. They now share the limit of 60 writes a minute per person
  (`middleware/writeLimit.ts`, matched by pattern, any `:id`): the 61st is 429 "That is more than 60 changes in a
  minute. Wait a minute, then try again.", is not audited and clears nothing.
- **Invoice lines say why.** A self-billed invoice's lines now carry the pay breakdown's note ("8 logged, 1 cancelled
  by CHN", "not yet confirmed by BCN", a correction's "2 cancelled by BCN: paid for 11, confirmed 9"), in grey under
  the description on screen, in print and in the PDF (smaller and grey, through the formula guard). `InvoiceLine.note`
  is optional (additive); invoices issued before this fix keep their lines exactly as issued, and the next version or
  next week's invoice carries the notes.
- **`npm test` no longer touches the real key file.** `server/src/lib/crypto.test.ts` used the default
  `server/data/app-secret` (reading the owner's, or creating one in a fresh clone that a later `npm start` would then
  use); it now points the key file at a temporary folder for the test and puts it back afterwards.

- **An event's name is no longer cut to a few letters** at 768–1280 px: the page header keeps the title at full width
  and puts Log gauges, Pitch, Edit and Cancel event under it when both do not fit; a name longer than the row wraps to
  two lines (also on a phone) before it is cut.
- **The dashboard greeting keeps your name** at 768 and 1024 px ("Good afternoon, …" lost it): the period choice and
  Log gauges move under the greeting when the row is too narrow (the same header change).
- **The dashboard's team card, Upcoming events and Announcements are readable at 1024 px**: two cards side by side with
  Announcements across the row until 1360 px (three cards gave about 210 px each and cut names to "H.").
- **Donut charts stay inside their cards** at 1024 px (Sales by campaign, Payroll punctuality): the ring shrinks to the
  card instead of running 8–28 px past its edge.
- **Card headings are no longer squeezed by their buttons**: the button wraps under a heading that would get less than
  10rem ("Client accounts" read "C…" at 1024 px, "Company details on invoices" was cut on a phone), and a person's side
  cards (contact, invoice details) stack above their performance until 1280 px.
- **Weekly money flow's axis shows the £** (Finance → Company): ticks read "£36K" instead of a clipped "36,000"; the
  tooltip keeps the exact amount.
- **The demo rep always has last week's invoice to accept**: on a demo seeded from 12:00 Thursday to Sunday, Jordan's
  invoice for last week was already "counts as accepted"; it is now issued an hour before the seed, so the 24-hour rule
  keeps it open.
- **An empty table on a phone shows its message in full** ("No pay runs yet…" was centred across the scrolling columns
  and cut off), with no "Scroll to see more" on a table without rows.
- **"Scroll to see more" no longer covers a table's last row**: it is a line under the table.
- **40 px tap targets on phones** for small buttons (a gauge row's Edit and Delete), the filter selects (Events, Team,
  Leaderboard, Recruitment's "Move to…"), table sort headers (were 20 px) and a candidate's rating stars (were 20 px).
- **The top bar no longer shows a cut page name on a phone** ("Recruitm…"); the page's own heading names it, and screen
  readers keep the breadcrumb.
- **An event's header counts the people booked**: "7 booked" before the day and "3 logged · 7 booked" on it, instead
  of "0 reps" next to "Plans for the 7 booked".
- **Sign-in instructions never send a localhost link**: added on the computer that runs Linear Hub, a new person's (or
  a client's) instructions say "Open the Linear Hub sign-in page" instead of `http://localhost:…/login`, which would not
  open on their phone.
- **A candidate's pipeline is readable on a phone**: the steps show their numbers and one line names the current stage
  in full ("Stage 3 of 6: Interview") instead of "App… Pho… Inte… Obs…".
- **The sign-in page's demo buttons show the whole name and position on a phone** ("Jordan Lee (Field …"): they wrap to
  a second line like the charity account.
- **Conversion with nothing logged reads "—" in the neutral tone**, not "0.0%" in red as if a brand-new person were
  failing (dashboard, person page, event and team totals).
- **The demo's disputed invoice reads sensibly**: Thomas's sales dispute says "2 sign-ups missing" on the commission
  line, not a whole week's "21 sales" pinned on a line that was not paid.
- **"Not yet confirmed" goes once the statement confirms the week.** A statement that confirms exactly the number
  logged changes no amount, so the open invoice kept saying "not yet confirmed by BCN" — and, once paid, kept it for
  good. The week's confirmations are now part of what an invoice is checked against: such an invoice is brought up to
  date in place (same version, same status), while a dispute's "the figures have changed" still compares the amounts
  only. Invoices stamped before this release are restamped once on start-up, so none is rewritten for it.
- The dashboard's **Conversion** tile shows no comparison while you have no stops (it showed "—" next to a red
  "−100%").
- Page headers put their buttons under the title only when the title needs the room (a long description no longer
  pushes them down), and **Quick gauges** keeps its name in the top bar on a phone, where the page has no other
  heading once an event is chosen.
- `npm start` says "the dependencies were installed after the last build" only when nothing else changed; after a pull
  that changes the screens too, it names the changed screen file. `npm run backup` says the backups hold the app secret
  only when the folder has a copy of it (with `LM_APP_SECRET` set it says the key is not in them), and restore no longer
  says "Only the database was restored" when it put the app secret back too.

## [1.3.0] - 2026-10-22

Pay you can check, clients on board, data that coaches. Details: [docs/USER_GUIDE.md](docs/USER_GUIDE.md) ("What's new
in 1.3"), [docs/LOGIC.md](docs/LOGIC.md) §16, [docs/API.md](docs/API.md) ("1.3 endpoints") and, for the owner,
[docs/OWNER_NOTES_1.3.md](docs/OWNER_NOTES_1.3.md).

### Changed

- **Pay: base or commission, whichever is higher.** Each pay week (Mon–Sun) pays the base (£63.50 × the days worked)
  or the commission (paid subs × each campaign's rate on the day), whichever is higher, never both. No automatic sales
  bonus and no automatic leader overrides: Matt adds a bonus to a person's week by hand, with a note. The rule applies
  from the week the upgrade first runs (**Settings → Pay** shows the date and the day rate); weeks before it keep the
  1.2 maths, and paid weeks never change. Every week opens a breakdown that says which applied and why.

### Added

- **Cancellations from the clients' statements.** Linear Hub reads the charities' commission statements from Matt's
  Gmail (an app password in **Settings → Integrations**, read-only, only the senders listed per campaign), takes the
  table out of the PDF, matches each row to the person and corrects pay: an unpaid week is recalculated with the
  confirmed subs, a paid week's difference goes on the person's next unpaid week ("2 cancelled by BCN: −£20.00", or
  "no change" when the base still applied). Rows it cannot match wait in Matt's top box. **Finance → Statements**
  shows each statement, its PDF and its effect; a PDF can also be uploaded by hand.
- **Self-billing invoices.** Everyone in the field is self-employed: each closed pay week issues an invoice in the
  person's name to Linear MCR Limited, numbered `LM-SB-…`, with the breakdown, the office's signatory and signature,
  and the person's electronic acceptance. **Accept invoice** or **Something's wrong** (say which lines and why); the
  office fixes and reissues it or keeps it with a note. Not disputed by 12:00 the day before payday, or 24 hours after
  it was issued when that is later, counts as accepted; **Mark paid** needs acceptance or an override with a reason. A
  one-off self-billing agreement, supplier details (address, UTR, VAT) and company details in **Settings**.
- **Client accounts.** Each campaign's client gets an access code and a PIN and sees only a portal: post an update, an
  announcement or a commission change. Posts appear in Announcements ("From Breast Cancer Now") and in Matt's top box;
  commission changes wait for Matt's approval and apply from the date he confirms. Campaign pages hold the brief, rates
  history, client contacts and every post; the Campaigns item shows unread posts.
- **Learning videos.** Matt uploads a video (up to 2 GB) or adds a YouTube, Vimeo or Drive link, with a topic,
  audience and a required flag. The player resumes where you stopped; required videos join the checklist and leaders
  see who has watched.
- **PDF everywhere.** **Export ▾** offers CSV or PDF on every table, plus PDFs of invoices, candidate profiles and
  interview sheets, venue reports, the audit view, the leaderboard and learning progress. Every export is recorded.
- **Recruitment detail.** Date of birth (age and an under-18 warning, recruitment roles only); a timeline of every
  stage, interviewer change and reschedule with who did it; **Recruitment → Schedule**; a question bank per interview
  type; interview sheets where the interviewer writes each answer and a score, kept as asked.
- **Venues and event plans.** **Events → Venues**: every venue's shifts, per person-day averages and stage ratios
  against the company, and the law of averages in a chart and a sentence. Leaders book their team on events, reps tap
  **I'm working this**, and every booked person sees how many stops, tables, presentations, closes and taps their
  target needs there.
- **Audit of every action.** The audit trail also records sign-ins and failed attempts, PIN and two-step failures,
  every export and download, opened invoices, candidates and the audit trail, client portal actions and automatic
  steps; a test fails for any write route without an audit entry. **Audit**: Everything or Changes only, a kind
  filter, and **Team → person → Activity**.
- New settings: `LM_STATEMENTS_JOB=0` turns the statement reader off; `LM_STATEMENTS_DIR` and `LM_UPLOADS_DIR` move
  where statements and the signature image are kept. Learning videos live in `media/videos` next to the database. The
  nightly backup copies none of these files (videos, statement PDFs, signature image).

### Fixed

- The test server no longer drops idle keep-alive connections, which made one route test fail at random under load.

## [1.2.0] - 2026-10-20

### Added

- **Learning page** (everyone). The COD pack as 21 lessons, each with the pack's pictures, a three-question
  self-check (marked by the server) and a teach-back your leader reads and signs off; field cards for the 5 steps and the six objections;
  the leadership checklist (Learn / Teach) and the progression tracker with your real numbers. Leaders see their
  team's teach-backs waiting for sign-off; admins confirm the office-only criteria. A one-line "next level" card on
  the dashboard.
- **Pitch studio** (Learning → Pitches): a pitch per campaign, starting with the Breast Cancer Now pitch as written.
  Read it with the COD theory each line uses, time each step against the pack's targets, practise on a teleprompter
  or with flashcards. Fact-check notes sit beside a line without changing it, and every practice mode flags the
  figures the office has not approved yet. Admins and leaders write and edit pitches (only admins change the fact
  check); Quick gauges and event pages open the campaign's pitch.
- **Sign-in PIN** (Settings → Security): an optional 4–6 digit PIN after email and employee ID. Ten wrong tries lock
  it for 15 minutes, longer each time (up to a day); admins can require a PIN for everyone, require two-step
  verification for admins, set the sign-out time and reset a person's PIN, and `npm run pin:reset -- <email>` resets
  one from the server. `docs/DEPLOY.md` explains putting Linear Hub online.
- **Bulk entry** (leaders, admins): the whole team's gauges for an event on one sheet, or pasted straight from the
  WhatsApp chat; everything saves together or nothing does, and it keeps working offline until saved.
- **Audit trail** (admins): every change with who, when, what changed and from where, with filters; a **History**
  section on payslips and gauge entries; "Read by N of M" under announcements.
- **One-tap check-in** (reps, leaders): **Check in** on today's events, on time or late against the start and grace,
  with 2 minutes to undo and an offline queue; a roll call on the event page for leaders and admins. A check-in never
  creates gauges or pay; punctuality uses it where there is one, unless a leader recorded the arrival time.
- **Search** (⌘K / Ctrl+K): the top bar finds people, events, candidates and campaigns (only what you could open)
  and offers actions: Log gauges, New event, Mark week paid.
- **Export for payroll** (admins, Finance → Runs to pay): a week's unpaid runs as a CSV for Xero Payroll or Sage
  Payroll, formula-safe, never changing a run.
- `npm run latest`: update in one command (stop, pull, install, build, start or restart the background service). It
  stops rather than touch your own edits, and resets only npm's package-lock.json rewrite.
- `npm start` installs changed dependencies (`npm ci`) and rebuilds stale screens first, naming the file that changed,
  so new features always show after a pull. The server warns at start-up when its screens are older than the code, and
  `npm run doctor` checks both.

### Security

- Sign-in PINs are hashed with a key derived from the app secret, so a copied database file on its own does not give
  them away. Back up the app secret (`LM_APP_SECRET` or `server/data/app-secret`) and keep the backups folder private.
- Behind a reverse proxy (`TRUST_PROXY=1`) the sign-in limiter counts each client, not the proxy, so one person's
  wrong tries cannot lock out someone else.
- A per-person limit of 60 writes a minute on the 1.2 learning, pitch, check-in, PIN and bulk-entry routes.
- The audit trail stores no row for a write that changed nothing, keeps long text as its length and fingerprint, and
  shows a leader no other team's notes or arrival times in an entry's history.

### Changed

- **Tally taps count people.** One tap on the Tally card or in Quick gauges is one person, at the furthest stage they
  reached, and the earlier stages count too: **+1** on Presentations adds a stop, a table and a presentation; on Taps it
  adds one to Stops through Taps; on Stops just a stop; on Sales all six. **−1** takes that person off again. When
  everyone on that stage went further it names the tile that brings it down instead ("Can't take one off Closes: all 2
  people who got to closes went on to taps. Take one off Taps instead (Closes comes down with it)."). Taps can come in
  any order, so **Count it through** is gone and a **+1** is greyed only at the daily maximum. Each tile says what a tap
  adds (**+ stop, table**), a line under the event explains the rule, and the tiles a tap raised flash for a moment (no
  movement with reduced motion). Tallies already on a phone carry over unchanged. `tallyPerson` replaces `tallyStep`,
  `tallyStepThrough` and `tallyThroughOffer` in `@lm/shared`. No server change.

### Fixed

- package-lock.json disagreed with package.json (the Node requirement), so every `npm install` rewrote it, and that
  local change then blocked the next `git pull`. It is regenerated, installs use `npm ci`, and CI now fails if the two
  drift apart again.

- Collapsed sidebar: the page names that pop out beside the icons were cut off by the scrolling link list, so only a
  sliver showed. They now draw above the page and show in full. They appear on mouse hover and keyboard focus only (a
  click or tap no longer leaves one stuck open), and Escape or scrolling hides them.

- Gauges (admin, 1024 px): the date-range presets pushed the page sideways. They now move under the tabs when both do
  not fit.

## [1.1.0] - 2026-10-19

The **smart release**: the existing screens now notice things for you, by fixed, deterministic rules built from the
numbers you can already see (no outside service, no AI). Every forecast is labelled an estimate and shows its range.
`LM_SMART=0` switches the estimates and suggestions off on the server. Details: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
("What's new in 1.1"), [docs/LOGIC.md](docs/LOGIC.md) §14 and [docs/API.md](docs/API.md) ("Smart endpoints").

### Added

- **Your pace and streaks.** A private note on the dashboard when this week's stops a day or conversion is clearly off
  (or ahead of) your own last 8 weeks, with one lever to pull; a 16-week "steadily improving / drifted" line; sales
  streaks and **Personal best week so far** on the **Sales** tile; streak flames on leaderboards (`streak` on
  `GET /leaderboard` rows).
- **This week's pay estimate** for reps and leaders: low / likely / high with the distance to the bonus in sales and
  stops (`forecast` on `GET /finance/me`, `personal.payForecast` on `GET /me/insights`). Never written to payroll.
- **Payroll checks** for administrators before paying (`flags` on unpaid runs), and paying many runs at once from
  **Runs to pay** (**Mark week paid**, a **Paid on** date, a summary of paid / skipped / failed).
- **Check in with…**: a private, ranked list of up to five people worth a word this week, for leaders (own team) and
  the owner (every team), plus **Team coaching**, **Company coaching** and **Focus** chips on Gauges → Team.
- **Needs attention**: one role-scoped list behind the bell, pop-up notes, a tab-title count and a dashboard card —
  unlogged days with what they cost in pay, tomorrow's event, your pay (due tomorrow, overdue, just paid), team gaps,
  events with nothing logged or behind target, mistyped-looking numbers, runs to pay, overdue follow-ups and interview
  outcomes to record (`GET /me/attention`).
- **Event forecasts**: expected sales with a range and usual headcount on upcoming and live events, **Stretch** and
  **Behind target** pills, a suggested target in **New event** (`forecast` on events, `GET /events/forecast`),
  **N / M logged** with **Not logged yet** and **Log for …** buttons (`roster` on events), and directions links.
- **Signal-proof logging**: an offline banner; gauge saves kept on the phone and replayed safely, with a review sheet
  when someone else changed the same day; today's event preselected; a **Checking in? Use now** button around the
  start time; a full-screen **Tally** counter for the shift.
- **Quick gauges** (`/quick`): the shift tally as six big buttons for a phone or an iPad in the field (each tile is the
  +1, with a −1 in its corner), the same counts as the Tally card, **Count it through** when a sale comes before its
  tap, a sticky **Finish shift**, and the screen kept awake where the browser allows. One tap from a **Quick gauges**
  button at the top of the sidebar (with today's stops), from the topbar on phones, and from **Full screen** on the
  Tally card. Also in ⌘K. Not shown to recruiters. No server change.
- **Recruitment deadlines**: each stage has a target (3 / 5 / 7 / 7 / 7 days) that sets the next-action date on create
  and on every move; **Idle** badges and **Longest idle first**; an **Idle beyond target** tile; **Record the outcome**
  on the candidate page and in **Needs attention**.
- **Your week in review** of the last finished week on the dashboard, per role, with private lines locked and **Copy as text** for
  the WhatsApp group (`GET /me/digest`).
- **Backups**: a consistent, checked copy of the database 10 minutes after start-up and every night, kept for 30 days
  plus 8 weekly copies; `npm run backup`, `npm run backups` and a guarded `npm run restore` (it refuses while the
  database is open in another process, whatever port that server uses); a **Backups** card in
  Settings for administrators (`backup` on `GET /health`); `npm run doctor` warns about stale backups and low disk.
- **Run it in the background**: `npm run service:install`, `service:status` and `service:uninstall` (macOS
  LaunchAgent, Linux systemd user unit, printed steps for Windows).
- **Compressed responses** (gzip) for pages, scripts and data over the hotspot.
- **Two-step verification** with an authenticator app (QR set-up, single-use recovery codes, admin reset), with the
  encryption key generated and kept next to the database.
- **CSV export** on every data table and **Print payslip**.
- A public landing page for signed-out visitors (`/welcome`) and a single-file brand config.
- Use from phones on the same Wi-Fi or hotspot: the server prints its network addresses and `npm run share` shows them
  with a QR code.
- `npm run doctor`, `npm run stop` and `npm run restart` for a server that will not start or a copy left holding the
  port.
- Environment variables `LM_SMART`, `LM_BUSINESS_NOW`, `LM_BACKUP`, `LM_BACKUP_DIR`, `LM_BACKUP_HOUR`,
  `LM_COMPRESSION`, `HOST`, `TRUST_PROXY`, `LM_APP_SECRET`, `LM_APP_SECRET_FILE` (see README).
- Server route tests (`node:test`) run with `npm test`; a pinnable business clock lets the smoke test pass at any hour.

### Changed

- Moving a candidate to a new stage starts that stage's deadline instead of carrying the previous one forward, and
  `nextActionAt` must be a real date or an ISO 8601 timestamp (`400` otherwise) on create, edit and stage moves.
- Scheduled events show a neutral **Target N** until they start.
- **Runs to pay** (`GET /finance/payroll?status=pending,failed` without a range) lists failed transfers whatever their
  week; pending runs keep the 12-week window. The bell, the week in review and a rep's overdue-pay note count the same
  runs.
- The recruiter dashboard asks for interview outcomes once, in **Needs attention**.
- The server runs on plain Node (built-in TypeScript type stripping, Node 22.18 or newer) instead of `tsx`.
- `GET /api/health` reports version `1.1.0`.
- Faster API: a short per-user response cache cleared by every write, grouped queries and immutable asset caching.
- Dashboard-only and finance-only components, the sign-in page and About load on demand, keeping the main script
  under 460 kB.

### Fixed

- The server no longer prints "listening" and exits when the port is already taken; it names the process holding the
  port. Ctrl+Z stops it instead of leaving a paused copy on the port.
- Pending pay runs follow every gauge change; paid weeks are locked for everyone but administrators.
- Relative dates count calendar days: on a Monday afternoon Friday reads "in 4 days", not "in 3 days".

### Security

- The login limiter counts per connection address and per email (forwarded headers cannot bypass it); proxy trust is
  opt-in with `TRUST_PROXY`.
- Security headers (CSP, `X-Frame-Options`, `nosniff` and more) on every response; numeric inputs have ceilings.
- Login errors no longer reveal deactivated accounts; other people's check-in times and notes are hidden in gauge
  lists.

## [1.0.0] - 2026-10-15

First release for Linear MCR.

### Added

- Sign-in with work email and employee ID for four roles (rep, leader, recruiter, administrator), with employee IDs
  shown only to the office and the person.
- Dashboard per role; the six gauges with the funnel rule, ratios against the law of averages and coaching notes.
- Events with statuses that roll forward by themselves; **Log gauges**; the Gauges page by person, team, campaign, day
  and week; the leaderboard with movement.
- Recruitment pipeline from Applied to Hired, with interviews and hiring that creates the rep's account.
- Pay: itemised weekly payslips, automatic pending runs when a week closes, **Runs to pay** with **Mark paid**,
  company finance with revenue, payroll, expenses and margin by campaign.
- Team directory, campaigns, announcements, light and dark themes, deterministic 26-week demo data and Docker image.

