# P2 invoices: self-billing invoices, accept or dispute, a proper document

Every pay run of a field person gets a self-billing invoice issued by Linear MCR Limited on the person's behalf; the
person accepts it or says what is wrong, and the office pays only accepted (or deemed accepted) invoices.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P2 invoices**.

## API

All routes are under `/api/invoices`, behind `requireAuth`; anonymous → 401, a client portal account → 403
`clientPortalOnly` (the foundation's client guard). Types: `shared/src/types/invoices.ts`.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /invoices/agreement` | every staff role | `SelfBillingAgreement` `{ version, title, body, acceptedAt }` (the text names the company's legal name) |
| `POST /invoices/agreement/accept` | reps and leaders (others 403) | `SelfBillingAgreement`; records version, time and IP once (a second call changes nothing) |
| `GET /invoices/profile` · `PUT /invoices/profile` | the signed-in person | `InvoiceProfile` (+ `invoiced`, `agreement { version, acceptedAt }`); PUT takes `InvoiceProfileInput` (strict: only the address lines, town, postcode, UTR, VAT number; `null`/empty clears) |
| `GET /invoices/profile/:userId` · `PUT …` | admin | the same for anyone (404 for an unknown id or a client account) |
| `GET /invoices/company` | every staff role | `CompanySettings` (defaults: the brand's legal name and address, the owner as signatory) |
| `PUT /invoices/company` | admin | `CompanySettings`; `CompanySettingsInput.signatureImage` is a `data:image/png;base64,…` (a complete PNG: IHDR first with a width and height of 1–4000 px, every chunk's CRC right, IEND last with nothing after it; ≤ 200 KB) or `null` to remove. 400 otherwise, and nothing is written |
| `GET /invoices/signatures/:file` | every staff role | the signature PNG an invoice prints (content-addressed `<16 hex>.png`, cached privately) |
| `GET /invoices?from=&to=&userId=&weekStart=&status=` | rep/recruiter own; leader own team + self; admin all | `InvoiceListRow[]` (an `InvoiceSummary` plus `payrollRunId, userId, userName, weekStart, weekEnd, dueDate, runStatus`), newest week first; default range the last 12 weeks |
| `GET /invoices/by-run/:runId` · `GET /invoices/:id` | admin, the person, their team leader (others 403; none 404 "Invoice not found") | `Invoice` with `runStatus`, `paidDate`, `paidOverride`, `previousVersions` (after a reissue), `actions { accept, dispute, resolve, markPaidWithReason }` for the viewer, `agreementAccepted` for the supplier only, and `runTotal` + `figuresChanged` for the admin. A team leader's view has `supplier { name, vatNumber, withheld: true }` with no address, postcode or UTR. A deemed acceptance of someone who had not accepted any self-billing agreement by then has `acceptance.withoutAgreement: true`. An invoice whose run changed since is brought up to date first (see Logic) |
| `POST /invoices/:id/accept` | the supplier only (403 otherwise) | `Invoice`. 409 `{ details.code: 'agreement_required' }` until the agreement is accepted; idempotent once accepted or deemed accepted; also from disputed (the person changed their mind) or resolved |
| `POST /invoices/:id/dispute` `{ reason (3–1000), lines: [{ line, note? }] }` | the supplier only | `Invoice` (status `disputed`). 400 for a line that is not on the invoice or picked twice; 409 once paid, already disputed or already answered, or past the deadline ("The time to dispute this invoice passed at 12:00 Thu 22 Oct. Speak to the office: a correction can go on a later week.") |
| `GET /invoices/disputes` | admin | `InvoiceDisputeRow[]` oldest first, with `disputedLines` (description, amount, the person's note), `ours { total, salesLogged, salesConfirmed? }`, `payrollRunId`, `dueDate`, `teamName`, `figuresChanged`, `runTotal`, and `statements [{ id, campaignCode }]`: the client statements that confirmed the person's sales for that week (P1's `sale_confirmations`) |
| `POST /invoices/:id/resolve` `{ action: 'reissue' \| 'keep', note (3–1000), adjustment?: { amount, note? } }` | admin | `Invoice`. Disputed only (else 409). `keep` → `resolved` (payable); `reissue` (unpaid runs only) → optional correction, then version + 1, status `issued` |

`PUT /invoices/profile`, `POST /invoices/agreement/accept`, `POST /invoices/:id/accept` and `/dispute` share a
per-person limit of 60 a minute (the numbers and wording of `middleware/writeLimit.ts`, a counter of their own inside
the router): the next one is 429 "That is more than 60 changes in a minute. Wait a minute, then try again." with
`Retry-After: 60`, and is not audited.

Changes to the finance routes (through the foundation's hooks, no edit to `routes/finance.ts`):

- `GET /finance/payroll`, `GET /finance/me` (runs) and `GET /finance/payroll/:id`: each run with an invoice carries
  `invoice: InvoiceSummary` (status as it stands now, so an issued invoice past its deadline already reads
  `deemed_accepted`, and the invoice of a run that changed is brought up to date first); runs without one gain no key.
- `POST /finance/payroll/:id/pay` (admin): **409** when the run's invoice is issued and before its deadline —
  `"This invoice is not accepted yet. Open the run to mark it paid with a reason."` (`details.code
  'invoice_not_accepted'`); body `{ overrideReason }` (3–500 characters) pays it anyway and the reason is stored on the
  invoice. A **disputed** invoice is held until the office resolves it: 409 `'invoice_disputed'` *even with a reason* —
  `"This invoice is disputed, so it is held until the office answers. Resolve it first in Finance → Company → Disputed
  invoices: Keep as it is, or Fix and reissue."` (named as the card is). A run whose pay changed since its invoice was
  issued gets a new version first; while that version waits for the person, 409 `'invoice_reissued'` (or pay it with
  a reason). `details.deemedAcceptedAt` is the version's deadline. A run without an invoice (office roles, weeks before
  1.3) is unchanged.

Audit (`server/src/lib/audit/invoiceSpecs.ts`): accept the agreement (entity `agreement`, once), save invoice details
(own / admin, entity `user`, the changed fields named), save company details (entity `settings`; the signature as a
file name, never its bytes), accept / dispute / resolve an invoice (entity `invoice`), and a refinement of Mark paid
(same row and wording as 1.2, plus "without an accepted invoice (LM-SB-…). Reason: "…"" when overridden). Automatic
steps are `SYSTEM invoices.issue` / `invoices.reissue` / `invoices.refresh` / `invoices.deem` rows (actor "Linear
Hub"): one per week for issue and deem, one per reissued invoice, one per batch of refreshed ones. Unchanged saves write nothing. The client reports "Print invoice" and "Download PDF" as exports
(`reportAuditEvent`, formats `print` / `pdf`).

Attention (`lib/attention/invoices.ts`, kind `invoices`, read-only):

- reps and leaders: `invoices:open:<id>:v<version>` "Check and accept your invoice" ("… by 12:00 Thu 22 Oct" once
  the deadline is under 24 hours away); for a new version "Your invoice changed: £300.00 (was £345.00)" when the total
  moved, "Your invoice was reissued" when only the paid lines did, "The office fixed your invoice" after Fix and
  reissue. The body names the deadline: "w/c 12 Oct, £300.00. Accept it or say what's wrong by 08:30 Sat 24 Oct;
  after that it counts as accepted." A deadline at 00:00 reads "midnight on Thu 22 Oct", never "00:00 Fri 23 Oct";
  `invoices:resolved:<id>:<at>` "The office replied about your invoice" for 7 days. All severity `info`: they sit in
  the bell and the top box and never pop up as a toast (a warning toast covered the open invoice's own Accept / Send
  buttons on phones, and offered "Open My pay" on My pay);
- admin: `invoices:dispute:<id>:v<version>` "Harry Donnelly says something's wrong" → `/finance?tab=company#disputes`,
  and on the day before and the day of a deadline `invoices:waiting:<date>` "12 invoices not accepted yet" (count).

One SQL statement per caller (the person's own invoices, with the replaced version's total from a sub-select; the
admin's disputes and the waiting count in one `UNION ALL`). Measured on the merged demo: the whole feed takes the
admin 12 statements (was 13 with P2's two admin queries, over the 1.1 budget of 12), a leader 12, a rep 6, a
recruiter 4.

## Logic

**Who.** Reps and leaders (`INVOICED_ROLES`: the field people, decision 1). Office recruiters and administrators keep
the payslip. A run is invoiced when it is unpaid (`pending` or `failed`) and has no invoice yet.

**When.** `startInvoiceJobs` (index.ts) runs at start-up and every 15 minutes: it makes sure the closed week has its
runs (`ensurePayrollMaterialised`), then `syncInvoices`: (1) invoices whose unpaid run changed are brought up to date
(refreshed or reissued, below); (2) every unpaid field run without an invoice gets one; (3) issued invoices past their
deadline become `deemed_accepted`. Nothing is ever deemed accepted in the tick that issues it: every version has at
least 24 hours (Deadline, below). An issued invoice past its deadline already *reads* as deemed accepted. Reading an invoice (`GET
/invoices/:id`, `/by-run/:runId`, the list, the payroll rows' summaries) or accepting, disputing or paying it first
brings it up to date with its run, so nobody sees an old total until the next tick. Paid runs never change, so their
invoices never do.

**Removed runs.** A run removed because nothing is payable any more (or a deleted account) takes its invoice with it
(CASCADE), but the trigger `invoices_keep_void` first copies it into `invoice_voids` (number, person, run, last
version, status, total, lines, reason, and `versions_json`: every earlier version from `invoice_versions` — lines,
total, status, acceptance, dispute, why it was replaced — read before the cascade removes them), so every number and
every version ever issued is accounted for. A database whose trigger predates `versions_json` gets the column and the
new trigger once (`upgrade`: `invoice_voids.versions_json`, `trigger invoices_keep_void`).

**Number.** `LM-SB-<year>-<6 digits>` (`formatInvoiceNumber`), in issue order per calendar year of the issue date
(meta `ext:invoices:seq:<YYYY>`, never below a number already used). A reissue keeps the number and raises the
version; each replaced version is kept in `invoice_versions` (lines, total, status, dispute).

**Lines and total.** From P1's `weekPayBreakdown(db, userId, weekStart)` when its paid lines add up to the run's gross
(base or commission, the other listed as *Not paid*, per-campaign subs with cancellations, corrections from earlier
weeks, bonus, deductions); otherwise from the stored run (base, commission, bonus, overrides, corrections from
`adjustments_total`, deductions, and an "Other adjustments" line if the stored figures do not add up). Either way
**the total is the run's gross**: what Mark paid pays. Worked example (1.2 figures, the fixture rep): 4 days × £60.00
= £240.00 + 12 sales × £45.00 = £540.00 + £75.00 bonus = **£855.00**; a £20.00 deduction later reissues it as
version 2 at **£835.00**. With P1's rule: 4 days × £63.50 = £254.00 paid; BCN 16 subs × £10.00 = £160.00 listed, not
paid; bonus £25.00; correction for w/c 5 Oct −£20.00; deduction −£12.50 → **£246.50**.

**Change detection.** An invoice remembers its run's figures when its lines were last written (`run_fingerprint`:
days, sales, team sales, base, commission, bonus, overrides, deductions, gross, and P1's paid-as / confirmed /
cancelled / adjustments). A different value on an unpaid run means the run was recalculated (gauges, a statement, an
adjustment, an approved rate). The lines are rebuilt and compared with the invoice's (`sameInvoicePayment`):

- **the same payment** — the same total and the same paid lines (kind, campaign, quantity, unit price, amount; "Not
  paid" lines and wording do not count): the lines are **refreshed in place** and the status, acceptance, version and
  deadline stay. Example: BCN cancels 2 of Sophie's 5 subs on a week paid as the base (4 days × £63.50 = £254.00):
  the BCN line now reads 3 subs, still not paid, the total stays £254.00, and her accepted invoice stays accepted.
  When the version had been accepted (or counted as accepted, or kept by the office) and its wording changes, the
  lines it was accepted with are kept first in `invoice_refreshes` (invoice, number, version, status, when it was
  accepted, the lines, when they were replaced; no foreign key, so the record outlives a voided invoice): what the
  person agreed to is never lost;
- **a different payment**: a new version ("The amounts changed after it was issued") for the person to check.

A **disputed** invoice is never refreshed or reissued by itself: it is held for the office.

**Deadline (the rule).** An invoice counts as accepted if it is not disputed by **12:00 the day before payday, or 24
hours after the version was issued, whichever is later** (`invoiceDeadline(payday, issuedLocal)`, Europe/London wall
clock; "24 hours" is the same time the next day, rounded up to the whole minute). So every version gives the person
at least a day to accept it or say something's wrong:

| Issued (payday Fri 23 Oct) | Counts as accepted at |
| --- | --- |
| Mon 19 Oct 07:00 (the usual Monday issue) | 12:00 Thu 22 Oct |
| Wed 21 Oct 11:00 (reissued: a late gauge) | 12:00 Thu 22 Oct |
| Wed 21 Oct 16:30 | 16:30 Thu 22 Oct |
| Thu 22 Oct 13:05 (a statement applied after the usual deadline) | 13:05 Fri 23 Oct |
| Fri 23 Oct 08:30 (payday morning) | 08:30 Sat 24 Oct |
| Wed 21 Oct 15:00, for an old failed transfer (payday Fri 4 Sep) | 15:00 Thu 22 Oct |

Until then the invoice is *issued*: the person is told ("Your invoice changed: £300.00 (was £345.00)") and has
**Accept invoice** and **Something's wrong**; Mark paid needs their acceptance or the office's reason (the lead's
rule), and bulk Mark paid skips it and says so. A deemed acceptance is dated at the deadline, so never before the
version existed (`deemedAcceptanceMoment` also guards rows written by an earlier build). The earlier build capped
every deadline at 00:00 on payday: a version issued on or after payday was stored as deemed accepted at once, dated
before it existed, with no way to dispute it (re-review P2 major); that cap is gone. A disputed invoice is never
deemed accepted.

**Statuses.** `issued` → `accepted` (the person, needs the agreement) · `deemed_accepted` (the deadline) ·
`disputed` (the person, before the deadline, while unpaid) → `resolved` ("Keep as it is", payable) or a new `issued`
version ("Fix and reissue"). Payable: accepted, deemed accepted, resolved.

**Fix and reissue with a correction.** The admin's correction becomes a `pay_adjustments` row (kind `dispute`,
`invoice_id`, target and source = the disputed week, created by the admin); the run is recalculated with
`db/maintenance.ts syncPayrollRun` (P1's rule) and the new version is built from it: with P1, a +£63.50 correction on
a £254.00 week moves the run's gross to £317.50 and version 2 is issued at £317.50 (version 1 kept).

**Parties.** Supplier = the person's name, address lines, postcode, UTR (optional), VAT number (optional, else "Not
VAT registered"); customer = Settings → Company plus the signatory and the signature file. Both are copied onto the
invoice when issued and refreshed while it is open (issued or disputed, unpaid); once accepted they are frozen, so a
later edit never rewrites an accepted invoice. Only the person and the office see the supplier's home address and UTR;
a team leader opening a team member's invoice sees the name, the VAT registration (public), the lines and the total.

**Mark paid.** Accepted, deemed accepted or resolved → paid. Issued and before its deadline → a reason is needed
("Mark paid anyway", in the invoice). Disputed → held: resolve it first (Keep as it is makes it payable at once). A
version issued late (on payday, say) waits for the person like any other: they accept it, or the office pays it with a
reason, or it counts as accepted 24 hours later.

**Bulk Mark paid.** Selected runs whose invoice is not accepted are not sent (`payableRuns`); the bar says how many
("18 invoices not accepted yet: skipped"), the confirm step for runs with checks counts and lists only the runs that
will be paid ("Mark 10 paid"; no confirm step when none of those has a check), and the summary reads "20 marked paid ·
3 skipped (invoice not accepted) · 0 skipped (already paid) · 0 failed". When held runs are in the selection, the
confirm step's description says so: "These checks are advisory. 3 selected runs with an invoice not accepted yet are
skipped. Here is why each run you are paying stood out:" (`bulkConfirmDescription`), never "you can still pay every
selected run".

**Payslip (runs without an invoice).** Office roles and weeks paid before invoices began keep the payslip. For a field
person's week under P1's base-or-commission rule, P1's breakdown (fetched once, the query PayBreakdown makes) replaces
the 1.2 pay table and the plan box, whose plan figures ("Commission 10 sales × £0.00 £254.00", "Base pay 4 days ×
£63.50 £0.00") contradicted it (re-review P1 minor). The 1.2 table stays for plan-rule weeks, salaried office weeks
and when the breakdown cannot be read.

**Demo seed.** Invoices for the field people's runs of the last six completed weeks, each issued at 07:xx on the
Monday after its week. Self-billing "started" with the first of those weeks, so every older unpaid run (a failed
transfer) is invoiced on that first Monday at 06:30–06:59 (before that morning's other invoices, keeping the numbers
in issue order), not backdated to its own week as if 1.3 had existed then; with 24 hours to answer, they are accepted
or counted as accepted by now. The demo agreements are dated a few days before that first Monday (or on a newer
person's start date), and an invoice is only marked accepted after its person accepted the agreement (else it counts
as accepted at its deadline). The first job tick on a fresh demo issues, refreshes, reissues and deems nothing.

**Files.** The signature is stored under `uploads/` next to the app secret (server/data/uploads/; `LM_UPLOADS_DIR`
relocates it), content-addressed so an issued invoice always shows the signature it was issued with.

Tests: `shared/src/logic/invoices.test.ts` (14, hand-computed fixtures: the deadline across issue times — the usual
Monday, a late reissue, payday itself, an old failed transfer, month and year ends, a sweep checking it is never under
24 hours —, the deadline in words, the acceptance moment, the same-payment rule, effective status, lines from a 1.2 run
and from a P1 breakdown, the balancing line, formats) and `server/src/test/invoices.test.ts` (24: every route for
anonymous, client, rep, leader, recruiter and admin; the job, with the late week waiting 24 hours; the hooks; refresh
in place vs reissue, keeping the accepted lines; a version issued after the usual deadline (24 hours, "Your invoice
changed", accept or dispute, payday Mark paid needs acceptance) and one issued on payday for an old transfer (never
accepted at once, deemed 24 hours later and dated then); a disputed invoice refused even with a reason; the leader's
withheld supplier block; malformed PNGs; the write limit; void records with every version; the old void trigger's
upgrade; the deadline; the 1.2 upgrade of the foundation's table; the demo seed: first tick, no acceptance before the
agreement, older transfers issued when self-billing started). Line checks go by kind, amount and paid flag, so they
pass with P1's breakdown and with the stored run.

## User guide

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
- If what you are paid changes (a late gauge, a client's statement, a correction), you get a new version to accept,
  and a notification such as "Your invoice changed: £300.00 (was £345.00)". It has the same 24 hours at least, even on
  payday. Until you accept it, the office needs a reason to pay it, so accept it as soon as it is right. A change that
  does not change your pay (for example cancellations on a week you were paid the base) just updates the lines:
  nothing to accept again.
- **Print invoice** gives a clean A4 page (and **Download PDF** once PDFs are switched on).
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

## Owner notes

- **Who is invoiced**: reps and leaders. Recruiters and administrators (you, Marcus) still get a payslip, because they
  are office roles. If recruiters are self-employed too, say so: it is a one-line change (`INVOICED_ROLES`).
- **Have your accountant read the agreement** (Settings → Company → **Agreement text**) before go-live. HMRC expects a
  self-billing agreement with each supplier, reviewed every 12 months for VAT-registered suppliers. Changing the
  wording means a new version (`SELF_BILLING_AGREEMENT_VERSION`) and everyone accepts again.
- **VAT**: Linear Hub never adds VAT. If someone is VAT registered, their invoices need VAT on top: talk to your
  accountant before paying a VAT-registered person through Linear Hub. The invoice prints their VAT number and says
  "No VAT has been added to this invoice."
- **Fill in Settings → Company** first: the postcode and company number are empty in the demo (the invoice prints
  what is there). The owner's name is the default signatory.
- **On your existing database**, the first start of 1.3 issues invoices for every unpaid field run (pending runs and
  failed transfers); already paid weeks get none. Last week's have the usual Thursday 12:00 deadline; older unpaid
  runs, whose payday has gone, get 24 hours like any late invoice (then they count as accepted). **Upgrade on a
  Monday, Tuesday or Wednesday morning**: upgrading on Thursday afternoon gives last week's invoices until Friday
  afternoon, so on Friday morning Mark paid needs each person's acceptance or your reason. Everyone is asked to accept
  the agreement on their next visit.
- **The deadline rule (lead decision, for your accountant)**: "12:00 the day before payday, or 24 hours after the
  invoice was issued, whichever is later", so nobody's invoice counts as accepted before they could see it. The cost:
  an invoice that changes on Thursday afternoon or on payday is not paid automatically on Friday morning unless the
  person accepts it (they get a notification) or you pay it with a reason. Clause 3 of the agreement says so ("You
  always get at least 24 hours…"). The agreement's version is unchanged (2026-10): nobody outside the demo has
  accepted it yet. Bump `SELF_BILLING_AGREEMENT_VERSION` if a real person accepted the earlier wording.
- **Decision for you (and your accountant): deemed acceptance without an agreement.** "Counts as accepted at the
  deadline" is a term of the self-billing agreement. Today an invoice still counts as accepted at the deadline when
  the person has not accepted the agreement yet (otherwise nobody could be paid in the first week without a reason),
  and the invoice says so: "Deemed accepted … (the self-billing agreement was not accepted yet)". If you would rather
  such invoices wait for acceptance (or a reason), say so: it is a small change.
- **Paying without acceptance** is possible with a reason (kept with the invoice and in the audit trail) for an
  invoice still waiting; never for a **disputed** one, which is held until you answer it (the lead's rule, taken
  literally). Bulk Mark paid never pays a waiting invoice for you.
- **Back up the signature image**: it lives in `server/data/uploads/`, which the nightly database backup does not
  copy (the invoices keep working without it; they just show the name).
- **A reissue keeps the invoice number** and raises the version (the earlier versions are kept and shown). If your
  accountant prefers a credit note and a new number for corrections, that is a change to make before go-live.
- **For the lead**: (1) the bulk confirm step's count is fixed with a three-line change in `pages/Finance.tsx` (P1's
  page: `payableRuns` from `features/finance/bulkPay.tsx` for `flaggedSelected` and the confirm label), and its
  description now comes from `bulkConfirmDescription` (same file, one more line); keep both when merging. (2) The self-service invoice writes have their own 60-a-minute limiter inside `routes/invoices.ts`; if P9
  adds `/invoices` prefixes to `WRITE_LIMITED_ROUTES`, drop it. (3) Removed runs leave void records in
  `invoice_voids` (no screen yet). (4) Merged with P1 the "Fix and reissue" correction moves the run's gross, and the
  lines come from P1's `weekPayBreakdown`; the P2 tests pass with and without P1. (5) Last fix round: the test server
  in `server/src/test/helpers.ts` keeps idle sockets for 120 s (`server.keepAliveTimeout`), because r3-contracts'
  "anonymous → 401" test failed with ECONNRESET ("fetch failed") in every full `npm test` run on the merged tree: the
  synchronous extension-seed test before it blocks the event loop for ~6 s, longer than Node's 5 s keep-alive timeout,
  and the next request went out on a pooled socket the server then reset (integration-trial item 5). One line, test
  only; drop it if the foundation fixes the flake another way. (6) The attention feed's 12-statement budget is met
  for the admin again (13 → 12) by P2's provider alone; the leader is exactly at 12.
