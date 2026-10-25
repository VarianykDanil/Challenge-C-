/**
 * Release 1.4 — OWNED BY F payments-foundation. Mounted at /payments (app.ts), administrators only: every route answers
 * 401 signed out, 403 for every other role (and for client accounts, from the client guard before this router).
 * Contracts: shared/src/types/payments.ts. Logic: lib/payments/*. Every write has an audit spec
 * (lib/audit/paymentSpecs.ts) and the per-person write limit (middleware/writeLimit.ts).
 */
import { Router } from 'express';
import type { PaymentApproveInput, PaymentBatchInput, PaymentConnectionInput, PaymentConnectionPatch, PaymentMarkPaidInput } from '@lm/shared';
import { formatPence } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { recordAudit } from '../lib/audit.ts';
import { idParam } from '../lib/validate.ts';
import { approveBatch, batchDetail, batchFile, cancelBatch, createDraftBatch, listBatches, markFileBatchPaid, refreshBatch } from '../lib/payments/batches.ts';
import { codeSource } from '../lib/payments/code.ts';
import { createConnection, disconnectConnection, listConnections, testConnection, updateConnection } from '../lib/payments/connections.ts';
import { listPaymentProviders, providerView } from '../lib/payments/registry.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const body = <T>(raw: unknown): T => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as T;

export function paymentsRouter(db: Db): Router {
  const router = Router();
  router.use(requireRole('admin'));

  // ── ways to pay and connections ──
  router.get('/providers', (_req, res) => {
    res.json(listPaymentProviders().map(providerView));
  });

  router.get('/connections', (_req, res) => {
    res.json(listConnections(db));
  });

  router.post('/connections', (req, res) => {
    res.status(201).json(createConnection(db, currentUser(req), body<PaymentConnectionInput>(req.body)));
  });

  router.patch('/connections/:id', (req, res) => {
    res.json(updateConnection(db, currentUser(req), idParam(req), body<PaymentConnectionPatch>(req.body)));
  });

  router.delete('/connections/:id', (req, res) => {
    res.json(disconnectConnection(db, currentUser(req), idParam(req)));
  });

  router.post('/connections/:id/test', async (req, res) => {
    res.json(await testConnection(db, idParam(req)));
  });

  // ── batches ──
  router.get('/batches', (req, res) => {
    const raw = Number(req.query.limit ?? 50);
    res.json(listBatches(db, Number.isFinite(raw) ? raw : 50));
  });

  router.post('/batches', (req, res) => {
    res.status(201).json(createDraftBatch(db, currentUser(req), body<PaymentBatchInput>(req.body)));
  });

  router.get('/batches/:id', (req, res) => {
    res.json(batchDetail(db, idParam(req)));
  });

  router.post('/batches/:id/approve', async (req, res) => {
    res.json(await approveBatch(db, currentUser(req), idParam(req), body<PaymentApproveInput>(req.body).code, codeSource(req)));
  });

  router.post('/batches/:id/refresh', async (req, res) => {
    res.json(await refreshBatch(db, idParam(req), currentUser(req)));
  });

  router.post('/batches/:id/cancel', async (req, res) => {
    res.json(await cancelBatch(db, currentUser(req), idParam(req)));
  });

  router.post('/batches/:id/mark-paid', (req, res) => {
    res.json(markFileBatchPaid(db, currentUser(req), idParam(req), body<PaymentMarkPaidInput>(req.body)));
  });

  /** The bank file (it holds account numbers): never cached, recorded in the audit trail as an export. */
  router.get('/batches/:id/file', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const file = batchFile(db, id);
    const batch = batchDetail(db, id);
    // review fix (cross:X-4): what is IN the file — a line the bank format refused is not (no file reference)
    const inFile = batch.items.filter((i) => i.providerRef);
    const count = inFile.length;
    const totalPence = inFile.reduce((sum, i) => sum + i.amountPence, 0);
    try {
      recordAudit(db, {
        userId: me.id, action: 'GET /payments/batches/:id/file', entity: 'payment_batch', entityId: id, kind: 'export', actorRole: me.role,
        summary: `Downloaded the bank file for payment #${id}: ${count} ${count === 1 ? 'person' : 'people'}, ${formatPence(totalPence)}`,
        after: { fileName: file.name, count, totalPence }, ip: req.ip ?? null,
      });
    } catch (err) {
      console.error('Audit trail (bank file download) failed', err);
    }
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/[^A-Za-z0-9._-]+/g, '-')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.body);
  });

  return router;
}
