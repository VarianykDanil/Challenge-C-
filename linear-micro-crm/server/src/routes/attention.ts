/**
 * GET /me/attention → AttentionFeed — OWNED BY p5-needs-attention-feed.
 * Stub laid down by p1-foundation-contracts (mounted under /me, cached via CACHED_PATHS): answers { items: [],
 * generatedAt } for every signed-in role. p5 gathers the scoped inputs (≤ 12 indexed, date-bounded queries, after
 * ensurePayrollMaterialised) and calls the shared attentionItems(). A rep only ever receives items about themself,
 * their own team's events and their own pay. LM_SMART=0 → items: [].
 */
import { Router } from 'express';
import type { AttentionFeed } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { smartEnabled } from '../lib/smart/enabled.ts';
import { currentUser } from '../middleware/auth.ts';

export function attentionRouter(db: Db): Router {
  const router = Router();
  router.get('/attention', (req, res) => {
    void db;
    void currentUser(req);
    const feed: AttentionFeed = { items: [], generatedAt: new Date().toISOString() };
    if (!smartEnabled()) return res.json(feed);
    res.json(feed);
  });
  return router;
}
