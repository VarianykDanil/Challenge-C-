/**
 * Release 1.3 — OWNED BY P9 audit-everything (laid down by r3-foundation). Audit rows that are not a route's write:
 *
 *  - recordSystemEvent(db, event): an automatic step (P3: statement fetched / parsed / applied; P2: invoices issued,
 *    deemed accepted). Actor "Linear Hub" (user_id NULL), action "SYSTEM <name>" (e.g. "SYSTEM statements.fetch"),
 *    kind `automatic`. Never throws into the job that calls it.
 *  - recordClientEvent(db, me, input, ip, label): what POST /audit/events records — an export a page built (kind
 *    `export`, action "EVENT export": "Exported Gauges by team as CSV: 124 rows", the format, row count and file name in
 *    the snapshot) or a sensitive record a page opened (kind `opened`, action "EVENT opened": "Opened the candidate
 *    profile: Sam Brown", "Opened the payslip: Jordan Lee w/c 12 Oct", "Opened the audit trail"). An export of ONE
 *    record (P7's candidate profile and interview sheet PDFs, P2's invoice PDF and print) keeps that record on its row
 *    and names it: "Exported the candidate profile as PDF: Mia Parker", "Printed the invoice LM-SB-2026-000123: Jordan
 *    Lee w/c 12 Oct", so it shows under the record (the Record filter) and a name search finds it; an export of a table
 *    is filed under the trail's own `export` entity. The same person opening the same record again within
 *    AUDIT_OPENED_REPEAT_MINUTES adds no row (a page re-mounting, a phone going back and forth; `what` compared without
 *    case), so the trail lists openings, not re-renders. Exports are never merged: each is a file.
 *  - openedRecord(db, me, entity, entityId): may `me` open that record, and what is it called? The route answers 403 /
 *    404 from it — for an opening and for an export of a record alike — so nobody can write "Jordan opened (or
 *    exported) Sam Brown's profile" when Jordan cannot open it. openedLabel(opened, what) is what the row calls it.
 * Snapshots pass through recordAudit's redaction like every other row.
 */
import {
  AUDIT_ENTITY_LABELS,
  AUDIT_EVENT_EXPORT_ACTION,
  AUDIT_EXPORT_FORMAT_LABELS,
  AUDIT_EVENT_OPENED_ACTION,
  AUDIT_OPENED_REPEAT_MINUTES,
  AUDIT_SYSTEM_PREFIX,
  auditExportSummary,
  auditWeekLabel,
  type AuditEntity,
  type ClientAuditEventInput,
  type UserWithTeam,
} from '@lm/shared';
import { get, type Db } from '../../db/connection.ts';
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
    recordAudit(db, {
      userId: null,
      action: `${AUDIT_SYSTEM_PREFIX}${event.name}`,
      entity: event.entity ?? null,
      entityId: event.entityId ?? null,
      summary: event.summary,
      after: event.after,
      kind: 'automatic',
    });
  } catch (err) {
    console.error(`Audit trail (system event ${event.name}) failed; the job was not affected`, err);
  }
}

/** What an opened record is called, or why it may not be reported. */
/** `label`: what the record is called ("Sam Brown"); `named`/`short`: when the page's `what` already names it ("invoice LM-SB-2026-000123"), `short` is said instead. */
export type OpenedRecord = { label: string; named?: string; short?: string } | { refused: 'forbidden' | 'not_found' };

const soft = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const RECRUITMENT_ROLES = new Set(['admin', 'leader', 'recruiter']);

/** A pay run's owner and team (the rule of GET /finance/payroll/:id: admin, the person, their team's leader). */
function payRunAccess(db: Db, me: UserWithTeam, runId: number): { label: string } | { refused: 'forbidden' | 'not_found' } {
  const run = get<{ userId: number; teamId: number | null; name: string; weekStart: string }>(
    db,
    `SELECT p.user_id AS userId, u.team_id AS teamId, u.first_name || ' ' || u.last_name AS name, p.week_start AS weekStart
     FROM payroll_runs p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    [runId],
  );
  if (!run) return { refused: 'not_found' };
  const allowed = me.role === 'admin' || run.userId === me.id || (me.role === 'leader' && me.teamId !== null && run.teamId === me.teamId);
  return allowed ? { label: `${run.name} ${auditWeekLabel(run.weekStart)}` } : { refused: 'forbidden' };
}

/**
 * May `me` open this record, and what is it called? Candidates: recruitment roles (as GET /recruitment/candidates/:id).
 * Pay runs: admin, the person, their team's leader (GET /finance/payroll/:id). Invoices (P2's table): the same rule,
 * through the invoice's pay run. The audit trail itself (no entity): administrators. Any other record: administrators.
 */
export function openedRecord(db: Db, me: UserWithTeam, entity: AuditEntity | null, entityId: number | null): OpenedRecord {
  if (entity === null) return me.role === 'admin' ? { label: '' } : { refused: 'forbidden' };
  if (entityId === null) return { refused: 'not_found' };
  if (entity === 'candidate') {
    if (!RECRUITMENT_ROLES.has(me.role)) return { refused: 'forbidden' };
    const c = get<{ name: string }>(db, `SELECT first_name || ' ' || last_name AS name FROM candidates WHERE id = ?`, [entityId]);
    return c ? { label: c.name } : { refused: 'not_found' };
  }
  if (entity === 'payroll_run') return payRunAccess(db, me, entityId);
  if (entity === 'invoice') {
    const inv = soft(() => get<{ runId: number; number: string }>(db, `SELECT payroll_run_id AS runId, number FROM invoices WHERE id = ?`, [entityId]), undefined);
    if (!inv) return { refused: 'not_found' };
    const run = payRunAccess(db, me, inv.runId);
    return 'refused' in run ? run : { label: `${inv.number} (${run.label})`, named: inv.number, short: run.label };
  }
  if (me.role !== 'admin') return { refused: 'forbidden' };
  return { label: `${AUDIT_ENTITY_LABELS[entity]} #${entityId}` };
}

/**
 * What a row calls the record `openedRecord` allowed: its label ("Sam Brown"), or — when the page's `what` names it
 * already ("invoice LM-SB-2026-000123") — whose it is instead of the number twice ("Jordan Lee w/c 12 Oct").
 */
export function openedLabel(opened: { label: string; named?: string; short?: string }, what: string): string {
  return opened.named && opened.short && what.includes(opened.named) ? opened.short : opened.label;
}

/** "payslip" → "the payslip"; "audit trail" → "the audit trail". */
const theWhat = (what: string) => {
  const w = what.trim().replace(/\s+/g, ' ');
  return /^(the|a|an)\s/i.test(w) ? w : `the ${w}`;
};

const ROWS = new Intl.NumberFormat('en-GB');

/** True when every word of `label` is in `what` already ("BCN 5–11 Oct 2026" in "BCN statement for 5–11 Oct 2026"). */
const saysAlready = (what: string, label: string) => {
  const w = what.toLowerCase();
  const words = label.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((x) => w.includes(x));
};

/**
 * An export of one record: "Exported the candidate profile as PDF: Mia Parker" · "Printed the invoice LM-SB-2026-000123:
 * Jordan Lee w/c 12 Oct" · with a row count "… as CSV: Mia Parker (12 rows)"; a `what` that names the record already
 * is not followed by its name again (P3's download: "Exported the BCN statement for 5–11 Oct 2026 as PDF"). (A table's
 * export reads as shared auditExportSummary: "Exported Gauges by team as CSV: 124 rows".)
 */
export function recordExportSummary(input: Pick<ClientAuditEventInput, 'what' | 'format' | 'rows'>, label: string): string {
  const the = theWhat(input.what);
  const named = label && !saysAlready(input.what, label) ? `: ${label}` : '';
  const rows = typeof input.rows === 'number' && Number.isFinite(input.rows) ? ` (${ROWS.format(input.rows)} ${input.rows === 1 ? 'row' : 'rows'})` : '';
  if (input.format === 'print') return `Printed ${the}${named}${rows}`;
  const as = input.format ? ` as ${AUDIT_EXPORT_FORMAT_LABELS[input.format]}` : '';
  return `Exported ${the}${as}${named}${rows}`;
}

/**
 * Has `userId` opened this record within the repeat window already? (one indexed lookup: user_id, at). `what` is
 * compared without case: "Candidate Profile" and "candidate profile" are the same opening.
 */
function openedRecently(db: Db, userId: number, entity: AuditEntity | null, entityId: number | null, what: string): boolean {
  const since = new Date(Date.now() - AUDIT_OPENED_REPEAT_MINUTES * 60_000).toISOString();
  return Boolean(
    get(
      db,
      `SELECT 1 FROM audit_log WHERE user_id = ? AND at >= ? AND action = ? AND entity IS ? AND entity_id IS ? AND lower(json_extract(after_json, '$.what')) IS lower(?)`,
      [userId, since, AUDIT_EVENT_OPENED_ACTION, entity, entityId, what],
    ),
  );
}

/** The record an export report names, if any ('export' is the trail's own entity for a table's export, not a record). */
export function exportedRecord(input: { entity?: AuditEntity | null; entityId?: number | null }): { entity: AuditEntity; entityId: number | null } | null {
  const entity = input.entity ?? null;
  if (entity === null || entity === 'export') return null;
  return { entity, entityId: input.entityId ?? null };
}

/**
 * Records what POST /audit/events reported (already validated by the route; `label` from openedLabel for an opened
 * or exported record, which the route has checked `me` may open). Returns false when nothing was written (the same
 * record opened again within the repeat window).
 */
export function recordClientEvent(db: Db, me: UserWithTeam, input: ClientAuditEventInput, ip: string | null, label = ''): boolean {
  if (input.kind === 'export') {
    const record = exportedRecord(input);
    const file = { what: input.what, format: input.format ?? null, rows: input.rows ?? null, filename: input.filename ?? null };
    recordAudit(db, {
      userId: me.id,
      action: AUDIT_EVENT_EXPORT_ACTION,
      entity: record?.entity ?? 'export',
      entityId: record?.entityId ?? null,
      summary: record ? recordExportSummary(input, label) : auditExportSummary(input),
      after: record ? { ...file, record: label || null } : file,
      ip,
      kind: 'export',
      actorRole: me.role,
    });
    return true;
  }
  const entity = input.entity ?? null;
  const entityId = entity === null ? null : (input.entityId ?? null);
  if (openedRecently(db, me.id, entity, entityId, input.what)) return false;
  const summary = entity === null ? `Opened ${theWhat(input.what)}` : `Opened ${theWhat(input.what)}: ${label}`;
  recordAudit(db, {
    userId: me.id,
    action: AUDIT_EVENT_OPENED_ACTION,
    entity,
    entityId,
    summary,
    after: { what: input.what, record: label || null },
    ip,
    kind: 'opened',
    actorRole: me.role,
  });
  return true;
}
