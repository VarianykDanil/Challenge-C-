/**
 * Release 1.2 — OWNED BY U3 audit-trail.
 * Pure: the field-level diff the /audit page and the entity history show, the keys that are never stored, and the
 * wording helpers the server's readable summaries use ("Marked paid: Jordan Lee w/c 5 Oct, £945"). Deterministic and
 * en-GB: the same snapshots always give the same text. No I/O.
 */
import type { Role } from '../types.ts';
import type { AuditEntity, AuditEventKind, AuditExportFormat, AuditFieldChange, AuditSignInReason } from '../types/audit.ts';
import { AUDIT_EVENT_KINDS } from '../types/audit.ts';

/** Every entity the trail knows, in the order the /audit filter lists them. */
export const AUDIT_ENTITIES: readonly AuditEntity[] = [
  'payroll_run', 'gauge_entry', 'user', 'candidate', 'event', 'campaign', 'pitch', 'settings', 'announcement', 'expense',
  'learning', 'check_in',
];

/**
 * Release 1.3 (r3-foundation): the entities the 1.3 packages record. Kept apart from AUDIT_ENTITIES (the 1.2 filter
 * list) so the /audit filter is unchanged until P9 audit-everything decides how to list them; isAuditEntity accepts both.
 */
export const AUDIT_ENTITIES_R3: readonly AuditEntity[] = [
  'campaign_rate', 'pay_adjustment', 'invoice', 'agreement', 'statement', 'video', 'client_post', 'client_account',
  'interview_question', 'event_roster', 'export',
];

export const AUDIT_ENTITY_LABELS: Record<AuditEntity, string> = {
  payroll_run: 'Pay run',
  gauge_entry: 'Gauge entry',
  user: 'Person',
  candidate: 'Candidate',
  event: 'Event',
  campaign: 'Campaign',
  pitch: 'Pitch',
  settings: 'Settings',
  announcement: 'Announcement',
  expense: 'Expense',
  learning: 'Learning',
  check_in: 'Check-in',
  // Release 1.3 (r3-foundation)
  campaign_rate: 'Campaign rate',
  pay_adjustment: 'Pay adjustment',
  invoice: 'Invoice',
  agreement: 'Self-billing agreement',
  statement: 'Commission statement',
  video: 'Video',
  client_post: 'Client post',
  client_account: 'Client account',
  interview_question: 'Interview question',
  event_roster: 'Event booking',
  export: 'Export',
};

export function isAuditEntity(value: unknown): value is AuditEntity {
  return typeof value === 'string' && ((AUDIT_ENTITIES as readonly string[]).includes(value) || (AUDIT_ENTITIES_R3 as readonly string[]).includes(value));
}

// ───────────────────────────── Release 1.3 (P9 audit-everything): kinds of action ─────────────────────────────

/** The Audit page's Record filter: the 1.2 entities, then the 1.3 ones (AUDIT_ENTITIES itself is unchanged). */
export const AUDIT_FILTER_ENTITIES: readonly AuditEntity[] = [...AUDIT_ENTITIES, ...AUDIT_ENTITIES_R3];

/** The kind filter's words (Audit page, Team → person → Activity). */
export const AUDIT_EVENT_KIND_LABELS: Record<AuditEventKind, string> = {
  change: 'Changes',
  sign_in: 'Sign-ins',
  export: 'Exports',
  opened: 'Opened records',
  automatic: 'Automatic',
  client: 'Client portal',
};

/** One row's kind in words, singular ("Sign-in", "Export"). */
export const AUDIT_EVENT_KIND_LABELS_ONE: Record<AuditEventKind, string> = {
  change: 'Change',
  sign_in: 'Sign-in',
  export: 'Export',
  opened: 'Opened',
  automatic: 'Automatic',
  client: 'Client portal',
};

export const AUDIT_EXPORT_FORMAT_LABELS: Record<AuditExportFormat, string> = {
  csv: 'CSV',
  pdf: 'PDF',
  xero: 'Xero CSV',
  sage: 'Sage CSV',
  print: 'print',
};

export function isAuditEventKind(value: unknown): value is AuditEventKind {
  return typeof value === 'string' && (AUDIT_EVENT_KINDS as readonly string[]).includes(value);
}

/** The actions of signing in and out (their failed attempts use the same actions, kind `sign_in`). */
export const AUDIT_SIGN_IN_ACTIONS: readonly string[] = ['POST /auth/login', 'POST /auth/login/2fa', 'POST /auth/logout'];

/**
 * The sign-in page's actions. A failed attempt there (a wrong employee ID, PIN or two-step code) is filed under the
 * account it was tried on, but whoever typed it may not be that person: it is an attempt ON the account, not something
 * the person did (their "Last active" leaves it out; the trail words it "Attempt on Jordan Lee's account"). A failed
 * check while signed in (a wrong current PIN or code in Settings) is the person's own.
 */
export const AUDIT_SIGN_IN_PAGE_ACTIONS: readonly string[] = ['POST /auth/login', 'POST /auth/login/2fa'];

/** A failed sign-in, wrong PIN or wrong two-step code (its row's snapshot has a `reason`). */
export function isAuditFailedAttempt(entry: { kind?: AuditEventKind | null; after?: unknown }): boolean {
  const after = isRecord(entry.after) ? entry.after : null;
  return entry.kind === 'sign_in' && typeof after?.reason === 'string';
}

/** A failed attempt made on the sign-in page: on the account it is filed under, maybe by somebody else. */
export function isAuditAttemptOnAccount(entry: { kind?: AuditEventKind | null; action: string; after?: unknown }): boolean {
  return isAuditFailedAttempt(entry) && AUDIT_SIGN_IN_PAGE_ACTIONS.includes(entry.action);
}

/** Actions for rows that are not a route's write: `SYSTEM <name>` (automatic), `EVENT export` / `EVENT opened` (reported by a page). */
export const AUDIT_SYSTEM_PREFIX = 'SYSTEM ';
export const AUDIT_EVENT_EXPORT_ACTION = 'EVENT export';
export const AUDIT_EVENT_OPENED_ACTION = 'EVENT opened';
/** The Xero / Sage payroll CSV (routes/payExport.ts records it itself, as a GET). */
export const AUDIT_PAY_EXPORT_ACTION = 'GET /finance/payroll/export';

/**
 * The kind of an audit row, from its action and the role of whoever acted, when the row does not say (a failed PIN
 * change says `sign_in` itself). In order: `SYSTEM …` → automatic; `EVENT export` and the payroll export → export;
 * `EVENT opened` → opened; signing in or out (and its failed attempts) → sign_in; anything a client account did, or
 * a write to the client portal (`/client`, `/client/…`) → client; everything else → change.
 * server/src/db/extensions/audit.ts classifies rows written before 1.3 with the same rules in SQL.
 */
export function auditKindOf(action: string, actorRole?: Role | null): AuditEventKind {
  if (action.startsWith(AUDIT_SYSTEM_PREFIX)) return 'automatic';
  if (action.startsWith(AUDIT_EVENT_EXPORT_ACTION) || action === AUDIT_PAY_EXPORT_ACTION) return 'export';
  if (action.startsWith(AUDIT_EVENT_OPENED_ACTION)) return 'opened';
  if (AUDIT_SIGN_IN_ACTIONS.includes(action)) return 'sign_in';
  if (actorRole === 'client' || /^[A-Z]+ \/client(\/|$)/i.test(action)) return 'client';
  return 'change';
}

/**
 * `?kind=sign_in,export` → ['sign_in', 'export'] (in the order given, without repeats); undefined when absent or
 * empty; null when any part is not a kind (the route answers 400).
 */
export function parseAuditKinds(raw: string | undefined): AuditEventKind[] | undefined | null {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  if (!parts.every(isAuditEventKind)) return null;
  return [...new Set(parts as AuditEventKind[])];
}

/**
 * What a page reported as exported, in words: "gauges-by-team" → "Gauges by team"; a file name loses its extension
 * and a trailing date ("linear-leaderboard-2026-10-21.csv" → "Linear leaderboard"). Empty → "a table".
 */
export function auditWhatLabel(what: string): string {
  const base = what.trim().replace(/\.(csv|pdf|txt|xlsx?)$/i, '').replace(/[-_ ]?\d{4}-\d{2}-\d{2}(?:[-_ ]?(?:to|-)?[-_ ]?\d{4}-\d{2}-\d{2})?$/i, '');
  const words = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return 'a table';
  return words[0]!.toUpperCase() + words.slice(1);
}

const ROWS = new Intl.NumberFormat('en-GB');

/** "Exported Gauges by team as CSV: 124 rows" · "Exported Leaderboard as PDF" (no row count sent) · "Printed Payslip". */
export function auditExportSummary(input: { what: string; format?: AuditExportFormat; rows?: number }): string {
  const label = auditWhatLabel(input.what);
  const rows = typeof input.rows === 'number' && Number.isFinite(input.rows) ? `: ${ROWS.format(input.rows)} ${input.rows === 1 ? 'row' : 'rows'}` : '';
  if (input.format === 'print') return `Printed ${label}${rows}`;
  const as = input.format ? ` as ${AUDIT_EXPORT_FORMAT_LABELS[input.format]}` : '';
  return `Exported ${label}${as}${rows}`;
}

/** Keys (any depth, case-insensitive) replaced by "[redacted]" before a snapshot is stored. U3 owns the list. */
export const AUDIT_REDACTED_KEYS: readonly string[] = [
  'pin', 'currentPin', 'newPin', 'pinHash', 'pin_hash', 'pinSalt', 'pin_salt', 'password', 'token', 'sessionToken',
  'challengeToken', 'secret', 'totp_secret_enc', 'totp_pending_enc', 'totpSecretEnc', 'totpPendingEnc', 'code',
  'recoveryCode', 'recoveryCodes', 'code_hash', 'codeHash', 'otpauthUrl', 'otpauth', 'qrDataUrl', 'manualKey',
];

/** Any key that CONTAINS one of these (case-insensitive) is redacted too, e.g. `appSecret`, `resetToken`. */
export const AUDIT_REDACTED_FRAGMENTS: readonly string[] = ['secret', 'password', 'token', 'pinhash', 'pin_hash', 'recovery'];

/** What a redacted value is stored as. */
export const AUDIT_REDACTED = '[redacted]';

const REDACTED_EXACT = new Set(AUDIT_REDACTED_KEYS.map((k) => k.toLowerCase()));

/** True when a snapshot key must never be stored. */
export function isAuditRedactedKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACTED_EXACT.has(k) || AUDIT_REDACTED_FRAGMENTS.some((f) => k.includes(f));
}

/**
 * A deep copy of `value` with every redacted key's value replaced by "[redacted]" (objects and arrays, 8 levels deep;
 * deeper values are dropped). Functions and undefined fields are left out, as JSON would.
 */
export function redactAuditSnapshot<T>(value: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (depth > 8) return undefined;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === 'function') continue;
      out[k] = isAuditRedactedKey(k) ? AUDIT_REDACTED : walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (v: unknown): unknown => (v === undefined || v === '' ? null : v);
const same = (a: unknown, b: unknown): boolean => {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false;
  return JSON.stringify(x) === JSON.stringify(y);
};

/**
 * Never shown as a change: the record's own identity, and the reference ids every snapshot pairs with a readable name
 * (`userId` with `userName`, `eventId` with `eventName` …), so a move shows once, as names. `employeeId` is a value.
 */
export const AUDIT_DIFF_SKIPPED: readonly string[] = [
  'id', 'userId', 'eventId', 'teamId', 'campaignId', 'payPlanId', 'ownerId', 'referredById', 'interviewerId', 'candidateId',
  'hiredUserId', 'authorId', 'signedOffById',
];
const DIFF_SKIPPED = new Set(AUDIT_DIFF_SKIPPED);

/**
 * The changed fields between two snapshots (flat objects; nested values compared as JSON). A create (before null)
 * lists every field the new record has; a delete (after null) every field it had. `undefined` and '' count as empty
 * (null). Identity and reference ids (AUDIT_DIFF_SKIPPED) are never listed. Order: the before snapshot's keys, then
 * keys only the after has.
 */
export function auditDiff(before: unknown, after: unknown): AuditFieldChange[] {
  const b = isRecord(before) ? before : null;
  const a = isRecord(after) ? after : null;
  if (!b && !a) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of [...Object.keys(b ?? {}), ...Object.keys(a ?? {})]) {
    if (seen.has(k) || DIFF_SKIPPED.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  const out: AuditFieldChange[] = [];
  for (const field of keys) {
    const was = norm(b?.[field]);
    const now = norm(a?.[field]);
    if (same(was, now)) continue;
    out.push({ field, before: was, after: now });
  }
  return out;
}

// ───────────────────────────── wording ─────────────────────────────

/** Release 1.3 (P9): a failed attempt's `reason` in words ("Reason: Wrong PIN" when its row is opened). */
export const AUDIT_SIGN_IN_REASON_LABELS: Record<AuditSignInReason, string> = {
  wrong_employee_id: 'Wrong employee ID',
  deactivated: 'The account is deactivated',
  unknown_email: 'No account has this email',
  wrong_pin: 'Wrong PIN',
  pin_locked_now: 'This try locked the PIN',
  pin_locked: 'The PIN is locked',
  too_many_attempts: 'Too many attempts',
  wrong_code: 'Wrong two-step code',
  too_many_codes: 'Too many wrong two-step codes',
  challenge_expired: 'The two-step code was not entered within 5 minutes',
  wrong_current_pin: 'Wrong current PIN',
};

/** Labels for snapshot fields (diff tables and summaries); anything else is humanised from camelCase. */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  // gauge entry
  userName: 'Person', eventName: 'Event', date: 'Date', stops: 'Stops', table: 'To table', presentations: 'Presentations',
  closes: 'Closes', taps: 'Taps', sales: 'Sales', checkedInAt: 'Check-in', notes: 'Notes',
  // pay run
  weekStart: 'Week', weekEnd: 'Week ends', status: 'Status', paidDate: 'Paid on', dueDate: 'Due', daysWorked: 'Days worked',
  teamSales: 'Team sales', basePay: 'Base pay', commission: 'Commission', bonus: 'Bonus', overrides: 'Overrides',
  deductions: 'Deductions', gross: 'Gross', reference: 'Reference', adjustedAt: 'Adjusted after payment',
  // person
  name: 'Name', email: 'Email', employeeId: 'Employee ID', role: 'Role', position: 'Position', teamName: 'Team',
  payPlanName: 'Pay plan', startDate: 'Start date', phone: 'Phone', city: 'City', twoFactor: 'Two-step verification',
  pinSet: 'PIN set',
  // candidate and interview
  stage: 'Stage', source: 'Source', positionApplied: 'Applied for', ownerName: 'Owner', referredByName: 'Referred by',
  rating: 'Rating', nextAction: 'Next action', nextActionAt: 'Next action due', hiredUserName: 'Hired as',
  candidateName: 'Candidate', scheduledAt: 'Scheduled', interviewerName: 'Interviewer', outcome: 'Outcome',
  // event and campaign
  venue: 'Venue', type: 'Type', startTime: 'Starts', endTime: 'Ends', targetSales: 'Target', campaignName: 'Campaign',
  campaignCode: 'Code', sector: 'Sector', payoutPerSale: 'Payout per sale', repCommissionPerSale: 'Rep commission per sale',
  color: 'Colour', active: 'Active', description: 'Description',
  // expense, announcement, pitch, settings, learning
  category: 'Category', amount: 'Amount', title: 'Title', body: 'Text', pinned: 'Pinned', authorName: 'Author',
  facts: 'Fact check', requirePin: 'Require a PIN for everyone', requireAdminTwoFactor: 'Require two-step for administrators',
  sessionIdleHours: 'Sign out after idle (hours)', lessonKey: 'Lesson', learnedAt: 'Learned', quizScore: 'Self-check score',
  teachbackAt: 'Teach-back written', signedOffByName: 'Signed off by', signedOffAt: 'Signed off',
  // Release 1.3 (P9): exports and opened records reported by a page, failed sign-ins
  what: 'What', format: 'Format', rows: 'Rows', filename: 'File', record: 'Record', reason: 'Reason',
  attemptsLeft: 'Tries left', lockedUntil: 'Locked until', typedEmail: 'Email typed',
};

/** Fields whose numbers are money (shown as £). */
export const AUDIT_MONEY_FIELDS: ReadonlySet<string> = new Set([
  'gross', 'basePay', 'commission', 'bonus', 'overrides', 'deductions', 'amount', 'payoutPerSale', 'repCommissionPerSale',
]);

/** "checkedInAt" → "Check-in"; unknown "fooBarBaz" → "Foo bar baz", "foo_bar" → "Foo bar". */
export function auditFieldLabel(field: string): string {
  const known = AUDIT_FIELD_LABELS[field];
  if (known) return known;
  const words = field.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : field;
}

/** "feel-felt-found" → "Feel felt found"; "field_rep" → "Field rep". */
export function auditHumanise(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const GBP_WHOLE = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const GBP_PENCE = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole pounds without pence ("£945"), otherwise two places ("£412.50"). */
export function auditMoney(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return (Number.isInteger(v) ? GBP_WHOLE : GBP_PENCE).format(v === 0 ? 0 : v);
}

/** "2026-10-12" → "12 Oct". */
export function auditDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/** "2026-10-05" → "w/c 5 Oct". */
export function auditWeekLabel(weekStart: string): string {
  return `w/c ${auditDayLabel(weekStart)}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const ZONED_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ENUM_RE = /^[a-z]+(?:_[a-z]+)+$/;
const TEXT_MAX = 40;

/**
 * One value as words: empty → "—", true/false → "yes"/"no", money fields → "£945", numbers en-GB, a date → "12 Oct",
 * a wall-clock time → "12 Oct 09:24", a zoned timestamp → London time "12 Oct, 14:00", snake_case enums → "field rep",
 * long text cut at 40 characters with "…".
 */
export function auditValueText(field: string, value: unknown): string {
  const v = norm(value);
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return AUDIT_MONEY_FIELDS.has(field) ? auditMoney(v) : NUMBER.format(v);
  if (typeof v === 'string') {
    if (DATE_RE.test(v)) return auditDayLabel(v);
    const naive = NAIVE_TS_RE.exec(v);
    if (naive) return `${auditDayLabel(naive[1]!)} ${naive[2]}:${naive[3]}`;
    if (ZONED_TS_RE.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return LONDON.format(d);
    }
    if (ENUM_RE.test(v)) return v.replace(/_/g, ' ');
    const flat = v.replace(/\s+/g, ' ').trim();
    return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1).trimEnd()}…` : flat;
  }
  const json = JSON.stringify(v) ?? '';
  return json.length > TEXT_MAX ? `${json.slice(0, TEXT_MAX - 1)}…` : json;
}

const isLongText = (v: unknown) => typeof v === 'string' && v.length > TEXT_MAX;

/** One detail of a row that records an event rather than a change: "Reason" · "Wrong PIN". */
export interface AuditFact {
  field: string;
  label: string;
  text: string;
}

/**
 * Release 1.3 (P9): the details of a sign-in or failed attempt, an export or an opened record, as facts ("Reason:
 * Wrong PIN", "Tries left: 6", "Format: PDF") rather than as a before → after change. A failed attempt's reason and an
 * export's format are said in words; everything else as auditValueText says it; empty values are left out.
 */
export function auditFacts(snapshot: unknown): AuditFact[] {
  if (!isRecord(snapshot)) return [];
  const out: AuditFact[] = [];
  for (const [field, value] of Object.entries(snapshot)) {
    if (norm(value) === null) continue;
    let text: string;
    if (field === 'reason' && typeof value === 'string' && value in AUDIT_SIGN_IN_REASON_LABELS) text = AUDIT_SIGN_IN_REASON_LABELS[value as AuditSignInReason];
    else if (field === 'format' && typeof value === 'string' && value in AUDIT_EXPORT_FORMAT_LABELS) text = auditHumanise(AUDIT_EXPORT_FORMAT_LABELS[value as AuditExportFormat]);
    else text = auditValueText(field, value);
    out.push({ field, label: auditFieldLabel(field), text });
  }
  return out;
}

/**
 * The changes as one phrase: "sales 3 → 4, stops 60 → 65 and 2 more". Long text fields are named, not quoted
 * ("notes"). `skip` leaves fields out (e.g. names already in the sentence); `max` (default 3) caps the list.
 * Empty when nothing is left.
 */
export function auditChangeText(changes: readonly AuditFieldChange[], opts: { max?: number; skip?: readonly string[] } = {}): string {
  const max = Math.max(1, opts.max ?? 3);
  const skip = new Set(opts.skip ?? []);
  const shown = changes.filter((c) => !skip.has(c.field));
  const parts = shown.slice(0, max).map((c) => {
    const label = auditFieldLabel(c.field).toLowerCase();
    if (isLongText(c.before) || isLongText(c.after)) return label;
    return `${label} ${auditValueText(c.field, c.before)} → ${auditValueText(c.field, c.after)}`;
  });
  const more = shown.length - parts.length;
  if (!parts.length) return '';
  return more > 0 ? `${parts.join(', ')} and ${more} more` : parts.join(', ');
}
