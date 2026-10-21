/**
 * Release 1.3 — POST /audit/events: a page reports an export it built (CSV / PDF, with the row count) or a sensitive
 * record it opened (an invoice, a candidate profile, the audit trail) — OWNED BY P9 audit-everything (laid down by
 * r3-foundation as a stub that accepts and records nothing, so callers can report from day one). Mounted at
 * /audit/events BEFORE the audit router. Any signed-in staff member (clients never reach it: the client guard).
 *
 *  POST /audit/events  ClientAuditEventInput → 204
 * P9: validate the kind (export | opened) and fields, rate-limit per person (middleware/writeLimit.ts), and record it
 * with lib/audit/events.ts recordClientEvent. The audit middleware skips this route (lib/audit/auditEventSpecs.ts).
 */
import { Router } from 'express';
import type { Db } from '../db/connection.ts';
import { currentUser } from '../middleware/auth.ts';

export function auditEventsRouter(db: Db): Router {
  void db;
  const router = Router();
  router.post('/', (req, res) => {
    currentUser(req);
    res.status(204).end();
  });
  return router;
}
