/**
 * Release 1.3 — OWNED BY P3 statements (laid down empty by r3-foundation). This package's audit specs: one entry per write
 * route it adds, in the shape of lib/auditSpecs.ts (AuditRouteSpec: method, pattern, before, after → AuditDraft[]),
 * registered through ./registry.ts (P9 owns the registry; this file is the only one this package edits for audit).
 * P9's coverage test fails for any write route without a spec. Routes to cover:
 * POST /statements/upload, POST /statements/:id/apply, PUT /statements/:id/rows/:rowId, POST /statements/check-now, PUT /statements/mail (never the app password), POST /statements/mail/test, PUT /statements/senders, PUT /statements/templates/:campaignId, PUT /statements/client-refs/:userId.
 * Snapshots never include PINs, passwords, app passwords, secrets, tokens or codes (lib/audit.ts redacts again).
 */
import type { AuditRouteSpec } from '../auditSpecs.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [];
