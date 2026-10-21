/**
 * Release 1.2 — OWNED BY U3 audit-trail.
 * Pure: the field-level diff the /audit page and the entity history show, the keys that are never stored, and the
 * wording helpers the server's readable summaries use ("Marked paid: Jordan Lee w/c 5 Oct, £945"). Deterministic and
 * en-GB: the same snapshots always give the same text. No I/O.
 */
import type { AuditEntity, AuditFieldChange } from '../types/audit.ts';

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
