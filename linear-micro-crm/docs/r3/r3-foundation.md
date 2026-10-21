# r3-foundation: the contracts of Linear Hub 1.3

The foundation lays down every shared contract first, so the nine packages (P1–P9) edit separate files. Behaviour and
visuals are unchanged apart from two navigation items (**Venues** for every staff role, under Events; **Statements** for
administrators, under Finance), nine stub pages and the client portal stub (a demo client account, Hannah Price of
Breast Cancer Now, signs in to a portal that shows only **Updates** and **Security**).

Each stub file names its owner in its first comment. Owners replace stub bodies and may ADD fields, types, columns,
tables, routes inside their own routers and functions, but never rename or remove what another package relies on
(marked STABLE). A package that needs to change a file it does not own asks the lead; the section "Who edits which
existing file" below says who owns every file 1.3 touches.

## API

### The client role and the client guard (foundation, STABLE)

- `Role` gains `'client'` (shared `ROLES`, `STAFF_ROLES` = admin, leader, recruiter, rep, `isStaffRole()`,
  `ROLE_LABELS.client` = "Client"); `Position` gains `'client'` (`POSITION_LABELS.client`; never in `POSITIONS`, so the
  Team form never offers it). A client account is a `users` row with role and position `client`, no team, the owner's
  pay plan (users.pay_plan_id is required; a client is never paid), `employee_id` = its access code ("CL-0001") and
  `users.client_campaign_id` = its campaign.
- **Client guard** (`server/src/middleware/clientGuard.ts`, mounted in `app.ts` right after `authenticate`, before the
  PIN gate, the write limit, the audit recorder, the cache and every router): a client session may call ONLY
  `/health(/*)`, `/auth/me`, `/auth/logout`, `/auth/login`, `/auth/login/2fa`, `/auth/demo-accounts`, `/auth/pin(/*)` and
  `/client(/*)` (not `/client-posts` or `/client-accounts`). Everything else, whatever the method and even an unknown
  path, answers **403** `ClientPortalOnlyError` `{ error: 'This account can only use the client portal',
  clientPortalOnly: true }`. `clientMayCall(path)` is exported for tests. Staff and anonymous requests pass through.
- `authenticate` puts `clientCampaignId` on `req.user` (and so on `/auth/me`) for client sessions only.
- `GET /auth/demo-accounts` keeps `accounts` (the four staff accounts, same shape and order) and adds
  `clientAccounts: [{ label: 'Hannah Price (Client)', role: 'client', email: 'hannah.price@breastcancernow.example',
  employeeId: 'CL-0001' }]` while the seeded demo client exists, is active and has no PIN (absent otherwise; nothing
  with `LM_DEMO_ACCOUNTS=0`). P6 shows it on the sign-in page.
- Client accounts never appear in a staff list: `GET /users` (any filter) leaves them out and `GET /users/:id`,
  `/users/:id/performance`, `PATCH /users/:id`, `POST /users/:id/2fa/reset` answer 404 for them; the search palette's
  people, `GET /learning/team`, the Needs-attention members, the read-receipt audience ("Read by 18 of 34") and
  `lib/pay.ts payableUsers` (so no payroll run) leave them out. Server helper `server/src/lib/client.ts` (foundation,
  STABLE; P6 may add functions): `CLIENT_ROLE`, `isClientUser(user)`, `staffOnly(alias = 'u')` → `u.role <> 'client'`,
  `clientCampaignIdOf(db, userId)`, `nextClientAccessCode(db)` → "CL-0002", `clientPayPlanId(db)`.

### New routes (all mounted in `server/src/app.ts` behind `requireAuth`; anonymous → 401)

Stubs answer empty data shaped as the contract for reads and **501** for writes, with the role checks already in place.
Routers that share a prefix with a 1.0 router are mounted BEFORE it and answer only their own paths (their role checks
are per route, never router-wide, so the 1.0 routes keep their own rules).

| Path | Router file (owner) | Stub answer |
| --- | --- | --- |
| `GET /pay/settings` (admin) | `routes/pay.ts` (P1) | `PayRuleSettings` from meta: `{ dayRate: 63.5, ruleFrom: <Monday of today until P1 writes it> }` |
| `PUT /pay/settings` (admin) · `POST /pay/rates` (admin) · `POST /pay/bonuses` (admin) · `POST /pay/adjustments` (admin) · `DELETE /pay/adjustments/:id` (admin) | P1 | 501 |
| `GET /pay/rates?campaignId=` (admin, leader) · `GET /pay/adjustments?userId=&weekStart=` | P1 | `[]` |
| `GET /pay/breakdown?userId=&weekStart=` (own; leader own team; admin) — cached | P1 | 501 |
| `GET /invoices` · `GET /invoices/disputes` (admin) | `routes/invoices.ts` (P2) | `[]` |
| `GET /invoices/by-run/:runId` · `GET /invoices/:id` | P2 | 404 "Invoice not found" |
| `GET/POST /invoices/agreement(/accept)` · `GET/PUT /invoices/profile` · `GET/PUT /invoices/profile/:userId` (admin) · `GET /invoices/company` · `PUT /invoices/company` (admin) · `POST /invoices/:id/accept` · `POST /invoices/:id/dispute` · `POST /invoices/:id/resolve` (admin) | P2 | 501 |
| `/statements…` — every path admin only (router-wide, its own prefix) | `routes/statements.ts` (P3) | `GET /statements`, `/statements/senders`, `/statements/client-refs?userId=` → `[]`; `GET /statements/mail` → `{ address: null, hasPassword: false, enabled: false, lastCheckAt: null, lastError: null }`; `GET /statements/:id`, `/statements/:id/file`, `/statements/templates/:campaignId` → 404; `PUT /statements/mail`, `POST /statements/mail/test`, `PUT /statements/senders`, `PUT /statements/templates/:campaignId`, `PUT /statements/client-refs/:userId`, `POST /statements/check-now`, `POST /statements/upload`, `POST /statements/:id/apply`, `PUT /statements/:id/rows/:rowId` → 501 |
| `GET /videos` | `routes/videos.ts` (P5) | `[]` |
| `GET /videos/settings` (admin) · `GET /videos/team?userId=` (admin, leader; cached) · `GET /videos/:id/views` (admin) | P5 | `{ leadersCanAdd: false }` · `{ required: 0, rows: [] }` · `[]` |
| `GET /videos/:id` · `GET /videos/:id/stream` | P5 | 404 "Video not found" |
| `POST /videos` · `POST /videos/upload` · `PATCH /videos/:id` · `DELETE /videos/:id` · `POST /videos/:id/progress` · `PUT /videos/settings` (admin) | P5 | 501 |
| `GET /client/portal` — client role only (router-wide; staff 403) | `routes/client.ts` (P6) | real: `ClientPortal` `{ campaign: { id, code, name, color }, me: { id, name, email }, posts: [] }` |
| `GET /client/posts` · `POST /client/posts` | P6 | `[]` · 501 |
| `GET /client-posts?status=&campaignId=` · `GET /client-posts/unread` (admin, leader) | `routes/clientOffice.ts` `clientPostsRouter` (P6) | `[]` · `{ count: 0 }` |
| `POST /client-posts/:id/read` (admin, leader) · `POST /client-posts/:id/approve` · `/decline` · `/unpublish` (admin) | P6 | 501 |
| `PATCH /client-accounts/:id` · `POST /client-accounts/:id/reset-pin` (admin) | `routes/clientOffice.ts` `clientAccountsRouter` (P6) | 501 |
| `GET /campaigns/:id/page` (staff; cached) | `routes/campaignPages.ts` (P6), mounted before `/campaigns` | 501 |
| `GET /campaigns/:id/client-accounts` (admin) · `POST /campaigns/:id/client-accounts` (admin) | P6 | `[]` · 501 |
| `GET /recruitment/schedule` · `GET /recruitment/candidates/:id/timeline` (admin, leader, recruiter) | `routes/recruitmentPlus.ts` (P7), mounted before `/recruitment` | `[]` |
| `GET /recruitment/questions` (admin, recruiter) | P7 | `[]` |
| `POST /recruitment/questions` · `PATCH /recruitment/questions/:id` (admin, recruiter) · `GET /recruitment/interviews/:id/sheet` · `PUT /recruitment/interviews/:id/answers` (admin, leader, recruiter) | P7 | 501 |
| `GET /venues?sort=` (staff; cached) | `routes/venues.ts` (P8) | `[]` |
| `GET /venues/:key` (staff; cached) | P8 | 400 "Invalid venue" unless `isVenueKey(key)`, then 404 "Venue not found" |
| `GET /events/:id/plan[?userId=]` (cached) · `GET /events/:id/roster` | `routes/eventPlans.ts` (P8), mounted before `/events` | `[]` |
| `PUT /events/:id/roster` (admin, leader) · `POST` / `DELETE /events/:id/roster/me` (admin, leader, rep) | P8 | 501 |
| `POST /audit/events` (staff) | `routes/auditEvents.ts` (P9), mounted before `/audit` | **204**, records nothing (so P4's exports and P9's slot can report from day one; the audit middleware skips it) |

Response cache (`CACHED_PATHS` in app.ts): adds `/pay/breakdown`, `/videos/team`, `/campaigns/:id/page`, `/venues`,
`/events/:id/plan`. A background job that changes data those read must call `bumpDataVersion()` (lib/cache.ts).

Content-Security-Policy (app.ts): `frame-src 'self'` plus `VIDEO_EMBED_ORIGINS` and `img-src 'self' data:` plus
`VIDEO_THUMBNAIL_ORIGINS`, both lists in `server/src/lib/videoEmbeds.ts` (P5 edits that file, never app.ts). Every
response still carries `X-Frame-Options: DENY` and `frame-ancestors 'none'`: P3's `GET /statements/:id/file` must set
`X-Frame-Options: SAMEORIGIN` and its own `Content-Security-Policy: frame-ancestors 'self'` on that response if the page
shows the PDF in an iframe.

### Hooks the foundation wired into code other packages own (stubs do nothing)

| Where | Call | Owner of the hook |
| --- | --- | --- |
| `routes/finance.ts` `POST /finance/payroll/:id/pay`, after validation, before the UPDATE | `assertInvoicePayable(db, run, me, req.body)` (`lib/invoices.ts`) — P2 throws 409 unless accepted / deemed accepted or `body.overrideReason` | P2 |
| `routes/finance.ts` `GET /finance/payroll`, `GET /finance/me` (runs), `GET /finance/payroll/:id` | `withInvoiceSummaries(db, runs, me)` → each run's `invoice?: InvoiceSummary` (one grouped query) | P2 |
| `routes/campaigns.ts` after `POST /campaigns` (before = null) and `PATCH /campaigns/:id` | `recordCampaignRateChange(db, campaignId, before, after, actorId)` (`lib/payRule.ts`) | P1 |
| `index.ts` at start-up (each guarded) | `startInvoiceJobs(db)` (`lib/invoices.ts`), `startStatementJob(db)` (`lib/statements/job.ts`) → stop functions; unref'd timers | P2, P3 |
| `routes/attention.ts` `buildAttentionFeed` | `withProviderItems(core, providerAttentionItems(db, me, now))` (`lib/attention/index.ts`) | P2, P3, P6 providers |
| `lib/audit.ts` `auditMiddleware` | `matchAuditSpec(method, path)` (`lib/audit/registry.ts`): the packages' specs, then the 1.2 ones | P9 (registry), each package (its specs) |
| `db/queries.ts` `PAYROLL_SELECT` / `mapPayroll` | `paidAs`, `salesLogged`, `salesConfirmed`, `salesCancelled`, `adjustmentsTotal` (left out while NULL) | P1 |
| `db/queries.ts` `CANDIDATE_SELECT` / `mapCandidate` | `dateOfBirth` (left out while NULL) | P7 |
| `db/queries.ts` `ANNOUNCEMENT_SELECT` / `mapAnnouncement` | `fromClient: { campaignId, campaignCode, campaignName, campaignColor }` when the author is a client account | P6 |

### Middleware order on `/api` (app.ts)

`authenticate` → `clientGuard` (1.3) → `pinSetupGate` (U1) → `perUserWriteLimit` → `auditMiddleware` → write bumps the
cache version → routers (each mount recorded for the route table).

### Route table and test harness

- `server/src/lib/routeTable.ts` (foundation, STABLE): app.ts records every `/api` mount; `listApiRoutes(app)` →
  `{ method, path, mount }[]` (e.g. `POST /finance/payroll/:id/pay`). Use it to enumerate every route (P6's client
  guard test, P9's audit coverage test).
- `server/src/test/helpers.ts`: `srv.login('client')` signs in the demo client (seed: Hannah Price, BCN, CL-0001; the
  fixture: cleo.client@fixture.test / CL-0001 of the fixture campaign FXC, created on first use so other tests see no
  extra user); `DEMO_ACCOUNTS.client`, `FIXTURE_ACCOUNTS.client`; `addClientUser(db, { campaignId, email?, employeeId?,
  firstName?, lastName?, status? })` → id.
- `server/src/test/r3-contracts.test.ts` (foundation): the extension list and order, every 1.3 table and core-table
  column, a 1.2 database upgrading cleanly (rows kept, changes reported once), the demo client account, the client
  guard paths, the audit registry, the attention providers, every 1.3 path mounted behind requireAuth (anonymous 401,
  admin never "Not found" / 5xx except 501), the 1.0 routes beside the new mounts, the route table, the client session
  (portal, /auth/me, staff 403 on the portal), **a client gets 403 clientPortalOnly on every other route in the app**,
  client accounts absent from staff lists, `fromClient`, no new payload keys while the 1.3 columns are empty, the cache.
- `r2-contracts.test.ts` (updated): the first five extensions keep their order; the core-table hashes cover the core
  columns only (an extension's own columns on core rows may be filled by its seed) and leave out announcements authored
  by client accounts (P6's published demo posts).

## Logic

### Database extensions (`server/src/db/extensions/`)

`index.ts` (foundation) runs, in this fixed order: learning, pitches, pin, audit, checkins (1.2), then **pay (P1),
invoices (P2), statements (P3), videos (P5), client (P6), recruitment (P7), venues (P8)**. P4 adds none; P9 owns the
1.2 `audit.ts`. The rules of `types.ts` stand (CREATE TABLE IF NOT EXISTS, `addColumnIfMissing`, data steps guarded with
meta flags and skipped on an empty database, INSERT OR IGNORE, report only real changes, rows both databases need in
both `upgrade` and `seed`, `ctx.rng(salt)`, never gauge rows or payroll runs from an extension). 1.3 adds:

- The foundation laid down each 1.3 extension's tables and columns; they are STABLE. Owners add columns with
  `addColumnIfMissing` in `upgrade` (so a database created at the foundation commit upgrades too) and new tables.
- An extension's `seed` may UPDATE the columns its own extension added to core tables, on core rows. The one core-row
  insert allowed: P6 may insert `announcements` authored by a client account (`ctx.clients`).
- Core demo rows are written by the core seed (`db/seed.ts`): the demo client account (foundation, inserted after every
  staff member without the core random stream, counted in `stats.users`, passed to extensions as `ctx.clients:
  SeedClientRef[]` — never in `ctx.users`) and the 1.3 pay plans, runs, bonuses and cancellations (P1).

| Extension (owner) | Tables | Columns on core tables | Meta |
| --- | --- | --- | --- |
| `pay.ts` (P1) | `campaign_rates (id, campaign_id → campaigns CASCADE, rep_rate, payout_rate, effective_from, source 'seed'\|'admin'\|'client', approved_by, client_post_id, created_at)`; `pay_adjustments (id, user_id → users CASCADE, target_week_start, source_week_start, kind 'cancellation'\|'statement'\|'bonus'\|'dispute'\|'manual', amount, note, campaign_id, statement_id, invoice_id, created_by, created_at)`; `sale_confirmations (user_id, campaign_id, week_start, confirmed, statement_id, confirmed_at; PK user+campaign+week)` | `payroll_runs.paid_as, sales_logged, sales_confirmed, sales_cancelled, adjustments_total` (NULL = 1.2 rules) | `ext:pay:rule_from`, `ext:pay:day_rate` |
| `invoices.ts` (P2) | `self_billing_agreements (user_id, version, accepted_at, ip; PK user+version)`; `invoices (id, payroll_run_id UNIQUE → payroll_runs CASCADE, user_id, number UNIQUE, version, issued_at, status 'issued'\|'accepted'\|'deemed_accepted'\|'disputed'\|'resolved', total, lines_json, supplier_json, customer_json, accepted_at, accepted_ip, disputed_at, dispute_reason, dispute_lines, resolved_at, resolved_by, resolution_note)` | `users.address_line1, address_line2, address_town, postcode, utr, vat_number` | `ext:invoices:company` (JSON), `ext:invoices:seq:<YYYY>` |
| `statements.ts` (P3) | `campaign_statement_senders (campaign_id, address NOCASE; PK)`; `statement_templates (campaign_id PK, mapping JSON, updated_at, updated_by)`; `statements (id, campaign_id, source 'email'\|'upload', message_id UNIQUE, received_at, file_path, file_name, file_sha256, period_start, period_end, status 'parsed'\|'needs_review'\|'applied'\|'failed', error, applied_at, applied_by)`; `statement_rows (id, statement_id → CASCADE, raw JSON, fundraiser_ref, name, period_start, period_end, sale_date, confirmed, cancelled, amount, user_id, match 'auto'\|'manual'\|'none')`; `user_client_refs (user_id, campaign_id, ref NOCASE; PK user+campaign; UNIQUE campaign+ref)` | — | `ext:statements:mail` (address, app password ENCRYPTED with lib/crypto.ts, last check, last error, last UID) |
| `videos.ts` (P5) | `learning_videos (id, title, description, topic, kind 'upload'\|'link', url, file_path, mime, size, duration_s, required, audience 'everyone'\|'leaders'\|'reps', example, created_by, created_at)`; `video_views (video_id → CASCADE, user_id → CASCADE, watched_s, position_s, completed_at, last_at; PK video+user)` | — | `ext:videos:leaders_can_add` |
| `client.ts` (P6) | `client_posts (id, campaign_id, author_id, kind 'update'\|'announcement'\|'commission', title, body, rate_rep, rate_payout, effective_from, status 'published'\|'pending'\|'approved'\|'declined'\|'unpublished', decided_by, decided_at, decision_note, announcement_id → announcements SET NULL, created_at)` | `users.client_campaign_id` (+ index); `campaigns.long_description, brief, contact_name, contact_email, contact_phone` | — |
| `recruitment.ts` (P7) | `interview_questions (id, interview_type, position, text, sort, active, created_at, updated_at)`; `interview_answers (id, interview_id → interviews CASCADE, question_id → SET NULL, question_text, sort, answer, score, updated_at, updated_by)`; `interview_changes (id, interview_id → CASCADE, field, from_value, to_value, changed_by, changed_at)` | `candidates.date_of_birth` | — |
| `venues.ts` (P8) | `event_roster (event_id → events CASCADE, user_id → users CASCADE, booked_by, booked_at, source 'leader'\|'self'; PK event+user)` | — | — |

Files on disk (git-ignored in `.gitignore`): `server/data/media/` (P5 videos), `server/data/statements/` (P3 PDFs),
`server/data/uploads/` (P2's signature image). Tests write files only to a temp dir, never there.

### Shared types (`shared/src/types/*.ts`, re-exported from `@lm/shared`)

- `pay.ts` (P1): `PAY_DAY_RATE_DEFAULT` 63.5, `PaidAs`, `PayRuleSettings { dayRate; ruleFrom }`, `PayRuleSettingsInput`,
  `CampaignRateSource`, `CampaignRate { id, campaignId, repRate, payoutRate, effectiveFrom, source, approvedBy,
  approvedByName?, clientPostId?, createdAt }`, `CampaignRateInput`, `PayLineKind`, `PayLine`, `PayAdjustmentKind`,
  `PayAdjustment { id, userId, targetWeekStart, sourceWeekStart, kind, amount, note, campaignId?, statementId?,
  invoiceId?, createdBy, createdAt }`, `WeekCampaignPay { campaignId, code, name?, logged, confirmed, cancelled,
  statementConfirmed, rate, amount }`, `WeekPayBreakdown extends PayrollBreakdown { userId, weekStart, weekEnd, rule,
  daysWorked, dayRate, baseAmount, commissionAmount, paidAs, lines, salesLogged, salesConfirmed, salesCancelled,
  perCampaign, adjustments, explanation, runId, status }`, `ConfirmedSalesRow`, `ApplyConfirmedSalesOptions`,
  `ApplyPersonResult`, `ApplyResult`, `BonusInput`, `ManualAdjustmentInput`.
- `invoices.ts` (P2): `SELF_BILLING_AGREEMENT_VERSION` '2026-10', `INVOICE_NUMBER_PREFIX` 'LM-SB', `InvoiceStatus`,
  `SelfBillingAgreement`, `InvoiceParty`, `InvoiceLine`, `InvoiceSummary { id, number, status, version, issuedAt,
  acceptedAt, disputedAt, deemedAcceptedAt, total }`, `InvoiceDisputeLine`, `InvoiceDispute`, `InvoiceResolution`,
  `Invoice`, `InvoiceDisputeInput`, `InvoiceResolveInput`, `InvoiceDisputeRow`, `InvoiceProfile`, `InvoiceProfileInput`,
  `CompanySettings`, `CompanySettingsInput`.
- `statements.ts` (P3): `StatementSource`, `StatementStatus`, `StatementRowMatch`, `StatementSummary { …, rowCount,
  matchedCount, … }`, `StatementRow`, `StatementDetail { …, rows, effect: ApplyResult | null, template }`,
  `StatementRowMatchInput`, `StatementColumnMapping`, `StatementTemplate`, `MailSettings`, `MailSettingsInput`,
  `MailTestResult`, `CheckNowResult`, `StatementSender`, `ClientRef`.
- `videos.ts` (P5): `VideoKind`, `VideoTopic`, `VIDEO_TOPICS`, `VideoAudience`, `VIDEO_MAX_BYTES` (2 GB),
  `VIDEO_MIME_TYPES`, `VIDEO_COMPLETE_SHARE` 0.9, `VIDEO_PROGRESS_INTERVAL_S` 15, `VideoProgress`, `LearningVideo`,
  `VideoLinkInput`, `VideoUpdateInput`, `VideoProgressInput`, `VideoViewRow`, `TeamVideoProgress`, `VideoSettings`.
- `client.ts` (P6): `CLIENT_ACCESS_CODE_PREFIX` 'CL-', `ClientPortalOnlyError`, `ClientPostKind`, `ClientPostStatus`,
  `ClientPost`, `ClientPostInput`, `ClientPostDecisionInput`, `ClientPortal`, `ClientAccountStatus`, `ClientAccount`,
  `ClientInviteInput`, `ClientInviteResult`, `AnnouncementSource`, `CampaignBrief`, `CampaignPage`.
- `recruitmentPlus.ts` (P7): `InterviewType` (= Interview['type']), `CANDIDATE_ADULT_AGE` 18, `InterviewQuestion`,
  `InterviewQuestionInput`, `InterviewAnswer`, `InterviewAnswerInput`, `InterviewSheet`, `InterviewChangeField`,
  `InterviewChange`, `CandidateTimelineKind`, `CandidateTimelineItem`, `InterviewScheduleItem`.
- `venues.ts` (P8): `RosterSource`, `EventBooking`, `EventBookingSummary { booked, me }`, `EventRosterInput`,
  `EventPlanStep`, `EventPlan`, `VenueSummary { key, venue, city, eventCount, shifts, sales, salesPerShift, lastVisit,
  campaigns }`, `VenuePoint`, `VenueProfile`.
- `audit.ts` (P9; the 1.2 file): `AuditEntity` gains `campaign_rate`, `pay_adjustment`, `invoice`, `agreement`,
  `statement`, `video`, `client_post`, `client_account`, `interview_question`, `event_roster`, `export`;
  `AuditEventKind` ('change' | 'sign_in' | 'export' | 'opened' | 'automatic' | 'client'), `AUDIT_EVENT_KINDS`,
  `ClientAuditEventKind`, `AuditExportFormat`, `ClientAuditEventInput { kind, format?, what, rows?, filename?, entity?,
  entityId? }`. Shared logic `AUDIT_ENTITIES_R3` lists the new entities (the 1.2 `AUDIT_ENTITIES` filter list is
  unchanged; `isAuditEntity` accepts both; labels in `AUDIT_ENTITY_LABELS`).
- Core `types.ts` (foundation): optional `UserWithTeam.clientCampaignId`, `SalesEventWithMeta.bookings?:
  EventBookingSummary` (P8; not the p6 `roster` count), `PayrollRun.paidAs? / salesLogged? / salesConfirmed? /
  salesCancelled? / adjustmentsTotal?` (P1), `PayrollRunWithUser.invoice?: InvoiceSummary` (P2), `Candidate.dateOfBirth?`
  (P7), `Announcement.fromClient?: AnnouncementSource` (P6); `AttentionKind` gains `'invoices'` (P2), `'statements'`
  (P3), `'client'` (P6) — the bell labels them "Invoices", "Statements", "Client updates".

### Shared logic modules (`shared/src/logic/`, registered in `logic/index.ts` by the foundation)

| Module | Owner | Exports now |
| --- | --- | --- |
| `payRule.ts` | P1 | STABLE `paidAsFor(base, commission)` (tie → commission); `WeekPaySale`, `WeekPayInput`, `WeekPayResult`; stubs `calculateWeekPay`, `payExplanation` |
| `invoices.ts` | P2 | STABLE `formatInvoiceNumber(year, seq)` → "LM-SB-2026-000123", `deemedAcceptedAt(payday)` → "YYYY-MM-DDT12:00:00" the day before |
| `statements.ts` | P3 | `STATEMENT_HEADER_KEYWORDS`, `normalisePersonName`, stub `detectStatementColumns` |
| `exportFormat.ts` | P4 | `PDF_PORTRAIT_MAX_COLUMNS` 6, `PdfOrientation`, `pdfOrientationFor(columnCount)` |
| `videos.ts` | P5 | `VIDEO_TOPIC_LABELS`, `isVideoComplete(watchedS, durationS)`, stub `videoEmbedUrl` |
| `clientPortal.ts` | P6 | `CLIENT_POST_KIND_LABELS`, `CLIENT_POST_STATUS_LABELS`, STABLE `formatClientAccessCode(n)` |
| `recruitmentPlus.ts` | P7 | `ageOn(dateOfBirth, today)`, `isUnderAge(dateOfBirth, today)` |
| `venues.ts` | P8 | STABLE `venueSlug`, `venueKey(venue, city)` → "golden-square--manchester", `isVenueKey` |

`shared/src/logic/r3-contracts.test.ts` (foundation) tests the STABLE ones.

### Server helpers other packages call

- `server/src/lib/payRule.ts` (P1, STABLE signatures): `payRuleSettings(db)`, `weekPayBreakdown(db, userId,
  weekStart): WeekPayBreakdown | null`, `applyConfirmedSales(db, rows: ConfirmedSalesRow[], { statementId, actorId,
  dryRun? }): ApplyResult` (P3 calls; idempotent per statement; paid weeks → `pay_adjustments` on the next unpaid run),
  `campaignRateOn(db, campaignId, date)`, `listCampaignRates(db, campaignId)`, `addCampaignRate(db, input, actorId)`
  (P6's approval; stub throws 501), `recordCampaignRateChange(db, campaignId, before, after, actorId)`.
- `server/src/lib/invoices.ts` (P2, STABLE): `assertInvoicePayable`, `withInvoiceSummaries`, `startInvoiceJobs`.
- `server/src/lib/statements/job.ts` (P3): `startStatementJob(db): () => void`; never started by tests.
- `server/src/lib/attention/` — `types.ts` + `index.ts` (foundation, STABLE): `AttentionProvider { name, items(db, me,
  now): AttentionItem[] }`, `ATTENTION_PROVIDERS` [invoices, statements, client-posts], `providerAttentionItems`,
  `withProviderItems(core, extra)` (dedupe by key, `sortAttentionItems`, cap `ATTENTION_MAX_ITEMS`; unchanged when no
  extra items; a throwing provider is logged and skipped). Provider files, one per owner: `invoices.ts` (P2),
  `statements.ts` (P3), `clientPosts.ts` (P6). Keys start with the kind (`invoices:dispute:12`); items only for what
  the caller may see; one or two grouped queries. With `LM_SMART=0` the whole feed (and so the providers) is off.
- `server/src/lib/audit/` — `registry.ts` (foundation; P9 owns it from now): `PACKAGE_AUDIT_SPECS`, `allAuditSpecs()`,
  `matchAuditSpec(method, path)`; one spec file per package exporting `AUDIT_SPECS: readonly AuditRouteSpec<any>[]` in
  the shape of `lib/auditSpecs.ts`: `paySpecs.ts` (P1), `invoiceSpecs.ts` (P2), `statementSpecs.ts` (P3),
  `videoSpecs.ts` (P5), `clientSpecs.ts` (P6), `recruitmentSpecs.ts` (P7), `venueSpecs.ts` (P8), `auditEventSpecs.ts`
  (P9; `POST /audit/events` skip: true for now). Package specs are matched before the 1.2 ones (first match wins), so a
  package may refine a 1.2 route's entry from its own file. `lib/auditSpecs.ts` keeps its own `matchAuditRoute` (1.2
  specs only). `events.ts` (P9): `recordSystemEvent(db, { name, summary, entity?, entityId?, after? })` — works now:
  one row, user NULL ("Linear Hub"), action `SYSTEM <name>`; P3 records "statements.fetch" / "statements.apply"
  with it, P2 "invoices.issue" / "invoices.deem"; stub `recordClientEvent(db, me, input, ip)`.
- `server/src/lib/videoEmbeds.ts` (P5): `VIDEO_EMBED_ORIGINS`, `VIDEO_THUMBNAIL_ORIGINS` (the CSP).

### Client

- API hooks, one file per package (`client/src/api/`): `pay.ts` (P1: `payKeys`, `usePaySettings`,
  `useUpdatePaySettings`, `useCampaignRates`, `useAddCampaignRate`, `usePayBreakdown(userId, weekStart)`,
  `usePayAdjustments`, `useAddBonus`, `useAddAdjustment`, `useRemoveAdjustment`), `invoices.ts` (P2: `invoiceKeys`,
  `useAgreement`, `useAcceptAgreement`, `useInvoiceProfile(userId?)`, `useSaveInvoiceProfile`, `useCompanySettings`,
  `useSaveCompanySettings`, `useInvoices`, `useInvoiceForRun(runId)`, `useInvoice`, `useAcceptInvoice`,
  `useDisputeInvoice`, `useInvoiceDisputes`, `useResolveInvoice`), `statements.ts` (P3: `statementKeys`,
  `useStatements`, `useStatement`, `statementFileUrl`, `useApplyStatement`, `useMatchStatementRow`,
  `useCheckStatementsNow`, `useMailSettings`, `useSaveMailSettings`, `useTestMail`, `useStatementSenders`,
  `useSaveStatementSenders`, `useStatementTemplate`, `useSaveStatementTemplate`, `useClientRefs`, `useSaveClientRefs`,
  `useUploadStatement`), `videos.ts` (P5: `videoKeys`, `useVideos`, `useVideo`, `videoStreamUrl`, `useAddVideoLink`,
  `useUpdateVideo`, `useDeleteVideo`, `useReportVideoProgress`, `useVideoViews`, `useTeamVideoProgress`,
  `useVideoSettings`, `useSaveVideoSettings`), `clientPortal.ts` (P6: `clientPortalKeys`, `useClientPortal`,
  `useCreateClientPost`, `useClientPosts`, `useUnreadClientPosts`, `useMarkClientPostRead`, `useDecideClientPost`,
  `useCampaignPage`, `useClientAccounts`, `useInviteClient`, `useUpdateClientAccount`, `useResetClientPin`),
  `recruitmentPlus.ts` (P7: `recruitmentPlusKeys`, `useInterviewSchedule`, `useCandidateTimeline`,
  `useInterviewQuestions`, `useSaveInterviewQuestion`, `useInterviewSheet`, `useSaveInterviewAnswers`), `venues.ts`
  (P8: `venueKeys`, `useVenues(sort)`, `useVenue(key)`, `useEventPlan(eventId, userId?)`, `useEventRoster`,
  `useSaveEventRoster`, `useBookMyself`), `auditEvents.ts` (P9, STABLE: `reportAuditEvent(event)` — fire and forget,
  never throws). `api/hooks.ts`: only `useDemoAccounts` now types `clientAccounts?`; no package edits it.
- PDF (`client/src/lib/pdf/`, P4, API STABLE): `exportTablePdf(TablePdfOptions)` (title, subtitle, filters, columns =
  the CSV `CsvColumn`s, rows, totals, filename, orientation 'auto'), `pdfDocument(PdfDocumentOptions) → PdfDoc` (header,
  addressBlocks, heading, paragraph, keyValues, lineTable, table, totals, signatureBlock, footer with page x of y,
  save, blob), types `PdfAddress`, `PdfLineColumn`, `PdfLineRow`, `PdfSignature`, `PdfUnavailableError`, and
  `PDF_EXPORTS_READY` (false until P4 lands; pages add a PDF button in a PageHeader's actions only when true, so no
  empty actions row appears before). Stubs throw `PdfUnavailableError`. jsPDF loads in its own lazy chunk.
- `ExportButton` (P4): new optional props `pdf?`, `pdfTitle?`, `pdfFilters?`, `pdfTotals?`, `auditWhat?`; every call
  site keeps working unchanged (P4 derives the PDF title from the file name) and P4 turns the button into "Export ▾
  CSV / PDF" everywhere, reporting each export with `reportAuditEvent`.
- Pages (lazy, `App.tsx`; titles in `COPY.nav.*`): `/finance/statements` `Statements.tsx` (P3, `STATEMENT_ROLES` =
  admin), `/venues` `Venues.tsx` and `/venues/:key` `VenueDetail.tsx` (P8, `VENUE_ROLES` = staff),
  `/recruitment/schedule` `InterviewSchedule.tsx` and `/recruitment/interviews/:id` `InterviewSheet.tsx` (P7,
  RECRUITMENT_ROLES), `/learning/videos/:id` `LearningVideo.tsx` (P5), `/campaigns/:id` `CampaignPage.tsx` (P6,
  `CAMPAIGN_PAGE_ROLES` = staff; the server trims money), `/client` `ClientPortal.tsx` and `/client/security`
  `ClientSecurity.tsx` (P6) inside `ClientLayout` → `PinSetupGate` → lazy `features/client/ClientShell.tsx` (P6).
  A client account is sent to `/client` from every staff path; staff visiting `/client` go to `/`.
- Navigation (`components/layout/nav.ts`, icons in `Sidebar.tsx`): **Venues** (staff, Workspace, MapPinned) after
  Events; **Statements** (admin, Manage, FileSpreadsheet) after Finance (Finance is now `end: true`, so it is not lit on
  /finance/statements); `CLIENT_NAV_ITEMS` = **Updates** (/client) and **Security** (/client/security) for the client
  shell. `NavItem.end?` is new. Copy keys (`content/copy.ts`, packages do not edit it): `venues`, `statements`,
  `interviewSchedule`, `interviewSheet`, `learningVideo`, `campaignPage`, `clientPortal`, `clientSecurity`.
- Role lists (`auth/RequireRole.tsx`): `STAFF_ROLES_ALL`, `VENUE_ROLES`, `STATEMENT_ROLES`, `CAMPAIGN_PAGE_ROLES`,
  `CLIENT_ROLES`. The Team form's Role select lists `STAFF_ROLES` only.
- Slots (render nothing now; each mounted in an `ErrorBoundary` with `fallback={null}`; a slot that renders a card
  renders the whole card or nothing):

| Slot (props) | Owner | Mounted in |
| --- | --- | --- |
| `features/pay/PayBreakdown.tsx` `{ run, className? }` | P1 | `PayslipModal` body, after the pay table and plan box, before the week's gauges |
| `features/pay/PaySettingsSection.tsx` `{ className? }` | P1 | Settings, left column, after Backups (admin) |
| `features/invoices/InvoiceActionsBar.tsx` `{ run, className? }` | P2 | `PayslipModal` body, after the status badges |
| `features/invoices/InvoiceStatusBadge.tsx` `{ run }` | P2 | `PayrollRunsTable` Status cell, after the payroll status badge (inline) |
| `features/invoices/DisputesCard.tsx` `{ className? }` | P2 | Finance → Company, first item |
| `features/invoices/InvoiceSettingsSection.tsx` `{ className? }` | P2 | Settings, left column, after Security (every staff role; render nothing for roles not invoiced) |
| `features/invoices/CompanySettingsSection.tsx` `{ className? }` | P2 | Settings, after Settings → Pay (admin) |
| `features/invoices/InvoiceProfileSection.tsx` `{ user, className? }` | P2 | Team → person, left column, after the Pay plan card (admin) |
| `features/invoices/AgreementPrompt.tsx` `{ user }` | P2 | `AppShell` sticky banner row, after the check-in outbox (every page; load the modal lazily) |
| `features/statements/IntegrationsSection.tsx` `{ className? }` | P3 | Settings, after Company (admin) |
| `features/statements/ClientRefsSection.tsx` `{ user, className? }` | P3 | Team → person, left column, after the invoice details (admin) |
| `features/videos/VideosSection.tsx` `{ className? }` | P5 | Learning hub, right after the pitches section |
| `features/videos/VideoProgressSection.tsx` `{ view: 'me' \| 'person' \| 'team', userId?, className? }` | P5 | Learning → Progress: after the own checklist (me), after a person's (person), after the team checklist (team) |
| `features/videos/VideoSettingsSection.tsx` `{ className? }` | P5 | Settings, after Integrations (admin) |
| `features/client/AnnouncementSourceBadge.tsx` `{ announcement }` | P6 | Each dashboard announcement's title row, after the title (inline) |
| `features/client/CampaignsNavBadge.tsx` `{ compact }` | P6 | Sidebar, inside the Campaigns link after the label (main chunk: keep it tiny) |
| `features/venues/EventPlanStrip.tsx` `{ event, variant: 'row' \| 'upcoming' \| 'quick', className? }` | P8 | `EventRow` under the forecast chip (row); `UpcomingEvents` under each event's details (upcoming); `QuickGauges` right under the header (quick, the thin "Aim" strip) |
| `features/venues/EventPlanCard.tsx` `{ event, canManage, className? }` | P8 | EventDetail, after the forecast |
| `features/venues/EventRosterCard.tsx` `{ event, canManage, className? }` | P8 | EventDetail, after the check-in roll call ("Who's working") |
| `features/venues/VenueLink.tsx` `{ venue, city, className? }` | P8 | EventDetail header, after the directions link (inline) |
| `features/recruitment/QuestionBankSection.tsx` `{ className? }` | P7 | Settings, after Settings → Invoices (admin, recruiter) |
| `features/audit/RecordOpened.tsx` `{ entity, entityId, what }` | P9 | CandidateDetail (candidate), PayslipModal (payroll_run; P2 may switch it to invoice), Audit page (null: the trail itself) |
| `features/audit/PersonActivity.tsx` `{ user, className? }` | P9 | Team → person, right column, under the performance panel (admin) |
| `features/pdf/AuditPdfButton.tsx` `{ entries, filters, className? }` | P4 | Audit page header actions, only while `PDF_EXPORTS_READY` (P9 passes the real filter lines) |
| `features/pdf/ProgressPdfButton.tsx` `{ userId?, className? }` | P4 | Learning → Progress header actions (me, person), only while `PDF_EXPORTS_READY` |

### Who edits which existing file in 1.3

No two packages edit the same file. Foundation-owned (ask the lead): `server/src/app.ts`, `index.ts`,
`middleware/clientGuard.ts`, `middleware/auth.ts`, `lib/routeTable.ts`, `lib/attention/index.ts` + `types.ts`,
`lib/client.ts` (P6 may ADD functions), `db/extensions/index.ts` + `types.ts`, `db/schema.ts`, `routes/users.ts`,
`routes/search.ts`, `routes/learning.ts`, `routes/attention.ts`, `test/helpers.ts`,
`test/r2-contracts.test.ts`, `test/r3-contracts.test.ts`; `shared/src/index.ts`, `logic/index.ts`, `types.ts`,
`constants.ts`, `logic/r3-contracts.test.ts`; client `App.tsx`, `auth/RequireRole.tsx`, `components/layout/*`,
`content/copy.ts`, `api/hooks.ts`, `api/client.ts`, `pages/Settings.tsx`, `pages/UserDetail.tsx`, `pages/Learning.tsx`,
`pages/LearningProgress.tsx`, `pages/Dashboard.tsx`, `features/dashboard/Announcements.tsx`,
`features/team/UserFormModal.tsx`; `.gitignore`; the version numbers (lead).

| Package | Its own new files (above) plus these existing ones |
| --- | --- |
| P1 | `server/src/lib/pay.ts`, `db/maintenance.ts`, `routes/finance.ts` (keep the P2 hook calls), `routes/dashboard.ts` and `lib/smart/payForecast.ts` / `payrollFlags.ts` / `digest.ts` where pay figures show, `db/queries.ts` (the payroll section only), `db/seed.ts` and `db/seed-data.ts` (pay plans, payroll runs, bonuses, cancellations; keep the demo client block), `smoke.ts` (the pay checks the new rule changes), the existing tests of pay maths (`money`, `personal`, `office-tools`…); shared `logic/finance.ts`, `logic/payForecast.ts`, `logic/payrollFlags.ts`; client `pages/Finance.tsx` (keep the DisputesCard slot), `features/finance/PayrollRunsTable.tsx` (keep the InvoiceStatusBadge slot), `features/finance/csv.ts`, `features/smart/WeekPayStrip.tsx` / `weekPayCopy.ts`, `features/dashboard/PersonalKpis.tsx` |
| P2 | `client/src/features/finance/PayslipModal.tsx` (keep the PayBreakdown and RecordOpened slots), `features/finance/BulkPayBar.tsx`, `features/finance/bulkPay.tsx` |
| P3 | `server/package.json` + `package-lock.json` (imapflow, mailparser, pdfjs-dist; jspdf at P4's version for demo PDFs) |
| P4 | `client/src/features/common/ExportButton.tsx`, `client/src/lib/csv.ts`, `client/package.json` + `package-lock.json` (jspdf, jspdf-autotable); its node test in `server/src/test/` |
| P5 | `server/package.json` + `package-lock.json` (busboy) |
| P6 | `server/src/routes/announcements.ts`, `routes/campaigns.ts` (the campaign's brief fields; keep P1's `recordCampaignRateChange` calls), `lib/pin.ts` (PIN required for client accounts), `test/announcements-older.test.ts` if its shapes change; client `pages/Campaigns.tsx`, `features/campaigns/*`, `pages/Login.tsx` (the client demo button, client sign-in), `auth/PinSetupStep.tsx` if the client's PIN step needs other words |
| P7 | `server/src/routes/recruitment.ts` (date of birth on candidates, interview_changes on PATCH /recruitment/interviews/:id); client `pages/Recruitment.tsx` (**Schedule**), `pages/CandidateDetail.tsx` (keep the RecordOpened slot), `features/recruitment/*` |
| P8 | `server/src/routes/events.ts` (`bookings` on events), `lib/smart/eventForecast.ts` (bookings feed forecasts), shared `logic/eventForecast.ts` if the maths changes; client `pages/Events.tsx` (**Venues**), `pages/EventDetail.tsx`, `pages/QuickGauges.tsx`, `features/events/*`, `features/dashboard/UpcomingEvents.tsx` (keep the slots) |
| P9 | `server/src/lib/audit.ts`, `lib/auditSpecs.ts`, `lib/audit/registry.ts`, `lib/audit/events.ts`, `routes/audit.ts`, `routes/auth.ts` (only to record failed sign-ins if the middleware cannot), `middleware/writeLimit.ts` (rate-limit POST /audit/events), `db/extensions/audit.ts` (e.g. a kind column), the `audit*` tests; shared `types/audit.ts`, `logic/audit.ts`; client `pages/Audit.tsx` (keep the AuditPdfButton and RecordOpened slots), `features/audit/*`, `api/audit.ts` |

Dependencies (only these; checked on 21 Oct 2026 — the highest release at least two weeks old; pin exactly with
`npm install <pkg>@<version> -w <workspace>`): P3 `imapflow@2.2.6`, `mailparser@3.9.36` (+ `@types/mailparser@3.9.0`
dev), `pdfjs-dist@6.4.299`; P4 `jspdf@4.2.1`, `jspdf-autotable@5.0.8` (client; P3 uses the same `jspdf@4.2.1` on the
server); P5 `busboy@1.6.0` (+ `@types/busboy@1.5.4` dev). Three packages touch `package-lock.json`: the lead
regenerates it when merging.

Bundle: the foundation's routes, nav items and slots add 6.0 kB to the main chunk (466.17 → 472.19 kB, gzip 144.5 →
146.1 kB); every 1.3 page is its own lazy chunk.

## User guide

Nothing changes for anyone yet apart from two new items in the sidebar (and the mobile menu) and the client portal:

- **Venues** (everyone, under **Events**) opens the Venues page, which says **Coming soon** until it is built.
- **Statements** (administrators, under **Finance**) opens the commission statements page, which says **Coming soon**.
- The demo client account — **Hannah Price** of **Breast Cancer Now** (email hannah.price@breastcancernow.example,
  access code CL-0001) — signs in to a portal with only **Updates** and **Security**. Updates shows "You are signed in
  for Breast Cancer Now" and **Coming soon**; nothing about the office, pay or other campaigns is reachable.
- The other new pages (a campaign's page, a venue, the interview schedule and sheet, a learning video) exist at their
  addresses and say **Coming soon**; nothing links to them yet.

## Owner notes

- The demo client account is part of the demo data only (a fresh seed). It has no PIN so the demo sign-in works; P6
  makes a PIN required for real client accounts. It never appears in Team, the search palette, payroll, leaderboards
  or read receipts.
- Client accounts sign in with their email and an access code (CL-0001…), like staff use their employee ID.
