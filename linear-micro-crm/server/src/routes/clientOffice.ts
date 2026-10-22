/**
 * Release 1.3 — the office side of the client portal — OWNED BY P6 client-portal. Two routers, each with its own prefix:
 *
 *  clientPostsRouter, mounted at /client-posts (admin, leader; decisions admin only):
 *   GET  /client-posts?status=&campaignId=           → ClientPost[] (newest first, each with `unread` for the caller)
 *   GET  /client-posts/unread                        → { count } (the sidebar Campaigns badge)
 *   POST /client-posts/read  { ids: number[] }        → 204 (at most 200 ids; unknown ids ignored): the caller's
 *        read receipts for every post the campaign page shows, in one statement (idempotent)
 *   POST /client-posts/:id/read                      → 204 (idempotent; the caller's own read receipt)
 *   POST /client-posts/:id/approve  ClientPostDecisionInput → ClientPost — a pending commission change only: a new
 *        campaign_rates row through P1's lib/payRule.ts addCampaignRate (source 'client', clientPostId), effective from
 *        the date Matt confirms (default: the client's), so unpaid weeks from that date recalculate. 409 for anything
 *        but a pending commission change. The post and the rate are written together or not at all.
 *   POST /client-posts/:id/decline  { note }         → ClientPost — a pending commission change; the reason is
 *        required and shown to the client ("Declined: …").
 *   POST /client-posts/:id/unpublish  { note? }      → ClientPost — a published update or announcement: its
 *        Announcements row is removed (and its read receipts with it); the client sees "Unpublished".
 *  clientAccountsRouter, mounted at /client-accounts (admin):
 *   PATCH /client-accounts/:id  ClientAccountUpdateInput → ClientAccount (deactivate signs them out everywhere)
 *   POST  /client-accounts/:id/reset-pin             → ClientAccount (clears the PIN and its lock, signs them out;
 *        they create a new PIN at their next sign-in)
 *  404 "Client post not found" / "Client account not found" for an unknown id, or a staff member's id.
 * Inviting an account (POST /campaigns/:id/client-accounts) is in routes/campaignPages.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { MONEY_MAX, type ClientAccountUpdateInput, type ClientPostStatus } from '@lm/shared';
import { get, run, transaction, type Db } from '../db/connection.ts';
import {
  CLIENT_POSTS_READ_MAX,
  countUnreadClientPosts,
  getClientAccount,
  getClientPost,
  listOfficePosts,
  markClientPostRead,
  markClientPostsRead,
} from '../lib/clientPortal.ts';
import { addDays, isISODate, nowISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { addCampaignRate, campaignRateOn } from '../lib/payRule.ts';
import { resetPinAndSignOut } from '../lib/pin.ts';
import { idParam, optionalIdQuery } from '../lib/validate.ts';
import { currentUser, destroyUserSessions, requireRole } from '../middleware/auth.ts';

const STATUSES: readonly ClientPostStatus[] = ['published', 'pending', 'approved', 'declined', 'unpublished'];

const approveBody = z.object({
  effectiveFrom: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
});
const declineBody = z.object({ note: z.string().trim().max(500).optional().default('') });
const unpublishBody = z.object({ note: z.string().trim().max(500).optional() });
const readBody = z.object({
  ids: z.array(z.number().int().positive()).max(CLIENT_POSTS_READ_MAX, `At most ${CLIENT_POSTS_READ_MAX} posts at a time`),
});

const nameField = z.string().trim().min(1, 'Required').max(60);
const accountPatch = z.object({
  status: z.enum(['active', 'left']).optional(),
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(200).optional(),
});

/** The latest effective date Matt may confirm (P1's rate history accepts a year ahead). */
const APPROVE_MAX_DAYS = 366;

const postOr404 = (db: Db, id: number) => {
  const post = getClientPost(db, id);
  if (!post) throw notFound('Client post');
  return post;
};

export function clientPostsRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireRole('admin', 'leader'), (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : undefined;
    if (status !== undefined && !STATUSES.includes(status as ClientPostStatus)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    const campaignId = optionalIdQuery(req.query.campaignId, 'campaignId');
    res.json(listOfficePosts(db, currentUser(req), { status: status as ClientPostStatus | undefined, campaignId }));
  });

  router.get('/unread', requireRole('admin', 'leader'), (req, res) => {
    res.json({ count: countUnreadClientPosts(db, currentUser(req)) });
  });

  // The campaign page reads every post it shows in one request (one write, one cache refresh), not one per post.
  router.post('/read', requireRole('admin', 'leader'), (req, res) => {
    const { ids } = readBody.parse(req.body ?? {});
    markClientPostsRead(db, [...new Set(ids)], currentUser(req).id);
    res.status(204).end();
  });

  router.post('/:id/read', requireRole('admin', 'leader'), (req, res) => {
    const post = postOr404(db, idParam(req));
    markClientPostRead(db, post.id, currentUser(req).id);
    res.status(204).end();
  });

  router.post('/:id/approve', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const post = postOr404(db, idParam(req));
    const body = approveBody.parse(req.body ?? {});
    if (post.kind !== 'commission') throw conflict('Only a commission change needs approval. Updates and announcements are published straight away.');
    if (post.status !== 'pending') throw conflict(`This commission change was already ${post.status}.`);
    const effectiveFrom = body.effectiveFrom || post.effectiveFrom;
    if (!effectiveFrom || !isISODate(effectiveFrom)) throw badRequest('Pick the date the new rate applies from', [{ path: 'effectiveFrom', message: 'Pick a date' }]);
    const latest = addDays(todayISO(), APPROVE_MAX_DAYS);
    if (effectiveFrom > latest) throw badRequest('Pick a date within a year from today', [{ path: 'effectiveFrom', message: 'Within a year from today' }]);
    const campaign = get<{ startDate: string; rep: number; payout: number }>(
      db, `SELECT start_date AS startDate, rep_commission_per_sale AS rep, payout_per_sale AS payout FROM campaigns WHERE id = ?`, [post.campaignId],
    );
    if (!campaign) throw notFound('Campaign');
    if (effectiveFrom < campaign.startDate) throw badRequest('Pick a date on or after the campaign started', [{ path: 'effectiveFrom', message: 'On or after the campaign start' }]);
    // A change of one rate keeps the other as it is on that date (the history's rate, else the campaign's own).
    const current = campaignRateOn(db, post.campaignId, effectiveFrom);
    const repRate = post.rateRep ?? current?.repRate ?? campaign.rep;
    const payoutRate = post.ratePayout ?? current?.payoutRate ?? campaign.payout;
    if (!(repRate >= 0 && repRate <= MONEY_MAX) || !(payoutRate > 0 && payoutRate <= MONEY_MAX)) throw badRequest('The rates in this change are not valid');
    transaction(db, () => {
      // P1's rate history: the new row, and the recalculation of unpaid weeks from that date (paid weeks never change).
      addCampaignRate(db, { campaignId: post.campaignId, repRate, payoutRate, effectiveFrom, source: 'client', clientPostId: post.id }, me.id);
      run(
        db,
        `UPDATE client_posts SET status = 'approved', effective_from = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'`,
        [effectiveFrom, me.id, nowISO(), body.note || null, post.id],
      );
    });
    markClientPostRead(db, post.id, me.id);
    res.json(getClientPost(db, post.id));
  });

  router.post('/:id/decline', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const post = postOr404(db, idParam(req));
    const { note } = declineBody.parse(req.body ?? {});
    if (post.kind !== 'commission') throw conflict('Only a commission change can be declined. Unpublish an update or announcement instead.');
    if (post.status !== 'pending') throw conflict(`This commission change was already ${post.status}.`);
    if (!note) throw badRequest('Tell the client why, in a sentence. They see it in their portal.', [{ path: 'note', message: 'Say why' }]);
    run(db, `UPDATE client_posts SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'`, [me.id, nowISO(), note, post.id]);
    markClientPostRead(db, post.id, me.id);
    res.json(getClientPost(db, post.id));
  });

  router.post('/:id/unpublish', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const post = postOr404(db, idParam(req));
    const { note } = unpublishBody.parse(req.body ?? {});
    if (post.status !== 'published') throw conflict('Only a published update or announcement can be unpublished.');
    transaction(db, () => {
      if (post.announcementId) run(db, `DELETE FROM announcements WHERE id = ?`, [post.announcementId]);
      run(
        db,
        `UPDATE client_posts SET status = 'unpublished', announcement_id = NULL, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`,
        [me.id, nowISO(), note || null, post.id],
      );
    });
    markClientPostRead(db, post.id, me.id);
    res.json(getClientPost(db, post.id));
  });

  return router;
}

export function clientAccountsRouter(db: Db): Router {
  const router = Router();

  router.patch('/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    const account = getClientAccount(db, id);
    if (!account) throw notFound('Client account');
    const patch: ClientAccountUpdateInput = accountPatch.parse(req.body ?? {});
    if (patch.status === undefined && patch.firstName === undefined && patch.lastName === undefined && patch.email === undefined) {
      throw badRequest('Nothing to change: send a status, a name or an email');
    }
    if (patch.email && patch.email !== account.email.toLowerCase()) {
      if (get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?) AND id <> ?`, [patch.email, id])) throw conflict(`${patch.email} already has an account`);
    }
    transaction(db, () => {
      run(
        db,
        `UPDATE users SET first_name = ?, last_name = ?, email = ?, status = ? WHERE id = ? AND role = 'client'`,
        [patch.firstName ?? account.firstName, patch.lastName ?? account.lastName, patch.email ?? account.email, patch.status ?? account.status, id],
      );
      // Deactivated: signed out everywhere at once (authenticate also refuses a 'left' session).
      if (patch.status === 'left') destroyUserSessions(db, id);
    });
    res.json(getClientAccount(db, id));
  });

  router.post('/:id/reset-pin', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    if (!getClientAccount(db, id)) throw notFound('Client account');
    resetPinAndSignOut(db, id);
    res.json(getClientAccount(db, id));
  });

  return router;
}
