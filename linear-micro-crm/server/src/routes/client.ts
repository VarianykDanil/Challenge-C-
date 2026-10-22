/**
 * Release 1.3 — /client (the client portal: a campaign's client posts updates, announcements and commission changes) —
 * client accounts only — OWNED BY P6 client-portal.
 *
 *  GET  /client/portal                → ClientPortal (their campaign, themself, their campaign's posts)
 *  GET  /client/posts                 → ClientPost[] (their campaign's posts, newest first)
 *  POST /client/posts  ClientPostInput → 201 ClientPost
 *       - 'update' and 'announcement' publish straight to Announcements (an announcements row authored by the client
 *         account, so it carries `fromClient`: the badge "From Breast Cancer Now"), status 'published';
 *       - 'commission' waits for Matt (status 'pending'): a new rate per sub to the fundraiser and / or the payout per
 *         sub to Linear, from a date (today at the earliest, a year ahead at most). Title and message are optional for
 *         it ("Commission change from Mon 2 Nov").
 *       - 400 with `details: [{ path, message }]` (the shared clientPostProblems rules, the portal form's own); 429 after
 *         CLIENT_POSTS_PER_DAY posts in 24 hours; the same post sent twice within two minutes (a double tap on a phone)
 *         answers 200 with the first one instead of publishing it twice. Both windows are on the REAL clock
 *         (client_posts.posted_at), like every rate limit; created_at (what the office reads) is the business clock.
 * This is the only router a client session may reach besides /auth and /health (middleware/clientGuard.ts); staff get
 * 403 here. Nothing about the office, finance or other campaigns is ever returned (lib/clientPortal.ts clientCopy).
 * Audit specs: lib/audit/clientSpecs.ts (every client-portal action is recorded).
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  CLIENT_POSTS_PER_DAY,
  clientCommissionTitle,
  clientPostProblems,
  clientPostPublishes,
  type ClientPortal,
  type ClientPostInput,
  type UserWithTeam,
} from '@lm/shared';
import { get, run, transaction, type Db } from '../db/connection.ts';
import { clientCampaignIdOf } from '../lib/client.ts';
import { campaignHeader, clientCopy, getClientPost, listClientPostsForCampaign } from '../lib/clientPortal.ts';
import { nowISO, todayISO } from '../lib/dates.ts';
import { HttpError, badRequest, notFound, tooManyRequests } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

/** The shape only; the rules (lengths, rates, dates) are the shared clientPostProblems. */
const postBody = z.object({
  kind: z.enum(['update', 'announcement', 'commission']),
  title: z.string().max(1000).optional().default(''),
  body: z.string().max(20_000).optional().default(''),
  rateRep: z.number().finite().nullable().optional(),
  ratePayout: z.number().finite().nullable().optional(),
  effectiveFrom: z.string().max(40).nullable().optional(),
});

/** The same post again within this long is a double tap: answered with the first one. */
const DUPLICATE_WINDOW_MS = 2 * 60_000;

const round2 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

/** The client's campaign: from the session (authenticate puts it there), else the users row. */
function campaignOf(db: Db, me: UserWithTeam): number {
  const id = me.clientCampaignId ?? clientCampaignIdOf(db, me.id);
  if (!id) throw notFound('Campaign');
  return id;
}

export function clientRouter(db: Db): Router {
  const router = Router();
  // The portal is the client's alone (this router has the /client prefix to itself).
  router.use(requireRole('client'));

  router.get('/portal', (req, res) => {
    const me = currentUser(req);
    const campaignId = campaignOf(db, me);
    const campaign = campaignHeader(db, campaignId);
    if (!campaign) throw notFound('Campaign');
    const body: ClientPortal = {
      campaign,
      me: { id: me.id, name: `${me.firstName} ${me.lastName}`, email: me.email },
      posts: listClientPostsForCampaign(db, campaignId),
    };
    res.json(body);
  });

  router.get('/posts', (req, res) => {
    res.json(listClientPostsForCampaign(db, campaignOf(db, currentUser(req))));
  });

  router.post('/posts', (req, res) => {
    const me = currentUser(req);
    const campaignId = campaignOf(db, me);
    const raw = postBody.parse(req.body);
    const input: ClientPostInput = { ...raw, title: raw.title.trim(), body: raw.body.trim() };
    const commission = input.kind === 'commission';
    if (!commission) {
      input.rateRep = null;
      input.ratePayout = null;
      input.effectiveFrom = null;
    }
    const problems = clientPostProblems(input, todayISO());
    if (problems.length) throw badRequest(problems[0]!.message, problems.map((p) => ({ path: p.field, message: p.message })));

    const now = nowISO();
    // Rate limits stay on the real clock (a pinned or moved business clock must not stretch or shrink them).
    const realNow = Date.now();
    const rateRep = round2(input.rateRep);
    const ratePayout = round2(input.ratePayout);
    const effectiveFrom = commission ? (input.effectiveFrom ?? null) : null;
    const title = input.title || clientCommissionTitle(effectiveFrom);

    // A double tap: the same post from the same account a moment ago is answered with that post.
    const duplicate = get<{ id: number }>(
      db,
      `SELECT id FROM client_posts WHERE author_id = ? AND kind = ? AND title = ? AND body = ? AND rate_rep IS ? AND rate_payout IS ? AND effective_from IS ? AND posted_at >= ?
       ORDER BY id DESC LIMIT 1`,
      [me.id, input.kind, title, input.body, rateRep, ratePayout, effectiveFrom, new Date(realNow - DUPLICATE_WINDOW_MS).toISOString()],
    );
    if (duplicate) return res.status(200).json(clientCopy(getClientPost(db, duplicate.id)!));

    const recent = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM client_posts WHERE author_id = ? AND posted_at >= ?`, [
      me.id, new Date(realNow - 86_400_000).toISOString(),
    ]);
    if (Number(recent?.n ?? 0) >= CLIENT_POSTS_PER_DAY) {
      throw tooManyRequests(`You have sent ${CLIENT_POSTS_PER_DAY} posts in the last 24 hours. Try again tomorrow, or call the Linear MCR office.`);
    }

    const id = transaction(db, () => {
      let announcementId: number | null = null;
      if (clientPostPublishes(input.kind)) {
        announcementId = run(db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES (?, ?, ?, ?, 0)`, [title, input.body, me.id, now]).lastInsertRowid;
      }
      return run(
        db,
        `INSERT INTO client_posts (campaign_id, author_id, kind, title, body, rate_rep, rate_payout, effective_from, requested_from, status, announcement_id, created_at, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [campaignId, me.id, input.kind, title, input.body, rateRep, ratePayout, effectiveFrom, effectiveFrom, commission ? 'pending' : 'published', announcementId, now, new Date(realNow).toISOString()],
      ).lastInsertRowid;
    });
    const post = getClientPost(db, id);
    if (!post) throw new HttpError(500, 'The post was not saved');
    res.status(201).json(clientCopy(post));
  });

  return router;
}
