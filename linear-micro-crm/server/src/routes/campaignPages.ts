/**
 * Release 1.3 — the campaign page and its client accounts — OWNED BY P6 client-portal (laid down by r3-foundation as a
 * stub). Mounted at /campaigns BEFORE the 1.0 campaigns router (routes/campaigns.ts, unchanged): only the paths below
 * are answered here, everything else falls through to it. Role checks are per route, never router-wide, so the 1.0
 * routes keep their own rules.
 *
 *  GET  /campaigns/:id/page               → CampaignPage (admin, leader; reps: the brief without money) — cached
 *  GET  /campaigns/:id/client-accounts    → ClientAccount[] (admin)
 *  POST /campaigns/:id/client-accounts  ClientInviteInput → 201 ClientInviteResult (admin; the access code shown once)
 */
import { Router } from 'express';
import type { ClientAccount } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

export function campaignPagesRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/:id/page', requireRole('admin', 'leader', 'recruiter', 'rep'), () => {
    throw new HttpError(501, 'Campaign pages are not available yet');
  });
  router.get('/:id/client-accounts', requireRole('admin'), (_req, res) => {
    const rows: ClientAccount[] = [];
    res.json(rows);
  });
  router.post('/:id/client-accounts', requireRole('admin'), () => {
    throw new HttpError(501, 'Client accounts are not available yet');
  });
  return router;
}
