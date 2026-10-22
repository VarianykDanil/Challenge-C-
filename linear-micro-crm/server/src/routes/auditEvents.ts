/**
 * Release 1.3 — POST /audit/events: a page reports an export it built (CSV / PDF, with the row count) or a sensitive
 * record it opened (an invoice, a candidate profile, a payslip, the audit trail) — OWNED BY P9 audit-everything.
 * Mounted at /audit/events BEFORE the audit router. Any signed-in staff member (clients never reach it: the client
 * guard answers 403 first).
 *
 *  POST /audit/events  ClientAuditEventInput → 204
 *    kind      'export' | 'opened' (anything else → 400)
 *    what      required text, cut at 80 characters, e.g. "gauges-by-team", "candidate profile", "audit trail"
 *    format    exports: 'csv' | 'pdf' | 'xero' | 'sage' | 'print' (optional; anything else → 400)
 *    rows      exports: a whole number 0–1,000,000 (optional; anything else → 400)
 *    filename  exports: the file's name, cut at 120 characters (a path keeps its last part) (optional)
 *    entity, entityId   the record (an AuditEntity and a positive id). Opened: no entity = the audit trail itself.
 *                       Export: an export of ONE record (P7's candidate profile and interview sheet PDFs: 'candidate';
 *                       P2's invoice PDF and print: 'invoice'); no entity (or 'export') = an export of a table
 *  An opening, or an export of a record: 403 when the caller may not open that record (the rules of the record's own
 *  page), 404 when it does not exist or no id is sent; the row keeps the record and names it ("Exported the candidate
 *  profile as PDF: Mia Parker"). The same person opening the same record again within 5 minutes answers 204 and adds
 *  no row (exports are never merged).
 *  At most AUDIT_EVENTS_PER_MINUTE (60) reports a minute per person (middleware/writeLimit.ts; 429 after that).
 * Recorded with lib/audit/events.ts recordClientEvent; the audit middleware skips this route
 * (lib/audit/auditEventSpecs.ts), so a report never writes a second, generic row.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  AUDIT_EVENT_FILENAME_MAX,
  AUDIT_EVENT_ROWS_MAX,
  AUDIT_EVENT_WHAT_MAX,
  AUDIT_EXPORT_FORMATS,
  isAuditEntity,
  type AuditEntity,
  type AuditExportFormat,
  type ClientAuditEventInput,
} from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { exportedRecord, openedLabel, openedRecord, recordClientEvent } from '../lib/audit/events.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { currentUser } from '../middleware/auth.ts';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** One line of text: control characters and runs of spaces become one space; longer than `max` is cut, not refused. */
const text = (max: number) => z.string().transform((s) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trimEnd()).pipe(z.string().min(1, 'Required'));
/** A file name as the page saved it; a path keeps its last part only. */
const fileName = (max: number) => z.string().transform((s) => s.split(/[\\/]/).pop() ?? '').pipe(text(max));

/** Unknown keys are dropped, not refused: a newer page reporting an extra detail still gets its event recorded. */
const eventBody = z
  .object({
    kind: z.enum(['export', 'opened']),
    what: text(AUDIT_EVENT_WHAT_MAX),
    format: z.enum(AUDIT_EXPORT_FORMATS as [AuditExportFormat, ...AuditExportFormat[]]).optional(),
    rows: z.number().int().min(0).max(AUDIT_EVENT_ROWS_MAX).optional(),
    filename: fileName(AUDIT_EVENT_FILENAME_MAX).optional(),
    entity: z.string().refine(isAuditEntity, 'Invalid entity').nullable().optional(),
    entityId: z.number().int().positive().nullable().optional(),
  });

export function auditEventsRouter(db: Db): Router {
  const router = Router();
  router.post('/', (req, res) => {
    const me = currentUser(req);
    const body = eventBody.parse(req.body);
    const input: ClientAuditEventInput = {
      kind: body.kind,
      what: body.what,
      ...(body.format ? { format: body.format } : {}),
      ...(body.rows !== undefined ? { rows: body.rows } : {}),
      ...(body.filename ? { filename: body.filename } : {}),
    };
    let label = '';
    // an opening (of a record, or of the audit trail itself) and an export of one record follow the record's own rule
    const record = body.kind === 'opened' ? null : exportedRecord({ entity: (body.entity ?? null) as AuditEntity | null, entityId: body.entityId ?? null });
    if (body.kind === 'opened' || record) {
      const entity = record ? record.entity : ((body.entity ?? null) as AuditEntity | null);
      const entityId = entity === null ? null : (body.entityId ?? null);
      const opened = openedRecord(db, me, entity, entityId);
      if ('refused' in opened) {
        if (opened.refused === 'not_found') throw notFound('Record');
        throw forbidden('You cannot open that record');
      }
      label = openedLabel(opened, body.what);
      if (entity !== null) {
        input.entity = entity;
        input.entityId = entityId!;
      }
    }
    recordClientEvent(db, me, input, req.ip ?? null, label);
    res.status(204).end();
  });
  return router;
}
