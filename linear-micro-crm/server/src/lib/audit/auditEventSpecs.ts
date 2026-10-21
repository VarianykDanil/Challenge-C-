/**
 * Release 1.3 — OWNED BY P9 audit-everything (laid down by r3-foundation). Specs for P9's own write routes.
 * POST /audit/events (a page reporting an export or an opened record) is `skip: true` while it is a stub, so a report
 * never writes a generic "POST /audit/events" row; P9 records those events itself (lib/audit/events.ts) and replaces
 * this entry. Shape: lib/auditSpecs.ts AuditRouteSpec; registered through ./registry.ts.
 */
import type { AuditRouteSpec } from '../auditSpecs.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  { method: 'POST', pattern: '/audit/events', skip: true, after: () => [] },
];
