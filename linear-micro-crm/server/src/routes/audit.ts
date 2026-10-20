/**
 * Release 1.2 — /audit and announcement read receipts — OWNED BY U3 audit-trail (laid down by r2-foundation as a stub).
 *
 *  GET  /audit?userId=&entity=&entityId=&from=&to=&limit=&offset=  → AuditPage (admin)
 *  GET  /audit/:entity/:entityId   → AuditEntryDetail[] (admin; leader: their own team's gauge entries)
 *  POST /announcements/:id/read    → 204 (any signed-in user; idempotent)         [announcementReadsRouter]
 *  GET  /announcements/reads       → AnnouncementReadStats[] (admin: all; others: the ones they wrote)
 * The recording itself is lib/audit.ts (middleware + recordAudit). Types: shared/src/types/audit.ts.
 * Mounted in app.ts: auditRouter at /audit; announcementReadsRouter at /announcements BEFORE the announcements router.
 */
import { Router } from 'express';
import type { AnnouncementReadStats, AuditEntryDetail, AuditPage } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

export function auditRouter(db: Db): Router {
  void db;
  const router = Router();
  // STUB (U3): nothing recorded yet.
  router.get('/', requireRole('admin'), (_req, res) => {
    const body: AuditPage = { rows: [], total: 0 };
    res.json(body);
  });
  router.get('/:entity/:entityId', requireRole('admin', 'leader'), (_req, res) => {
    const body: AuditEntryDetail[] = [];
    res.json(body);
  });
  return router;
}

export function announcementReadsRouter(db: Db): Router {
  void db;
  const router = Router();
  // STUB (U3)
  router.get('/reads', (req, res) => {
    currentUser(req);
    const body: AnnouncementReadStats[] = [];
    res.json(body);
  });
  router.post('/:id/read', () => {
    throw new HttpError(501, 'Read receipts are not available yet');
  });
  return router;
}
