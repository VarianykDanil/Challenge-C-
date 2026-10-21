/**
 * Release 1.2 — the audit trail's recording side — OWNED BY U3 audit-trail.
 *
 *  - auditMiddleware(db): mounted in app.ts on the /api router right after `authenticate` and the PIN gate, before the
 *    routers. For every POST / PUT / PATCH / DELETE it looks the path up in the route registry (lib/auditSpecs.ts):
 *    a registered route loads a "before" snapshot now, before the handler runs; when the handler answers 2xx the
 *    middleware loads the "after" snapshot (synchronously, at `res.end`, so nothing can slip in between) and writes one
 *    row — who, when, the method and route pattern, the entity and a readable summary ("Marked paid: Jordan Lee w/c
 *    5 Oct, £945"). Routes the registry does not know are still recorded (method, route pattern, user), without
 *    snapshots. Failed requests (4xx/5xx) write nothing. It never throws into the request: an audit failure is logged
 *    and the response goes out unchanged.
 *  - recordAudit(db, entry): one explicit row (also what the middleware uses). Snapshots are redacted
 *    (shared AUDIT_REDACTED_KEYS: PINs, two-step secrets, recovery codes, session tokens, passwords) before storage,
 *    and any text over 2,000 characters is stored as { length, sha256, head } (compactLongText), so a 19 KB pitch
 *    script costs a few hundred bytes per row while the diff can still tell that it changed.
 *  - A write that changed nothing writes no row: the registry's `after` answers [] for it (lib/auditSpecs.ts).
 *  - purgeAuditLog(db): keeps two years (AUDIT_RETENTION_DAYS); index.ts calls it at start-up and daily.
 * The read side is routes/audit.ts. Times are the real clock (UTC ISO), like sessions: an audit row says when it
 * really happened, whatever the business clock says.
 */
import { createHash } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { redactAuditSnapshot, type AuditEntity } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { matchAuditRoute, type AuditCall, type AuditDone, type AuditRouteSpec } from './auditSpecs.ts';

/** One audit row to write (snapshots are redacted before they are stored). */
export interface AuditRecord {
  userId: number | null;
  /** Method and route pattern, e.g. "POST /finance/payroll/:id/pay". */
  action: string;
  entity?: AuditEntity | null;
  entityId?: number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** What the middleware keeps on the request between "before the handler" and "response finished". */
export interface AuditRequestContext {
  entity?: AuditEntity | null;
  entityId?: number | null;
  before?: unknown;
  [key: string]: unknown;
}

/** Retention: rows older than this are purged. */
export const AUDIT_RETENTION_DAYS = 730;

/** A snapshot larger than this (as JSON, after long text is compacted) is stored as a short note instead. */
const SNAPSHOT_MAX_CHARS = 64_000;
const SUMMARY_MAX_CHARS = 500;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A text field longer than this many characters is stored as an AuditLongText instead of in full. */
export const AUDIT_LONG_TEXT_MIN = 2000;
/** How much of a long text is kept, so the trail can still show how it starts. */
export const AUDIT_LONG_TEXT_HEAD = 200;

/**
 * What a snapshot stores in place of a string longer than AUDIT_LONG_TEXT_MIN characters: its length, the SHA-256 of
 * the whole text (hex), so two versions compare equal exactly when the text is the same, and its first 200 characters.
 * The client's audit views render it under the field's label as "Changed · 19,204 characters" (features/audit/longText.ts).
 */
export interface AuditLongText {
  length: number;
  sha256: string;
  head: string;
}

/** True for the { length, sha256, head } shape compactLongText stores. */
export function isAuditLongText(value: unknown): value is AuditLongText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && typeof v.length === 'number' && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256) && typeof v.head === 'string';
}

/** A copy of `value` with every string (any depth) longer than AUDIT_LONG_TEXT_MIN replaced by its AuditLongText. */
export function compactLongText<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.length <= AUDIT_LONG_TEXT_MIN) return v;
      const long: AuditLongText = { length: v.length, sha256: createHash('sha256').update(v, 'utf8').digest('hex'), head: v.slice(0, AUDIT_LONG_TEXT_HEAD) };
      return long;
    }
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
    return out;
  };
  return walk(value) as T;
}

function snapshotJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(compactLongText(redactAuditSnapshot(value)));
  if (json === undefined) return null;
  return json.length > SNAPSHOT_MAX_CHARS ? JSON.stringify({ note: `Snapshot of ${json.length} characters not kept` }) : json;
}

/** Writes one audit row (real clock). Snapshots are redacted and long text compacted; the summary is capped at 500 characters. */
export function recordAudit(db: Db, entry: AuditRecord): void {
  const summary = entry.summary.length > SUMMARY_MAX_CHARS ? `${entry.summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : entry.summary;
  db.prepare(
    `INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary, before_json, after_json, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.userId ?? null,
    entry.action,
    entry.entity ?? null,
    entry.entityId ?? null,
    summary,
    snapshotJson(entry.before),
    snapshotJson(entry.after),
    entry.ip ?? null,
  );
}

/** Deletes rows older than AUDIT_RETENTION_DAYS (real clock); returns how many. */
export function purgeAuditLog(db: Db, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString();
  return Number(db.prepare(`DELETE FROM audit_log WHERE at < ?`).run(cutoff).changes);
}

function logAuditError(stage: string, err: unknown): void {
  console.error(`Audit trail (${stage}) failed; the request was not affected`, err);
}

/** "/finance/payroll/12/pay" → "/finance/payroll/:id/pay" when Express could not tell us the pattern. */
function genericPattern(path: string): string {
  return path.replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** The route pattern Express matched ("/finance" + "/payroll/:id/pay"), relative to /api. */
function expressPattern(baseUrl: string, routePath: unknown): string | null {
  if (typeof routePath !== 'string') return null;
  const base = baseUrl.replace(/^\/api(?=\/|$)/, '');
  const joined = `${base}${routePath === '/' ? '' : routePath}`;
  return joined || '/';
}

interface AuditState extends AuditRequestContext {
  spec: AuditRouteSpec | null;
  call: AuditCall;
  state: unknown;
  response: unknown;
}

/**
 * Records successful writes with before/after snapshots for registered routes. Pass-through for reads, and for writes
 * the registry marks `skip` (announcement read receipts, which have their own table).
 */
export function auditMiddleware(db: Db): RequestHandler {
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    let ctx: AuditState | null = null;
    try {
      const match = matchAuditRoute(req.method, req.path);
      if (match?.spec.skip) return next();
      const call: AuditCall = { method: req.method, path: req.path, params: match?.params ?? {}, body: req.body, me: req.user ?? null };
      let state: unknown;
      try {
        state = match?.spec.before ? match.spec.before(db, call) : undefined;
      } catch (err) {
        logAuditError('before', err);
      }
      ctx = { spec: match?.spec ?? null, call, state, response: undefined };
      req.audit = ctx;
    } catch (err) {
      logAuditError('match', err);
      return next();
    }
    const audit = ctx;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      audit.response = body;
      return originalJson(body);
    }) as Response['json'];
    const originalEnd = res.end;
    let finished = false;
    res.end = function (this: Response, ...args: unknown[]) {
      if (!finished) {
        finished = true;
        try {
          finishAudit(db, audit, res.statusCode, {
            pattern: expressPattern(req.baseUrl, req.route?.path),
            me: req.user ?? audit.call.me,
            ip: req.ip ?? null,
          });
        } catch (err) {
          logAuditError('after', err);
        }
      }
      return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
    } as Response['end'];
    next();
  };
}

function finishAudit(db: Db, ctx: AuditState, status: number, info: { pattern: string | null; me: AuditCall['me']; ip: string | null }): void {
  if (status < 200 || status >= 300) return;
  const action = `${ctx.call.method} ${ctx.spec?.pattern ?? info.pattern ?? genericPattern(ctx.call.path)}`;
  const done: AuditDone = { ...ctx.call, me: info.me, status, response: ctx.response };
  const drafts = ctx.spec ? ctx.spec.after(db, done, ctx.state) : [{ entity: null, entityId: null, summary: action }];
  for (const d of drafts) {
    recordAudit(db, {
      userId: d.userId !== undefined ? d.userId : (info.me?.id ?? null),
      action,
      entity: d.entity,
      entityId: d.entityId,
      summary: d.summary,
      before: d.before,
      after: d.after,
      ip: info.ip,
    });
  }
}
