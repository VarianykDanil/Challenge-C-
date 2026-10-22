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
 *
 * Release 1.3 — OWNED BY P9 audit-everything from here on ("every action anyone takes is recorded"):
 *  - Every row has a kind (audit_log.kind, shared AuditEventKind): `entry.kind`, else shared auditKindOf(action, the
 *    actor's role) — a change, a sign-in (and every failed attempt), an export, an opened record, an automatic step
 *    ("Linear Hub") or a client-portal action.
 *  - Failed attempts: a 4xx answer to a route whose spec has a `failed` hook (sign-in, two-step sign-in, PIN change and
 *    removal, two-step settings) writes what the hook returns — "Failed sign-in: wrong PIN (4 tries left)" — within a
 *    budget per 15 minutes (FAILED_ROWS_*): 30 rows per real account, and for emails nobody has 30 per address and 600
 *    in all — so a flood of made-up emails, from one address or many, can never hide a try on a real account.
 *    Other failed requests still write nothing.
 *  - Exports and opened records reported by a page (POST /audit/events) and automatic steps go through
 *    lib/audit/events.ts, which calls recordAudit.
 *  - The INSERT is prepared once per database, so a burst of writes costs less than in 1.2 (docs/r3/P9-audit-everything.md
 *    has the before/after benchmark).
 */
import { createHash } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { RequestHandler, Response } from 'express';
import { auditKindOf, redactAuditSnapshot, type AuditEntity, type AuditEventKind, type Role } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import type { AuditCall, AuditDone, AuditDraft, AuditRouteSpec } from './auditSpecs.ts';
import { FailureLimiter } from './limiter.ts';
// Release 1.3 (r3-foundation): writes are matched against the spec registry (the 1.3 packages' specs, then the 1.2 ones).
import { matchAuditSpec } from './audit/registry.ts';

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
  /** Release 1.3 (P9): the kind of action; default shared auditKindOf(action, actorRole). */
  kind?: AuditEventKind;
  /** Release 1.3 (P9): the role of whoever acted (a client account's rows are kind `client`). */
  actorRole?: Role | null;
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

/** One prepared INSERT per database (release 1.3: no prepare per row, so a burst of writes costs less than in 1.2). */
const INSERT_STATEMENTS = new WeakMap<Db, StatementSync>();
const INSERT_SQL = `INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary, before_json, after_json, ip, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertStatement(db: Db): StatementSync {
  let stmt = INSERT_STATEMENTS.get(db);
  if (!stmt) {
    stmt = db.prepare(INSERT_SQL);
    INSERT_STATEMENTS.set(db, stmt);
  }
  return stmt;
}

/**
 * Writes one audit row (real clock). Snapshots are redacted and long text compacted; the summary is capped at 500
 * characters. Release 1.3: the row's kind is `entry.kind`, else shared auditKindOf(action, actorRole).
 */
export function recordAudit(db: Db, entry: AuditRecord): void {
  const summary = entry.summary.length > SUMMARY_MAX_CHARS ? `${entry.summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : entry.summary;
  const kind = entry.kind ?? auditKindOf(entry.action, entry.actorRole);
  const values = [
    new Date().toISOString(),
    entry.userId ?? null,
    entry.action,
    entry.entity ?? null,
    entry.entityId ?? null,
    summary,
    snapshotJson(entry.before),
    snapshotJson(entry.after),
    entry.ip ?? null,
    kind,
  ] as const;
  try {
    insertStatement(db).run(...values);
  } catch (err) {
    INSERT_STATEMENTS.delete(db); // prepared afresh next time (SQLite re-prepares on a schema change by itself)
    throw err;
  }
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
 * Release 1.3 (P9): failed sign-ins, wrong PINs and wrong two-step codes are recorded (the registry's `failed` hook),
 * within a budget per 15-minute window, so a script hammering the sign-in page cannot fill the disk:
 *  - FAILED_ROWS_PER_ACCOUNT rows per account a try is filed under (a real account: its own budget and only that, so a
 *    flood of made-up emails — even from the same address — can never use up the room for a try on Matt's account);
 *  - for emails nobody has (no account to file them under): FAILED_ROWS_PER_SOURCE rows per address of the sign-in
 *    page, and FAILED_ROWS_ALL rows in all.
 * The row that reaches a cap says recording has paused, for whom, and that it starts again within 15 minutes; an
 * account's pause row names the account (entity 'user'), so it shows on that person's Activity, as Linear Hub's note.
 * Worst case per window: FAILED_ROWS_ALL + FAILED_ROWS_PER_ACCOUNT × accounts tried.
 */
export const FAILED_ROWS_PER_SOURCE = 30;
export const FAILED_ROWS_PER_ACCOUNT = 30;
export const FAILED_ROWS_ALL = 600;
export const FAILED_ROWS_WINDOW_MS = 15 * 60_000;

interface FailureBudget {
  perSource: FailureLimiter;
  perAccount: FailureLimiter;
  /** Rows with no account (an email nobody has). */
  all: FailureLimiter;
}

/**
 * Records successful writes with before/after snapshots for registered routes. Pass-through for reads, and for writes
 * the registry marks `skip` (announcement read receipts, which have their own table; POST /audit/events, which records
 * itself). Release 1.3: a 4xx answer to a route whose spec has a `failed` hook (signing in, PIN and two-step checks)
 * writes what the hook returns, within the failure budget above.
 */
export function auditMiddleware(db: Db): RequestHandler {
  const budget: FailureBudget = {
    perSource: new FailureLimiter(FAILED_ROWS_PER_SOURCE, FAILED_ROWS_WINDOW_MS),
    perAccount: new FailureLimiter(FAILED_ROWS_PER_ACCOUNT, FAILED_ROWS_WINDOW_MS),
    all: new FailureLimiter(FAILED_ROWS_ALL, FAILED_ROWS_WINDOW_MS, 1),
  };
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    let ctx: AuditState | null = null;
    try {
      const match = matchAuditSpec(req.method, req.path);
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
          }, budget);
        } catch (err) {
          logAuditError('after', err);
        }
      }
      return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
    } as Response['end'];
    next();
  };
}

function writeDrafts(db: Db, drafts: AuditDraft[], action: string, info: { me: AuditCall['me']; ip: string | null }): void {
  for (const d of drafts) {
    const userId = d.userId !== undefined ? d.userId : (info.me?.id ?? null);
    recordAudit(db, {
      userId,
      action,
      entity: d.entity,
      entityId: d.entityId,
      summary: d.summary,
      before: d.before,
      after: d.after,
      ip: info.ip,
      kind: d.kind,
      // a row about the caller's own action carries their role (a client account's rows are kind `client`)
      actorRole: d.userId === undefined || d.userId === info.me?.id ? (info.me?.role ?? null) : null,
    });
  }
}

/** The row written when a cap is reached: what paused, filed under the account when it was one account's budget. */
interface PauseRow {
  summary: string;
  accountId: number | null;
}

/**
 * Takes one row from the failure budget: `source` is the address of a sign-in page try (null for a signed-in
 * person's own check), `accountId` the account the try is filed under (null for an email nobody has). Returns null
 * when the room is used up; otherwise the row to write after the failure when this one was the last allowed (null
 * pause when it was not). A try on a real account counts against that account's budget only (not the address's), so
 * made-up emails from the same address never use up its room.
 */
function takeFailureBudget(db: Db, budget: FailureBudget, source: string | null, accountId: number | null): { pause: PauseRow | null } | null {
  const now = Date.now();
  const minutes = FAILED_ROWS_WINDOW_MS / 60_000;
  const again = `; recording starts again within ${minutes} minutes`;
  if (accountId !== null) {
    const key = String(accountId);
    const fromAccount = budget.perAccount.count(key, now);
    if (fromAccount >= FAILED_ROWS_PER_ACCOUNT) return null;
    budget.perAccount.record(key, now);
    if (fromAccount + 1 < FAILED_ROWS_PER_ACCOUNT) return { pause: null };
    const name = get<{ name: string }>(db, `SELECT first_name || ' ' || last_name AS name FROM users WHERE id = ?`, [accountId])?.name;
    const whose = name ? `${name}'s account` : 'one account';
    return { pause: { accountId, summary: `Stopped recording failed sign-ins on ${whose} after ${FAILED_ROWS_PER_ACCOUNT} in ${minutes} minutes${again}` } };
  }
  const fromSource = source === null ? 0 : budget.perSource.count(source, now);
  const fromAll = budget.all.count('*', now);
  if (source !== null && fromSource >= FAILED_ROWS_PER_SOURCE) return null;
  if (fromAll >= FAILED_ROWS_ALL) return null;
  if (source !== null) budget.perSource.record(source, now);
  budget.all.record('*', now);
  if (source !== null && fromSource + 1 === FAILED_ROWS_PER_SOURCE) {
    return { pause: { accountId: null, summary: `Stopped recording failed sign-ins with unknown emails from ${source} after ${FAILED_ROWS_PER_SOURCE} in ${minutes} minutes${again}` } };
  }
  if (fromAll + 1 === FAILED_ROWS_ALL) {
    return { pause: { accountId: null, summary: `Stopped recording failed sign-ins with unknown emails after ${FAILED_ROWS_ALL} in ${minutes} minutes from many addresses${again}` } };
  }
  return { pause: null };
}

function finishAudit(
  db: Db,
  ctx: AuditState,
  status: number,
  info: { pattern: string | null; me: AuditCall['me']; ip: string | null },
  budget: FailureBudget,
): void {
  const action = `${ctx.call.method} ${ctx.spec?.pattern ?? info.pattern ?? genericPattern(ctx.call.path)}`;
  const done: AuditDone = { ...ctx.call, me: info.me, status, response: ctx.response };
  if (status >= 200 && status < 300) {
    const drafts = ctx.spec ? ctx.spec.after(db, done, ctx.state) : [{ entity: null, entityId: null, summary: action }];
    writeDrafts(db, drafts, action, info);
    return;
  }
  // Release 1.3: refused sign-ins and security checks (4xx) — only routes whose spec says what a failure means.
  if (status < 400 || status >= 500 || !ctx.spec?.failed) return;
  const drafts = ctx.spec.failed(db, done, ctx.state);
  if (!drafts.length) return;
  // a try from the sign-in page counts against its address; every try against the account it is filed under
  const source = info.me ? null : (info.ip ?? 'unknown');
  const first = drafts[0]!;
  const accountId = first.entity === 'user' && typeof first.entityId === 'number' ? first.entityId : null;
  const taken = takeFailureBudget(db, budget, source, accountId);
  if (taken === null) return;
  writeDrafts(db, drafts.map((d) => ({ ...d, kind: d.kind ?? 'sign_in' })), action, info);
  const pause = taken.pause;
  if (pause) {
    recordAudit(db, { userId: null, action, entity: pause.accountId === null ? null : 'user', entityId: pause.accountId, kind: 'sign_in', ip: info.ip, summary: pause.summary });
  }
}
