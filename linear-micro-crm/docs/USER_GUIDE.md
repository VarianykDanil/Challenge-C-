# Linear Hub — User guide

Step-by-step for everyone at Linear MCR, by role. Start with **Everyone**, then jump to your section. Buttons, tabs and fields are named exactly as they appear in the app, in **bold**.

- [What's new in 1.4](#whats-new-in-14) — two-step verification for everyone, signed out 14 hours after signing in, your bank details, and paying people from Linear Hub
- [What's new in 1.3.1](#whats-new-in-131) — the Sapiens team's demo sign-ins, leaders and recruiters can add people, and invoice lines that say why
- [What's new in 1.3](#whats-new-in-13) — pay you can check, client accounts, learning videos, PDFs, venues and the audit
- [What's new in 1.2](#whats-new-in-12) — learning the COD pack and your pitch, and field and office upgrades
- [What's new in 1.1](#whats-new-in-11) — the smart release
- [Everyone](#everyone) — signing in, what your role can do, your dashboard, the six gauges, logging a day, ratios and benchmarks, the Gauges page, pay and punctuality, the leaderboard, events, the team directory, settings
- [Leaders](#leaders) — scheduling events, logging for your team, the team view, announcements
- [Recruiters](#recruiters) — your dashboard, the pipeline, adding and moving candidates, interviews, hiring, your pay
- [Administrators](#administrators) — campaigns, people, gauges and events for anyone, payroll and paying people, expenses, company finance
- [If something goes wrong](#if-something-goes-wrong)

---

## What's new in 1.4

Linear Hub 1.4 does three things. Everyone who signs in now uses **two-step verification**: a 6-digit code from an
authenticator app on their phone. Everyone is **signed out 14 hours after signing in**. And the office can **pay
people from Linear Hub**, in four ways, once each person has added their **bank details**.

### Two-step verification for everyone

Linear Hub now asks everyone who signs in for a 6-digit code from an authenticator app (Google Authenticator,
Microsoft Authenticator, 1Password or Authy). That means administrators, team leaders, recruiters, field reps, and
charity and client accounts alike. There are no codes by email or text message.

**Setting it up (once, about two minutes).** If you have not set it up, the next time you sign in you see **Set up
two-step verification**.

1. Tap **Set up now**.
2. In your authenticator app, add an account and scan the code Linear Hub shows. If you cannot scan it, type the key
   shown under **Can’t scan? Enter this key instead**. Then tap **Next**.
3. Type the 6 digits the app shows. Linear Hub checks them as soon as the sixth digit is in (**Turn on** does the same).
4. Save your 10 recovery codes somewhere safe, away from your phone (**Copy all** or **Download .txt**), then tick **I
   have saved these codes**.

**Every sign-in from then on.** Staff: your work email and employee ID, your PIN if you have one, then the code from
your app. Charity and client accounts: your email and access code, your PIN, then the code. There is no "remember this
device": each sign-in asks for a new code. Codes change every 30 seconds and each one works once.

**Settings → Security** (the client portal's **Security** page for charity and client accounts) shows two-step
verification as **Required**, how many recovery codes you have left, and **New recovery codes**. It cannot be turned
off.

**If you lose your phone or get a new one.**
- On the code screen, choose **Use a recovery code instead** and type one of your recovery codes. Each works once.
  Then make a fresh set with **New recovery codes**.
- No recovery codes left? Ask an administrator to reset your two-step verification. They do it in **Team → the
  person → Edit profile → Reset two-step verification** (staff) or on the campaign page's **Client accounts** card with **Reset
  two-step** (charity and client accounts). You are signed out everywhere, and at your next sign-in you set it up again
  on the new phone.
- If the only administrator loses both phone and codes, whoever looks after the computer Linear Hub runs on types
  `npm run 2fa:reset -- <their email>` there (see [If something goes wrong](#if-something-goes-wrong)).

**The demo sign-in buttons** on the sign-in page work as before (no code) while Linear Hub is still the demo. Anyone
the office adds, and every invited charity contact, uses two-step even on the demo.

### Signed out 14 hours after signing in

For security, everyone is signed out 14 hours after signing in, however busy they are, and signs in again with their
code. The sign-in page then says: "For security you are signed out 14 hours after signing in. Sign in again to carry
on." Sign in at the start of a shift and you are fine for the whole day. The sign-out after inactivity (12 hours unless
your administrator changed it) still applies too.

Nothing is lost when it happens:
- gauges saved without signal, or as you were signed out, wait on your phone and send after you sign in again;
- counts you had typed into **Log gauges** but not saved are there the next time you open it for that event ("These
  are the counts you had typed but not saved. Check them, then save."), for 24 hours;
- a **Check in** tap that was refused because you had just been signed out is kept on the phone and sent after you
  sign in.

### Your bank details

**Settings → Bank details** is where your pay goes. Choose **Add bank details** (or **Change**) and fill in **Name on
the account**, **Sort code** (6 digits) and **Account number** (8 digits), then the **Code from your authenticator
app**, and choose **Save bank details**. After that Linear Hub only ever shows the last digits ("••-••-34",
"••••5678"), to you and to the administrators; leaders and recruiters never see anyone's.

When you change them, the office checks the new details with you (in person or by phone) before the next payment goes
there; until then your payment waits. That stops anyone who got into your account from sending your pay elsewhere.

### Paying people from Linear Hub (administrators)

**The four ways to pay.** Settings → **Payments** shows each with its logo, what it can do (✓ or ✗), its fees, **What
you need to set it up** and **Good to know**. Logos belong to their owners and only identify the service.

| | Bank payment file | Revolut Business | Wise Business | Open Banking (TrueLayer) |
| --- | --- | --- | --- | --- |
| How it works | Linear Hub makes a bulk payment file; you upload it to your online banking and approve it there, then mark who was paid | Linear Hub pays each person from your Revolut Business GBP account | Linear Hub creates each transfer in Wise; you pay (fund) them in Wise | Linear Hub pays each person from your TrueLayer merchant account, which you top up from your bank |
| Pays from Linear Hub | ✗ | ✓ | ✗ | ✓ |
| Confirms payment automatically | ✗ (you tick who the bank paid) | ✓ | ✓ | ✓ |
| You approve the payments in your bank | ✓ | ✗ (unless your Revolut account needs an approver) | ✓ | ✗ |
| Test mode | ✗ (a file moves nothing until you upload it) | ✓ | ✓ | ✓ |
| Shows your balance | ✗ | ✓ | ✗ | ✓ |
| Works with any UK business bank | ✓ | — | — | — |
| Fees | none from Linear Hub; your bank's bulk payment charges | Revolut's transfer fees and your plan | Wise's fee per transfer, shown before you pay | per payout: check your TrueLayer agreement |

**1. Connect a way to pay.** In Settings → **Payments**, choose **Connect** on the card. For Revolut, Wise and TrueLayer
the form starts with **How to connect**: the steps in order, including the ones you do outside Linear Hub (in Revolut,
Wise, the TrueLayer Console or on a computer). Every field says where to find the value. Keys and tokens are stored encrypted and never shown again:
when you **Edit** a connection, leave a key empty to keep the one stored.
- **Bank payment file**: under **File format** choose **Starling Bank bulk payments (CSV)**, **Revolut Business bulk
  transfer (CSV)**, or the **General Faster Payments file (CSV)** for any other UK bank, then **Save connection**.
  There is nothing to test.
- **Revolut Business**: on a computer, make a key pair and add an API certificate in Revolut Business (Settings → APIs
  → Business API) with any website address as the OAuth redirect URI. Copy the **Client ID**, the **OAuth redirect
  URI** and the **Private key** into the form. Then in Revolut choose **Enable access** and allow it: Revolut opens your
  redirect address with a code in it. Copy that whole address into **Code from Revolut** and press **Save and test**
  straight away, because the code works for 2 minutes.
- **Wise Business**: make a personal API token in Wise on a computer (Your account → Connect and manage apps → API
  tokens) with full access, paste it into **API token** and press **Save and test**. Leave **Business profile ID**
  empty unless you run more than one business in Wise.
- **Open Banking (TrueLayer)**: ask TrueLayer to switch on payouts and open a GBP merchant account, then top it up.
  Make a signing key on a computer with the two openssl commands shown under **Signing key ID**, upload the public key
  in the TrueLayer Console (Payments → Settings), then paste the **Client ID**, **Client secret**, **Signing key ID**
  and **Signing private key**, and press **Save and test**.

**2. Test mode first, then live.** Revolut, Wise and TrueLayer connections start in **test mode**: they talk to the
provider's sandbox, and nobody receives any money. The card shows **Connected**, **Not tested yet** or **Needs a look**,
and **Test** tries it again. Make a payment in test mode first: it says **Test done: nobody paid**, each person reads
**Test: not paid**, and the weeks stay on Runs to pay. When you are ready, choose **Switch to live** and type **PAY FOR
REAL**. Your sandbox details do not work live, so then choose **Edit**, enter your live details (for Revolut, a new code
too) and **Test** again; the card then says **Live: real money**. Pay one person a small amount first (yourself, for
example) before you pay the team. **Switch to live** and **Switch to test mode** wait while a payment through that
connection is on its way. **Edit** on a live connection says so: approving a payment through it moves real money, and
after you change its details you test it again. A draft made in test mode cannot be approved once the connection is
live: its page says so; cancel it and make a new payment.

**3. Choose who to pay.** In **Finance → Company → Runs to pay**, tick the weeks you want to pay and choose **Pay N from
Linear Hub** (or **Pay from Linear Hub** with nothing ticked). On **Pay people**, check **1. Who to pay** (pending weeks
and failed transfers), choose the connection under **2. How to pay**, look at **3. Review** and choose **Review
payment**. Nothing is sent yet. **3. Review** counts people, runs and the **Total before checks**, leaving out ticked
runs whose invoice is not accepted yet or is disputed; a run already in a draft payment says **In a draft payment**,
and a connection that has not passed its test is listed below the ones that work, with a dashed border and "Test it in
Settings → Payments first" (it cannot be chosen).

**4. Check and approve.** The payment's page shows the total, each person with the last four digits of their account,
and who was left out and why: no bank details yet, details changed and not yet checked, an invoice not accepted yet or
disputed, the week not over, already paid or already in a payment. Type the **Code from your authenticator app** and
choose the button:
- bank payment file: **Approve and make the bank file**;
- Revolut and TrueLayer: **Approve and pay £…** (in test mode **Approve test payment of £…**);
- Wise: **Approve and create the transfers (£…)** (in test mode **Approve test payment of £…**): nobody is paid until
  you pay them in Wise.

Every payment needs a fresh code, and each code works once.

**5. Follow it.** The page updates by itself while payments are on their way, and **Check now** asks the provider at
once. Linear Hub also checks every 5 minutes on its own, even when nobody is signed in, and marks each week paid when
the provider says the money has gone. Paid weeks leave Runs to pay; a failed one stays there with **Payment failed**
and the reason, and you can pay it again in a new payment.

**With a bank payment file.** Choose **Download the bank file**; the page says where to upload it (Starling: Payments →
Bulk Payments → New bulk payment; Revolut: Payments → Transfers → Bulk, in the web app). Upload the file as it is: if you
open it in Excel and save it again, Excel can drop the zeros at the start of sort codes and account numbers. Approve it
in your online banking. When the bank has paid it, come back to **Mark as paid**: everyone is ticked; untick anyone the
bank rejected and say why in **Why the bank did not pay them**, check **Paid on**, and choose **Mark N paid** (or
**Mark N paid, M not paid** with someone unticked). Each line
shows the reference written in the file (like "LINEAR 05OCT JL"), so you can find it on your statement. Someone the bank
would refuse (Revolut needs a first and last name, for example) is left out of the file with the reason: fix their bank
details, then pay that week again. The payment's **Total** is what you approved; when someone was left out, it also
says **In the file £…**, the amount your bank will show, and Needs attention gives the people and the money in the file.
Someone you cancel later is still in the file you downloaded, so they still count in **In the file £…**: never upload
that file again. Delete downloaded files from your computer once the bank has paid them: they hold full account
numbers.

**With Wise.** After approving, open Wise and pay the transfers Linear Hub made. They wait there until you do, and Wise
cancels any that are not paid in time (those weeks go back to Runs to pay). **Cancel the rest** stops transfers you
have not paid yet. If your Wise account needs payments approved by someone, Wise refuses transfers made with a token:
switch that off for these payments, or use another way to pay.

**With Revolut.** If your Revolut Business account makes payments wait for an approver, approve them in Revolut too;
until then they show as processing. If Revolut stops accepting Linear Hub, the connection asks you to choose **Enable
access** again in Revolut and paste the new code.

**With TrueLayer.** Payouts come out of your merchant account: if one fails for lack of money, top it up and pay that
week again.

**While a payment is on its way**, **Mark paid** by hand on those weeks waits for it, so nobody is paid twice. The
week's pay also stays as you approved it: if a gauge or a statement changes it meanwhile, the payment page and Needs
attention say so ("Jordan Lee's pay changed while payment #3 was on its way"), and you add the difference on a later
week as an adjustment, saying which week it corrects. If the payment fails or is cancelled instead, the week is brought
up to date before you pay it again.

**If a provider does not answer**, the payment says why (for example "TrueLayer did not answer within 15 seconds", or
"Linear Hub could not reach Wise: check this computer’s internet connection, or Wise may be down.") and reads
**Waiting to send** until the provider confirms one of them. A payment sent without an answer may still have been made,
so the message after approving says the provider "has not confirmed" it yet, and counts a refused payment as failed,
never as sent. Linear Hub sends the rest at the next check, or when you press **Check now**, to the account each payment
was approved with and with the same references, so the provider does not make them twice. Providers only recognise a
resent payment for a while: Revolut for 2 weeks (after 13 days Linear Hub looks the payment up instead of resending)
and TrueLayer for 6 hours (a payout approved more than 5 hours ago is not sent again: it fails with "Linear Hub does not
know whether TrueLayer made this payout: …", and its week goes back to Runs to pay; check the TrueLayer Console before
paying it again). Wise does not say how long it recognises one, so Linear Hub keeps resending Wise transfers: after a
long outage, check Wise → Transfers for a transfer made twice before you pay any.

**Cancel the rest** stops what Linear Hub has not sent yet and, with Wise, transfers you have not paid yet; payments
already sent to Revolut or TrueLayer cannot be stopped from Linear Hub. While Linear Hub is still finding out whether
the provider made a payment, Cancel waits and the page says why, and **Mark paid** by hand waits too. With Wise,
**Cancel the rest** is greyed out until **Check now** gets an answer, then works again. During an outage a live payment
holds the week until the provider answers (TrueLayer: for 5 hours after the approval at most); a test-mode payment never
holds it. The message after cancelling says how many were stopped and how many are still on their way.

**A payment that bounces back after it was paid** (the receiving bank returns it days later) is not undone in Linear
Hub: the week stays paid. The provider tells you; pay the person again by hand and put it on a later week as an
adjustment.

**Changed bank details.** When someone changes their bank details, Needs attention says "Thomas Grainger changed their
bank details". Check the new details with them in person or by phone, then open **Team → the person → Bank details**
and choose **Confirm details**. If they changed them again in the meantime, Linear Hub says "They changed their bank
details again since you looked: check the new ones before confirming." and shows the new ones, still waiting. Details
you type in for someone there count as checked by you.

**Signed out while paying?** Being signed out 14 hours after signing in never stops a payment you already approved:
Linear Hub keeps checking it on its own and marks the weeks paid. A bank file you approved is still there to download
and mark paid after you sign in again.

### For the administrator: Settings → Security → Sign-in rules

- **Two-step verification is required for everyone**: a plain line now. The old switch "Require two-step verification
  for administrators" is gone.
- **Sign out after**: 4 to 24 hours from sign-in (14 hours by default). A shorter time applies at once, to everyone
  already signed in too; a longer one from each person's next sign-in (anyone signed in now is still signed out at the
  old time, and the sign-in page names it). The demo sign-in accounts are left out while Linear Hub is still the demo,
  and the hint under the setting says so.
- **Sign out after inactivity**: unchanged (12 hours by default).

Adding someone (**Team → Add person**) or inviting a charity contact (the campaign page's **Client accounts** card →
**Invite**) gives you sign-in instructions that now end with setting up two-step verification and keeping the recovery
codes safe. People you added or invited before 1.4 got the old text, so tell them.

## What's new in 1.3.1

### The Sapiens team on the demo

The demo now has a fifth team, **Sapiens**, with seven people whose accounts start **blank**: every page works, but
nothing has been logged yet — no gauges, events, pay, invoices, learning or check-ins. They have first names only; an
administrator adds surnames in **Team → the person → Edit profile** (the last name can stay empty until then).

| Name | Employee ID | Email | Position |
| --- | --- | --- | --- |
| Theo (leads the team) | LM-0101 | theo@linear-mcr.co.uk | Team Leader |
| Daniel | LM-0102 | daniel@linear-mcr.co.uk | Team Leader |
| Ridwan | LM-0103 | ridwan@linear-mcr.co.uk | Team Leader |
| Jamie | LM-0104 | jamie@linear-mcr.co.uk | Team Leader |
| Olivia | LM-0105 | olivia@linear-mcr.co.uk | Trainee |
| Owens | LM-0106 | owens@linear-mcr.co.uk | Trainee |
| Yasmin | LM-0107 | yasmin@linear-mcr.co.uk | Trainee |

On the sign-in page, under the four demo buttons, open **Sapiens team (7)** and tap a name to sign in as them. There is
no PIN on these demo accounts. The first time a Sapiens leader or trainee signs in, Linear Hub asks them to read the
self-billing agreement, as it does for every new field person (**Later** puts it off until the next visit). The group
is shown only on the demo database, like the other demo buttons; `LM_DEMO_ACCOUNTS=0` hides it.

### A charity account on the demo

Under the demo buttons, **Charity accounts** has a one-tap sign-in for **Hannah Price — Breast Cancer Now**, the demo
charity's own account (CL-0001, hannah.price@breastcancernow.example, no PIN). It opens the client portal as the charity
sees it: their updates and announcements, a commission change you declined and one waiting for you. A demo database
first made before 1.3 gains this account, with those posts, the next time Linear Hub starts — but only while it is
still the demo: the four demo staff accounts (LM-0001, LM-0002, LM-0003, LM-0010) are all there with their demo roles
and none has left (renaming them or changing their emails does not count), and the server is not run with
`LM_DEMO_ACCOUNTS=0`. Every Linear Hub database starts as the demo, so before real people use yours, deactivate the
demo accounts (see the go-live checklist in [DEPLOY.md](DEPLOY.md)); `LM_DEMO_ACCOUNTS=0` only hides their buttons.

### Leaders and recruiters can add people

**Team → Add person** is now there for recruiters and for leaders (Team Leaders and Crew Leaders), as well as
administrators. See [Adding a person (leaders)](#adding-a-person-leaders) and
[Adding a person (recruiters)](#adding-a-person-recruiters).

### Invoice lines say why

Each line of your self-billing invoice now says why it is what it is, in grey under the line, as **How this week is
worked out** does: "8 logged, 1 cancelled by CHN", "Not yet confirmed by BCN", or for a correction "2 cancelled by BCN:
paid for 11, confirmed 9". It is on the printed invoice and the PDF too, so you can check a line before you accept it
or tap **Something's wrong**. Invoices issued before this update stay exactly as they were issued (no notes); the next
version of one, and every new week's invoice, has them.

### Fair-use limit on bookings and interview sheets

**I'm working this** / **I can't make it**, **Edit bookings** and the interview sheet's saves now count towards the
same limit as check-ins and other quick changes: 60 changes a minute per person. Normal use never comes near it. If
you do reach it, Linear Hub says "That is more than 60 changes in a minute. Wait a minute, then try again." and
nothing is changed; on an interview sheet it shows **Not saved** with **Try again**, and your words stay on the screen.

## What's new in 1.3

Linear Hub 1.3 makes pay something everyone can check: each week is paid as the base (£63.50 a day) or the commission, whichever is higher; the clients' statements correct cancellations automatically; and a self-billing invoice comes to each person to accept or query. Clients get their own login for updates, Matt can add learning videos, every table downloads as PDF, recruitment keeps much more detail, venues show what it takes to make a sale there, and the audit trail records every action.

### Pay: base or commission, and cancellations

**Everyone on weekly pay: Finance → My pay.**

- **Commission weeks** shows how many of the last 12 weeks the commission beat the base, and what those weeks paid ("4 of 12", "£1,228 · beat the base").
- **This week so far** shows the likely pay and a bar of commission so far against the base for the days you are likely to work, with a line such as "9 more subs and commission beats your £381.00 base — about 188 stops (likely)".
- **How this week is worked out** opens the week's breakdown as it stands.
- **Payslips** lists every week. The **Paid as** column shows Base or Commission with its amount. Under the gross it shows "incl. £25.00 bonus", "incl. −£16.50 corrections" or "after £20.00 deductions". Sales show "2 cancelled" when a client cancelled subs.
- Select a week to see the full breakdown:
  - two tiles, **Base** (days × £63.50) and **Commission** (subs at the campaign rates). On a paid week the one paid is marked **Paid** and the other **Not paid**, with the badge **Paid the base** or **Paid the commission**;
  - on a week not paid yet (waiting for payday, or a transfer that failed) they read **Applies** and **Does not apply**, with the badge **Pays the base** or **Pays the commission**;
  - while the week is still going, the tiles read **Ahead** and **Behind**;
  - each campaign's subs × rate, with "18 logged, 2 cancelled by BCN" or "Not yet confirmed by BCN";
  - any bonus with its note, any correction from an earlier week, the total, and the reasons in plain sentences.
- A week a client corrected after it was paid shows **Corrected after payment** with the amount and the week it went on.

**Leaders: Finance → Team pay.** The same columns for the team, plus **Paid as commission**: how many of the team's runs the commission beat the base. A leader can open a team member's week and read the same breakdown.

**Administrators: Finance → Company.**

- **Runs to pay** has the same columns.
- Open a run to see the breakdown, where **Add a bonus** and **Add an adjustment** work on an unpaid week, and the bin removes a bonus or a manual line.
- **Bonuses and corrections** lists the last six weeks' bonuses, manual lines and statement corrections.
  - **Add a bonus**: choose the person and the week it is paid with (last week by default), the amount and what it is for. The person sees the note.
  - **Add an adjustment**: choose **Add money** or **Take money off**, and optionally the week it corrects.
  - A paid week cannot take a line; choose the next unpaid week.
  - A line on a past week the person did not work goes on their next unpaid week; the message after **Add adjustment** says which ("−£20.00 on w/c 5 Oct: no work in w/c 14 Sep, so it goes on the next unpaid week").
  - Taking off more than a finished week pays is refused; split it over two weeks.
  - Removing a bonus that made room for a deduction is refused in the same way: remove or reduce the deduction first.

**Administrators: Settings → Pay.**

- **Day rate (£)** and **The rule applies from** (a Monday), then **Save pay settings**. Unpaid weeks are recalculated and paid weeks never change.
- **Rate per sub, by campaign** lists each campaign's current rep rate and payout. Open one to see its history (who approved a client's change).
- **Add a rate** adds a new rate from a date. Sales on and after that day use it.

### Self-billing invoices

**Your invoice (reps and leaders).** You are self-employed, so each week Linear MCR Limited writes a self-billing
invoice for you. Open **Finance → My pay** and tap a week: you see the invoice — your details as the supplier, Linear
MCR Limited as the customer, every line (if your commission beat your base you are paid the commission and the base
is listed as *Not paid*, and the other way round), the total, and the deadline.

- **Accept invoice** when it is right. The first time, read and accept the **self-billing agreement** (it also opens
  by itself once, and is always in **Settings → Invoices**).
- **Something's wrong**: tick the lines that are wrong, say what they should be ("18 sales") and why ("I made 18
  sales, not 16"), then **Send to the office**. The invoice is held until the office answers; you see the answer on
  the invoice and in your notifications.
- Do nothing, and the invoice **counts as accepted at 12:00 the day before payday** (Thursday for a Friday payday).
  You always get at least 24 hours: an invoice that arrives later than Wednesday 12:00 counts as accepted 24 hours
  after it arrived (the invoice and your notification say exactly when).
- A line can have a note in grey under it saying why it is what it is ("8 logged, 1 cancelled by CHN", "Not yet
  confirmed by BCN"; release 1.3.1).
- If what you are paid changes (a late gauge, a client's statement, a correction), you get a new version to accept,
  and a notification such as "Your invoice changed: £300.00 (was £345.00)". It has the same 24 hours at least, even on
  payday. Until you accept it, the office needs a reason to pay it, so accept it as soon as it is right. A change that
  does not change your pay (for example cancellations on a week you were paid the base) just updates the lines:
  nothing to accept again.
- **Print invoice** gives a clean A4 page, and **Download PDF** saves the same invoice as a PDF.
- **Settings → Invoices**: your address, postcode, Unique Taxpayer Reference (if you have one) and VAT number (only
  if you are VAT registered). They are printed on every invoice still waiting to be accepted.

**The office (administrators).**

- **Finance → Company → Disputed invoices** (top of the tab, only when there are some): who, which week, what they
  say is wrong, our figures, **Open the week** (the invoice, the week's gauges and the pay breakdown), **Statements**.
  **Fix and reissue**: correct the gauges first or type a correction (£, minus to take money off) and a note; a new
  version goes to the person to accept. **Keep as it is**: a note that explains why; the invoice can then be paid.
- **Runs to pay**: each row shows the invoice's status. **Mark paid** refuses an invoice that is not accepted yet and
  says so; **Mark week paid** skips those and tells you how many. To pay one anyway, open the run and tap **Mark paid
  anyway**, with a reason: it is kept on the invoice and in the audit trail. A **disputed** invoice cannot be paid
  until you answer the dispute (**Keep as it is** makes it payable straight away).
- **Team leaders** can open their team's invoices to check the lines and the total; the person's home address and UTR
  are shown only to them and the office.
- **Settings → Company details on invoices**: the legal name, address, postcode, company number, the authorised
  signatory and an optional signature image (PNG or JPEG, scaled down for you).
- **Team → a person → Invoice details**: their supplier details (you can correct them) and whether they accepted the
  agreement.

### Client statements from Gmail

**Finance → Statements** (administrators). Every commission statement the clients emailed you (once Gmail is connected)
or that you uploaded, newest first: the campaign, the period, when it arrived, how many rows matched a person, and its
status — **Needs review**, **Ready to apply**, **Applied** or **Couldn't read** (on a phone the status sits under the
campaign). An applied statement that a corrected copy replaced also says **Replaced**. The top of the page says whether Gmail
is being checked. **Check Gmail now** looks straight away; **Upload statement** takes a PDF from your computer or phone.

Open a statement to check it:

- **Before you can apply it** lists what is left, in plain words: rows nobody is matched to, a missing campaign or
  period, a column the client's saved columns expect but this statement does not have, or dates another applied
  statement already covers.
- The blue box says what is worth a look: Gmail could not confirm the email came from the client, some sign-ups are
  dated outside the statement's period (they count on their own days, in place of what was logged), or **This replaces
  the BCN statement for … applied on …** — applying the corrected copy puts pay right to its figures, and a correction
  already waiting on an unpaid week is changed rather than added to. Anyone on the old copy but not the new one goes back
  to the subs they logged (listed under Pay).
- **Pay** shows, for each person on the statement, the subs they logged in the period, what the client confirmed, and
  how many were cancelled, with the pay effect: Linear Hub works out what applying would change before you press
  anything.
- **Rows** shows the statement's rows and who each one is. For a row nobody matched, choose the person in **Pick the
  person…** (or **Not one of ours**). Every other row written the same way gets the same choice, and if the row had the
  client's fundraiser ID, Linear Hub remembers it as that person's ID for next time.
- **Details**: fix the campaign or the period if the PDF did not say them, then **Save campaign and period**.
- **Columns**: which column holds what. Linear Hub reads the headings itself; if it got one wrong, change it and press
  **Save columns for BCN**. Applying the first statement from a client saves its columns too, so the client's next
  statements in the same layout **apply themselves** as soon as they arrive, when every row matches.
- **Apply** corrects pay: weeks not paid yet are recalculated with the confirmed subs; for a week already paid, the
  difference goes on that person's next unpaid pay run with a line saying why. Paid runs never change. A statement for a
  period longer than a week takes cancellations off its latest week first.
- **Discard** removes a statement that is not applied (a remittance advice, a wrong file). **Open PDF** shows the PDF;
  on a laptop or tablet **Show it here** shows it in the page. Opening or downloading a statement PDF is on the audit
  trail.
- A statement that was replaced says **Replaced by the statement received …** with a link; pay follows the newer one.

**Settings → Integrations** (administrators): your Gmail address and an **app password**, **Save**, **Test
connection**, and **Check for statements every 15 minutes**; below, **Statement senders**: for each campaign, the
address its statements come from (only those emails are read). **How to make an app password** explains the steps.

**Team → a person → Client IDs** (administrators): the person's fundraiser ID at each client, exactly as the client's
statements write it. A statement row with that ID matches them even if the name is spelt differently.

The dashboard's **Needs attention** box (and the bell) shows a statement that needs a look ("BCN statement for 12–18
Oct 2026 needs a look", with what to do), one that could not be read, one ready to apply, and a Gmail check that keeps
failing.

### PDF downloads

- **Export ▾** (every table that had **Export CSV**: Gauges, a person's gauges and entries, an event's gauges, the
  Leaderboard, Team, Campaigns, Recruitment's list and Hired column, Finance → My pay / Team pay / Company): pick
  **CSV** for a spreadsheet that opens in Excel, or **PDF** to print or share. The PDF holds exactly the rows on screen,
  with the filters set on screen (team, position, search…) and the date range under the title, money and dates written
  as on screen, and "Page 1 of 3" at the foot of each page. Wide tables print on landscape pages. On a phone the button
  shows just the download icon.
- **Audit → Download PDF**: every entry that matches the filters, newest first (up to 2,000) — who did what and when,
  the record and what changed. (Until the Audit page passes its filters to the button, it is the 50 entries on
  screen, and the PDF says so under the title.)
- **Learning → Progress → Download PDF** (your own, or a person's from My team / Everyone): the COD pack checklist,
  what the next level needs, and the required videos.
- The first PDF of a visit takes a second or two while the PDF maker downloads (about 140 kB over the network); after
  that PDFs are instant. Offline, the CSV still works, and so does the PDF once the PDF maker has loaded on that
  visit; otherwise the PDF asks you to connect.
- Every download — CSV or PDF — is recorded in the audit trail with what, how many rows and the file name. Downloads
  from **Export ▾**, **Audit → Download PDF** and **Learning → Progress → Download PDF** made without signal are
  recorded when the phone is back online (with several tabs open, once). An invoice, candidate profile, interview
  sheet or venue report PDF made without signal is not recorded yet.

### Learning videos

**Learning → Videos** (everyone): under the pitches on the Learning page. Each video shows its still, length, topic
and badges: **Required** (for you), **In progress**, **Watched** (with the day) and **Example**. What is required of you
and not watched comes first, then what you are part way through. With more than four videos you can filter by topic.

**Add video** (administrators, and team leaders when an administrator allows it): choose **Upload a file** (MP4, WebM
or MOV up to 2 GB; a progress bar shows how far it is, **Cancel upload** stops it; keep the page open) or **Paste a
link** (YouTube, Vimeo or Google Drive; a Drive file must be shared with "Anyone with the link"). Then a title, what it
covers, the topic (Interviews, Pitching, Objections, Leadership, Other), who it is for (Everyone, Leaders, Reps) and
**Required**, which adds it to the Learning checklist of everyone it is for. For a link you can give the length
(mm:ss, e.g. 9:58): it counts as watched at 90% of it. After adding, the video's page opens. While a video uploads,
pressing Escape or Back asks **Stop the upload?** (**Keep uploading** / **Stop the upload**), and closing or reloading
the tab asks before leaving. Ctrl+K / ⌘K (the search) waits until the upload has finished ("Search opens once the
upload has finished"). **Cancel upload** stops it at once.

**The video's page**: the player, picking up where you left off ("Picked up where you left off, at 8:15." with
**Start from the beginning**). **Your progress** fills in as you watch and says **Watched** once you have seen 90%;
skipping ahead does not count, and watching a part twice counts once. An uploaded video whose length Linear Hub could
not read counts as watched once it knows the length (the office can type it in Edit video). A Google Drive video cannot tell Linear Hub how
much you watched: tap **Mark as watched** when you have. Administrators see **Who watched** (who has watched it and
when, and who is part way). Whoever may change a video sees **Edit** (title, description, topic, who it is for,
required, a link's length) and **Delete video** there.

**Learning → Progress**: **Required videos** lists the ones required of you, with a bar ("1 of 3 watched"); each
counts once you have seen 90% of it. Leaders on **My team**
(administrators on **Everyone**) see how many people have watched every required video and a row per person
("6 of 8 watched", a numbered dot per video, green once watched); a person's own page shows their required videos.

**Settings → Learning videos** (administrators): **Leaders can add videos** (off at first), and how many uploaded
videos the server holds, how big they are and the folder they are in.

### Client accounts and campaign pages

**For clients (the client portal).** Sign in with your email and the access code from your invite (CL-0002…). The
first time, create a PIN of 4 to 6 digits; you type it after your email and access code every time (a client account
always keeps a PIN: you can change it, not remove it). Forgotten it? Ask Linear MCR to reset your PIN, then sign in
with your email and access code and create a new one. Since 1.4 you then set up two-step verification too, and type
the code from your authenticator app after your PIN at every sign-in (see [What's new in 1.4](#whats-new-in-14)). **Updates** has one form: choose **Update** or **Announcement**
(published to the Linear MCR team's Announcements straight away, with your organisation's name on it) or **Commission
change** (a new rate per sub to the fundraiser and / or the payout per sub to Linear, and the date it starts — it waits
for Linear MCR to approve it). If something is missing when you tap the button, the page scrolls to the first field to
fix and puts the cursor in it. **Your posts** lists everything your
organisation posted: Published, Waiting for Linear, Approved from Mon 2 Nov, Declined (with the reason) or Unpublished.
**Security** shows your account and lets you change your PIN and, since 1.4, your two-step verification (status,
recovery codes left, **New recovery codes**). Forgotten your PIN or lost your phone? Ask Linear MCR to reset it.

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
instructions to copy into an email (sent from the computer that runs Linear Hub, a `localhost` address, they say "Open
the Linear Hub sign-in page": add the address the client should use); per account **Edit** (name or email; the access code stays), **Reset PIN**, **Reset two-step** (1.4, for a lost or new
phone) and **Turn off** / **Turn on**. "No PIN yet" means the account has not created its PIN (a new invite, after Reset
PIN, or the demo client); "No two-step yet" that it has not set up two-step verification.

**For leaders.** The same campaign page and posts, read only (no decisions, no client accounts).

**For reps and recruiters.** Tap the "From BCN" badge on a client's announcement (dashboard) to open the campaign's
page: the brief for the field team, the client's announcements and this month's events (reps: your team's), never any
money and not the client contact's email or phone. The contact card says who to ask instead: a rep with a team
"Questions for Breast Cancer Now go through your team leader or the Linear MCR office"; a recruiter (office staff, no
team) or a rep without a team "Questions for Breast Cancer Now go to the owner or another administrator".

### Recruitment: date of birth, schedule and interview sheets

**Recruitment → Schedule.** Every interview by day with its time, type, candidate (and the stage they are at now),
interviewer and how far the sheet has got. Choose **Today**, **This week** or **Next week**, and filter by interviewer
(**Me**, **No interviewer yet**, or a person) or by type. **Schedule interview** books one for any open candidate.
**Reschedule** moves it to another time or gives it to another interviewer; **Open sheet** opens the interview sheet.

**The interview sheet.** Open it from the schedule, from a candidate's **Interviews** card (**Sheet**) or from the
timeline. Each question has an answer box and an optional score from 1 to 5 (tap the score again to clear it). Write
the candidate's answers in a few words as you go — the sheet saves by itself ("Saved 10:42"). If you asked something
that is not on the sheet, add it under **Add a question you asked**; if you did not ask a question, tap **Not asked**.
Record the outcome on the right (at the bottom on a phone). Under each answer you can see who last changed it and
when. Until anything is saved the sheet shows today's questions; as soon as anything on it is saved its questions are
fixed, so changes in Settings never alter an interview that has happened.

The same sheet can be open on two devices: each saves only what it changed, so one never wipes the other's answers. If
both change the same question, the second sees "Rhys Morgan changed this on another device" with their answer under
yours ("Not saved yet" under your box): tap **Keep mine** or **Use theirs**. Nothing else on the sheet waits for that
choice. If you leave the sheet before choosing, a message names the question; your words are kept on this device and
the choice is waiting when you open the sheet again. Closing, reloading or leaving the sheet while it is still saving
(a slow hotspot) loses nothing: what you typed is saved, and opening the sheet again shows it.

**A candidate's page** now shows the date of birth and age in the profile (the pencil edits it) with an **Under 18**
warning when it applies, every interview with **Reschedule** and **Sheet**, **Questions and answers** (each saved
sheet, the questions as they were asked, with who last changed each answer), and a **Timeline** of everything: who moved each stage, every interview and
its interviewer, bookings, interviewer changes, reschedules and outcomes. **Add candidate** has an optional **Date of
birth**.

**Settings → Recruitment: interview questions** (administrators and recruiters): pick the interview type, then **Add
question** (optionally only for one position), edit the words (pencil), move a question up or down, or **Turn off** one
you no longer ask (**Turn on** brings it back). A question already in the list is refused ("That question is already in
the final interview list"). Ask about the job only; a warning appears if a question seems to be about age,
health, family, religion, where someone is from or another protected characteristic.

### Venues, rosters and event plans

**Venues** (sidebar, under Events; or **Venues** at the top of the Events page). Every venue the team has worked, each
with its sales a shift, shifts and visits, "a sale every N stops", the last and next visit and its campaigns. Sort by
**Sales a shift**, **Shifts** or **Last visit**, or search by venue or town. The bar under each venue compares its sales
a shift with the best listed; the tick marks the company-wide figure. Venues with fewer than 10 shifts come after the
rest when sorting by sales a shift: a handful of shifts is too few to rank. **Export CSV** downloads the list (and
**PDF** once PDF exports arrive).

**A venue's page** (tap a venue, or **Venue numbers** on an event's page):

- Four tiles: sales a shift, stops per sale, stops a shift (each against the company) and shifts.
- **The law of averages**: the sentence ("At Golden Square, every 26 stops made a sale on average, steady across 89
  shifts."), a dot for every shift (stops across, sales up) with the fitted line, the shifts in three groups by stops
  (fewest, middle, most) and how steady each step is from visit to visit — **Steady** means the visits differ by no more
  than luck alone would explain.
- **A shift here and company-wide**: each gauge per shift and each step's rate, here and across the company (▲ / ▼ when
  a step is more than 5% above or below).
- **By campaign**: each campaign's sales a shift here and company-wide; pick a campaign to see its six gauges and five
  steps here against the same campaign everywhere. **By weekday**: sales a shift by day, then pick a day for the same
  comparison (Mondays here against Mondays everywhere).
- **Your numbers here** and **Events here** (coming up, with who is booked, then earlier ones with their sales).
- **Venue report** (once PDF exports arrive): the whole page as a PDF — the law of averages, the comparisons, how
  steady each step is, the events (and, for the office and leaders, the people).
- **People here** — the office sees everyone who worked the venue; a leader sees their own team. Reps see the venue's
  numbers and their own, never a colleague's.

**Who's working** (an event's page). Everyone booked, with who booked them ("booked yourself", "booked by you",
"booked by Amelia Hart"). A leader (or the office) taps **Edit bookings**, ticks the team members working that day (or
**Tick the whole … team**) and taps **Save bookings**. Saving changes only the people ticked or unticked, so someone
who books themself while the list is open stays booked. Someone on leave stays booked, marked "on leave". A rep taps
**I'm working this** on their team's events, or **I can't make it** to come off. Bookings close once the event is over or cancelled. Once a leader has booked people, the
forecast counts the people booked ("· 3 booked"); while only people's own bookings are in, it keeps the team's usual
number as a floor ("· 3 booked, 6 expected"). Someone who leaves drops off the list.

**Your plan** (an event's page, for everyone booked). "To make 4 sales you need about: 88 stops, 33 to table, 18
presentations, 8 closes, 5 taps", where the target comes from (the event's target shared among the people expected, or
your good day when that is higher — and when the share is far above a good day, the plan aims for a good day and says
so), the range most days fall in, and how much comes from your own last 8 weeks and how much from everyone's shifts at
the venue. A leader sees every booked person's plan under their own (someone the office booked from another team: a
plan from the venue's numbers only). The same plan shows in one line as **Aim** on the event's row in Events, on the
dashboard's upcoming events and in Quick gauges, where it takes the first line under the event ("Aim 4 sales · 88
stops → 33 → 18 → 8 → 5 taps", cut short with "…" on a small phone) and the help keeps its first sentence, so all six
tiles stay on one screen. Plans are estimates: luck evens out over many shifts, not in one.

### Audit of every action

#### Audit (administrators)

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
administrators, the address it came from. **Download PDF** (P4) prints every entry that matches the filters (newest
first, up to 2,000 — not only the 50 on screen), with the filters written out ("Showing: Sign-ins", "Person: Jordan
Lee", "Dates: 1 – 21 Oct 2026").

#### Team → person → Activity (administrators)

A person's page has an **Activity** card under their performance: everything they did and the failed attempts to sign
in to their account ("Attempt on this account"), newest first, with their last sign-in, when they were last active
(failed tries on the sign-in page do not count: they may be somebody else's) and how many failed attempts there were
on their account in the last 30 days (in red when there were any). The chips narrow it to changes, sign-ins, exports or opened records; **Show more** loads 20
more; **Open in the audit trail** shows the full list with every filter.

---

## What's new in 1.2

Linear Hub 1.2 adds a **Learning** page for the COD pack and your campaign pitches, and a set of upgrades for the
field and the office.

### Learning pack: COD pack lessons, the Learn / Teach checklist and the progression tracker

**Learning** (sidebar, everyone) opens the Learning page:

- **Your COD pack**: how many lessons you have learned and taught back, and a button to carry on (**Continue: …**, or
  **Teach back: …** once everything is learned).
- **Field cards**: **5 steps to a conversation** and **The six objections**, each one phone screen with the line to
  say, for a quick look between stops. Tap a line to open that part of the lesson.
- Campaign pitches (from the pitch studio) sit above the lessons.
- **The COD pack**: 21 lessons grouped like the pack's leadership checklist, each with its state (**Not started**,
  **Learned**, **Teach-back sent**, **Taught**). Search finds a lesson by any word in it ("GIFGUP", "no time", "pause").

A lesson shows a summary and the key points, the lesson itself with the pack's pictures, then:

1. **Self-check**: three questions. Get all three right (**Check my answers**) and the lesson is learned. Got one wrong?
   It says which question to look at again (not the right answer), so read that part of the lesson; **Try again**
   keeps your right answers, as often as you like. The explanations show once all three are right.
2. **Teach it back**: write the theory in your own words and **Send to my leader** (people without a team leader
   send it to the office). Only you, your team leader and the office can read it. You can **Rewrite it** later. If you
   teach it at the whiteboard instead, your leader can sign it off in person.
3. **Signed off**: your leader ticks it and the lesson shows **Taught**. A sign-off counts as learned too, so if you
   taught it at the whiteboard before taking the self-check, Learn is ticked as well.

"Run an impact" and "Go on a roadtrip" are practical tasks: the COD pack lists them but does not describe them, so
ask your leader what each involves. Once you have done it, tap **I've done this**, then say how it went.

**Progress** (from the Learning page, **Checklist and progress**):

- **Reps and recruiters**: your leadership checklist (Learn and Teach ticks for every lesson) and the progression
  tracker: your level, the next one and each criterion with your real numbers (for example "12 of 14 sales this week",
  "9 of 21 lessons learned"), a chart of your sales per week for the last 12 weeks against the 14 and 12 lines (touch
  or slide a finger along it, or hover, to read a week; on a keyboard Tab to it and use the arrow keys), and the whole
  ladder from entry level to national consultant. Recruiters see the checklist only (they are outside the field
  ladder).
- **Leaders**: **Me** shows your own; **My team** shows the teach-backs **Waiting for your sign-off** (read them and
  tap **Sign off**), everyone's Learn / Taught counts, and on a tablet or computer the whole checklist grid. Open a
  person to tick their Teach column (**Sign off**, which ticks Learn too if it was empty; tap a green **Taught** to
  withdraw it) and see their progression. Withdrawing takes Learn back only when the sign-off was the only reason for
  it: if they have passed the self-check (even if a later retake went wrong) or written a teach-back since, it stays
  learned, and the dialog says which.
- **Admins**: **Everyone** instead of My team, and on a person's progression the criteria the office confirms by hand
  (marked **Office**) have a switch or a count to set, e.g. **4 + 1 or 3 + 2** or people trained to leadership.

**Dashboard** (reps and leaders): a one-line card under the week's pay estimate, e.g. "Your next level: 12 of 14 sales
this week; 9 of 21 lessons learned". Tap it for the Progress page.

### Pitch studio: campaign pitches, annotations and practice modes

**Learning → Pitches.** At the top of the Learning page there is a card for every active campaign (and any inactive
one that has a pitch). A campaign with a pitch shows its title and when it was last updated; tap it to open the pitch.
Admins and leaders see **Write the pitch** under the name of a campaign without one; everyone else sees "Not written
yet". A long campaign name wraps to a second line rather than being cut.

**Opening a pitch from the field.** On **Quick gauges** a microphone button next to the event opens that campaign's
pitch; on an event's page the **Pitch** button does the same. Both only appear when the campaign has a pitch.

**The pitch page** (`/learning/pitch/BCN`) shows the campaign, the title, how many lines it has, about how long it
reads aloud and who updated it last. Choose how to practise:

- **Read**: the script in large type, in its five steps (Introduction, Short story, Presentation, Close,
  Consolidation), each with the pack's target time and the script's estimate ("Estimate over 7–10 s" means the words
  take longer than the target at a steady pace; time yourself with the step timer). Stage directions are grey italics,
  pauses are a row of dots ("Pause · 1 s"), **Name** marks where their name goes and **Close** marks the close. When
  they answer a question, "If yes" and "If no" sit side by side (tabs on a phone). Under each line, small chips name
  the COD pack theory it uses (**Pre-emptive strike**, **Group effect**, **Greed** …); tap one to see why it works and
  **Open the lesson**. Turn **Show the theory** off for a clean script.
- **Check the figures.** Where the fact check has a note on a line, it sits beside the line on a wide screen and under
  it on a phone (tap **Check the figures**): what the charity actually says, a suggested accurate wording and the
  source. Each line has its own note, so "Over 1000 women…" and "every 43 minutes…" each get their own suggestion. A
  green **Checked** note means it matches. The script itself is never changed by the check: the office decides the
  final wording.
- **In the teleprompter and the flashcards** a strip says how many lines still need checking ("Check the figures: 5
  lines use figures the office has not approved yet"; on a phone just "Check the figures: 5 lines"), with **See the
  notes** to go to the notes in Read mode. In the teleprompter it sits at the top of the dark panel, so Play and the
  speed still fit on the screen; in the flashcards it is in the "Lines you know" card (at its top on a phone, next to
  "Saved on this device only." on a wider screen, so it adds no height above the card). In the teleprompter those
  lines end with an amber warning sign, with the suggested wording under them (on a phone, tap **Check the figures**
  under the line). The notes do not speed it up: the lines scroll at the words a minute you chose, and a note under a
  line simply takes its own time. A flashcard for one of those lines says **Check the figures** at the top; once you
  reveal the line, the note and its suggested wording show under **Again** and **Known** (on a phone, tap **Check the
  figures** there to open it), so the two buttons stay in the same place on every card.
- **Step timer**: tap **Start** as you begin, **Next step** as you move from the introduction to the short story and
  on, then **Finish** (or **Stop**). Each step shows your time against the target (introduction 7–10 s, short story
  10–15 s). On a tablet, or beside the sidebar on a laptop, each step's number sits above its name so every name shows
  in full. On a phone, held upright or sideways, it shrinks to one line that stays at the top with **Next step** and
  **Stop** while you read down. Nothing is saved.
- **Teleprompter**: the script on a dark panel that scrolls by itself past a reading line. **Play**/**Pause**, **−**
  and **+** to change the speed (words a minute, kept on the phone), the circle arrow to go back to the start, and the
  corner button for full screen. Turn the phone sideways for the widest lines. On a keyboard: Space plays and pauses,
  the arrow keys change the speed, F goes full screen, Esc leaves it. The screen stays awake while it plays.
- **Memorise**: flashcards, one line at a time. You see the line before as the cue; say the next line, then tap to
  check and mark it **Known** or **Again**. "Lines you know" counts up; **Only lines still to learn** skips the ones you
  know; **Start over** clears it. Progress is saved on this device only. On a phone the card comes first and the
  "Lines you know" card is under it, so the line and **Again** / **Known** usually fit on the screen without scrolling
  (the longest lines need a short scroll).

**Writing and editing (admins and leaders).** **Edit** on a pitch (or **Write the pitch**) opens the editor: a title,
the script, and the fact-check notes, with a live **Preview** beside it (a **Write**/**Preview** switch on phones and
tablets). **How to write the script** lists the format: one spoken line per line; `(Pause - 1 Second)` for a pause;
`(Name)` for their name; `(Close)` for the close; `Yes -` and `No -` for the answers to a question; `(Short story)`,
`(Presentation)` and so on to start a step. **Start from a template** fills an empty script with a skeleton in that
format. Fact-check notes go one per line starting with "- ", with the words they are about in double quotes and a
colon; links become sources. Only the office (administrators) writes the fact-check notes: leaders see them greyed out
with "Only the office can change the fact-check notes." and can change the title and the script. **Save pitch**
publishes it to everyone straight away; **Cancel** asks before throwing changes away. Every save records who made it,
and the audit trail keeps the history.

Recruiters and reps read every pitch and practise with all three modes; they cannot edit.

### Sign-in PIN and stronger sessions

**Everyone — your PIN (Settings → Security → Sign-in PIN).** Tap **Set a PIN**, type 4 to 6 digits twice and save.
Avoid 1234, 0000, the most common PINs and the digits of your employee ID; the screen tells you which rule a PIN breaks.
From then on, signing in asks for your email and employee ID, then your PIN. Setting or changing your PIN signs you
out on your other phones and laptops. **Change PIN** asks for the current one; **Remove** (when your administrator
does not require PINs) takes you back to email and employee ID only.

**Signing in.** After your email and employee ID, the "Enter your PIN" screen appears if you have one. Ten wrong PINs in
a row lock it for 15 minutes, and the screen says when you can try again ("Try again after 14:35"). If it happens again
before you get it right, the wait doubles each time (30 minutes, then an hour, up to a day). Once you sign in with the
right PIN the count starts again from nothing. Forgotten it? Ask an administrator to reset it, then sign in with your
email and employee ID and choose a new PIN. If your PIN locks and you did not type the wrong PINs yourself, change it
and tell an administrator. A 6-digit PIN is much harder to guess than a 4-digit one.
If you are away from Linear Hub for longer than the sign-out time (12 hours unless your administrator changed it), you
sign in again. Since 1.4 you are also signed out 14 hours after signing in, whatever you are doing.

**When your administrator requires a PIN.** The next time you open Linear Hub you see **Create your PIN** instead of the
app. Type a PIN twice and tap **Save PIN**; you carry on where you were. **Sign out** is there if you are on someone
else's phone.

**Administrators — Settings → Security → Sign-in rules.**
- **Require a PIN for everyone.** Set your own PIN first (the switch says so). Everyone without a PIN, including people
  signed in right now, creates one before they can carry on. Demo accounts too.
- **Require two-step verification for administrators** (1.2 to 1.3.1). Since 1.4 this switch is gone: two-step
  verification is required for everyone (see [What's new in 1.4](#whats-new-in-14)).
- **Sign out after inactivity.** 1 to 72 hours (12 by default). Shorter is safer for shared phones.

**Administrators — resetting a PIN (Team → person → Edit profile → Sign-in PIN).** The badge shows **PIN set**, **No PIN**
or **Locked** (with the time the lock ends). **Reset PIN** clears it and its lock and signs them out everywhere; they
sign in with their email and employee ID and choose a new PIN (straight away, if a PIN is required).

**Administrators — your own PIN.** You cannot reset your own PIN from the Team page. If it is locked, wait for the time
on the sign-in screen, or ask another administrator. If you are the only administrator, whoever looks after the server
runs `npm run pin:reset -- your.email@linear-mcr.co.uk` there (in the `linear-micro-crm` folder): it clears your PIN and
its lock, signs you out everywhere and notes it in the audit trail. Then sign in with your email and employee ID and set
a new PIN.

**Leaders, recruiters and reps** see only their own PIN card; the rules and resets are for administrators.

**Putting Linear Hub online.** `docs/DEPLOY.md`: a small UK/EU server with Caddy (automatic HTTPS) or Fly.io / Render,
with costs, backups off the server and a go-live checklist.

### Bulk gauge entry with WhatsApp paste

**Leaders** — open **Gauges** and press **Bulk entry** (next to **Tally**).

1. Today's event for your team is already chosen; pick another from **Event** if you need to (the last three weeks).
2. Everyone on your team has a row. People who already logged show their numbers with a green **Logged** badge.
   Type the six numbers for anyone else (a blank counts as 0) and their check-in time. **Enter** jumps down to the
   next person in the same column on a keyboard. Use **Not saved yet** to see only the people still to do.
3. Or press **Paste from WhatsApp** and paste the numbers from the team chat — one person per line, like
   `Jordan 65 22 11 5 3 3`, `Jordan L - 65/22/11/5/3/3` or `amelia: 40 12 6 2 1 1 in 9:58`. You can paste a whole chunk
   of the chat: timestamps, emojis and chat lines are skipped, and a message with no name uses the sender. Each line
   shows what was read. If a name matches two people, or nobody, choose the person from the list. Lines with a problem
   (say, more to table than stops) are marked in amber. Press **Fill N rows** to put them in the table.
4. Check the rows: anything marked in red needs fixing first. The bar at the bottom says how many are new and how
   many will update. Press **Save N people**. Everything saves together, or nothing does — if Linear Hub refuses a
   row, it is marked with the reason and nothing is saved until it is fixed.

If the signal drops, your numbers stay on this phone; open **Bulk entry** again and they are back on the sheet
(**Discard them** throws them away). A week that has already been paid cannot be changed by a leader — ask an
administrator.

**Administrators** — the same page, for any team's events (the event list shows the team), and for paid weeks: the
change goes through and the payslip is marked "adjusted after payment".

**Reps and recruiters** do not see **Bulk entry**; reps keep logging their own day with **Log gauges** or the tally.

### Audit trail and announcement read receipts

#### Administrators

- **Audit** (sidebar, under Manage) lists every change, newest first, grouped by day: who made it, at what time, a
  sentence saying what happened and a tag for the kind of record. Each day is headed with its date ("Wednesday 21
  October"; the year is added for another year), never "Today" or "Yesterday", as the times are when the change
  really happened. A lesson is named by its title: "Learned “Pre-emptive strike”: self-check passed". Tap a row to
  see exactly which fields changed, with the old value struck through and the new one beside it, plus the route and
  the IP address it came from.
- Narrow the list with **Search** (words in the sentence, e.g. "marked paid" or a name; apostrophes do not matter,
  so "cant controls" finds "Can’t controls"), **Person**, **Record** (pay run, gauge entry, person, candidate …) and
  **From** / **To** dates. **Show sign-ins** adds sign-ins and sign-outs,
  which are hidden by default so the page is about changes. **Clear filters** starts again. **Newer** and **Older** move
  through the pages, 50 changes at a time. The filters are part of the page address, so a view can be bookmarked.
- On a payslip (Finance → open a pay run) the **History** section at the bottom lists that run's changes: marked paid,
  recalculated after a gauge change (with the old and new gross), adjusted after payment. **Open in the audit trail**
  shows the same rows on the Audit page. An open gauge entry has the same **History** section. Its times carry their
  date ("21 Oct 2026, 09:24").
- Under each announcement on the dashboard, **Read by 27 of 28** shows how many active people have read it; tap it to
  see their names. Earlier ones are under **Older announcements** at the bottom of the card (with how many there
  are): tap it to list up to 20 more, each with the same **Read by** line.

#### Leaders

- When you open one of your team's gauge entries to edit it (event page → **Edit**), the **History** section under the
  form shows who logged or changed it, when, and what changed. You do not see the IP address, pay runs or anyone
  else's records.
- Under announcements you wrote, **Read by 12 of 33** shows how many active people have read it, and tapping it shows
  who, under **Older announcements** too. You do not see these figures for other people's announcements.

#### Reps and recruiters

- Nothing new to do. When an announcement has been on your screen for a moment it counts as read, so whoever posted
  it knows it reached you; one you open under **Older announcements** counts the same way. You do not see who else
  has read it, and there is no Audit page or History section for you.

### One-tap shift check-in

**Reps and leaders**

- On the **Dashboard**, each of today's events in *Upcoming events* has a **Check in** button, with "Starts 15:30 · 5
  min grace" next to it. Tap it when you arrive. It changes to "Checked in 15:02 · on time" (green) or "· 6 min late"
  (amber; over an hour it reads "· 1 h 20 min late"). It does not log any gauges, and it is not a day worked.
- Tapped by mistake? **Undo** stays next to it for 2 minutes. After that, ask your team leader to remove it.
- On **Quick gauges**, the button sits in the event strip at the top. On a phone it is a pin icon. Once you are checked
  in it shows a tick (green on time, amber late) and, on an iPad or a computer, the time. Tap the tick to see the time
  again, with **Undo** while it is still allowed.
- **No signal?** Tap **Check in** anyway. The phone keeps the time you tapped and shows "saved on this phone". A line
  under the top bar says "1 check-in waiting to send". It sends by itself when the signal is back, or tap **Send now**.
  - It must reach Linear Hub within 24 hours of the event ending. After that it is refused, and the line says so: ask
    your team leader to record your arrival time instead.
  - A tap more than an hour before the start is recorded as one hour before the start. That is still on time.
  - If Linear Hub refuses it (say the event was cancelled), the line explains why. Tap **×** to dismiss it.
- On an event's page you see **Your check-in**: the button today, or "You checked in 09:24 · on time" afterwards.
- When you **Log gauges**, **Checked in at** is already filled with your check-in time. You can still change it.
- If your team leader records your arrival time when they log your gauges, their time counts for punctuality instead
  of your check-in. You can still change your counts and notes, but not that time: **Checked in at** is greyed out
  and says "recorded for you by a leader or admin". Ask them if it needs changing.
- The **Check in** button only appears on the day of the event, until the event ends.

**Team leaders and admins**

- Each event's page has a **Roll call**: who has checked in and when, earliest first, with "on time", "11 min late"
  or, over an hour, "1 h 20 min late".
  Today's events also list who has **not checked in yet**. The heading counts them, e.g. "6 / 8 checked in · 1 late".
- A phone icon with "sent later" marks a check-in that was tapped without signal and sent afterwards, with the time it
  was tapped. Every check-in whose time came from the phone carries it, so such a time never looks like a live tap.
- **Remove (×)** takes a check-in away at any time. For example, someone checked in from the wrong place. Punctuality
  for that day then goes back to the time on their gauges, if any. Gauges and pay are not affected.
- **Recording someone's arrival time yourself.** When you log a person's gauges (one at a time or with bulk entry)
  with a **Checked in at** time, your time counts for their punctuality, even if their phone sends an earlier
  check-in later, and they cannot change it themselves. Leave the field empty, or keep the check-in time the form
  fills in, and their own check-in counts, to the second. Editing their counts without changing the time keeps
  whichever time counted before. The field's hint says which time will count, for example "the time you save here
  counts instead" or "punctuality uses it unless you change the time here".
- Your own **Check in** button is in the roll call's header until you have checked in.
- Punctuality on dashboards, profiles, the week in review and the **Check in with…** list now uses check-in times
  where there are any, except where a leader or admin recorded the time on someone's gauges.

**Recruiters** see no check-in buttons or roll calls.

### Search, payroll export and a layout fix

- **Search (⌘K or Ctrl+K).** The field at the top of every page now finds people, events, candidates and campaigns as
  well as pages. Type two letters or more. Use the arrow keys and Enter, or tap a result. It also offers **Log gauges**,
  **New event** (leaders and admins) and **Mark week paid** (admins). On a phone, tap the magnifier in the top bar.
  You only find what you could open anyway: reps see their own team's events and no candidates.
- **Export for payroll (admins).** Finance → Company → Runs to pay → **Export for payroll**. Pick the week and **Xero
  Payroll** or **Sage Payroll**: you get a CSV of that week's unpaid runs to import. It never changes a run; mark the
  runs paid as usual once the transfer has gone.
- **Gauges at 1024 px.** The date presets move under the tabs when there is not room for both, so the page no longer
  scrolls sideways on a small laptop or an iPad held sideways.

---

## What's new in 1.1

Linear Hub 1.1 is the **smart release**. It does not add new screens so much as make the existing ones notice things
for you: how your week is going against your own usual pace, what this week's pay is likely to be, who on a team might
welcome a chat, what needs doing next, how an event is likely to go, and a short review of the last finished week
you can paste straight into WhatsApp. It also keeps your gauges safe when the hotspot drops. Everything is worked out
from the same numbers you already see on your tiles, by fixed rules (no outside service and no AI), so the same week
always reads the same way, and every forecast is labelled an **estimate** with its range. Nothing private leaves your
screen: your pay, your pace notes and the check-in list are only ever shown to the person they belong to. If the office
ever wants them gone, the estimates and suggestions can be switched off on the server with one setting.

Everything below is built for a phone first: buttons are big enough to tap, and anything a mouse shows on hover is
also on the screen already, or one tap away (open the event, the run or the person).

**At a glance, by role**

| You are | What is new for you |
|---|---|
| **Rep** | A note when your week is off (or ahead of) your usual pace; your sales streak on the **Sales** tile; **This week (estimate)** of your pay with how far you are from the bonus; the bell and **Needs attention** card (unlogged days, tomorrow's event, your pay); event forecasts; saves that wait on your phone when the signal drops; the **Tally** counter and **Quick gauges**, the same tally as six big buttons for the field; **Your week in review** of the last finished week. |
| **Leader** | All of the rep's, plus **Check in with…** (a private list for your team), **Team coaching**, **Focus** chips, who has not logged an event yet with **Log for …**, suggested targets when you create an event, and team lines in the bell. |
| **Recruiter** | Deadlines that set themselves when you move a candidate, **Idle** badges and **Longest idle first**, **Record the outcome** prompts, an **Idle beyond target** tile, the bell, and your week in review. |
| **Owner / administrator** | Company-wide **Check in with…** and **Company coaching**, payroll checks before you pay, **Mark week paid** and paying many runs at once, **Runs to pay** in the bell, the **Backups** card in Settings, and the company review of the last finished week. |

### Links that open the right screen

Some links now take you straight to the action, not just the page. A link to **Log gauges** for an event opens the
**Log gauges** window with that event already chosen (a leader's or administrator's link can also pick the person);
after it opens, the address goes back to plain **Gauges**, so pressing Back never opens the window again. An
administrator's link to **Runs to pay** opens **Finance → Company** and scrolls to the **Runs to pay** card.

### If a card hits a problem

If one card on a page fails to draw, only that card is replaced by **This card hit a problem** with a **Try again**
button; the rest of the page keeps working. The bell at the top works the same way: if it fails it turns into a
crossed-out bell, and tapping it tries again. If a whole page fails you see **This page hit a problem** instead — try
again, or open another page from the menu.

### Your pace and streaks

**Your usual pace (reps, leaders and administrators who log gauges).** Under the coaching tips in **Your funnel** on
the dashboard, Linear Hub compares this week (Monday to yesterday) with your own last 8 weeks — never with anyone else:

* **Off your usual pace** — you are averaging noticeably fewer stops a day than usual (after at least 2 days). When your
  conversion is holding (at least 100 stops this week, and no more than 10% under your usual), it also tells you how
  many extra stops usually make one sale.
* **Conversion below your usual** — after at least 100 stops this week, your conversion is clearly below your usual.
  It names the one funnel stage to work on first.
* **Converting above your usual** and **Ahead of your usual pace** — a well-done when you are clearly beating your own
  usual.
* **Steadily improving: 3.6% → 5.2% over the last 16 weeks**, or **Conversion has drifted from … over 16 weeks** — how
  your conversion has moved across the last 16 weeks, shown only when the change is clear.

Today and events still live never count, so the note does not change while you are on site. You need at least 4 worked
weeks in the last 8 (about 20 stops a day or more) before a pace note appears; new starters and recruiters see the
card exactly as before. These notes are private: nobody else — not your leader, not the office — sees them.

**Streaks.** A streak is the number of days you worked in a row with at least one sale. Days off never break it, and
today only counts once it is over. From 3 days, the **Sales** tile on your dashboard shows it after your rank, for
example **#3 of 9 in your team · 12-day sales streak · best 26**. In a week where your sales so far already beat every
earlier week of 3 or more worked days (once you have at least 4 of those) it shows **Personal best week so far**.
Nothing ever tells you a streak was broken.

**Flames on the leaderboard.** On the **Leaderboard** page and in the team card on the dashboard, a small flame with a
number marks anyone on a streak of 5 days or more (on a computer, hover it to read "12-day sales streak"; screen
readers say the same). Flames only appear on boards you can already see: reps see their own team, the dashboard team
card shows your team, and **Top performers** (administrators and recruiters) shows the company. Only the streak is ever
shown for a colleague — never their pace notes or personal bests.

### This week's pay estimate and payroll checks

**This week's pay estimate (reps and team leaders).**

- **Dashboard.** Under your tiles, a strip reads **This week (estimate): about £1,050 · £930–£1,140** — what this
  week's payslip is likely to be, with a low–high range — and one line about your bonus: how many more sales unlock
  it and roughly how many stops that is at your own rate, or **Bonus unlocked** once you are there. On a phone the
  same facts are shorter ("~" means "about"), for example **£75 bonus: one more sale · ~23 stops**. Tap the strip to
  open **Finance → My pay**.
- **Finance → My pay → This week so far.** The same estimate with the workings: what you have logged so far, days and
  sales, the team event days left, and a bar towards the bonus. The **ⓘ** button explains the method, e.g. "your 2.1
  sales a day over the last 8 weeks, for the 2 team event days left".
- It is an **estimate**: it assumes you work every team event day left this week and sell at your usual rate. Friday's
  payslip is the official figure, and **Next payday** still shows the official amount. New starters see "not enough
  history for a range" until they have five worked days in the last 8 weeks.
- Only you see your estimate. Recruiters and administrators do not get one.

**Payroll checks and paying many runs at once (administrators).**

- **Finance → Company → Runs to pay** says **N runs need a look** when some unpaid runs look unusual. Those runs carry
  an amber **Check** badge. Open the run for the payslip's **Checks before paying** list (on a computer you can also
  hover the badge), for example "£780 is 2.6× the usual £300". Checks are advice only: you can always pay.
- **Select runs** with the boxes on the left (the box in the header selects every run you can in that list). In a long
  list grouped by week, **Mark week paid** selects that week's pending runs. Failed transfers are left out until you
  tick **Include failed transfers**.
- The bar at the bottom shows **Mark 23 selected paid · £4,310.00** and a **Paid on** date (today unless you change it;
  it cannot be before the latest selected week ends or after today). **Clear** empties the selection.
- If any selected run has a check, you see the reasons first and confirm with **Mark N paid**. The same happens when
  you press **Mark paid** on a single run with a check.
- Runs are paid one at a time while a notice says **Marking N runs paid…**; then a summary such as **22 marked paid ·
  1 skipped (already paid) · 0 failed**. A run someone already paid is skipped, not paid twice. Runs that fail stay
  selected so you can try again. While the batch runs, the single **Mark paid** buttons wait (they are greyed out).

### Check in with… (leaders and the owner)

**Check in with…** is a short, private list of people it may be worth a word with this week. It is a list of
conversation starters, not a ranking or a verdict.

- **Leaders** find it on the dashboard, at the bottom of their team card under **Team coaching**. It covers only their
  own team and never themselves.
- **The owner** finds it in the **Company** section, next to **Company coaching**. It covers every team, and shows
  each person's team under their name.
- Each person shows their first two reasons, one per line, with the numbers behind them. For example: "Worked 2 of the
  team's 9 event days this fortnight — usually 7 in 9", or "Late for 4 of the last 10 check-ins (team: 1 in 7)" (the
  team figure is everyone else on the team). Tap **+N more** to show the rest, **Show less** to fold them away again,
  and tap the name to open their profile.
- Earnings reasons always include last week's pay: if last week's payroll has not been worked out yet, the list works
  it out first.
- At most five people appear, the ones with the most to talk about first. Lateness on its own never puts anyone on
  the list.
- Nobody on leave, and nobody who has left, ever appears.
- When nobody stands out, the card says **Nobody needs a check-in this week**.
- Reps and recruiters never see this list, about themselves or anyone else.

**Team coaching (leaders).** Under the team's mini leaderboard, up to three sentences about the team's funnel for the
selected period, each with one thing to run at the huddle. For example: "The team's stop-to-table rate is 31% vs the
35% benchmark. Run a five-minute opener drill at the huddle".

**Company coaching (owner).** In the Company section: the same coaching for every team together, with one thing to
ask of the leaders. For example: "Linear MCR's tap-to-sale rate is 80% vs the 90% benchmark. Ask the leaders to
spot-check sign-up forms this week".

**Focus chips (leaders and the owner).** On **Gauges → Team → By person**, anyone with at least 20 stops in the
selected range whose weakest stage is below benchmark gets a chip such as **Focus: stop → table**. The ratio cells in
the same row show their rate against the benchmark (on a computer, hovering the chip shows it too). It tells you what
to practise together.

Reps keep their own coaching on the dashboard and the Gauges page exactly as before. If the office switches the smart
features off, the check-in list disappears for everyone; Team coaching, Company coaching and the Focus chips stay,
because they are worked out from the figures already on the page.

### Needs attention

Linear Hub now tells you what needs doing instead of waiting for you to look. Everything comes from one list, shown in
three places:

- **The bell** at the top right shows a number when something new needs you. Tap it to see the list, grouped (**Your
  pay**, **Gauges**, **Events**, **Payroll**, **Recruitment**, **Security**). Each line has a button that takes you
  straight to the right screen, for example **Log gauges** or **Log for Jordan**. Opening the bell clears the number on
  this device; a line you have read comes back as new only if it gets bigger (for example a second person has not
  logged yet). The browser tab shows the same number, like "(2) Dashboard · Linear Hub". If Linear Hub cannot be
  reached, the bell says **Could not check just now** and offers **Try again**.
- **Pop-up notes** appear at the bottom of the screen for new, important things (at most one when you open the app).
  They never interrupt you while a window such as **Log gauges** is open; those wait in the bell. You will not see the
  same pop-up twice on the same phone or computer.
- **The Needs attention card** at the top of the dashboard shows the first five, with **Show all** for the rest. When
  nothing needs you it simply says **All caught up**.

The list checks again every minute while Linear Hub is open, and clears itself: log the gauges and that line
disappears. There are no phone notifications while Linear Hub is closed (those need a secure https address, and the
hotspot uses plain http).

What each person sees:

- **Reps**: event days this pay week (from Monday, and today once the event has finished) that you have not logged yet,
  one line per day, with what that day is worth from your own pay plan so it is not missing from Friday's pay;
  tomorrow's event with its start time and notes; and your own pay: due tomorrow, overdue, or just paid ("You've been
  paid …"). If an overdue pending payment is older than the 12 weeks the office's pay list shows, the line asks you to
  mention it to the office (a failed transfer is always on the office's list, however old). Only ever about you and your own team's events.
- **Leaders**: the same for yourself, plus your team: who has not logged an event that finished (with **Log for …**
  when it is one person), events with nothing logged ("did it run?"), today's events that are behind target (the
  same events that show the red **Behind target** pill; an event too new to have an estimate counts as behind when it
  has less than half its target after 1 pm), and numbers that look mistyped. Also the candidates you own: overdue follow-ups and interviews that need an outcome.
- **Recruiters**: overdue follow-ups for your candidates and unassigned ones ("8 of your recruitment follow-ups are
  overdue … (yours or unassigned; 11 across the pipeline)" — the 11 is the **Overdue actions** tile), interviews from the last eight weeks that
  need an outcome (the only place the dashboard asks for them), your interviews in the next 24 hours, and your own pay.
- **Owner / administrators**: every team's gaps and events, **Runs to pay** with the total and any failed transfers,
  however old (red when a run is overdue), a payday reminder on Fridays, the whole recruitment pipeline, and a reminder to turn on
  two-step verification if it is off.

### Event forecasts and who has not logged yet

**Event forecasts (everyone).** Upcoming and live events now show what to expect, for example
**expect ≈ 14 (9–20) · 5 reps usually**: an estimate of about 14 sales, likely between 9 and 20, with the 5 people who
usually turn up. It is based on the team's own similar days over the last 12 weeks. Tap the event to see what it is
based on and how many people the target needs (on a computer, hovering the estimate shows the same): "Estimate from 23
similar days (Deansgate team, BCN private sites, last 12 weeks) · range 9–20 · target 17 needs about 7 reps". An amber
**Stretch** pill means the target is well above what the team usually sells on days like this. A red **Behind target**
pill on a live event means the day is unlikely to reach 70 % of its target at the usual pace. Events without enough
history show no estimate.

**Upcoming days are neutral.** Events that have not started show **Target 17** with a grey bar instead of an amber
"0 / 17". Colour starts once the day is under way.

**Suggested target (administrators and leaders).** In **New event**, once you have picked the campaign, team and type,
you see **Suggested target: 14** with a **Use** button. It is only a suggestion: tap **Use** to put it in the **Sales
target** box, or type your own. Nothing is changed for you. It also tells you how many reps the typed target needs.
When there is no suggestion for that choice, the form says so and you set the target as usual.

**Who has not logged yet.** On the Events page, today's and the last two days' events read **4 / 7 logged**, in amber
while someone on that team is missing. Everyone sees these counts (they are numbers only, never names). The 7 is the
team's active members who had started by that day. Someone from outside the team who logged there (an administrator
helping out, say) does not count towards the 4, so the row always matches the event's own list. **Administrators and
the team's leader** can open the event to see **Not logged yet** with one button per person. Tap **Log for Sophie** to
open **Log gauges** with Sophie already chosen. Once you save, her button goes. Reps, recruiters and other teams' leaders
never see the names.

**Reps.** If you have not logged today's event yet, its page says **Log today's gauges**. On the dashboard, today's
event (once it has started) has a **Log gauges** button that opens the form for that event.

**Directions.** Every event row has a directions button (the arrow icon), and the event page has a **Directions**
link. It opens Google Maps (the Maps app on a phone) at the venue.

### If the signal drops

**Reps, leaders and administrators** (anyone who logs gauges):

* **When the signal drops** — or Linear Hub itself is not running — an amber strip appears under the top bar: **Can't
  reach Linear Hub — check the hotspot. Gauges you save are kept on this phone.** It goes away by itself when the
  connection is back; **Try again** checks straight away.
* **Logging without signal.** Log gauges as normal. The button reads **Save on this phone**. You'll see **Saved on
  this phone — it will send when you're back online**, and a blue strip says **1 entry waiting to send**.
* **When the signal is back**, it sends by itself and tells you **Sent from this phone — logged** (or **— updated
  your earlier entry**). Tap **Send now** to try straight away, or **View** to see what is waiting.
* **If Linear Hub already has an entry for that day that this phone had not seen** — for example your leader corrected
  it while yours was waiting, or you had logged the day earlier and the phone could not check for it before saving
  without signal — your entry is not sent over it. The strip says **1 entry needs a look**. Tap **Review** to see both
  versions, then choose:
  * **Send mine anyway** to replace theirs with yours;
  * **Open** to edit yours first;
  * **Discard** to keep theirs.

  The same happens if the entry you were changing was **deleted** while yours waited: the sheet says **Linear Hub no
  longer has the entry you changed — it may have been deleted.** **Send mine anyway** logs the day again;
  **Discard** leaves it deleted.

  If Linear Hub refuses an entry (for example a check-in time in the future from a phone clock that is wrong), it
  shows **Not accepted** with the reason.
* **Signing out.** If entries are still waiting, Linear Hub asks first: **1 entry hasn't been sent — it stays on this
  phone and sends next time you sign in as Jordan.** Nothing is deleted.
* **Private browsing.** Some private modes don't let Linear Hub keep anything on the phone. Then a save without signal
  shows **Could not save gauges**, as before. Keep the form open and save again when you have signal.
* **Keep the page open.** Saves wait safely while Linear Hub is open in the browser. Linear Hub cannot open from
  scratch without any signal yet (that needs a secure https address; it is on the roadmap).
* **Two taps to log.** Opening **Log gauges** from the dashboard or the Gauges page on a day when your team has one
  event under way picks it for you (**Today's event selected**). Around the start of an event (from an hour before to
  an hour and a half after) a **Checking in? Use now (09:58)** button appears. Tap it to record your arrival; it never
  fills itself in.
* **Leaders and administrators:** there, **Rep** starts on the first person in the team who hasn't logged that event
  yet (**First on the team without an entry yet**). From an event's own page it still starts on you.

**Tally — count your shift as you go** (reps, leaders and administrators):

* **Opening it.** Tap **Tally** on the Gauges page, or **Count your shift** on the dashboard's **Upcoming events**
  card.
* **One tap is one person.** When you finish with someone, tap the big **+1** on the furthest stage they reached:
  Stops, To table, Presentations, Closes, Taps or Sales. The earlier stages count too, because everyone who got to a
  presentation was also stopped and came to the table. The line under the event says so: **Tap the furthest stage each
  person reached. Earlier stages count too.**
  * Someone you only stopped: **+1** on **Stops**. Just the stop goes up.
  * Someone who got to a presentation: **+1** on **Presentations**. Stops, To table and Presentations each go up by 1.
  * Someone who got as far as a tap: **+1** on **Taps**. Stops, To table, Presentations, Closes and Taps each go up by 1.
  * A sale: **+1** on **Sales** adds one to all six.

  Every row that went up flashes for a moment, so you can see what the tap counted. Taps can come in any order, so a
  **+1** is never greyed out (only at the daily maximum of 2,000 stops).
* **Tapped the wrong one?** The small **−** takes that person off again: the same stages go back down by 1. If
  everyone counted on that stage went further, there is nobody who stopped there to take off, so it names the tile
  that does bring it down, for example "Can't take one off Closes: all 2 people who got to closes went on to taps.
  Take one off Taps instead (Closes comes down with it)." One tap on that tile does it. If that person did get part
  of the way, **+1** them again on the furthest stage they really reached.
* **Your counts are safe** on the phone through reloads and lost signal. The **Tally** button shows today's stop
  count, and the dashboard says **Carry on counting**. An unfinished tally is dropped after 14 days.
* **Finish shift** opens Log gauges with your counts filled in: check them, add your check-in or notes, and save
  (without signal it is kept on the phone like any other save). The tally then clears.

**Recruiters** see the same amber strip when Linear Hub can't be reached, without the line about gauges.

### Quick gauges in the field

**For reps, leaders and administrators.** **Quick gauges** is the tally as six big buttons, made for a phone in your
hand or an iPad on the stand.

* **Opening it.** Tap **Quick gauges** at the top of the side menu. On a phone, or an iPad held upright, it is the
  tally-marks button next to the bell, one tap from any screen. From the **Tally** card on the Gauges page, **Full
  screen** opens the same event there. While you are counting, the side menu button shows today's stops so far.
* **Your event is picked for you** the same way as the Tally card: the one you are already counting today, otherwise
  the one under way, otherwise your only event. If there are several, tap **Change** to pick another (on a phone, tap
  the event's name: the arrow after it shows you can).
* **Counting: one tap is one person.** Tap anywhere on the tile of the furthest stage the person reached: Stops, To
  table, Presentations, Closes, Taps or Sales. The earlier stages go up with it, exactly as on the Tally card, and the
  small line under each stage's name says what a tap adds: **just a stop**, **+ stop**, **+ stop, table**, **+ 3
  earlier**, **+ 4 earlier**, **+ all 5 earlier**. For example, a presentation adds a stop, a table and a
  presentation; a tap adds one to Stops through Taps; a sale adds one to all six. Every tile that went up flashes for
  a moment. The help line under the event repeats the rule.
* **Taking one off.** The small **−** in the top corner of each tile takes that person off again, and never adds; the
  **+1** on the tile always sits well clear of it. If everyone counted on that stage went further, the bar at the
  bottom names the tile to take one off instead, which brings that stage down with it (for example **Taps** instead
  of **Closes** when both closes went on to a tap). Taps can come in any order, so the **+1** is only grey at the daily
  maximum (2,000 stops).
* **Same counts as the Tally card.** Start on the Gauges page and carry on here, or the other way round. The numbers
  stay on your phone through reloads and lost signal until you finish. With Linear Hub open in two tabs, both show
  the same counts.
* **Finish shift** at the bottom opens Log gauges with your counts filled in: check them, add your check-in or notes,
  and save (without signal it is kept on the phone, for leaders and administrators too). The tally then clears.
* **Reset** asks first: **Keep counting** appears where **Finish shift** was, and the red **Reset to 0** on the
  other side, so a quick second tap never clears your shift.
* **No signal?** Once Linear Hub has opened with signal, Quick gauges still opens after the signal drops.
* **Leaders and administrators** count their own shift here, just as on the Tally card. To log for someone else, use
  **Log gauges** as usual.

**Phone and iPad tips**

* **Hold it either way.** Upright, the tiles are two across and three down; sideways, or on an iPad, three across and
  two down. The six tiles fill the screen, with **Finish shift** always in reach at the bottom.
* **Add it to your Home Screen.** In Safari, open Linear Hub, tap **Share**, then **Add to Home Screen**. You get a
  Linear Hub icon that opens full screen, without the browser bars, like an app. On Android, in Chrome, use the **⋮**
  menu, then **Add to Home screen**. Use either the icon or the browser for the whole shift: on iPhone they keep
  separate counts, and the icon has its own sign-in.
* **The screen stays on** while Quick gauges is open, on phones and browsers that allow it. That needs the secure
  (https) address. Over a plain hotspot address it follows your phone's own auto-lock setting, so set auto-lock to a
  few minutes for the shift.
* **Taps you can feel.** On phones that support it, each tap gives a short buzz, and a tap that can't count gives a
  double buzz.

### Recruitment deadlines

**Every candidate now gets a real deadline.** A new candidate is due a **Phone screen** within 3 days. Each time you
move someone to a new stage, their next-action date is set from that stage's target:

| Stage | Target |
|---|---|
| Applied | 3 days |
| Phone screen | 5 days |
| Interview | 7 days |
| Observation day | 7 days |
| Offer | 7 days |

The **Move to…** list shows the date each stage would set ("Phone screen · due Sat 24 Oct"), and the confirmation
says it again: "Next action due Sat 24 Oct (5-day target)". You can still change the date under **Notes & next
action → Due** on the candidate's page. Hiring, rejecting or withdrawing someone clears their deadline.

**Idle badges.** When someone has been in the same stage for longer than its target, an amber **Idle 9d** badge
appears on their board card, under their stage in the list view, and on the **Pipeline** card of their page. Moving
them on resets the count. To see who needs moving most, choose **Longest idle first** in the order menu next to
**Any owner** (it works on the board and in the list): everyone past their target comes first, the furthest past at
the top, then everyone else, the nearest to their target first. The same menu has **Recently moved first** and, in the
list, **Newest applicants first**.

**Record the outcome.** Two hours after an interview's start time, if its outcome still says *Pending* (and for up to
eight weeks after it), the candidate's page shows a **Record the outcome** card at the top with the outcome menu right
there — pick **Passed**, **Failed** or **No show** and it saves straight away. The interview also carries an
**Outcome due** badge in the **Interviews** list.

**Recruiter dashboard.** Recruiters get an **Idle beyond target** tile — how many open candidates have been in a stage
longer than its target. Interviews that have happened but still say pending (the ones **you ran or whose candidate you
own**, from the last eight weeks) are asked for once, in the **Needs attention** card at the top of the dashboard and
in the bell: **Record outcome** opens the candidate's page with the outcome menu at the top. Once you save an outcome
the line disappears.

**Who sees what.** Recruitment pages are for recruiters, team leaders and the owner, as before; reps never see them.
The **Idle beyond target** tile is on the **recruiter** dashboard only. Everyone who runs interviews — recruiters, team
leaders and the owner — gets the same outcome reminders in **Needs attention** and the bell: interviews from the last
eight weeks that they ran or whose candidate they own (the owner sees them all), and the **Record the outcome** card on
each candidate's page. Deadlines, Idle badges and the **Record the outcome** card stay on even if the office switches
the smart features off.

### Your week in review

At the bottom of the **Dashboard**, under the team, events and announcements, the **Your week in review · w/c 12 Oct**
card sums up the last full week (Monday to Sunday) in five to eight short lines.

- **‹ / ›** step back and forward a week. **›** is greyed out on the latest finished week: a week has no review until
  it is over.
- Lines with a **lock** are private to you — your pay, the payroll figures, the size of your check-in list. They are
  never copied.
- **Copy as text** copies the other lines, with the title, as plain text, ready for the team WhatsApp group. You will
  see **Copied — paste it into WhatsApp**. It works on the office Wi-Fi and over a phone hotspot. If a phone refuses,
  the text appears selected under the card so you can copy it by hand.

What each role sees:

- **Reps** — your sales, stops and conversion against the week before; where you finished on your team's board and
  whether you moved; how you did against the bonus (for example **You finished one sale short of the £75 bonus**); one
  coaching tip for the stage that most needs it; and, with a lock, your pay for the week. Nobody else's name appears in
  your review.
- **Leaders** — your team's sales and conversion against the week before; the top seller and the biggest move up on
  your team's board (the biggest move down is shown with a lock, so it is never copied to the group); how many recorded
  check-ins were late (a number, never names); next week's events with an
  estimate of the sales they should bring against their targets; and, with a lock, how many people are on your
  **Check in with…** list — the card never names them, and nobody on that list is named in the lines you can copy.
- **Administrators** — company sales and revenue against the week before; the campaign with the biggest rise and the
  one with the biggest fall; hires and applications; and, with a lock, the payroll due on Friday and any failed
  transfers still to send again, however old (the same runs as **Runs to pay**).
- **Recruiters** — applications, interviews and hires against the week before; how many open candidates are past their
  next action (the **Overdue actions** tile); interview outcomes to record now; and the size of the open pipeline.

The numbers are the same ones as on your tiles, the leaderboard and the finance and recruitment pages for that week —
if the review and a tile ever disagree, the tile is looking at a different period.

### Backups and running in the background (administrators)

**Settings › Backups** (only the owner and other administrators see this card) shows:

- **Last backup** — how long ago, and the date and time. A green **Up to date** badge means there is one from the last
  36 hours.
- **Kept** — how many copies there are. Linear Hub keeps one a day for 30 days, then one a week for 8 weeks.
- **Latest file** and **Folder on the server laptop**, with a **Copy path** button.

If there has been no backup for more than 36 hours the card turns amber (**No backup for 3 days**). Backups only
happen while Linear Hub is running: leave it running overnight, or on the laptop run `npm run backup`. Either way,
copy the backups folder to iCloud or Drive now and then — a backup on the same laptop does not survive losing it.
The backups hold the database (and the app secret, unless you set `LM_APP_SECRET`) only: copy `server/data/media` (learning videos),
`server/data/statements` (client statement PDFs) and `server/data/uploads` (the signature image) with them;
`npm run backup` names those folders when it finishes.

If the server was started with automatic backups switched off (`LM_BACKUP=0`), the card says so with an amber **Off**
badge and does not promise nightly copies: run `npm run backup` on the laptop yourself, or start Linear Hub again
without `LM_BACKUP=0`.

The backups folder is a full copy of everyone's details, pay and the app secret (the key for two-step sign-in and PINs;
with it, someone could work out a 4-digit PIN in minutes): keep it private, in your own iCloud or Drive only, never
commit it to git or share it.

To go back to a backup (for example after a mistake that deleted the wrong entries): on the laptop, stop the server
(`npm run stop`, or `npm run service:uninstall` if it runs in the background) and run
`npm run restore -- <file name>`. It shows what will change and asks first; the database it replaces is kept, so you
can change your mind. The videos, statement PDFs and signature image folders are not in the backups and are left as
they are, and restore says so (videos uploaded after that backup stay on disk with no entry; delete them if you do not
need them).

To keep Linear Hub running without a Terminal window — so phones on the hotspot keep working and it starts by itself
when you log in — run `npm run service:install` once on the laptop. `npm run service:status` says whether it is
running; `npm run service:uninstall` stops it. The README has the details.

Everyone else sees no change, except that pages load faster over the hotspot: the server now sends compressed pages
and data (about a third of the bytes it sent before).

---

## Everyone

### Signing in

1. Open Linear Hub at the address the office gave you. (Running it yourself: <http://localhost:5173> during `npm run dev`, or <http://localhost:4000> after `npm run build && npm start`.)
2. Enter your **Work email** and your **Employee ID** — format `LM-0000`, e.g. `LM-0042`; it is on your welcome email and your payslip or invoice. Capital letters do not matter.
3. Choose **Sign in**. If you have a PIN, type it next.
4. Type the 6-digit code from your authenticator app and choose **Verify**. The first time, Linear Hub asks you to set two-step verification up instead (about two minutes; see [What's new in 1.4](#whats-new-in-14)).

You stay signed in on this device for 14 hours from signing in (your administrator may choose 4 to 24 hours), or until you sign out or leave it unused for 12 hours.

There is no password yet, so your employee ID is half of your credential — treat it like one; the code from your app is what stops someone who knows your email and employee ID from signing in as you. Linear Hub shows employee IDs only to administrators and to you: nobody else can read yours on the Team page, a payslip or your profile. After **eight failed attempts in fifteen minutes** the sign-in for that email is paused and the message says how many minutes to wait. If the office sets your status to **Left**, you are signed out on every device immediately.

On a demo database the sign-in page also shows **Try a demo account** — one button per role, then **Sapiens team (7)**: open it for the seven blank Sapiens accounts (see [What's new in 1.3.1](#whats-new-in-131)). These demo accounts need no code while Linear Hub is still the demo. The office switches this off on the live database, so if you do not see it, that is why.

**Signing out:** open your avatar at the top right and choose **Sign out**.
**Light or dark:** use the sun/moon toggle in the top bar, the **Light** / **Dark** / **Match system** entries in the same avatar menu, or **Settings → Appearance** (**Light**, **Dark**, **System**). The choice is remembered on this device.
**Finding a page:** the **Go to page…** box in the top bar (⌘K or Ctrl+K) lists every page your role can open. The sidebar groups them into **Workspace**, **Manage** and **Account**.

### What your role can see and do

| Role | You can see | You can change |
|---|---|---|
| **Representative** | Your own gauges and pay; your team's events, leaderboard and gauges summary; the directory; any event or colleague's profile read-only (other people's check-in times and notes are hidden) | Your own gauges, at your team's events |
| **Leader** | Everything company-wide — every team's events, the full leaderboard, any profile — plus your own team's check-in times and notes, your team's pay runs, and recruitment | Events for your team; gauges for your team's members at your team's events; candidates, interviews and stage changes; announcements; adding trainees and field representatives to your team |
| **Recruiter** | The whole recruitment pipeline, the directory, your own pay; events and the leaderboard read-only (no Gauges page) | Candidates, interviews, stage changes — hiring creates the rep's account; adding trainees and field representatives to any team |
| **Administrator** | Everything, including every employee ID | Everything — people, campaigns, events, any gauges, payroll payments, expenses, announcements |

A page your role cannot open shows "This area isn't available on your account" with a **Back to dashboard** link.

### Reading your dashboard

The dashboard greets you by name and shows your position, team and the dates in view. Change the period with **This week**, **This month** or **This quarter**. Reps, leaders and administrators also have **Log gauges** here.

| Tile or card | What it shows |
|---|---|
| **Sales** | Confirmed sales for the period. Underneath: **Ranked #N of M in your team** (reps — the same people as your leaderboard) or **company-wide** (leaders and administrators). |
| **Conversion** | sales ÷ stops, tinted against the benchmark. **—** with no colour while you have no stops in the period (nothing to convert yet). |
| **Stops** | With your presentations underneath. |
| **Earnings to date** | Gross pay for the period: the pay runs that start in it, plus a live estimate for any week that has no run yet. |
| **Next payday** | The date and amount of the earliest **unpaid** run. If its due date has passed the tile turns red and says **overdue**; when nothing is owed it shows this week's payday and the live estimate. |
| **Punctuality** | The share of your check-ins that were on time. Green from 90%, amber from 75%, red below. |
| **Your trend** / **Your funnel** | Sales and stops per day; your funnel against the law of averages with one to three coaching notes underneath. |
| Team card (named after your team) | Stops, sales, conversion and your team's top five. People without a team see **Top performers** across the company instead. |
| **Upcoming events** | The next five for your team (administrators: the whole company). |
| **Announcements** | The latest five, pinned first; **Older announcements** underneath lists up to 20 earlier ones. Leaders and administrators see **New announcement** here (**New**, or just the megaphone icon, on a narrow card). |

**The "vs" arrows.** Each change compares with the **same days of the previous period**, and the small label under the tile names them — on Thursday 15 October the week view says "vs 5 Oct – 8 Oct". This week (Monday to today) is compared with last week Monday to the same weekday; this month (1st to today) with the same days of last month; this quarter with the same stretch of the previous quarter. The leaderboard's movement arrows use the same comparison. An arrow is blank when there was nothing in the previous period.

Leaders and administrators also get a **Company** section — sales, revenue, active reps, payroll on time, open candidates, hires, the company trend and sales by campaign. For administrators it comes first and their own gauges follow under **Your activity**; for leaders it sits under their own numbers. Recruiters get a recruitment-first dashboard, described under [Recruiters](#recruiters).

### The six gauges

Every rep records the same six numbers for every event day. They are a funnel: each stage is a subset of the one before, so **no stage can be larger than the previous one**. All six are whole numbers, zero or more.

| # | Gauge | What counts | Rule |
|---|---|---|---|
| 1 | **Stops** | Every person you stopped and spoke to. | — |
| 2 | **To table** | Stops who came over to the table or stand to hear more. | ≤ Stops |
| 3 | **Presentations** | Full pitches delivered, start to finish. | ≤ To table |
| 4 | **Closes** | Presentations where you asked for the sale. | ≤ Presentations |
| 5 | **Taps** | Closes where the customer tapped, signed or confirmed their details. | ≤ Closes |
| 6 | **Sales** | Confirmed sales that count towards your commission and the campaign. | ≤ Taps |

A valid day might read `120 · 42 · 21 · 9 · 5 · 5`. A day reading `120 · 42 · 21 · 5 · 6 · 5` is rejected, because 6 taps cannot come from 5 closes.

### Logging gauges

Open the form with **Log gauges** on the Dashboard or the Gauges page, or open the event under **Events** and choose **Log gauges** there (**Update my gauges** if you have already logged that event).

1. **Event.** From the Dashboard or Gauges the list shows your team's events from the last three weeks up to today; cancelled events are not offered. From an event page the event is fixed. A future event cannot take gauges — the form says "This event is on … — gauges can be logged from that day." — and neither can a cancelled one.
2. **Rep.** Reps: this is you. Leaders choose a member of the event's team; administrators anyone.
3. **Date.** Fixed to the event's date and shown read-only: gauges are recorded against the day the event ran. If you already have an entry for that event the hint says so, and saving will update it.
4. **Gauges.** Use the six steppers (**Stops**, **To table**, **Presentations**, **Closes**, **Taps**, **Sales**) in order. A stage that breaks the funnel rule is highlighted and named in the warning; the **Live ratios vs law of averages** panel updates as you type. **What counts as what?** expands the definitions.
5. **Checked in at.** Tap **Now** when you arrive — this is what your punctuality is measured from; the hint shows the event's start time and the 5-minute grace. Add **Notes** if the day needs explaining.
6. **Save gauges** — or **Update gauges** when the form is editing an existing entry. You will see "Gauges logged" or "Gauges updated".

There is one entry per person, per event, per day. Saving again for the same event **updates** it rather than adding a second one, and the time you submitted is kept. To change a day later, open the event and choose **Edit** on your row in **Gauges by rep**; only leaders (own team) and administrators can **Delete** an entry.

### Your ratios against the benchmarks

Linear Hub turns your gauges into five stage-to-stage ratios and compares each with the company's **law of averages** benchmarks:

| Ratio | Benchmark | Meaning |
|---|---|---|
| Stop → table | **35%** | 35 of every 100 people you stop come to the table |
| Table → presentation | **50%** | half of those hear the full pitch |
| Presentation → close | **40%** | you ask for the sale in 4 of every 10 pitches |
| Close → tap | **60%** | 6 of every 10 asks get a tap |
| Tap → sale | **90%** | 9 of every 10 taps become confirmed sales |

Hit every benchmark and about **3.8% of stops become sales — roughly 1 sale for every 26 stops**.

**How to read your ratios**

- Ratio cells are tinted: **green** within 10% of the benchmark or above (for a 50% benchmark, 45% and up), **amber** 10–25% below, **red** more than 25% below. Colour is a hint — the number is always shown alongside.
- Look for the **lowest ratio relative to its benchmark**. That is the stage to coach or practise. The coaching notes under your funnel say it in a sentence: a low stop → table means the opening needs work; a low presentation → close means you are pitching well but not asking.
- With **fewer than 20 stops** in the period the ratios are too noisy to read much into. The notes say "Early days" until then.
- A stage nobody has reached yet (4 closes but no taps) is not graded — it is undefined, not poor.
- The volume target is **2 sales per worked day**. Ratios tell you *how well*; sales per day tells you *how much*.

### The Gauges page

Open **Gauges**. The tabs depend on your role: **My performance** (everyone), **Team** (leaders: your team; administrators: any team via the **Team** picker) and **Company** (administrators). The range picker offers **This week**, **Last week**, **This month**, **Last month**, **This quarter** and **Custom** (type a from and to date).

**My performance** shows six tiles — **Sales** (with per day), **Stops** (with days worked), **Presentations**, **Conversion**, **Stops per sale**, **Punctuality** — then **Funnel vs benchmarks** with coaching notes, your **Trend**, **By campaign** and **Recent entries**. The same panel appears on your profile under **Team**.

**Team** and **Company** show a summary table grouped **By person**, **By team**, **By campaign**, **By day** or **By week**, with the six gauges, sales per day and every ratio tinted against the benchmarks. By day and By week add a **Trend** chart. Clicking a person opens their profile. The **Rep-days** column counts distinct person × day pairs, so for a campaign or a week it is "days of work", not calendar days.

### Checking your pay

Open **Finance**. Everyone lands on **My pay**:

- Four tiles: **Earned · last 12 weeks**, **Commission**, **Paid on time** (share of your paid runs that landed by the due date) and **Next payday**.
- **Earnings** — gross pay per week, split into **Base**, **Commission**, **Bonus** and **Overrides** (only the components you actually earn are plotted).
- **Payslips** — one row per pay week: **Week**, **Days**, **Sales**, **Commission**, **Gross**, **Due**, **Status**. Click a row for the payslip (**Payslip · PAY-2026W41-LM-0010** and so on): **Base pay** (days × your daily rate), **Commission** (sales × your rate), **Bonus** (paid when the week's sales reach your plan's threshold), **Overrides** (leaders: team sales × the override), **Deductions**, **Gross pay**; your **Pay plan** alongside; and **The week's gauges** that fed into it.

**Pay weeks run Monday to Sunday** and are **due on the Friday after the week ends** — a week ending Sunday 18 October is due Friday 23 October. When a week closes, its runs appear by themselves on the Monday as **Pending**.

**Status** badges: **Pending** (not yet paid), **Paid** (on or before the due date), **Paid late**, **Failed** (the transfer bounced or the payment did not go through; the office will pay it again). A pending run past its due date also carries a red **Overdue** badge, and the **Next payday** tile on your dashboard turns red and keeps pointing at it until it is paid — money owed never drops off.

Leaders have a **Team pay** tab and administrators a **Company** tab; see their sections.

### Punctuality

Your check-in time at each event is compared with the event's start time. Checking in up to **5 minutes** after the start still counts as on time. Your punctuality rate is the share of recorded check-ins that were on time; days with no check-in recorded do not count either way, so record it. Other people's check-in times are visible only to administrators and to their own team's leader; everyone else sees **—** in the **Check-in** column.

### The leaderboard

Open **Leaderboard**. Choose the period (**This week**, **This month**, **This quarter**) and the metric (**Sales** or **Conversion**). Leaders, recruiters and administrators can pick a **Team**; reps always see their own team, shown as a badge. Everyone who logged sales in the period is ranked — ties share a rank — with the top three on a podium and the full table beneath: **#**, **Rep**, **Team**, **Sales**, **Stops**, **Conv.**, **Days**, **Move**.

When you are ranked, the header says **You're #N of M this week** (month, quarter). For a rep, M is the number of people in your team; for leaders and administrators it is the whole company — the same number your dashboard's Sales tile quotes. The **Move** column compares your rank with the same days of the previous period: an arrow up or down with the number of places, a dash for no change, **New** when you were not ranked last time.

### Events

Open **Events**. The default range is **Upcoming** — a week back to three weeks ahead; the other presets are **This week**, **Last week**, **This month**, **Last month** and **Custom**. Filter by **Team** (reps always see their own team), **Campaign** and **Status** (**Scheduled**, **Live**, **Completed**, **Cancelled**).

Days are listed with **today first** (highlighted), then the days to come, then last week's completed days under an **Earlier** divider, newest first — so nobody scrolls past history to find today. Lists with more than 60 events show two weeks of days and a **Show N more days** button. Each row shows the event, campaign code, venue, times, team, type, sales against target, how many reps have logged, and the status. Statuses follow the clock: today's events turn **Live** at their start time and past events become **Completed**, checked every fifteen minutes.

Open an event for the day's totals, the **Event funnel** against the benchmarks, the notes, and **Gauges by rep** — each person's six gauges, conversion and check-in punctuality. Under the title, the people count reads **7 booked** before the day, **3 logged · 7 booked** on the day, and the number of reps who logged otherwise (or when nobody was booked).

### The team directory

Open **Team**. Team chips at the top (member count and leader) filter by team; the search box **Search name, email or ID…** also finds employee IDs for administrators. Filter by **Team**, **Position** and **Status** (**Active**, **On leave**, **Left**, **Everyone**) and switch between **Card view** and **Table view**. Open a person for their contact details, pay plan name, and their full performance panel for any range (default **This month**). Employee IDs appear on your own card and, for administrators, on everyone's.

### Settings

**Settings** shows your profile as the office holds it (**Employee ID**, **Email**, **Phone**, **Position**, **Role**, **Team**, **Pay plan**, **Start date**, **City** — ask an administrator to change anything), **Appearance**, **Security** (**Two-step verification**, required for everyone since 1.4: your recovery codes left and **New recovery codes**; and your **Sign-in PIN**), **Bank details** (where your pay goes, since 1.4; see [Your bank details](#your-bank-details)) and **About this app** (version and when the sample data was seeded). Administrators also see **Backups** (see [What's new in 1.1](#backups-and-running-in-the-background-administrators)) and **Payments** (see [Paying people from Linear Hub](#paying-people-from-linear-hub-administrators)).

---

## Leaders

Everything above applies to you too. In addition:

### Scheduling an event

1. Open **Events** and choose **New event**.
2. Fill in **Event name** (what the team will recognise, e.g. "Trafford Centre weekend"), **Campaign** (active campaigns only), **Team** (locked to yours — "Leaders schedule events for their own team."), **Venue**, **City**, **Type** (Private site, Event, B2B, Residential or Retail), **Date**, **Start** and **End** (24-hour; the end must be after the start), **Sales target** and **Notes** (parking, dress code, who to ask for).
3. **Create event.** It appears on every team member's dashboard and in Events.

The status is set for you: **Completed** for a past date, **Live** for today once the start time has passed, otherwise **Scheduled**. To change anything later, open the event and choose **Edit** — the same form plus a **Status** field (set it to **Cancelled** rather than deleting) — then **Save changes**. Only administrators can **Delete** an event.

### Logging for team members

Choose **Log gauges** (Dashboard, Gauges or the event page), pick the event, then pick the **Rep** from your team. The form is the same as a rep's, with the same funnel, event-date and today-or-earlier rules. You can only log at **your own team's events**: an attempt elsewhere is refused. On the event page every row of **Gauges by rep** has **Edit** (opens **Update gauges**) and **Delete** (asks "Delete this gauge entry?").

### The team view

- **Dashboard** — your team's card with its top five, and the **Company** section under your own numbers.
- **Gauges → Team** — your team only, grouped **By person** (compare ratios side by side), **By campaign**, **By day** or **By week**.
- **Team** — open any member for their full performance; for your own team you also see their check-in times and notes on each entry.
- **Leaderboard** and **Events** — the whole company, with a **Team** picker.
- **Finance → Team pay** — your team's runs for **This week**, **Last week**, **Last 4 weeks**, **Last 12 weeks**, **This month** or a custom range, with **Team payroll**, **Commission**, **Awaiting payment** and **People paid** on top. Click a run for its payslip. Marking runs paid is an administrator's job.
- **Recruitment** — full access: add candidates, schedule interviews and move stages, as described under [Recruiters](#recruiters).

### Announcements

On the Dashboard choose **New announcement**, add a **Title** and the **Message**, switch on **Pinned** if it should stay at the top, and **Post announcement**. Everyone sees it on their dashboard, pinned ones first.

### Adding a person (leaders)

Team Leaders and Crew Leaders can add a new trainee or field representative to their own team.

1. Open **Team** and choose **Add person**.
2. Fill in **First name**, **Last name**, **Email** (they sign in with it), **Phone** (optional), **Position**
   (**Trainee** or **Field Representative**) and **Start date**. **Team** shows your own team; you cannot change it.
3. Choose **Add person**.
4. **Sign-in details** opens: their name, team, email and **Employee ID**. Choose **Copy instructions** and paste them into
   a message to the new person — they say which address to open (the one your phone or laptop is using), and to enter the
   email and the employee ID. On the computer that runs Linear Hub (an address starting `localhost`), they say "Open the
   Linear Hub sign-in page" instead, because that address would not open on their phone: add the address they use. Since 1.4 they also say to set up two-step verification with an authenticator app at the first sign-in. The button changes to **Copied** once they are on your clipboard. This is the only time
   you see their employee ID: afterwards only administrators (on the **Team** page) and the person themselves can. A tap
   beside the box does not close it; choose **Done** when you have sent them.

They start as **Active**, on the standard pay plan for their position. Only an administrator can give someone another
role or position, a pay plan, a status, an avatar colour or a chosen employee ID, put them on another team, or change
anything later (**Edit profile**). If something is refused, the message says why in a sentence.

---

## Recruiters

### Your dashboard

Your dashboard opens with the **Needs attention** card (overdue follow-ups, interview outcomes to record, today's interviews), then leads with **Recruitment**: **Open candidates** (with how many are at interview or observation), **Interviews this week**, **Overdue actions**, **Idle beyond target**, **Hires** for the chosen period and **Avg time to hire**; then **Upcoming interviews** (the next two weeks), **Overdue follow-ups** and **Weekly activity** for the last twelve weeks. Below that: **Top performers** across the company, **Upcoming events** and **Announcements**. You do not log gauges, so the Gauges page is not on your menu; Events, Leaderboard and Team are read-only.

### The pipeline

Candidates move through six stages in order, and can leave at any point:

**Applied → Phone screen → Interview → Observation day → Offer → Hired**

**Rejected** and **Withdrawn** are the two other end states. Hired, Rejected and Withdrawn are final; everything else is the **open pipeline**.

Open **Recruitment**. The range picker (**Last 4 weeks**, **Last 12 weeks**, **This quarter**, **This month**, **Last month**, **Custom**) drives the summary: **Applied**, **In interview**, **Hired** (with the share of applicants hired), **Avg time to hire**, **Overdue actions**, plus **Weekly activity** and **Conversion by source**. Below, filter candidates with **Search name or email…**, **Source** and **Owner**, and switch between **Board view** — the open pipeline by stage, with the **Hired** column showing hires made in the range — and **List view**, where **Include closed** also shows rejected, withdrawn and hired candidates.

### Adding a candidate

1. Choose **Add candidate**. New candidates start at Applied.
2. **First name**, **Last name** and **Email** are required. Add **Phone** and **City**.
3. Choose the **Position applied for** (Trainee or Field Representative — nobody is hired straight into a leadership or office role), the **Source** (Indeed, LinkedIn, Referral, Website, Walk-in, Agency, University or Other) and, for a referral, **Referred by**.
4. Set the **Owner** — "who follows up"; it defaults to you — and any **Notes**.
5. **Add candidate.** The candidate's page opens.

### The candidate page

- **Pipeline** — a stepper showing the stage and since when.
- **Profile** — email, phone, city, **Source**, **Rating** (click the stars, 1–5), **Owner**, **Position**, and after hiring **Hired as → View profile**.
- **Notes & next action** — **Notes**, **Next action**, **Due** and **Owner**; **Save**. Every new candidate and every stage move gets a **Due** date from the stage's target (see [Recruitment deadlines](#recruitment-deadlines)); change it here if you need to. When it passes, the candidate is flagged **Overdue** on the board, in the list and on your dashboard, so nothing goes quiet.
- **Interviews** and **Timeline** — every stage change, newest first, with who made it and the note.

### Moving candidates

Use the **Move to…** dropdown — in the header of the candidate page, or on a card on the board — and pick the new stage. Moving to Hired or Rejected asks you to confirm and lets you add a **Note** (what was decided and why). Hired, Rejected and Withdrawn are final: once there, the dropdown becomes a badge.

### Interviews

Choose **Schedule interview** (or **Schedule** in the Interviews card): the **Type** (Phone screen, First interview, Observation day or Final interview — suggested from the stage), the **Date and time**, the **Interviewer** (leaders, recruiters or the office) and **Notes**, then **Schedule**. Afterwards set the outcome with the dropdown on the interview: **Pending**, **Passed**, **Failed** or **No show**.

### Hiring

Move the candidate to **Hired**. The **Hire …?** dialog asks for the **Team** (it defaults to the owner's team) and the **Position** (Trainee or Field Representative, from the application), with an optional **Note**; **Confirm hire**. Linear Hub creates the employee record straight away: role Representative, the team and position you chose, the standard pay plan for that position, start date today, a work email in the `first.last@linear-mcr.co.uk` pattern and the next free employee ID. You will see "Rep account created · Field Representative · Deansgate" or similar, and the candidate's profile gains **Hired as → View profile**. An administrator reads the new employee ID off the profile and gives it to the new starter so they can sign in on day one.

### Adding a person (recruiters)

Recruiters can add a trainee or field representative straight to any team (for someone who did not come through the
pipeline; a hire from the pipeline creates the account by itself).

1. Open **Team** and choose **Add person**.
2. Fill in **First name**, **Last name**, **Email**, **Phone** (optional), **Position** (**Trainee** or **Field
   Representative**), **Team** (choose one) and **Start date**, then **Add person**.
3. In **Sign-in details**, choose **Copy instructions** and send them to the new person (they include setting up
   two-step verification at the first sign-in). Their employee ID is shown only this once (if it gets lost, an
   administrator can find it on the **Team** page); then **Done**.

As for leaders, the role, pay plan, status, avatar colour and employee ID are the office's to set.

### Your pay

**Finance → My pay** works for you as for everyone. Recruiters are on the **Office recruiter plan**: a daily rate Monday to Friday, no sales commission, and a **bonus in any week with two or more hires**. On your payslips the **Sales** column counts the **hires you closed** that week — candidates you own who were moved to Hired.

---

## Administrators

You can do everything above for anyone, plus:

### Campaigns

Open **Campaigns** (tabs **Active**, **Inactive**, **All**). Choose **New campaign**: **Name**, **Code** (2–6 letters or digits, e.g. `BCN`), **Sector** (Charity, Energy, Telecoms, Broadband, Other), **Type** (Fundraising, B2C, B2B), **Client payout per sale (£)**, **Rep commission per sale (£)** (cannot exceed the payout; a pay plan may override it), **Start date**, **Colour** for charts and chips, **Description**, and the **Active** switch; then **Create campaign**. Use the pencil on a card to edit and **Save changes**. Switch **Active** off to pause a campaign — its history is kept and it is no longer offered when scheduling an event.

### People

On **Team**, choose **Add person**: **First name**, **Last name**, **Work email**, **Employee ID** (format `LM-0000`; used with the email to sign in — leave it blank for the next free ID), **Role** (Administrator, Leader, Recruiter or Representative), **Position** (Trainee, Field Representative, Team Leader, Crew Leader, Assistant Owner, Owner or Recruiter), **Team**, **Pay plan**, **Start date**, **Status** (Active, On leave, Left), **Phone**, **City** and **Avatar colour**; then **Add person**. To change anything, open the person and choose **Edit profile**, then **Save changes**. Someone added without a surname (the Sapiens demo accounts) can be saved with **Last name** still empty until you add one; once given, a surname cannot be cleared. Recruiters and leaders can add trainees and field representatives too (see [Leaders](#adding-a-person-leaders)); each addition is in the audit trail under the person who made it.

Each person's page (Team → the person) also shows their **Bank details**, masked: **Ready for payments**, waiting for your check (**Confirm details**, once you have checked the new details with them in person or by phone), or none yet (**Add bank details** lets you type them in for them). In **Edit profile**, **Reset two-step verification** is for a lost or new phone: they set it up again at their next sign-in.

When someone leaves, set their **Status** to **Left**: they are signed out everywhere at that moment and can no longer sign in; their gauges, pay runs and history stay so the numbers still add up. You cannot set your own status to Left. Only administrators see other people's employee IDs — on the Team page, profiles and payslips — and the Team search finds people by ID for administrators only.

### Gauges and events for anyone

You can **Log gauges** at any team's event for any active member of that team (and for yourself), **Edit** or **Delete** any entry, and **Edit** or **Delete** any event. Deleting an event removes its gauge entries for everyone — set its **Status** to **Cancelled** instead unless it was created in error.

### Payroll

1. Open **Finance → Company**. The range (**Last 4 weeks**, **Last 12 weeks**, **This quarter**, **This month**, **Last month** or **Custom**) is snapped to whole Monday–Sunday pay weeks, so revenue, payroll and expenses always cover the same days.
2. **Runs to pay** lists every **Pending** run of the last 12 weeks and every **Failed** run, however old, across the company, newest week first (grouped by week in collapsible sections when there are more than twenty). Click a run to check its payslip against the pay plan.
3. Once the money has gone, choose **Mark paid**. The run is recorded as paid **today** and becomes **Paid** if today is on or before the due date, otherwise **Paid late**; you will see "Marked paid" or "Marked paid (late)". A run that is already paid cannot be paid twice. When the list is empty it says "Everyone is paid up".

Make this a Friday routine: pay weeks close on Sunday, their pending runs appear on Monday, and they are due the following Friday. A **Failed** run (a transfer that bounced) stays in Runs to pay until you mark it paid again.

4. Or pay them from Linear Hub (1.4): tick the runs and choose **Pay N from Linear Hub**, then follow
   [Paying people from Linear Hub](#paying-people-from-linear-hub-administrators). A run in a payment shows **In a
   draft payment**, **Payment on its way** or **Payment failed** (with the reason); while a payment is on its way,
   **Mark paid** on that week waits for it, so nobody is paid twice.

### Expenses

Further down **Finance → Company**, choose **Add expense**: **Date**, **Amount (£)**, **Category** (Venue fees, Travel, Office, Software, Recruitment, Marketing or Other), optionally the **Campaign** it belongs to, and a **Description**; then **Add expense**. The bin icon deletes an expense entered in error (you are asked to confirm). The table shows 25 at a time with a **Show N more** button.

### Company finance

The top of **Finance → Company** shows, for the chosen range:

- Tiles: **Revenue** (sales × campaign payout), **Payroll**, **Expenses**, **Profit** and **Sales**. The week in progress has no runs yet, so its payroll is a live estimate and the tiles say "incl. this week's estimate".
- **Weekly money flow** — revenue against payroll and expenses per pay week.
- **Payroll punctuality** — paid on time, paid late, pending and failed, the **On-time rate** and the average days late.
- **By campaign** — sales, revenue, the commission reps actually earned on that campaign and the margin.

### Announcements

As a leader does: **New announcement** on the Dashboard, with the **Pinned** switch to keep it at the top for everyone.

### Resetting the sample data

From the repository root, `npm run seed` rebuilds the database with the deterministic 26-week sample data, anchored to today. Do not run it against a live company database — and on a live database set `LM_DEMO_ACCOUNTS=0` so the sign-in page offers no demo accounts.

---

## If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| "We couldn’t match that email and employee ID." | One of them is wrong, or your status is Left. | Check both against your payslip, then ask the office. |
| "Too many attempts, try again in N minutes" | Eight failed sign-ins for this email in fifteen minutes. | Wait the stated minutes; a successful sign-in resets the count. |
| "Your session has ended" | Your sign-in expired or was revoked. | Sign in again; you return to where you were. |
| "For security you are signed out 14 hours after signing in. Sign in again to carry on." | It is 14 hours (or the time your administrator chose) since you signed in. | Sign in again with your code. Anything waiting on your phone sends after you sign in. |
| **Set up two-step verification** instead of the app | Two-step verification is required for everyone since 1.4, and you have not set it up yet. | Tap **Set up now** and follow the steps (about two minutes). **Sign out** if it is not your phone. |
| "That code is not valid" when signing in | The code was mistyped, already used, or your phone's clock is wrong. | Wait for the next code and type it. Check your phone sets its time automatically. Or **Use a recovery code instead**. |
| You lost your phone, or got a new one | Your authenticator app was on it. | Sign in with a recovery code, then **New recovery codes**. No codes left: ask an administrator to reset your two-step verification. The only administrator: `npm run 2fa:reset -- <your email>` on the computer Linear Hub runs on (in the `linear-micro-crm` folder). |
| "That code is not right. Codes change every 30 seconds and each one works once…" when approving a payment or saving bank details | The code was old, mistyped or already used for something else. | Wait for the next code in your app and try again. |
| **Payment failed** on a run in Runs to pay | The provider or your bank did not pay it; the reason is in the badge's tooltip and on the payment's page. | Fix what the reason says (bank details, a top-up), then pay that week again in a new payment, or **Mark paid** once you have paid it another way. |
| "Test it in Settings → Payments first" on Pay people | The connection's last test did not work, or it has not been tested since its details changed or it was switched to live. | Open Settings → **Payments** and choose **Test**; the card says what went wrong. |
| A payment says a provider "did not answer" (or "could not reach") | The provider was slow or offline, or this computer's internet was down, when Linear Hub sent it. | Press **Check now** later, or wait for the 5-minute check: Linear Hub resends with the same references, which the provider recognises as the same payment for a while (TrueLayer 6 hours, Revolut 2 weeks, Wise not documented). A TrueLayer payout not answered within 5 hours of the approval fails with "Linear Hub does not know whether TrueLayer made this payout: …": check the TrueLayer Console before paying that week again. After a long Wise outage, check Wise → Transfers for a transfer made twice. |
| "This area isn't available on your account" | Your role cannot open that page (recruiters and the Gauges page, for example). | Use **Back to dashboard**; speak to your crew leader or the office if you think you should have access. |
| **Not saved.** "Invalid funnel" | One stage is larger than the one before it. | Fix the stage named in the message. |
| **Not saved.** "Gauges are recorded against the event's date" or "Gauges cannot be recorded before the event takes place" | The entry was for a date other than the event's, or the event is in the future. | Pick the right event; log it on or after the day it runs. |
| **Not saved.** "Reps can only record their own gauges" (or a similar refusal) | Your role does not allow that write — a rep logging for someone else, a leader at another team's event. | Ask your leader or the office. |
| "This event was cancelled, so gauges cannot be logged for it." | The event's status is Cancelled. | Ask a leader or administrator to reinstate it if it did run. |
| A pay run shows **Overdue** | It is pending and its Friday due date has passed. | Nothing for you to do; the office sees the same badge in Runs to pay. |
| A pay run shows **Paid late** | It was marked paid after the due date. | Nothing for you to do; the office tracks the on-time rate. |
| Your punctuality shows **—** | No check-ins have been recorded yet. | Tap **Now** in **Checked in at** when you arrive at each event. |
| **Check-in** shows **—** for other people | Their check-in times are only shown to administrators and their own team's leader. | Expected. |
| "Demo accounts aren’t available right now" | The database has real users, or demo accounts are switched off. | Sign in with your own details. |
| An amber strip: **Can't reach Linear Hub — check the hotspot** | Your phone has no signal, or the laptop running Linear Hub is asleep or stopped. | Keep logging: saves wait on this phone (**Save on this phone**) and send by themselves when the connection is back. |
| **1 entry needs a look** | Linear Hub already had an entry for that day that this phone had not seen — someone else's correction, or your own earlier entry when the phone could not check for it before saving — or the entry you were changing was deleted while yours waited. | Tap **Review** to see both versions, then **Send mine anyway**, **Open** or **Discard**. |
| A strip or card you expected is missing (pace note, pay estimate, **Needs attention**) | There is not enough history yet, or the office has switched the smart features off. | Nothing to do; the rest of the page works as before. |

*Linear Hub v1.4.0 — © Linear MCR Limited, internal use.*
