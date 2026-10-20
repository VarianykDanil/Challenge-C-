# U1 sign-in-pin: a personal PIN, stronger sessions, deploy guide

A person may add a 4–6 digit PIN to their sign-in (email + employee ID + PIN). An administrator can require a PIN for
everyone, require two-step verification for administrators, choose how long an unused device stays signed in, and
reset someone's forgotten or locked PIN. Everything is off by default, so existing accounts, tests and the four demo
accounts sign in exactly as before. `docs/DEPLOY.md` (new) explains how to put Linear Hub on the internet with HTTPS.

## API

All in `server/src/routes/auth.ts`; types in `shared/src/types/pin.ts`.

| Method | Path | Who | Body → answer |
| --- | --- | --- | --- |
| POST | `/auth/login` | anyone | `{ email, employeeId, pin? }` → `200 { user }` / `200 TwoFactorChallenge` as before. For an account **with a PIN**: no PIN → `200 LoginPinChallenge { requiresPin: true, attemptsLeft }` and no cookie (step two, like the two-step challenge); wrong PIN → `401`, locked → `423`, both with `LoginPinRequired` (below). A PIN sent for an account without one is ignored. |
| GET | `/auth/pin` | signed in | → `PinStatus { hasPin, setAt, required, locked }` (yours) |
| POST | `/auth/pin` | signed in | `{ pin, currentPin? }` → `204`. Sets a first PIN, or changes it (`currentPin` required once you have one). Signs out every **other** session of yours. `400` with `details: [{ path: 'pin' \| 'currentPin', message }]` for a refused PIN, a missing or wrong current PIN, or the same PIN again; `423` when your PIN is locked; `429` after 6 wrong current PINs in 15 minutes. |
| POST | `/auth/pin/remove` | signed in | `{ currentPin }` → `204`. `409` while a PIN is required for everyone, or when you have none; wrong PIN as above. |
| GET | `/auth/pin/:userId` | admin | → `PinStatus` of anyone (never the PIN or hash); `404` unknown user, `400` bad id |
| POST | `/auth/pin/reset/:userId` | admin | → `204`: clears the PIN and its lock, signs the person out everywhere. `400` for yourself (use Settings), `404` unknown. |
| GET | `/auth/security-settings` | admin | → `SecuritySettings { requirePin, requireAdminTwoFactor, sessionIdleHours }` (defaults `false, false, 12`) |
| PUT | `/auth/security-settings` | admin | `Partial<SecuritySettings>` (strict: unknown keys `400`; `sessionIdleHours` a whole number 1–72) → the full settings. `409` when switching on `requirePin` without your own PIN, or `requireAdminTwoFactor` without your own two-step verification. Switching `requireAdminTwoFactor` on signs out every other administrator who has not set up two-step verification. |
| POST | `/auth/2fa/disable` | signed in | unchanged, plus `409` for an administrator while two-step verification is required for administrators |

`LoginPinRequired` (401 / 423):

```json
{ "error": "That PIN is not right", "requiresPin": true,
  "details": { "requiresPin": true, "reason": "wrong", "attemptsLeft": 9 } }
```

`reason` is `wrong` or `locked` (`attemptsLeft` is absent when locked). The flags are repeated in `details` because
the client's `ApiError` keeps only `error` and `details`. A wrong employee ID still answers the plain
`401 Invalid email or employee ID` and never mentions a PIN. The PIN challenge is a 200 so the everyday sign-in of a
person with a PIN logs no failed request in the browser console.

`/auth/me` and the login responses' `user` now carry the caller's own `hasPin`, `pinSetupRequired` and
`twoFactorSetupRequired` (the optional fields the foundation added to `UserWithTeam`). No other user row carries them.

**The gate** (`pinSetupGate` in `server/src/middleware/auth.ts`, mounted after `authenticate`):

- While `pinSetupRequired`: every `/api` request answers `403 { "error": "Create your PIN to carry on", "pinSetupRequired": true }`
  except `/health`, `/auth/me`, `/auth/logout`, `/auth/login`, `/auth/login/2fa`, `/auth/demo-accounts` and
  `/auth/pin` (GET and POST). The client's `PIN_SETUP_REQUIRED_EVENT` fires on that body.
- Then, while `twoFactorSetupRequired` (an admin, when required): the same list plus `/auth/2fa`, `/auth/2fa/setup`
  and `/auth/2fa/enable`; everything else answers `403 { "error": "Set up two-step verification to carry on", "twoFactorSetupRequired": true }`.
- Anonymous requests pass through (requireAuth answers them). Paths are compared lower-cased without trailing slashes,
  and anything not listed stays closed.

Database (`server/src/db/extensions/pin.ts`, columns only): `users.pin_hash`, `users.pin_set_at`,
`users.pin_failed_attempts` (default 0), `sessions.last_seen_at`. Settings are the `meta` keys `ext:pin:require-pin`,
`ext:pin:require-admin-2fa` and `ext:pin:session-idle-hours`, written only by the PUT above (absent → default). No seed
rows: the demo accounts have no PIN.

## Logic

**Hashing** (`server/src/lib/pin.ts`). scrypt from `node:crypto`, N = 2^14, r = 8, p = 1, a fresh 16-byte random salt,
32-byte key, stored as `scrypt$16384$8$1$<salt>$<key>` (base64) so the cost can be raised later without a migration.
It runs on the libuv thread pool (no event-loop stall) and is compared with `timingSafeEqual`. A malformed PIN or
hash is a mismatch. Nothing logs or returns a PIN or hash.

**PIN rules** (`shared/src/logic/pin.ts`, the same on the phone and the server, checked in this order):
`format` 4–6 ASCII digits → `repeated` one digit only (0000, 777777) → `sequence` a run up or down by one (0123, 9876,
543210; 7890 is not a run) → `common` one of 27 most-guessed PINs that the first rules miss (1212, 1004, 2000, 6969,
2580, 123123, 159753, …) → `employee-id` the PIN contains, or is contained in, the digits of your employee ID when
they are at least four long (LM-0042 refuses 0042 and 004299). The first broken rule's message is the refusal.

**Sign-in with a PIN.** After the email and employee ID match (and the account is not `left`):

1. The PIN is locked (`pin_failed_attempts ≥ 10`) → `423 locked` (counted against the login limiter).
2. No PIN sent → `200 { requiresPin: true, attemptsLeft }`, no cookie (counted against the login limiter, so the
   answer cannot be used to test email and employee ID pairs faster than a wrong ID).
3. Otherwise the attempt is counted **before** the hash is awaited — a login-limiter failure and `pin_failed_attempts + 1`
   — so a burst of parallel guesses meets both limits one request at a time. A right PIN resets the count to 0 (and
   the login counters once the sign-in completes, after the two-step code if the account has one); a wrong one
   answers `401 wrong` with `attemptsLeft = 10 − count`, or `423` on the tenth.

Rate limits are the login's own: 8 failures per (source address, email) in 15 minutes, 20 per email from anywhere,
then `429`. The PIN lock is separate and persistent: 10 wrong PINs **in a row**, across every device and restart,
lock it until an administrator resets it (a forgotten PIN takes the same route). Wrong current PINs in Settings count
towards the same lock, plus 6 per user in 15 minutes → `429`.

Worked example: a stranger who knows a rep's email and employee ID can try at most 8 PINs from one address in 15
minutes before `429`, and 10 in total before the PIN locks: about a 1-in-1,000 chance against a 4-digit PIN that passes
the rules. The rep then asks an admin for a reset. Without the lock the login limiter alone would allow 20 guesses per
15 minutes from rotating addresses, nearly 2,000 a day.

**Require a PIN for everyone.** `pinSetupRequired = requirePin && !hasPin`, recomputed on every request from the
session's user row (no stale flag). Sign-in still succeeds for someone without a PIN; the gate then holds them at
"Create your PIN". An open session meets the gate on its next request. Setting a PIN lifts it at once.

**Require two-step for administrators.** `twoFactorSetupRequired = requireAdminTwoFactor && role = admin && two-step
not on`. Switching it on needs your own two-step on (409 otherwise) and signs out the other administrators without it,
so they meet the setup step at their next sign-in. While it holds, an administrator cannot turn two-step off (409); an
administrator's lost-device reset (`POST /users/:id/2fa/reset`) still works and they set it up again at sign-in.

**Sessions.** A session ends when it is 14 days old (unchanged) **or** idle for longer than the admin's
`sessionIdleHours` (default 12, 1–72), measured on the real clock from `sessions.last_seen_at` (else `created_at`). The
check is strict (exactly on the limit is still alive). `authenticate` deletes an idle session on sight (→ 401) and
refreshes `last_seen_at` at most once a minute (`LAST_SEEN_RESOLUTION_MS`), so the timeout costs one small write a
minute per active session, not one per request. The 15-minute sweep (`purgeExpiredSessions`) also deletes idle
sessions. Setting or changing a PIN signs out your other sessions; an admin PIN reset signs the person out everywhere.
When the column is first added, sessions opened before 1.2 count as seen at the upgrade, so the new timeout does not
sign everyone out at once.

**Settings reads** are cached per database and dropped whenever the data version moves (every write request bumps
it), so a change applies on the very next request and a read-only request costs no extra query.

**Client.**
- `pages/Login.tsx`: a PIN step between the credentials and the two-step code (masked digits-only field with a show
  button, password-manager friendly). Wrong PIN → "That PIN isn't right" plus "N tries left before your PIN locks" when
  3 or fewer remain; locked or `429` → the field stays disabled with the reason until Back.
- `auth/PinSetupGate.tsx` (around the signed-in shell) shows the lazy full-screen steps from `auth/PinSetupStep.tsx`:
  "Create your PIN" (PIN twice, the shared rules as you go) and, for administrators, "Set up two-step verification"
  (the Settings setup modal). Once that modal opens, the step stays until it closes, so the recovery codes are never
  swept away when /auth/me stops asking. It listens for `PIN_SETUP_REQUIRED_EVENT` and re-reads /auth/me (one request
  at a time).
- `auth/AuthProvider.tsx`: a signed-in tab coming back to the front re-reads /auth/me (at most once a minute), so an
  idle-expired or reset session shows the sign-in page straight away.
- `features/settings/PinSettings.tsx` (Settings → Security) and `PinResetSection.tsx` (Team → edit person).
- Main chunk 445 kB, under the 460 kB budget: the gate is small and the steps, Settings and Login are lazy chunks.

## User guide

**Everyone — your PIN (Settings → Security → Sign-in PIN).** Tap **Set a PIN**, type 4 to 6 digits twice and save.
Avoid 1234, 0000, the most common PINs and the digits of your employee ID; the screen tells you which rule a PIN breaks.
From then on, signing in asks for your email and employee ID, then your PIN. Setting or changing your PIN signs you
out on your other phones and laptops. **Change PIN** asks for the current one; **Remove** (when your administrator
does not require PINs) takes you back to email and employee ID only.

**Signing in.** After your email and employee ID, the "Enter your PIN" screen appears if you have one. Ten wrong PINs in
a row lock it: ask an administrator to reset it, then sign in with your email and employee ID and choose a new PIN.
If you are away from Linear Hub for longer than the sign-out time (12 hours unless your administrator changed it), you
sign in again.

**When your administrator requires a PIN.** The next time you open Linear Hub you see **Create your PIN** instead of the
app. Type a PIN twice and tap **Save PIN**; you carry on where you were. **Sign out** is there if you are on someone
else's phone.

**Administrators — Settings → Security → Sign-in rules.**
- **Require a PIN for everyone.** Set your own PIN first (the switch says so). Everyone without a PIN, including people
  signed in right now, creates one before they can carry on. Demo accounts too.
- **Require two-step verification for administrators.** Turn on your own two-step verification first. Other
  administrators without it are signed out and set it up when they next sign in; while the rule is on, administrators
  cannot turn their own two-step off.
- **Sign out after inactivity.** 1 to 72 hours (12 by default). Shorter is safer for shared phones.

**Administrators — resetting a PIN (Team → person → Edit profile → Sign-in PIN).** The badge shows **PIN set**, **No PIN**
or **Locked**. **Reset PIN** clears it and its lock and signs them out everywhere; they sign in with their email and
employee ID and choose a new PIN (straight away, if a PIN is required).

**Leaders, recruiters and reps** see only their own PIN card; the rules and resets are for administrators.

**Putting Linear Hub online.** `docs/DEPLOY.md`: a small UK/EU server with Caddy (automatic HTTPS) or Fly.io / Render,
with costs, backups off the server and a go-live checklist.
