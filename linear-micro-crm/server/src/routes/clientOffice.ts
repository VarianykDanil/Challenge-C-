/**
 * Release 1.3 — the office side of the client portal — OWNED BY P6 client-portal (laid down by r3-foundation as stubs:
 * reads empty, writes 501). Two routers, each with its own prefix:
 *
 *  clientPostsRouter, mounted at /client-posts (admin, leader; decisions admin only):
 *   GET  /client-posts?status=&campaignId=           → ClientPost[]
 *   GET  /client-posts/unread                        → { count } (the sidebar Campaigns badge)
 *   POST /client-posts/:id/read                      → 204
 *   POST /client-posts/:id/approve  ClientPostDecisionInput → ClientPost (commission: lib/payRule.ts addCampaignRate)
 *   POST /client-posts/:id/decline  ClientPostDecisionInput → ClientPost
 *   POST /client-posts/:id/unpublish                 → ClientPost
 *  clientAccountsRouter, mounted at /client-accounts (admin):
 *   PATCH /client-accounts/:id  { status }           → ClientAccount
 *   POST  /client-accounts/:id/reset-pin             → ClientAccount
 * Inviting an account (POST /campaigns/:id/client-accounts) is in routes/campaignPages.ts.
 */
import { Router } from 'express';
import type { ClientPost } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

const notYet = () => {
  throw new HttpError(501, 'Client posts are not available yet');
};

export function clientPostsRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/', requireRole('admin', 'leader'), (_req, res) => {
    const rows: ClientPost[] = [];
    res.json(rows);
  });
  router.get('/unread', requireRole('admin', 'leader'), (_req, res) => {
    res.json({ count: 0 });
  });
  router.post('/:id/read', requireRole('admin', 'leader'), notYet);
  router.post('/:id/approve', requireRole('admin'), notYet);
  router.post('/:id/decline', requireRole('admin'), notYet);
  router.post('/:id/unpublish', requireRole('admin'), notYet);
  return router;
}

export function clientAccountsRouter(db: Db): Router {
  void db;
  const router = Router();
  router.patch('/:id', requireRole('admin'), notYet);
  router.post('/:id/reset-pin', requireRole('admin'), notYet);
  return router;
}
