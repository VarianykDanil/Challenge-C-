/**
 * Release 1.3 — /invoices (self-billing invoices, the agreement, the supplier profile, company settings, disputes) —
 * OWNED BY P2 invoices (laid down by r3-foundation as a stub: reads answer empty data, writes 501).
 *
 *  GET  /invoices/agreement                     → SelfBillingAgreement
 *  POST /invoices/agreement/accept              → SelfBillingAgreement
 *  GET  /invoices/profile, PUT /invoices/profile InvoiceProfileInput → InvoiceProfile (mine)
 *  GET  /invoices/profile/:userId, PUT …        → InvoiceProfile (admin)
 *  GET  /invoices/company, PUT /invoices/company CompanySettingsInput → CompanySettings (PUT admin)
 *  GET  /invoices/disputes                      → InvoiceDisputeRow[] (admin)
 *  GET  /invoices?userId=&weekStart=&status=    → InvoiceSummary[] (own; leader: own team; admin: all)
 *  GET  /invoices/by-run/:runId                 → Invoice (scoped like the payslip)
 *  GET  /invoices/:id                           → Invoice
 *  POST /invoices/:id/accept                    → Invoice (the supplier)
 *  POST /invoices/:id/dispute  InvoiceDisputeInput → Invoice (the supplier)
 *  POST /invoices/:id/resolve  InvoiceResolveInput → Invoice (admin)
 * Types: shared/src/types/invoices.ts. Hooks into finance: lib/invoices.ts. Audit specs: lib/audit/invoiceSpecs.ts.
 */
import { Router } from 'express';
import type { InvoiceDisputeRow, InvoiceSummary } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const notYet = () => {
  throw new HttpError(501, 'Self-billing invoices are not available yet');
};

export function invoicesRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/agreement', notYet);
  router.post('/agreement/accept', notYet);
  router.get('/profile', notYet);
  router.put('/profile', notYet);
  router.get('/profile/:userId', requireRole('admin'), notYet);
  router.put('/profile/:userId', requireRole('admin'), notYet);
  router.get('/company', notYet);
  router.put('/company', requireRole('admin'), notYet);
  router.get('/disputes', requireRole('admin'), (_req, res) => {
    const rows: InvoiceDisputeRow[] = [];
    res.json(rows);
  });
  router.get('/', (req, res) => {
    currentUser(req);
    const rows: InvoiceSummary[] = [];
    res.json(rows);
  });
  router.get('/by-run/:runId', () => {
    throw notFound('Invoice');
  });
  router.get('/:id', () => {
    throw notFound('Invoice');
  });
  router.post('/:id/accept', notYet);
  router.post('/:id/dispute', notYet);
  router.post('/:id/resolve', requireRole('admin'), notYet);
  return router;
}
