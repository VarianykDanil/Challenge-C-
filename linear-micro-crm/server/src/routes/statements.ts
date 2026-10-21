/**
 * Release 1.3 — /statements (commission statements from the clients: mail settings, senders, templates, the parsed
 * statements, applying them to pay, people's client fundraiser IDs) — admin only — OWNED BY P3 statements (laid down by
 * r3-foundation as a stub: reads answer empty data, writes 501).
 *
 *  GET  /statements?campaignId=&status=        → StatementSummary[]
 *  GET  /statements/mail, PUT …  MailSettingsInput → MailSettings (the app password is write-only)
 *  POST /statements/mail/test                  → MailTestResult
 *  GET  /statements/senders, PUT … StatementSender[] → StatementSender[]
 *  GET  /statements/templates/:campaignId, PUT … StatementColumnMapping → StatementTemplate
 *  GET  /statements/client-refs?userId=, PUT /statements/client-refs/:userId ClientRef[] → ClientRef[]
 *  POST /statements/check-now                  → CheckNowResult
 *  POST /statements/upload                     → 201 StatementSummary (a PDF)
 *  GET  /statements/:id                        → StatementDetail
 *  GET  /statements/:id/file                   → the PDF
 *  POST /statements/:id/apply                  → StatementDetail
 *  PUT  /statements/:id/rows/:rowId  StatementRowMatchInput → StatementRow
 * Types: shared/src/types/statements.ts. Job: lib/statements/job.ts. Audit specs: lib/audit/statementSpecs.ts.
 */
import { Router } from 'express';
import type { ClientRef, MailSettings, StatementSender, StatementSummary } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

const notYet = () => {
  throw new HttpError(501, 'Commission statements are not available yet');
};

export function statementsRouter(db: Db): Router {
  void db;
  const router = Router();
  // Every /statements path is the office's (this router has the prefix to itself).
  router.use(requireRole('admin'));
  router.get('/', (_req, res) => {
    const rows: StatementSummary[] = [];
    res.json(rows);
  });
  router.get('/mail', (_req, res) => {
    const body: MailSettings = { address: null, hasPassword: false, enabled: false, lastCheckAt: null, lastError: null };
    res.json(body);
  });
  router.put('/mail', notYet);
  router.post('/mail/test', notYet);
  router.get('/senders', (_req, res) => {
    const rows: StatementSender[] = [];
    res.json(rows);
  });
  router.put('/senders', notYet);
  router.get('/templates/:campaignId', () => {
    throw notFound('Statement template');
  });
  router.put('/templates/:campaignId', notYet);
  router.get('/client-refs', (_req, res) => {
    const rows: ClientRef[] = [];
    res.json(rows);
  });
  router.put('/client-refs/:userId', notYet);
  router.post('/check-now', notYet);
  router.post('/upload', notYet);
  router.get('/:id', () => {
    throw notFound('Statement');
  });
  router.get('/:id/file', () => {
    throw notFound('Statement');
  });
  router.post('/:id/apply', notYet);
  router.put('/:id/rows/:rowId', notYet);
  return router;
}
