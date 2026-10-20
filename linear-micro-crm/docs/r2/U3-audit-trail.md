# U3 audit-trail: who changed what, and announcement read receipts

Every successful change made through Linear Hub is written to an audit log: who, when, which record, a readable
sentence ("Marked paid: Jordan Lee w/c 5 Oct, £945") and, for the records that matter, the record before and after so
the field-level difference can be shown. Admins read it on the new **Audit** page; a **History** section on the payslip
and on an open gauge entry shows one record's trail. Announcements now record who has read them, and the author and
admins see "Read by 18 of 34".

## API

All routes are behind `requireAuth` (anonymous → 401). Types: `shared/src/types/audit.ts`. None is in the response
cache (they are admin views or per-author lists, and any write clears the cache anyway).

### `GET /audit` (admin; everyone else 403) → `AuditPage`

`{ rows: AuditEntryDetail[], total }`, newest first (`at DESC, id DESC`). Query parameters, all optional:

| Param | Meaning |
| --- | --- |
| `userId` | Only rows made by this person. |
| `entity` | One of `payroll_run`, `gauge_entry`, `user`, `candidate`, `event`, `campaign`, `pitch`, `settings`, `announcement`, `expense`, `learning`, `check_in` (400 otherwise). |
| `entityId` | Only rows about this record (use with `entity`). |
| `from`, `to` | `YYYY-MM-DD`, inclusive London calendar days (`from` after `to` → 400). |
| `q` | Words in the summary, case-insensitive; `%` and `_` are literal. Up to 100 characters. |
| `signIns` | `0` leaves out sign-ins and sign-outs (`POST /auth/login`, `/auth/login/2fa`, `/auth/logout`); `1` or absent keeps them. Anything else → 400. |
| `limit`, `offset` | Paging: `limit` 1–200 (default 50; 0 or negative → 400), `offset` ≥ 0. `total` counts every matching row. |

`AuditEntryDetail`: `id`, `at` (UTC ISO, real clock), `userId`, `userName` (null for a row without a person),
`action` (method and route pattern, e.g. `POST /finance/payroll/:id/pay`), `entity` and `entityId` (null for routes
the registry does not describe), `summary`, `ip` (admins only, null for anyone else), `before` and `after` (the stored
snapshots, or null) and `diff` (`AuditFieldChange[]`, computed when read by the shared `auditDiff`).

### `GET /audit/:entity/:entityId` → `AuditEntryDetail[]`

The newest 100 rows about one record. Admin: any entity. Leader: `gauge_entry` only, and only entries of a person on
their own team or their own entries (a deleted entry is judged by the person in its last snapshot); anything else 403.
Reps and recruiters 403. Unknown entity or non-numeric id → 400. `ip` is null for leaders. An id with no rows → `[]`.

### `POST /announcements/:id/read` → 204

Marks the announcement read by the caller. Idempotent: the first read time is kept. 404 for an unknown announcement,
400 for a non-numeric id. Any signed-in role. Read receipts are not audit rows (they have their own table).

### `GET /announcements/reads[?ids=1,2,3]` → `AnnouncementReadStats[]`

Admins get every announcement, everyone else only the ones they wrote (a rep gets `[]`). Without `ids`: the 50 newest,
pinned first, the order the dashboard lists them; with `ids` (up to 100, positive integers, else 400) only those.
Each item: `announcementId`, `readCount`, `audience`, and `readers` (`{ userId, name, readAt }`, newest read first).
Names are always included because only the author and admins ever receive a row. Two queries in all.

### Recording (no new endpoint)

`auditMiddleware(db)` (`server/src/lib/audit.ts`) sits on the `/api` router after `authenticate` and the PIN gate.
For every `POST`, `PUT`, `PATCH` and `DELETE` that is answered 2xx it writes one row (more for gauge writes, see
Logic). Reads (`GET`, `HEAD`, `OPTIONS`) pass straight through, so read throughput is unchanged. Failed requests
(4xx, 5xx) write nothing. An audit failure is logged to the console and never changes the response.
`recordAudit(db, entry)` writes an explicit row (e.g. from a maintenance job). Route files were not edited.

## Logic

### What is recorded

- **Every successful write**: when (`at`, the real clock, not the business clock: an audit row says when it really
  happened), who (the signed-in person; for a sign-in, the person who has just signed in), the method and Express
  route pattern, the IP, and a summary. Routes the registry does not describe are recorded with the action as the
  summary (`POST /things/:id/zap`) and no snapshots.
- **Registered routes** (`server/src/lib/auditSpecs.ts`) load a "before" snapshot just before the handler runs and an
  "after" snapshot at the moment the response is sent (synchronously, so nothing can slip in between):

| Entity | Routes | Summary, for example |
| --- | --- | --- |
| Pay run | `POST /finance/payroll/:id/pay` | Marked paid: Jordan Lee w/c 5 Oct, £945 (· "Marked paid (late)" when the money landed after the due date) |
| Pay run (side effect) | any gauge write | Recalculated after a gauge change: Jordan Lee w/c 12 Oct, £675 → £795 · Pay run created / removed after a gauge change · Adjusted after payment: Jordan Lee w/c 5 Oct, paid £945; the gauges changed |
| Gauge entry | `POST /gauges` (create or edit), `PATCH /gauges/:id`, `DELETE /gauges/:id`, `POST /gauges/bulk` (one row per entry created or changed) | Logged gauges: Jordan Lee, 15 Oct at Arndale, 2 sales · Edited gauges: …: taps 2 → 3, sales 2 → 3 · Deleted gauges: … (3 sales) · Logged gauges in bulk: … |
| Person | `POST /users`, `PATCH /users/:id`, `POST /users/:id/2fa/reset`, `POST /auth/pin/reset/:userId`, sign-in, sign-out, the caller's own two-step and PIN changes | Added Sam Brown: Representative, Trainee, Team North · Updated Daisy Holt: position trainee → field rep · Deactivated Rita Rep · Reactivated … · Reset two-step verification: … · Reset PIN: … · Signed in · Signed out · Turned on two-step verification · Set a PIN |
| Candidate | `POST /recruitment/candidates`, `PATCH …/:id`, `POST …/:id/stage` (a hire also records the new person), `POST /recruitment/interviews`, `PATCH /recruitment/interviews/:id` (filed under the candidate) | Moved Elliot Bradley: Applied → Phone screen · Booked first interview: Sam Brown, 21 Oct, 14:00 |
| Event | `POST /events`, `PATCH /events/:id`, `DELETE /events/:id` | Updated event: Castlefield Bowl, 21 Oct: target 14 → 16 · Cancelled event: … · Restored event: … |
| Campaign | `POST /campaigns`, `PATCH /campaigns/:id` | Updated campaign Breast Cancer Now (BCN): payout per sale £120 → £130 |
| Pitch | `PUT /pitches/:campaignCode` (entity id = the campaign's id) | Wrote the BCN pitch · Edited the BCN pitch: text |
| Settings | `PUT /auth/security-settings` | Changed sign-in settings: require a PIN for everyone no → yes |
| Announcement | `POST /announcements` | Posted announcement: “Saturday rota is up” |
| Expense | `POST /finance/expenses`, `DELETE /finance/expenses/:id` | Added expense: £42.60 travel, 20 Oct |
| Learning | `POST /learning/progress/:lessonKey/quiz`, `…/teachback`, `…/:userId/:lessonKey/signoff` (entity id = the learner) | Learned Feel felt found: self-check passed · Signed off a teach-back: Jordan Lee, Bullet theory |
| Check-in | `POST /checkins`, `DELETE /checkins/:id` | Checked in: Jordan Lee at Arndale, 20 Oct 09:24 · Removed check-in: … |

- **Pay runs moved by a gauge write.** Before the handler, the trail notes everyone whose run the entry can move (the
  same rule as `affectedPayUsers`: the person, override earners on their team, no-team seniors who logged at the same
  event, for the old and the new key when an entry is moved) and their runs for the weeks concerned, in two queries.
  Afterwards it reloads those runs and writes a pay-run row for each one that changed: recalculated (gross changed, or
  other figures with the gross the same), created, removed, or flagged "adjusted after payment" (a paid run whose
  `adjustedAt` was set by an admin's change). So a payslip's history explains every change to its figures.
- Snapshots carry readable names next to ids (`userName` with `userId`). Tables of other 1.2 packages
  (`campaign_pitches`, `learning_progress`, `check_ins`, `users.pin_hash`) are read defensively: until they exist the
  snapshot is empty and the row is still written.
- **Settings** have no stored "before" of their own: the before of a change is what the last recorded settings change
  left, or the documented defaults (PIN not required, two-step for administrators not required, 12 hours) for the
  first one.
- **Not recorded**: reads, failed requests, step one of a two-step sign-in (no session yet), and announcement read
  receipts (their own table).

### Secrets never stored

Request bodies and responses are never stored, only snapshots the registry loads itself, and those never select
PINs, PIN hashes, two-step secrets, recovery codes or session tokens. As a second guard every snapshot is redacted
before storage (shared `redactAuditSnapshot`): any key, at any depth, named `pin`, `currentPin`, `newPin`, `pinHash`,
`pin_hash`, `pinSalt`, `password`, `token`, `sessionToken`, `challengeToken`, `secret`, `totp_secret_enc`,
`totp_pending_enc`, `code`, `recoveryCode(s)`, `code_hash`, `otpauthUrl`, `qrDataUrl`, `manualKey`, or containing
`secret`, `password`, `token`, `pinhash`, `pin_hash` or `recovery`, is stored as `[redacted]`. (A campaign's code is
therefore stored as `campaignCode`.) A snapshot larger than 64,000 characters is replaced by a short note; summaries
are capped at 500 characters.

### The diff

`auditDiff(before, after)` (shared, pure): the fields whose values differ, compared as JSON for nested values; empty
and `''` count as null; a create lists every filled field, a delete every field it had. The record's `id` and the
reference ids that travel with a name (`userId`, `eventId`, `teamId`, `campaignId`, `payPlanId`, `ownerId`,
`referredById`, `interviewerId`, `candidateId`, `hiredUserId`, `authorId`, `signedOffById`) are never listed, so a move
shows once, as names; `employeeId` is a value and is listed. Summaries name at most three changes ("… and 2 more");
long text fields are named, not quoted. Values read the British way: £945 / £412.50, 12 Oct, wall-clock check-ins
"12 Oct 09:24", zoned times in London time, enums as words ("field rep").

### Read receipts

- The dashboard reports an announcement as read once at least half of its card has been on screen for 1.2 seconds;
  never for the author's own announcement. Several cards are sent together, then the stats refresh once. Each
  person's reported ids are remembered on the device (`localStorage` `lm-announcement-reads:<userId>`, newest 200; a
  blocked store only means a harmless repeat), so a visit does not post again.
- **Audience** = everyone whose status is `active`, except the author. **Read count** = reads by people in that
  audience (a reader who has since left or gone on leave no longer counts; the author's own read never counts).
- The demo seed marks a plausible share of the active people as having read each seeded announcement (35% just after
  posting, rising to 90% after a week, at times between the post and now; its own random stream, so the core demo
  data is unchanged). An existing database starts with no reads.

### Retention

`purgeAuditLog` deletes rows older than 730 days (two years, real clock) at start-up and every 24 hours
(`index.ts`). Read receipts live as long as their announcement.

### Database (`server/src/db/extensions/audit.ts`)

- `audit_log(id, at, user_id, action, entity, entity_id, summary, before_json, after_json, ip)`, indexed on `at`,
  `(user_id, at)` and `(entity, entity_id, at)`. No foreign key on `user_id`, so a row outlives anything.
- `announcement_reads(announcement_id, user_id, read_at, PRIMARY KEY (announcement_id, user_id))`, cascading with the
  announcement and the person; indexed on `user_id`.
- `upgrade` has no data steps (returns `[]`); `seed` writes `announcement_reads` only.

### Performance

Reads are untouched (the middleware returns at once for `GET`). A write costs one or two snapshot queries before the
handler and one to three after it, plus one insert per row; a gauge write adds two queries for the pay runs. `GET
/audit` is two queries (count and page), `GET /announcements/reads` two.

## User guide

### Administrators

- **Audit** (sidebar, under Manage) lists every change, newest first, grouped by day: who made it, at what time, a
  sentence saying what happened and a tag for the kind of record. Tap a row to see exactly which fields changed, with
  the old value struck through and the new one beside it, plus the route and the IP address it came from.
- Narrow the list with **Search** (words in the sentence, e.g. "marked paid" or a name), **Person**, **Record** (pay
  run, gauge entry, person, candidate …) and **From** / **To** dates. **Show sign-ins** adds sign-ins and sign-outs,
  which are hidden by default so the page is about changes. **Clear filters** starts again. **Newer** and **Older** move
  through the pages, 50 changes at a time. The filters are part of the page address, so a view can be bookmarked.
- On a payslip (Finance → open a pay run) the **History** section at the bottom lists that run's changes: marked paid,
  recalculated after a gauge change (with the old and new gross), adjusted after payment. **Open in the audit trail**
  shows the same rows on the Audit page. An open gauge entry has the same **History** section.
- Under each announcement on the dashboard, **Read by 27 of 28** shows how many active people have read it; tap it to
  see their names.

### Leaders

- When you open one of your team's gauge entries to edit it (event page → **Edit**), the **History** section under the
  form shows who logged or changed it, when, and what changed. You do not see the IP address, pay runs or anyone
  else's records.
- Under announcements you wrote, **Read by 12 of 33** shows how many active people have read it, and tapping it shows
  who. You do not see these figures for other people's announcements.

### Reps and recruiters

- Nothing new to do. When an announcement has been on your screen for a moment it counts as read, so whoever posted
  it knows it reached you. You do not see who else has read it, and there is no Audit page or History section for you.
