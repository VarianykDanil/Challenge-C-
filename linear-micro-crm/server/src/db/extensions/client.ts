/**
 * Release 1.3 — OWNED BY P6 client-portal (laid down by r3-foundation: the client role's column and the tables below are
 * the contract; P6 adds data steps, seed rows and further columns or tables, e.g. office read receipts for the sidebar
 * badge, always with addColumnIfMissing / CREATE TABLE IF NOT EXISTS).
 *
 *  - users.client_campaign_id: the campaign a `client` account belongs to (NULL for staff). Read by the client guard
 *    (middleware/clientGuard.ts) and authenticate (req.user.clientCampaignId). The demo client account
 *    (Hannah Price, Breast Cancer Now, CL-0001) is inserted by the CORE demo seed (db/seed.ts), not here.
 *  - client_posts: what a client posted from the portal — kind 'update' | 'announcement' | 'commission', title, body,
 *    the proposed rates and effective date for a commission change, status 'published' | 'pending' | 'approved' |
 *    'declined' | 'unpublished', the decision (who, when, the note the client sees) and the Announcements row it
 *    published.
 *  - campaigns columns (the campaign page): long_description, brief, contact_name, contact_email, contact_phone. A
 *    fresh demo seed may fill them for the seeded campaigns from `seed` (columns this extension added; see ./types.ts).
 * Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';
import { addColumnIfMissing } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS client_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  rate_rep REAL,
  rate_payout REAL,
  effective_from TEXT,
  status TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT,
  decision_note TEXT,
  announcement_id INTEGER REFERENCES announcements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_posts_campaign ON client_posts(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_client_posts_status ON client_posts(status);
`;

export const extension: DbExtension = {
  name: 'client',
  sql: SQL,
  upgrade(db) {
    const added = [
      addColumnIfMissing(db, 'users', 'client_campaign_id', 'INTEGER'),
      addColumnIfMissing(db, 'campaigns', 'long_description', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'brief', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'contact_name', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'contact_email', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'contact_phone', 'TEXT'),
    ];
    // The guard and the portal look client accounts up by campaign (after the column exists; idempotent).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_client_campaign ON users(client_campaign_id)`);
    return added.filter((name): name is string => name !== null);
  },
};
