# Release 1.4 — integration: two-step for everyone meets paying people

Packages S (security.md) and F + P + A (payments-*.md) were built side by side from 1.3.1. This fragment records how
they behave together on the merged code, so the docs stage words the combined release correctly. Tests:
server/src/test/r4-integration.test.ts (plus the payments tests, which now sign in with two-step like everyone).

## API

Nothing new. Two answers change because two-step is now required for every account that is not a demo sign-in account:

- `GET /me/bank-details` answers `codeRequired: true` for every such account (they all have two-step once past the
  setup gate), so `PUT /me/bank-details` and the admin's `PUT /users/:id/bank-details` need a current code from them.
  `codeRequired: false` is left only for a demo sign-in account that has not chosen to set two-step up.
- Every `/payments/*` route and every bank details route answers `403 { twoFactorSetupRequired: true }` (the setup
  gate, middleware/auth.ts) to an account that must use two-step and has not set it up — before any role check, write
  limit or audit step. A client account gets `403 { clientPortalOnly: true }` for all of them, set up or not.
- `POST /payments/batches/:id/approve` answers `403 twoFactorRequired` ("Set up two-step verification in Settings →
  Security first …") only to an exempt demo admin without two-step; any other admin without it never gets past the
  setup gate.

## Logic

- **The demo admin** is exempt from the sign-in rule but not from the payments rule: every payout needs a fresh code.
  The demo admin can set two-step up voluntarily (Settings → Security, the same setup as everyone); from then on each
  sign-in asks for the code, the session stays the demo's 14 days, and approving works with a fresh code. Switching it
  off again (only the demo accounts may) puts the hold on approving back.
- **The 14-hour sign-out and payments.** Approving is one request; once approved, a payment never depends on the
  admin's session. The payments job (every 5 minutes, server-side, no session) resends what a timeout left queued and
  checks statuses, marking runs paid as the approving admin, so a sign-out 14 hours after sign-in never interrupts it.
  A bank file approved before the sign-out is still there after signing in again, to download and mark paid.
- **Bank details for non-exempt accounts always need a code.** The "no code when you have no two-step" path of 1.4 F
  now applies only to demo sign-in accounts, because everyone else is held at the setup gate until two-step is on.
- **Client (charity) accounts** reach nothing of payments or bank details through the API (the client guard answers
  first, before the setup gate) and their portal answers carry no payment or bank field; the client app never routes
  them to the staff pages (Finance → Pay people, Settings → Bank details / Payments).

## User guide

- Bank details: "If you use two-step verification, a change needs your code" now reads, for everyone but the demo
  accounts, "A change needs the code from your authenticator app".
- Pay people (demo): the demo admin sees "Every payment needs a code from your authenticator app. Set up two-step
  verification first." with **Open Settings → Security** until two-step is set up.

## Changelog

- Changed: with two-step verification required for everyone, every bank details change and every payment approval
  needs a current code from the authenticator app; the demo admin sets two-step up in Settings → Security before
  paying anyone.

## Owner notes

- Before paying anyone from the demo admin account, set up two-step in Settings → Security (the demo accounts are
  exempt from the sign-in rule, not from the payment rule). If you switch it off again, approving is held again.
- Being signed out 14 hours after signing in never stops a payment you already approved: Linear Hub keeps checking it
  every 5 minutes on its own (unless `LM_PAYMENTS_JOB=0`) and marks the weeks paid; sign in again to see it finished.
