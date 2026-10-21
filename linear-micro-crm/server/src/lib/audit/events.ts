/**
 * Release 1.3 — OWNED BY P9 audit-everything (laid down by r3-foundation). Audit rows that are not a route's write:
 *
 *  - recordSystemEvent(db, event): an automatic step (P3: statement fetched / parsed / applied; P2: invoices issued,
 *    deemed accepted). Actor "Linear Hub" (user_id NULL), action "SYSTEM <name>" (e.g. "SYSTEM statements.fetch").
 *    Works now (one plain row through recordAudit); P9 may add the kind and wording.
 *  - recordClientEvent(db, me, input, ip): what POST /audit/events records (exports with row counts, opened records).
 *    Stub: records nothing.
 * Snapshots pass through recordAudit's redaction like every other row.
 */
import type { AuditEntity, ClientAuditEventInput, UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { recordAudit } from '../audit.ts';

export interface SystemEvent {
  /** Dotted, e.g. "statements.fetch", "invoices.issue". */
  name: string;
  summary: string;
  entity?: AuditEntity | null;
  entityId?: number | null;
  after?: unknown;
}

/** One audit row for an automatic step (actor "Linear Hub"). Never throws into the job that calls it. */
export function recordSystemEvent(db: Db, event: SystemEvent): void {
  try {
    recordAudit(db, { userId: null, action: `SYSTEM ${event.name}`, entity: event.entity ?? null, entityId: event.entityId ?? null, summary: event.summary, after: event.after });
  } catch (err) {
    console.error(`Audit trail (system event ${event.name}) failed; the job was not affected`, err);
  }
}

/** STUB (P9): record a client-reported export or opened record. */
export function recordClientEvent(db: Db, me: UserWithTeam, input: ClientAuditEventInput, ip: string | null): void {
  void db;
  void me;
  void input;
  void ip;
}
