# Linear Hub 1.5: notes for the owner

What the owner of Linear MCR needs to know, do or decide for 1.5. Release 1.5 answers the independent review of
1.4.0 and makes Linear Hub safe to go live with. The step-by-step for everyone is in
[USER_GUIDE.md, "What's new in 1.5"](USER_GUIDE.md#whats-new-in-15); the rules are in
[LOGIC.md §18](LOGIC.md#18-release-15); the go-live runbook is [DEPLOY.md](DEPLOY.md).

## What changed, in one screen

| Area | What it means for you |
| --- | --- |
| **Trial mode** | A new Linear Hub holds an invented demo company so everyone can try it. Administrators see a banner until you go live. The one-tap demo accounts can only play with the demo company: never your own people, real pay, bank details, payments or settings. |
| **Going live** | `npm run golive` (on the server, `sudo linear-hub golive`) ends the trial: it backs up first, removes the demo company, keeps your settings, your own people and everything made during the trial, makes you the first owner with a one-time setup code, and signs everyone out. |
| **Setup codes** | Every new account, and every reset, gets a one-time setup code (7 days, used once). Knowing someone's email and employee ID is no longer enough to start their account. |
| **Your own code for sensitive changes** | Making or stopping an administrator, setting one as left, changing someone's email or employee ID, resets and setup codes ask for your fresh two-step code. |
| **Secure connections** | Bank details, payments, setup codes and resets only work on the computer that runs Linear Hub or over https. Built-in HTTPS is available, but the supported way online is the server in [DEPLOY.md](DEPLOY.md). |
| **The app key** | Linear Hub now refuses to start with a missing or wrong key instead of quietly making a new one (which would have lost every bank detail and sign-in). The key goes on a printed **recovery sheet**, made on the server only. |
| **Backups** | Every backup now holds the uploaded files too (statement PDFs, the signature image), and can be copied **off-site, encrypted** with a passphrase. Restore warns before it forgets any payment. **System health** in the bell says when something is wrong. |
| **Money** | Days logged with no booking or check-in wait for a leader (**Days to confirm**). Bank details someone else typed in wait for the person. **Two people approve each payment** once two administrators use two-step. Bank files start in test mode with a **1p test file**; a downloaded file counts as sent. **VAT** on self-billed invoices, once the office has checked the number. Days off and leaving dates for office staff. The payroll export is honestly a spreadsheet, not a Xero or Sage import file. |
| **Phones** | On the https address Linear Hub works with no signal once it has been opened with signal, even after an update or while the server restarts. **Add to Home Screen** gives an app icon. Tables are cards on a phone. A **Today** card and a **Check in at …** reminder for reps and leaders. |
| **Documents and installer** | `deploy/install.sh` sets up a small Ubuntu server with HTTPS, a firewall, automatic security updates and encrypted off-site copies; [DEPLOY.md](DEPLOY.md) is the runbook. The documents now say truthfully who built Linear Hub and how ([TEAM.md](TEAM.md)); Linear Hub is © Noryn System Ltd, licensed to Linear MCR Limited (`LICENSE`). |

## Decisions for you

Nothing here blocks the trial; each is a small change once you decide.

1. **A base day's evidence can still be self-made.** A day logged with gauges pays a base day when the person was
   booked on the event or checked in. A rep can book themselves onto an event (until the event day) or check in
   themselves, then log one stop, and the day is paid without a leader. Counting only bookings a leader made would send
   most honest days to **Days to confirm**. **After the trial, do you want only leader bookings to count?**
2. **The recovery sheet is made on the server, not in the app.** A first version let the owner make the sheet in
   Settings with a two-step code. The review found that against the rule that secrets are never returned by the app,
   so it was removed: Noryn makes the sheet with you on the server computer. **If you want it back in the app, that
   needs your explicit agreement to relax that rule.** We recommend keeping it as it is.
3. **Two approvals and a departing administrator.** Turning "Two people approve each payment" off needs a second
   administrator while two use two-step. An administrator who can mark the other as left (which needs their own code)
   or reset their two-step can then turn it off alone; the audit trail records each step. **Tell us if you want
   setting another administrator as left to need a second administrator too.**
4. **VAT for VAT-registered self-employed reps.** Ask your accountant how to treat VAT before the first such pay run.
   Linear Hub charges 20% on the invoice total once the office has checked the number on HMRC's service; it does not
   ask HMRC itself.
5. **The GitHub repository.** Dependabot and the weekly CI run only work from the repository's default branch, which is
   still an older, unrelated project. Make Linear Hub's branch the default (Settings → General → Default branch) or move
   Linear Hub to a private repository of its own, then switch on **Dependabot alerts** and **Dependabot security
   updates** (Settings → Code security). Until then nothing checks for new security advisories between changes.

## Before you update from 1.4

- **Run `npm run backup` first.** This one update is run by 1.4.0's own updater, which makes no backup and does not stop
  the background service. From 1.5 on, `npm run latest` does both itself.
- **What the first start of 1.5 changes:**
  - The database records the app key's fingerprint, after checking the key against the bank details already there.
  - Sessions are stored as a hash. Nobody with two-step is signed out; a real account without two-step is signed out at
    its next request and signs in again with a setup code (its 1.4 session was made without one).
  - A database the 1.4 demo seed built is put in **trial mode**. The 1.4 demo owner LM-0001 becomes a restricted one-tap
    demo account: it loses the sensitive actions and `npm run golive` removes it. Go live, then sign in as the owner
    golive makes (you may use the same email again). The 1.4 starter team accounts are kept as your own.
  - **Every real account without two-step verification needs a setup code** at its next sign-in: give one from **Team
    → the person → Edit profile → Sign-in setup → Give a setup code**, or `npm run setup-code -- <email>` on the server.
  - Bank details an administrator typed in and confirmed themselves in 1.4 wait again, for the person (**Yes, these are
    mine**) or a second administrator. Check **Team → each person → Bank details**.
  - A VAT number typed in 1.4 adds no VAT until the office checks it (a bell item each).
  - Every day already logged counts as confirmed; the day check applies from now on, so no existing pay changes.
  - With two or more administrators using two-step, "Two people approve each payment" is stored as on.
  - A bank file connection that was live stays live; new ones start in test mode.
  - Records made during a trial week on 1.4 (candidates, announcements, expenses, statements, client IDs on demo
    campaigns) are kept by `npm run golive`.
- With the background service installed and `LM_APP_SECRET` in use, run `npm run service:install` once more so the key
  moves into a private file; later rebuilds keep it.

## Before going live: in this order

1. **Agree the go-live package.** Going online is outside the signed agreement: Noryn quotes it as a fixed-price package
   and both companies sign a short variation first ([DEPLOY.md §1](DEPLOY.md)).
2. **The HTTPS server.** A small UK/EU server in Linear MCR's name, set up with `deploy/install.sh`: Caddy gives HTTPS,
   Linear Hub listens on 127.0.0.1 only, one-tap demo sign-ins are off. Reps then use Linear Hub on 4G at any venue, and
   "works with no signal" works (it needs https). The office Mac is for the trial week only.
3. **Bring the trial database across and go live.** `sudo linear-hub import <file>.lhbk`, then `sudo linear-hub golive`:
   read what goes and what stays, type **GO LIVE**, and keep the setup code it prints. It signs everyone out: each
   person signs in again, with two-step or, until they have it, a setup code. Sign in, set up two-step
   verification, keep the recovery codes away from your phone.
4. **The recovery sheet.** With Noryn, over SSH: `sudo linear-hub recovery-sheet` shows the sheet; copy the key onto the
   paper (16 groups of 4), then `sudo linear-hub recovery-sheet --confirm` and type the **whole key** back from the paper.
   Settings › Backups then says **Printed and kept**. Lock the paper away like a bank card, not near the server. (On the
   trial Mac: `npm run recovery-sheet -- --print`, then `npm run recovery-sheet -- --confirm`.)
5. **Off-site backups.** The installer makes the off-site passphrase and shows it once: write it on a **separate**
   paper, kept apart from the recovery sheet. Turn on snapshots or versioning at the storage provider, agree how long
   copies are kept (90 days suggested), add the heartbeat check (required), then `sudo linear-hub restore-test` and
   write the date in the go-live checklist.
6. **Setup codes for everyone.** **Team → each person → Edit profile → Sign-in setup → Give a setup code** (your own
   code each time). Hand each code over privately. People added from now on get theirs in **Sign-in details**.
7. **The first test payments.**
   - **Bank file**: Settings → Payments → **Make a 1p test file**, type your own account and your code, upload it to
     your bank and approve it there, then press **The bank took it** (or **The bank refused it**). Switch the
     connection to live with **PAY FOR REAL**.
   - **Revolut, Wise or TrueLayer**: test the connection, make one test-mode payment through the provider's sandbox
     and wait for its answer, then switch to live, test the live keys, and make the first live run **one person, a
     small amount**. Changing the details in test mode means a new sandbox payment.
   - Check each person's bank details are confirmed (by the person, or a second administrator).
8. **Turn on two approvals.** Add a second administrator who uses two-step verification: "Two people approve each
   payment" switches on by itself and stays on. Check it in **Settings → Payments**. With one administrator it can be
   on, but live payments then wait for a second one.
9. **Habits.** Leaders look at **Pay → Days to confirm** before each payday. The office adds days off and leaving dates
   for office staff, checks VAT numbers in the bell, and looks at **Check before paying** on each payment.

## What was tested, and what was not

**Tested.** Each package was built test-first, reviewed independently, fixed, and then merged. On the merged release
1.5.0: the typecheck passes; the whole test suite passes (1,704 tests: 564 shared, 1,083 server, 57 client, none
failing); the end-to-end API check passes 82 of 82 checks; and the production build passes with no warnings. Before
merging, each package also ran its own checks:

- going live on a copy of a real-shaped 1.4 trial-week database: the candidate, announcement, expense and a rep's client
  ID on a demo campaign all stayed;
- demo accounts refused on every money, people and settings action they tried, run live from the Wi-Fi address;
- the phone app with the server really stopped (not a simulated offline): every page opens, check-ins are kept and sent
  when the server is back, a stalled connection opens the app in about 11 seconds, a new release takes over cleanly;
- screens at 320, 360 and 390 px for the owner, a leader, a recruiter and a rep, with no sideways scrolling;
- the installer from scratch in a throwaway Ubuntu 24.04 machine (108 of 108 checks), including a Storage Box over
  SFTP, moving to a new box, `linear-hub update` and `restore`, and the real services under systemd;
- the whole test suite on five awkward dates (the Sunday the clocks go forward, New Year's Eve and others), and on a
  Mac-like network set-up;
- the recovery sheet's confirmation (one wrong character confirms nothing) and a backup's key copy removed afterwards;
- a release check of the merged release (an upgrade from 1.4 with a trial week, going live, security, money, keys,
  phones, the public page) found three problems, all fixed with tests before release: a restore could forget a week
  paid late and a bank file downloaded after the backup without a warning; a session made without a setup code (a 1.4
  session, a one-tap session) outlived the setup-code rule, and going live did not sign anyone out; and the description
  search engines and the home-screen app show mentioned pay and gauges.

**Not tested yet — so the first real run is a test:**

- **Revolut, Wise and TrueLayer have only been tested against stand-ins**: small fake servers built from each
  provider's published API. Nothing has run against a real sandbox or a real account. Before any live payment, run a
  sandbox payment with Linear MCR's own accounts (step 7 above); Linear Hub will not switch an API connection to live
  until one has been answered.
- **The bank file layouts are not confirmed by a bank.** The 1p test file is how you confirm them.
- **No HMRC call**: the check digits catch typing slips and made-up numbers; the office checks registration on HMRC's
  service.
- **The Mac checks in CI have never run** (nothing was pushed from the build machine); whoever pushes first checks that
  "verify (macos-latest)" is green.
- **On the real server**: the firewall and the HTTPS certificate cannot be tested in a throwaway machine (the go-live
  checklist checks them), and an S3 bucket was never used for real (a Storage Box was).
- **Real phones**: the browser checks used Chrome's engine at phone sizes, not a real iPhone or Android phone. On a
  plain http address the screen can still turn off during Quick gauges (keeping it on needs https), and the two-step
  setup screen still shows the QR code first on a phone (a later change will put **Open in authenticator app** first).
- **Speed**: 1.5 has not been load-tested; the figures in [LOAD_TEST.md](LOAD_TEST.md) are for 1.0 and 1.1 on a test
  machine.

## Where things are

- Everyone's guide: [USER_GUIDE.md](USER_GUIDE.md) (release notes at the end).
- Going online: [DEPLOY.md](DEPLOY.md) and `deploy/install.sh`.
- Commands and settings: [README.md](../README.md).
- What changed in detail: [CHANGELOG.md](../CHANGELOG.md).
- For a developer taking Linear Hub over: [MAINTAINERS.md](MAINTAINERS.md).
