/**
 * Release 1.2 — POST /gauges/bulk — OWNED BY U2 bulk-entry (laid down by r2-foundation as a stub).
 *
 *  POST /gauges/bulk  BulkGaugeInput → 200 BulkGaugeResult | 400 { error, details: { rows: BulkRowError[] } }
 * Leader: own team's events and members; admin: any. All rows or nothing (one transaction). Reuse the single-entry
 * rules exported by routes/gauges.ts (gaugeBody, assertFunnel, assertGaugeIntegrity, checkInFor, rateSnapshot) and
 * db/maintenance.ts (assertWeekUnpaidFor, syncPayrollForEntry) so a bulk row is exactly a POST /gauges row.
 * Mounted in app.ts at /gauges/bulk BEFORE the /gauges router. Types: shared/src/types/bulk.ts.
 */
import { Router } from 'express';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

export function bulkGaugesRouter(db: Db): Router {
  void db;
  const router = Router();
  router.post('/', requireRole('admin', 'leader'), () => {
    throw new HttpError(501, 'Bulk entry is not available yet');
  });
  return router;
}
