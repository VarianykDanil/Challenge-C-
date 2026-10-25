# Release 1.4 — package S: two-step verification for everyone, 14-hour sign-in

The owner's decisions, in his words: "charity must have 2fa and same as everyone who log ins" and "every 14 hours
everyone gets signed out and they have to do log in and 2af". Asked how the code is given: an authenticator app (no
email or SMS codes). The demo sign-in accounts are left out while Linear Hub is still the demo, so one-click demo
sign-in keeps working on the owner's Mac.

## API

All additive: no field renamed or removed; the new fields are optional in the shared types (a 1.4 server always sends them).

- **`POST /auth/login`, `POST /auth/login/2fa`** — unchanged steps (credentials → PIN when the account has one → the
  6-digit code when two-step is on). The signed-in answer is now `{ user, session }`; `session: SessionInfo` is
  `{ signedInAt, endsAt, maxHours }` (`maxHours: null` for a demo sign-in account, whose session lasts 14 days). The
  `Set-Cookie` Max-Age equals the session: `sessionMaxHours` hours (default 14 h = 50400 s), 14 days for a demo account.
  `user.twoFactorSetupRequired` is now true for **every** account without two-step, except the demo sign-in accounts.
- **`GET /auth/me`** → `{ user, session }` (the same `SessionInfo`). `endsAt` is when this session really ends and
  `maxHours` the hours that end it: the current setting, or — for a session signed in under a shorter limit than
  today's (the admin raised it since) — the session's own hours, since its expiry and cookie were fixed at sign-in.
- **The session limit's 401.** The request that finds a session past its hours-from-sign-in limit answers
  `401 { error: "For security you are signed out 14 hours after signing in. Sign in again to carry on.", details: {
  sessionEnded: "max_age", maxHours: 14 } }` (shared `SessionEndedDetails`, `sessionMaxAgeMessage(hours)`), deletes
  the session and clears the cookie; every later request is a plain 401. Any route behind `requireAuth` /
  `requireRole` answers it, `/auth/me` included. The same goes for a session that still sends its cookie after its own
  4–24-hour expiry (signed in before the admin raised the limit): `maxHours` is then the shorter of its own hours and
  the current setting.
- **`GET /auth/2fa`** → `TwoFactorStatus` plus `required: boolean` (true for every account but the demo sign-in ones).
- **`POST /auth/2fa/disable`** → `409 "Two-step verification is required for every account, so it cannot be turned
  off. If you have lost your phone, ask an administrator to reset it."` for an account that must use it (checked
  before any code, so no code is spent or recorded). The demo sign-in accounts may still switch it off with a code.
- **`GET/PUT /auth/security-settings`** (admin) — `SecuritySettings` gains `sessionMaxHours` (whole hours 4–24, default
  14; 400 outside that, for a fraction or a string). It applies at once (a session already older than a shorter limit
  ends at its next request) and to every sign-in from then on; a longer one applies from each person's next sign-in
  (a session's expiry and cookie are fixed when it starts). `requireAdminTwoFactor` is still read, returned and
  accepted (no data loss) but decides nothing: no lock-out check, nobody signed out. Leader, recruiter, rep → 403;
  client → 403 (client guard); anonymous → 401.
- **New: `POST /client-accounts/:id/reset-2fa`** (admin) → `ClientAccount`. A lost or new phone: clears the client
  account's two-step verification (secret, pending secret, recovery codes, open sign-in challenges) and signs it out
  everywhere; it sets two-step up again at its next sign-in, after the PIN. 404 for an unknown id or a staff member's
  id; leader / recruiter / rep 403; a client session 403 `clientPortalOnly`; anonymous 401. Audit spec
  (`lib/audit/securitySpecs.ts`): "Reset the two-step verification of Ivy Invite (Breast Cancer Now); they set it up
  again at their next sign-in" (entity `client_account`, snapshots with `twoFactor` true → false, never a secret).
  Under the per-person write limit (60 a minute).
- **`POST /users/:id/2fa/reset`** (admin, staff) — unchanged, but its effect changes with the rule: the person sets
  two-step up again at their next sign-in. Your own id is still 400, now with: "You cannot reset your own two-step
  verification here. Sign in with a recovery code and make new codes in Settings → Security, or run "npm run
  2fa:reset -- <your email>" on the server."
- **New server command: `npm run 2fa:reset -- <email>`** (`server/src/twoFactorReset.ts`, like `npm run pin:reset`) —
  the way back in when no administrator can reset it in the app (the only administrator lost phone and recovery codes,
  or the app secret was lost, so no authenticator code matches). Clears that person's two-step (secret, half-done
  setup, recovery codes, open sign-in challenges), signs them out on every device and writes an audit row (no actor,
  action `npm run 2fa:reset`, "Reset two-step verification from the server command: Danil Varianyk"; snapshots say
  only `twoFactor`, never a secret). The PIN is left alone. Honours `DB_PATH`; exit 0 when done or nothing to reset, 1
  for no email, no database, a file that is not a Linear Hub database, or no one with that email. Works while the
  server runs.
- **`POST /users` `signInInstructions`** and **`POST /campaigns/:id/client-accounts` `instructions`** (shared
  `staffSignInInstructions`, `clientInviteInstructions`) end with the two-step setup step, after the PIN step when
  there is one: "The first time, set up two-step verification. You need an authenticator app on your phone (Google
  Authenticator, Microsoft Authenticator, 1Password or Authy): scan the code Linear Hub shows, type the 6-digit code
  from the app and keep your recovery codes somewhere safe. Each time you sign in after that, you type a new code from
  the app." ("Then set up …" after a PIN step), and the closing line names the recovery codes and what to do about a
  lost phone. Neither text is ever for a demo sign-in account (a new person or a new client account never is one).
- **`ClientAccount`** (`GET /campaigns/:id/client-accounts`, the campaign page, the client account routes) gains
  `twoFactorEnabled`.
- **The client guard** now lets a client session reach `/auth/2fa` and `/auth/2fa/*` (its own two-step: status,
  setup, enable, new recovery codes, disable). Everything else outside the portal stays 403 `clientPortalOnly`.
- **The setup gate** (`middleware/auth.ts pinSetupGate`) holds every API, the client portal's `/client/*` included,
  with `403 { error: "Set up two-step verification to carry on", twoFactorSetupRequired: true }` until two-step is on;
  open meanwhile: `/auth/me`, `/auth/logout`, the sign-in routes, `/auth/demo-accounts`, `/auth/pin`, `/auth/2fa`,
  `/auth/2fa/setup`, `/auth/2fa/enable`, `/health`. (The PIN step, when a PIN is required, comes first, as before.)

## Logic

### Who must use two-step verification

`lib/demoTeams.ts isDemoSignInAccount(db, user)`, next to `demoStepAllowed`: true only while Linear Hub is still the
demo — `LM_DEMO_ACCOUNTS` is not `0`, the database is one the demo seed built (`seeded_at` and `seed_today`), its core
rows exist and the four demo staff are intact (present, those roles, none left) — **and** the account is one the
sign-in page's demo buttons list: one of the four by employee ID and role (`DEMO_STAFF`), a team Sapiens account by
its marker (`seed_demo_teams`: same id, employee ID and email; staff), or the demo charity account by its marker
(`seed_demo_clients`, `matchesDemoClient`). Everyone else must use two-step — anyone Matt adds, every invited client,
even on the demo database — and nobody is exempt once the database is in real use (a demo person left or changed
role) or with `LM_DEMO_ACCOUNTS=0`. The database part is cached per data version (every write request moves it), so
the check costs nothing per request.

`lib/pin.ts accountFlags`: `twoFactorSetupRequired = !twoFactorEnabled && !demoSignIn` for every role. The PIN rule is
unchanged. Every sign-in of an account with two-step on asks for the code: there is no "remember this device".

### The 14-hour session

- **A session ends `sessionMaxHours` (default 14) after sign-in, whatever the activity** — `last_seen_at` (the idle
  timeout's clock) never moves it. Real clock, like the idle timeout and the PIN lock. Shared
  `isSessionPastMaxAge(signedInMs, nowMs, hours)`: at exactly the limit the session has ended (13:59 alive, 14:00 and
  14:01 ended); an unreadable sign-in time counts as ended.
- **New sessions** (`middleware/auth.ts createSession`) get `expires_at = sign-in + sessionMaxHours`, and the cookie
  the same Max-Age. A demo sign-in account keeps the 14-day session.
- **Every request** (`authenticate`) checks the limit against the session's `created_at` and the *current* setting, so
  a shorter setting applies at once and a session from before 1.4 (14-day `expires_at`) older than 14 hours ends at its
  next request. That request gets the 401 with the reason, the session is deleted and the cookie cleared. When a
  session is both idle and over the limit, the limit is named.
- **A longer setting applies from the next sign-in.** A session keeps the `expires_at` and cookie it got at sign-in, so
  after the admin raises the limit (say 14 → 24) a session signed in under 14 still ends at 14 hours. Its own lifetime
  (`expires_at − created_at`, rounded to whole hours) is what `/auth/me` reports as `maxHours` while it is shorter than
  the current limit, so the sign-in page's sentence names the 14 hours that really applied. A request that still
  carries the cookie after that expiry — a session 1.4 made with a limit (own lifetime 4–24 hours, never a demo
  account's or a 1.3 session's 14 days) — is ended as the limit too: the 401 with the reason and one audit row, naming
  the shorter of its own hours and the current setting (as the sweep does).
- **Audit**: each automatic sign-out is one row, action `SESSION max-age`, kind `sign_in`, filed under the person, no
  actor needed: "Signed out 14 hours after signing in (signed in 07:02 Fri 23 Oct)" (London time). Written by the
  request that ends the session, and by the start-up / 15-minute sweep (`purgeExpiredSessions`) for sessions whose limit
  and cookie ran out unused — **one row per person**, however many devices (only sessions 1.4 made with a limit, never
  a demo account's or a 1.3 session's 14 days, which go quietly as before). It is not the person being active:
  `GET /audit/person` leaves it out of `lastActiveAt`, and `signIns=0` leaves it out with the other sign-in rows.
- **The sign-in page says why** (`client/src/api/sessionEnd.ts`): from the 401's reason, or — usually, because the
  browser drops the cookie at the same moment — from the end time the server gave at sign-in and on `/auth/me`
  (`session.endsAt`, kept in localStorage per device; a plain 401 within 2 minutes of it or after it is the limit).
  Signing out by hand forgets it. `/` goes to the sign-in page rather than the public landing page while there is
  something to say; the generic "Your session has ended" toast is skipped then.

### Nothing lost in the field

- **Gauge outbox** (`features/gauges/outbox.ts`): already one localStorage key per person (`lm-gauge-outbox:<userId>`),
  kept across a sign-out and replayed when the app mounts after sign-in. A 401 stops the replay with every item still
  waiting; new in 1.4: so does the setup gate's 403 (PIN or two-step still to set up), which used to mark an item
  failed.
- **Check-in outbox**: already per person and stops on 401; the gate's 403 for two-step now also keeps the item
  waiting (`api/client.ts` announces `twoFactorSetupRequired` with the same event as `pinSetupRequired`).
- **Log gauges**: a save answered 401 (signed out as it was sent) is kept on the phone and sent after the next sign-in
  ("Saved on this phone — it sends after you sign in again"). Counts typed but not saved when the form goes away
  without a save or a close — the app moved to the sign-in page, the tab was hidden or dropped — are kept for 24 hours
  (`features/gauges/gaugeDraft.ts`, `lm-gauge-draft:<userId>`) and the next Log gauges (that event, or none fixed)
  starts from them: "These are the counts you had typed but not saved. Check them, then save." Saving or closing
  forgets them.
- **The one-tap check-in**: a tap answered 401 is kept on the phone too.
- **An open session** that meets the two-step gate (after the upgrade) re-reads `/auth/me` and shows the setup step
  without a reload, as the PIN step already did.

## User guide

### Two-step verification is now on for everyone

Linear Hub asks everyone who signs in for a 6-digit code from an authenticator app (Google Authenticator, Microsoft
Authenticator, 1Password or Authy) — administrators, team leaders, recruiters, field reps and charity and client
accounts alike. If you have not set it up, the next time you sign in you see **Set up two-step verification**: tap
**Set up now**, scan the code with your app (or type the key), enter the 6 digits it shows, and save your 10 recovery
codes somewhere safe. It takes about two minutes and you do it once.

From then on every sign-in is your email and employee ID (charity and client accounts: email and access code), your
PIN if you have one, then the code from your app. There is no "remember this device": each sign-in asks for the code.

Lost your phone? Sign in with one of your recovery codes instead of the code ("Use a recovery code instead"). If you
have none left, ask an administrator to reset two-step verification (staff: **Team › Edit › Reset two-step
verification**; charity and client accounts: the campaign page's **Client accounts** card, **Reset two-step**). You then
set it up again, with a new code, at your next sign-in. An administrator who has lost both phone and codes, with no
other administrator to ask, runs `npm run 2fa:reset -- <their email>` on the computer Linear Hub runs on. Two-step cannot be turned off: **Settings → Security** shows
it as **Required**, with **New recovery codes**.

Charity and client accounts see the same in the client portal's **Security** page.

### Adding someone or inviting a charity contact

The sign-in instructions Linear Hub gives you to send a new person (Team › **Add person**) or a new charity or client
contact (the campaign page's **Client accounts** card › **Invite**) now include the last step: set up two-step
verification with an authenticator app at the first sign-in, and keep the recovery codes safe.

### Signed out 14 hours after signing in

For security, everyone is signed out 14 hours after signing in, however busy they are, and signs in again with their
code. The sign-in page then says: "For security you are signed out 14 hours after signing in. Sign in again to carry
on." Sign in at the start of a shift and you are fine for the whole day.

Nothing is lost: gauges saved without signal or as you were signed out wait on your phone and send after you sign in
again; counts you had typed into **Log gauges** but not saved are there the next time you open it.

The demo sign-in buttons on the sign-in page work as before (no code, 14-day sessions) while Linear Hub is the demo.

### For the administrator: Settings → Security → Sign-in rules

- **Two-step verification is required for everyone** — a plain line now; the old switch "Require two-step
  verification for administrators" is gone.
- **Sign out after** — 4 to 24 hours from sign-in (default 14 hours). A shorter time applies at once, to everyone
  already signed in too; a longer one from each person's next sign-in (anyone signed in now is still signed out at the
  old time, and the sign-in page names it).
- **Sign out after inactivity** — unchanged (default 12 hours).

## Changelog

### [1.4.0]

#### Added
- Two-step verification (authenticator app) is required for every account that signs in — administrators, team
  leaders, recruiters, field reps, and charity and client accounts. Anyone without it sets it up at their next
  sign-in; a charity or client account sets it up after its PIN. The demo sign-in accounts are left out while Linear
  Hub is still the demo.
- Everyone is signed out 14 hours after signing in, whatever they are doing, and signs in again with their code; the
  sign-in page says why. The administrator can choose 4 to 24 hours in **Settings → Security → Sign-in rules → Sign out
  after**.
- The client portal's **Security** page shows two-step verification (status, recovery codes left, **New recovery
  codes**, **Set up**).
- The campaign page's **Client accounts** card shows whether each account has two-step on, and **Reset two-step** for a
  lost phone.
- The automatic sign-out is recorded in the audit trail under the person ("Signed out 14 hours after signing in").
- `npm run 2fa:reset -- <email>` on the server switches off one person's two-step verification (they set it up again
  at their next sign-in), for when no administrator can do it in the app.
- **Log gauges** keeps counts typed but not saved when you are signed out with it open, and a save answered "signed
  out" waits on the phone and sends after the next sign-in; so does a one-tap check-in.

#### Changed
- "Require two-step verification for administrators" is replaced by the line "Two-step verification is required for
  everyone"; its stored setting is kept but no longer decides anything.
- Two-step verification can no longer be turned off (except on the demo sign-in accounts); **Settings → Security**
  marks it **Required**.
- Resetting someone's two-step verification now means they set it up again at their next sign-in (not that they sign
  in without it).
- The sign-in code and PIN steps of a charity or client account say "Back to email and access code".
- The sign-in instructions for a new person (Team › **Add person**) and a client invite (**Client accounts** ›
  **Invite**) end with setting up two-step verification with an authenticator app; the **Invite** and **Turn on**
  dialogs say so too.

## Owner notes

- **What happens at the upgrade.** Everyone without two-step verification — staff and every charity or client account
  you invited — is asked to set it up at their next sign-in, and anyone signed in at the moment of the upgrade meets the
  setup step at their next tap. Tell the team before you upgrade: they need an authenticator app on their phone
  (Google Authenticator, Microsoft Authenticator, 1Password or Authy) and about two minutes. Charity contacts need the
  same: the instructions Linear Hub gives you when you add a person or invite a client now include that step, but
  people you added or invited before 1.4 got the old text, so tell them.
- **Existing sessions older than 14 hours end at their next request** (sessions made before 1.4 lasted 14 days), with
  the same sentence on the sign-in page. Younger ones carry on until they are 14 hours old.
- **Until someone has set it up, their email and employee ID (and PIN, if they have one) still open the setup step.**
  Ask everyone to do it promptly. If someone sets it up on the wrong phone, or loses theirs, reset it: Team › person ›
  Edit › **Reset two-step verification** (staff) or the campaign page's **Client accounts** card › **Reset two-step**
  (charity and client accounts). Recovery codes let a person in without the phone; each works once.
- **Your own account.** The demo admin account (Danil Varianyk, LM-0001) stays exempt only while the database is still
  the demo. Once any of the four demo staff accounts leaves or changes role, or the server runs with
  `LM_DEMO_ACCOUNTS=0`, **every** account — yours included — must use two-step and the 14-hour sign-out. Set up your own
  two-step (Settings → Security → **Set up**) before that day, and keep your recovery codes somewhere safe: if you lose
  both your phone and your codes, another administrator can reset it for you, or — when there is no other
  administrator — run `npm run 2fa:reset -- <your email>` on the computer Linear Hub runs on (in the
  `linear-micro-crm` folder, with the same `DB_PATH` as `npm start`). It signs you out everywhere; you sign in with
  your email, employee ID and PIN and set two-step up again. It is in the audit trail as "npm run 2fa:reset".
  The same command is the way back if the app secret (`LM_APP_SECRET`, or the `server/data/app-secret` file) is ever lost: the
  authenticator secrets are encrypted with it, so no code would match (recovery codes still work).
- **The 14 hours** can be changed in Settings → Security → Sign-in rules → **Sign out after** (4 to 24 hours). It counts
  from sign-in on the real clock, whatever `LM_BUSINESS_NOW` says. A shorter time applies at once; a longer one only
  from each person's next sign-in (a session's end is fixed when it starts). The idle sign-out (default 12 hours) still
  applies on its own.
- **The demo sign-in accounts** (the four, team Sapiens' seven, Hannah Price) need no code and keep 14-day sessions while
  Linear Hub is the demo. The demo charity account stays exempt even if it sets a PIN (it is recognised by the demo
  seed's marker, the same as for the PIN rule), though the sign-in page lists it only while it has no PIN.
- **What was tested**: route tests for every rule and role (admin, leader, recruiter, rep, client, anonymous), the 14-hour
  boundary at ±1 minute, a session used a minute ago still ending at 14 hours, the setting's range, a raised limit (a
  session signed in under 14 still reports and ends at 14, with the reason and one audit row), the audit rows, the
  demo database against one in real use and `LM_DEMO_ACCOUNTS=0`, `npm run 2fa:reset` on a copied database; Playwright on the demo seed at 375 and 1440 px (768
  and 1024 for Log gauges), light and dark. Not tested on a real phone's authenticator app (codes were computed to the
  same RFC 6238 standard).
