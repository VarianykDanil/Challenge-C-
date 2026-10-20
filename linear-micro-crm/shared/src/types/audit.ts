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
  | 'check_in';

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
