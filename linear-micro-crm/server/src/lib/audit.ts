/**
 * Release 1.2 — the audit trail's recording side — OWNED BY U3 audit-trail (laid down by r2-foundation as a stub).
 *
 *  - auditMiddleware(db): mounted in app.ts on the /api router right after `authenticate` and the PIN gate, before the
 *    routers. U3 makes it record every successful mutating request (method, route pattern, user, status, ip) and, for
 *    registered entities, before/after snapshots loaded by small loaders keyed by route pattern, with a readable
 *    summary. It must never throw into the request and never store PINs, two-step secrets, recovery codes, session
 *    tokens or passwords (shared AUDIT_REDACTED_KEYS). Stub: pass-through.
 *  - recordAudit(db, entry): for explicit records (e.g. a maintenance job). Stub: no-op.
 *  - purgeAuditLog(db): keep two years; called at start-up and nightly from index.ts. Stub: removes nothing.
 * The read side is routes/audit.ts. Request-scoped state may ride on `req.audit` (server/src/types/express.d.ts).
 */
import type { RequestHandler } from 'express';
import type { AuditEntity } from '@lm/shared';
import type { Db } from '../db/connection.ts';

/** One audit row to write (snapshots are redacted before they are stored). */
export interface AuditRecord {
  userId: number | null;
  /** Method and route pattern, e.g. "POST /finance/payroll/:id/pay". */
  action: string;
  entity?: AuditEntity | null;
  entityId?: number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** What the middleware keeps on the request between "before the handler" and "response finished" (U3 shapes it). */
export interface AuditRequestContext {
  entity?: AuditEntity | null;
  entityId?: number | null;
  before?: unknown;
  [key: string]: unknown;
}

/** Retention: rows older than this are purged. */
export const AUDIT_RETENTION_DAYS = 730;

/** STUB (U3): writes nothing yet. */
export function recordAudit(db: Db, entry: AuditRecord): void {
  void db;
  void entry;
}

/** STUB (U3): pass-through. */
export function auditMiddleware(db: Db): RequestHandler {
  void db;
  return (_req, _res, next) => next();
}

/** STUB (U3): deletes rows older than AUDIT_RETENTION_DAYS; returns how many. */
export function purgeAuditLog(db: Db): number {
  void db;
  return 0;
}
