# Release 1.4 — package F: payments foundation

Paying people from Linear Hub: bank details, payment connections, payment batches (draft → approve with a fresh
two-step code → paid or failed), and the contract packages P (bank payment file) and A (Revolut Business, Wise
Business, TrueLayer) build on. F ships the four ways to pay with their abilities, logos and connection forms, and a
fake provider for tests; until P and A land, paying (and testing a connection) through any of the four answers 501
with a plain sentence.

## API

All under `/api`, JSON. Contracts: `shared/src/types/payments.ts`. Every write has an audit spec
(`server/src/lib/audit/paymentSpecs.ts`) and the per-person write limit (`middleware/writeLimit.ts`).

**Who.** `/payments/*` and `/users/:id/bank-details*`: administrators only — 401 signed out, 403 for leaders,
recruiters and reps, 403 `clientPortalOnly` for client accounts (the client guard). `/me/bank-details`: every staff
role, their own; client accounts 403. A leader or recruiter never sees anyone else's bank details.

### Ways to pay and connections

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/payments/providers` | — | `PaymentProviderView[]`: the four (`bank_file`, `revolut`, `wise`, `truelayer`) with `abilities`, `configFields` (the connection form) and `available` (false until P / A build the adapter) |
| GET | `/payments/connections` | — | `PaymentConnection[]` (active first). Never a secret: `secretsSet` lists the NAMES of the secrets stored |
| POST | `/payments/connections` | `{ provider, name?, settings?, secrets? }` | 201 `PaymentConnection`. 400 with `details: [{ path, message }]` per wrong field. An API connection starts `mode: 'test'`, `status: 'not_connected'`; a bank file connection `mode: 'live'`, `status: 'connected'` (it has no test mode; nothing moves until Matt uploads the file) |
| PATCH | `/payments/connections/:id` | `{ name?, settings?, secrets?, mode?, confirm? }` | `PaymentConnection`. An empty secret keeps the stored one. Changing settings or secrets of an API connection puts it back to `not_connected`. `mode: 'live'` needs `confirm: "PAY FOR REAL"` typed exactly (400 otherwise) and a connected test (409 otherwise); afterwards the connection is `not_connected` until a live test works. A bank file cannot change mode (400). 409 once disconnected |
| DELETE | `/payments/connections/:id` | — | `PaymentConnection` with `disconnectedAt`: secrets wiped, drafts through it cancelled, history kept. 409 while a payment through it is still on its way |
| POST | `/payments/connections/:id/test` | — | `PaymentConnectionTestResult { ok, message, balancePence?, checkedAt, connection }`; stores `connected` / `error`. 501 until the adapter is built |

### Batches

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/payments/batches` | `?limit=` (1–200, default 50) | `PaymentBatchSummary[]`, newest first, with `paidCount`, `failedCount`, `waitingCount` |
| POST | `/payments/batches` | `{ connectionId, runIds }` (1–500) | 201 `PaymentBatch` (a draft). Runs that cannot be paid this way are left out with a plain reason (`skipped: PaymentSkip[]`, codes `not_found`, `already_paid`, `in_payment`, `week_not_ended`, `not_positive`, `invoice_not_accepted`, `invoice_disputed`, `no_bank_details`, `bank_details_unconfirmed`). 400 `{ error, details: { skipped } }` when none can; 409 when the connection is not connected, or a run went into another payment a moment ago |
| GET | `/payments/batches/:id` | — | `PaymentBatch { …summary, items, skipped, kind, actions { approve, cancel, refresh, download, markPaid } }`. Items show the payee name and `accountLast4` only |
| POST | `/payments/batches/:id/approve` | `{ code }` | `PaymentBatch` after submitting. Order: 409 unless a draft; 501 if the provider is not built yet; 409 if the connection is not connected or changed mode; 409 `batch_changed` with `details.problems` if anything changed since the draft (a run paid, a run's pay changed, bank details changed, an invoice no longer payable) — all BEFORE the code is used; 403 `twoFactorRequired` if the admin has no two-step verification; 400 for a missing or wrong code (6 wrong codes in 10 minutes → 429); then one approval wins (409 for the other) |
| POST | `/payments/batches/:id/refresh` | — | `PaymentBatch`: sends again what a failed submit left queued (same idempotency keys) and asks the provider about the rest. 409 for a draft or a bank file |
| POST | `/payments/batches/:id/cancel` | — | `PaymentBatch`: a draft; a bank file's people not yet marked (the file was not used); an API payment only when the adapter can stop it (409 otherwise: "cannot be stopped from Linear Hub") |
| GET | `/payments/batches/:id/file` | — | The bank file (`Content-Disposition: attachment`, `Cache-Control: no-store`), stored encrypted; recorded in the audit trail as an export. 404 before approval or once cancelled |
| POST | `/payments/batches/:id/mark-paid` | `{ paid?: itemId[], failed?: itemId[], reason?, paidDate? }` | Bank files only (409 otherwise): `paid` items mark their runs paid (on `paidDate`, default today, not in the future, not before the week ends); `failed` items fail with `reason` (default "The bank did not pay this one"). Neither list: every waiting item is paid |

### Bank details

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/me/bank-details` | — | `BankDetailsView { details: BankDetails \| null, codeRequired }` — masked: `sortCodeMasked` "••-••-34", `accountNumberMasked` "••••5678" |
| PUT | `/me/bank-details` | `{ holderName, sortCode, accountNumber, code? }` | `BankDetailsView`. Sort code 6 digits, account number 8 (spaces and dashes ignored), holder name 2–70 letters, spaces, hyphens, apostrophes. The fields are checked before the code, so a typo never uses one up. `code` (a current authenticator code) is required when the person has two-step verification on. A person's own change waits for the admin (`needsConfirmation: true`) |
| GET | `/users/:id/bank-details` | — | `BankDetailsView` (admin). 400 for a client account, 404 unknown |
| PUT | `/users/:id/bank-details` | as above | Admin types them in: they count as confirmed by that admin. The admin's own code when the admin has two-step |
| POST | `/users/:id/bank-details/confirm` | — | `BankDetailsView`: confirmed now (no change, and no audit row, when already confirmed). 404 when there are none |

### Additive fields on existing answers

- `GET /finance/payroll` (admin only): an unpaid run carries `payment?: PayrollRunPayment { batchId, itemId, status,
  draft, failureReason, updatedAt }` — its latest live payment from Linear Hub. Absent otherwise.
- `POST /finance/payroll/:id/pay` answers 409 `{ code: 'in_payment', batchId }` while the run is in an APPROVED payment
  still on its way ("… is in payment #12, which is still on its way. Wait for it to finish, or cancel it, before
  marking the week paid by hand."). Drafts do not hold a run.
- `AttentionKind` gains `'payments'` (the bell's "Payments" group); `AuditEntity` gains `payment_connection`,
  `payment_batch`, `bank_account` (labels "Payment connection", "Payment", "Bank details").

## Logic

Proposed LOGIC §17 "Paying people (1.4)".

### 17.0 Tables (`server/src/db/extensions/payments.ts`, appended last to the extension list)

- `bank_accounts (user_id PK → users CASCADE, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2,
  changed_at, changed_by, confirmed_by_admin_at, confirmed_by)` — numbers encrypted with `lib/crypto.ts`.
- `payment_connections (id, provider, name, mode 'test'|'live', settings_json, secrets_enc, status
  'not_connected'|'connected'|'error', last_checked_at, last_error, balance_pence, created_at, created_by,
  live_confirmed_at, live_confirmed_by, disconnected_at)` — `secrets_enc` is ONE encrypted JSON of the secrets.
- `payment_batches (id, connection_id, provider, mode, created_at, created_by, approved_at, approved_by, total_pence,
  count, status 'draft'|'submitted'|'processing'|'completed'|'partly_failed'|'failed'|'cancelled', file_name,
  idempotency_key UNIQUE, provider_ref, skipped_json, file_enc, last_error, updated_at, cancelled_at, cancelled_by)`.
- `payment_items (id, batch_id → CASCADE, payroll_run_id, user_id, week_start, amount_pence > 0, payee_name,
  account_last4, status 'queued'|'submitted'|'processing'|'paid'|'failed'|'cancelled', provider_ref, failure_reason,
  submitted_at, paid_at, updated_at, note, live 0|1)` with the partial UNIQUE index `idx_payment_items_live_run ON
  (payroll_run_id) WHERE status NOT IN ('failed','cancelled') AND live = 1`. No foreign key to `payroll_runs` or `users`
  (the pay rules may remove and remake an unpaid run; payment history outlives both): a run is also matched by
  (user, week).
- Times are on the business clock (`nowISO()`), like pay adjustments; the two-step code limiter is on the real clock.
- Demo seed (fresh databases only): bank details for the active field people and recruiters, sort code 00-00-00 and
  account number `0000` + their id (obviously fake); every ninth person has none; one changed theirs yesterday and waits
  for the admin. No connection, no payment. An existing demo database gains no bank details.

### 17.1 Money and bank details (`shared/src/logic/payments.ts`)

- Pence everywhere in payment code: `poundsToPence(gross)` converts a run's two-decimal pounds once, exactly
  (1.15 → 115), and throws on anything with more decimals; `formatPence` shows "£1,234.50".
- `normaliseSortCode` (6 ASCII digits), `normaliseAccountNumber` (8), `validateBankDetails` (one message per field),
  `maskSortCode` "••-••-34", `maskAccountNumber` "••••5678".
- `defaultPaymentReference(weekStart, payeeName)` → "LINEAR 05OCT JL" (A–Z, 0–9, spaces, ≤ 18 characters). A bank
  format may make its own.
- `batchStatusFromItems`: anything waiting → `submitted` (nothing back) or `processing`; else, ignoring cancelled
  items, all paid → `completed`, all failed → `failed`, a mix → `partly_failed`; nothing left → `cancelled`.
- `PAYMENT_PROVIDERS`: the four ways to pay with `PaymentAbilities { paysFromApp, confirmsAutomatically,
  needsBankApproval, testMode, checksBalance, sameDay, fees, setup[], limits }` in plain words — written from each
  provider's public description; P and A correct them against the providers' current documentation.

### 17.2 The hold on changed bank details

A person's own change leaves the details unconfirmed (`confirmed_by_admin_at` NULL or older than `changed_at`): the next
payment to them is skipped ("Thomas changed their bank details on Thu 22 Oct: check them with Thomas, then confirm them
in Team"), and the admin's Needs-attention feed says "Thomas Grainger changed their bank details" until an admin
confirms them. Details an admin types in count as confirmed by that admin. Saving the same details again changes
nothing. Approving a draft re-checks that nobody's details changed since the draft; sending re-checks against the
approval time, and never sends to details that changed after it.

### 17.3 A batch, from draft to paid (`server/src/lib/payments/batches.ts`)

1. **Draft.** From the selected runs and a connected connection. A run goes in when it is unpaid (pending or failed),
   its week is over, it is more than £0, its invoice is accepted, deemed accepted or resolved (or it has none: the 1.2
   rules), it is not in another LIVE payment (by run id or person + week), and its person has confirmed bank details.
   The rest are skipped with a reason, kept on the batch. Items copy the amount (pence), the holder name and the last
   four digits.
2. **Approve.** Everything is checked again before the code is used; then the admin's fresh authenticator code
   (`lib/payments/code.ts`: an authenticator code only, accepted once, wrong codes counted like at sign-in); then a
   conditional UPDATE claims the batch (one approval wins); then `submit` is called with every queued item, each with
   its idempotency key `<batch key>:<item id>`.
3. **Results.** `paid` → the run is marked paid through `lib/markPaid.ts`, the same function POST
   `/finance/payroll/:id/pay` now calls (same checks, invoice hook and UPDATE), once; if a check refuses because
   something changed after approval (e.g. the invoice was reissued), the run is marked paid anyway — the money has gone
   — and the item carries a note. If the run's pay changed after the money went, the note says by how much ("Add an
   adjustment for the difference on a later week"). A run already marked paid by hand is never marked again (note:
   check whether they were paid twice). `failed` → the run stays unpaid, `pending` becomes `failed` (a failed
   transfer, on Runs to pay from any week), and Runs to pay shows "Payment failed" with the reason. Each run a payment
   moves gets its own audit row ("Marked paid by payment #12: …" / "Payment #12 failed: …"), by the admin or, from the
   job, by Linear Hub.
4. **Refresh** (Check now, and `lib/payments/job.ts` every 5 minutes while an approved API payment has items waiting;
   `LM_PAYMENTS_JOB=0` turns the job off): resends queued items (same keys) after a submit that threw, then asks the
   provider about submitted / processing items. One conversation per batch at a time.
5. **Test mode** (a provider's sandbox) moves no money: items can be paid but never mark a run paid ("Test mode: nobody
   was paid"), and test items never hold a run (`live = 0`).
6. **Bank files**: `submit` returns the file; it is stored encrypted (`file_enc`) and downloaded by the admin; Mark as
   paid settles the items the bank paid and fails the ones it rejected; Cancel frees the rest.

Never twice: the partial unique index, the draft and approval checks, the claim, per-item idempotency keys, the
in-payment hold on Mark paid by hand, and `settlePaid` refusing a run already paid.

### 17.4 The provider contract (`server/src/lib/payments/provider.ts`) — for packages P and A

```ts
interface PaymentProviderAdapter {
  info: PaymentProviderInfo;                       // name, kind 'file'|'api', abilities, iconKey
  configFields: readonly PaymentConfigField[];     // the connection form (name, label, secret?, required?, help, type, options)
  ready: boolean;                                  // false: testing and paying answer 501
  validateConfig(input, existing?): ProviderConfig; // throw ProviderConfigError([{ path, message }])
  testConnection(conn, ctx): Promise<{ ok, message, balancePence? }>;
  submit(conn, batch, items, ctx): Promise<{ items: { itemId, status, providerRef?, failureReason? }[]; providerRef?; file? }>;
  refresh(conn, items, ctx): Promise<{ itemId, status, providerRef?, failureReason? }[]>;
  cancel?(conn, items, ctx): Promise<…>;
}
```

- `conn.secrets` are decrypted for the call only; `items` carry the full sort code and account number, the amount in
  pence, the reference and `idempotencyKey` (send it as the provider's idempotency key / request id). `submit` MUST be
  idempotent per item key: Linear Hub resends queued items after a submit that threw.
- Network only through `lib/payments/http.ts` `providerFetch` (15 s timeout; reads retried twice on network errors, 429
  and 5xx; a money-moving request never retried unless given its idempotency key; secrets and bearer tokens redacted
  from errors). Errors as `ProviderError(plain words)`. No test ever calls the real internet.
- Register in `lib/payments/registry.ts` in place of `stubProvider('<id>')`; correct the abilities in
  `shared/src/logic/payments.ts` and the form in `lib/payments/stubs.ts` (or your adapter). The fake
  (`lib/payments/fake.ts`) shows the shape; `LM_PAYMENTS_FAKE=1` registers it (and a fake bank file) for trying the
  screens — never on a server people are paid from.

### 17.5 Needs attention (`lib/attention/payments.ts`, admin only, one UNION ALL statement)

Changed bank details to check (by name up to three, then one line), failed live payments whose run is still unpaid with
no newer payment (one line, danger), bank files approved but not marked paid (info, newest two), and connections whose
last test failed (warning).

## User guide

### Paying people from Linear Hub (administrators)

1. **Set up a way to pay** — Settings → **Payments**. Each of the four ways to pay shows its logo, what it can do
   ("Pays from Linear Hub ✓", "Confirms payment automatically ✗", "You approve the payments in your bank ✓", test
   mode, balance, same day), its fees, what you need to set it up and anything to know. Press **Connect** and fill in
   the form; keys and tokens are stored encrypted and never shown again (leave a key empty when editing to keep it). A
   Revolut, Wise or TrueLayer connection starts in **test mode**: press **Test**, and once it works you can **Switch
   to live** by typing PAY FOR REAL. A bank payment file needs no test.
2. **Choose who to pay** — Finance → Company → Runs to pay → **Pay from Linear Hub** (it takes the runs you ticked), or
   Finance → **Pay people**. Tick the runs, choose how to pay, then **Review payment**.
3. **Check and approve** — the payment's page shows the total, each person with the last four digits of their account,
   and who was left out and why (no bank details, details changed and not checked, invoice not accepted, already in a
   payment…). Type the code from your authenticator app and press **Approve and pay £…** (or **Approve and make the bank
   file**). Every payment needs a fresh code, so set up two-step verification first (Settings → Security).
4. **Follow it** — the page updates by itself while payments are on their way; **Check now** asks at once. Paid weeks
   leave Runs to pay; a failed one stays there with the reason ("Payment failed") and can go in a new payment.
5. **A bank file** — **Download the bank file**, upload it in your online banking and approve it there. When the bank
   has paid it, tick who it paid under **Mark as paid** (untick anyone it rejected and say why) and press **Mark … paid**.
   If you did not use the file, **Cancel the rest**.

While a payment is on its way, **Mark paid** by hand on those weeks waits for it, so nobody is paid twice.

### Bank details (everyone)

Settings → **Bank details**: add the name on the account, the sort code and the account number. Only the last digits
are ever shown again. If you use two-step verification, a change needs your code. When you change them, the office
checks them with you before the next payment goes there. Administrators see each person's details (masked) on Team →
person, confirm changed ones with **Confirm details**, and can type them in for someone.

## Changelog

- Added: pay people from Linear Hub — Finance → **Pay people** and each payment's page: choose runs and a way to pay,
  review the total, people, masked accounts and who is left out, approve with a fresh two-step code, follow the
  statuses live; bank files can be downloaded and marked paid (per person, with a reason for any the bank rejected).
- Added: Settings → **Payments**: the four ways to pay (bank payment file, Revolut Business, Wise Business, Open Banking
  through TrueLayer) with their logos, what each can and cannot do, fees and setup; connections start in test mode and
  go live only when PAY FOR REAL is typed. Paying through them arrives with the provider packages of this release.
- Added: **Bank details** in Settings (your own) and on Team → person (administrators): masked, encrypted, a two-step
  code to change them, and a hold until an administrator confirms changed details; a Needs-attention item says so.
- Added: Runs to pay shows a run's payment from Linear Hub ("Payment on its way", "Payment failed" with the reason).
- Changed: Mark paid by hand waits while the run is in a payment from Linear Hub that is still on its way.
- Security: payment keys, tokens and account numbers are encrypted at rest and never returned by any API, written to
  the audit trail or logged; every payments write is audited and rate limited.

## Owner notes

- **Two-step verification is needed to pay anyone.** The demo admin account has none (and package S keeps the demo
  accounts exempt from the sign-in rule), so set it up in Settings → Security before approving a payment.
- **Test mode first.** Connect Revolut, Wise or TrueLayer in test mode with the provider's sandbox details, make a
  payment through it (nobody is paid; the runs stay on Runs to pay), and only then switch to live by typing PAY FOR REAL.
  Switching to live asks for a new test against the live service.
- **What F tested.** The whole flow with a fake provider (no network): drafts, approvals, refreshes, failures, timeouts
  and resubmits, bank files, never paying a run twice, test mode, the 501 of the four providers. Paying through the
  real Revolut, Wise, TrueLayer or a bank's file format arrives with packages A and P; until then those connections can
  be saved but not tested or used, and Linear Hub says so plainly.
- **Bank details on your current demo database**: an existing demo database gets none (they would be fake details on
  real people you may have added). A fresh demo (`npm run seed`) has fake ones (sort code 00-00-00) for most of the
  field people, and one change waiting for your check. Real people add theirs in Settings → Bank details.
- **Check changed bank details with the person** (in person or by phone) before you confirm them: this is the step
  that stops a payment going to someone else's account if a sign-in is misused.
- **Logos** come from the simple-icons package (CC0, pinned at 16.34.0): Revolut, Wise, Starling Bank, Monzo,
  Barclays, HSBC and Tide. It has no TrueLayer mark, so TrueLayer shows a neutral "TL" monogram (its brand colour could
  not be verified, so the badge is neutral rather than coloured). Logos belong to their owners and only identify the
  service — the docs stage may want this sentence on the About page and in the README.
- **Trying the screens without real money**: `LM_PAYMENTS_FAKE=1` adds a "Test provider" and a "Test bank file" that
  pay nobody. Never set it on the server people are paid from.
- `LM_PAYMENTS_JOB=0` turns off the 5-minute check of payments on their way (Check now still works).
- The app secret (`server/data/app-secret` or `LM_APP_SECRET`) now also protects bank details and payment keys: back it
  up with the database, as before. If it is lost, bank details cannot be read: everyone re-enters them, and
  connections must be connected again.
