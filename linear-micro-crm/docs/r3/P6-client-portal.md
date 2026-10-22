# P6 client-portal: client accounts, updates, commission changes, campaign pages

Each campaign's client signs in to a portal with only a quick form for updates, announcements and commission changes; the office sees every post and approves commission changes.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P6 client-portal**.

## API

Every route is behind `requireAuth` (anonymous → 401). A client session reaches **only** `/client/*` (and its own
`/auth/me`, `/auth/pin(/*)`, `/auth/logout`, `/health`): the foundation's client guard answers 403
`{ error: 'This account can only use the client portal', clientPortalOnly: true }` everywhere else, `/client-posts`,
`/client-accounts` and `/campaigns/:id/page` included (P6's test walks every route of the app).

### The client's portal (`routes/client.ts`, client accounts only — staff 403)

| Route | Answer |
| --- | --- |
| `GET /client/portal` | `ClientPortal { campaign: { id, code, name, color }, me: { id, name, email }, posts }` — the client's own campaign only, posts newest first (at most 200). |
| `GET /client/posts` | `ClientPost[]`, the same list. |
| `POST /client/posts` `ClientPostInput` | **201** `ClientPost`. `update` / `announcement`: published straight away — an `announcements` row authored by the client account (so it carries `fromClient`, the badge "From Breast Cancer Now"), `status: 'published'`, `announcementId` set. `commission`: `status: 'pending'`, no announcement; `rateRep` (£ per sub to the fundraiser) and / or `ratePayout` (£ per sub to Linear), `effectiveFrom` today … today + 366 days (business clock), kept as `requestedFrom` too; title and message optional (default title "Commission change from Mon 2 Nov"). **400** `{ error: <first problem>, details: [{ path, message }] }` from the shared `clientPostProblems` (the portal form's own rules); **429** after 20 posts in 24 hours; the same post again within two minutes (a double tap) answers **200** with the first post and writes nothing. Both windows count on the **real clock** (`client_posts.posted_at`), like every rate limit; `created_at`, what everyone reads, is the business clock. The campaign always comes from the session, never the body. |

The client's copy of a post never names the office: `decidedBy` is `null` and `decidedByName` / `unread` are absent.
`decisionNote` reaches the client **only on a declined change** (the reason, written for them); the note Matt may add
when he approves or unpublishes is the office's own and is always `null` in `GET /client/portal` and `GET /client/posts`.

### The office (`routes/clientOffice.ts`)

| Route | Roles | Answer |
| --- | --- | --- |
| `GET /client-posts?status=&campaignId=` | admin, leader | `ClientPost[]` newest first, each with `unread` for the caller (no read receipt and newer than 30 days, not unpublished). 400 for an unknown status. |
| `GET /client-posts/unread` | admin, leader | `{ count }` — the sidebar Campaigns badge. |
| `POST /client-posts/read` `{ ids: number[] }` | admin, leader | 204: the caller's receipts for every listed post in **one** statement (at most 200 ids, unknown ids ignored, idempotent; not audited). The campaign page sends one of these per visit instead of one request per post. 400 for a missing or bad list. |
| `POST /client-posts/:id/read` | admin, leader | 204, idempotent (the caller's own receipt; not audited, like announcement reads). |
| `POST /client-posts/:id/approve` `{ effectiveFrom?, note? }` | admin | `ClientPost` (`status: 'approved'`, `effectiveFrom` = the date Matt confirmed, default the client's; `requestedFrom` keeps the client's; `note` is an office note, never shown to the client). Adds the campaign rate through **P1's `addCampaignRate`** (`source: 'client'`, `clientPostId`), which recalculates unpaid weeks from that date; a rate the change leaves out keeps the one in effect on that date. The post and the rate are written in one transaction: if P1's call fails (the foundation stub answers 501), nothing changes. 409 unless a pending commission change; 400 for a date that is not a date, more than a year ahead, or before the campaign started. |
| `POST /client-posts/:id/decline` `{ note }` | admin | `ClientPost` (`status: 'declined'`, `decisionNote` shown to the client). The reason is required (400). 409 unless pending. |
| `POST /client-posts/:id/unpublish` `{ note? }` | admin | `ClientPost` (`status: 'unpublished'`, `announcementId: null`): the Announcements row is deleted (its read receipts with it). The note stays in the office. 409 unless published. |
| `PATCH /client-accounts/:id` `ClientAccountUpdateInput { status?, firstName?, lastName?, email? }` | admin | `ClientAccount`. `status: 'left'` signs the client out everywhere at once. 400 with nothing to change, 409 for an email in use, 404 for an unknown id **or a staff member**. |
| `POST /client-accounts/:id/reset-pin` | admin | `ClientAccount` (`hasPin: false`): PIN, failed count and lock cleared, every session ended; they create a new PIN at the next sign-in. 404 for staff. |

### The campaign page (`routes/campaignPages.ts`, mounted before `/campaigns`)

| Route | Roles | Answer |
| --- | --- | --- |
| `GET /campaigns/:id/page` (cached per person) | every staff role | `CampaignPage`. **Admin, leader** (`full: true`): the campaign with its money, brief and client contact, `rates` (P1's `listCampaignRates`), every post with its status and `unread`; admin also `clientAccounts` and `paidThrough` (the last day of the latest pay week with a paid run, or `null`: the Approve dialog's warning). **Recruiter, rep** (`full: false`): no `payoutPerSale` / `repCommissionPerSale`, no rates, no accounts, `contactName` / `contactEmail` / `contactPhone` are `null` (the client contact's details are for the office), only published posts (never a commission change). Everyone: the client's announcements (authored by this campaign's client accounts, newest 50), this calendar month's events (a rep: own team only, as `GET /events`) and `sales: { thisMonth, lastMonth }` (gauge sales of this campaign's events). 404 for an unknown campaign. |
| `GET /campaigns/:id/client-accounts` | admin | `ClientAccount[]`, active first. |
| `POST /campaigns/:id/client-accounts` `ClientInviteInput { firstName, lastName, email, signInUrl? }` | admin | **201** `ClientInviteResult { account, accessCode, instructions }`: a `client` user (no team, the owner's pay plan, no PIN) with the next access code (`nextClientAccessCode`: CL-0002 onwards, never a demo code). `instructions` is the plain text to email (it names `signInUrl` when sent, an http(s) address). 409 for an email that already has an account (staff included). |

### Changed 1.0 routes

- `POST /campaigns` and `PATCH /campaigns/:id` (`routes/campaigns.ts`) also take `longDescription`, `brief`,
  `contactName`, `contactEmail`, `contactPhone` (each optional; `''` or `null` clears it, a field left out keeps its
  value; `contactEmail` must be an email) and answer the campaign **plus** those five fields. P1's
  `recordCampaignRateChange` calls are unchanged.
- `GET /auth/pin` (`lib/pin.ts pinStatusFor`): `required` is also `true` for a client account (never for the demo client).

### Needs attention (`lib/attention/clientPosts.ts`, kind `client`, the bell's "Client updates")

- Admin: `client:commission:<id>` (warning) for every pending commission change, until it is decided — "Breast Cancer
  Now asks to change commission", **Review** → `/campaigns/<id>?post=<id>`.
- Admin and leader: `client:post:<id>` (info) for every other post they have not read, from the last 30 days —
  "Update from Breast Cancer Now", **Read it**. A leader sees a pending change as info ("Waiting for the office").
- Every other role: nothing. One statement per caller, so the feed's 1.1 budget (12 statements) holds with P2's and
  P3's providers merged: for an admin a `UNION ALL` of the pending changes, **all of them** up to the feed's 20 (a
  change to approve is never pushed out by newer posts; the feed keeps warnings ahead of info items), and at most 8
  unread posts, newest first, each part with its own `ORDER BY` and `LIMIT`; for a leader the unread posts alone. Reading a client's announcement in Announcements does not clear its item; opening the campaign page does.

### Audit (`lib/audit/clientSpecs.ts`)

Every write is recorded: the client's posts with the **client account as the actor** ("Breast Cancer Now posted an
update: “New welcome pack”", "… asked for a commission change: £22.00 per sub to the fundraiser, from Mon 2 Nov"),
approve (plus the `campaign_rate` row it added), decline (with the reason), unpublish (plus the removed announcement and
its text), invite ("Invited Jo Bloggs (CL-0002) to the Breast Cancer Now client portal"), deactivate / reactivate /
edit an account, reset a PIN. Reactivating with nothing else changed reads "Reactivated the client account of Rachel
Okafor (Children's Hospice North)". Read receipts are skipped. `POST /campaigns` and `PATCH /campaigns/:id` are refined from
the 1.2 specs (same wording) so the snapshot holds the brief too. Snapshots never hold a PIN or its hash (`pinSet` only).

## Logic

- **Shared rules** (`shared/src/logic/clientPortal.ts`, tested in `clientPortal.test.ts`): `clientPostProblems(input,
  today)` (the form and the server use the same rules: title ≤ 120, message ≤ 2,000, rates > £0, ≤ £1,000, pence at
  most, a date from today to 366 days ahead), `clientPostStatusText` ("Approved from Mon 2 Nov", "Declined: reason"),
  `clientPostOfficeStatusText` (the same, except "Waiting for approval" where the client reads "Waiting for Linear"),
  `clientCommissionSummary`, `clientPostDayLabel`, `clientCommissionTitle`, `clientInviteInstructions`,
  `isClientAccessCode`, the labels and limits.
- **The client PIN rule** (`lib/pin.ts accountFlags`, body only, as the foundation contracted):
  `pinSetupRequired = !hasPin && (settings.requirePin || (role === 'client' && !demoClient))`. So an invited client's
  first sign-in (email + access code) lands on **Create your PIN** and the gate holds every other route until it is set;
  every later sign-in asks for the PIN. The seeded demo client (recognised by the seed's marker) is exempt unless the
  admin requires a PIN for everyone. `pinStatusFor` reports `required: true` for client accounts, so neither Settings nor
  the portal offers **Remove**, and `POST /auth/pin/remove` refuses a client account (409 "A PIN is required for client
  accounts…"; a two-line check in the foundation's `routes/auth.ts`). Whole truth table in `client-portal-seed.test.ts`.
- **Read receipts** (`client_post_reads`, new table of the client extension): one per (post, person), real clock. A
  post counts as unread for the office while it has no receipt, is less than 30 days old (business clock) and is not
  unpublished. The campaign page marks the posts it shows as read, in one `POST /client-posts/read`.
- **Unpublish** deletes the announcement (the client post keeps the text and its history), so read receipts of that
  announcement go too.
- **Approval** uses P1's rate history; the post's `effectiveFrom` becomes the confirmed date, `requestedFrom` keeps the
  client's. Until P1 lands the approval answers 501 and writes nothing (tested both ways; checked with P1's commit
  applied in a scratch copy: 200, a `campaign_rates` row `source 'client'` linked to the post). P1 recalculates only
  **unpaid** runs from that date: weeks already paid keep the old rate and nothing corrects them automatically (no
  adjustment line is made), which is why the Approve dialog warns when the date is on or before `paidThrough`.
- **Schema** (`db/extensions/client.ts`): `client_posts.requested_from`, `client_posts.posted_at` (the real-clock
  moment a portal post arrived; `NULL` for demo rows and posts from before this column, which therefore never count
  towards the limits) — both also added to a database created at the foundation commit — and `client_post_reads`. No
  data step for upgraded databases.
- **Demo rows** (fresh seed only, no random stream): the campaign briefs and contacts of BCN, CHN, VLT and FCB
  (columns this extension added); from Hannah Price (BCN) a declined payout change (24 days ago, "We agreed £120 per sub
  until the end of March…"), a published announcement (9 days ago) and update (3 days ago) with their Announcements
  rows, and a pending change to £22.00 per sub from the Monday after next (yesterday); for every client rate change in
  P1's demo history (BCN £18 → £20 six weeks ago) the approved post it came from, linked through
  `campaign_rates.client_post_id`. The owner has read the older posts, the leaders the announcement, so the demo opens
  with a commission change to approve and one new update. The two published posts' Announcements rows get read
  receipts from a share of the active staff that grows with age, like the audit seed's (`announcement_reads`; e.g.
  "Read by 27 of 29" for the nine-day-old walk, "19 of 29" for the three-day-old update), never "Read by 0". The
  audience of a client's announcement is every active staff member: a client account is never in it, so nobody is
  taken off for being the author.

## User guide

**For clients (the client portal).** Sign in with your email and the access code from your invite (CL-0002…). The
first time, create a PIN of 4 to 6 digits; you type it after your email and access code every time (a client account
always keeps a PIN: you can change it, not remove it). **Updates** has one form: choose **Update** or **Announcement**
(published to the Linear MCR team's Announcements straight away, with your organisation's name on it) or **Commission
change** (a new rate per sub to the fundraiser and / or the payout per sub to Linear, and the date it starts — it waits
for Linear MCR to approve it). If something is missing when you tap the button, the page scrolls to the first field to
fix and puts the cursor in it. **Your posts** lists everything your
organisation posted: Published, Waiting for Linear, Approved from Mon 2 Nov, Declined (with the reason) or Unpublished.
**Security** shows your account and lets you change your PIN. Forgotten it? Ask Linear MCR to reset it.

**For Matt (admin).** A new client post shows in **Needs attention** and the bell ("Client updates"), and as a count on
**Campaigns** in the sidebar. **Campaigns** → a campaign → **Open page** shows the client's brief and contact, this
month's sales and events, the rate history and **Client posts** (a change waiting for you reads "Waiting for
approval"): **Approve** a commission change (confirm the date it starts — unpaid weeks from that date are recalculated;
if the change has a new rate to the fundraiser and the date reaches back into a week already paid, the dialog says
so: those weeks keep the old rate; a payout-only change changes nobody's pay, so it gets no such warning), **Decline** it
with a reason the client sees, **Unpublish** an update or announcement (also from the dashboard: the crossed-out eye
next to "From BCN"). The optional **Note for the office** on Approve and Unpublish stays in the office (the campaign page
and the audit trail); only a decline's reason reaches the client. **Edit brief** changes the description, the brief for
the field team and the contact. **Client accounts** → **Invite** (name and email) shows the access code and the sign-in
instructions to copy into an email; per account **Edit** (name or email; the access code stays), **Reset PIN** and
**Turn off** / **Turn on**. "No PIN yet" means the account has not created its PIN (a new invite, after Reset PIN, or
the demo client).

**For leaders.** The same campaign page and posts, read only (no decisions, no client accounts).

**For reps and recruiters.** Tap the "From BCN" badge on a client's announcement (dashboard) to open the campaign's
page: the brief for the field team, the client's announcements and this month's events (reps: your team's), never any
money and not the client contact's email or phone. The contact card says who to ask instead: a rep with a team
"Questions for Breast Cancer Now go through your team leader or the Linear MCR office"; a recruiter (office staff, no
team) or a rep without a team "Questions for Breast Cancer Now go to the owner or another administrator".

## Owner notes

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

## Notes for the lead

- Foundation files touched (two small edits, both tolerant of merge order): `server/src/routes/auth.ts`
  `POST /auth/pin/remove` refuses a client account (`clientPinRequired`); `server/src/test/r3-contracts.test.ts`
  asserts P6's 404 "Client account not found" for an admin's `PATCH /client-accounts/1` (user 1 is staff) and 403 for a
  rep (integration I1 dropped the stub's 501 once every package had landed).
- Merge P1 before P6: the client seed links P1's demo `campaign_rates` rows (`client_post_id`) and Approve calls P1's
  `addCampaignRate`.
- Fixed in integration (I1): `GET /announcements/reads` (U3/P9's `routes/audit.ts`) took the author off the audience
  even when the author was a client account (never counted in it), so a client's announcement read one short ("Read by
  29 of 28" once everyone had read it). It now takes the author off only when the author is active staff, and counts
  only staff readers; tests in `r3-contracts.test.ts`.
