/**
 * Release 1.4 — package F (payments foundation): the pure rules every payment package shares. No I/O.
 *
 *  - Money: whole pence inside payment code. `poundsToPence` converts a payroll run's pounds (two decimals) once,
 *    exactly, and refuses anything with more decimals; `formatPence` shows "£1,234.50".
 *  - UK bank details: a sort code is 6 digits, an account number 8; spaces and dashes are ignored; only the last two
 *    digits of the sort code and the last four of the account number are ever shown ("••-••-34", "••••5678").
 *  - Batch status from its items (`batchStatusFromItems`), and which item statuses keep a run out of any other payment
 *    (`isLivePaymentItemStatus`: everything but failed and cancelled — the database's partial unique index says the same).
 *  - The four ways to pay with their abilities in plain words (`PAYMENT_PROVIDERS`). Packages P and A correct the
 *    truths they verify against each provider's documentation.
 */
import type {
  PaymentAbilities,
  PaymentBatchStatus,
  PaymentItemStatus,
  PaymentMode,
  PaymentProviderInfo,
  PaymentProviderKind,
} from '../types/payments.ts';
import { PAYMENT_LIVE_CONFIRMATION } from '../types/payments.ts';
import { payMoney } from './payRule.ts';
import { asciiFold } from './textFold.ts';

// ───────────────────────────── money ─────────────────────────────

/**
 * Pounds (a payroll run's two-decimal amount) → whole pence, exactly: 1.15 → 115 (not 114.99999999999999). RangeError
 * for NaN, infinities and amounts with more than two decimals (they are not money the runs hold).
 */
export function poundsToPence(pounds: number): number {
  if (typeof pounds !== 'number' || !Number.isFinite(pounds)) throw new RangeError('Not an amount of money');
  const pence = Math.round(pounds * 100);
  // a two-decimal amount is within floating-point noise of a whole number of pence
  if (Math.abs(pence - pounds * 100) > 1e-6 * Math.max(1, Math.abs(pounds))) throw new RangeError(`${pounds} has more than two decimals`);
  return pence === 0 ? 0 : pence; // never -0
}

export function penceToPounds(pence: number): number {
  return Math.round(pence) / 100;
}

/** Adds whole pence; RangeError for anything that is not a whole number. */
export function sumPence(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError('Pence must be whole numbers');
    total += v;
  }
  return total;
}

/** "£1,234.50"; "−£20.00". */
export function formatPence(pence: number): string {
  return payMoney(penceToPounds(pence));
}

// ───────────────────────────── bank details ─────────────────────────────

/** "12-34-56", "12 34 56", "123456" → "123456"; null unless exactly 6 ASCII digits. */
export function normaliseSortCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.replace(/[\s-]/g, '');
  return /^[0-9]{6}$/.test(clean) ? clean : null;
}

/** "1234 5678" → "12345678"; null unless exactly 8 ASCII digits. */
export function normaliseAccountNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.replace(/[\s-]/g, '');
  return /^[0-9]{8}$/.test(clean) ? clean : null;
}

/** "123456" → "12-34-56" (for files and forms; never sent by an API). */
export function formatSortCode(sortCode: string): string {
  return sortCode.length === 6 ? `${sortCode.slice(0, 2)}-${sortCode.slice(2, 4)}-${sortCode.slice(4)}` : sortCode;
}

/** The last two digits → "••-••-34". */
export function maskSortCode(last2: string): string {
  return `••-••-${last2}`;
}

/** The last four digits → "••••5678". */
export function maskAccountNumber(last4: string): string {
  return `••••${last4}`;
}

export const BANK_HOLDER_NAME_MIN = 2;
export const BANK_HOLDER_NAME_MAX = 70;
/** Letters (any alphabet), digits, spaces and the punctuation names use. */
const HOLDER_NAME_RE = /^[\p{L}\p{M}0-9 .,'’&/-]+$/u;

export interface BankDetailsErrors {
  ok: false;
  errors: { path: 'holderName' | 'sortCode' | 'accountNumber'; message: string }[];
}

/** The cleaned details, or one plain message per wrong field (in form order). */
export function validateBankDetails(input: { holderName: unknown; sortCode: unknown; accountNumber: unknown }):
  | { ok: true; value: { holderName: string; sortCode: string; accountNumber: string } }
  | BankDetailsErrors {
  const errors: BankDetailsErrors['errors'] = [];
  const holderName = typeof input.holderName === 'string' ? input.holderName.trim().replace(/\s+/g, ' ') : '';
  if (holderName.length < BANK_HOLDER_NAME_MIN || holderName.length > BANK_HOLDER_NAME_MAX) {
    errors.push({ path: 'holderName', message: `Give the name on the account (${BANK_HOLDER_NAME_MIN} to ${BANK_HOLDER_NAME_MAX} characters)` });
  } else if (!HOLDER_NAME_RE.test(holderName)) {
    errors.push({ path: 'holderName', message: 'Use the name on the account: letters, spaces, hyphens and apostrophes' });
  }
  const sortCode = normaliseSortCode(input.sortCode);
  if (!sortCode) errors.push({ path: 'sortCode', message: 'A sort code has 6 digits, like 12-34-56' });
  const accountNumber = normaliseAccountNumber(input.accountNumber);
  if (!accountNumber) errors.push({ path: 'accountNumber', message: 'An account number has 8 digits' });
  if (errors.length || !sortCode || !accountNumber) return { ok: false, errors };
  return { ok: true, value: { holderName, sortCode, accountNumber } };
}

// ───────────────────────────── statuses ─────────────────────────────

export const PAYMENT_BATCH_STATUS_LABELS: Record<PaymentBatchStatus, string> = {
  draft: 'Draft',
  submitted: 'Sent',
  processing: 'Processing',
  completed: 'Paid',
  partly_failed: 'Partly paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PAYMENT_ITEM_STATUS_LABELS: Record<PaymentItemStatus, string> = {
  queued: 'Waiting to send',
  submitted: 'Sent',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  test: 'Test mode',
  live: 'Live',
};

/** Statuses that keep a payroll run out of every other payment (all but failed and cancelled). */
export function isLivePaymentItemStatus(status: PaymentItemStatus): boolean {
  return status !== 'failed' && status !== 'cancelled';
}

/** Still on its way: queued, submitted or processing. */
export function isWaitingPaymentItemStatus(status: PaymentItemStatus): boolean {
  return status === 'queued' || status === 'submitted' || status === 'processing';
}

/**
 * An approved batch's status from its items: anything still waiting → 'submitted' (nothing back yet) or 'processing'
 * (some answers back, or the provider says processing); otherwise, ignoring cancelled items, all paid → 'completed',
 * all failed → 'failed', a mix → 'partly_failed'; nothing left at all → 'cancelled'.
 */
export function batchStatusFromItems(statuses: readonly PaymentItemStatus[]): PaymentBatchStatus {
  const live = statuses.filter((s) => s !== 'cancelled');
  if (!live.length) return 'cancelled';
  const waiting = live.filter(isWaitingPaymentItemStatus);
  if (waiting.length) {
    const anyBack = waiting.length < live.length || waiting.some((s) => s === 'processing');
    return anyBack ? 'processing' : 'submitted';
  }
  const paid = live.filter((s) => s === 'paid').length;
  if (paid === live.length) return 'completed';
  if (paid === 0) return 'failed';
  return 'partly_failed';
}

/** The message straight after Approve (the client shows it as a toast). */
export interface ApprovalOutcome {
  tone: 'success' | 'warning' | 'error';
  title: string;
  body: string;
}

/**
 * Review fixes (UI-2, SD-3, money:3): what an approval did, from the item statuses it answered with. Sent: submitted,
 * processing or paid; failed: refused, never counted as sent; waiting: still queued — the provider has not confirmed
 * it yet, either because it was not reached or because its answer was lost (a payment sent without an answer may still
 * exist there), so the words stay neutral. The provider's next step (`createsOnly`: Wise, fund the transfers there) or
 * `success` (who and how much) only when every item was really sent. A test bank file is never to be uploaded.
 */
export function approvalOutcome(
  b: { kind: PaymentProviderKind; mode: PaymentMode; items: readonly { status: PaymentItemStatus }[] },
  o: { providerName: string; createsOnly: boolean; success: string },
): ApprovalOutcome {
  if (b.kind === 'file') {
    return b.mode === 'test'
      ? { tone: 'success', title: 'Test bank file ready', body: 'For looking at only. Every line has sort code 00-00-00 and account 00000000, so it pays nobody, even if it is uploaded.' }
      : { tone: 'success', title: 'Bank file ready', body: 'Download it, upload it to your bank and approve it there. Then mark it paid here.' };
  }
  const live = b.items.filter((i) => i.status !== 'cancelled');
  const failed = live.filter((i) => i.status === 'failed').length;
  const waiting = live.filter((i) => i.status === 'queued').length;
  const sent = live.length - failed - waiting;
  const X = o.providerName;
  if (live.length && failed === live.length) {
    return {
      tone: 'error',
      title: 'Payment not made',
      body: failed === 1
        ? `${X} did not take it: the reason is on this page. The week stays on Runs to pay.`
        : `${X} did not take any of the ${failed}: the reasons are on this page. The weeks stay on Runs to pay.`,
    };
  }
  if (live.length && waiting === live.length) {
    return { tone: 'warning', title: 'Payment approved', body: `Approved, but ${X} has not confirmed ${waiting === 1 ? 'it' : 'them'} yet: Linear Hub tries again every 5 minutes.` };
  }
  if (failed || waiting) {
    const parts = [
      sent ? `${sent} sent` : '',
      failed ? `${failed} failed (${failed === 1 ? 'the reason is' : 'the reasons are'} on this page)` : '',
      waiting ? `${X} has not confirmed the other ${waiting} yet: Linear Hub tries again every 5 minutes` : '',
    ].filter(Boolean);
    return { tone: 'warning', title: 'Payment approved', body: `${parts.join('; ')}.` };
  }
  return { tone: 'success', title: 'Payment approved', body: b.mode === 'test' ? 'Test mode: nobody is paid.' : o.createsOnly ? `Linear Hub created the transfers. Now open ${X} and fund them: transfers you do not fund go back to Runs to pay.` : o.success };
}

/** The live switch: PAYMENT_LIVE_CONFIRMATION typed exactly (surrounding spaces ignored). */
export function isLiveConfirmation(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === PAYMENT_LIVE_CONFIRMATION;
}

// ───────────────────────────── references ─────────────────────────────

const MONTHS_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Faster Payments carry 18 characters of reference. */
export const PAYMENT_REFERENCE_MAX = 18;

/**
 * "LINEAR 05OCT JL": the week (its Monday) and the payee's initials, upper-case A–Z, 0–9 and spaces only (what every
 * UK bank accepts), at most 18 characters. A bank format (package P) may use its own.
 * `copy` 2 and up: a later bank file for the same person-week after an earlier downloaded one was void
 * ("LINEAR 05OCT JL 2"), so the bank's own duplicate check can tell the two files apart.
 */
export function defaultPaymentReference(weekStart: string, payeeName: string, copy = 1): string {
  const base = baseReference(weekStart, payeeName);
  if (!(copy > 1)) return base;
  const suffix = ` ${Math.floor(copy)}`;
  return `${base.slice(0, PAYMENT_REFERENCE_MAX - suffix.length).trim()}${suffix}`;
}

function baseReference(weekStart: string, payeeName: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  const week = m ? `${m[3]}${MONTHS_UPPER[Number(m[2]) - 1] ?? ''}` : '';
  // the first letter of each word ("O'Neill-Smith" is one word: O)
  const initials = asciiFold(payeeName ?? '')
    .toUpperCase()
    .split(/\s+/)
    .map((w) => /[A-Z]/.exec(w)?.[0] ?? '')
    .join('');
  const parts = ['LINEAR', week, initials.length > 2 ? `${initials[0]}${initials[initials.length - 1]}` : initials].filter(Boolean);
  return parts.join(' ').slice(0, PAYMENT_REFERENCE_MAX).trim();
}

// ───────────────────────────── the four ways to pay ─────────────────────────────

/**
 * What each way to pay can do. Written from each provider's public description; packages P and A check them against
 * the provider's current documentation and correct them in place (record the doc URLs next to their adapters).
 */
export const PAYMENT_PROVIDERS: readonly PaymentProviderInfo[] = [
  {
    // Release 1.4 — P (bank payment file) checked these against what the bank file does (lib/payments/bankFile.ts,
    // logic/bankFiles.ts): nothing is paid from Linear Hub, and nothing comes back from the bank by itself.
    id: 'bank_file',
    name: 'Bank payment file',
    summary: 'Linear Hub makes a bulk payment file. You upload it to your online banking, approve it there, then mark the payment paid here. It starts in test mode: test files say TEST and have no real bank details in them, so they can pay nobody.',
    kind: 'file',
    iconKey: 'bank',
    abilities: {
      paysFromApp: false,
      confirmsAutomatically: false,
      needsBankApproval: true,
      // a bank file connection starts in test mode like the others; live needs PAY FOR REAL typed
      testMode: true,
      checksBalance: false,
      sameDay: true,
      anyUkBank: true,
      fees: 'No fees from Linear Hub. Your bank’s own charges for bulk payments apply (Starling, for one, charges a monthly fee for Bulk Payments).',
      setup: [
        'Online banking for your business account that takes a bulk payment file',
        'Choose your bank’s file format: Starling Bank or Revolut Business (made from each bank’s own published guide), or the general Faster Payments file for any other bank (not any bank’s own template: check its columns with your bank)',
        'Before the first real run, make a 1p test file and upload it to your bank, to check the bank takes the layout',
      ],
      limits: 'You upload and approve every file in your bank yourself, then mark who was paid here. No layout has been tried with a bank yet: the first real run is a test, so start with the 1p test file. Once a file is downloaded its weeks count as sent. Linear Hub keeps no passwords or keys for your bank: only the file, stored encrypted so you can download it again. Your bank’s own limits apply.',
    },
    connectSteps: [
      'Choose your bank’s file format below. Starling and Revolut files follow each bank’s own published guide; the general file is the five things every UK bank asks for, so check its columns with your bank.',
      'The connection starts in test mode: test files say TEST in their name and in every reference, and every line has sort code 00-00-00 and account 00000000 instead of the person’s. They can pay nobody and mark no week paid. Try a test payment to see the file.',
      'Make a 1p test file (one payment of £0.01 to an account you choose), upload it to your bank and approve it there. Then tell Linear Hub whether the bank took it.',
      'Switch to live (type PAY FOR REAL). Treat the first real run as a test too: pay one or two people, check the money arrived, then pay everyone else.',
    ],
    liveNote: 'Live files pay real money once you upload and approve them in your bank. Make the 1p test file first if you have not, and treat the first real run as a test: one or two people, then everyone else.',
  },
  // Package A: checked against each provider's documentation on 23 Oct 2026 (URLs in server/src/lib/payments/revolut.ts,
  // wise.ts and truelayer.ts). `connectSteps` say plainly what is done outside Linear Hub.
  {
    id: 'revolut',
    name: 'Revolut Business',
    summary: 'Linear Hub sends each payment from your Revolut Business GBP account and checks until Revolut says it has arrived.',
    kind: 'api',
    iconKey: 'revolut',
    abilities: {
      paysFromApp: true,
      confirmsAutomatically: true,
      needsBankApproval: false,
      testMode: true,
      checksBalance: true,
      sameDay: true,
      fees: 'Revolut’s own transfer fees and your plan’s allowance apply. No fees from Linear Hub.',
      setup: [
        'A Revolut Business plan that includes the Business API',
        'An API certificate added in Revolut Business on a computer (Settings → APIs → Business API), with its client ID and private key',
        'Allowing Linear Hub once in Revolut (Enable access), then pasting the code Revolut gives you',
        'For test mode, a Revolut sandbox account with its own certificate',
      ],
      limits: 'Pays people in pounds to UK accounts (sort code and account number). If your Revolut account makes payments wait for an approver, they wait in Revolut until approved, and Linear Hub shows them as processing. Linear Hub does not run Confirmation of Payee checks. Revolut’s own limits apply.',
    },
    connectSteps: [
      'On a computer, make a key pair as Revolut’s guide says (openssl), then in Revolut Business open Settings → APIs → Business API and add an API certificate: upload the public certificate and type an OAuth redirect URI (any website address you control, e.g. your company website).',
      'Revolut shows a client ID. Copy it, the redirect URI and your private key into the form below.',
      'In Revolut, choose Enable access for that certificate and allow it. Revolut opens your redirect address with a code in it: copy the whole address into “Code from Revolut” and save straight away (the code works for 2 minutes). Linear Hub tests it when you save.',
      'Test mode uses the Revolut sandbox (sandbox-business.revolut.com), which has its own certificate and client ID. Make a test payment through the sandbox first: Linear Hub switches to live only after the sandbox has answered one.',
      'Linear Hub was built from Revolut’s published API and checked against a copy of it, not yet against Revolut itself: the sandbox payment is the first real check. Treat the first live run as a test too: one or two people, then everyone else.',
    ],
    liveNote: 'Your sandbox certificate does not work live. After switching, choose Edit and enter the client ID, private key and a new code from your real Revolut Business account, then test. Make the first live run small: one or two people.',
    waitingNote: 'Revolut sends each payment as soon as you approve. If your Revolut Business makes payments wait for an approver, approve them in Revolut too. Linear Hub checks with Revolut every 5 minutes and marks each week paid when Revolut has completed the payment.',
  },
  {
    id: 'wise',
    name: 'Wise Business',
    summary: 'Linear Hub creates the transfers in your Wise Business account; you fund them in Wise. Transfers you do not fund go back to Runs to pay. Linear Hub sees when Wise has sent the money.',
    kind: 'api',
    iconKey: 'wise',
    abilities: {
      paysFromApp: false,
      confirmsAutomatically: true,
      needsBankApproval: true,
      testMode: true,
      checksBalance: false,
      sameDay: true,
      fees: 'Wise’s own fee for each transfer, shown in Wise before you pay it. No fees from Linear Hub.',
      setup: [
        'A Wise Business account',
        'A personal API token made in Wise on a computer (Your account → Connect and manage apps → API tokens)',
        'After each approval in Linear Hub, funding the transfers in Wise yourself (Linear Hub cannot fund them)',
        'For test mode, a Wise sandbox account and its own token',
      ],
      limits: 'Linear Hub creates the transfers; you fund them in Wise: for UK businesses Wise does not let an API token fund a transfer. Transfers you do not fund in time are cancelled by Wise and go back to Runs to pay. If your Wise account needs payments approved, Wise refuses transfers made with a token. Linear Hub cannot show your Wise balance.',
    },
    connectSteps: [
      'In Wise Business on a computer, open Your account → Connect and manage apps → API tokens and add a token with full access (Wise asks for its own code).',
      'Paste the token below. Leave the business profile empty unless you run more than one business in Wise. Linear Hub tests it when you save.',
      'After you approve a payment in Linear Hub, open Wise and fund the transfers it created. Linear Hub marks each week paid once Wise has sent the money; transfers you do not fund go back to Runs to pay.',
      'Test mode uses the Wise sandbox (wise-sandbox.com), which needs its own account and token. Make a test payment through the sandbox first: Linear Hub switches to live only after the sandbox has answered one.',
      'Linear Hub was built from Wise’s published API and checked against a copy of it, not yet against Wise itself: the sandbox payment is the first real check. Treat the first live run as a test too: one or two people, then everyone else.',
    ],
    liveNote: 'Your sandbox token does not work live. After switching, choose Edit and paste a token from your real Wise Business account, then test. Make the first live run small: one or two people.',
    approveNote: 'Linear Hub creates the transfers; nobody is paid until you fund them in Wise. Transfers you do not fund go back to Runs to pay.',
    waitingNote: 'Now open Wise and fund the transfers Linear Hub created: they wait there until you do. Transfers you do not fund in time are cancelled by Wise and go back to Runs to pay. Linear Hub checks with Wise every 5 minutes and marks each week paid once Wise has sent the money.',
  },
  {
    id: 'truelayer',
    name: 'Open Banking (TrueLayer)',
    summary: 'Payouts through TrueLayer from your TrueLayer GBP merchant account, which you top up from your business bank.',
    kind: 'api',
    iconKey: 'truelayer',
    abilities: {
      paysFromApp: true,
      confirmsAutomatically: true,
      needsBankApproval: false,
      testMode: true,
      checksBalance: true,
      sameDay: true,
      fees: 'TrueLayer charges per payout: check your TrueLayer agreement. No fees from Linear Hub.',
      setup: [
        'A TrueLayer business account with payouts switched on (TrueLayer checks your business first)',
        'A GBP merchant account in TrueLayer, topped up from your business bank',
        'The client ID and client secret from the TrueLayer Console',
        'A signing key made on a computer: the public half uploaded in the Console, the private half and its key ID here',
      ],
      limits: 'Payouts come out of your TrueLayer merchant account, so top it up before you pay people. TrueLayer may ask for each person’s date of birth and address for its own checks; Linear Hub does not send them. A payout the receiving bank sends back after it was paid needs sorting out by hand.',
    },
    connectSteps: [
      'Ask TrueLayer to switch on payouts and open a GBP merchant account for your business, then top it up from your bank.',
      'On a computer, make a signing key with openssl (the commands are under “Signing key ID” below) and upload the public key in the TrueLayer Console (Payments → Settings). Copy the key ID it shows.',
      'Copy the client ID and client secret from the Console, and paste them, the key ID and the private key below. Linear Hub tests them when you save.',
      'Test mode uses the TrueLayer sandbox, which has its own client ID, secret and signing key. Make a test payment through the sandbox first: Linear Hub switches to live only after the sandbox has answered one.',
      'Linear Hub was built from TrueLayer’s published API and checked against a copy of it, not yet against TrueLayer itself: the sandbox payment is the first real check. Treat the first live run as a test too: one or two people, then everyone else.',
    ],
    liveNote: 'Sandbox details do not work live. After switching, choose Edit and enter the live client ID, secret, signing key ID and private key from the TrueLayer Console, then test. Make the first live run small: one or two people.',
    waitingNote: 'TrueLayer pays each person from your merchant account. A payout fails if the merchant account runs short: top it up and pay that week again. Linear Hub checks with TrueLayer every 5 minutes and marks each week paid when TrueLayer has sent the money.',
  },
];

export function paymentProviderInfo(id: string): PaymentProviderInfo | null {
  return PAYMENT_PROVIDERS.find((p) => p.id === id) ?? null;
}

export interface AbilityLine {
  key: 'paysFromApp' | 'confirmsAutomatically' | 'needsBankApproval' | 'testMode' | 'checksBalance' | 'sameDay' | 'anyUkBank';
  label: string;
  ok: boolean;
}

/**
 * The checklist Settings → Payments shows for a way to pay (the page draws ✓ / ✗). Release 1.4 (P): "Works with any
 * UK business bank" comes last, only for a way to pay that says (the bank payment file).
 */
export function abilityChecklist(a: PaymentAbilities): AbilityLine[] {
  const lines: AbilityLine[] = [
    { key: 'paysFromApp', label: 'Pays from Linear Hub', ok: a.paysFromApp },
    { key: 'confirmsAutomatically', label: 'Confirms payment automatically', ok: a.confirmsAutomatically },
    { key: 'needsBankApproval', label: 'You approve the payments in your bank', ok: a.needsBankApproval },
    { key: 'testMode', label: 'Test mode', ok: a.testMode },
    { key: 'checksBalance', label: 'Shows your balance', ok: a.checksBalance },
    { key: 'sameDay', label: 'Usually arrives the same day', ok: a.sameDay },
  ];
  if (typeof a.anyUkBank === 'boolean') lines.push({ key: 'anyUkBank', label: 'Works with any UK business bank', ok: a.anyUkBank });
  return lines;
}
