/**
 * Release 1.3 — /client (the client portal: a campaign's client posts updates, announcements and commission changes) —
 * client accounts only — OWNED BY P6 client-portal (laid down by r3-foundation as a stub: the portal shows the
 * client's campaign and no posts; writes 501).
 *
 *  GET  /client/portal                → ClientPortal (their campaign, themself, their campaign's posts)
 *  GET  /client/posts                 → ClientPost[]
 *  POST /client/posts  ClientPostInput → 201 ClientPost
 * This is the only router a client session may reach besides /auth and /health (middleware/clientGuard.ts); staff get
 * 403 here. Nothing about the office, finance or other campaigns is ever returned. Types: shared/src/types/client.ts.
 * Audit specs: lib/audit/clientSpecs.ts (every client-portal action is recorded).
 */
import { Router } from 'express';
import type { ClientPortal, ClientPost } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

export function clientRouter(db: Db): Router {
  const router = Router();
  // The portal is the client's alone (this router has the /client prefix to itself).
  router.use(requireRole('client'));
  router.get('/portal', (req, res) => {
    const me = currentUser(req);
    const campaign = get<ClientPortal['campaign']>(
      db,
      `SELECT c.id, c.code, c.name, c.color FROM users u JOIN campaigns c ON c.id = u.client_campaign_id WHERE u.id = ?`,
      [me.id],
    );
    if (!campaign) throw notFound('Campaign');
    const body: ClientPortal = { campaign, me: { id: me.id, name: `${me.firstName} ${me.lastName}`, email: me.email }, posts: [] };
    res.json(body);
  });
  router.get('/posts', (_req, res) => {
    const rows: ClientPost[] = [];
    res.json(rows);
  });
  router.post('/posts', () => {
    throw new HttpError(501, 'Posting from the client portal is not available yet');
  });
  return router;
}
