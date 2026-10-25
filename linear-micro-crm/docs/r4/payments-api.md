# Release 1.4 — package A: paying through Revolut Business, Wise Business and TrueLayer

Package A builds the three API ways to pay on package F's contract (`server/src/lib/payments/provider.ts`):
**Revolut Business** pays each person from Linear Hub, **Wise Business** creates each transfer and Matt pays it in
Wise, **Open Banking via TrueLayer** pays out from a TrueLayer merchant account. Each was built from the provider's
current official documentation (read 23 Oct 2026 and the key points checked again on 25 Oct 2026; the URLs are in
the header of each adapter file). Every
connection starts in the provider's sandbox (test mode). Nothing in the test suite calls the internet: each adapter is
tested against a local fake server that follows the documented request, answer and error shapes.

## API

No new endpoints. The `/payments/*` endpoints from package F (docs/r4/payments-foundation.md) now work for `revolut`,
`wise` and `truelayer`:

- `GET /payments/providers`: the three answer `available: true`. Their `abilities` are corrected from each provider's
  documentation, and `configFields` are each provider's real connection form. Two new optional fields on
  `PaymentProviderInfo` / `PaymentProviderView` (additive):
  - `connectSteps?: string[]`: how to connect, in order, including the steps done outside Linear Hub;
  - `liveNote?: string`: what switching to live needs (live has its own keys);
  - `approveNote?: string`: what approving does not do yet (Wise: "Nobody is paid until you open Wise and pay the
    transfers there."), shown on the payment's Approve card;
  - `waitingNote?: string`: what happens while payments are on their way, and what Matt does in the provider's app
    meanwhile (Wise: pay the transfers; Revolut: approve them there if his account needs an approver), shown on the
    payment page while anything is on its way.

  And one on `PaymentConfigField`: `requiredUnless?: string`, a field needed unless the connection already holds that
  secret. Revolut's `authCode` has `requiredUnless: 'refreshToken'`, so the form marks the code required until Linear
  Hub holds Revolut's sign-in (the adapter's own check is the rule).
- `POST /payments/connections/:id/test` now reaches the provider (in its sandbox, or live when switched). It answers
  `ok: false` with a plain message rather than an error status when the provider refuses the details.
- `POST /payments/batches/:id/approve`, `/refresh` and `/cancel` send to, check with, and (Wise only) cancel at the
  provider.
- A payment whose provider did not answer keeps those items `queued`. The reason shows as the batch's `lastError`
  (e.g. "TrueLayer did not answer within 15 seconds"), and the next check sends them again with the same idempotency
  keys.

Connection forms (settings are stored as JSON, secrets are encrypted and never returned):

| Provider | Settings | Secrets |
| --- | --- | --- |
| `revolut` | `clientId`, `redirectUri` (the OAuth redirect URI typed in Revolut), `accountId` (optional: the GBP account) | `privateKey` (RSA, PEM), `authCode` (the code from Revolut; the whole redirect address is accepted), then `refreshToken` (kept by Linear Hub itself) |
| `wise` | `profileId` (optional, digits) | `apiToken` (a personal API token) |
| `truelayer` | `clientId`, `signingKeyId`, `merchantAccountId` (optional) | `clientSecret`, `privateKey` (EC P-521, PEM) |

The form checks run without a network call. A Revolut key must be RSA, and the redirect URI must be an address. A
Revolut connection needs a code, or a refresh token Linear Hub already holds. A TrueLayer key must be EC P-521 (ES512).
A Wise profile ID must be digits.

## Logic

**Shared rules (all three).** These live in `server/src/lib/payments/apiCommon.ts`:
- **Idempotency.** Each payment's idempotency id is a name-based UUID (version 5) of Linear Hub's per-item key, so the
  same item always sends the same id: Revolut `request_id`, Wise `customerTransactionId`, TrueLayer `Idempotency-Key`.
- **Retries.** Requests go through F's `providerFetch` (15-second timeout). A money-moving POST is retried only
  because it carries that id.
- **Amounts.** They stay exact. Revolut and Wise take pounds as a decimal (6350p → 63.5). TrueLayer takes pence
  (`amount_in_minor`).
- **When a provider does not answer.** If a call times out, or the provider answers 429, 5xx or 409, `submit` stops.
  It returns what it knows and says why in `SubmitResult.error`. The rest stay queued and go again with the same
  ids. A refusal of one person (4xx) fails only that item, with the provider's words, and never shows the full
  account number. A refused sign-in (401) stops the whole submit.
- **Tests.** Under `node --test`, an adapter refuses any host but 127.0.0.1 or localhost, so a test can never call a
  real provider.

**Revolut Business** (`revolut.ts`).
- **Hosts.** Sandbox `https://sandbox-b2b.revolut.com/api/1.0`, live `https://b2b.revolut.com/api/1.0`.
- **Signing in.**
  - The first test swaps the pasted code at `POST /auth/token` (grant `authorization_code`). It signs in with a
    client-assertion JWT, RS256, signed with the private key: iss = the redirect URI's domain, sub = the client ID,
    aud = `https://revolut.com`, exp 5 minutes.
  - The refresh token is stored encrypted through `ProviderContext.saveSecrets`, and the used code is removed.
  - Access tokens (40 minutes) are kept in memory and refreshed with less than a minute left. A 401 refreshes once
    and tries again.
  - Revolut refusing the refresh token ("invalid_grant") asks Matt to choose Enable access again in Revolut.
- **Paying.**
  1. The GBP account (`GET /accounts`; the only active GBP one, or the chosen `accountId`).
  2. One counterparty per person, reused: `GET /counterparties?account_no=&sort_code=`, else `POST /counterparty` as a
     UK individual (first names and last name split from the holder name).
  3. `POST /pay` with `request_id`.
- **A repeat.** Revolut refuses a repeated `request_id` (400, code 3020). Linear Hub then finds the first payment with
  `GET /transactions?request_id=&from=` (at most 14 days), so it never makes a second one.
- **After two weeks.** Revolut only spots repeats for 2 weeks. A payment approved more than 13 days ago is never sent
  again blind: Linear Hub looks it up, and if Revolut has no such payment, the item fails with a plain reason.
- **Statuses.** `completed` → paid; `declined`, `failed`, `reverted` → failed with the reason code in words; `created`,
  `pending` → processing.

**Wise Business** (`wise.ts`).
- **Hosts.** Sandbox `https://api.wise-sandbox.com` (Wise's sandbox V2; the old `api.sandbox.transferwise.tech` was
  deprecated on 30 June 2026), live `https://api.wise.com`. Wise added dated API versions (2026Q3, 2026Q4) this year.
  They are opt-in, and the endpoint-based versions used here remain available (Wise changelog).
- **Sign-in.** A personal API token. Wise's documentation says a personal token **cannot fund transfers** for UK and
  EEA profiles (PSD2). So Linear Hub creates each transfer, and Matt pays it in Wise. Linear Hub never calls the
  funding endpoint (a test checks it).
- **Paying.**
  1. The business profile (`GET /v2/profiles`).
  2. A recipient: `POST /v1/accounts`, GBP, `sort_code`, legal type PRIVATE.
  3. A quote: `POST /v3/profiles/{id}/quotes`, GBP → GBP, `targetAmount`, `targetAccount`.
  4. The transfer: `POST /v1/transfers` with `customerTransactionId`. A repeat answers the first transfer.
- **Statuses** (`GET /v1/transfers/{id}`).
  - `outgoing_payment_sent` → paid.
  - `cancelled` (not paid in time, or cancelled in Wise), `funds_refunded`, `charged_back` → failed with plain words.
  - `incoming_payment_waiting` (waiting for Matt to pay it in Wise), `processing`, `funds_converted`, `bounced_back`
    and the rest → processing.
- **Cancel.** `PUT /v1/transfers/{id}/cancel` stops a transfer not yet paid in Wise, so the week goes back to Runs to
  pay. A transfer already on its way stays as it is. Review fix: Linear Hub can only stop a transfer it has Wise's id
  for. While a transfer call timed out and Linear Hub does not know yet whether Wise made it, Cancel answers 409
  ("Linear Hub is still finding out whether Wise Business made the transfer for …: press Check now, then cancel") and
  changes nothing; Check now finds the transfer (the same `customerTransactionId`), and Cancel then stops it. A cancel
  that stops nothing (Wise is already paying them) is not recorded as cancelled, and the page says so.
- **Payment approvals.** Wise refuses transfers made with a personal token while approvals are switched on ("missing
  approval"). Linear Hub fails the item with plain words.

**TrueLayer** (`truelayer.ts`).
- **Hosts.** Auth `https://auth.truelayer(-sandbox).com`, API `https://api.truelayer(-sandbox).com`, from TrueLayer's
  own library.
- **Sign-in.** A client-credentials token (scope `payments`; JSON body, as TrueLayer's library sends it), kept in
  memory.
- **Signing.** Every payout is signed (request signing v2): a `Tl-Signature` detached JWS, ES512, with header
  `{alg, kid, tl_version: "2", tl_headers: "Idempotency-Key"}`. It is signed over
  `POST /v3/payouts\nIdempotency-Key: …\n<body>`, using node:crypto (P-521, IEEE P1363).
- **Testing.** In test mode, the connection test also checks the signature at the sandbox's `POST /test-signature`.
- **Paying.**
  - The GBP merchant account (`GET /v3/merchant-accounts`).
  - `POST /v3/payouts` to an `external_account` beneficiary (holder name, sort code and account number, reference).
  - The same key and body answer the first payout. The same key with a different body (422 "Idempotency-Key Reuse")
    stays queued with a plain error to check the Console.
- **Statuses** (`GET /v3/payouts/{id}`). `executed` → paid; `failed` → failed (insufficient_funds, blocked,
  invalid_scan, invalid_iban, returned and scheme_error in plain words); `pending`, `authorized` → processing.

**Contract additions** (additive, in F's files):
- `ProviderContext.saveSecrets(patch)`: merges into the ONE encrypted secrets blob; null removes a key. Implemented in
  `connections.ts` (`providerContext(db, connectionId)`, `saveConnectionSecrets`).
- `ProviderBatch.approvedAt`.
- `SubmitResult.error`: stored as the batch's `lastError`, redacted.
- `PaymentProviderInfo.approveNote` / `waitingNote` and `PaymentConfigField.requiredUnless` (shared types).

**The payment page** (`client/src/pages/PaymentBatch.tsx`) reads the provider's abilities. When the provider does not
pay from Linear Hub (`paysFromApp: false`, i.e. Wise), a live Approve card says "Wise Business gets transfers for 4
people (£996.00) when you approve. Nobody is paid until you open Wise and pay the transfers there.", and its button is
**Approve and create the transfers (£996.00)** instead of "Approve and pay". While anything is on its way, the
provider's `waitingNote` shows above the list.

## User guide

**Settings → Payments** (administrators). Each of the three cards says plainly what it can and cannot do:
- **Revolut:** pays from Linear Hub and confirms automatically.
- **Wise:** you pay each transfer in Wise; Linear Hub cannot show your balance.
- **TrueLayer:** pays from your TrueLayer merchant account, which you top up from your bank.

**Connect** opens the form. It starts with **How to connect**: the steps in order, including the ones done outside
Linear Hub (in Revolut, Wise or the TrueLayer Console, or on a computer). Every field has "where to find this" help.
**Save and test** saves the connection and tests it straight away, in the provider's sandbox.

- **Revolut Business:**
  1. On a computer, make a key pair and add an API certificate in Revolut Business (Settings → APIs → Business API),
     with any website address as the OAuth redirect URI.
  2. Copy the client ID, the redirect URI and the private key into the form.
  3. In Revolut, choose **Enable access** and allow it. Revolut opens your redirect address with a code in it. Copy
     that whole address into **Code from Revolut** and press Save and test straight away: the code works for 2 minutes.
- **Wise Business:**
  1. Make a personal API token in Wise (Your account → Connect and manage apps → API tokens) and paste it.
  2. After you approve a payment in Linear Hub, **open Wise and pay the transfers it made**. Each week is marked paid
     when Wise has sent the money.
  3. If you do not pay a transfer in Wise in time, Wise cancels it and the week goes back to Runs to pay. **Cancel**
     on the payment's page stops transfers you have not paid yet.
- **TrueLayer:**
  1. Ask TrueLayer to switch on payouts and open a GBP merchant account, then top it up.
  2. Make a signing key with the openssl commands shown under **Signing key ID**, and upload the public key in the
     TrueLayer Console (Payments → Settings).
  3. Paste the client ID, client secret, key ID and private key.

**Paying through Wise.** On the payment page the button says **Approve and create the transfers**, and the card says
nobody is paid until you pay them in Wise. After approving, the page says: "Now open Wise and pay the transfers Linear
Hub made: they wait there until you do, and Wise cancels any that are not paid in time." Revolut's and TrueLayer's
payment pages say what happens while payments are on their way (Revolut: approve them in Revolut too if your account
needs an approver; TrueLayer: top up the merchant account if a payout fails for lack of money).

**Switch to live** (type PAY FOR REAL) says what live needs. Your sandbox details do not work live, so choose **Edit**,
enter your live details (for Revolut, a new code too), then **Test**.

If a provider does not answer while you pay, the payment says why. Linear Hub sends the rest at the next check, or when
you press Check now, to the account each payment was approved with and with the same references, so the provider does
not make them twice. **Cancel the rest** waits until Linear Hub knows whether the provider made them: press **Check
now** first if it asks you to.

## Changelog

- Pay people through **Revolut Business**: Linear Hub sends each payment from your GBP account and marks the week paid
  when Revolut completes it.
- Pay people through **Wise Business**: Linear Hub creates the transfers; you pay them in Wise (Wise does not let an API
  token pay them for UK businesses), and Linear Hub marks each week paid once Wise has sent the money. Transfers not
  yet paid can be cancelled from Linear Hub.
- Pay people through **Open Banking (TrueLayer)**: signed payouts from your TrueLayer merchant account.
- All three start in the provider's sandbox. Each payment carries the provider's idempotency key, so a payment sent
  again after a timeout is never paid twice.
- Settings → Payments: each Connect form begins with **How to connect**, including the steps done in the provider's app
  or on a computer. Saving an API connection tests it straight away (**Save and test**). Switch to live says what live
  needs.
- The payment page says what each provider still needs from you: for Wise the button is **Approve and create the
  transfers** and the page reminds you to pay them in Wise; Revolut and TrueLayer say what happens while payments are
  on their way.

## Owner notes

What Matt must set up, decide or know:

- **Everything starts in test mode, and live needs its own details.** Each provider's sandbox needs its own account and
  credentials:
  - Revolut: sandbox-business.revolut.com, with its own certificate.
  - Wise: a sandbox account at wise-sandbox.com, with its own token.
  - TrueLayer: the sandbox app in the Console.

  After **Switch to live**, choose **Edit** and enter the live details, then **Test**. Try a payment of a few pounds to
  yourself before paying the team.
- **Revolut Business.**
  - The Business API needs a plan that includes it. A Revolut guide page described it as Grow, Scale and Enterprise;
    check your plan.
  - The certificate is made on a computer (openssl) and uploaded in Revolut Business, Settings → APIs → Business API.
    The OAuth redirect URI can be any website address you control: Linear Hub never receives the redirect, you copy
    the address from the browser.
  - **Enable access** is done in Revolut, and the code it gives works once, for 2 minutes. If Revolut later stops
    accepting Linear Hub ("Enable access again"), repeat that step and paste the new code.
  - Revolut's documentation disagrees with itself on whether the refresh token expires (one page says it does not;
    third-party guides mention 90 days). Linear Hub says so plainly when it happens.
  - If your Revolut account makes payments wait for an approver, they wait in Revolut and show as processing.
  - Linear Hub does not use Confirmation of Payee. In the UK, Revolut needs you to ask API Support to switch it on.
- **Wise Business.**
  - With a personal token, Wise does not let Linear Hub pay (fund) the transfers for a UK business. After approving in
    Linear Hub, you pay each transfer in Wise. Until you do, the week shows as processing. Not paying one in time
    means Wise cancels it, and it goes back to Runs to pay.
  - **If your Wise account has payment approvals switched on, Wise refuses transfers made with a token.** Turn approvals
    off for these payments, or use another way to pay.
  - Every payment creates a recipient in Wise, so a person can appear more than once under Recipients.
  - Wise moved to dated API versions (2026Q3, 2026Q4) this year. The endpoint-based ones Linear Hub uses remain
    available, but a later release should move to a dated version.
  - Wise's own guide offers OAuth "partner" access (with funding) to larger partners. That is not built.
- **TrueLayer.**
  - TrueLayer has to approve your business and switch on payouts. Payouts come out of your **merchant account**, so top
    it up from your bank first (the test shows the available balance).
  - Fees are per payout: check your agreement.
  - TrueLayer asks non-regulated businesses for each person's date of birth and address for sanctions screening. The
    API accepts payouts without them, and Linear Hub does not send them. If TrueLayer refuses payouts for that reason,
    it shows in the payout's reason, and sending them would be a later change and a data-sharing decision for you.
  - The signing key is checked by the sandbox's test endpoint. Live has no documented test endpoint, so a live
    signature is checked by the first payout.
- **Paid means the provider says the money left.** A payment the receiving bank returns later (Wise "bounced back"
  after "sent", TrueLayer "returned" after "executed") is not undone in Linear Hub: the week stays paid. Sort it out by
  hand with an adjustment line on a later week. The provider emails or shows it.
- **Very long outages.** If a provider stays unreachable for a long time while a payment is being sent:
  - Revolut: Linear Hub stops resending after 13 days, because Revolut only spots repeats for 2 weeks.
  - TrueLayer and Wise: their documentation does not say how long a repeat is recognised. Check the provider's own
    list before paying that week another way.
- **Not verified against the real services.** Everything was built from the documentation and tested against local
  fakes of it. No real sandbox call was made from here: the build machine's network refuses the providers' sites
  (developer.revolut.com, docs.wise.com, docs.truelayer.com and their APIs). The docs were read through web search and
  the providers' official GitHub files (Revolut's OpenAPI file, TrueLayer's signing and PHP libraries). On 25 Oct 2026
  these points were checked again: Revolut's hosts, `request_id` (at most 40 characters, repeats spotted for 2 weeks,
  code 3020), `GET /transactions?request_id=` needing `from` within 14 days, the client assertion (iss = the redirect
  domain, aud `https://revolut.com`), 40-minute tokens and the 2-minute code; Wise's sandbox V2 host
  (`api.wise-sandbox.com`; the old `api.sandbox.transferwise.tech` was retired on 30 June 2026) and that a personal
  token cannot fund transfers for UK businesses; TrueLayer's `external_account` payout shape and its statuses.
  - A sandbox run with your own credentials is the first real check.
  - The least certain points: the exact Revolut consent step and whether the code shows in the redirect address as
    `?code=`; Wise token permission names ("full access"); TrueLayer's production signature behaviour.
- **Files outside package A that changed (small and additive):**
  - `server/src/lib/payments/provider.ts`: `saveSecrets`, `approvedAt`, `SubmitResult.error`.
  - `server/src/lib/payments/connections.ts`: `providerContext(db, id)`, `saveConnectionSecrets`.
  - `server/src/lib/payments/batches.ts`: passes those, and stores `out.error`.
  - `server/src/lib/payments/registry.ts`: the three adapters.
  - `shared/src/types/payments.ts`: `connectSteps`, `liveNote`.
  - `shared/src/logic/payments.ts`: the three providers' abilities.
  - `client/src/features/payments/PaymentsSettingsSection.tsx`: How to connect, Save and test, live note, a field
    required until a secret is held (`requiredUnless`).
  - `client/src/pages/PaymentBatch.tsx`: the Approve card and button for a provider that does not pay from Linear Hub
    (Wise), and the provider's note while payments are on their way.
  - `server/src/test/payments.test.ts`: F's three tests that assumed the stubs.
