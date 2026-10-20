# Changelog

All notable changes to Linear Hub are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). API changes are additive within a major version: no
response field is renamed or removed, and new fields are optional.

## [Unreleased]

### Added

- `npm run latest`: update in one command (stop, pull, install, build, start or restart the background service). It
  stops rather than touch your own edits, and resets only npm's package-lock.json rewrite.
- `npm start` installs changed dependencies (`npm ci`) and rebuilds stale screens first, naming the file that changed,
  so new features always show after a pull. The server warns at start-up when its screens are older than the code, and
  `npm run doctor` checks both.

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

What comes next is in [docs/ROADMAP.md](docs/ROADMAP.md).

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

