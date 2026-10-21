/**
 * Release 1.3 — OWNED BY P2 invoices (laid down empty by r3-foundation). This package's audit specs: one entry per write
 * route it adds, in the shape of lib/auditSpecs.ts (AuditRouteSpec: method, pattern, before, after → AuditDraft[]),
 * registered through ./registry.ts (P9 owns the registry; this file is the only one this package edits for audit).
 * P9's coverage test fails for any write route without a spec. Routes to cover:
 * POST /invoices/agreement/accept, PUT /invoices/profile(/:userId), POST /invoices/:id/accept | dispute | resolve, PUT /invoices/company — and the Mark-paid override reason (P2 may register its own POST /finance/payroll/:id/pay spec here: package specs are matched before the 1.2 ones).
 * Snapshots never include PINs, passwords, app passwords, secrets, tokens or codes (lib/audit.ts redacts again).
 */
import type { AuditRouteSpec } from '../auditSpecs.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [];
