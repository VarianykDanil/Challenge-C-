/**
 * Release 1.2 — /audit and announcement read receipts — OWNED BY U3 audit-trail.
 *
 *  GET  /audit?userId=&entity=&entityId=&from=&to=&q=&signIns=&limit=&offset=  → AuditPage (admin), newest first
 *  GET  /audit/:entity/:entityId   → AuditEntryDetail[] (admin; leader: their own team's gauge entries and their own)
 *  POST /announcements/:id/read    → 204 (any signed-in user; idempotent)         [announcementReadsRouter]
 *  GET  /announcements/reads[?ids=1,2]  → AnnouncementReadStats[] (admin: every announcement; others: the ones they wrote)
 * The recording itself is lib/audit.ts (middleware + recordAudit). Types: shared/src/types/audit.ts.
 * Mounted in app.ts: auditRouter at /audit; announcementReadsRouter at /announcements BEFORE the announcements router.
 */
import { Router } from 'express';
import { z } from 'zod';
import { auditDiff, isAuditEntity, type AnnouncementReadStats, type AuditEntity, type AuditEntryDetail, type AuditPage, type UserWithTeam } from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../db/connection.ts';
import { getGauge, getUser } from '../db/queries.ts';
import { addDays, toBusinessISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { canSeeEntryDetails } from '../lib/scope.ts';
import { idParam, isoDate, offsetQuery, optionalIdQuery, optionalString } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

/** GET /audit page size: 50 by default, at most 200. */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
/** GET /audit/:entity/:entityId answers the newest 100 rows. */
export const ENTITY_HISTORY_MAX = 100;
/** The sign-in and sign-out rows (left out with `signIns=0`, so the page lists changes only). */
export const SIGN_IN_ACTIONS = ['POST /auth/login', 'POST /auth/login/2fa', 'POST /auth/logout'] as const;
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
}

const AUDIT_SELECT = `
  SELECT a.id, a.at, a.user_id AS userId, u.first_name || ' ' || u.last_name AS userName, a.action, a.entity,
         a.entity_id AS entityId, a.summary, a.before_json AS beforeJson, a.after_json AS afterJson, a.ip
  FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;

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
  };
}

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
    const q = optionalString(req.query.q)?.slice(0, 100);
    const signIns = optionalString(req.query.signIns);
    if (signIns !== undefined && signIns !== '0' && signIns !== '1') throw badRequest('signIns must be 0 or 1');
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
      clauses.push(`lower(a.summary) LIKE ? ESCAPE '\\'`);
      params.push(`%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (signIns === '0') {
      clauses.push(`a.action NOT IN (${placeholders(SIGN_IN_ACTIONS.length)})`);
      params.push(...SIGN_IN_ACTIONS);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log a ${where}`, params)!.n;
    const rows = all<AuditRow>(db, `${AUDIT_SELECT} ${where} ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const body: AuditPage = { rows: rows.map((r) => toDetail(r, true)), total: Number(total) };
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
    const rows = all<AuditRow>(db, `${AUDIT_SELECT} WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.at DESC, a.id DESC LIMIT ?`, [
      entity,
      entityId,
      ENTITY_HISTORY_MAX,
    ]);
    const body: AuditEntryDetail[] = rows.map((r) => toDetail(r, me.role === 'admin'));
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
   * "Read by 18 of 34": the audience is everyone active except the author; a read counts when its reader is in that
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
      `SELECT a.id, a.author_id AS authorId, (au.status = 'active') AS authorActive
       FROM announcements a LEFT JOIN users au ON au.id = a.author_id ${where}
       ORDER BY a.pinned DESC, a.created_at DESC, a.id DESC${limit}`,
      params,
    );
    if (!announcements.length) {
      res.json([]);
      return;
    }
    const active = Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)!.n);
    const annIds = announcements.map((a) => a.id);
    const reads = all<{ announcementId: number; userId: number; name: string; readAt: string }>(
      db,
      `SELECT r.announcement_id AS announcementId, r.user_id AS userId, u.first_name || ' ' || u.last_name AS name, r.read_at AS readAt
       FROM announcement_reads r JOIN users u ON u.id = r.user_id JOIN announcements a ON a.id = r.announcement_id
       WHERE r.announcement_id IN (${placeholders(annIds.length)}) AND u.status = 'active' AND r.user_id <> a.author_id
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
