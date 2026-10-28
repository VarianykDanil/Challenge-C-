# Linear Hub 1.4: notes for the owner

What Matt needs to know, set up or decide for 1.4, collected from the engineers' notes. 1.4 does three things:
everyone who signs in uses two-step verification (a code from an authenticator app), everyone is signed out 14 hours
after signing in, and you can pay people from Linear Hub in four ways. Settings named in **bold** are where you change
them. The step-by-step for everyone is in [USER_GUIDE.md, "What's new in 1.4"](USER_GUIDE.md#whats-new-in-14); the
rules are in [LOGIC.md §17](LOGIC.md#17-release-14).

## Two decisions for you

These are the two open questions from the build. Nothing needs to change until you answer; both are small changes.
Two questions for the providers are in their sections: **ask TrueLayer** which repeat window applies to payouts, and
**ask Wise** how long it recognises a repeated transfer (see "A very long outage" below).

1. **Should changing a connection's account also wait while a payment through it is on its way?** Today **Switch to
   live** and **Switch to test mode** wait until a payment through that connection has finished (or is cancelled), but
   you can still **Edit** its details: that is deliberate, so you can reconnect (a new Revolut code, a new Wise token)
   in the middle of a payment. It also means you could change the account the money comes from (the Revolut **GBP
   account to pay from**, the Wise **Business profile ID**, the TrueLayer **Merchant account ID**) while a payment is
   still being sent or checked. Linear Hub would then resend or check that payment against the new account, where the
   provider may not recognise the first attempt. Until you decide, only change keys for the same account while a
   payment is on its way, never the account itself. **Do you want Linear Hub to refuse a change of account (but still
   allow new keys) while a payment through the connection is on its way?**
2. **Should Linear Hub add the adjustment line by itself when a week's pay changes while its payment is on its way?**
   A week in a payment that is on its way is paid exactly as you approved it. If a gauge, a client statement, a rate or
   a dispute changes that week meanwhile, the payment page notes it and Needs attention says "Jordan Lee's pay changed
   while payment #3 was on its way". Today you add the difference yourself, as an adjustment on a later week with "the
   week it corrects" set to that week (that clears the Needs-attention item). **Would you rather Linear Hub added that
   line to the person's next unpaid week by itself**, with the reason, as it already does for a client statement that
   arrives after payday?

## Before you upgrade: two-step for everyone and the 14-hour sign-out

- **Everyone without two-step verification is asked to set it up at their next sign-in** — staff and every charity
  or client account you invited — and anyone signed in at the moment of the upgrade meets the setup step at their next
  tap. Tell the team and your charity contacts before you upgrade: they need an authenticator app on their phone
  (Google Authenticator, Microsoft Authenticator, 1Password or Authy) and about two minutes. The sign-in instructions
  Linear Hub gives you when you add a person or invite a client now include that step, but people you added or invited
  before 1.4 got the old text.
- **Sessions older than 14 hours end at their next request** (sessions made before 1.4 lasted 14 days), with the
  sentence "For security you are signed out 14 hours after signing in. Sign in again to carry on." on the sign-in page.
  Younger ones carry on until they are 14 hours old.
- **Until someone has set it up, their email and employee ID (and PIN, if they have one) still open the setup step.**
  Ask everyone to do it promptly. If someone sets it up on the wrong phone or loses theirs, reset it: Team → the person
  → **Edit profile** → **Reset two-step verification** (staff), or the campaign page's **Client accounts** card →
  **Reset two-step** (charity and client accounts). Recovery codes let a person in without the phone; each works once.
- **The 14 hours** can be changed in **Settings → Security → Sign-in rules → Sign out after** (4 to 24 hours). It counts
  from sign-in on the real clock, whatever `LM_BUSINESS_NOW` says. A shorter time applies at once; a longer one only
  from each person's next sign-in. The sign-out after inactivity (12 hours by default) still applies on its own. The
  old switch "Require two-step verification for administrators" is gone; its stored value is kept but no longer
  matters.
- **Nothing in the field is lost** when someone is signed out mid-shift: gauges waiting on the phone send after the
  next sign-in, and counts typed into **Log gauges** but not saved come back the next time it is opened (for 24 hours).

## Your own account and the demo

- **The demo sign-in accounts** (the four staff, team Sapiens' seven, Hannah Price CL-0001) need no code and keep
  14-day sessions **while Linear Hub is still the demo**, so one-click demo sign-in keeps working on your Mac. Anyone
  you add, and every client you invite, uses two-step even on the demo database.
- **That ends the day the demo ends.** Once any of the four demo staff accounts leaves or changes role (the go-live
  checklist asks you to turn them off), or the server runs with `LM_DEMO_ACCOUNTS=0`, **every** account must use
  two-step and the 14-hour sign-out, the demo admin included. Set up your own two-step (**Settings → Security → Set
  up**) before that day, and keep your recovery codes somewhere safe, away from your phone.
- **If you lose both your phone and your recovery codes**, another administrator can reset it for you. When there is
  no other administrator, run `npm run 2fa:reset -- <your email>` on the computer Linear Hub runs on (in the
  `linear-micro-crm` folder, with the same `DB_PATH` as `npm start`). It signs you out everywhere; you sign in with
  your email, employee ID and PIN and set two-step up again. It is in the audit trail as "npm run 2fa:reset". The same
  command is the way back if the app secret (`LM_APP_SECRET`, or the `server/data/app-secret` file) is ever lost: the
  authenticator secrets are encrypted with it, so no code would match (recovery codes still work).
- **To pay anyone, set up two-step first, even on the demo.** The demo admin is exempt from the sign-in rule, not from
  the payment rule: every payment needs a fresh code from your app. Until two-step is on, a payment's page says
  "Every payment needs a code from your authenticator app. Set up two-step verification first." with **Open Settings →
  Security**. If you turn it off again (only the demo accounts can), approving is held again.

## Paying people: before the first payment

- **Bank details.** Everyone you pay adds their own in **Settings → Bank details** (name on the account, sort code,
  account number, and the code from their app). Your existing database gets none from the upgrade: they would be fake
  details on real people. A fresh demo (`npm run seed`) has obviously fake ones (sort code 00-00-00) for most of the
  field people, every ninth person has none, and one change waits for your check. You can type someone's details in
  for them on Team → the person → **Bank details**; details you type in count as checked by you.
- **Check changed bank details with the person** (in person or by phone) before you choose **Confirm details**. Until
  you do, Linear Hub leaves them out of the next payment. This is the step that stops a payment going to someone else's
  account if a sign-in is misused.
- **Test mode first, then one person.** Connect Revolut, Wise or TrueLayer in test mode with the provider's sandbox
  details, make a payment through it (nobody is paid; the weeks stay on Runs to pay), and only then **Switch to live**
  by typing PAY FOR REAL. Your sandbox details do not work live: choose **Edit**, enter the live ones, and **Test**
  again. Then pay **one person, a small amount** (yourself, for example) and check it arrived before you pay the team.
  A bank file has no test mode: make the first file for one person, upload it, and check your bank takes it. (Since
  1.5 a bank file connection starts in test mode and has a 1p test file: see OWNER_NOTES_1.5.md.)
- **The app secret now also protects bank details and payment keys.** Back it up with the database, as before
  (`LM_APP_SECRET` in your password manager, or the `app-secret` file the backups folder keeps). The backups now hold
  everyone's bank details and the connections' keys, encrypted with it: keep the secret apart from any copy you send
  off the laptop. If it is lost, bank details cannot be read (everyone types them in again) and every connection has
  to be connected again.
- `LM_PAYMENTS_FAKE=1` adds a "Test provider" and a "Test bank file" that pay nobody, for trying the screens on a demo.
  Both stay in test mode (neither can be switched to live), so **Mark as paid** on a test bank file marks no week paid:
  the weeks stay on Runs to pay (the payment's page says "Test mode: nobody was paid"). The test bank file says "TEST
  FILE" on its first line and shows only the last digits of each account, so no bank can pay from it, and Needs
  attention never asks you to upload it. **Never set it on the server people are paid from.** `LM_PAYMENTS_JOB=0`
  turns off the 5-minute check of payments on their way (Check now still works); leave it on.
- **Being signed out never stops a payment you approved.** Linear Hub keeps checking it every 5 minutes on its own and
  marks the weeks paid; sign in again to see it finished. A bank file you approved is still there to download.

## Each way to pay

What each one can do is on its card in **Settings → Payments** (✓ and ✗), with its fees and what you need. Each
**Connect** form starts with **How to connect**, and every field says where to find its value.

### Bank payment file (any UK business bank)

- **What you need**: online banking for your business account that takes a bulk payment file. Linear Hub keeps no
  password or key for your bank.
- **Set up**: Settings → Payments → Bank payment file → **Connect**, choose the **File format** (**Starling Bank bulk
  payments (CSV)**, **Revolut Business bulk transfer (CSV)**, or the **General Faster Payments file (CSV)** for any other
  bank) and **Save connection**. There is nothing to test.
- **Paying**: approve in Linear Hub, **Download the bank file**, upload it in your online banking and approve it there,
  then **Mark as paid** in Linear Hub (untick anyone the bank rejected, with the reason). Upload the file as it is:
  Excel can drop the zeros at the start of sort codes and account numbers if you open and save it.
- **Costs and limits from the banks, as found on 23 Oct 2026** (check them yourself): Starling Bulk Payments costs £7
  a month after a free first month and allows 250 payments a month, up to £250,000 a payment; Revolut takes files of up
  to 1,000 payments, uploaded on the web only.
- **Names in the file** are each person's account holder name in plain letters: an apostrophe is dropped ("O'Neill"
  becomes "ONeill") and "&" becomes "and". Your bank's name check (Confirmation of Payee) should still match; if it
  flags someone, check their details with them. Revolut needs a first and last name, so a one-word name is left out of
  a Revolut file with the reason.
- **The file holds full account numbers.** Linear Hub stores it encrypted, only an administrator can download it, it
  is never cached, and every download is in the audit trail. Delete downloaded files from your computer once your bank
  has paid them.

### Revolut Business

- **What you need**: a Revolut Business plan that includes the Business API (a Revolut guide page named Grow, Scale and
  Enterprise; check your plan), and a computer to make the certificate.
- **Where to find each value**:
  - **Client ID**: Revolut Business on a computer → Settings → APIs → Business API → your API certificate. Make a key
    pair first with openssl, as Revolut's guide says, and upload the public certificate there.
  - **OAuth redirect URI**: the address you typed when you added the certificate, exactly. Any website address you
    control works (your company website): Linear Hub never receives the redirect, you copy the address from the
    browser.
  - **Private key**: the private half of the key pair you made (for example `privatecert.pem`).
  - **Code from Revolut**: in Revolut choose **Enable access** for the certificate and allow it. Revolut opens your
    redirect address with a code in it: copy the whole address and press **Save and test** at once — the code works
    once, for 2 minutes.
  - **GBP account to pay from**: leave it empty with one GBP account; with more, the test lists them.
- **Test mode** uses the Revolut sandbox (sandbox-business.revolut.com), which needs its own certificate and client ID.
- **Good to know**: if your Revolut account makes payments wait for an approver, they wait in Revolut and show as
  processing until you approve them there. If Revolut later stops accepting Linear Hub ("Enable access again"), repeat
  that step and paste the new code; Revolut's documentation disagrees with itself on whether that ever expires.
  Linear Hub does not use Confirmation of Payee (in the UK, Revolut needs you to ask API Support to switch it on).
  Revolut only spots a repeated payment for 2 weeks, so Linear Hub stops resending a payment it could not confirm
  after 13 days: check with Revolut before paying that week another way.

### Wise Business

- **What you need**: a Wise Business account and a personal API token. **With a personal token, Wise does not let
  Linear Hub pay (fund) the transfers for a UK business**: Linear Hub creates each transfer, and you pay it in Wise.
  Until you do, the week shows as processing; a transfer not paid in time is cancelled by Wise and goes back to Runs to
  pay.
- **Where to find each value**: **API token** — Wise on a computer → Your account → Connect and manage apps → API tokens
  → Add new token, with full access (Wise asks for its own code). **Business profile ID** — leave it empty unless you
  run more than one business in Wise.
- **Test mode** uses the Wise sandbox (wise-sandbox.com), with its own account and token.
- **If your Wise account has payment approvals switched on, Wise refuses transfers made with a token.** Turn approvals
  off for these payments, or use another way to pay.
- **Good to know**: every payment creates a recipient in Wise, so a person can appear more than once under Recipients.
  Wise moved to dated API versions this year; the ones Linear Hub uses remain available, but a later release should
  move to a dated version. Wise's OAuth "partner" access (which can fund transfers) is offered to larger partners and is
  not built.

### Open Banking (TrueLayer)

- **What you need**: a TrueLayer business account with payouts switched on (TrueLayer checks your business first) and
  a GBP **merchant account**, topped up from your business bank: payouts come out of it. Fees are per payout: check
  your TrueLayer agreement.
- **Where to find each value**: **Client ID** and **Client secret** — the TrueLayer Console (console.truelayer.com),
  your app's settings; the secret is shown once when you make it. **Signing key ID** and **Signing private key** — make
  a key on a computer with the two openssl commands shown under **Signing key ID**, upload the public key in the
  Console (Payments → Settings) and copy the key ID it shows; paste the private key (it never leaves Linear Hub).
  **Merchant account ID** — leave it empty with one GBP merchant account; with more, the test lists them.
- **Test mode** uses the TrueLayer sandbox app in the Console, with its own client ID, secret and signing key. The test
  also checks your signature with the sandbox; live has no such check, so a live signature is first checked by the
  first payout.
- **Good to know**: TrueLayer asks non-regulated businesses for each person's date of birth and address for sanctions
  screening. Its API accepts payouts without them and Linear Hub does not send them. If TrueLayer refuses payouts for
  that reason, the payout says so; sending them would be a later change and a data-sharing decision for you.
- **A payout TrueLayer did not answer is resent for 5 hours only.** TrueLayer recognises a resent payout (the same
  Idempotency-Key) for a limited time: 6 hours on its general idempotency page, 30 days on its Payments v3 page. Linear
  Hub keeps to the shorter one: a payout approved more than 5 hours ago is never sent again, it fails with "Linear Hub
  does not know whether TrueLayer made this payout: … Check the payouts in the TrueLayer Console before paying this
  week again." and its week goes back to Runs to pay. Check the Console before paying that week again: the first send
  may have arrived. **Ask TrueLayer** which window applies to payouts; if it is
  30 days, the 5 hours can be raised in a later release.

## While a payment is on its way, and after

- **Paid means the provider says the money left.** A payment the receiving bank returns later (Wise "bounced back"
  after "sent", TrueLayer "returned" after "executed") is not undone in Linear Hub: the week stays paid. The provider
  emails you or shows it; pay the person again and put it right with an adjustment on a later week.
- **Mark paid by hand waits** on a week whose payment from Linear Hub is on its way, so nobody is paid twice.
- **A very long outage**: if a provider stays unreachable while a payment is being sent, Linear Hub keeps resending
  with the same reference, which the provider recognises as the same payment. Revolut recognises repeats for 2 weeks
  (after 13 days Linear Hub looks the payment up instead of resending); TrueLayer for 6 hours (after 5 hours Linear Hub
  fails the payout with a reason instead of resending); Wise's documentation does not say how long, so Linear Hub keeps
  resending Wise transfers with the same reference for as long as Wise does not answer. Each resend relies on Wise
  still recognising the reference: if it has forgotten it, a second transfer can appear. Wise transfers wait for you to
  pay them, so after a long Wise outage check **Wise → Transfers** for a transfer made twice before you pay any.
  **Ask Wise** how long a repeated `customerTransactionId` is recognised; Linear Hub could then stop resending in time,
  as it does for Revolut and TrueLayer. Check the provider's own list before paying that week another way.
- **During an outage a live payment holds the week until the provider answers** (TrueLayer: for 5 hours after the
  approval at most, then the payout fails and the week is freed, as above). While Linear Hub does not know whether a
  provider made a payment, Cancel waits and says why, and Mark paid by hand waits: paying that week another way could
  pay it twice. With Wise, **Cancel the rest** shows greyed out and works again once **Check now** gets an answer;
  Revolut and TrueLayer payments cannot be stopped from Linear Hub once sent, so while it waits the page explains that
  instead of showing a greyed-out Cancel. A test-mode payment never holds the week.

## What was tested, and what was not

- **No real call was made to Revolut, Wise or TrueLayer.** Each was built from the provider's current documentation and
  tested against local fake servers that follow the documented requests, answers and error shapes, including
  timeouts, refusals, partial failures, resends after a timeout and token refreshes. No test calls the internet. The
  build machine's network refused the providers' sites, so the documentation was read through web searches and the
  providers' official GitHub files (Revolut's OpenAPI file, TrueLayer's signing and PHP libraries). Key points were
  checked again on 25 Oct 2026: Revolut's addresses, its 40-character request id recognised for 2 weeks, the 2-minute
  code and 40-minute tokens; Wise's new sandbox address (the old one was retired on 30 June 2026) and that a personal
  token cannot fund transfers for UK businesses; TrueLayer's payout shape and statuses, and its idempotency window
  (6 hours on one page, 30 days on another: Linear Hub uses the shorter). **A sandbox run with your own
  credentials is the first real check.** The least certain points: the exact Revolut consent step and whether the
  code shows in the redirect address as `?code=`; the name Wise gives the token permission ("full access"); how
  TrueLayer's live service checks the signature.
- **Bank file formats were checked from the banks' published pages**, read through web searches on 23 Oct 2026 (the
  pages themselves were blocked), not by uploading a real file. **Starling**: the column order, the 18-character
  reference, the 255-character name, numbers-only amounts, the header row and the £250,000 limit come from Starling's
  help pages; the exact words of Starling's header row could not be seen (the template is behind sign-in), so Linear
  Hub uses the help page's field names. **Revolut**: the header row and field rules come from Revolut's developer
  documentation for its CSV payment file and the 1,000-line limit from its help page; this is the UK, pounds layout. A
  third-party guide says Revolut may want each new payee paid once by hand before they can be in a bulk transfer:
  check this on your first file. If a bank refuses a file, compare its first line with the bank's own template and tell
  us what it says.
- **Left out, so use the General Faster Payments file and check it with your bank**: **Wise** (its batch template's
  bank-detail columns come from a template builder behind sign-in; Wise is available through its API instead),
  **Monzo Business** (Monzo publishes the column order but not the values of its "Bank account type" column, and
  Linear Hub does not know whether each account is personal or business), and **NatWest / RBS Bankline, Barclays,
  HSBC, Lloyds and Santander** (their import specifications are PDFs or pages behind sign-in that could not be read;
  Bankline's and HSBC's long, field-coded layouts are not safe to guess).
- **The rest of the payments flow** was tested end to end with a fake provider: drafts, approvals with a fresh code,
  checks, failures, timeouts and resends, bank files, test mode, never paying a week twice, a week frozen while its
  payment is on its way, and every route for every role (administrator, leader, recruiter, rep, client account and
  signed out).
- **Two-step and the 14-hour sign-out**: route tests for every rule and role, the 14-hour boundary at ±1 minute, a
  session used a minute ago still ending at 14 hours, the setting's range, a raised limit, the audit rows, the demo
  database against one in real use and `LM_DEMO_ACCOUNTS=0`, and `npm run 2fa:reset` on a copied database; screens
  checked on phone and laptop sizes, light and dark. Not tested with a real phone's authenticator app (codes were
  computed to the same RFC 6238 standard, checked against its published examples).

## Only if you tried an earlier 1.4 build

A payment approved on a build before the review fixes has no copy of the bank details it was approved with. If it is
still waiting after a timeout and the person changed their details since, Linear Hub does not resend it and says so:
check with the provider whether it went before paying that week again. Your own database never ran such a build.
