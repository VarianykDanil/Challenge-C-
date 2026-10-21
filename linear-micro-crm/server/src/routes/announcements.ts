import { Router } from 'express';
import { z } from 'zod';
import type { Announcement } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { ANNOUNCEMENT_SELECT, listAnnouncements, mapAnnouncement } from '../db/queries.ts';
import { nowISO } from '../lib/dates.ts';
import { offsetQuery, optionalIdQuery } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

/** GET /announcements?limit= answers at most this many (the dashboard's "Older announcements" asks for 20). */
export const ANNOUNCEMENTS_PAGE_MAX = 50;

const body = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  pinned: z.boolean().default(false),
});

export function announcementsRouter(db: Db): Router {
  const router = Router();

  /**
   * Everyone signed in reads every announcement (as on the dashboard). Pinned first, newest first. Without `limit`
   * all of them, as before; `limit` (1–50, more is capped) and `offset` (≥ 0) page through them in the same order, so
   * `?offset=5&limit=20` is the twenty after the dashboard's latest five.
   */
  router.get('/', (req, res) => {
    const limitRaw = optionalIdQuery(req.query.limit, 'limit');
    const offset = offsetQuery(req.query.offset);
    const limit = limitRaw === undefined ? undefined : Math.min(limitRaw, ANNOUNCEMENTS_PAGE_MAX);
    res.json(listAnnouncements(db, limit, offset));
  });

  router.post('/', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const input = body.parse(req.body);
    const r = run(db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES (?, ?, ?, ?, ?)`, [
      input.title, input.body, me.id, nowISO(), input.pinned,
    ]);
    const row = get<Announcement>(db, `${ANNOUNCEMENT_SELECT} WHERE a.id = ?`, [r.lastInsertRowid])!;
    res.status(201).json(mapAnnouncement(row));
  });

  return router;
}
