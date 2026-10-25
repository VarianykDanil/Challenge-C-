/**
 * Release 1.3 — OWNED BY P6 client-portal (laid down by r3-foundation). Labels and pure rules for client posts and
 * client accounts, shared by the server (validation, audit wording, the Needs-attention items) and the client (the
 * portal form, the statuses). formatClientAccessCode is STABLE (the foundation's demo account is "CL-0001").
 * No I/O; every function is deterministic and en-GB.
 */
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../types/pin.ts';
import { shareableSignInUrl, twoFactorSetupStep } from './people.ts';
import { CLIENT_ACCESS_CODE_PREFIX, type ClientPost, type ClientPostInput, type ClientPostKind, type ClientPostStatus } from '../types/client.ts';

export const CLIENT_POST_KIND_LABELS: Record<ClientPostKind, string> = {
  update: 'Update',
  announcement: 'Announcement',
  commission: 'Commission change',
};

/** "Waiting for Linear", "Approved", "Declined" (clientPostStatusText words the dates: "Approved from Mon 2 Nov", "Declined: reason"). */
export const CLIENT_POST_STATUS_LABELS: Record<ClientPostStatus, string> = {
  published: 'Published',
  pending: 'Waiting for Linear',
  approved: 'Approved',
  declined: 'Declined',
  unpublished: 'Unpublished',
};

/** What each kind does, in the portal's words. */
export const CLIENT_POST_KIND_HINTS: Record<ClientPostKind, string> = {
  update: 'News for the Linear MCR team, like a new leaflet or a campaign change. It is published in Announcements straight away.',
  announcement: 'Something every fundraiser should see, like an event or a deadline. It is published in Announcements straight away.',
  commission: 'A new rate per sub. It waits for Linear MCR to approve it, from the date they confirm.',
};

export const CLIENT_POST_KINDS: readonly ClientPostKind[] = ['update', 'announcement', 'commission'];

/** "CL-0001" for 1. */
export function formatClientAccessCode(n: number): string {
  return `${CLIENT_ACCESS_CODE_PREFIX}${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`;
}

/** True for a well-formed access code ("CL-0002"; case-insensitive). */
export function isClientAccessCode(value: unknown): boolean {
  return typeof value === 'string' && /^CL-\d{4,}$/i.test(value.trim());
}

// ── limits ──

export const CLIENT_POST_TITLE_MAX = 120;
export const CLIENT_POST_BODY_MAX = 2000;
/** £ per sub a client may propose at most (a sanity bound, far above any real rate). */
export const CLIENT_RATE_MAX = 1000;
/** A commission change may start at most this many days ahead. */
export const CLIENT_EFFECTIVE_MAX_DAYS = 366;
/** Posts one client account may send in 24 hours. */
export const CLIENT_POSTS_PER_DAY = 20;
/** The office's "unread" (sidebar badge, Needs attention) looks back this far; older posts count as read. */
export const CLIENT_POST_UNREAD_DAYS = 30;

/** Published straight to Announcements (updates and announcements); a commission change waits for Matt. */
export function clientPostPublishes(kind: ClientPostKind): boolean {
  return kind !== 'commission';
}

// ── words ──

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isClientPostDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "2026-11-02" → "Mon 2 Nov" (the date as written, never shifted by a time zone); anything else unchanged. */
export function clientPostDayLabel(date: string | null | undefined): string {
  if (!date || !isClientPostDate(date)) return date ?? '';
  const d = new Date(`${date}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** £22.00 (always pence: rates per sub). */
export function clientPostMoney(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "2026-10-21" + n days, in UTC so a clock change never shifts the day. */
function addDaysISO(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * "£22.00 per sub to the fundraiser, from Mon 2 Nov"; "£22.00 per sub to the fundraiser and £125.00 per sub to Linear,
 * from …"; "" when the post carries no rate.
 */
export function clientCommissionSummary(p: Pick<ClientPost, 'rateRep' | 'ratePayout' | 'effectiveFrom'>): string {
  const parts: string[] = [];
  if (p.rateRep != null) parts.push(`${clientPostMoney(p.rateRep)} per sub to the fundraiser`);
  if (p.ratePayout != null) parts.push(`${clientPostMoney(p.ratePayout)} per sub to Linear`);
  if (!parts.length) return '';
  const when = p.effectiveFrom ? `, from ${clientPostDayLabel(p.effectiveFrom)}` : '';
  return `${parts.join(' and ')}${when}`;
}

/** The status as the client and the office read it: "Approved from Mon 2 Nov", "Declined: We agreed £120 until March". */
export function clientPostStatusText(p: Pick<ClientPost, 'status' | 'effectiveFrom' | 'decisionNote'>): string {
  switch (p.status) {
    case 'approved':
      return p.effectiveFrom ? `Approved from ${clientPostDayLabel(p.effectiveFrom)}` : CLIENT_POST_STATUS_LABELS.approved;
    case 'declined': {
      const note = p.decisionNote?.trim();
      return note ? `Declined: ${note}` : CLIENT_POST_STATUS_LABELS.declined;
    }
    default:
      return CLIENT_POST_STATUS_LABELS[p.status] ?? String(p.status);
  }
}

/**
 * The office's words for a post's status (the campaign page): the client reads "Waiting for Linear", Linear's own staff
 * read "Waiting for approval"; every other status reads as clientPostStatusText.
 */
export function clientPostOfficeStatusText(p: Pick<ClientPost, 'status' | 'effectiveFrom' | 'decisionNote'>): string {
  return p.status === 'pending' ? 'Waiting for approval' : clientPostStatusText(p);
}

/** The default title of a commission change the client left untitled: "Commission change from Mon 2 Nov". */
export function clientCommissionTitle(effectiveFrom: string | null | undefined): string {
  return effectiveFrom ? `Commission change from ${clientPostDayLabel(effectiveFrom)}` : CLIENT_POST_KIND_LABELS.commission;
}

// ── validation (the portal form and POST /client/posts use the same rules) ──

export type ClientPostField = 'kind' | 'title' | 'body' | 'rateRep' | 'ratePayout' | 'effectiveFrom';

export interface ClientPostProblem {
  field: ClientPostField;
  message: string;
}

const hasPence = (n: number) => Math.abs(Math.round(n * 100) - n * 100) > 1e-6;

/** A rate as typed: a number, or null / undefined / '' for "not changing". */
function rateProblem(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return `Enter the new ${what} in pounds, more than £0.`;
  if (n > CLIENT_RATE_MAX) return `That is more than ${clientPostMoney(CLIENT_RATE_MAX)} per sub. Check the amount.`;
  if (hasPence(n)) return 'Use pounds and pence, like 12.50.';
  return null;
}

/**
 * Every problem with a post, in form order ([] when it can be sent). `today` is the business date (YYYY-MM-DD):
 * a commission change starts today at the earliest and at most CLIENT_EFFECTIVE_MAX_DAYS ahead. Updates and
 * announcements need a title and a message; a commission change needs a new rate (to the fundraiser, to Linear, or
 * both) and a date, and its title and message are optional.
 */
export function clientPostProblems(input: Partial<ClientPostInput>, today: string): ClientPostProblem[] {
  const out: ClientPostProblem[] = [];
  const kind = input.kind;
  if (!kind || !CLIENT_POST_KINDS.includes(kind)) {
    out.push({ field: 'kind', message: 'Choose Update, Announcement or Commission change.' });
    return out;
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const commission = kind === 'commission';
  if (!title && !commission) out.push({ field: 'title', message: 'Give it a short title.' });
  else if (title.length > CLIENT_POST_TITLE_MAX) out.push({ field: 'title', message: `Keep the title to ${CLIENT_POST_TITLE_MAX} characters.` });
  if (!body && !commission) out.push({ field: 'body', message: 'Write your message.' });
  else if (body.length > CLIENT_POST_BODY_MAX) out.push({ field: 'body', message: `Keep the message to ${CLIENT_POST_BODY_MAX.toLocaleString('en-GB')} characters.` });
  if (!commission) return out;

  const rep = rateProblem(input.rateRep, 'rate per sub to the fundraiser');
  const payout = rateProblem(input.ratePayout, 'payout per sub to Linear');
  const none = (input.rateRep === null || input.rateRep === undefined) && (input.ratePayout === null || input.ratePayout === undefined);
  if (none) out.push({ field: 'rateRep', message: 'Enter the new rate per sub to the fundraiser, the payout to Linear, or both.' });
  if (rep) out.push({ field: 'rateRep', message: rep });
  if (payout) out.push({ field: 'ratePayout', message: payout });
  const from = input.effectiveFrom;
  if (!from) out.push({ field: 'effectiveFrom', message: 'Pick the date the new rate starts.' });
  else if (!isClientPostDate(from)) out.push({ field: 'effectiveFrom', message: 'Pick a date, like 2 Nov.' });
  else if (from < today) out.push({ field: 'effectiveFrom', message: 'Pick today or a later date. Ask Linear MCR about earlier weeks.' });
  else if (from > addDaysISO(today, CLIENT_EFFECTIVE_MAX_DAYS)) out.push({ field: 'effectiveFrom', message: 'Pick a date within a year from today.' });
  return out;
}

// ── client accounts ──

export interface ClientInviteText {
  firstName: string;
  email: string;
  accessCode: string;
  campaignName: string;
  /** The sign-in page, when known ("https://hub.example/login"); a localhost address is left out (shareableSignInUrl). */
  signInUrl?: string | null;
}

/**
 * The sign-in instructions the admin copies into an email after an invite (plain text, no secrets but the code). Release
 * 1.4: with the two-step setup after the PIN (every invited client account must use it).
 */
export function clientInviteInstructions(t: ClientInviteText): string {
  const url = shareableSignInUrl(t.signInUrl);
  const where = url ? `Open ${url}` : 'Open the Linear Hub sign-in page';
  return [
    `Hello ${t.firstName.trim() || 'there'},`,
    '',
    `You can now post updates for ${t.campaignName} to the Linear MCR team in Linear Hub.`,
    '',
    `1. ${where}.`,
    `2. Enter your email (${t.email}) and your access code: ${t.accessCode}.`,
    `3. The first time, create a PIN of ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits. You will type it after your email and access code each time you sign in.`,
    twoFactorSetupStep(4, true),
    '',
    'Keep your access code, PIN and recovery codes to yourself. If you forget your PIN, ask Linear MCR to reset it. ' +
      'If you lose your phone, sign in with a recovery code, or ask Linear MCR to reset two-step verification.',
  ].join('\n');
}
