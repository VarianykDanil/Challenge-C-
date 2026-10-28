# Roadmap

Version 1.5.0 makes Linear Hub ready to run for real, away from the office Mac. It brings a tested installer for a small
UK/EU server with HTTPS ([`DEPLOY.md`](DEPLOY.md)), a trial mode that ends with `npm run golive`, one-time setup codes
for new accounts, the administrator's own code for sensitive actions, a printed recovery sheet for the app key,
encrypted backups copied off the server every night, system health warnings in the bell, an app that installs on the
phone's home screen and opens without signal, tables that read as cards on a phone, and stronger money controls (days a
leader confirms before they are paid, bank-detail changes that someone else must confirm, two administrators approving each payment,
bank files in test mode first, VAT on self-billed invoices). Before that, 1.4.0 asked everyone for a two-step code,
signed everyone out 14 hours after signing in and let the office pay people from Linear Hub; 1.3 made pay checkable
(base or commission, cancellations from the clients' statements, self-billing invoices) and added client accounts,
learning videos, PDFs, recruitment schedules and venue plans; 1.2 added the Learning page, one-tap check-in, the PIN,
the audit trail and search; 1.1 added the smart features and nightly backups; 1.0 brought gauges, pay, recruitment and
finance behind one sign-in. What each release changed is in [`CHANGELOG.md`](../CHANGELOG.md).

This is what comes next, in the order we would do it. Items move on evidence from the pilot (see
[`PITCH.md`](PITCH.md)), not on opinion.

**How something makes the list.** It must remove a question somebody at Linear asks every week, or remove a piece of
paper, or protect the data or the money. If it does none of those, it waits.

---

## Now — going live

| Item | Why | Notes |
|---|---|---|
| **Go live on a small UK/EU server with HTTPS** | The office Mac on its Wi-Fi or hotspot reaches only phones on that network, stops when the Mac sleeps or leaves the office, and keeps its backups on the same disk. Reps at venues across Greater Manchester and Liverpool need it on 4G. | First the agreement: a fixed-price go-live package and a signed variation (clauses 9.3 and 26.2; [`DEPLOY.md`](DEPLOY.md) §1). Then route A: buy the server and the domain in Linear MCR's name, run `deploy/install.sh` (Caddy for HTTPS, firewall, nightly encrypted off-site copies, automatic security updates), move the trial database across, `npm run golive`, print the recovery sheet, test a restore. About half a day with Noryn. **SQLite stays**: nothing in the data layer changes. |
| **Linear Hub's own private repository, with release tags** | The code sits on a branch of a public repository that was set up for something else. A release should be one tagged, private place that the server installs from. | Move it to a private Noryn repository, tag `v1.5.0`, and point the installer at it; the server then moves between releases with `sudo linear-hub update v1.5.1`. |
| **Everyone on two-step verification, with setup codes** | Everyone must set up an authenticator at their first sign-in, with the one-time setup code the office gives them. | Tell the team and the charity contacts first; hand out setup codes in person or by text, never in a group chat; reset two-step for anyone on a new phone. |
| **First real payments: sandbox, then one person** | Every API connection was built from the providers' documentation and tested against local stand-ins; a bank file was never uploaded to a real bank. | Settings → Payments walks through it: a sandbox payment with the owner's own provider account, then one small live payment, then one team. For a bank file, the 1p test file first. Steps in [`OWNER_NOTES_1.4.md`](OWNER_NOTES_1.4.md). |
| **Decide the two open payment questions** | Whether changing a connection's account should wait while a payment is on its way, and whether Linear Hub should add the adjustment line itself when a week's pay changes while its payment is on its way. | Both small changes once decided; see "Two decisions for you" in [`OWNER_NOTES_1.4.md`](OWNER_NOTES_1.4.md). |
| **Check the statement reader against real statements** | The reader recognises the clients' PDF statements by their table; it was built on sample statements. | The owner forwards one real (redacted) statement from each client; the columns are saved per client in Finance → Statements. |
| **Pilot the invoices with one team** | Self-billing only works if people accept on time and disputes are handled the same week. | Measure accepted before the deadline, disputes per week and days to resolve. |
| **Pilot the Learning page with one team** | Lessons, teach-backs and pitches only help if leaders sign them off. | Measure teach-backs sent and signed per week; the office writes the CHN and Volt Energy pitches in the pitch studio (only BCN ships). |
| **Announcement edit, unpin and expiry** | Announcements still cannot be changed after posting. | Uses the audit trail for the history. |
| **Marking a transfer as failed from the app** | A week marked paid by hand, or a payment the receiving bank returns after it was paid, cannot yet be flagged as failed. | One action on the run, with a reason; keeps the on-time maths unchanged. Recorded in the audit trail. |

## Next — the following quarter

| Item | Why | Notes |
|---|---|---|
| **Browser tests in the automated checks** | The screens are checked by scripted browser runs while each release is built, but those runs are not repeated on every change. | A Playwright suite at phone and laptop sizes: sign-in for each role, logging gauges, a test payment, the offline save. Run in CI. |
| **Tidy the history out of the code** | Many code comments still name the work packages that wrote them ("OWNED BY P8"). They are history, not owners, and they slow a new developer down. | Remove them; [`MAINTAINERS.md`](MAINTAINERS.md) already holds what they meant. |
| **Import the old recruitment history** | The owner asked for the candidates and hires from before Linear Hub, so conversion by source and time to hire cover the past too. | Needs the old records (spreadsheet or export), a mapping to the pipeline's stages, and a dry run that shows what would be imported before anything is written. |
| **The review, delivered on Monday** | The weekly review is ready on Monday morning; people should not have to open the app to see it. | Now that Linear Hub has HTTPS: push notifications or email, with consent. Private lines only to their owner. |
| **Ask Linear Hub** (assistant, rules mode) | Owners and leaders want to ask "why was Tuesday quiet?" and get an answer in the same voice as the weekly review. | Answers only from facts the person can already see, built by the same rules as the review. |
| **Optional Claude mode for the assistant** | Free-text questions the rules cannot phrase well. | Opt-in, behind its own setting and switch; falls back to rules mode; daily caps; the model words the facts, never works them out. |
| **Smart scheduling defaults** | Leaders re-type the same events every week. | "Same as last time", clash and duplicate warnings, repeating events. |
| **Weekly team targets with pace** | Leaders want to know on Thursday whether the week will land. | "On pace for 54 of 60 by Sunday", an estimate with its range like every forecast. |
| **Finance alerts and a pay-week preview** | The owner wants loss weeks and Sunday-evening payroll surprises spotted early. | Loss weeks, low margins, missing or duplicate expenses; Sunday-evening estimated runs with the people who still have unlogged days. |
| **Entry-time plausibility nudges** | A mistyped 600 instead of 60 is easiest to fix while the form is open. | "Double-check?" when a day is far outside the person's usual; never blocks the save. |
| **Stage attribution and context benchmarks** | "Your conversion dropped" should say which stage, and compare with the company's actual as well as the law of averages. | "What changed and why" on conversion; a company-actual benchmark beside the fixed ones. |
| **New-starter documents with e-signing** | Hiring ends with paperwork in a folder. | Contract, right-to-work checklist and policies, signed on a phone and attached to the person; signed PDFs kept. |
| **Interview scheduling with calendar invites** | Observation days get missed when they live only in a message thread. | `.ics` invites to candidate and interviewer, with clash checks. |
| **Weekly numbers for clients** | Clients ask for weekly numbers on their campaign. | On the client accounts' campaign page: one campaign, no personal data about reps. |

## Later — when the business asks for it

| Item | Why | Notes |
|---|---|---|
| **A different database (Postgres, for example on Supabase)** | Worth it only when Linear MCR runs several offices with their own teams, or hundreds of people use Linear Hub at the same moment, or the business wants a managed database service. | **Not needed for going online**, and not the next step: one small server with SQLite handles Linear MCR's size with room to spare (about 430 requests a second for release 1.0 and 700 to 900 for 1.1 in the October 2026 load tests on a 4-vCPU test machine, for a company of tens of people that needs a few; 1.5 on a small shared server is not measured yet), and the backups, restore and off-site copies are built around it. Moving is a large job: every database call in the server is written for SQLite and runs one at a time (around 700 calls in about 90 files, with SQLite-only SQL), so it means a new data layer area by area, numbered migrations and a parallel run before switching. Weeks of work, quoted on its own. Supabase would hold the database only: the Linear Hub server would still run on a server like today's. |
| **Multi-office support** | If Linear opens a second city, teams and events need an office. | Mostly a data change plus filters; the first point at which the database item above might become worth it. |
| **Single sign-on** (Microsoft 365 or Google Workspace) | Replaces email + employee ID (or PIN) once the company has managed accounts for everyone. | Employee ID stays as the display identifier; two-step stays for anyone outside SSO. |
| **Accounting push** (Xero or Sage) | 1.5 exports a payroll spreadsheet for the accountant; next is sending pay and expenses straight to the ledger. | Only from each product's published import or API, tested with a real account. |
| **More bank file formats** | Starling, Revolut and a general Faster Payments file today; NatWest / RBS Bankline, Barclays, HSBC, Lloyds, Santander, Monzo Business and Wise's batch file could not be checked against the banks' own templates. | Add each one only from the bank's published template, tested with a 1p file. |
| **Wise funding and payment approvals** | With a personal token, Wise does not let Linear Hub fund the transfers it creates for a UK business, and refuses tokens when approvals are on. | Wise's partner access, if Linear MCR qualifies. |
| **Calendar export** | Reps want their events in their phone's calendar. | `.ics` downloads, then a personal subscription link. |
| **Offer letter, onboarding checklist and expense receipts** | Less paper after a hire and after a day out. | Receipts by phone camera; leader expense claims with approval. |
| **Recruitment source attribution** | Which job boards actually produce hires. | Cost per hire, sources ranked with honest small-number handling. |
| **Event-day live board** | A big-number board on a tablet at the venue for the leader's huddle. | Read-only, team-scoped. |
| **Personal data tools** | UK GDPR: export someone's data, anonymise on leaving, retention sweeps. | Administrators only, recorded in the audit trail. |
| **A system health page** | 1.5 puts system health in the bell (backups, off-site copies, disk, the key on paper, server errors). | One page with the history, and scripted releases that write the changelog and tag. |
| **Partner API tokens** | Let a client or a payroll provider pull data without a person signing in. | Scoped, expiring tokens; rate-limited. |

---

## Not planned

- **Replacing WhatsApp for chat.** Linear Hub is for records, not conversations. Announcements cover the one-to-many
  case, and the weekly review is made to be pasted into the group.
- **Timesheets or GPS tracking.** The check-in time answers the punctuality question; tracking people's location does
  not earn its place.
- **A native app store app.** The installable web app (1.5) gives an icon on the home screen and opening without signal
  without two more codebases.
