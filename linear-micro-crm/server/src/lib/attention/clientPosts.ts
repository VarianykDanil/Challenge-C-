/**
 * Release 1.3 — OWNED BY P6 client-portal. Needs-attention items of kind 'client' (the dashboard's top box and the
 * bell, "Client updates"), for admins and leaders only — every other role gets none:
 *  - admin: every commission change waiting for approval (warning, `client:commission:<id>`), until it is approved or
 *    declined, read or not;
 *  - admin and leader: every other client post they have not read yet, from the last CLIENT_POST_UNREAD_DAYS days
 *    (info, `client:post:<id>`): an update or an announcement ("Update from Breast Cancer Now"), or, for a leader, a
 *    commission change ("waiting for the office"). Reading it on the campaign page clears it.
 * One statement per caller (the feed's 1.1 budget of 12 holds with every provider merged): for an admin, a UNION ALL of
 * the changes to approve (every one of them up to the feed's cap, never pushed out by newer posts: a change waits for
 * Matt until he decides it) and at most CLIENT_ATTENTION_MAX unread posts, newest first (the pending changes are not
 * counted twice); for a leader, the unread posts alone. Each item links to the post on its campaign page.
 * Contract: ./types.ts.
 */
import { ATTENTION_MAX_ITEMS, clientCommissionSummary, type AttentionItem } from '@lm/shared';
import { all } from '../../db/connection.ts';
import { unreadSince } from '../clientPortal.ts';
import type { AttentionProvider } from './types.ts';

/** The most unread-post (info) items one feed carries; the admin's changes to approve come on top (the feed keeps 20 in all). */
export const CLIENT_ATTENTION_MAX = 8;

interface Row {
  id: number;
  kind: 'update' | 'announcement' | 'commission';
  title: string;
  status: string;
  rateRep: number | null;
  ratePayout: number | null;
  effectiveFrom: string | null;
  createdAt: string;
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  authorName: string;
}

const COLUMNS = `p.id, p.kind, p.title, p.status, p.rate_rep AS rateRep, p.rate_payout AS ratePayout, p.effective_from AS effectiveFrom,
  p.created_at AS createdAt, p.campaign_id AS campaignId, c.code AS campaignCode, c.name AS campaignName,
  TRIM(a.first_name || ' ' || a.last_name) AS authorName`;
const FROM = `FROM client_posts p JOIN campaigns c ON c.id = p.campaign_id JOIN users a ON a.id = p.author_id`;

const quoted = (s: string) => `“${s}”`;

export const provider: AttentionProvider = {
  name: 'client-posts',
  items(db, me, now) {
    if (me.role !== 'admin' && me.role !== 'leader') return [];
    const admin = me.role === 'admin';
    const since = unreadSince(now.nowISO);
    // The newest unread posts (an admin's pending changes come from the first part instead).
    const unread = `SELECT 1 AS part, ${COLUMNS} ${FROM}
       LEFT JOIN client_post_reads r ON r.post_id = p.id AND r.user_id = ?
       WHERE r.post_id IS NULL AND p.created_at >= ? AND p.status <> 'unpublished'${admin ? ` AND p.status <> 'pending'` : ''}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${CLIENT_ATTENTION_MAX}`;
    // For an admin, the decisions first, all of them (the feed's own cap keeps warnings ahead of info items): each part
    // keeps its own ORDER BY and LIMIT inside a subselect, in one statement.
    const rows = admin
      ? all<Row>(
          db,
          `SELECT * FROM (SELECT 0 AS part, ${COLUMNS} ${FROM} WHERE p.status = 'pending' ORDER BY p.created_at DESC, p.id DESC LIMIT ${ATTENTION_MAX_ITEMS})
           UNION ALL
           SELECT * FROM (${unread})
           ORDER BY part, createdAt DESC, id DESC`,
          [me.id, since],
        )
      : all<Row>(db, unread, [me.id, since]);
    return rows.map((p): AttentionItem => {
      const href = `/campaigns/${p.campaignId}?post=${p.id}`;
      const change = clientCommissionSummary(p);
      if (p.kind === 'commission' && p.status === 'pending' && admin) {
        return {
          key: `client:commission:${p.id}`,
          kind: 'client',
          severity: 'warning',
          title: `${p.campaignName} asks to change commission`,
          body: `${p.authorName} asked for ${change || 'a new rate'}. Approve it with the date it starts, or decline it with a reason.`,
          href,
          actionLabel: 'Review',
          at: p.createdAt,
        };
      }
      const what = p.kind === 'announcement' ? 'Announcement' : p.kind === 'update' ? 'Update' : 'Commission change';
      const body =
        p.kind === 'commission'
          ? `${quoted(p.title)} from ${p.authorName}${change ? `: ${change}` : ''}.${p.status === 'pending' ? ' Waiting for the office to approve it.' : ''}`
          : `${quoted(p.title)} from ${p.authorName}. It is in Announcements.`;
      return {
        key: `client:post:${p.id}`,
        kind: 'client',
        severity: 'info',
        title: `${what} from ${p.campaignName}`,
        body,
        href,
        actionLabel: 'Read it',
        at: p.createdAt,
      };
    });
  },
};
