// Release 1.3 — P9 audit-everything: what a page reports to the audit trail — OWNED BY P9 (laid down by r3-foundation).
// Endpoint: POST /audit/events (server/src/routes/auditEvents.ts). STABLE: P4's exports and P9's RecordOpened slot call
// reportAuditEvent; it never throws, never blocks the export or the page, and stays quiet when it cannot reach the
// server (the export already happened on the device).
import type { ClientAuditEventInput } from '@lm/shared';
import { api } from './client';

/** Report an export (CSV / PDF, with its row count) or an opened sensitive record. Fire and forget. */
export function reportAuditEvent(event: ClientAuditEventInput): void {
  void api<void>('/audit/events', { method: 'POST', json: event }).catch(() => undefined);
}
