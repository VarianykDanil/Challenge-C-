/**
 * Release 1.4 — OWNED BY P bank payment file: the bulk payment files Linear Hub makes for Matt to upload to his online
 * banking (the `bank_file` way to pay; server/src/lib/payments/bankFile.ts is the adapter). Pure: no I/O.
 *
 * The formats, and where each layout comes from (looked up on 23 Oct 2026; the bank pages themselves could not be
 * downloaded from the build machine, so each was read through a web search of the bank's own page):
 *
 *  - 'generic' — a general Faster Payments file: payee name, sort code, account number, amount, reference, with a
 *    header row. No bank publishes this exact layout: it is the five things every UK bank's bulk upload asks for, for
 *    a bank whose own template is not below. Check the columns with your bank before the first upload.
 *  - 'starling' — Starling Bank Bulk Payments. Columns, order, header row, sort code 6 digits, account number 8 digits,
 *    payee name (a person's name OR a business name, at most 255 characters), payment reference (at most 18
 *    characters), amount in GBP with numbers and a decimal point only (no £):
 *      https://help.starlingbank.com/business/topics/making-a-bulk-payment/what-details-do-i-need-to-provide-in-the-payments-file-to-make-a-bulk-payment/
 *    Uploading (.csv, .ods or .xlsx; Payments → Bulk Payments → New bulk payment):
 *      https://help.starlingbank.com/business/topics/bulk-payments/how-do-i-make-bulk-payments/
 *    At most £250,000 in one payment of a bulk file:
 *      https://help.starlingbank.com/business/topics/making-a-bulk-payment/what-is-the-maximum-total-value-a-bulk-payment-can-be/
 *    NOT verified: the exact words of the header row in Starling's downloadable template (it is behind sign-in). The
 *    help page says the columns must stay in the template's order with the header included; the header here uses the
 *    help page's names for the fields. If Starling refuses the file, compare its first row with Starling's template.
 *  - 'revolut' — Revolut Business bulk transfer CSV, as Revolut documents its CSV payment file: the header row
 *    "Name,Recipient type,Account number,Sort code,Recipient bank country,Currency,Amount,Payment reference"; Name at
 *    most 80 characters and, for an INDIVIDUAL, a first and a last name separated by a space; Recipient type
 *    INDIVIDUAL or COMPANY; sort code for UK local transfers; a dot as the decimal separator:
 *      https://developer.revolut.com/docs/guides/build-banking-apps/tutorials/create-a-file-payment
 *    CSV files of at most 1,000 payments, uploaded in the Revolut Business web app (Payments → Transfers → Bulk):
 *      https://help.revolut.com/business/help/receiving-payments/sending-money-to-an-external-bank-account/what-are-bulk-payments/
 *    Revolut's web app template varies with the destination country and currency; this is the UK, GBP layout from the
 *    documentation above. If Revolut refuses the file, compare it with the template in the web app.
 *
 * Left out because their layout could not be checked against the bank's own published template: Wise (batch payment
 * template: its bank-detail columns are made by a template builder behind sign-in), Monzo Business (the column order
 * is published, but not the values of its "Bank account type" column — and Linear Hub does not know whether each
 * person's account is personal or business), NatWest / RBS Bankline, Barclays, HSBC, Lloyds and Santander (their
 * import specifications are PDFs or pages behind sign-in that could not be read). Use the general file and check it
 * with your bank (docs/OWNER_NOTES_1.4.md, "What was tested, and what was not").
 *
 * Every format: one payment per line, CRLF line ends, UTF-8 without a byte-order mark, a header row, sort codes as 6
 * digits and account numbers as 8, amounts in pounds with two decimals from whole pence (exact: no floating point),
 * references of at most 18 characters (Faster Payments carry 18) in upper case A–Z, 0–9, space, full stop, slash and
 * hyphen (what every UK bank takes), and names folded to plain letters (accents off) with only letters, digits,
 * spaces, full stops and hyphens ("&" becomes "and"). Nothing a spreadsheet would run as a formula can reach a cell:
 * those characters are not in the sets above, a cell starts with a letter or a digit, and every cell goes through the
 * CSV guard (payExportCell) as well. A line a bank would refuse is left out of the file with a plain reason.
 */
import { payExportCell } from './payExport.ts';
import { PAYMENT_REFERENCE_MAX, formatPence, normaliseAccountNumber, normaliseSortCode } from './payments.ts';
import { asciiFold } from './textFold.ts';

export type BankFileFormatId = 'generic' | 'starling' | 'revolut';
export const BANK_FILE_FORMAT_IDS: readonly BankFileFormatId[] = ['generic', 'starling', 'revolut'];

/** The cells of one line, before the guard. */
interface BankFileCells {
  name: string;
  sortCode: string;
  accountNumber: string;
  amount: string;
  reference: string;
}

export interface BankFileFormat {
  id: BankFileFormatId;
  /** The format picker's label: "Starling Bank bulk payments (CSV)". */
  label: string;
  /** The bank whose template it is (null: the general file). */
  bank: string | null;
  /** The client's logo key (features/payments/ProviderLogo). */
  iconKey: string;
  /** One sentence for the picker. */
  summary: string;
  /** Where to upload it, in the bank's own words. */
  uploadSteps: string;
  /** The header row, in order. */
  headers: readonly string[];
  /** Longest payee name the bank takes. */
  nameMax: number;
  /** Longest reference (never more than PAYMENT_REFERENCE_MAX). */
  referenceMax: number;
  /** Most one payment of the file may be (pence), when the bank says. */
  maxAmountPence: number | null;
  /** Most payments in one file, when the bank says. */
  maxRows: number | null;
  /** The bank needs a first and a last name for a person. */
  needsFirstAndLastName: boolean;
  /** The bank's own pages the layout comes from. */
  sources: readonly string[];
  /** What could not be checked, said plainly (null: nothing). */
  checkFirst: string | null;
  /** "faster-payments", "starling", "revolut": the end of the file name. */
  fileSuffix: string;
  /** The cells of one line, in header order. */
  line(c: BankFileCells): string[];
}

export const BANK_FILE_FORMATS: readonly BankFileFormat[] = [
  {
    id: 'generic',
    label: 'General Faster Payments file (CSV)',
    bank: null,
    iconKey: 'bank',
    summary: 'Payee name, sort code, account number, amount and reference: for any UK bank not listed here. Check the columns with your bank before the first upload.',
    uploadSteps: 'In your online banking, find the bulk payment (or payment file) upload and choose this file. Check that the columns match what your bank asks for.',
    headers: ['Payee name', 'Sort code', 'Account number', 'Amount', 'Reference'],
    nameMax: 70,
    referenceMax: PAYMENT_REFERENCE_MAX,
    maxAmountPence: null,
    maxRows: null,
    needsFirstAndLastName: false,
    sources: [],
    checkFirst: 'This is not a bank’s own template: check with your bank which columns its bulk upload takes.',
    fileSuffix: 'faster-payments',
    line: (c) => [c.name, c.sortCode, c.accountNumber, c.amount, c.reference],
  },
  {
    id: 'starling',
    label: 'Starling Bank bulk payments (CSV)',
    bank: 'Starling Bank',
    iconKey: 'starling',
    summary: 'Starling’s Bulk Payments layout: sort code, account number, name, reference (18 characters) and amount.',
    uploadSteps: 'In Starling Online Banking: Payments → Bulk Payments → New bulk payment, then upload this file and check the names before you authorise it.',
    headers: ['Payee Sort Code', 'Payee Account Number', 'Payee Name', 'Payment Reference', 'Amount'],
    nameMax: 255,
    referenceMax: 18,
    maxAmountPence: 25_000_000,
    maxRows: null,
    needsFirstAndLastName: false,
    sources: [
      'https://help.starlingbank.com/business/topics/making-a-bulk-payment/what-details-do-i-need-to-provide-in-the-payments-file-to-make-a-bulk-payment/',
      'https://help.starlingbank.com/business/topics/bulk-payments/how-do-i-make-bulk-payments/',
      'https://help.starlingbank.com/business/topics/making-a-bulk-payment/what-is-the-maximum-total-value-a-bulk-payment-can-be/',
    ],
    checkFirst: 'The words of the header row could not be checked against Starling’s own template: if Starling refuses the file, compare its first line with Starling’s template.',
    fileSuffix: 'starling',
    line: (c) => [c.sortCode, c.accountNumber, c.name, c.reference, c.amount],
  },
  {
    id: 'revolut',
    label: 'Revolut Business bulk transfer (CSV)',
    bank: 'Revolut Business',
    iconKey: 'revolut',
    summary: 'Revolut’s CSV payment file for UK payments in pounds: name, recipient type, account number, sort code, country, currency, amount and reference.',
    uploadSteps: 'In the Revolut Business web app: Payments → Transfers → Bulk, then upload this file (Revolut takes files only on the web, not in the phone app).',
    headers: ['Name', 'Recipient type', 'Account number', 'Sort code', 'Recipient bank country', 'Currency', 'Amount', 'Payment reference'],
    nameMax: 80,
    referenceMax: 18,
    maxAmountPence: null,
    maxRows: 1000,
    needsFirstAndLastName: true,
    sources: [
      'https://developer.revolut.com/docs/guides/build-banking-apps/tutorials/create-a-file-payment',
      'https://help.revolut.com/business/help/receiving-payments/sending-money-to-an-external-bank-account/what-are-bulk-payments/',
    ],
    checkFirst: 'Revolut’s template changes with the country and currency: this is its UK, pounds layout. If Revolut refuses the file, compare it with the template in the web app.',
    fileSuffix: 'revolut',
    line: (c) => [c.name, 'INDIVIDUAL', c.accountNumber, c.sortCode, 'GB', 'GBP', c.amount, c.reference],
  },
];

/** The format with this id (null for anything else). */
export function bankFileFormat(id: unknown): BankFileFormat | null {
  return BANK_FILE_FORMATS.find((f) => f.id === id) ?? null;
}

// ───────────────────────────── cells ─────────────────────────────

/** Whole pence → "945.50" (exact; RangeError for anything that is not a whole number of pence). */
export function bankAmount(pence: number): string {
  if (!Number.isSafeInteger(pence)) throw new RangeError('Pence must be a whole number');
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Cuts to `max` characters without leaving a space at the end. */
const cut = (text: string, max: number) => text.slice(0, Math.max(0, max)).trim();
/** Starts with a letter or a digit (a cell never begins with = + - @ or anything else a spreadsheet runs). */
const fromFirstLetterOrDigit = (text: string) => text.replace(/^[^A-Za-z0-9]+/, '');

/**
 * A reference every UK bank takes: plain letters (accents off), upper case, only A–Z, 0–9, space, "." "/" "-",
 * starting with a letter or a digit, at most `max` (18) characters.
 */
export function bankReference(raw: string, max: number = PAYMENT_REFERENCE_MAX): string {
  const clean = asciiFold(String(raw ?? ''))
    .toUpperCase()
    .replace(/[^A-Z0-9 ./-]+/g, '')
    .replace(/\s+/g, ' ');
  return cut(fromFirstLetterOrDigit(clean.trim()), Math.min(max, PAYMENT_REFERENCE_MAX));
}

/**
 * The payee's name as a bank takes it: plain letters (accents off, other alphabets spelled in Latin letters), "&" as
 * "and", only letters, digits, spaces, "." and "-", starting with a letter or a digit, at most `max` characters.
 * '' when nothing is left.
 */
export function bankPayeeName(raw: string, max: number): string {
  const clean = asciiFold(String(raw ?? ''))
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9 .-]+/g, '')
    .replace(/\s+/g, ' ');
  return cut(fromFirstLetterOrDigit(clean.trim()), max);
}

/** "linear-hub-payment-12-2026-10-23-starling.csv" */
export function bankFileName(formatId: BankFileFormatId, batchId: number, today: string): string {
  const f = bankFileFormat(formatId) ?? BANK_FILE_FORMATS[0]!;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : 'today';
  return `linear-hub-payment-${Math.trunc(batchId)}-${date}-${f.fileSuffix}.csv`;
}

// ───────────────────────────── the file ─────────────────────────────

/** One payment to write (the payee's full details: server-side only). */
export interface BankFileRow<K = number> {
  /** The caller's id for the line (the payment item's id). */
  key: K;
  payeeName: string;
  /** 6 digits (spaces and dashes are ignored). */
  sortCode: string;
  /** 8 digits. */
  accountNumber: string;
  amountPence: number;
  /** e.g. "LINEAR 05OCT JL" (cleaned and cut to the format's limit; "LINEAR" when nothing is left). */
  reference: string;
}

export interface BankFileResult<K = number> {
  format: BankFileFormat;
  /** The file ('' when no line could go in it). */
  body: string;
  /** The keys written, in order. */
  included: K[];
  /** The keys left out, with the reason in plain words (never an account number). */
  rejected: { key: K; reason: string }[];
  /** The reference written for each included key. */
  references: Map<K, string>;
}

/** Why a bank would refuse this line (null: it can go). */
function refusal(f: BankFileFormat, row: BankFileRow<unknown>, name: string): string | null {
  const shown = String(row.payeeName ?? '').trim().slice(0, 40);
  if (!name) return `The name on the account (“${shown}”) has no letters a bank accepts: check the bank details, then pay this week again.`;
  if (f.needsFirstAndLastName && name.split(' ').length < 2) {
    return `${f.bank ?? 'The bank'} needs the first and last name on the account, and the bank details say only “${name}”: check them, then pay this week again.`;
  }
  if (!normaliseSortCode(row.sortCode)) return 'The sort code in the bank details is not 6 digits: check them, then pay this week again.';
  if (!normaliseAccountNumber(row.accountNumber)) return 'The account number in the bank details is not 8 digits: check them, then pay this week again.';
  if (!Number.isSafeInteger(row.amountPence) || row.amountPence <= 0) return `Nothing to pay (${Number.isSafeInteger(row.amountPence) ? formatPence(row.amountPence) : 'not an amount'}): a bank file pays only amounts above £0.`;
  if (f.maxAmountPence !== null && row.amountPence > f.maxAmountPence) {
    return `${f.bank ?? 'The bank'} takes at most ${formatPence(f.maxAmountPence)} in one payment of a bulk file: pay this week another way.`;
  }
  return null;
}

/** One CSV cell: the shared CSV guard on text that is already bank-safe (it never needs quotes). */
const cell = (text: string) => payExportCell(text);

/**
 * The file for `formatId`: the header row, then one line per row a bank would take, in the order given (CRLF line
 * ends and a final CRLF). Rows a bank would refuse are left out with the reason; rows past the format's limit too.
 */
export function buildBankFile<K>(formatId: BankFileFormatId, rows: readonly BankFileRow<K>[]): BankFileResult<K> {
  const f = bankFileFormat(formatId);
  if (!f) throw new RangeError(`Unknown bank file format: ${String(formatId)}`);
  const lines: string[] = [];
  const included: K[] = [];
  const rejected: { key: K; reason: string }[] = [];
  const references = new Map<K, string>();
  for (const row of rows) {
    const name = bankPayeeName(row.payeeName, f.nameMax);
    const why = refusal(f, row, name);
    if (why) {
      rejected.push({ key: row.key, reason: why });
      continue;
    }
    if (f.maxRows !== null && included.length >= f.maxRows) {
      rejected.push({ key: row.key, reason: `${f.bank ?? 'The bank'} takes at most ${f.maxRows.toLocaleString('en-GB')} payments in one file: pay this week in another payment.` });
      continue;
    }
    const reference = bankReference(row.reference, f.referenceMax) || 'LINEAR';
    const cells: BankFileCells = {
      name,
      sortCode: normaliseSortCode(row.sortCode)!,
      accountNumber: normaliseAccountNumber(row.accountNumber)!,
      amount: bankAmount(row.amountPence),
      reference,
    };
    lines.push(f.line(cells).map(cell).join(','));
    included.push(row.key);
    references.set(row.key, reference);
  }
  const body = lines.length ? `${[f.headers.map(cell).join(','), ...lines].join('\r\n')}\r\n` : '';
  return { format: f, body, included, rejected, references };
}
