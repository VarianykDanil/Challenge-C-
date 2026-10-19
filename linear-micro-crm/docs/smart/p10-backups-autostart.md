# p10 — Backups, restore, running in the background, compression

The company's people, gauges and payroll live in one SQLite file on one MacBook. This package keeps dated, consistent
copies of that file, makes putting one back safe, keeps the server answering phones on the hotspot without a Terminal
window open, and compresses what the server sends over the hotspot.

Per the fragment guide, p10 has no LOGIC.md section: the **Logic** section below is written as the two README sections
("Backups and restore", "Run it in the background") plus the README table rows to merge, followed by the rules and
measurements behind them.

## API

### `GET /api/health` — `backup` for administrators (additive)

Unchanged for everyone else: `{ ok, version, seededAt }`. When the request carries an **admin** session, the response
also has `backup` (`BackupStatus` in `shared/src/types.ts`):

| Field | Type | Meaning |
|---|---|---|
| `backup.lastAt` | `string \| null` | ISO time of the last backup; `null` when there has been none |
| `backup.file` | `string \| null` | its file name, e.g. `linear-2026-10-19-0200.sqlite` |
| `backup.count` | `number` | backup files kept in the folder now |
| `backup.dir` | `string` | absolute path of the backup folder on the server |
| `backup.enabled` | `boolean` (optional) | `false` when this server was started with `LM_BACKUP=0`, so it makes no automatic backups (`npm run backup` still works); `true` otherwise |

- The health router already runs after `authenticate`, so `req.user` is set for a signed-in request. Leaders,
  recruiters, reps and anonymous probes (`npm run stop`, `npm run share`, `doctor`, `loadtest/lag.mjs`) never see the
  key. Covered by `server/src/test/backups.test.ts`.
- `lastAt`/`file` are the newer of the meta record (`last_backup_at`, `last_backup_file`) and the newest file in the
  folder (after a restore the meta table is the backup's own, older record).
- Not cached (not in `CACHED_PATHS`); one `readdir` of the backup folder per admin request.
- `enabled` is an addition to `BackupStatus` declared next to the route (`BackupStatus & { enabled?: boolean }`), so
  `shared/src/types.ts` is unchanged; Settings reads it the same way.

### HTTP compression (every response)

- `gzip` (level 6) for JSON, HTML, JavaScript, CSS and SVG responses of **1 KB or more** when `Accept-Encoding`
  allows it; `br` (brotli quality 4) only when the client **prefers** it (ranks `br` above `gzip` with q-values, or
  accepts only `br`). Browsers send `gzip, deflate, br, zstd` without q-values and get gzip — see the measurements.
- Headers: `Content-Encoding`, an exact `Content-Length` (the compressed size), `Vary: Accept-Encoding` on every
  compressible response (compressed or not), and no `Accept-Ranges` on a compressed one.
- Left alone: `HEAD`, `204`, `206` (ranges), `304`, any non-2xx, responses that already have a `Content-Encoding`,
  `Cache-Control: no-transform`, bodies under 1 KB, other types (PNG, fonts…), and clients without a usable
  `Accept-Encoding`.
- ETags are unchanged (Express's are weak, so one ETag for both encodings is correct); `If-None-Match` still gives a
  `304` with no body. `X-Cache: HIT` replays from the response cache are compressed exactly like a fresh response.
- `LM_COMPRESSION=0` turns it off (for example behind a reverse proxy that compresses already).

### New npm scripts (root and `server/`)

| Script | What it does |
|---|---|
| `npm run backup` | Back the database up now (fine while the server runs). |
| `npm run backups` | List the backup files with size and age. |
| `npm run restore -- <file> [--yes]` | Put a backup back as the live database (server must be stopped). `<file>` is a path or a file name from the backups folder. |
| `npm run service:install` | Run Linear Hub in the background (macOS LaunchAgent, Linux systemd user unit; Windows: prints Task Scheduler steps). |
| `npm run service:uninstall` | Remove the background service and free the port. |
| `npm run service:status` | Is it loaded and answering; last 20 log lines; Node-path check. |
| `node src/service.ts --print` | Dry run (from `server/`): print the service file and the commands, change nothing. `--platform=darwin\|linux\|win32` shows another platform's file. |

## Logic

### README — "Backups and restore" (new section, after "Troubleshooting")

Everything — people, gauges, pay — is in one file, `server/data/linear.sqlite`. While the server runs it keeps dated
copies of it in **`server/data/backups/`** (set `LM_BACKUP_DIR` to put them elsewhere):

- **10 minutes after start-up**, when the last backup is more than 24 hours old;
- **every night**: an hourly check backs up once the London time has reached 02:00 (`LM_BACKUP_HOUR`) and there is no
  backup dated today. A laptop that was asleep at 02:00 gets its copy within an hour of waking.

Each copy is a complete, checked database (`linear-2026-10-19-0200.sqlite`, named in London time), made with SQLite's
online backup, so it is consistent even while people are logging gauges. The folder keeps the newest copy of each of
the last 30 days plus one a week for the 8 weeks before that; older copies are deleted (never one made in the last 24
hours), anything else in the folder is left alone.

```bash
npm run backup                       # back up now (works while the server is running)
npm run backups                      # list the copies with size and age
npm run stop                         # a restore needs the server stopped
npm run restore -- linear-2026-10-19-0200.sqlite        # shows what changes and asks before replacing
npm start
```

`restore` refuses while anything answers on the port ("Stop it first: npm run stop"), checks the backup
(`PRAGMA integrity_check` and the Linear Hub tables), prints the current and the backup's users, gauge entries,
payroll runs and latest gauge date side by side, and only then asks (`--yes` skips the question). The database it
replaces is kept next to it as `linear.sqlite.before-restore-<date-time>`, so a restore can itself be undone.

**Keep the folder private and copy it off the laptop.** It holds everyone's names and pay. It also holds
`app-secret`, a copy of the key that encrypts two-step sign-in secrets (mode 600): without it, people with two-step
sign-in could not sign in after restoring on a new laptop (restore puts it in place when the new laptop has none, and
warns when there is no key anywhere). A backup on the same laptop does not survive losing the laptop: copy the folder to
iCloud Drive or Google Drive now and then. `npm run doctor` warns when the last backup is more than 36 hours old and
when the disk has less than 1 GB free; **Settings › Backups** shows the same to the owner.

**Never commit the backups folder.** `server/data/backups/`, the `*.before-restore-*` copies a restore keeps and its
`*.restoring-*` staging files are in `.gitignore`; if you set `LM_BACKUP_DIR`, choose a folder outside the repository
(never push a copy of payroll and the sign-in key to GitHub).

### README — "Run it in the background" (new section, after "Use it from a phone or another laptop")

So phones on the hotspot keep working with no Terminal window open, and Linear Hub starts by itself when you log in:

```bash
npm run build                # the service serves the built client
npm run service:install      # stops a copy running in a terminal, then installs and starts the service
npm run service:status       # loaded? answering? the last 20 log lines
npm run service:uninstall    # stop it for good and free the port
```

- **macOS**: a LaunchAgent, `~/Library/LaunchAgents/uk.co.linear-mcr.hub.plist`, with `RunAtLoad` and `KeepAlive`: it
  starts at log-in and macOS restarts it within seconds if it stops. Logs go to
  `~/Library/Logs/LinearHub/linear-hub.log`. It runs this checkout's `server/src/index.ts` with the Node you ran the
  command with, in production mode with `TZ=Europe/London`, plus `PORT`, `HOST`, `DB_PATH` and the other Linear Hub
  settings if they are set in that terminal.
- **Linux**: a systemd user unit, `~/.config/systemd/user/linear-hub.service` (`Restart=always`), started with
  `systemctl --user enable --now`. Run `loginctl enable-linger $USER` to keep it running while nobody is logged in.
- **Windows**: `npm run service:install` prints the Task Scheduler steps.
- While it runs as a service, `npm run stop` only makes macOS start it again: use `npm run service:uninstall`
  (for example before `npm run restore`, then `npm run service:install` afterwards).
- After switching Node (`nvm use`, `brew upgrade node`), run `npm run service:install` again; `service:status` and
  `npm run doctor` warn when the service still points at the old Node.
- A sleeping Mac answers nobody: for a day in the field, set System Settings › Battery › Options › "Prevent automatic
  sleeping on power adapter when the display is off".
- **Keep the Linear Hub folder out of Desktop, Documents, Downloads and iCloud Drive** on a Mac. macOS guards those
  folders, and a background service (unlike Terminal) can be refused access to them ("Operation not permitted" in the
  log), so it could not open the database or write backups. `service:install` and `service:status` warn when the
  checkout, `DB_PATH`, `LM_BACKUP_DIR` or `LM_APP_SECRET_FILE` is in one: move the folder (for example to
  `~/LinearHub`) and install again, or give the Node it names Full Disk Access in System Settings › Privacy & Security.
  For the same reason, do not point `LM_BACKUP_DIR` into iCloud Drive while it runs as a service: copy the folder there
  by hand instead.
- **Windows**: the printed `.cmd` creates `%LOCALAPPDATA%\LinearHub` before writing its log there.

### README tables — rows to add

Scripts: `npm run backup`, `npm run backups`, `npm run restore -- <file>`, `npm run service:install`,
`npm run service:uninstall`, `npm run service:status` (descriptions as in the API table above).

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `LM_BACKUP` | on | `0` turns the automatic backups off (`npm run backup` still works). |
| `LM_BACKUP_DIR` | `<data dir>/backups` | Where backups go. |
| `LM_BACKUP_HOUR` | `2` | London hour (0–23) from which the nightly backup may run. |
| `LM_COMPRESSION` | on | `0` turns HTTP compression off. |

### Rules (for LOGIC readers)

**Backup** (`server/src/lib/backup.ts`, `backupNow`)
1. `backup(db, '<dir>/.<name>.<pid>.partial')` from `node:sqlite` (online backup API; `doctor` warns when a Node build
   lacks it, Node 22.16+ has it). The staging name carries the process id, so `npm run backup` in the same minute as
   the server's own backup never writes into the other's file (both finish; the second rename wins, and both copies are
   consistent).
2. The copy is switched from WAL to `journal_mode = DELETE`, so it is one self-contained file that opens anywhere
   without growing `-wal`/`-shm` files, then `PRAGMA quick_check` must say `ok`.
3. Only then is it renamed to `linear-YYYY-MM-DD-HHmm.sqlite` (Europe/London wall clock, from `Intl`, so the process
   TZ does not matter). A failed or half-written copy never carries the name. Two backups in one minute: the second
   replaces the first.
4. The app-secret is copied to `<dir>/app-secret` (mode 0600, written to a temp file and renamed) only when it is missing
   there or different. Skipped when `LM_APP_SECRET` is set (the key is not in a file).
5. `meta.last_backup_at` (ISO) and `meta.last_backup_file` are upserted. Nothing else is written; no gauge row, no
   payroll row.
6. Rotation runs. A second call while one runs for the same database shares the running one; shutdown waits for it
   before closing the database.
   - Node 26.8.1 quirk: the copy finishes on the thread pool, but its completion can sit unprocessed until something
     else wakes the event loop (measured: the worker finished the copy at 10:56:32.72 and JavaScript saw it at
     10:57:02.71, a 30 s stall under the test runner; an idle server would wait for its next timer). A 25 ms ref'd tick
     while the copy runs keeps the loop polling, so it settles within one tick. Node 22.22 does not show it.
7. The backup folder is created with mode 0700. Backups run on the real clock: a pinned `LM_BUSINESS_NOW` never changes
   their names or the schedule.

**Rotation** (`planRotation(names, today)`, `today` = London date)
- Day window: `today − 29 … today` (30 days). The newest file of each day in it is kept.
- Week window: the 8 ISO weeks (Mon–Sun) going back from the week that contains `today − 30`. In each, the newest file
  dated before the day window is kept.
- The newest file overall is always kept (so a laptop unused for months never loses its last copy).
- `rotate` never deletes a file written (mtime) in the last **24 hours**, even when a newer one replaces it for that
  day: after a mistake at 10:50, a panicked `npm run backup` at 11:00 must not delete the good 02:00 copy from the same
  morning. It goes at the first rotation a day later.
- Only names matching `^linear-YYYY-MM-DD-HHmm\.sqlite$` (valid month, day, hour and minute) are ever deleted as
  backups; `app-secret`, `linear.sqlite`, `*.bak` and anything else are left alone.
- Staging files a killed backup left behind (`.linear-….sqlite[.<pid>].partial`, with any `-wal`/`-shm`/`-journal`)
  are deleted once they are **1 hour** old (mtime); younger ones may belong to a backup running in another process.
  They are not counted as removed backups.

**Schedule** (`scheduleBackups`, unref'd timers, every failure logged and retried at the next check)
- Start-up: after 10 minutes, back up if `lastAt` is null or ≥ 24 h ago.
- Hourly: back up if the London hour ≥ `LM_BACKUP_HOUR` and the London date of `lastAt` is not today.
- `LM_BACKUP=0`: no timers (logged at start-up).

**Restore** (`restoreDatabase`)
1. Refuse while `findPortHolder(PORT)` finds anything (Linear Hub: "Linear Hub is running on port N … Stop it first:
   npm run stop"; when a service file is installed the message adds "npm run service:uninstall first").
2. Refuse a missing file, the live database itself, or a file without the SQLite header.
3. Copy the candidate to a private staging file next to the database (`<db>.restoring-<time>`; a raw copy of a live
   WAL database has its `-wal` folded in). The backup itself is never modified.
4. Open the staging copy read-only: `PRAGMA integrity_check` must return exactly `ok` and the tables `users, teams,
   pay_plans, campaigns, events, gauge_entries, payroll_runs, meta` must exist; otherwise refuse and delete staging.
5. Print current v backup: users, gauge entries, payroll runs, latest gauge date.
6. Ask (`--yes`, or a typed `y`/`yes` in a terminal; no terminal and no `--yes` = cancel).
7. Check the port again, move `<db>`, `<db>-wal`, `<db>-shm`, `<db>-journal` to `<db>.before-restore-<YYYY-MM-DD-HHmmss>`
   (+ suffix), rename staging to `<db>`.
8. Key: if `<backup folder>/app-secret` exists and the live key file is missing, install it (0600); if both exist and
   differ, say so and change nothing. If neither exists (and `LM_APP_SECRET` is not set) and the restored database has
   people with two-step sign-in on, warn: they cannot finish signing in with a code until the kept `app-secret` is put
   next to the database; otherwise they use a recovery code (stored hashed, so they still work) and an administrator
   resets their two-step sign-in (Team › Edit › Reset two-step verification).

**Health status for admins**: `count` = matching files in the folder; `lastAt`/`file` from meta unless the newest file
is more than a minute newer; `enabled` = the schedule this server started with (`index.ts` passes `backupsEnabled()`
to `configureBackupDir`; without that call it follows `LM_BACKUP`).

**Warnings** (Settings card and `npm run doctor`)
- Stale: last backup more than **36 h** ago → amber card / doctor `▲`.
- No backup yet: Settings shows a neutral "None yet — the first runs 10 minutes after the server starts" until the
  install is 36 h old, then amber; doctor shows `ℹ` (info, does not count as a warning) for an install seeded under
  24 h ago, else `▲`. `LM_BACKUP=0` always makes the doctor line a warning.
- Schedule off (`backup.enabled === false`): Settings promises nothing. The header reads "Automatic backups are off on
  this server." with an amber **Off** badge (instead of **Up to date**), an amber box says "Automatic backups are off
  (LM_BACKUP=0)" and points at `npm run backup` (or starting again without `LM_BACKUP=0`), and "None yet" says "run npm
  run backup on the laptop". Past 36 h the box also carries the copy-off-the-laptop line.
- Disk: free space (`fs.statfsSync`) on the backup folder's disk under **1 GB** → `▲`.
- Service: the installed plist/unit runs a Node that no longer exists, or a different one from this terminal → `▲`
  ("run npm run service:install again"). With the service installed and answering, the doctor's port check passes
  ("held by Linear Hub running as the background service") instead of failing.

**Service files** (`server/src/service.ts`)
- Label `uk.co.linear-mcr.hub`; `ProgramArguments [node, <abs>/server/src/index.ts]`; `WorkingDirectory server/`;
  `EnvironmentVariables` `TZ=Europe/London`, `NODE_ENV=production`, `NODE_NO_WARNINGS=1`, plus when set: `PORT`,
  `HOST`, `DB_PATH`, `LM_APP_SECRET_FILE`, `LM_BACKUP`, `LM_BACKUP_DIR`, `LM_BACKUP_HOUR`, `TRUST_PROXY`, `LM_SMART`,
  `LM_COMPRESSION` (relative paths resolved from `server/`, as `npm start` resolves them). `LM_APP_SECRET` is never
  written into the file (it would sit there in plain text): install warns and suggests `LM_APP_SECRET_FILE`.
- `node` is `process.execPath`, except a Homebrew Cellar path (deleted by the next `brew upgrade`) becomes its stable
  `<prefix>/opt/node/bin/node` link when that link points at the same binary.
- Install (macOS): refuse without `client/dist/index.html` ("run npm run build first") → `bootout` an earlier install
  → run `src/stop.ts` for a terminal copy (abort if the port is held by something else) → write the plist and create
  the log folder → `launchctl enable`, `bootstrap gui/<uid>` (fallback `load -w`) → wait up to 20 s for `/api/health`.
- Uninstall: `bootout` (fallback `unload -w`), delete the plist, wait for the port to free. Status: `launchctl print`
  (state, pid, last exit code, runs), health, Node check, last 20 log lines.
- Linux unit: values quoted for systemd: `\` and `"` escaped and `%` → `%%` everywhere; `$` → `$$` only in
  `ExecStart=` (which expands `$VAR`), never in `Environment=` (where `$` has no special meaning, so doubling it would
  leave a literal `$$` in the value); `WorkingDirectory=` escapes `%` only. `Restart=always`, `RestartSec=2`,
  `WantedBy=default.target`. `systemd-analyze verify` accepts the printed unit.
- macOS privacy (TCC): install (and `--print`, as a `# warning:` line) and status warn when the checkout, `DB_PATH`,
  `LM_BACKUP_DIR` or `LM_APP_SECRET_FILE` resolves (as written or through links, ignoring case) into `~/Desktop`,
  `~/Documents`, `~/Downloads` or `~/Library/Mobile Documents` (iCloud Drive). Install still goes ahead.
- Windows: the printed `.cmd` runs `if not exist "%LOCALAPPDATA%\LinearHub" mkdir "%LOCALAPPDATA%\LinearHub"`
  before the `node … >> "%LOCALAPPDATA%\LinearHub\linear-hub.log" 2>&1` line (cmd.exe cannot redirect into a missing
  folder, and the task would never start Node).

**Release checks still to run on the owner's Mac** (macOS cannot run in CI; only the `--print` plist has been checked:
it parses with `plistlib`, `KeepAlive`/`RunAtLoad` true, the environment and log path as above):
1. From a checkout outside Desktop/Documents/Downloads/iCloud: `npm run build && npm run service:install`, then
   `launchctl list | grep uk.co.linear-mcr.hub` and `curl http://localhost:4000/api/health`.
2. `kill -9 <pid>` (from `npm run service:status`): a new pid answers within 10 s.
3. `npm run service:uninstall`: port 4000 is free (`lsof -iTCP:4000 -sTCP:LISTEN` prints nothing).
4. `npm run backup && npm run backups`; delete a gauge, `npm run service:uninstall`, `npm run restore -- <file> --yes`,
   `npm run service:install`: the gauge is back.

**Compression** (`server/src/lib/compress.ts`, mounted first in `app.ts` after the security headers)
- The body is collected and compressed in one piece, so `Content-Length` is exact; bodies up to 16 KB are compressed
  synchronously, larger ones on the libuv thread pool.
- Compressed bytes are remembered in two small LRUs keyed by encoding, path and ETag: immutable `/assets/*` bundles
  (64 entries / 12 MB) and everything else with an ETag (512 entries / 4 MB). Express derives an API ETag from a SHA-1 of
  the exact body and static files from size + mtime, so an equal key means equal bytes: a response-cache replay or the
  same JSON fetched again is not compressed twice, and nobody can be sent bytes other than the ones the route produced
  for them. Nothing is precompressed at build time.
- Why gzip for browsers: brotli at the specified quality 4 is no smaller than gzip 6 here and costs more CPU.

| Payload | identity | gzip 6 | brotli q4 | brotli q5 | brotli q11 |
|---|---|---|---|---|---|
| main bundle `index-*.js` | 449,053 B | **138,725 B** (12 ms) | 139,823 B (9 ms) | 131,140 B (17 ms) | 118,790 B (1,037 ms) |
| SPA shell `/` | 2,112 B | **908 B** | 833 B | 767 B | 678 B |
| rep `/me/dashboard?range=month` | 9,919 B | **2,813 B** (0.18 ms) | 2,767 B (0.30 ms) | 2,620 B | 2,257 B |

**Measured on the wire** (same build, seeded database, `Accept-Encoding: gzip, deflate, br, zstd` as Chrome sends):

| Request | Before | After | Saved |
|---|---|---|---|
| `/` (SPA shell) | 2,112 B | 908 B | 57% |
| main JS bundle (`/assets/index-*.js`) | 449,035 B | 138,725 B | 69% |
| `/api/me/dashboard?range=week` (admin) | 6,302 B | 2,250 B | 64% |

**Load test** (`server/loadtest/mix.mjs`, 50 connections, 20 s, 4 vCPU sandbox; the load generator runs on the same
machine and Node's `fetch` asks for gzip, so it now also decompresses every response):
- Before this package: 869 req/s, 0 errors.
- Same build, alternating runs, `LM_COMPRESSION=0` v on: 854 / 905 req/s off, 825 / 824 req/s on; 0 errors in every
  run; smoke 82/82.
- A CPU profile of the server under that load puts compression-specific work (negotiation, zlib, the LRUs) at **2%** of
  its busy time; the rest of the gap is the single-threaded load generator gunzipping (its CPU went from 60% to 86% of a
  core). Over the hotspot the 57–69% fewer bytes are what the phones feel.

## User guide

### Backups and running in the background (administrators)

**Settings › Backups** (only the owner and other administrators see this card) shows:

- **Last backup** — how long ago, and the date and time. A green **Up to date** badge means there is one from the last
  36 hours.
- **Kept** — how many copies there are. Linear Hub keeps one a day for 30 days, then one a week for 8 weeks.
- **Latest file** and **Folder on the server laptop**, with a **Copy path** button.

If there has been no backup for more than 36 hours the card turns amber (**No backup for 3 days**). Backups only
happen while Linear Hub is running: leave it running overnight, or on the laptop run `npm run backup`. Either way,
copy the backups folder to iCloud or Drive now and then — a backup on the same laptop does not survive losing it.

If the server was started with automatic backups switched off (`LM_BACKUP=0`), the card says so with an amber **Off**
badge and does not promise nightly copies: run `npm run backup` on the laptop yourself, or start Linear Hub again
without `LM_BACKUP=0`.

The backups folder is a full copy of everyone's details, pay and the two-step key: keep it private, never commit it to
git or share it.

To go back to a backup (for example after a mistake that deleted the wrong entries): on the laptop, stop the server
(`npm run stop`, or `npm run service:uninstall` if it runs in the background) and run
`npm run restore -- <file name>`. It shows what will change and asks first; the database it replaces is kept, so you
can change your mind.

To keep Linear Hub running without a Terminal window — so phones on the hotspot keep working and it starts by itself
when you log in — run `npm run service:install` once on the laptop. `npm run service:status` says whether it is
running; `npm run service:uninstall` stops it.

Everyone else sees no change. Pages also load faster over the hotspot: the server now sends compressed pages and data
(about a third of the bytes it sent before).
