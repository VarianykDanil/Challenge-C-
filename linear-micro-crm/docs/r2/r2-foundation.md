# r2-foundation: the contracts of Linear Hub 1.2

The foundation lays down every shared contract first, so the seven packages edit separate files. Behaviour and visuals
are unchanged apart from two navigation items (**Learning** for everyone, **Audit** for admins) and six stub pages.
Each stub file names its owner in its first comment; owners replace stub bodies and may add fields and types to the
files they own, but never rename or remove what another package relies on (marked STABLE below).

## API

All new routes are mounted in `server/src/app.ts` behind `requireAuth` (anonymous → 401). Stubs answer empty data
shaped as the contract for reads and 501 for writes.

| Path | Router (owner) | Stub answer |
| --- | --- | --- |
| `GET /learning/progress[?userId=]` | `routes/learning.ts` (L1) | own `LearningProgress`, every lesson `new` |
| `POST /learning/progress/:lessonKey/quiz`, `…/teachback` | L1 | 501 |
| `POST /learning/progress/:userId/:lessonKey/signoff` | L1 (admin, leader) | 501 |
| `GET /learning/team` | L1 (admin, leader; others 403) | `{ rows: [], total: 21 }` |
| `GET /learning/progression/:userId` | L1 | 501 |
| `GET /pitches` | `routes/pitches.ts` (L2) | `[]` |
| `GET /pitches/:campaignCode` | L2 | 404 "Pitch not found" |
| `PUT /pitches/:campaignCode` | L2 (admin, leader) | 501 |
| `POST /gauges/bulk` | `routes/bulkGauges.ts` (U2, admin / leader), mounted before `/gauges` | 501 |
| `GET /audit` | `routes/audit.ts` `auditRouter` (U3, admin) | `{ rows: [], total: 0 }` |
| `GET /audit/:entity/:entityId` | U3 (admin, leader) | `[]` |
| `GET /announcements/reads` | `routes/audit.ts` `announcementReadsRouter` (U3), mounted before `/announcements` | `[]` |
| `POST /announcements/:id/read` | U3 | 501 |
| `GET /checkins?eventId=` | `routes/checkins.ts` (U4) | `{ eventId, checkIns: [] }` (400 without eventId) |
| `POST /checkins`, `DELETE /checkins/:id` | U4 | 501 |
| `GET /search?q=` | `routes/search.ts` (U5) | `{ q, results: [] }` |
| `GET /finance/payroll/export?weekStart=&format=` | `routes/payExport.ts` (U5, admin), mounted before `/finance` | 501 |
| `/auth/pin…`, `/auth/security-settings` | `routes/auth.ts` (U1) | not mounted yet (U1 adds them to its own router) |

Response cache (`CACHED_PATHS`): `/learning/progress`, `/learning/team`, `/learning/progression`, `/pitches`, `/search`.

Middleware slots on the `/api` router, in order after `authenticate`: `pinSetupGate(db)` (U1, `middleware/auth.ts`)
then `auditMiddleware(db)` (U3, `lib/audit.ts`), both pass-through. `purgeAuditLog(db)` (U3) runs at start-up and
daily from `index.ts` (removes nothing yet). `req.audit` (type `AuditRequestContext`, `lib/audit.ts`) is free for U3.

Optional fields on core types (U1): `LoginInput.pin`, `UserWithTeam.hasPin`, `UserWithTeam.pinSetupRequired`,
`UserWithTeam.twoFactorSetupRequired`.

`routes/gauges.ts` now exports `gaugeBody`, `assertFunnel`, `assertGaugeIntegrity`, `checkInFor` and `rateSnapshot`
(unchanged) so U2's bulk rows follow exactly the single-entry rules.

Test harness (`server/src/test/helpers.ts`): `srv.login(who, pin?)` sends `pin` only when given (or `who.pin`);
`TestClient.put(url, body)` for PUT routes. `server/src/test/r2-contracts.test.ts` (foundation) checks the extension
registry, idempotent upgrades, an unchanged core seed and that every 1.2 path is mounted behind requireAuth.

## Logic

### Database extensions (`server/src/db/extensions/`)

Each package with tables owns one file exporting `export const extension: DbExtension = { name, sql, upgrade, seed? }`
(contract in `extensions/types.ts`): `learning.ts` (L1), `pitches.ts` (L2), `pin.ts` (U1), `audit.ts` (U3),
`checkins.ts` (U4). `extensions/index.ts` (foundation) lists them in the fixed order learning, pitches, pin, audit,
checkins.

- `createSchema(db)` runs the core schema and core column upgrades, then for every extension its `sql`
  (`CREATE TABLE IF NOT EXISTS …`) and `upgrade(db)`. It returns the core column names followed by the extensions'
  changes as `<extension>:<name>` (e.g. `pin:users.pin_hash`). A second run returns `[]`. The smoke test's schema
  upgrade check compares core columns only (names without a colon).
- `upgrade(db)` adds columns to existing tables with `addColumnIfMissing(db, table, column, ddl)` and runs one-off data
  steps an already-seeded database needs, guarded with `metaFlag` / `setMetaFlag` (`ext:<name>:<step>`).
- `seed(db, ctx)` runs at the end of a fresh demo seed, inside the seed transaction, after every core row exists.
  `ctx` (`SeedContext`): `today`, `nowIso`, `users`, `teams`, `campaigns` (with `code`, e.g. 'BCN'), `events`, and
  `rng(salt)` — a random stream of the extension's own, so the core demo data stays byte-for-byte the same. Never
  insert gauge rows or payroll runs.

### Shared types (`shared/src/types/*.ts`, re-exported from `@lm/shared`)

- `learning.ts` (L1): STABLE `LESSON_KEYS` (21 keys, checklist order) / `LessonKey` and `LESSON_ANCHORS` (section ids:
  five-steps → introduction, short-story, presentation, close, consolidation; impulse-factors → greed, indifference,
  fear-of-loss, group-effect, urgency, power-of-suggestion; bullet-theory → no-money, no-time, other-charities,
  bank-details, direct-debit, cows, air, feel-felt-found, rrr; straight-line-theory → form, two-to-one). Also
  `LessonGroup`, `LessonState`, `LessonProgress`, `LearningProgress`, `LessonQuizInput`, `LessonQuizResult`,
  `TeachbackInput`, `TeachbackSignoffInput`, `TeamLearningRow`, `TeamLearning`, `CareerLevel`, `CAREER_LEVELS`,
  `ProgressionCriterion`, `ProgressionRequirement`, `Progression`.
- `pitches.ts` (L2): `CampaignPitch`, `PitchListItem`, `PitchUpsertInput`, `PitchStepKey`, `PitchStepTarget`,
  `PitchSegment`, `PitchTheoryKey`, `PitchAnnotation`, `PitchAnnotationRule`, `PitchBlock`, `PitchBranch`,
  `PitchScript`, `PitchFact`.
- `pin.ts` (U1): `PIN_MIN_LENGTH` 4, `PIN_MAX_LENGTH` 6, `SESSION_IDLE_HOURS_DEFAULT` 12 (`_MIN` 1, `_MAX` 72),
  `PinStatus`, `PinSetInput`, `SecuritySettings`, `LoginPinRequired`, `PinSetupRequiredError`.
- `bulk.ts` (U2): `BulkGaugeRow`, `BulkGaugeInput`, `BulkRowError`, `BulkGaugeResult`, `PasteMember`,
  `ParsedPasteLine`, `PasteParseResult`.
- `audit.ts` (U3): `AuditEntity`, `AuditEntry`, `AuditFieldChange`, `AuditEntryDetail`, `AuditPage`,
  `AnnouncementReadStats`.
- `checkins.ts` (U4): `ShiftCheckInSource`, `SHIFT_CHECK_IN_UNDO_MS` (2 minutes), `ShiftCheckIn`,
  `ShiftCheckInInput`, `ShiftCheckInList`. Named "shift" check-ins so they never clash with the 1.1 "Check in with…"
  list (`CheckInPerson`, `lib/smart/checkIns.ts`, `server/src/test/checkins.test.ts`).
- `search.ts` (U5): `SearchResultKind`, `SearchResult`, `SearchResponse`, `PayExportFormat`, `PayExportRow`.

### Shared logic modules (`shared/src/logic/`, registered in `logic/index.ts` by the foundation)

| Module | Owner | Exports now |
| --- | --- | --- |
| `learning.ts` | L1 | `isLessonKey` |
| `pitchScript.ts` | L2 | `PITCH_STEP_TARGETS` (intro 7–10 s, short story 10–15 s), stubs `parsePitchScript`, `parsePitchFacts` |
| `pitchAnnotations.ts` | L2 | `PITCH_ANNOTATION_RULES` (empty), `annotatePitchLine` |
| `pin.ts` | U1 | `isPinFormatValid` (4–6 digits) |
| `bulkPaste.ts` | U2 | stub `parseBulkPaste` |
| `audit.ts` | U3 | `AUDIT_REDACTED_KEYS`, stub `auditDiff` |
| `shiftCheckIn.ts` | U4 | `shiftCheckInStatus` (existing grace rule), `canUndoShiftCheckIn` |
| `search.ts` | U5 | `SEARCH_MIN_LENGTH` 2, `SEARCH_MAX_LENGTH` 60, `normaliseSearchQuery` |
| `payExport.ts` | U5 | stubs `payExportRows`, `payExportCsv` |

### Client

- API hooks, one file per package (`client/src/api/`): `learning.ts` (L1: `learningKeys`, `useLearningProgress`,
  `useTeamLearning`, `useProgression`, `useSubmitQuiz`, `useSubmitTeachback`, `useSignOffTeachback`), `pitches.ts`
  (L2: `pitchKeys`, `usePitches`, `usePitch`, `useSavePitch`), `pin.ts` (U1: `pinKeys`, `usePinStatus`, `useSetPin`,
  `useResetUserPin`, `useSecuritySettings`, `useUpdateSecuritySettings`), `bulk.ts` (U2: `useBulkGauges`), `audit.ts`
  (U3: `auditKeys`, `useAuditLog`, `useEntityHistory`, `useAnnouncementReads`, `useMarkAnnouncementRead`),
  `checkins.ts` (U4: `checkinKeys`, `useEventCheckIns`, `useCheckIn`, `useUndoCheckIn`), `search.ts` (U5:
  `searchKeys`, `useSearch`, `payExportUrl`). `api/hooks.ts` is not edited by any 1.2 package.
- Pages (lazy, in `App.tsx`): `/learning` `Learning.tsx` (L1, mounts L2's `PitchesSection`),
  `/learning/pack/:lessonKey` `LearningLesson.tsx` (L1), `/learning/pitch/:campaignCode` `LearningPitch.tsx` (L2),
  `/learning/progress` `LearningProgress.tsx` (L1), `/audit` `Audit.tsx` (U3, `AUDIT_ROLES` = admin),
  `/gauges/bulk` `BulkGauges.tsx` (U2, `BULK_GAUGE_ROLES` = admin, leader).
- Navigation (`components/layout/nav.ts`, icons in `Sidebar.tsx`): **Learning** (all roles, Workspace, GraduationCap)
  after Leaderboard; **Audit** (admin, Manage, History) after Team. Page titles: `COPY.nav.learning`, `COPY.nav.audit`,
  `COPY.nav.bulkGauges` (`content/copy.ts`).
- Slots (render nothing now; each mounted in an `ErrorBoundary` with `fallback={null}`):

| Slot | Owner | Mounted in |
| --- | --- | --- |
| `features/checkins/CheckInButton.tsx` `{ event, variant?: 'compact' \| 'row', className? }` | U4 | Quick gauges header (compact); dashboard Upcoming events, under each row dated today (row) |
| `features/checkins/CheckInRollCall.tsx` `{ event, canManage, className? }` | U4 | Event page, under "Not logged yet" |
| `features/learning/PitchLink.tsx` `{ campaignCode, campaignId?, variant?: 'compact' \| 'button', className? }` | L2 | Quick gauges header (compact); event page header actions (button) |
| `features/learning/PitchesSection.tsx` `{ className? }` | L2 | Learning hub, above the lessons |
| `features/learning/ProgressCard.tsx` `{ className? }` | L1 | Dashboard (rep, leader), under the KPI tiles and pay estimate (`className="mt-3"`) |
| `features/audit/EntityHistory.tsx` `{ entity, entityId, className? }` | U3 | Payslip modal end (`payroll_run`); Log gauges modal when an entry is open (`gauge_entry`) |
| `features/audit/AnnouncementReads.tsx` `{ announcement, className? }` | U3 | Each dashboard announcement, under the author line |
| `features/office/PayExportButton.tsx` `{ runs, className? }` | U5 | Finance → Company → Runs to pay header, before Export CSV |
| `features/gauges/BulkEntryLink.tsx` `{ className? }` | U2 | Gauges page header actions, leaders and admins |
| `features/settings/PinSettings.tsx` `{ className? }` | U1 | Settings → Security card, under two-step verification (`className="mt-4"`) |
| `features/settings/PinResetSection.tsx` `{ user, className? }` | U1 | Team → edit person (someone else), under the two-step reset |
| `auth/PinSetupGate.tsx` `{ children }` | U1 | `App.tsx` ShellLayout, wrapping the AppShell (pass-through) |

### Files each package may edit beyond its own new files

- L1: `client/src/content/learning/*`, `client/public/learning/*` (new).
- U1: `server/src/routes/auth.ts`, `server/src/middleware/auth.ts`, `client/src/pages/Login.tsx`,
  `client/src/auth/AuthProvider.tsx`, `docs/DEPLOY.md` (new).
- U4: the punctuality SQL in `server/src/lib/metrics.ts` (`punctualityFor`), `server/src/lib/smart/digest.ts` and
  `server/src/lib/smart/checkIns.ts` (check-in time = the shift check-in when present, else the gauge's
  `checked_in_at`); `client/src/features/gauges/LogGaugesModal.tsx` (prefill the check-in time).
- U5: `client/src/components/layout/Topbar.tsx` (QuickNav → command palette), `client/src/features/common/RangePicker.tsx`
  and the RangePicker container rows in the pages that use it.

## User guide

Nothing changes for anyone yet apart from two new items in the sidebar (and the mobile menu):

- **Learning** (everyone) opens the Learning page, which says **Coming soon** until the lessons and pitches are added.
- **Audit** (administrators) opens the audit trail page, which says **Coming soon** until it is built.
