/**
 * Release 1.3 — OWNED BY P6 client-portal. The queries behind the client portal and its office side: client posts (as
 * the client sees them and as the office sees them, with the office's read receipts), client accounts, the campaign
 * page's brief and the counts the sidebar badge and the Needs-attention items use. One or two grouped statements per
 * call, never a query per row. lib/client.ts (foundation) keeps the client role's own helpers.
 *
 * What a client session may see is built here and nowhere else: its own campaign's posts, without the office's ids
 * or names (decidedBy is null and decidedByName absent on the client's copy), and nothing about other campaigns.
 */
import {
  CLIENT_POST_UNREAD_DAYS,
  type CampaignBrief,
  type ClientAccount,
  type ClientPost,
  type ClientPostStatus,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, type Db, type Param } from '../db/connection.ts';
import { nowISO } from './dates.ts';

/** The posts the client's history and the office's lists show at most (newest first). */
export const CLIENT_POSTS_LIST_MAX = 200;

const POST_COLUMNS = `
  p.id, p.campaign_id AS campaignId, c.code AS campaignCode, c.name AS campaignName, p.author_id AS authorId,
  a.first_name || ' ' || a.last_name AS authorName, p.kind, p.title, p.body, p.rate_rep AS rateRep, p.rate_payout AS ratePayout,
  p.effective_from AS effectiveFrom, p.requested_from AS requestedFrom, p.status, p.decided_by AS decidedBy,
  d.first_name || ' ' || d.last_name AS decidedByName, p.decided_at AS decidedAt, p.decision_note AS decisionNote,
  p.announcement_id AS announcementId, p.created_at AS createdAt`;

const POST_FROM = `
  FROM client_posts p
  JOIN campaigns c ON c.id = p.campaign_id
  JOIN users a ON a.id = p.author_id
  LEFT JOIN users d ON d.id = p.decided_by`;

type PostRow = ClientPost & { unreadFlag?: number | null };

/** The moment before which a post counts as read for the office (CLIENT_POST_UNREAD_DAYS on the business clock). */
export function unreadSince(nowIso: string = nowISO()): string {
  return new Date(Date.parse(nowIso) - CLIENT_POST_UNREAD_DAYS * 86_400_000).toISOString();
}

function mapOffice(row: PostRow): ClientPost {
  const { unreadFlag, ...post } = row;
  const out: ClientPost = { ...post, decidedByName: post.decidedByName ?? null };
  if (unreadFlag !== undefined) out.unread = Boolean(unreadFlag);
  return out;
}

/**
 * The client's copy: nothing about who in the office decided (they read "Linear"), and no office note. The decline
 * reason is written for the client ("Declined: …"); a note on an approval or an unpublish is the office's own record
 * ("Note for the record", kept in the office's copy and the audit trail) and never leaves the office.
 */
export function clientCopy(post: ClientPost): ClientPost {
  const { decidedByName: _name, unread: _unread, ...rest } = post;
  return { ...rest, decidedBy: null, decisionNote: post.status === 'declined' ? post.decisionNote : null };
}

/** One post as the office sees it (no read flag), or undefined. */
export function getClientPost(db: Db, id: number): ClientPost | undefined {
  const row = get<PostRow>(db, `SELECT ${POST_COLUMNS} ${POST_FROM} WHERE p.id = ?`, [id]);
  return row ? mapOffice(row) : undefined;
}

/** A client's history: every post of its campaign, newest first, as the client sees them. */
export function listClientPostsForCampaign(db: Db, campaignId: number): ClientPost[] {
  return all<PostRow>(db, `SELECT ${POST_COLUMNS} ${POST_FROM} WHERE p.campaign_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ${CLIENT_POSTS_LIST_MAX}`, [campaignId])
    .map(mapOffice)
    .map(clientCopy);
}

export interface OfficePostFilter {
  status?: ClientPostStatus | null;
  campaignId?: number | null;
  /** Reps and recruiters on the campaign page: published updates and announcements only. */
  publishedOnly?: boolean;
}

/**
 * Posts as an admin or leader sees them, each with `unread` for `me` (no read receipt and newer than unreadSince),
 * newest first. With `publishedOnly` (the campaign page for reps and recruiters) no read flags are attached.
 */
export function listOfficePosts(db: Db, me: Pick<UserWithTeam, 'id'>, f: OfficePostFilter = {}): ClientPost[] {
  const where: string[] = [];
  const params: Param[] = [];
  if (f.status) {
    where.push('p.status = ?');
    params.push(f.status);
  }
  if (f.campaignId) {
    where.push('p.campaign_id = ?');
    params.push(f.campaignId);
  }
  if (f.publishedOnly) {
    where.push(`p.status = 'published'`);
    const rows = all<PostRow>(db, `SELECT ${POST_COLUMNS} ${POST_FROM} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ${CLIENT_POSTS_LIST_MAX}`, params);
    return rows.map(mapOffice).map(clientCopy);
  }
  const sql = `SELECT ${POST_COLUMNS}, (r.post_id IS NULL AND p.created_at >= ? AND p.status <> 'unpublished') AS unreadFlag ${POST_FROM}
    LEFT JOIN client_post_reads r ON r.post_id = p.id AND r.user_id = ?
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC, p.id DESC LIMIT ${CLIENT_POSTS_LIST_MAX}`;
  return all<PostRow>(db, sql, [unreadSince(), me.id, ...params]).map(mapOffice);
}

/** The sidebar badge: posts `me` has not read (newer than unreadSince, not unpublished). */
export function countUnreadClientPosts(db: Db, me: Pick<UserWithTeam, 'id'>): number {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM client_posts p
     WHERE p.created_at >= ? AND p.status <> 'unpublished'
       AND NOT EXISTS (SELECT 1 FROM client_post_reads r WHERE r.post_id = p.id AND r.user_id = ?)`,
    [unreadSince(), me.id],
  );
  return Number(row?.n ?? 0);
}

/** Records that `userId` has read `postId` (idempotent; real clock). */
export function markClientPostRead(db: Db, postId: number, userId: number): void {
  db.prepare(`INSERT OR IGNORE INTO client_post_reads (post_id, user_id, read_at) VALUES (?, ?, ?)`).run(postId, userId, new Date().toISOString());
}

/** The most posts one batch of read receipts takes (a campaign page lists at most CLIENT_POSTS_LIST_MAX). */
export const CLIENT_POSTS_READ_MAX = CLIENT_POSTS_LIST_MAX;

/**
 * Records that `userId` has read every post in `postIds` (unknown ids are ignored), in ONE statement: the campaign page
 * reads all its posts with a single request instead of one per post. Idempotent; real clock. Returns the new receipts.
 */
export function markClientPostsRead(db: Db, postIds: readonly number[], userId: number): number {
  if (!postIds.length) return 0;
  return Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO client_post_reads (post_id, user_id, read_at)
         SELECT p.id, ?, ? FROM client_posts p WHERE p.id IN (SELECT value FROM json_each(?))`,
      )
      .run(userId, new Date().toISOString(), JSON.stringify(postIds)).changes,
  );
}

// ── client accounts ──

const ACCOUNT_SELECT = `
  SELECT u.id, u.first_name AS firstName, u.last_name AS lastName, u.email, u.employee_id AS accessCode,
         u.client_campaign_id AS campaignId, u.status, (u.pin_hash IS NOT NULL) AS hasPin, u.start_date AS createdAt
  FROM users u WHERE u.role = 'client'`;

type AccountRow = Omit<ClientAccount, 'hasPin'> & { hasPin: number | boolean };

const mapAccount = (r: AccountRow): ClientAccount => ({ ...r, hasPin: Boolean(r.hasPin), status: r.status === 'left' ? 'left' : 'active' });

/** One client account (never a staff member: 404s come from undefined). */
export function getClientAccount(db: Db, id: number): ClientAccount | undefined {
  const row = get<AccountRow>(db, `${ACCOUNT_SELECT} AND u.id = ?`, [id]);
  return row ? mapAccount(row) : undefined;
}

/** A campaign's client accounts: active first, then by name. */
export function listClientAccounts(db: Db, campaignId: number): ClientAccount[] {
  return all<AccountRow>(db, `${ACCOUNT_SELECT} AND u.client_campaign_id = ? ORDER BY (u.status = 'left') ASC, u.last_name, u.first_name, u.id`, [campaignId]).map(mapAccount);
}

// ── the campaign's brief ──

export function campaignBrief(db: Db, campaignId: number): CampaignBrief | undefined {
  return get<CampaignBrief>(
    db,
    `SELECT long_description AS longDescription, brief, contact_name AS contactName, contact_email AS contactEmail, contact_phone AS contactPhone
     FROM campaigns WHERE id = ?`,
    [campaignId],
  );
}

/** The campaign's id, code, name and colour (the portal's header), or undefined. */
export function campaignHeader(db: Db, campaignId: number): { id: number; code: string; name: string; color: string } | undefined {
  return get(db, `SELECT id, code, name, color FROM campaigns WHERE id = ?`, [campaignId]);
}
