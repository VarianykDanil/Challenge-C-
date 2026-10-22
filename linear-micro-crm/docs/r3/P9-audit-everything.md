# P9 audit-everything

Every action on the platform is recorded — changes, sign-ins and failed attempts, exports, opened records, client-portal
actions and automatic steps — and Matt can see every one: on the Audit page (**Everything** by default, or one kind at a
time) and, per person, in Team → person → **Activity**.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P9 audit-everything**.

## API

All routes are behind `requireAuth` (anonymous → 401). A client portal session gets 403 `clientPortalOnly` from the
client guard on every one of them. Types: `shared/src/types/audit.ts`.

### `POST /audit/events` → 204 (any staff role)

What a page reports itself: an export it built, or a sensitive record it opened (`ClientAuditEventInput`).

| Field | Rule |
| --- | --- |
| `kind` | `export` or `opened`; anything else → 400 |
| `what` | required text; control characters and runs of spaces become one space; cut at 80 characters (`"gauges-by-team"`, `"candidate profile"`, `"invoice LM-SB-2026-000123"`, `"audit trail"`) |
| `format` | exports: `csv`, `pdf`, `xero`, `sage`, `print` (optional; anything else → 400) |
| `rows` | exports: a whole number 0–1,000,000 (optional; anything else → 400) |
| `filename` | exports: the file's name, cut at 120 characters; a path keeps its last part only (optional) |
| `entity`, `entityId` | an `AuditEntity` and a positive id. **Opened**: the record; leave both out (or `null`) for the audit trail itself. **Export**: an export of ONE record — P7's candidate profile and interview sheet PDFs (`candidate`), P2's invoice PDF and print (`invoice`); leave both out (or `null`, or `export`) for an export of a table |

Unknown keys are dropped, not refused (a newer page reporting an extra detail still gets its event recorded).
An opened record **and an export of a record** are checked against the rule of the record's own page: a candidate —
admin, leader, recruiter (`GET /recruitment/candidates/:id`); a pay run — admin, the person, their team's leader
(`GET /finance/payroll/:id`); an invoice — the same rule through its pay run; the audit trail — administrators; any
other record — administrators. Not allowed → **403** "You cannot open that record"; no such record, or an entity
without its id → **404**. The row keeps the record (entity and id) and names it:

| Report | Summary |
| --- | --- |
| P7 `{kind:'export', format:'pdf', what:'candidate profile', entity:'candidate', entityId}` | "Exported the candidate profile as PDF: Mia Parker" |
| P7 interview sheet (`what:'interview sheet'`) | "Exported the interview sheet as PDF: Mia Parker" |
| P2 `{kind:'export', format:'pdf', what:'invoice LM-SB-2026-000123', entity:'invoice', entityId}` | "Exported the invoice LM-SB-2026-000123 as PDF: Jordan Lee w/c 12 Oct" |
| P2 print (`format:'print'`) | "Printed the invoice LM-SB-2026-000123: Jordan Lee w/c 12 Oct" |
| P3 (server side, `recordClientEvent` with the label "BCN 5–11 Oct 2026") | "Exported the BCN statement for 5–11 Oct 2026 as PDF" (a `what` that names the record already is not followed by the name again) |
| a table (P4, no record) | "Exported Gauges by team as CSV: 124 rows" (entity `export`, as before) |

So an export of a record shows under the Record filter (`GET /audit?entity=candidate&entityId=…`) and a name search
finds it; the record's History panel still lists its changes only. The same person opening the same record again
within 5 minutes (`AUDIT_OPENED_REPEAT_MINUTES`; `what` compared without case, so "Candidate Profile" and "candidate
profile" are one opening) answers 204 and adds no row. Exports are never merged: each is a file.

Rate limit: at most `AUDIT_EVENTS_PER_MINUTE` (60) reports per person per minute, on a counter of its own
(`middleware/writeLimit.ts`); the next one is **429** "That is more than 60 exports and opened records in a minute.
Wait a minute, then try again." with `Retry-After: 60`. A refused report does not count and is not recorded. The 1.2
write limit (learning, pitches, check-ins, PINs, bulk gauges) keeps its own 60. `writeLimitPerMinute: 0` (createApp)
turns both off; `auditEventsPerMinute: 0` (perUserWriteLimit) only this one.

The audit middleware skips this route (`lib/audit/auditEventSpecs.ts` `skip: true`): the route writes its own row, so
there is never a second, generic `POST /audit/events` row.

### `GET /audit` (admin) — new parameters

| Param | Meaning |
| --- | --- |
| `kind` | One `AuditEventKind` (`change`, `sign_in`, `export`, `opened`, `automatic`, `client`) or a comma list (`kind=export,opened`); an empty value is no filter; any other value → 400. |
| `view` | `everything` (the default) or `changes` (= `kind=change`, the 1.2 view). Anything else → 400; `view=changes` together with `kind` → 400. |
| `entity` | Now also takes the 1.3 entities (`campaign_rate`, `pay_adjustment`, `invoice`, `agreement`, `statement`, `video`, `client_post`, `client_account`, `interview_question`, `event_roster`, `export`). |

`signIns=0` keeps working exactly as before (it leaves out the three sign-in actions). Every row now carries
`kind: AuditEventKind` and `userRole` (the role of the person who acted; `null` for "Linear Hub" and an unknown person).
Both are new optional fields; nothing was renamed or removed.

### `GET /audit/people` (admin) → `AuditPerson[]`

Everyone the trail can name, for the Audit page's Person filter: `{ id, name, role, status }` for every user, staff
and client accounts, any status, by name — no employee IDs or client access codes (the page never shows them; review
fix: `employeeId` was dropped before any other package used it). (`GET /users` leaves client accounts out, so it cannot serve this
filter any more.) Leader, recruiter, rep → 403.

### `GET /audit/person/:userId?kind=&view=&limit=&offset=` (admin) → `AuditPersonActivity`

Team → person → Activity: `{ person: AuditPerson, rows, total, lastSignInAt, lastActiveAt, failedSignIns }` — the rows
**made by** that person (their own changes, sign-ins, exports and openings, plus the failed attempts on their account,
which are filed under it), newest first, paged like `GET /audit` (limit 1–200, default 50). `lastSignInAt` is their
latest successful sign-in, `lastActiveAt` their latest row **not counting failed tries on the sign-in page** (those are
filed under the account but may be somebody else's: shared `isAuditAttemptOnAccount`), `failedSignIns` the failed
sign-ins, wrong PINs and wrong two-step codes on their account in the last 30 days. Unknown person → 404, bad id or kind → 400; leader,
recruiter, rep (their own included) → 403. Registered before `/audit/:entity/:entityId`, which would otherwise read
"person" as an entity. Two indexed queries plus the count.

### `GET /audit/:entity/:entityId` — new parameter

`kind=` (and `view=`) as on `GET /audit`. The History panels (payslip, gauge entry) ask for
`kind=change,automatic,client`, so "Opened the payslip" never reads as a change of it.

### What the recorder writes now (no new endpoint)

- **Failed attempts** (kind `sign_in`, filed under the account the email or the challenge belongs to; never the PIN,
  the employee ID typed, the code or the challenge token):

| Route | Answer | Summary |
| --- | --- | --- |
| `POST /auth/login` | 401 | "Failed sign-in: wrong employee ID" · "Failed sign-in: the account is deactivated" · "Failed sign-in with an unknown email: jo@example.com" (no person; the email typed is kept only when it is an email — the Login page's test — so "Failed sign-in with an unknown email" and `typedEmail: null` for an employee ID typed into the email box) · "Failed sign-in: wrong PIN (4 tries left before a lock)" |
| `POST /auth/login` | 423 | "PIN locked after 10 wrong PINs in a row, until 14:35" (this try started the lock) · "Sign-in refused: the PIN is locked until 14:35" |
| `POST /auth/login`, `/auth/login/2fa` | 429 | "Sign-in refused: too many attempts, try again in 12 minutes" |
| `POST /auth/login/2fa` | 401 / 410 | "Failed sign-in: wrong two-step code" · "Sign-in stopped: too many wrong two-step codes" · "Sign-in stopped: the two-step code was not entered within 5 minutes" (an unknown challenge writes nothing) |
| `POST /auth/pin`, `/auth/pin/remove` | 400 / 423 / 429 | "Wrong current PIN while changing their PIN" · "… while removing their PIN" · "PIN locked after wrong current PINs while changing their PIN, until 14:35" |
| `POST /auth/2fa/enable`, `/disable`, `/recovery-codes` | 400 / 429 | "Wrong two-step code while turning on two-step verification" · "… turning off …" · "… making new recovery codes" |

  Every row's snapshot has a `reason` (shared `AUDIT_SIGN_IN_REASONS`: `wrong_employee_id`, `deactivated`,
  `unknown_email`, `wrong_pin`, `pin_locked_now`, `pin_locked`, `too_many_attempts`, `wrong_code`, `too_many_codes`,
  `challenge_expired`, `wrong_current_pin`), which the trail says in words (`AUDIT_SIGN_IN_REASON_LABELS`).
  Validation answers (a missing field, a PIN that breaks the rules) and step one of a sign-in (the PIN or two-step
  challenge) write nothing. **The failure budget**, per 15 minutes (`FAILED_ROWS_*` in `lib/audit.ts`):
  - 30 rows per address, for tries from the sign-in page (a signed-in person's own wrong PIN or code counts against
    their account instead);
  - 30 rows per account a try is filed under — every real account has room of its own, so a flood of made-up emails
    from many addresses can never use up the room for a try on Matt's account;
  - 600 rows in all for emails nobody has.

  The row that reaches a cap is followed by one that says so (no person): "Stopped recording failed sign-ins from
  203.0.113.7 after 30 in 15 minutes; recording starts again within 15 minutes" · "… on Jordan Lee's account after 30
  in 15 minutes; …" (filed under that account) · "… with unknown emails after 600 in 15 minutes from many addresses;
  …". Worst case per 15 minutes: 600 + 30 × the accounts tried. Successful sign-ins are never held back.
- **New 1.2 specs** (found by the coverage test): `POST /auth/pin/remove` → "Removed their PIN" (was a bare route
  name); `PUT /learning/milestones/:userId/:key` → "Updated a progression milestone for Jordan Lee: “Trained 3
  personalities” 2 → 3" (a save of the same value writes nothing).
- **Exports and openings**: action `EVENT export` / `EVENT opened` (see `POST /audit/events`); an export is filed
  under the record it is of, or under entity `export` for a table.
- **Automatic steps**: `recordSystemEvent` rows (action `SYSTEM <name>`) are kind `automatic`.
- **The payroll export** (`GET /finance/payroll/export`, Xero / Sage CSV; its own route writes the row) is kind
  `export` — classified in P9's code, neither file edited.

## Logic

### Kinds

`audit_log.kind` (new column, indexed with `at`) is one of `change`, `sign_in`, `export`, `opened`, `automatic`,
`client`. A row's kind is what the writer says (failed attempts say `sign_in`; client events `export` / `opened`;
system events `automatic`), else shared `auditKindOf(action, actorRole)`, in this order:

1. `SYSTEM …` → automatic
2. `EVENT export` or `GET /finance/payroll/export` → export
3. `EVENT opened` → opened
4. `POST /auth/login`, `POST /auth/login/2fa`, `POST /auth/logout` → sign_in (a client account's sign-in too)
5. anything a client account did, or a write to `/client` or `/client/…` → client (e.g. a client setting their PIN on
   Security, posting an update)
6. everything else → change (the office approving a client post is an office change)

`db/extensions/audit.ts` adds the column to a 1.2 database and classifies its rows once by the same rules in SQL
(`KIND_CASE`; a test holds the SQL and `auditKindOf` equal for every action the app writes). It runs on every start but
only touches rows whose kind is still NULL, so a second start reports nothing. A 1.2 database's rows come out as
`sign_in` (sign-ins and sign-outs), `export` (the payroll exports) and `change` (everything else).

### The coverage test (`server/src/test/audit-coverage.test.ts`)

Every POST, PUT, PATCH and DELETE route the app mounts (`lib/routeTable.ts listApiRoutes`) must be matched by an audit
spec **of its own pattern** (a spec of another route catching it first fails: list literal paths before `:param`
ones). A route still answering 501 for every role is a 1.3 stub whose package has not landed: it writes nothing, so it
needs no spec yet, and the test lists it as a diagnostic; the moment it answers anything else, the test fails until its
package registers a spec. Only routes without a spec are probed (made-up id, empty body), so a merged release probes
nothing. Also: every spec names a route that exists with the same method; a pattern has at most two specs (a package
refining a 1.2 spec); and the only skips are read receipts — of one record (`POST /…/:id/read`, e.g. POST
/announcements/:id/read) or a batch (`POST /…/read`, e.g. P6's POST /client-posts/read) — and `POST /audit/events`.
(Review fix: the batch form was missing, which turned `npm test` red once P6 merged; checked on a P9 + P6 merge.)

At this commit 41 write routes are 1.3 stubs (P1, P2, P3, P5, P6, P7, P8). Each of those packages has written its specs
on its own branch; after the merge the test checks them all.

### Opened records

`features/audit/RecordOpened.tsx` reports `{ kind: 'opened', what, entity, entityId }` once per mount and record (not
for a client account or while signed out). The server checks access, names the record ("Opened the candidate profile:
Sam Brown", "Opened the payslip: Jordan Lee w/c 12 Oct", "Opened the invoice LM-SB-2026-000123: Jordan Lee w/c 12 Oct",
"Opened the audit trail") and keeps one row per person and record in any 5 minutes (one indexed lookup on
`user_id, at`; `what` compared without case), so React's development double mount or a page re-rendering adds nothing. Team → person → Activity is not
itself recorded (a summary on a person's page); opening the audit trail is.

### Exports

A table's export, shared `auditExportSummary`: "Exported Gauges by team as CSV: 124 rows", "Exported Leaderboard as
PDF" (no count sent), "Printed Payslip". `auditWhatLabel` turns the page's slug or file name into words
("linear-hub-leaderboard-2026-10-21.csv" → "Linear hub leaderboard"). An export of one record, server
`recordExportSummary`: "Exported the candidate profile as PDF: Mia Parker", "Printed the invoice LM-SB-2026-000123:
Jordan Lee w/c 12 Oct", with a count "… as CSV: Mia Parker (12 rows)"; the name is left out when the `what` names the
record already. The snapshot keeps `what`, `format`, `rows` and `filename`, and `record` (its name) for a record.

### How a row reads

- A failed try on the sign-in page (shared `isAuditAttemptOnAccount`: kind `sign_in`, a `reason`, action
  `POST /auth/login` or `/auth/login/2fa`) is filed under the account it was tried on, but it is not shown as
  something that person did: the Audit page says **"Attempt on Jordan Lee's account"** beside a shield (not his
  avatar), Team → person → Activity says **"Attempt on this account"**, and "Last active" leaves it out. A wrong current
  PIN or code in Settings is the signed-in person's own and keeps their name.
- Once opened, a sign-in or failed attempt, an export or an opened record shows its details as facts (shared `auditFacts`):
  "Reason: Wrong PIN", "Tries left: 8", "Format: PDF", "Record: Mia Parker" — not as a "— → wrong pin" change, and
  without a "2 fields" count. Changes, automatic steps and client-portal actions keep the before → after table.

### Performance

The INSERT is now prepared once per database (`WeakMap<Db, StatementSync>`) instead of on every row, which more than
pays for the new column: 10,000 `recordAudit` calls take **21.5 µs each, down from 25.6 µs** (median of 5 runs).

Burst benchmark (`server/src/test/audit-burst.bench.ts`, not part of `npm test`): the in-memory test server, 1,000
requests per burst, 10 at a time; median of 3 runs on the same machine, the foundation commit (before) against this one
(after):

| Burst of 1,000 | Before | After | Audit rows after |
| --- | --- | --- | --- |
| Audited writes, `PATCH /gauges/:id` | 3,398 ms | 3,340 ms | 1,000 (as before) |
| Trail reads, `GET /audit?limit=50` | 2,996 ms | 3,003 ms | 0 |
| Failed sign-ins, 1,000 unknown emails | 1,185 ms | 1,105 ms | 31 (30, then the pause row; before: 0) |
| Page reports, `POST /audit/events` from 6 people | 992 ms | 1,094 ms | 360 (60 a person, then 429; before: a no-op) |

Writes and reads are unchanged within noise. The new rows cost about 0.1 ms per request; a flood never writes more than
the failure budget and the per-person report limit allow. Retention is unchanged (two years, `purgeAuditLog`).

## User guide

### Audit (administrators)

**Audit** now lists **everything** done in Linear Hub, newest first, under the day it happened:

- **Changes** — pay, gauges, people, events, campaigns, announcements, settings and every 1.3 record (as in 1.2).
- **Sign-ins** — every sign-in and sign-out, and every failed attempt in red: a wrong employee ID, a wrong PIN ("8 tries
  left before a lock"), a locked PIN, a wrong two-step code, an email nobody has ("Unknown person"). A failed try on
  someone's account reads "Attempt on Jordan Lee's account": whoever typed it may not have been Jordan.
- **Exports** — every CSV or PDF someone downloaded, with how many rows, and every Xero / Sage payroll export. A
  download of one record names it ("Exported the candidate profile as PDF: Mia Parker") and shows when you filter by
  that record or search for the name.
- **Opened** — who opened a candidate's profile, a payslip or invoice, or the audit trail itself.
- **Automatic** — what Linear Hub did by itself (statements fetched from Gmail and applied, invoices issued and deemed
  accepted), shown as "Linear Hub".
- **Client portal** — what a client account did (their updates, announcements and commission changes, setting their
  PIN).

Tap a chip at the top to see one kind; **Everything** shows them all. **Changes** is the view 1.2 had. The **Person**
filter lists client accounts too ("Hannah Price (Client)"). Tap any row to see the details: the fields that changed
(for a sign-in, an export or an opening: what happened, e.g. "Reason: Wrong PIN", "Format: PDF"), the action and, for
administrators, the address it came from. **Download PDF** (P4) prints the view with its filters
written out ("Showing: Sign-ins", "Person: Jordan Lee", "Dates: 1 – 21 Oct 2026").

### Team → person → Activity (administrators)

A person's page has an **Activity** card under their performance: everything they did and the failed attempts to sign
in to their account ("Attempt on this account"), newest first, with their last sign-in, when they were last active
(failed tries on the sign-in page do not count: they may be somebody else's) and how many failed attempts there were
on their account in the last 30 days (in red when there were any). The chips narrow it to changes, sign-ins, exports or opened records; **Show more** loads 20
more; **Open in the audit trail** shows the full list with every filter.

## Owner notes

- **Failed sign-ins are recorded from now on.** They are filed under the account the email belongs to, so a person's
  Activity shows attempts on their account even when it was not them typing (worded "Attempt on … account", never as
  their action). An email nobody has is recorded with the email typed — only when it is an email, never an employee
  ID, PIN or code — so you can see which addresses someone tried.
- **How much is recorded in a flood (a trade-off).** Per 15 minutes: 30 failures per address, 30 per account and 600
  for emails nobody has, each followed by one row saying recording paused. A flood of made-up emails from many
  addresses can no longer hide a try on your account (each account has its own room), but a determined attacker who
  sends more than 30 tries at one account in 15 minutes is recorded for the first 30 plus the pause row, not for every
  try; the sign-in limiter and the PIN lock still block the tries themselves. Worst case on disk: 600 + 30 × accounts
  tried rows per 15 minutes.
- **What is still not recorded**: page views, reading a list, a session that ends by itself after the idle timeout (it
  is simply gone; the next request asks to sign in), a refused request other than a sign-in or security check (a rep
  trying to open the office pages gets 403 and nothing is written), and a request refused by the client guard.
- **For the lead: the idle sign-out** happens in the foundation's `middleware/auth.ts` (`authenticate`, the branch
  that calls `destroySession` when `isSessionIdle`, and `purgeExpiredSessions` at start-up). Recording it needs one
  line there before `destroySession`: a `recordAudit` row with `userId: row.id`, `action: 'SESSION idle'`, `kind:
  'sign_in'` and the summary "Signed out after 12 hours without activity" (the admin's `sessionIdleHours`). P9 did not
  edit that file.
- **For the lead: P3's docs sentence** for a statement download now reads "Exported the BCN statement for 12–18 Oct
  2026 as PDF" (with "the"), and the row is filed under the statement; P3's code needs no change.
- **Opened records come from the page.** The phone or laptop reports them, and the server checks the person may open
  that record before writing anything. Someone using the API directly without the app could open a record without the
  "opened" row; every change they make is still recorded by the server.
- **An existing database** gets the new column on the first start (`audit:audit_log.kind`) and its rows are classified
  once: sign-ins, the payroll exports and changes. Nothing is deleted; the two-year retention is unchanged.
- The Audit page's line under the title is the page's own ("Everything done in Linear Hub: …"); `COPY.nav.audit`
  still says "Who changed what and when" (foundation copy) and the lead may want to change it there.
