/**
 * Release 1.2 — U3 audit-trail contracts (laid down by r2-foundation; OWNED BY U3, which may add fields and types).
 *
 * Endpoints (server/src/routes/audit.ts, owned by U3):
 *  - GET  /audit?userId=&entity=&entityId=&from=&to=&q=&signIns=&limit=&offset=  → AuditPage (admin)
 *  - GET  /audit/:entity/:entityId → AuditEntryDetail[] (admin; a leader for their own team's gauge entries)
 *  - POST /announcements/:id/read  → 204 (any signed-in user; idempotent)
 *  - GET  /announcements/reads[?ids=]  → AnnouncementReadStats[] (admin: every announcement; others: the ones they wrote)
 * Recorded by lib/audit.ts (every successful write; snapshots for the routes in lib/auditSpecs.ts). Docs: docs/LOGIC.md §15.5.
 * Snapshots never contain PINs, two-step secrets, recovery codes, session tokens or passwords (keys are redacted).
 */
import type { Role, UserStatus } from '../types.ts';

export type AuditEntity =
  | 'payroll_run'
  | 'gauge_entry'
  | 'user'
  | 'candidate'
  | 'event'
  | 'campaign'
  | 'pitch'
  | 'settings'
  | 'announcement'
  | 'expense'
  | 'learning'
  | 'check_in'
  // Release 1.3 (r3-foundation): the records the new packages write (each package's audit specs use its own).
  | 'campaign_rate' // P1: campaign_rates
  | 'pay_adjustment' // P1: bonuses and manual / statement adjustments
  | 'invoice' // P2
  | 'agreement' // P2: self-billing agreement acceptance
  | 'statement' // P3
  | 'video' // P5
  | 'client_post' // P6
  | 'client_account' // P6
  | 'interview_question' // P7
  | 'event_roster' // P8: bookings, filed under the event id
  | 'export' // P9: client-side exports (CSV / PDF), no entity id
  // Release 1.4 (F): paying people from Linear Hub
  | 'payment_connection'
  | 'payment_batch'
  | 'bank_account'; // filed under the person's user id

export interface AuditEntry {
  id: number;
  /** ISO timestamp (real clock). */
  at: string;
  userId: number | null;
  userName: string | null;
  /** Method and route pattern, e.g. "POST /finance/payroll/:id/pay". */
  action: string;
  entity: AuditEntity | null;
  entityId: number | null;
  /** Readable, e.g. "Marked paid: Jordan Lee w/c 5 Oct, £945". */
  summary: string;
  /** Admin only (null for everyone else). */
  ip: string | null;
  /**
   * Release 1.3 (P9): what kind of action the row records (a change, a sign-in or failed attempt, an export, an opened
   * record, an automatic step, a client-portal action). Always sent from 1.3; optional for older callers.
   */
  kind?: AuditEventKind;
  /** Release 1.3 (P9): the role of the person who acted (null for "Linear Hub" and unknown people). */
  userRole?: Role | null;
}

export interface AuditFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AuditEntryDetail extends AuditEntry {
  before: unknown | null;
  after: unknown | null;
  /** Field-level differences between before and after (empty when there are no snapshots). */
  diff: AuditFieldChange[];
}

/** GET /audit */
export interface AuditPage {
  rows: AuditEntryDetail[];
  total: number;
}

/** GET /announcements/reads — "Read by 18 of 34"; names only for admins and the author. */
export interface AnnouncementReadStats {
  announcementId: number;
  readCount: number;
  /** Active people who could read it. */
  audience: number;
  readers?: { userId: number; name: string; readAt: string }[];
}

// ───────────────────────────── Release 1.3 (P9 audit-everything) ─────────────────────────────
//
// Lead decision: audit "every action" = every change, every sign-in/out and failed attempt, every export or download
// (CSV, PDF, pay export, invoice), every opening of a sensitive record (an invoice, a candidate profile, the audit
// trail), every client-portal action and every automatic step (statement fetched, statement applied). Not every page
// view.
//
// Endpoints (owned by P9):
//  - POST /audit/events  ClientAuditEventInput → 204 (routes/auditEvents.ts, mounted at /audit/events before the audit
//    router; any signed-in staff member; at most AUDIT_EVENTS_PER_MINUTE a minute per person, 429 after that;
//    validated kinds and fields only, else 400; an opened record the caller may not open → 403, an unknown one → 404).
//  - GET /audit gains `kind=` (one AuditEventKind or a comma list) and `view=everything|changes`; every row carries
//    `kind` and `userRole`.
//  - GET /audit/people → AuditPerson[] (everyone the trail can name, client accounts included: the Person filter).
//  - GET /audit/person/:userId?kind=&limit=&offset= → AuditPersonActivity (Team → person → Activity).
// Server helpers (server/src/lib/audit/events.ts, owned by P9): recordSystemEvent (actor "Linear Hub"),
// recordClientEvent, and the spec registry server/src/lib/audit/registry.ts.

/** What kind of action an audit row records (the Audit page's filter). */
export type AuditEventKind = 'change' | 'sign_in' | 'export' | 'opened' | 'automatic' | 'client';
export const AUDIT_EVENT_KINDS: readonly AuditEventKind[] = ['change', 'sign_in', 'export', 'opened', 'automatic', 'client'];

/** GET /audit `view`: everything (the default) or the changes only (kind `change`). */
export type AuditView = 'everything' | 'changes';

/** The two kinds a page may report itself (POST /audit/events). */
export type ClientAuditEventKind = 'export' | 'opened';
export type AuditExportFormat = 'csv' | 'pdf' | 'xero' | 'sage' | 'print';
export const AUDIT_EXPORT_FORMATS: readonly AuditExportFormat[] = ['csv', 'pdf', 'xero', 'sage', 'print'];

/** POST /audit/events limits: `what` up to 80 characters, `filename` up to 120, `rows` 0 to 1,000,000. */
export const AUDIT_EVENT_WHAT_MAX = 80;
export const AUDIT_EVENT_FILENAME_MAX = 120;
export const AUDIT_EVENT_ROWS_MAX = 1_000_000;
/** POST /audit/events: at most this many reports per person per minute (429 after that). */
export const AUDIT_EVENTS_PER_MINUTE = 60;
/** The same person opening the same record again within this many minutes adds no row. */
export const AUDIT_OPENED_REPEAT_MINUTES = 5;

/** POST /audit/events — reported by the client: an export it built, or a sensitive record it opened. */
export interface ClientAuditEventInput {
  kind: ClientAuditEventKind;
  /** Exports: the format. */
  format?: AuditExportFormat;
  /** What was exported or opened, e.g. "gauges-by-team", "invoice", "candidate". */
  what: string;
  /** Exports: how many rows went into the file. */
  rows?: number;
  filename?: string;
  /**
   * Opened records: which one. Exports (release 1.3 review): an export of ONE record (a candidate profile PDF, an
   * invoice PDF or print) names it too, so the row is filed under that record and follows its access rule.
   */
  entity?: AuditEntity;
  entityId?: number;
}

/**
 * Release 1.3 (P9): why a failed sign-in or security check was recorded — the `reason` in its row's snapshot (server
 * lib/audit/signIns.ts writes only these; shared AUDIT_SIGN_IN_REASON_LABELS says them in words).
 */
export const AUDIT_SIGN_IN_REASONS = [
  'wrong_employee_id', 'deactivated', 'unknown_email', 'wrong_pin', 'pin_locked_now', 'pin_locked', 'too_many_attempts',
  'wrong_code', 'too_many_codes', 'challenge_expired', 'wrong_current_pin',
] as const;
export type AuditSignInReason = (typeof AUDIT_SIGN_IN_REASONS)[number];

/**
 * GET /audit/people — one person the trail can name (staff and client accounts, any status): what the Person filter
 * shows, nothing more (no employee IDs or client access codes).
 */
export interface AuditPerson {
  id: number;
  name: string;
  role: Role;
  status: UserStatus;
}

/** GET /audit/person/:userId — one person's timeline (what they did, newest first) and a short sign-in summary. */
export interface AuditPersonActivity extends AuditPage {
  person: AuditPerson;
  /** Their latest successful sign-in (UTC ISO), or null. */
  lastSignInAt: string | null;
  /** Their latest row of any kind (UTC ISO), or null — not counting failed tries on the sign-in page (maybe somebody else's). */
  lastActiveAt: string | null;
  /** Failed sign-ins, wrong PINs and wrong two-step codes on their account in the last 30 days. */
  failedSignIns: number;
}
