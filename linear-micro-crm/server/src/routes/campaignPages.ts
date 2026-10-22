/**
 * Release 1.3 — the campaign page and its client accounts — OWNED BY P6 client-portal. Mounted at /campaigns BEFORE
 * the 1.0 campaigns router (routes/campaigns.ts): only the paths below are answered here, everything else falls through
 * to it. Role checks are per route, never router-wide, so the 1.0 routes keep their own rules.
 *
 *  GET  /campaigns/:id/page → CampaignPage (every staff role; cached per person):
 *       admin, leader (`full: true`): the campaign with its money, the rate history (P1's campaign_rates), every client
 *         post with its status and the caller's `unread`, and (admin) the client accounts and `paidThrough` (the last
 *         day of the latest paid pay week, for the Approve dialog's warning);
 *       recruiter, rep: the brief without money — no payout or rep rate, no rates, no commission changes, only the
 *         published updates and announcements — and no client contact (name, email and phone are null);
 *       everyone: the client's announcements (authored by this campaign's client accounts), this calendar month's
 *         events (a rep: their own team's only, as GET /events) and the sales logged this month and last month.
 *  GET  /campaigns/:id/client-accounts → ClientAccount[] (admin)
 *  POST /campaigns/:id/client-accounts  ClientInviteInput → 201 ClientInviteResult (admin): a client account with
 *       the next access code (lib/client.ts nextClientAccessCode: "CL-0002" onwards, never a demo code), no team, the
 *       owner's pay plan, no PIN — the first sign-in creates it (lib/pin.ts: a PIN is required for client accounts).
 *       The code and the sign-in instructions are in the answer, to copy into an email. 409 for an email that already
 *       has an account.
 */
import { Router } from 'express';
import { z } from 'zod';
import { clientInviteInstructions, type CampaignPage, type CampaignPageCampaign, type ClientInviteResult } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { ANNOUNCEMENT_SELECT, CAMPAIGN_SELECT, listEvents, mapAnnouncement, mapCampaign, type AnnouncementRow } from '../db/queries.ts';
import { clientPayPlanId, nextClientAccessCode } from '../lib/client.ts';
import { campaignBrief, getClientAccount, listClientAccounts, listOfficePosts } from '../lib/clientPortal.ts';
import { addDays, startOfMonth, todayISO } from '../lib/dates.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { listCampaignRates } from '../lib/payRule.ts';
import { idParam } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';
import type { Campaign } from '@lm/shared';

/** The client's announcements a campaign page lists at most (newest first). */
export const CAMPAIGN_PAGE_ANNOUNCEMENTS_MAX = 50;

const inviteBody = z.object({
  firstName: z.string().trim().min(1, 'Enter their first name').max(60),
  lastName: z.string().trim().min(1, 'Enter their last name').max(60),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(200),
  signInUrl: z.string().trim().max(300).regex(/^https?:\/\/[^\s]+$/i, 'Expected an http(s) address').optional(),
});

/** The last day of the month `first` (YYYY-MM-01) starts. */
function endOfMonth(first: string): string {
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

export function buildCampaignPage(db: Db, me: { id: number; role: string; teamId: number | null }, campaignId: number): CampaignPage | null {
  const row = get<Campaign>(db, `${CAMPAIGN_SELECT} WHERE c.id = ?`, [campaignId]);
  if (!row) return null;
  const brief = campaignBrief(db, campaignId)!;
  const full = me.role === 'admin' || me.role === 'leader';
  const base = mapCampaign(row);
  let campaign: CampaignPageCampaign;
  if (full) campaign = { ...base, ...brief };
  else {
    // Reps and recruiters: the brief without money, and without the client contact's personal email and phone
    // (field staff ask their leader or the office, who speak to the client).
    const { payoutPerSale: _payout, repCommissionPerSale: _rep, ...rest } = base;
    campaign = { ...rest, ...brief, contactName: null, contactEmail: null, contactPhone: null };
  }

  const today = todayISO();
  const monthFrom = startOfMonth(today);
  const monthTo = endOfMonth(monthFrom);
  const lastFrom = startOfMonth(addDays(monthFrom, -1));
  const sales = get<{ thisMonth: number | null; lastMonth: number | null }>(
    db,
    `SELECT SUM(CASE WHEN g.date >= ? THEN g.sales ELSE 0 END) AS thisMonth, SUM(CASE WHEN g.date < ? THEN g.sales ELSE 0 END) AS lastMonth
     FROM gauge_entries g JOIN events e ON e.id = g.event_id
     WHERE e.campaign_id = ? AND g.date BETWEEN ? AND ?`,
    [monthFrom, monthFrom, campaignId, lastFrom, monthTo],
  );

  // Events this month: a rep sees their own team's only (as GET /events); everyone else every team's.
  const repTeam = me.role === 'rep' ? me.teamId : undefined;
  const eventsThisMonth =
    repTeam === null
      ? []
      : listEvents(
          db,
          `WHERE e.campaign_id = ? AND e.date BETWEEN ? AND ?${repTeam !== undefined ? ' AND e.team_id = ?' : ''}`,
          repTeam !== undefined ? [campaignId, monthFrom, monthTo, repTeam] : [campaignId, monthFrom, monthTo],
          'e.date ASC, e.start_time ASC',
          { from: monthFrom, to: monthTo },
        );

  const announcements = all<AnnouncementRow>(
    db,
    `${ANNOUNCEMENT_SELECT} WHERE u.role = 'client' AND u.client_campaign_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ${CAMPAIGN_PAGE_ANNOUNCEMENTS_MAX}`,
    [campaignId],
  ).map(mapAnnouncement);

  const page: CampaignPage = {
    campaign,
    full,
    posts: full ? listOfficePosts(db, me, { campaignId }) : listOfficePosts(db, me, { campaignId, publishedOnly: true }),
    announcements,
    eventsThisMonth,
    sales: { thisMonth: Number(sales?.thisMonth ?? 0), lastMonth: Number(sales?.lastMonth ?? 0) },
  };
  if (full) page.rates = listCampaignRates(db, campaignId);
  if (me.role === 'admin') {
    page.clientAccounts = listClientAccounts(db, campaignId);
    // The Approve dialog warns when the new rate would start in a week someone has already been paid for.
    page.paidThrough = get<{ d: string | null }>(db, `SELECT MAX(week_end) AS d FROM payroll_runs WHERE status = 'paid'`)?.d ?? null;
  }
  return page;
}

export function campaignPagesRouter(db: Db): Router {
  const router = Router();

  router.get('/:id/page', requireRole('admin', 'leader', 'recruiter', 'rep'), (req, res) => {
    const page = buildCampaignPage(db, currentUser(req), idParam(req));
    if (!page) throw notFound('Campaign');
    res.json(page);
  });

  router.get('/:id/client-accounts', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    if (!get(db, `SELECT 1 FROM campaigns WHERE id = ?`, [id])) throw notFound('Campaign');
    res.json(listClientAccounts(db, id));
  });

  router.post('/:id/client-accounts', requireRole('admin'), (req, res) => {
    const campaignId = idParam(req);
    const campaign = get<{ id: number; name: string; color: string }>(db, `SELECT id, name, color FROM campaigns WHERE id = ?`, [campaignId]);
    if (!campaign) throw notFound('Campaign');
    const input = inviteBody.parse(req.body ?? {});
    if (get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?)`, [input.email])) throw conflict(`${input.email} already has an account`);
    const accessCode = nextClientAccessCode(db);
    const id = run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city, client_campaign_id)
       VALUES (?, ?, ?, ?, 'client', 'client', NULL, ?, ?, 'active', NULL, ?, NULL, ?)`,
      [accessCode, input.email, input.firstName, input.lastName, clientPayPlanId(db), todayISO(), campaign.color, campaignId],
    ).lastInsertRowid;
    const account = getClientAccount(db, id)!;
    const result: ClientInviteResult = {
      account,
      accessCode,
      instructions: clientInviteInstructions({ firstName: input.firstName, email: input.email, accessCode, campaignName: campaign.name, signInUrl: input.signInUrl }),
    };
    res.status(201).json(result);
  });

  return router;
}
