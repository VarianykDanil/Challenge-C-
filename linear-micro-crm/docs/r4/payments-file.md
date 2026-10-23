# Release 1.4 — package P: bank payment file

The `bank_file` way to pay is built. Linear Hub makes the bulk payment file in the format Matt chose. He uploads it
to his online banking and approves it there, then marks in Linear Hub who the bank paid. Nothing is paid from Linear
Hub and nothing comes back from the bank by itself.

There are three formats:
- the **general Faster Payments file**, for any UK bank not listed;
- **Starling Bank** Bulk Payments;
- **Revolut Business** bulk transfer.

The other bank templates the plan named could not be checked against the bank's own published template, so they
are left out (see Owner notes). Built on package F's contract (`docs/r4/payments-foundation.md`).

## API

No new endpoints. Package F's routes now work for a bank file connection, where they used to answer 501. All of them
are for administrators only: 401 signed out, 403 for leaders, recruiters and reps, and 403 `clientPortalOnly` for
client accounts.

| Method | Path | What changes in 1.4 (P) |
| --- | --- | --- |
| GET | `/payments/providers` | `bank_file` has `available: true`. Its one form field `format` (a select, required) now has three options, `generic`, `starling` and `revolut`. Each option has `label`, `iconKey` (`bank`, `starling` or `revolut`) and `hint`. Its abilities gain `anyUkBank: true` |
| POST / PATCH | `/payments/connections` | For `provider: 'bank_file'`, `settings.format` must be one of the three (400 `details: [{ path: 'format' }]` otherwise). Any secrets sent are dropped: nothing secret is stored for a file. The connection is `mode: 'live'` and `status: 'connected'` from the start. Changing the format keeps it connected |
| POST | `/payments/connections/:id/test` | For a bank file: `ok: true`, with a message saying which files it makes and that there is nothing to connect to |
| POST | `/payments/batches/:id/approve` | Bank file: after the fresh two-step code, makes the file (stored encrypted). Each person in the file is `submitted`, and their `providerRef` is the reference written in the file. A person the bank would refuse is `failed` with the reason and is left out of the file. If nobody can go in it, no file is made and the payment is `failed` |
| GET | `/payments/batches/:id/file` | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="linear-hub-payment-<id>-<YYYY-MM-DD>-<faster-payments\|starling\|revolut>.csv"`, `Cache-Control: no-store`. Recorded in the audit trail as an export. 404 before approval, after a cancel, or when no file was made |
| POST | `/payments/batches/:id/mark-paid` | Unchanged (F): `{}` marks everyone still in the file paid; `{ paid: [itemIds], failed: [itemIds], reason? }` marks some paid and the rest failed with the reason (default "The bank did not pay this one") |
| POST | `/payments/batches/:id/refresh` | Bank file: 409 "A bank file is not checked automatically: mark it paid once your bank has paid it." |

Additive types (all optional):
- `PaymentConfigField.options[]` gains `iconKey?` and `hint?`.
- `PaymentAbilities` gains `anyUkBank?`.
- `AbilityLine.key` gains `'anyUkBank'`.

The new shared module `shared/src/logic/bankFiles.ts` holds `BANK_FILE_FORMATS`, `bankFileFormat`, `buildBankFile`,
`bankReference`, `bankPayeeName`, `bankAmount` and `bankFileName`.

## Logic

### 17.6 The bank payment file (`shared/src/logic/bankFiles.ts`; adapter `server/src/lib/payments/bankFile.ts`)

**Formats.** Each format records its columns in order, its header row, the longest name and reference it takes, its
limits per payment and per file, and the bank pages its layout comes from. The source URLs are kept in a code
comment next to each format.

| Format | Columns, in order (header row first) | Name | Reference | Limits | Source |
| --- | --- | --- | --- | --- | --- |
| `generic` | Payee name, Sort code, Account number, Amount, Reference | up to 70 | 18 | none set | No bank publishes this exact layout. It holds the five things every UK bulk upload asks for. Check it with your bank |
| `starling` | Payee Sort Code, Payee Account Number, Payee Name, Payment Reference, Amount | up to 255 | 18 | at most £250,000 in one payment | help.starlingbank.com: "What details do I need to provide in the payments file to make a bulk payment?", "How do I make bulk payments?", "What is the maximum total value a bulk payment can be?" |
| `revolut` | Name, Recipient type (`INDIVIDUAL`), Account number, Sort code, Recipient bank country (`GB`), Currency (`GBP`), Amount, Payment reference | up to 80, first and last name | 18 (Revolut takes up to 100; Faster Payments carry 18) | 1,000 payments per file | developer.revolut.com "Create a file payment"; help.revolut.com "What are bulk payments?" |

**Every cell.** The same rules apply to every format:
- **Sort code:** 6 digits, no dashes.
- **Account number:** 8 digits.
- **Amount:** pounds with two decimals, made from whole pence by integer arithmetic, with no £ and no thousands
  separator (945.50).
- **Reference:** upper case. Only A–Z, 0–9, space, full stop, slash and hyphen, which every UK bank takes. It starts
  with a letter or digit and is cut to 18 characters without a trailing space. The default is F's
  `defaultPaymentReference`, "LINEAR 05OCT JL". If nothing is left after cleaning, it is "LINEAR".
- **Payee name:** the account holder's name from their bank details. Accents are folded and other alphabets are
  spelled in Latin letters. "&" becomes "and". Only letters, digits, spaces, full stops and hyphens are kept, so an
  apostrophe is dropped ("O'Neill" becomes "ONeill"). It starts with a letter or digit and is cut to the format's
  limit.
- **File:** CRLF line ends, a final CRLF and UTF-8 without a byte-order mark. No cell ever needs quotes.

**Formula guard.** No cell can start with `=`, `+`, `-`, `@`, a tab or a carriage return, for three reasons:
- those characters are not in the name or reference character sets;
- every cell starts with a letter or digit;
- every cell also goes through the shared CSV guard (`payExportCell`).

Tested with the classic payloads, including full-width "＝" and the minus sign "−", in every format and end to end
through the route.

**Lines a bank would refuse.** These are left out of the file. The payment line fails with a plain reason, so the
person's run is set to `failed` with that reason on Runs to pay. A line is refused when:
- the name has no letters a bank accepts;
- the format is Revolut and the name is a single word (Revolut needs a first and last name for an individual);
- the sort code or account number is the wrong shape;
- the amount is £0 or less, or over the format's limit;
- the file already has the format's maximum number of lines.

No reason ever contains an account number.

**The adapter.** On approval, `submit` builds the file and answers:
- `submitted` for each included line, with the reference as `providerRef`;
- `failed` with the reason for each refused line.

Package F stores the file encrypted and serves it from GET …/file. `submit` moves no money, and making the file
again from the same items gives the same bytes. `testConnection` answers ok. `refresh` is never called for a file.

## User guide

### Paying people with a bank payment file (administrators)

1. **Settings → Payments → Bank payment file → Connect.** Under **File format**, choose your bank: **Starling Bank
   bulk payments**, **Revolut Business bulk transfer**, or the **General Faster Payments file** if your bank is not
   listed. Each choice shows the bank's logo. Then **Save connection**. There is nothing to test: a file connects to
   nothing.
2. **Finance → Pay people.** Choose the weeks, choose the bank file connection, check the people and amounts, type
   the code from your authenticator app and press **Approve and make the bank file**.
3. On the payment page, **Download the bank file**. The page says where to upload it. For Starling: Payments → Bulk
   Payments → New bulk payment. For Revolut: Payments → Transfers → Bulk, in the web app. Each line shows the
   reference written in the file, so you can find it on your bank statement.
4. Upload the file in your online banking, check the names and approve it there.
5. Back in Linear Hub, use **Mark as paid**. Everyone is ticked. Untick anyone the bank rejected and say why: their
   week stays on Runs to pay with your reason, and you can pay it again in a new payment. The rest are marked paid,
   exactly as **Mark paid** on Runs to pay would.

Someone the bank would refuse is left out of the file, with the reason on the payment page and on Runs to pay. For
example, Revolut needs a first and last name. Fix their bank details, then pay that week again.

Upload the file as it is. If you open the file in Excel and save it again, Excel can drop the zeros at the start of
sort codes and account numbers.

## Changelog

- **Added:** Pay people by bank payment file. Linear Hub makes a bulk payment file for Starling Bank, Revolut
  Business, or a general Faster Payments file for any other UK bank. Upload it to your online banking, approve it
  there, then mark in Linear Hub who was paid.
- **Added:** A format picker with each bank's logo in Settings → Payments, and on each bank file payment, where to
  upload the file and each person's reference.
- **Added:** Bank file references are at most 18 characters ("LINEAR 05OCT JL") and use only characters every UK
  bank takes. Names are folded to plain letters. No cell can be run as a spreadsheet formula.
- **Added:** A person the bank would refuse is left out of the file, with a plain reason, and their week stays on
  Runs to pay.

## Owner notes

- **What was checked, and how.** The build machine could not open the banks' pages directly: they were blocked. Each
  layout was read through web searches of the bank's own pages on 23 Oct 2026. Nothing was checked by uploading a
  real file, because there is no bank account to test with.
  - **Starling:** the order of the columns, the 18-character reference, the 255-character name, numbers-only amounts,
    the header row and the £250,000 limit per payment come from Starling's help pages. **The exact words of
    Starling's header row could not be seen**, because the template is behind sign-in. Linear Hub uses the help
    page's names for the fields.
  - **Revolut:** the header row and field rules come from Revolut's developer documentation for its CSV payment file,
    and the 1,000-line limit from Revolut's help page. Revolut's web-app template changes with the country and
    currency, and this is its UK, pounds layout. A third-party guide says Revolut may want each new payee paid once
    by hand before they can be in a bulk transfer. Check this on your first file.
  - **Before relying on either:** make a payment for one person first, upload it and check it. If the bank refuses
    the file, compare the file's first line with the bank's own template and tell us what it says.
- **Use the general file, and check it with your bank, for:**
  - **Wise.** The bank-detail columns of its batch template are made by a template builder behind sign-in. Package A
    adds Wise through its API instead.
  - **Monzo Business.** Monzo publishes the column order, but not the values its "Bank account type" column takes.
    Linear Hub also does not know whether each person's account is personal or business.
  - **NatWest / RBS Bankline, Barclays, HSBC, Lloyds and Santander.** Their import specifications are PDFs or pages
    behind sign-in that could not be read. Bankline and HSBC use long, field-coded layouts that are not safe to guess.
- **Costs and limits from the banks, as found on 23 Oct 2026.** Check them yourself:
  - Starling Bulk Payments costs £7 a month after a free first month, and allows 250 payments a month.
  - Revolut takes files of up to 1,000 payments, uploaded on the web only.
- **Names in the file** are the account holder's name from each person's bank details, in plain letters. An
  apostrophe is dropped and "&" becomes "and". Your bank's name check (Confirmation of Payee) should still match. If
  it flags someone, check their bank details with them.
- **Nothing secret** is stored for a bank file connection. The file itself holds full account numbers. It is stored
  encrypted, downloaded only by an administrator, never cached, and every download is in the audit trail. Delete
  downloaded files from your computer once your bank has paid them.
- **Files outside P's own new files that P changed** (small, additive changes):
  - `shared/src/logic/index.ts` (export), `shared/src/types/payments.ts` (option `iconKey` and `hint`, `anyUkBank`),
    and `shared/src/logic/payments.ts` (bank file abilities corrected, the "Works with any UK business bank" line);
  - `server/src/lib/payments/registry.ts` (the adapter in place of the stub) and `server/src/lib/payments/stubs.ts`
    (the bank file form comes from the adapter);
  - `server/src/test/payments.test.ts`: the bank file is available now, and the 501 test uses Wise;
  - `shared/src/logic/payments.test.ts` (the seventh checklist line);
  - `client/src/features/payments/PaymentsSettingsSection.tsx` (format picker, format line on a connection, format
    logos on the card), `client/src/features/payments/ProviderLogo.tsx` (`EXAMPLE_BANKS` removed),
    `client/src/features/payments/index.tsx` ("File ready" also when someone was left out), and
    `client/src/pages/PaymentBatch.tsx` (upload help, the reference on each line).
- **For merging with A:** A changes the same two F tests and `registry.ts` for the other three providers. Keep both
  edits.
