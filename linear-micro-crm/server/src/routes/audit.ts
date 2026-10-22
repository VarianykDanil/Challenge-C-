/**
 * Release 1.2 — /audit and announcement read receipts — OWNED BY U3 audit-trail.
 *
 *  GET  /audit?userId=&entity=&entityId=&from=&to=&q=&signIns=&limit=&offset=  → AuditPage (admin), newest first
 *  GET  /audit/:entity/:entityId   → AuditEntryDetail[] (admin; leader: their own team's gauge entries and their own,
 *                                    with every snapshot redacted the way GET /gauges redacts: see redactGaugeHistory)
 *  POST /announcements/:id/read    → 204 (any signed-in user; idempotent)         [announcementReadsRouter]
 *  GET  /announcements/reads[?ids=1,2]  → AnnouncementReadStats[] (admin: every announcement; others: the ones they wrote)
 * The recording itself is lib/audit.ts (middleware + recordAudit). Types: shared/src/types/audit.ts.
 * Mounted in app.ts: auditRouter at /audit; announcementReadsRouter at /announcements BEFORE the announcements router.
 *
 * Release 1.3 — OWNED BY P9 audit-everything from here on:
 *  GET /audit … &kind=sign_in,export&view=everything|changes   every row carries `kind` and `userRole`; `kind` is one
 *                                    AuditEventKind or a comma list, `view=changes` is `kind=change` (400 for anything
 *                                    else, or for both at once); `entity` takes the 1.3 entities too
 *  GET /audit/people                → AuditPerson[] (admin): everyone the trail can name, client accounts included
 *                                    (id, name, role, status: no employee IDs or client access codes)
 *  GET /audit/person/:userId?kind=&limit=&offset=  → AuditPersonActivity (admin): what that person did, newest first,
 *                                    the failed attempts on their account and Linear Hub's note when it paused
 *                                    recording them; their last sign-in, last activity (not
 *                                    counting tries on the sign-in page, which may be somebody else's) and failed
 *                                    sign-ins in the last 30 days
 *  GET /audit/:entity/:entityId?kind=  the record's history, optionally of some kinds only (as GET /audit)
 *  (both registered before /:entity/:entityId, which would otherwise read "person" as an entity)
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  AUDIT_SIGN_IN_PAGE_ACTIONS,
  auditDiff,
  auditKindOf,
  isAuditEntity,
  isAuditEventKind,
  parseAuditKinds,
  type AnnouncementReadStats,
  type AuditEntity,
  type AuditEntryDetail,
  type AuditEventKind,
  type AuditPage,
  type AuditPerson,
  type AuditPersonActivity,
  type Role,
  type UserStatus,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../db/connection.ts';
import { getGauge, getUser } from '../db/queries.ts';
import { addDays, toBusinessISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { gaugeSummary } from '../lib/auditSpecs.ts';
import { IDLE_SIGN_OUT_ACTION } from '../lib/audit/sessions.ts';
import { canSeeEntryDetails } from '../lib/scope.ts';
import { idParam, isoDate, offsetQuery, optionalIdQuery, optionalString } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

/** GET /audit page size: 50 by default, at most 200. */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
/** GET /audit/:entity/:entityId answers the newest 100 rows. */
export const ENTITY_HISTORY_MAX = 100;
/**
 * The sign-in and sign-out rows (left out with `signIns=0`, so the page lists changes only). Release 1.3: with the
 * sign-out by the idle timeout (lib/audit/signIns.ts IDLE_SIGN_OUT_ACTION), which is not the person being active.
 */
export const SIGN_IN_ACTIONS = ['POST /auth/login', 'POST /auth/login/2fa', 'POST /auth/logout', IDLE_SIGN_OUT_ACTION] as const;
/** GET /announcements/reads without `ids`: the 50 newest (pinned first, as the dashboard lists them). */
const READS_DEFAULT_LIMIT = 50;

interface AuditRow {
  id: number;
  at: string;
  userId: number | null;
  userName: string | null;
  action: string;
  entity: string | null;
  entityId: number | null;
  summary: string;
  beforeJson: string | null;
  afterJson: string | null;
  ip: string | null;
  kind: string | null;
  userRole: Role | null;
}

const AUDIT_SELECT = `
  SELECT a.id, a.at, a.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, a.action, a.entity,
         a.entity_id AS entityId, a.summary, a.before_json AS beforeJson, a.after_json AS afterJson, a.ip, a.kind,
         u.role AS userRole
  FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;

/** Release 1.3: a failed sign-in, wrong PIN or wrong two-step code (lib/audit/signIns.ts writes a `reason`). */
const FAILED_ATTEMPT = `a.kind = 'sign_in' AND json_extract(a.after_json, '$.reason') IS NOT NULL`;
/**
 * …made on the sign-in page (shared isAuditAttemptOnAccount): filed under the account it was tried on, maybe typed by
 * somebody else, so it is not that person being active. (The actions are constants, safe to inline.)
 */
const ATTEMPT_ON_ACCOUNT = `${FAILED_ATTEMPT} AND a.action IN (${AUDIT_SIGN_IN_PAGE_ACTIONS.map((x) => `'${x}'`).join(', ')})`;
/** Release 1.3: Team → person → Activity counts failed attempts over this many days. */
export const PERSON_FAILED_DAYS = 30;

/**
 * The `q` search folds apostrophes and quotes on both sides, so what a phone keyboard types finds what the summaries
 * print: apostrophes (’ ‘ ') are dropped, so "can't", "can’t" and "cant" all find “Can’t controls”, and curly double
 * quotes read as straight ones. `SUMMARY_FOLDED` is the same fold in SQL, over `lower(summary)` as before.
 */
const SUMMARY_FOLDED = `replace(replace(replace(replace(replace(lower(a.summary), '’', ''), '‘', ''), '''', ''), '“', '"'), '”', '"')`;
function foldAuditSearch(q: string): string {
  return q.toLowerCase().replace(/[’‘']/g, '').replace(/[“”]/g, '"');
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toDetail(row: AuditRow, showIp: boolean): AuditEntryDetail {
  const before = parseJson(row.beforeJson);
  const after = parseJson(row.afterJson);
  return {
    id: row.id,
    at: row.at,
    userId: row.userId,
    userName: row.userName,
    action: row.action,
    entity: isAuditEntity(row.entity) ? row.entity : null,
    entityId: row.entityId,
    summary: row.summary,
    ip: showIp ? row.ip : null,
    before,
    after,
    diff: auditDiff(before, after),
    // a row written before audit_log.kind was classified reads as the same rules would class it
    kind: isAuditEventKind(row.kind) ? row.kind : auditKindOf(row.action, row.userRole),
    userRole: row.userRole ?? null,
  };
}

/** `kind` and `view` of GET /audit and GET /audit/person/:userId → the kinds to keep (undefined: every kind). */
function kindsQuery(kindRaw: unknown, viewRaw: unknown): AuditEventKind[] | undefined {
  const view = optionalString(viewRaw);
  if (view !== undefined && view !== 'everything' && view !== 'changes') throw badRequest('view must be everything or changes');
  const kinds = parseAuditKinds(optionalString(kindRaw));
  if (kinds === null) throw badRequest('Invalid kind');
  if (view === 'changes') {
    if (kinds) throw badRequest('Use either kind or view=changes, not both');
    return ['change'];
  }
  return kinds;
}

function pushKinds(clauses: string[], params: (string | number)[], kinds: AuditEventKind[] | undefined): void {
  if (!kinds) return;
  clauses.push(`a.kind IN (${placeholders(kinds.length)})`);
  params.push(...kinds);
}

/** What the Person filter and the Activity card name a person by: no employee IDs or client access codes. */
const PERSON_SELECT = `SELECT u.id, TRIM(u.first_name || ' ' || u.last_name) AS name, u.role, u.status FROM users u`;

/** The UTC instant of midnight in London on `date` (audit times are UTC; the filters are London calendar days). */
export function londonMidnightUtc(date: string): string {
  const utcMidnight = new Date(`${date}T00:00:00.000Z`);
  const london = toBusinessISO(utcMidnight); // e.g. 2026-07-01T01:00:00 in summer time
  const offsetMs = Date.parse(`${london}Z`) - utcMidnight.getTime();
  return new Date(utcMidnight.getTime() - offsetMs).toISOString();
}

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** May `me` read the history of this gauge entry? Admin: yes. Leader: their own team's entries and their own. */
function canReadGaugeHistory(db: Db, me: UserWithTeam, entryId: number): boolean {
  if (me.role === 'admin') return true;
  if (me.role !== 'leader') return false;
  const entry = getGauge(db, entryId);
  if (entry) return canSeeEntryDetails(me, { id: entry.userId, teamId: entry.teamId });
  // a deleted entry: judge by the person it belonged to, from its newest snapshot
  const row = get<{ b: string | null; a: string | null }>(
    db,
    `SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity = 'gauge_entry' AND entity_id = ? ORDER BY at DESC, id DESC LIMIT 1`,
    [entryId],
  );
  const snap = (parseJson(row?.a ?? null) ?? parseJson(row?.b ?? null)) as { userId?: unknown } | null;
  const owner = typeof snap?.userId === 'number' ? getUser(db, snap.userId) : undefined;
  return owner ? canSeeEntryDetails(me, { id: owner.id, teamId: owner.teamId }) : false;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const ownerOf = (snap: unknown): number | null => (isRecord(snap) && typeof snap.userId === 'number' ? snap.userId : null);

/**
 * A leader's view of a gauge entry's history, redacted snapshot by snapshot with the rule GET /gauges uses
 * (canSeeEntryDetails / redactEntry): the check-in time and notes of a person outside the leader's team are blanked.
 * An entry can move between people and teams, so each snapshot is judged by the person it belonged to then (their
 * team now, as /gauges does), not by the entry's current owner. When anything was blanked, the diff and the summary
 * are rebuilt from the redacted snapshots, so neither can quote what was hidden. One query for the owners' teams.
 */
export function redactGaugeHistory(db: Db, me: UserWithTeam, rows: AuditEntryDetail[]): AuditEntryDetail[] {
  if (me.role === 'admin') return rows;
  const ids = [...new Set(rows.flatMap((r) => [ownerOf(r.before), ownerOf(r.after)]).filter((id): id is number => id !== null))];
  const teams = new Map<number, number | null>();
  if (ids.length) {
    for (const u of all<{ id: number; teamId: number | null }>(db, `SELECT id, team_id AS teamId FROM users WHERE id IN (${placeholders(ids.length)})`, ids)) teams.set(u.id, u.teamId);
  }
  const visible = (owner: number | null) => owner !== null && teams.has(owner) && canSeeEntryDetails(me, { id: owner, teamId: teams.get(owner) ?? null });
  return rows.map((row) => {
    let hid = false;
    const redact = (snap: unknown): unknown => {
      if (!isRecord(snap) || visible(ownerOf(snap))) return snap;
      if ((snap.checkedInAt ?? null) === null && (snap.notes ?? null) === null) return snap;
      hid = true;
      return { ...snap, checkedInAt: null, notes: null };
    };
    const before = redact(row.before);
    const after = redact(row.after);
    if (!hid) return row;
    const diff = auditDiff(before, after);
    const summary = gaugeSummary(isRecord(before) ? before : null, isRecord(after) ? after : null, diff, row.action === 'POST /gauges/bulk');
    return { ...row, before, after, diff, summary };
  });
}

export function auditRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireRole('admin'), (req, res) => {
    const { from, to } = listQuery.parse({ from: optionalString(req.query.from), to: optionalString(req.query.to) });
    if (from && to && from > to) throw badRequest('`from` must be on or before `to`');
    const userId = optionalIdQuery(req.query.userId, 'userId');
    const entityId = optionalIdQuery(req.query.entityId, 'entityId');
    const entityRaw = optionalString(req.query.entity);
    if (entityRaw !== undefined && !isAuditEntity(entityRaw)) throw badRequest('Invalid entity');
    const entity = entityRaw as AuditEntity | undefined;
    const q = foldAuditSearch(optionalString(req.query.q)?.slice(0, 100) ?? '').trim();
    const signIns = optionalString(req.query.signIns);
    if (signIns !== undefined && signIns !== '0' && signIns !== '1') throw badRequest('signIns must be 0 or 1');
    const kinds = kindsQuery(req.query.kind, req.query.view);
    const limitRaw = optionalIdQuery(req.query.limit, 'limit');
    const limit = Math.min(limitRaw ?? AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX);
    const offset = offsetQuery(req.query.offset);

    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (from) {
      clauses.push('a.at >= ?');
      params.push(londonMidnightUtc(from));
    }
    if (to) {
      clauses.push('a.at < ?');
      params.push(londonMidnightUtc(addDays(to, 1)));
    }
    if (userId) {
      clauses.push('a.user_id = ?');
      params.push(userId);
    }
    if (entity) {
      clauses.push('a.entity = ?');
      params.push(entity);
    }
    if (entityId) {
      clauses.push('a.entity_id = ?');
      params.push(entityId);
    }
    if (q) {
      clauses.push(`${SUMMARY_FOLDED} LIKE ? ESCAPE '\\'`);
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (signIns === '0') {
      clauses.push(`a.action NOT IN (${placeholders(SIGN_IN_ACTIONS.length)})`);
      params.push(...SIGN_IN_ACTIONS);
    }
    pushKinds(clauses, params, kinds);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log a ${where}`, params)!.n;
    const rows = all<AuditRow>(db, `${AUDIT_SELECT} ${where} ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const body: AuditPage = { rows: rows.map((r) => toDetail(r, true)), total: Number(total) };
    res.json(body);
  });

  // Release 1.3 (P9): the Person filter's list — staff and client accounts, any status (GET /users leaves clients out).
  router.get('/people', requireRole('admin'), (_req, res) => {
    const body: AuditPerson[] = all<AuditPerson>(db, `${PERSON_SELECT} ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.id`);
    res.json(body);
  });

  // Release 1.3 (P9): Team → person → Activity. Before /:entity/:entityId (two segments as well).
  router.get('/person/:userId', requireRole('admin'), (req, res) => {
    const userId = idParam(req, 'userId');
    const person = get<{ id: number; name: string; role: Role; status: UserStatus }>(db, `${PERSON_SELECT} WHERE u.id = ?`, [userId]);
    if (!person) throw notFound('User');
    const kinds = kindsQuery(req.query.kind, req.query.view);
    const limitRaw = optionalIdQuery(req.query.limit, 'limit');
    const limit = Math.min(limitRaw ?? AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX);
    const offset = offsetQuery(req.query.offset);
    // what they did, plus Linear Hub's note that it paused recording failed sign-ins on their account (no actor, filed
    // under the account: lib/audit.ts takeFailureBudget), so the card shows why tries on the account stopped appearing
    const clauses = [`(a.user_id = ? OR (a.user_id IS NULL AND a.entity = 'user' AND a.entity_id = ? AND a.kind = 'sign_in'))`];
    const params: (string | number)[] = [userId, userId];
    pushKinds(clauses, params, kinds);
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log a ${where}`, params)!.n);
    const rows = all<AuditRow>(db, `${AUDIT_SELECT} ${where} ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    // one more indexed query (user_id, at) for the summary line
    const since = new Date(Date.now() - PERSON_FAILED_DAYS * 86_400_000).toISOString();
    const stats = get<{ lastSignInAt: string | null; lastActiveAt: string | null; failed: number | null }>(
      db,
      `SELECT MAX(CASE WHEN a.action IN ('POST /auth/login', 'POST /auth/login/2fa') AND a.kind = 'sign_in' AND a.after_json IS NULL THEN a.at END) AS lastSignInAt,
              MAX(CASE WHEN ${ATTEMPT_ON_ACCOUNT} OR a.action = '${IDLE_SIGN_OUT_ACTION}' THEN NULL ELSE a.at END) AS lastActiveAt,
              SUM(CASE WHEN ${FAILED_ATTEMPT} AND a.at >= ? THEN 1 ELSE 0 END) AS failed
       FROM audit_log a WHERE a.user_id = ?`,
      [since, userId],
    );
    const body: AuditPersonActivity = {
      person,
      rows: rows.map((r) => toDetail(r, true)),
      total,
      lastSignInAt: stats?.lastSignInAt ?? null,
      lastActiveAt: stats?.lastActiveAt ?? null,
      failedSignIns: Number(stats?.failed ?? 0),
    };
    res.json(body);
  });

  router.get('/:entity/:entityId', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const entity = req.params.entity;
    if (!isAuditEntity(entity)) throw badRequest('Invalid entity');
    const entityId = idParam(req, 'entityId');
    if (me.role !== 'admin') {
      if (entity !== 'gauge_entry') throw forbidden('Only administrators can see this history');
      if (!canReadGaugeHistory(db, me, entityId)) throw forbidden("Leaders can only see the history of their own team's gauge entries");
    }
    // Release 1.3 (P9): `kind=` narrows a record's history (the History panels ask for changes and automatic steps only,
    // so "Opened the payslip" never reads as a change of it)
    const kinds = kindsQuery(req.query.kind, req.query.view);
    const clauses = ['a.entity = ?', 'a.entity_id = ?'];
    const params: (string | number)[] = [entity, entityId];
    pushKinds(clauses, params, kinds);
    const rows = all<AuditRow>(db, `${AUDIT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.at DESC, a.id DESC LIMIT ?`, [...params, ENTITY_HISTORY_MAX]);
    const details = rows.map((r) => toDetail(r, me.role === 'admin'));
    const body: AuditEntryDetail[] = entity === 'gauge_entry' ? redactGaugeHistory(db, me, details) : details;
    res.json(body);
  });

  return router;
}

/** `?ids=1,2,3` → [1, 2, 3] (at most 100 ids); undefined when absent. */
function idsQuery(value: unknown): number[] | undefined {
  const raw = optionalString(value);
  if (raw === undefined) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw badRequest('Invalid ids');
  return [...new Set(ids)].slice(0, 100);
}

export function announcementReadsRouter(db: Db): Router {
  const router = Router();

  /**
   * "Read by 18 of 34": the audience is every active staff member except the author (a client portal account is never
   * in it, so a client-authored announcement — release 1.3 — loses no one); a read counts when its reader is in that
   * audience. Admins get every announcement, everyone else only the ones they wrote. Names are always included, as the
   * only people who receive a row are the author and admins. Two queries whatever the number of announcements.
   */
  router.get('/reads', (req, res) => {
    const me = currentUser(req);
    const ids = idsQuery(req.query.ids);
    const clauses: string[] = [];
    const params: number[] = [];
    if (me.role !== 'admin') {
      clauses.push('a.author_id = ?');
      params.push(me.id);
    }
    if (ids) {
      clauses.push(`a.id IN (${placeholders(ids.length)})`);
      params.push(...ids);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = ids ? '' : ` LIMIT ${READS_DEFAULT_LIMIT}`;
    const announcements = all<{ id: number; authorId: number; authorActive: number }>(
      db,
      `SELECT a.id, a.author_id AS authorId, (au.status = 'active' AND au.role <> 'client') AS authorActive
       FROM announcements a LEFT JOIN users au ON au.id = a.author_id ${where}
       ORDER BY a.pinned DESC, a.created_at DESC, a.id DESC${limit}`,
      params,
    );
    if (!announcements.length) {
      res.json([]);
      return;
    }
    // (release 1.3: client portal accounts are not part of the audience)
    const active = Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND role <> 'client'`)!.n);
    const annIds = announcements.map((a) => a.id);
    const reads = all<{ announcementId: number; userId: number; name: string; readAt: string }>(
      db,
      `SELECT r.announcement_id AS announcementId, r.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS name, r.read_at AS readAt
       FROM announcement_reads r JOIN users u ON u.id = r.user_id JOIN announcements a ON a.id = r.announcement_id
       WHERE r.announcement_id IN (${placeholders(annIds.length)}) AND u.status = 'active' AND u.role <> 'client' AND r.user_id <> a.author_id
       ORDER BY r.read_at DESC, u.last_name, u.first_name`,
      annIds,
    );
    const byAnnouncement = new Map<number, { userId: number; name: string; readAt: string }[]>();
    for (const r of reads) {
      const list = byAnnouncement.get(r.announcementId) ?? [];
      list.push({ userId: r.userId, name: r.name, readAt: r.readAt });
      byAnnouncement.set(r.announcementId, list);
    }
    const body: AnnouncementReadStats[] = announcements.map((a) => {
      const readers = byAnnouncement.get(a.id) ?? [];
      return { announcementId: a.id, readCount: readers.length, audience: Math.max(0, active - (a.authorActive ? 1 : 0)), readers };
    });
    res.json(body);
  });

  /** Marks the announcement read by the caller (the first read time is kept; repeats change nothing). */
  router.post('/:id/read', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    if (!get(db, `SELECT 1 FROM announcements WHERE id = ?`, [id])) throw notFound('Announcement');
    run(db, `INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)`, [id, me.id, new Date().toISOString()]);
    res.status(204).end();
  });

  return router;
}
