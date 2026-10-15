import { Router } from 'express';
import { z } from 'zod';
import type { Announcement } from '@lm/shared';
import { get, run, type Db } from '../db/connection.ts';
import { ANNOUNCEMENT_SELECT, listAnnouncements, mapAnnouncement } from '../db/queries.ts';
import { nowISO } from '../lib/dates.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const body = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  pinned: z.boolean().default(false),
});

export function announcementsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listAnnouncements(db));
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
