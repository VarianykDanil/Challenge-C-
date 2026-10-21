/**
 * Release 1.3 — P6 client-portal contracts (laid down by r3-foundation; OWNED BY P6, which may add fields and types).
 *
 * Owner's decision 6 (quote): "Client accounts: each campaign's client gets a login with ONLY a quick form for updates,
 * announcements and commission changes. No finance, nothing about the office. A post appears in Matt's top box (Needs
 * attention) and in Announcements. Campaigns (sidebar) opens each client's page with its full description and every
 * announcement."
 * Lead decisions: sign-in with a generated access code ("CL-0001") + email, and a PIN is REQUIRED for client accounts
 * (the demo account has it off so the sign-in buttons work); "update" / "announcement" posts publish straight to
 * Announcements (badge "From Breast Cancer Now"; Matt can unpublish); commission changes always wait for Matt.
 *
 * The client role (r3-foundation): users.role = 'client', users.client_campaign_id, position 'client', employee_id =
 * the access code. The server's client guard (middleware/clientGuard.ts, foundation, STABLE) lets a client session
 * call ONLY /health, /auth/me, /auth/logout, /auth/login, /auth/login/2fa, /auth/demo-accounts, /auth/pin(/*) and
 * /client(/*); everything else answers 403 ClientPortalOnlyError.
 *
 * Endpoints (owned by P6; stubs: reads empty, writes 501):
 *  routes/client.ts, mounted at /client (the client's own portal; client role only, others 403):
 *   - GET  /client/portal                → ClientPortal
 *   - GET  /client/posts                 → ClientPost[] (their campaign's posts, newest first)
 *   - POST /client/posts  ClientPostInput → 201 ClientPost
 *  routes/clientOffice.ts (admin; leaders read-only where noted):
 *   - GET  /client-posts?status=&campaignId= → ClientPost[] (admin, leader)
 *   - GET  /client-posts/unread             → { count } (the sidebar badge; admin, leader)
 *   - POST /client-posts/:id/read           → 204
 *   - POST /client-posts/:id/approve  ClientPostDecisionInput → ClientPost (commission: new campaign_rates row via
 *     P1's lib/payRule.ts addCampaignRate, effective from the date Matt confirms)
 *   - POST /client-posts/:id/decline  ClientPostDecisionInput → ClientPost (the reason is shown to the client)
 *   - POST /client-posts/:id/unpublish → ClientPost (removes it from Announcements)
 *   - PATCH /client-accounts/:id  { status } → ClientAccount (deactivate / reactivate)
 *   - POST /client-accounts/:id/reset-pin → ClientAccount
 *  routes/campaignPages.ts, mounted at /campaigns before the campaigns router:
 *   - GET  /campaigns/:id/page → CampaignPage (admin, leader; reps: the brief without money) — cached
 *   - GET  /campaigns/:id/client-accounts → ClientAccount[] (admin)
 *   - POST /campaigns/:id/client-accounts  ClientInviteInput → 201 ClientInviteResult (admin; the code shown once)
 * Tables (server/src/db/extensions/client.ts): client_posts; users.client_campaign_id; campaigns columns
 * long_description, brief, contact_name, contact_email, contact_phone.
 */
import type { Announcement, Campaign, SalesEventWithMeta } from '../types.ts';
import type { CampaignRate } from './pay.ts';

/** Client access codes look like employee IDs: "CL-0001". */
export const CLIENT_ACCESS_CODE_PREFIX = 'CL-';

/** The 403 a client session gets from any route outside the portal (middleware/clientGuard.ts). */
export interface ClientPortalOnlyError {
  error: string;
  clientPortalOnly: true;
}

export type ClientPostKind = 'update' | 'announcement' | 'commission';
export type ClientPostStatus = 'published' | 'pending' | 'approved' | 'declined' | 'unpublished';

export interface ClientPost {
  id: number;
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  authorId: number;
  authorName: string;
  kind: ClientPostKind;
  title: string;
  body: string;
  /** Commission changes: the new £ per sub to the rep and / or the client's payout per sub. */
  rateRep: number | null;
  ratePayout: number | null;
  effectiveFrom: string | null;
  status: ClientPostStatus;
  decidedBy: number | null;
  decidedByName?: string | null;
  decidedAt: string | null;
  /** Declined: the reason the client sees. */
  decisionNote: string | null;
  /** The Announcements row it published (update / announcement). */
  announcementId: number | null;
  createdAt: string;
}

export interface ClientPostInput {
  kind: ClientPostKind;
  title: string;
  body: string;
  rateRep?: number | null;
  ratePayout?: number | null;
  effectiveFrom?: string | null;
}

export interface ClientPostDecisionInput {
  /** Approve (commission): the date the new rate applies from, as Matt confirms it. */
  effectiveFrom?: string;
  note?: string;
}

/** GET /client/portal — everything the portal shows, and nothing about the office. */
export interface ClientPortal {
  campaign: { id: number; code: string; name: string; color: string };
  me: { id: number; name: string; email: string };
  posts: ClientPost[];
}

export type ClientAccountStatus = 'active' | 'left';

export interface ClientAccount {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  /** "CL-0001" (users.employee_id). */
  accessCode: string;
  campaignId: number;
  status: ClientAccountStatus;
  hasPin: boolean;
  createdAt: string | null;
}

export interface ClientInviteInput {
  firstName: string;
  lastName: string;
  email: string;
}

export interface ClientInviteResult {
  account: ClientAccount;
  /** Shown once. */
  accessCode: string;
  /** Plain sign-in instructions to copy into an email. */
  instructions: string;
}

/** Announcement.fromClient — the badge "From Breast Cancer Now". */
export interface AnnouncementSource {
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  campaignColor: string;
}

/** The campaign's extra fields (campaigns columns added by the client extension). */
export interface CampaignBrief {
  longDescription: string | null;
  brief: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

/** GET /campaigns/:id/page. Money (rates, payout, revenue) only for admins and leaders. */
export interface CampaignPage {
  campaign: Campaign & CampaignBrief;
  rates?: CampaignRate[];
  clientAccounts?: ClientAccount[];
  posts: ClientPost[];
  announcements: Announcement[];
  eventsThisMonth: SalesEventWithMeta[];
  sales: { thisMonth: number; lastMonth: number };
}
