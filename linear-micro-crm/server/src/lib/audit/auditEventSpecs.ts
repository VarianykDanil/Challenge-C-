/**
 * Release 1.3 — OWNED BY P9 audit-everything. Specs for P9's own write routes.
 * POST /audit/events (a page reporting an export or an opened record) records its own row, with its own kind and
 * wording (routes/auditEvents.ts → lib/audit/events.ts recordClientEvent: "Exported Gauges by team as CSV: 124 rows",
 * "Opened the candidate profile: Sam Brown"), so the middleware skips it (`skip: true`) and never adds a second,
 * generic "POST /audit/events" row. The audit coverage test accepts a `skip` spec as a deliberate decision.
 * Shape: lib/auditSpecs.ts AuditRouteSpec; registered through ./registry.ts.
 */
import type { AuditRouteSpec } from '../auditSpecs.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  { method: 'POST', pattern: '/audit/events', skip: true, after: () => [] },
];
