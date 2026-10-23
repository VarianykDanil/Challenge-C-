# Changelog

All notable changes to Linear Hub are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). API changes are additive within a major version: no
response field is renamed or removed, and new fields are optional.

## [Unreleased]

Nothing yet. What comes next is in [docs/ROADMAP.md](docs/ROADMAP.md).

## [1.3.1] - 2026-10-22

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

### Fixed

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
  office fixes and reissues it or keeps it with a note. Not disputed by 12:00 the day before payday (or 24 hours after
  a late reissue) counts as accepted; **Mark paid** needs acceptance or an override with a reason. A one-off
  self-billing agreement, supplier details (address, UTR, VAT) and company details in **Settings**.
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
- `npm run pin:reset` is joined by new settings: `LM_STATEMENTS_JOB=0` turns the statement reader off,
  `LM_STATEMENTS_DIR` and `LM_UPLOADS_DIR` move where statements and the signature image are kept. Learning videos
  live in `media/videos` next to the database; the nightly backup does not copy them.

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

