/**
 * Release 1.3 — OWNED BY P8 venue-insights (laid down empty by r3-foundation). This package's audit specs: one entry per write
 * route it adds, in the shape of lib/auditSpecs.ts (AuditRouteSpec: method, pattern, before, after → AuditDraft[]),
 * registered through ./registry.ts (P9 owns the registry; this file is the only one this package edits for audit).
 * P9's coverage test fails for any write route without a spec. Routes to cover:
 * PUT /events/:id/roster, POST /events/:id/roster/me, DELETE /events/:id/roster/me (entity 'event_roster', filed under the event id).
 * Snapshots never include PINs, passwords, app passwords, secrets, tokens or codes (lib/audit.ts redacts again).
 */
import type { AuditRouteSpec } from '../auditSpecs.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [];
