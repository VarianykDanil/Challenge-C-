/**
 * Release 1.2 — GET /finance/payroll/export — OWNED BY U5 office-tools (laid down by r2-foundation as a stub).
 *
 *  GET /finance/payroll/export?weekStart=YYYY-MM-DD&format=xero|sage → text/csv attachment (admin only): the week's
 *  payroll runs for Xero Payroll or Sage (columns: shared PayExportRow), formula-injection guarded.
 * Mounted in app.ts at /finance/payroll/export BEFORE the /finance router (whose /payroll/:id would catch "export").
 */
import { Router } from 'express';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

export function payExportRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/', requireRole('admin'), () => {
    throw new HttpError(501, 'Payroll export is not available yet');
  });
  return router;
}
