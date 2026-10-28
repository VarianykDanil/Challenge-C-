# Linear Hub

**Every stop counts.** The team platform for Linear MCR Limited: every rep sees their own gauges, pay and progression and their team's board; leaders read the whole company and run their own team; the recruiter runs the pipeline; the office sees finance — all behind one sign-in with a work email, employee ID and a code from an authenticator app.

> Linear MCR runs face-to-face sales campaigns — B2B, B2C, private-site events and charity fundraising — from Manchester. The six gauges a rep records at every event (stops → to table → presentations → closes → taps → sales) are the heartbeat of the business. Linear Hub is built around them.

---

## Why

Today the business has no CRM, and it shows in small ways every day:

- **Gauges live on paper and in WhatsApp.** Leaders collect six numbers from each rep at the end of each event, retype them, and tally them by hand. Nobody can see a ratio until someone works it out.
- **Coaching starts from a hunch.** Without stage-by-stage ratios against the law of averages, it is hard to say *which* part of the pitch a rep should work on.
- **Recruitment is tracked ad hoc.** Candidates move from applied to observation day to hired in notes and messages; nobody knows the conversion by source or how long a hire takes.
- **Pay and punctuality questions take time to answer.** "What am I being paid this week, and when?" and "Was I paid late?" should be a glance, not a phone call.

Linear Hub fixes those four things without asking the business to change how it works. The gauges are the same six. The benchmarks are the company's own. The pay plan is the one already on the wall.

---

## What it does

| Area | What you get |
|---|---|
| **Dashboard** | Your period at a glance (**This week / This month / This quarter**): sales, stops and conversion with the change against the same days of the previous period; your rank; earnings to date and next payday (red when overdue); punctuality; your trend and funnel with coaching notes; your team's top five; upcoming events; announcements. Leaders and administrators also get a **Company** section; recruiters get a recruitment-first dashboard. |
| **Events & Gauges** | Leaders schedule events for their team against a campaign (venue, date, times, sales target); statuses roll forward by themselves (today's events go **Live** at their start time). Reps **Log gauges** for an event in under a minute: the date is the event's date, the event must be today or earlier and not cancelled, and the funnel rule (each stage ≤ the previous) is checked as you type. Everything rolls up by person, team, campaign, day and week. |
| **Leaderboard** | Everyone who logged sales, ranked by **Sales** or **Conversion** for the week, month or quarter, with movement against the same days of the previous period. Reps see their own team; everyone else can filter by team. |
| **Recruitment** | A board from Applied → Phone screen → Interview → Observation day → Offer → Hired, with interviews, owners, sources, ratings, next actions and overdue flags. Hiring asks for the **Team** and **Position** (Trainee or Field Representative) and creates the rep's account on the spot. |
| **Finance & Pay** | **My pay** for everyone: twelve weeks of payslips or self-billing invoices, each with its breakdown (the base or the commission, whichever is higher, plus any bonus, corrections and deductions), and the next payday. **Team pay** for leaders. **Company** for administrators: revenue, payroll, expenses and profit per pay week, **Runs to pay** with **Mark paid**, payroll punctuality, expenses and margin by campaign. |
| **Team** | The directory: who is on which team, their position on the ladder (Trainee → Field Representative → Team Leader → Crew Leader → Assistant Owner → Owner, plus the office **Recruiter** position), and a performance view per person. |
| **Campaigns** | The clients Linear represents, with sector, type, payout per sale, default rep commission and active/inactive status. |
| **Public page** | Signed-out visitors land on an outward-facing page about Linear MCR and Linear Hub (what we do, how we train, the career ladder from the training pack) with **Sign in**. It never mentions pay or the internal playbook (a test checks this); staff can review it any time at `/welcome`. The logo and colours come from one config (`client/src/content/brand.ts` and the `--brand-*` block in `client/src/index.css`). |
| **Export & print** | Every table has **Export** (CSV for Excel, or PDF): exactly the rows on screen, with the filters in the file name. Each payslip has **Print payslip**, and each invoice has **Print invoice** and **Download PDF**. |
| **Smart features** (1.1) | Pace notes, this week's pay estimate, **Check in with…**, the **Needs attention** bell, event forecasts, signal-proof logging, recruitment deadlines and **Your week in review** — see [Smart features](#smart-features-11) below. |
| **Learning** (1.2) | The COD pack as 21 lessons with self-checks, teach-backs your leader signs off, the leadership checklist and the progression tracker; a **pitch studio** per campaign (starting with Breast Cancer Now) with the theory behind each line, a step timer, a teleprompter and flashcards. |
| **Field & office** (1.2) | One-tap **Check in** with a roll call; leader **Bulk entry** (or paste from WhatsApp); an optional sign-in **PIN**; the **Audit** trail and announcement read receipts; ⌘K search for people, events, candidates and campaigns; a **Payroll spreadsheet** (CSV) for your accountant or payroll software (since 1.5 it is described as what it is: a spreadsheet to map, not a Xero or Sage import file). See [What's new in 1.2](docs/USER_GUIDE.md#whats-new-in-12). |
| **Pay you can check** (1.3) | Each week pays the base (£63.50 a day) or the commission, whichever is higher, with a full breakdown; the clients' PDF statements (read from Gmail) correct cancellations on the next week; a **self-billing invoice** each week to accept or query. See [What's new in 1.3](docs/USER_GUIDE.md#whats-new-in-13). |
| **Clients, learning, data** (1.3) | **Client accounts** that post updates and commission changes; **learning videos**; **PDF** downloads everywhere; recruitment with date of birth, a schedule and interview sheets; **Venues** that prove the law of averages and plan each booked person's shift; an audit of **every action**. |
| **Pay people from Linear Hub** (1.4) | **Pay people** (Finance → Company → Runs to pay → **Pay from Linear Hub**): choose the weeks, choose how to pay, check who is paid to which (masked) account and who is left out, approve with a fresh two-step code, then follow each payment. Four ways to pay, each with its logo and what it can and cannot do: a **bank payment file** for any UK business bank (Starling, Revolut or a general Faster Payments file; you upload and approve it in your bank), **Revolut Business** (pays from Linear Hub), **Wise Business** (Linear Hub creates the transfers, you pay them in Wise) and **Open Banking through TrueLayer** (payouts from your merchant account). Every connection starts in test mode (bank files too, since 1.5). Everyone adds their own **bank details** in Settings, stored encrypted and shown masked. See [What's new in 1.4](docs/USER_GUIDE.md#whats-new-in-14). |
| **Two-step for everyone** (1.4) | Every account that signs in, charity and client accounts included, uses a 6-digit code from an authenticator app, and everyone is signed out 14 hours after signing in (4 to 24 hours, the administrator's choice). Nothing typed or saved in the field is lost when it happens. |
| **A safe trial and a real go-live** (1.5) | A demo database is in **trial mode**: administrators see a banner, and the one-tap demo accounts can only play with the demo company, never your own people, real pay, bank details or office settings. **`npm run golive`** ends the trial: it backs up first, removes the demo company, keeps everything you made and makes the first owner. Every new account and every reset gets a **one-time setup code**; sensitive administrator actions need the administrator's fresh two-step code; money and secret actions need a secure connection; built-in **HTTPS** is one setting away. See [What's new in 1.5](docs/USER_GUIDE.md#whats-new-in-15). |
| **Keys and backups you cannot lose quietly** (1.5) | Linear Hub refuses to start with a missing or wrong app key instead of making a new one; the key goes on a printed **recovery sheet** (made on the server computer only); every backup also holds the uploaded files; **encrypted off-site copies** after every backup; restore lists the payments it would forget and asks first; **System health** in the bell. |
| **Money with a second pair of eyes** (1.5) | **Days to confirm** for logged days with no booking or check-in; bank details someone else typed in wait for the person (or a second administrator); **Two people approve each payment** once two administrators use two-step; bank files start in test mode with a **1p test file**; a downloaded bank file counts as sent; **VAT** on self-billed invoices once the office has checked the number; days off and leaving dates for office staff. |
| **Works with no signal** (1.5) | On the secure (https) address every page opens with no signal once Linear Hub has been opened with signal on that phone, even after an update or while the server restarts; a weak signal never leaves it on "Loading…". **Add to Home Screen** gives an app icon. Tables read as cards on a phone; a **Today** card and a **Check in at …** reminder for reps and leaders. |

### Roles

| Role | Sees | Can change |
|---|---|---|
| `rep` | Own gauges and pay; own team's events, leaderboard and gauges summary; the directory; any event or profile **read-only** (other people's check-in times and notes are hidden) | Own gauges, at own team's events |
| `leader` | Company-wide reads — every team's events, the full leaderboard, any profile — plus the check-in times and notes of their own team, their own team's payroll, and recruitment | Events for own team; gauges for own team's members at own team's events; candidates, interviews and stage changes; announcements; (1.5) **Days to confirm** for their own team |
| `recruiter` | The whole recruitment pipeline, the directory, own pay; events and the leaderboard read-only | Candidates, interviews, stage changes (hiring creates the rep's account) |
| `admin` | Everything, including every employee ID; everyone's bank details, masked | Everything — people, campaigns, events, any gauges, payroll payments and paying people from Linear Hub, expenses, announcements. Since 1.5 the sensitive ones (making or stopping an administrator, setting one as left, changing someone's email or employee ID, resets, setup codes) ask for the administrator's own fresh two-step code |

**Signing in and security, honestly.** Sign-in is a work email plus an employee ID (client accounts: email and access code), then a PIN if there is one, then a 6-digit code from an authenticator app — there is no password, so the employee ID is half of the credential and the API only returns it to administrators and to the person themselves (everyone else sees it blank on the Team page, payslips and profiles). Since 1.5 an account that has not finished setting up (no two-step yet, or a PIN an administrator reset) signs in only with a **one-time setup code** from an administrator (12 letters and digits, 7 days, once), so knowing someone's email and employee ID is no longer enough to start their account. Two-step verification is required for every account that signs in, and a session ends 14 hours after sign-in whatever the activity (the administrator can choose 4 to 24 hours) or after 12 hours unused; sessions are httpOnly cookies that last exactly as long, and the server keeps only a hash of each. During the trial the one-tap demo accounts need no code but can only touch the demo company. After eight wrong tries for the same email in fifteen minutes from one network address, signing in with that email is paused from that address (twenty from anywhere pauses it everywhere); setting a person's status to **Left** deletes their sessions at once, so they are signed out everywhere. Bank details, payment keys and tokens are encrypted at rest with the app key and never returned by the API; every payment needs a fresh two-step code, and money and secret actions are refused over plain http from another device (the office computer itself and https are fine). Single sign-on is on the [roadmap](docs/ROADMAP.md); putting it online is in [docs/DEPLOY.md](docs/DEPLOY.md).

### Smart features (1.1)

Release 1.1 makes the existing screens notice things, using fixed rules over the numbers people can already see — no
outside service, no AI, and the same data always gives the same sentence. Every forecast says **estimate** and shows
its range; pay, pace notes and the check-in list are only ever shown to the person they belong to.

| Feature | Who sees it | Where |
|---|---|---|
| **Your usual pace** and **sales streaks** | reps, leaders, administrators (their own) | dashboard funnel card, **Sales** tile, leaderboard flames |
| **This week (estimate)** of pay, with how many more subs beat the base (1.5: no automatic bonus is promised) | reps and leaders (their own) | dashboard strip, **Finance → My pay** |
| **Payroll checks** and paying many runs at once | administrators | **Finance → Company → Runs to pay** |
| **Check in with…**, **Team / Company coaching**, **Focus** chips | leaders (own team), the owner (every team) | dashboard, **Gauges → Team** |
| **Needs attention** | everyone, scoped to their role | the bell, pop-up notes, dashboard card |
| **Event forecasts**, suggested targets, **N / M logged** | everyone (forecasts and the **N / M logged** counts); leaders and administrators (targets, and the names of who has not logged) | Events, event page, **New event** |
| **Signal-proof logging** and the **Tally** | anyone who logs gauges | **Log gauges**, an offline strip under the top bar |
| **Quick gauges**: the tally as six big buttons for the field | anyone who logs gauges | top of the sidebar, the topbar on phones, **Full screen** on the Tally card |
| **Recruitment deadlines**, **Idle** badges, **Record the outcome** | recruiters, leaders, the owner | Recruitment, candidate page |
| **Your week in review**, ready for WhatsApp | everyone | bottom of the dashboard (always the last finished week, Monday to Sunday) |

`LM_SMART=0` switches the estimates and suggestions off on the server; the recruitment deadlines, the phone outbox
and the coaching worked out in the browser stay on. Plain-words guide:
[USER_GUIDE.md, "What's new in 1.1"](docs/USER_GUIDE.md#whats-new-in-11); rules and thresholds:
[LOGIC.md §14](docs/LOGIC.md#14-smart-release-11); endpoints and fields:
[API.md, "Smart endpoints"](docs/API.md#smart-endpoints); history: [CHANGELOG.md](CHANGELOG.md).

---

## Screenshots

| | |
|---|---|
| ![Sign in](docs/screenshots/login.png) *Sign in — work email and employee ID, with the one-tap demo accounts during the trial* | ![Dashboard](docs/screenshots/dashboard.png) *Dashboard — the period at a glance, with coaching from the funnel* |
| ![Dashboard, dark theme](docs/screenshots/dashboard-dark.png) *The same dashboard in the dark theme* | ![Events](docs/screenshots/events.png) *Events — today first, then what is coming, then last week under "Earlier"* |
| ![Gauges](docs/screenshots/gauges.png) *Gauges — ratios tinted against the law of averages* | ![Leaderboard](docs/screenshots/leaderboard.png) *Leaderboard — podium, movement and "You're #N of M"* |
| ![Recruitment](docs/screenshots/recruitment.png) *Recruitment — the board from Applied to Hired* | ![Finance](docs/screenshots/finance.png) *Finance — pay runs, Runs to pay and payroll punctuality* |
| ![Team](docs/screenshots/team.png) *Team — the directory by team, position and status* | |

The screenshots show the invented demo company in trial mode (the banner under the top bar is the trial banner
administrators see). `docs/screenshots/take-screenshots.mjs` takes them again from a running demo.

---

## Quick start

Requires **Node.js 22 (22.18 or later), 24 or 26** (`.nvmrc` says `22`): the long-term-support lines the tests run on,
because Node still labels its built-in `node:sqlite` experimental. The server prints a warning on any other version, and
`npm run doctor` shows the version and the `node:sqlite` status. The server runs TypeScript directly with Node's type stripping and uses the built-in `node:sqlite`, so there is nothing else to install.

Run the commands in this `linear-micro-crm` folder. They also work from the folder above it (the top of the
repository): there, each one changes into `linear-micro-crm` and runs the same command, and `npm install` installs
Linear Hub.

```bash
npm install
npm run dev
```

- Client: <http://localhost:5173> (Vite dev server; proxies `/api` to the server)
- API: <http://localhost:4000>

On first start the database is created with the demo company and is in **trial mode** until you go live with
`npm run golive` (see [Going live](#going-live-npm-run-golive)). Production build on one port:

```bash
npm start      # API + built client on http://localhost:4000
```

`npm start` first installs the dependencies (`npm ci`) if `package-lock.json` changed since the last install, and
rebuilds the screens (`npm run build`) if any client or shared file is newer than the last build, saying which file. So
after a `git pull` the new screens always show. `LM_SKIP_PREPARE=1` skips that step.

### Updating to the latest version

```bash
npm run latest
```

It stops the running copy (or the background service), **backs up and checks the database first** (with the uploaded
files; no good backup, no update), pulls, installs and builds what changed, and starts again (or restarts the
background service with its own settings). It prints the way back (`git checkout <previous> && npm run setup && npm
run restore -- <backup>`). It never throws away your own edits: if you changed a tracked file it stops and names
it. The one file it does reset is `package-lock.json`, which npm rewrites on install; the pulled version replaces it.
`npm run latest -- --no-start` updates without starting. Do not use `npm update`: that is npm's own command, which
upgrades packages and rewrites the lockfile.

**Updating from 1.4.0 to 1.5: run `npm run backup` first.** That one update is run by 1.4.0's own updater, which
makes no backup and does not stop the background service; from 1.5 on `npm run latest` does both itself. What the first
start of 1.5 changes, and what to do next, is in [docs/OWNER_NOTES_1.5.md](docs/OWNER_NOTES_1.5.md). On a server set up
with `deploy/install.sh`, use `sudo linear-hub update` ([docs/DEPLOY.md](docs/DEPLOY.md)).

### Scripts

Every command below exists in `package.json` (root) or `server/package.json`. Since 1.5, `doctor`, `backup`, `restore`, `key:restore`,
`recovery-sheet`, `golive`, `setup-code`, `pin:reset` and `2fa:reset` run from a plain terminal use the installed
background service's database, folders and key when the terminal sets no `DB_PATH` of its own, and say so in one line.

| Command | What it does |
|---|---|
| `npm run dev` | Server (`node --watch`, `TZ=Europe/London`) and client (Vite) together |
| `npm run build` | Install the dependencies first if `package-lock.json` changed since the last install (`npm ci`), then typecheck and build the client into `client/dist` |
| `npm run setup` | Install the dependencies if the lockfile changed (`npm ci`) and rebuild the client if its code changed; `npm start` runs it first |
| `npm start` | Serve the API **and** the built client on <http://localhost:4000> (`NODE_ENV=production`), after `npm run setup` |
| `npm run latest` | Update to the latest version: stop, pull, install, build, start (see Updating to the latest version) |
| `npm run stop` | Stop an earlier copy of Linear Hub that is still holding port 4000 (`PORT=…` for another port). Anything else on the port is reported and left alone |
| `npm run restart` | `npm run stop` followed by `npm start` |
| `npm run share` | While the server runs: the addresses phones and laptops on the same Wi-Fi or hotspot can use, with a QR code to scan |
| `npm run doctor` | Check this machine can run Linear Hub: Node version, built client, data folder, database, port, and a real boot on a temporary database. Run it whenever `npm start` misbehaves |
| `npm run golive` | 1.5: end the trial (stop Linear Hub first). It shows what goes and what stays, backs up and checks the database, asks you to type **GO LIVE**, removes the demo company, keeps your settings, your own people and everything made during the trial, and makes the first owner with a one-time setup code when none of your own administrators is left. Running it again changes nothing. For scripts: `-- --confirm "GO LIVE" --owner-email … --owner-first-name … --owner-last-name …`. See [Going live](#going-live-npm-run-golive) |
| `npm run seed` | Delete the database and build the demo again (trial mode). Since 1.5 it refuses a live database, a trial database with people of your own, or one Linear Hub has open; it asks you to type **START AGAIN** (`-- --confirm "START AGAIN"`) and backs up first. A missing database is seeded straight away |
| `npm run setup-code -- <email>` | 1.5: print a new one-time setup code for someone who has not finished setting up (for example the only administrator, or an account from 1.4). Says so when they need none. Works while the server runs |
| `npm run backup` | Back the database and the uploaded files up now (fine while the server runs) into `server/data/backups/`, and (1.5) write the encrypted off-site copy when `LM_OFFSITE_DIR` is set. `-- --no-offsite` skips the off-site copy this time; `-- --new-passphrase <file>` makes an off-site passphrase file and prints it once (it never overwrites a file) |
| `npm run backups` | List the backup files with size and age |
| `npm run restore -- <file> [--yes]` | Put a backup back as the live database, with its uploaded files and key (stop the server first). `<file>` is a path or a file name from the backups folder, or (1.5) an encrypted off-site copy `linear-….lhbk` (it asks for the passphrase or reads `LM_BACKUP_PASSPHRASE_FILE`). It shows what changes and asks first; when the backup would forget payments, bank files, bank details changes or paid runs it lists them and needs **RESTORE** typed (without a terminal: `--yes --forget-payments`) |
| `npm run key:restore` | 1.5: put the app key back, typed from the recovery sheet, `-- --file <path>` or `-- --from <file>.lhbk` (an off-site copy). It checks the key against the database first, and keeps any different key file as `app-secret.replaced-<time>` |
| `npm run recovery-sheet` | 1.5: show the recovery sheet for the app key in this terminal, on the computer that runs Linear Hub (`-- --print` sends it to the printer instead; `-- --out <file>` also saves it as a text file). The key never travels over the network |
| `npm run recovery-sheet -- --confirm` | 1.5: type the whole key back from the paper; once it matches, backups stop keeping a copy of that key. The key is never taken on the command line |
| `npm run pin:reset -- <email>` | Clear one person's sign-in PIN and its lock and sign them out everywhere (for the only administrator, or after losing the app key), and (1.5) print the one-time setup code their next sign-in needs. Honours `DB_PATH`; works while the server runs |
| `npm run 2fa:reset -- <email>` | Clear one person's two-step verification and sign them out everywhere; they set it up again at their next sign-in, with the one-time setup code it prints (1.5). For the only administrator who lost phone and recovery codes, or after losing the app key. Recorded in the audit trail. Honours `DB_PATH`; works while the server runs |
| `npm run service:install` | Run Linear Hub in the background and start it at log-in (macOS LaunchAgent, Linux systemd user unit; on Windows it prints the Task Scheduler steps). Run again (by hand, or by `npm run latest`), it keeps every setting of the installed service that this terminal leaves unset, and its key file, and says what it kept (1.5) |
| `npm run service:install -- --fresh` | 1.5: rebuild the service from this terminal's settings only (to drop a setting) |
| `npm run service:uninstall` | Remove the background service and free the port |
| `npm run service:status` | Is the service loaded and answering; its last 20 log lines; whether it still points at this Node |
| `npm run service:install -- --print` | Dry run: print the service file and the commands for this machine and change nothing (add `--platform=darwin`, `linux` or `win32` to see another platform's file) |
| `npm run typecheck` | Typecheck `shared`, `server` and `client` |
| `npm test` | Run the shared domain-logic tests, the server route tests and (1.5) the client's tests, including the service worker's (`node:test`). They write only to temporary folders, never to `server/data` (not even the `app-secret` key file) |
| `npm run test:dates` | 1.5: run `npm test` as if it were another day: by default five awkward moments ahead of today (next year's clocks-forward Sunday, New Year's Eve at 23:45, a January Sunday night, a summer-time Monday at midnight, and a spring Wednesday on the business clock only). `-- --list` prints them; `-- 2027-06-01T09:30` or `-- business:2027-06-01T09:30` runs the dates you name |
| `npm run smoke -w server` | Boot the API on a temporary seeded database and exercise every endpoint against the contract (it pins the business clock to 15:00 on the latest weekday; `SMOKE_REAL_CLOCK=1` uses the real clock). It sends from 127.0.0.2 and 127.0.0.3 to act as other devices: Linux has them; on a Mac add them first (`sudo ifconfig lo0 alias 127.0.0.2 up && sudo ifconfig lo0 alias 127.0.0.3 up`), or it stops and prints that command |

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Port the API (and, in production, the client) listens on |
| `HOST` | unset (every interface) | Set to `127.0.0.1` to make the server reachable from this machine only; unset so phones and laptops on the same network can open it. **Behind a reverse proxy (`TRUST_PROXY`) keep it `127.0.0.1`**: otherwise anyone who reaches the port directly could send forged forwarded headers (the server warns at start-up) |
| `DB_PATH` | `server/data/linear.sqlite` | Where the SQLite file lives; the directory is created if needed |
| `LM_BACKUP` | on | `0` turns the automatic backups off (`npm run backup` still works) |
| `LM_BACKUP_DIR` | `<data dir>/backups` | Where backups go. Keep it outside the repository (never commit backups) |
| `LM_BACKUP_VIDEOS` | unset | 1.5: `1` puts the learning videos in the local and off-site backups too (off by default because of their size) |
| `LM_OFFSITE_DIR` | unset (off) | 1.5: a folder that is not on this disk (a mounted cloud drive, or a folder rclone carries away). After every backup Linear Hub writes an encrypted, checked copy there (`linear-….lhbk`: the database, the uploaded files and the app key; 30 daily and 8 weekly kept). The folder must exist: Linear Hub never creates it, because a missing folder usually means the drive is not mounted |
| `LM_BACKUP_PASSPHRASE_FILE` | unset | 1.5: the file holding the off-site passphrase (at least 12 characters, mode 600; make one with `npm run backup -- --new-passphrase <file>`). Keep the passphrase on paper too, apart from the recovery sheet |
| `LM_BACKUP_HOUR` | `2` | London hour (0–23) from which the nightly backup may run |
| `LM_COMPRESSION` | on | `0` turns HTTP compression off (for example behind a reverse proxy that compresses already) |
| `LM_DEMO_ACCOUNTS` | unset | The one-tap demo sign-ins during the trial. `0`: off everywhere. `1`: on even on a server reachable from the internet. Unset: on, except on a server with built-in HTTPS (`LM_TLS_CERT_FILE`) or behind a proxy (`TRUST_PROXY`). Trial mode itself lasts until `npm run golive` either way, and after going live there are no demo sign-ins at all |
| `LM_SMART` | on | `0` switches the 1.1 smart features off: pace notes, pay estimates, payroll checks, check-in lists, the Needs-attention feed, event forecasts, streaks and the week in review answer empty, and the optional fields are left out of existing payloads. Recruitment deadlines stay on (they are workflow rules) |
| `LM_BUSINESS_NOW` | unset (real time) | Pins the business clock — "today" and "now" for events, gauges, pay and the demo seed — to this instant, e.g. `2026-10-19T15:00:00`, for demos and screenshots out of hours (use a fresh `DB_PATH` so the seed is built around it). The clock keeps ticking from there; sessions, rate limits, two-step codes and backups stay on the real clock. The server warns at start-up while it is set. Never set it for real use |
| `LM_STATEMENTS_JOB` | on | `0` stops the 15-minute check of the Gmail inbox for client statements (uploading a statement by hand still works) |
| `LM_STATEMENTS_DIR` | `server/data/statements` | Where the statement PDFs are kept (never committed) |
| `LM_PAYMENTS_JOB` | on | `0` stops the 5-minute check of payments on their way through Revolut, Wise or TrueLayer (**Check now** on a payment's page still works). Leave it on: it is what marks the weeks paid while nobody is signed in |
| `LM_PAYMENTS_FAKE` | unset | `1` adds a "Test provider" and a "Test bank file" that pay nobody (test mode only: Mark as paid on a test bank file marks no week paid), for trying the payment screens on a demo. **Never set it on the server people are paid from** |
| `LM_UPLOADS_DIR` | `uploads/` next to the app key file (`server/data/uploads`) | Where the office's signature image is kept (never committed). Since 1.5 every backup holds it, and the statement PDFs. Learning videos live in `media/videos` next to the database and are in the backups only with `LM_BACKUP_VIDEOS=1` |
| `LM_APP_SECRET` | unset (generated key file) | Key material for encrypting two-step verification secrets and (1.4) bank details, payment keys, tokens and bank files at rest (AES-256-GCM, key = SHA-256 of the value) and for peppering sign-in PINs (HMAC-SHA256 before scrypt). When unset, a random key is made on the first start of a new install into `server/data/app-secret` (mode 600, next to the database). **Since 1.5 a key is made only for a database with nothing locked yet**: with the key missing, or a different one, and locked data in the database, the server refuses to start (exit code 78) and says how to put the key back (`npm run key:restore`). Put the key on the recovery sheet (`npm run recovery-sheet`); until that is confirmed the backups folder keeps a copy of it, so keep that folder private. `npm run service:install` hands this variable to the service in a private file, never in the service file |
| `LM_APP_SECRET_FILE` | `<data dir>/app-secret` | Where the key file lives when `LM_APP_SECRET` is unset. The database records the key's fingerprint (like `3F2A-91BC-07DE`), so a wrong file is caught at start-up |
| `TRUST_PROXY` | unset (off) | Behind a TLS-terminating reverse proxy: `1` (one hop), the proxy's address or CIDR, or a comma list, so `X-Forwarded-Proto` is honoured (Secure cookies, HSTS, and the secure-connection check for money and secret actions). Keep `HOST=127.0.0.1` with it. Since 1.5 it also turns the one-tap demo sign-ins off by default. Leave unset otherwise |
| `LM_TLS_CERT_FILE`, `LM_TLS_KEY_FILE` | unset | 1.5: built-in HTTPS. Both set (a PEM certificate and its private key): the server answers HTTPS on `PORT` (no plain-http port, no redirect, no certificate reload: restart after renewing), cookies are `Secure` and every answer carries HSTS. One without the other, or a file that cannot be read, stops the start with a sentence. Not needed behind Caddy ([docs/DEPLOY.md](docs/DEPLOY.md)), which gives HTTPS itself |
| `COOKIE_SECURE` | unset | Set to `1` to force the `Secure` flag on the session cookie; it is set automatically when the request arrived over HTTPS (`X-Forwarded-Proto: https`, `trust proxy` is on) |
| `TZ` | `Europe/London` | The business time zone — "today" for events and pay weeks. The npm scripts and the Dockerfile pin it; keep it if you run the server another way |
| `NODE_ENV` | — | `production` makes the server serve `client/dist`; `npm start` sets it |

For troubleshooting and tests only: `LM_DEBUG=1` explains a failed health probe (`npm run stop`, `share`, `doctor`),
`LM_DOCTOR_SKIP_BOOT=1` skips the doctor's boot test, and `SMOKE_REAL_CLOCK=1` runs the smoke test on the real clock.

### Use it from a phone or another laptop (Wi-Fi or hotspot)

**For the trial only.** For real use, put Linear Hub on its own small server with HTTPS: [`docs/DEPLOY.md`](docs/DEPLOY.md)
and `deploy/install.sh`.

The server listens on every network interface, so any device on the same Wi-Fi or hotspot can open it: when it starts
it prints the addresses (`On your network: http://192.168.x.x:4000  http://your-mac.local:4000`), and `npm run share`
in a second terminal prints them again with a QR code to scan. Personal Hotspot works the same way: the phone that
provides the hotspot, and any other device joined to it, can open the printed address. Notes:

- macOS asks once whether `node` may accept incoming connections: click **Allow**. If you clicked Deny, fix it in
  **System Settings → Network → Firewall → Options**, or turn off "Block all incoming connections".
- The IP address changes from network to network; the `.local` name stays the same. Run `npm run share` after
  switching networks.
- Sign-in works over plain `http` on a private network (the session cookie is only marked `Secure` over HTTPS). Do not
  expose the port to the public internet without HTTPS (a reverse proxy, or the built-in `LM_TLS_CERT_FILE`).
- Since 1.5, over plain `http` from a phone or another laptop, money and secret actions are refused with "For safety
  this only works over a secure connection": entering or confirming bank details, approving a payment or downloading
  its file, changing a payment connection, the two-approvals setting, confirming a VAT number, giving a setup code,
  resetting two-step or a PIN, and new recovery codes. Do those on the computer that runs Linear Hub (or over https).
  A person added from a phone gets no setup code on screen, and someone who turns two-step on from a phone gets no
  recovery codes: make them on that computer later.
- Working with no signal (the app saved on the phone) and keeping the screen on in Quick gauges need the secure
  (https) address too; over plain `http` saves wait only while the page stays open.
- `HOST=127.0.0.1 npm start` keeps it private to this machine, for example on public Wi-Fi.

### Run it in the background

So phones on the hotspot keep working with no Terminal window open, and Linear Hub starts by itself when you log in:

```bash
npm run build                # the service serves the built client
npm run service:install      # stops a copy running in a terminal, then installs and starts the service
npm run service:status       # loaded? answering? the last 20 log lines
npm run service:uninstall    # stop it for good and free the port
```

#### macOS: a LaunchAgent

- `npm run service:install` writes `~/Library/LaunchAgents/uk.co.linear-mcr.hub.plist` (label `uk.co.linear-mcr.hub`)
  with `RunAtLoad` and `KeepAlive`: it starts at log-in and macOS restarts it within seconds if it stops. Logs go to
  `~/Library/Logs/LinearHub/linear-hub.log`. It runs this checkout's `server/src/index.ts` with the Node you ran the
  command with (a Homebrew Cellar path becomes the stable `…/opt/node/bin/node` link), in production mode with
  `TZ=Europe/London`, plus `PORT`, `HOST`, `DB_PATH`, `LM_APP_SECRET_FILE`, `LM_BACKUP`, `LM_BACKUP_DIR`,
  `LM_BACKUP_HOUR`, `TRUST_PROXY`, `COOKIE_SECURE`, `LM_SMART`, `LM_COMPRESSION`, `LM_DEMO_ACCOUNTS`,
  `LM_STATEMENTS_JOB`, `LM_STATEMENTS_DIR`, `LM_UPLOADS_DIR` and (1.5) `LM_OFFSITE_DIR`, `LM_BACKUP_PASSPHRASE_FILE`,
  `LM_BACKUP_VIDEOS`, `LM_TLS_CERT_FILE` and `LM_TLS_KEY_FILE` if they are set in that terminal (folders resolved from
  `server/`, as `npm start` resolves them). The 1.4 `LM_PAYMENTS_JOB` and `LM_PAYMENTS_FAKE` are not passed on: under
  the service the 5-minute payments check always runs and the test providers never appear. `LM_APP_SECRET` is never
  written into the file (it would sit there in plain text): since 1.5 install writes it to
  `~/Library/Application Support/LinearHub/app-secret` (mode 600) and points `LM_APP_SECRET_FILE` at it, with
  `LM_UPLOADS_DIR` pinned to where the uploads are now.
- **Running `service:install` again keeps the service's settings (1.5).** Every Linear Hub setting this terminal leaves
  unset is taken from the installed LaunchAgent or unit (a setting typed in the terminal wins), and its key file is
  used again; install prints what it kept. `npm run service:install -- --fresh` uses only this terminal's settings.
  `npm run latest` relies on this when it restarts the service.
- It refuses to install without a built client (`npm run build` first), stops a copy running in a terminal, then loads
  the agent and waits up to 20 seconds for it to answer.
- While it runs as a service, `npm run stop` only makes macOS start it again: use `npm run service:uninstall`
  (for example before `npm run restore`, then `npm run service:install` afterwards).
- After switching Node (`nvm use`, `brew upgrade node`), run `npm run service:install` again; `service:status` and
  `npm run doctor` warn when the service still points at the old Node.
- A sleeping Mac answers nobody: for a day in the field, set System Settings › Battery › Options › "Prevent automatic
  sleeping on power adapter when the display is off".
- **Keep the Linear Hub folder out of Desktop, Documents, Downloads and iCloud Drive.** macOS guards those folders, and
  a background service (unlike Terminal) can be refused access to them ("Operation not permitted" in the log), so it
  could not open the database or write backups. `service:install` and `service:status` warn when the checkout,
  `DB_PATH`, `LM_BACKUP_DIR`, `LM_APP_SECRET_FILE`, `LM_STATEMENTS_DIR` or `LM_UPLOADS_DIR` is in one: move the
  folder (for example to `~/LinearHub`) and install again, or give the Node it names Full Disk Access in System
  Settings › Privacy & Security. For the same reason, do not point `LM_BACKUP_DIR` into iCloud Drive while it runs as
  a service: copy the folder there by hand instead.

#### Linux and Windows

- **Linux**: a systemd user unit, `~/.config/systemd/user/linear-hub.service` (`Restart=always`,
  `RestartPreventExitStatus=78` so a missing or wrong app key does not restart in a loop), started with
  `systemctl --user enable --now`. Run `loginctl enable-linger $USER` to keep it running while nobody is logged in.
  Since 1.5 `LM_APP_SECRET` goes into `~/.config/linear-hub/linear-hub.env` (mode 600), which the unit reads with
  `EnvironmentFile=`. A server on the internet uses the system service `deploy/install.sh` sets up instead
  ([docs/DEPLOY.md](docs/DEPLOY.md)).
- **Windows**: `npm run service:install` prints the Task Scheduler steps; the printed `.cmd` creates
  `%LOCALAPPDATA%\LinearHub` before writing its log there.

`npm run service:install -- --print` shows the file and the commands without changing anything. The files it prints
for macOS, Linux and Windows are covered by the server tests (`server/src/test/service.test.ts`).

#### Release checks on the owner's Mac

macOS cannot run in CI, so these stay as release checks for the owner (only the `--print` plist has been checked: it
parses, `KeepAlive` and `RunAtLoad` are true, and the environment and log path are as above):

1. From a checkout outside Desktop/Documents/Downloads/iCloud: `npm run build && npm run service:install`, then
   `launchctl list | grep uk.co.linear-mcr.hub` and `curl http://localhost:4000/api/health`.
2. `kill -9 <pid>` (the pid from `npm run service:status`): a new pid answers within 10 seconds.
3. `npm run service:uninstall`: port 4000 is free (`lsof -iTCP:4000 -sTCP:LISTEN` prints nothing).
4. `npm run backup && npm run backups`; delete a gauge, `npm run service:uninstall`, `npm run restore -- <file> --yes`,
   `npm run service:install`: the gauge is back.

### Troubleshooting

| Symptom | What to do |
|---|---|
| `npm run build` (or any other command) says "Could not read package.json" with `ENOENT` | It was run in a folder with no Linear Hub commands. Update (`git pull`) so the top folder passes commands down, or run `cd linear-micro-crm` first |
| `npm start` says port 4000 is already in use, or an older build printed "listening" and the shell prompt came straight back | An earlier copy of this server is still running (another terminal tab or window; older builds printed "listening" anyway because Express 5 hands a failed bind to the listen callback instead of throwing). Run `npm run stop`, then `npm start`. The server now refuses to start behind another process, names it and exits with code 1, and reports any other reason it stops (a signal, a crash, a drained event loop). `npm run doctor` checks everything else; paste its report when asking for help |
| The browser shows a blank page that never finishes loading on <http://localhost:4000> | Something else is answering on that port. If it is an old Linear Hub, `npm run stop` ends it; otherwise find it with `lsof -nP -iTCP:4000 -sTCP:LISTEN` and `kill <PID>`, or use `PORT=4001 npm start` |
| An old copy keeps appearing on port 4000 | Stop the server with **Ctrl+C** in the terminal where it runs, not Ctrl+Z (which only pauses it and keeps the port) and not by closing the window. The current build stops within two seconds of Ctrl+C and treats Ctrl+Z as a stop request; an older copy that is still around is ended by `npm run stop` |
| A phone on the same Wi-Fi or hotspot cannot open the address | Allow incoming connections for `node` in **System Settings → Network → Firewall**, check both devices are on the same network, re-run `npm run share` for the current address, and make sure `HOST` is not set |
| `Cannot find module 'qrcode'` or similar after a `git pull` | Dependencies changed. `npm start` and `npm run build` install them first; with an older checkout run `npm ci`, then `npm start` |
| New features do not appear after updating | Either the pull did not happen or the screens were not rebuilt. Use `npm run latest`, which does both. `npm start` also rebuilds stale screens, and the server warns at start-up when they are out of date. `curl -s localhost:4000/api/health` shows the running version |
| `git pull` says "Your local changes to package-lock.json would be overwritten" | npm rewrote that file during an install. It is generated, so discard it: `git restore package-lock.json`, then `git pull` (or just `npm run latest`, which does this for you). Installs now use `npm ci`, which never rewrites it |
| `npm start` serves the API but the page is empty or stale | Rebuild the client: `npm run build` (the server serves `client/dist`) |
| The only administrator lost their phone and recovery codes, or no authenticator code works after the `app-secret` file or `LM_APP_SECRET` was lost | On the computer that runs Linear Hub: `npm run 2fa:reset -- morgan.blake@linearhub.example` (their sign-in email; from a plain terminal it uses the background service's database, otherwise set `DB_PATH` as you do for `npm start`). It clears that person's two-step verification, signs them out everywhere and prints a one-time setup code; they sign in with their email, employee ID, PIN and that code, and set two-step up again. Everyone else: an administrator resets it in Team → the person → **Edit profile** (charity and client accounts: **Reset two-step** on the campaign page's **Client accounts** card) |
| "Too many wrong PINs. Try again after …" and nobody else can reset that PIN (the only administrator), or no PIN works after the `app-secret` file or `LM_APP_SECRET` was lost | Wait for the time shown, or on the computer that runs Linear Hub: `npm run pin:reset -- morgan.blake@linearhub.example` (their sign-in email; set `DB_PATH` as you do for `npm start` unless the background service's is meant). It clears that person's PIN and lock, signs them out everywhere and prints a one-time setup code; they sign in with their email, employee ID and that code (and their two-step code) and set a new PIN |
| "Linear Hub did not start: the app key is missing", or "… is not the key this database was locked with" (exit code 78) | The key that locks bank details, two-step sign-in and PINs is not where the server reads it, or it is a different one. Do not delete anything. Put the key back: `npm run key:restore` and type it from the recovery sheet, or `-- --file <backups>/app-secret`, or `-- --from <file>.lhbk` (an off-site copy). It checks the key against the database before saving it. `npm run doctor` names what is locked and the fingerprint the database needs |
| "Demo accounts cannot … Sign in with your own administrator account, or go live first" | During the trial the one-tap demo accounts only work on the demo company. Use your own administrator account for real people, pay and settings, or go live with `npm run golive` |
| "For safety this only works over a secure connection" | A money or secret action was tried over plain `http` from another device. Do it on the computer that runs Linear Hub, or over https |
| "That setup code is not right, or it has been used or has expired" | Give a new code: Team → the person → **Edit profile** → **Sign-in setup** → **Give a setup code**, or `npm run setup-code -- <email>` on the server |
| The server stops at start-up saying a database was here before (backups exist but the database file does not) | `DB_PATH` probably points at the wrong place. Check it; or `npm run restore -- <newest backup>`; or `npm run seed` to start a demo on purpose. Linear Hub no longer makes a new demo company there by itself |
| `npm run smoke` on a Mac stops at once and prints a `sudo ifconfig lo0 alias …` command | The smoke test acts as other devices from 127.0.0.2 and 127.0.0.3, which a Mac does not have until they are added. Run the printed command once (it lasts until the next restart), then `npm run smoke -w server` again |

### Backups and restore

People, gauges and pay are in one file, `server/data/linear.sqlite`. Next to it sit `server/data/statements/` (client
statement PDFs), `server/data/uploads/` (the signature image on invoices) and `server/data/media/` (learning videos).
While the server runs it keeps dated backups in **`server/data/backups/`** (set `LM_BACKUP_DIR` to put them elsewhere):

- **10 minutes after start-up**, when the last backup is more than 24 hours old;
- **every night**: an hourly check backs up once the London time has reached 02:00 (`LM_BACKUP_HOUR`) and there is no
  backup dated today. A laptop that was asleep at 02:00 gets its copy within an hour of waking.

Each backup is a complete, checked database (`linear-2026-10-19-0200.sqlite`, named in London time, mode 600), made
with SQLite's online backup, so it is consistent even while people are logging gauges. **Since 1.5 it also holds the
uploaded files**: beside it, `linear-2026-10-19-0200.files/` has `statements/` and `uploads/` (and `media/` with
`LM_BACKUP_VIDEOS=1`); a file unchanged since the last backup is a hard link, so a nightly copy costs almost no disk.
The folder keeps the newest backup of each of the last 30 days plus one a week for the 8 weeks before that; older ones
are deleted with their files (never one made in the last 24 hours), anything else in the folder is left alone.
`LM_BACKUP=0` turns the automatic schedule off (`npm run backup` still works). Backups always run on the real clock,
even when `LM_BUSINESS_NOW` pins the business day.

```bash
npm run backup                       # back up now (works while the server is running)
npm run backups                      # list the copies with size and age
npm run stop                         # a restore needs the server stopped
npm run restore -- linear-2026-10-19-0200.sqlite        # shows what changes and asks before replacing
npm start
```

`restore` refuses while the database is open in another process — a Linear Hub started with another `PORT` or
`HOST`, or a background service, is caught too, because it checks the file's lock rather than only the port ("The
database is open in another process … Stop it first, with the PORT it runs on") — and while anything answers on the
port ("Stop it first: npm run stop"). It checks the backup (`PRAGMA integrity_check` and the Linear Hub tables), prints
the current and the backup's users, gauge entries, payroll runs and latest gauge date side by side, and only then asks
(`--yes` skips the question). **Since 1.5 it also lists what Linear Hub would forget about money** (live payments
approved, payments sent or paid, bank files made, bank details changed, pay runs marked paid since the backup) and then
needs **RESTORE** typed; if it cannot compare, it says so and still asks. A restore over newer payments leaves a
warning for administrators in the bell for 14 days: check payments with the bank. The database it replaces is kept
next to it as `linear.sqlite.before-restore-<date-time>`, so a restore can itself be undone. The backup's files are put
back (a different live file is kept as `<name>.before-restore-<time>`; files added since are left alone), and the key
that opens the backup is put in place. If Linear Hub runs as a background service, stop it with
`npm run service:uninstall` instead of `npm run stop` (macOS would only start it again), restore, then
`npm run service:install`.

**The app key and the recovery sheet (1.5).** One key, `app-secret` (or `LM_APP_SECRET`), locks two-step sign-in
secrets, bank details and payment keys and is mixed into every sign-in PIN. Lose it and those can never be read again,
so Linear Hub now refuses to start without the right key instead of quietly making a new one. Put it on paper once, on
the computer that runs Linear Hub: `npm run recovery-sheet -- --print` (or show it and copy it by hand), lock the paper
away, then `npm run recovery-sheet -- --confirm` and type the whole key back from the paper. Until that is confirmed
every backup keeps a copy of the key (so nothing can become unreadable); afterwards backups leave it out and the copy in
the backups folder is removed. **Settings › Backups** shows whether the sheet is done. `npm run key:restore` puts the
key back from the sheet. The key never travels over the network: no screen or API shows it.

**Off-site copies (1.5).** A backup on the same computer does not survive losing it. Set `LM_OFFSITE_DIR` (a folder on
a mounted cloud drive, or one rclone carries away) and `LM_BACKUP_PASSPHRASE_FILE` (make it with
`npm run backup -- --new-passphrase <file>` and write the passphrase on paper, kept apart from the recovery sheet).
After every backup Linear Hub writes `linear-….lhbk` there: the checked database, the uploaded files and the key,
encrypted with AES-256-GCM under the passphrase, read back and checked before it counts, 30 daily and 8 weekly kept.
`npm run restore -- <file>.lhbk` restores one (it asks for the passphrase). A server set up with `deploy/install.sh`
does all of this for you ([docs/DEPLOY.md](docs/DEPLOY.md)).

**Keep the backups folder private.** It holds everyone's names and pay, their bank details and the payment
connections' keys (encrypted), and, until the recovery sheet is confirmed, a copy of the key: anyone with the whole
folder could try every 4-digit PIN in minutes. Only in your own account, never in a shared folder or sent to anyone.
`npm run doctor` and **System health** in the bell (administrators) warn when the last backup failed or is more than
36 hours old, when the off-site copy is late or failing, when the disk has less than 1 GB free, when the key is not on
a confirmed recovery sheet, and when the server logged errors (`<data dir>/logs/errors.log`).

**Never commit the backups folder.** `server/data/backups/`, the `*.before-restore-*` copies a restore keeps and its
`*.restoring-*` staging files are in `.gitignore`, as are the live database (`server/data/*.sqlite`),
`server/data/app-secret` and `server/data/starter-team.json`; if you set `LM_BACKUP_DIR` or `LM_OFFSITE_DIR`, choose
folders outside the repository (never push a copy of payroll and the sign-in key to GitHub). Before any `git add`,
`git status` should show nothing under `server/data/`.

### Docker

```bash
docker build -t linear-hub .
docker run -p 4000:4000 -v linear-data:/app/server/data linear-hub
```

The image builds the client, installs production dependencies only, sets `TZ=Europe/London`, exposes port 4000 and
keeps the database in the `/app/server/data` volume. A new volume starts as the demo in trial mode: to go live, stop the
container, then run `docker run --rm -it -v linear-data:/app/server/data linear-hub npm run golive` and start it again.
For a real server, the supported route is `deploy/install.sh` ([docs/DEPLOY.md](docs/DEPLOY.md)).

### Going live: `npm run golive`

A database built by the demo seed is in **trial mode** (1.5): it holds the demo company (invented people, history and
records) and, on the office computer, the one-tap demo sign-ins. Administrators see "Trial mode: demo sign-ins are on"
under the top bar and as the first item in Needs attention until the owner goes live. During the trial the one-tap demo
accounts, and every person of the demo company, can only play with the demo: they can never change your own people,
anyone's real pay, bank details, payments or the office settings ("Demo accounts cannot … Sign in with your own
administrator account, or go live first (npm run golive)"). Every write the app has is on one list
(`server/src/lib/demoWrites.ts`), so a new feature is refused for demo accounts until someone decides.

On the computer that runs Linear Hub, with Linear Hub stopped (`npm run stop`, or `npm run service:uninstall` for the
background service):

```bash
npm run golive
```

1. It refuses while the database is open, and says how to stop Linear Hub.
2. It shows what goes and what stays, by name: the demo accounts used during the trial (they go too, so whoever used
   one adds their own account), the demo records it keeps and why, and the demo records only demo accounts changed.
3. It asks for the first owner's name and email when no administrator of your own would be left, then for **GO LIVE**.
4. It backs the database up (with the uploaded files) and checks the backup before changing anything.
5. It removes the demo company: its people (the one-tap accounts too, even renamed) and their history, and the records
   the demo seed made, except a demo record someone of your own made or changed, one that names one of your people, or
   one that something staying points at (for example a demo campaign with a real person's client ID). Statement PDFs
   are never deleted.
6. It keeps your settings (pay plans, payment connections, security, company details), your own people and their
   history, and every record made in the app since the demo was set up — a trial week spent on 1.4 included.
7. Trial mode is off for good: no one-tap sign-ins, and the server never seeds the demo again.
8. When none of your own administrators is left it makes the first **owner** (LM-0001 when free) and prints their
   one-time setup code; everyone of your own who has not finished setting up is listed ("give each a setup code").

Then `npm start`, and sign in with the email, employee ID and setup code it printed, then set up two-step verification.
Running it again changes nothing ("Linear Hub is already live"). It reads `DB_PATH`, `PORT`, `LM_BACKUP_DIR` and
`LM_APP_SECRET_FILE` like `npm start`, exits 0 when live and 1 when refused or cancelled with nothing changed, and is in
the audit trail.

### Demo accounts

Sign in with the email and employee ID (matching is case-insensitive). On a demo database in trial mode the sign-in
page also has one-tap buttons for these four, the charity account and the starter team. Every demo person is invented
and every demo email uses the invented domain `linearhub.example` (1.5): no real person is in the repository.

**The demo and sign-in (1.5).** The one-tap demo accounts need no setup code and no two-step code during the trial,
and follow the normal session limit (14 hours by default). They are restricted to the demo company (see
[Going live](#going-live-npm-run-golive)). They are shown on the office computer's plain-http address; on a server
online over https (built-in HTTPS or `TRUST_PROXY`) they are off unless `LM_DEMO_ACCOUNTS=1`, and `LM_DEMO_ACCOUNTS=0`
turns them off everywhere. Anyone you add, and every client you invite, signs in with a setup code and uses two-step
even on the demo. A fresh demo gives most of the people paid weekly obviously fake bank details (sort code 00-00-00).

| Role | Name | Email | Employee ID |
|---|---|---|---|
| admin | Morgan Blake (Owner) | morgan.blake@linearhub.example | LM-0001 |
| leader | Amelia Hart (Crew Leader) | amelia.hart@linearhub.example | LM-0002 |
| recruiter | Priya Shah (Recruiter) | priya.shah@linearhub.example | LM-0003 |
| rep | Jordan Lee (Field Rep) | jordan.lee@linearhub.example | LM-0010 |

**The charity account** — the client portal as Breast Cancer Now sees it (no PIN on the demo). On the sign-in page it is
under **Charity accounts**.

| Role | Name | Email | Access code |
|---|---|---|---|
| client | Hannah Price (Breast Cancer Now) | hannah.price@breastcancernow.example | CL-0001 |

**The starter team** — blank accounts at the end of the seed: everything works, nothing is logged yet (no gauges,
events, pay or learning). Since 1.5 they come from **your own** `server/data/starter-team.json` next to the database
when it exists (never committed: `.gitignore` has it), so the office's real team can try Linear Hub with one tap during
the trial and stays, as ordinary accounts needing a setup code, after going live. Otherwise they come from the
committed `server/starter-team.example.json`, invented people who belong to the demo company:

| Role | Name | Email | Employee ID |
|---|---|---|---|
| leader | Ava (Team Leader, leads Sapiens) | ava@linearhub.example | LM-0101 |
| leader | Ben (Team Leader) | ben@linearhub.example | LM-0102 |
| leader | Cleo (Team Leader) | cleo@linearhub.example | LM-0103 |
| leader | Dev (Team Leader) | dev@linearhub.example | LM-0104 |
| rep | Esme (Trainee) | esme@linearhub.example | LM-0105 |
| rep | Femi (Trainee) | femi@linearhub.example | LM-0106 |
| rep | Gina (Trainee) | gina@linearhub.example | LM-0107 |

A starter team file has the same shape as the example (`employeeId` and `lastName` are optional; IDs run from
LM-0101). A broken file stops the seed with a sentence naming the file and the problem.

Recruiters and leaders can add people too (**Team → Add person**: trainees and field representatives; a leader to their
own team), and get the new person's sign-in details, with their one-time setup code, to send on.

Sample teams: Northern Lights, Deansgate, Spinningfields, Ancoats and Sapiens. Sample campaigns: Breast Cancer Now (fundraising, private sites), Children's Hospice North (fundraising, events), Volt Energy (B2B), FibreCity Broadband (residential).

---

## Architecture

Three npm workspaces in one repository, all TypeScript (strict, ESM):

- **`client`** — React 19, Vite 6, Tailwind CSS v4 (semantic design tokens, light and dark themes), TanStack Query 5, React Router 7, Recharts, lucide-react. Pages compose domain components from `src/features/**`, the UI kit from `src/components/ui`, and charts from `src/components/charts`.
- **`server`** — Express 5 with SQLite through `node:sqlite` (no native build step), Zod 4 validation, httpOnly session cookie, role rules and employee-ID redaction in `src/lib/scope.ts`, pay rules in `src/lib/pay.ts`. Seeds deterministic sample data on first run, materialises weekly payroll runs and rolls event statuses forward (`src/db/maintenance.ts`), and serves the built client in production.
- **`shared`** — `@lm/shared`: the domain types, brand constants, benchmark ratios and pure business logic (funnel ratios and validation, payroll calculation, paydays, punctuality, ranking, coaching insights) used by both sides so the numbers always agree.

The API contract is in [`docs/API.md`](docs/API.md). Design tokens and the UI kit are described in [`docs/DESIGN.md`](docs/DESIGN.md); the maths behind ratios, payroll and charts in [`docs/LOGIC.md`](docs/LOGIC.md).

```
linear-micro-crm/
├── client/                          # React 19 + Vite 6 + Tailwind v4 (dev on :5173)
│   ├── index.html
│   ├── public/                      # favicon, logo, 1.5: web app manifest and home-screen icons
│   ├── sw/                          # 1.5: the offline service worker (sw.ts, request handling, cache policy)
│   ├── build/                       # 1.5: Vite plugin that writes dist/sw.js and its precache list
│   └── src/
│       ├── api/                     # fetch wrapper (client.ts) + TanStack Query hooks (hooks.ts)
│       ├── auth/                    # AuthProvider, RequireAuth, RequireRole
│       ├── components/
│       │   ├── brand/               # Logo
│       │   ├── charts/              # Funnel, Trend, Bars, Donut, Sparkline (Recharts)
│       │   ├── layout/              # AppShell, Sidebar, Topbar, nav.ts, theme
│       │   └── ui/                  # Button, Card, Badge, DataTable, Modal, Tabs, Stepper, …
│       ├── content/                 # copy.ts, about.ts, team.ts — all microcopy
│       ├── features/                # the bulk of the UI, by domain
│       │   ├── campaigns/           #   campaign form
│       │   ├── common/              #   range picker, status badges, confirm dialog, loading/error states, ErrorBoundary, offline banner
│       │   ├── dashboard/           #   announcements, company section, recruiter section, upcoming events
│       │   ├── events/              #   event form, event row, forecast chip
│       │   ├── finance/             #   payroll runs table, payslip, add expense, bulk Mark paid
│       │   ├── payments/            #   1.4: Settings → Payments, bank details card, provider logos, bank file formats
│       │   ├── gauges/              #   Log gauges modal, outbox, tally, summary and entries tables, performance panel, coaching
│       │   ├── recruitment/         #   candidate card, "Move to…" control, schedule interview, stage stepper, Record the outcome
│       │   ├── settings/            #   two-step verification set-up and recovery codes
│       │   ├── smart/               #   1.1 dashboard slots: Needs attention, pace note, pay strip, check-ins, week in review (lazy.tsx)
│       │   └── team/                #   user form
│       ├── lib/                     # formatGBP, dates, labels, ratios
│       ├── offline/                 # 1.5: service worker registration, the update banner, the field kit
│       └── pages/                   # one file per route
├── server/                          # Express 5 + node:sqlite (:4000)
│   ├── data/                        # linear.sqlite (generated, git-ignored)
│   └── src/
│       ├── app.ts                   # Express app factory (routes, static client in production)
│       ├── index.ts                 # bootstrap: open DB, seed, maintenance timers, listen
│       ├── db/                      # connection, schema, seed, seed-data, queries
│       │   └── maintenance.ts       # payroll materialisation, event status roll-forward
│       ├── lib/                     # dates (business clock), pay rules, metrics, scope (role rules + redaction), validation,
│       │   │                        #   errors, response cache, compression, backups, two-step verification
│       │   ├── payments/            # 1.4: provider contract and registry, bank file, Revolut, Wise, TrueLayer, batches, job
│       │   └── smart/               # 1.1 builders (pace, streaks, pay forecast, payroll checks, check-ins, event forecasts,
│       │                            #   digest) behind the LM_SMART switch
│       ├── middleware/              # session authentication; 1.5: secure-connection and demo-account guards
│       ├── routes/                  # one file per API area (incl. insights, attention, digest)
│       ├── test/                    # server route tests (node:test, npm test)
│       ├── backup.ts · restore.ts   # npm run backup / backups / restore
│       ├── keyRestore.ts · recoverySheet.ts   # 1.5: npm run key:restore / recovery-sheet
│       ├── golive.ts · setupCode.ts # 1.5: npm run golive / setup-code
│       ├── service.ts               # npm run service:install / uninstall / status
│       ├── doctor.ts · stop.ts · share.ts   # npm run doctor / stop / share
│       └── smoke.ts                 # boots a temporary DB and exercises every endpoint
├── shared/                          # @lm/shared — types, constants, pure logic (+ node:test suites)
│   └── src/
│       ├── types.ts
│       ├── constants.ts
│       └── logic/
├── deploy/                          # 1.5: install.sh for a small Ubuntu server (Caddy, HTTPS, off-site copies), templates, tests
├── docs/                            # API, LOGIC, DESIGN, USER_GUIDE, DEPLOY, MAINTAINERS, OWNER_NOTES, PITCH, ROADMAP, TEAM, …, screenshots/
├── scripts/                         # 1.5: npm run test:dates (runs the tests as if it were another day)
├── CHANGELOG.md
├── Dockerfile
├── LICENSE                          # 1.5: © Noryn System Ltd, licensed to Linear MCR Limited
└── package.json                     # npm workspaces + root scripts
```

---

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — step-by-step for reps, leaders, recruiters, administrators and charity and client accounts, using the app's own button and tab names, with the release notes at the end
- [`docs/OWNER_NOTES_1.5.md`](docs/OWNER_NOTES_1.5.md) — what changed in 1.5 for the owner, what to do before going live (go live, the recovery sheet, off-site backups, the HTTPS server, the first test payments, two approvals), and what was and was not tested
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — the go-live runbook: a small server with HTTPS, off-site copies, a go-live checklist; [`deploy/`](deploy/) holds the installer and its tests
- [`docs/OWNER_NOTES_1.4.md`](docs/OWNER_NOTES_1.4.md) and [`docs/OWNER_NOTES_1.3.md`](docs/OWNER_NOTES_1.3.md) — what the owner needed to set up or decide for 1.4 (two-step for everyone, each way to pay) and 1.3 (Gmail app password, company details, client accounts, videos)
- [`docs/PITCH.md`](docs/PITCH.md) — the business case and rollout plan for Linear MCR
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what comes next
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release (1.5.0: trial mode and going live, setup codes, the app key and off-site backups, money checks, working with no signal; 1.4.0: two-step for everyone, the 14-hour sign-out, paying people from Linear Hub; 1.3.1: leaders and recruiters add people, invoice lines that say why; 1.3.0: pay, invoices, statements, clients; 1.2.0: learning, field and office; 1.1.0: the smart release)
- [`docs/API.md`](docs/API.md) — the API contract and implementation notes
- [`docs/LOGIC.md`](docs/LOGIC.md) and [`docs/DESIGN.md`](docs/DESIGN.md) — the maths (section 14: the smart release; 15: release 1.2; 16: release 1.3; 17: release 1.4; 18: release 1.5) and the design system
- [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) — the guide for another developer taking Linear Hub over
- [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md) — the load and robustness report (§10: 1.1 against 1.0 on the same machine)
- [`docs/TEAM.md`](docs/TEAM.md) and [`docs/TEAM_CONTRACT.md`](docs/TEAM_CONTRACT.md) — how it is built
- [`LICENSE`](LICENSE) — Linear Hub is owned by Noryn System Ltd and licensed to Linear MCR Limited

---

## Built by

Linear Hub is built, owned and supported by **Noryn System Ltd** and licensed to Linear MCR Limited (see
[`LICENSE`](LICENSE)). One developer directs AI coding agents that write the code in parallel work packages; automated
tests and independent reviews check every release. [`docs/TEAM.md`](docs/TEAM.md) says how, and
[`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) is the guide for another developer taking it over.

---

## A note on the data

All sample data is **illustrative**. People, candidates, events, gauges, pay runs and expenses are generated deterministically for the last 26 weeks — but anchored to the date the seed runs, so a fresh install always looks like "this week" and every chart has something to show. Regenerate it with `npm run seed`; the figures will differ from an earlier run only because the calendar has moved. The demo names are not real employees, and the figures are not Linear MCR's actual results. Facts about the company itself (what it does, where it is registered, how its ladder works) come from public sources.

---

The bank and payment logos come from the CC0 `simple-icons` package (it has no TrueLayer mark, so TrueLayer shows a "TL" monogram). Logos belong to their owners and only identify the service.

© Noryn System Ltd. Licensed to Linear MCR Limited.
