/**
 * Release 1.3 — OWNED BY P3 statements (laid down by r3-foundation: the five tables below are the contract; P3 adds
 * columns with addColumnIfMissing, the statement_allocations table and the demo seed).
 *
 *  - campaign_statement_senders: the address(es) each campaign's statements come from (the mail job searches only these).
 *  - statement_templates: a per-campaign column mapping (header texts), saved by the admin or by the first Apply.
 *  - statements: one per PDF (source 'email' | 'upload'; message_id UNIQUE for mail — "<Message-ID>#<attachment n>" —
 *    so an attachment is fetched once), the stored file under server/data/statements/ (git-ignored), the period, status
 *    'parsed' | 'needs_review' | 'applied' | 'failed', the error in plain words, and who applied it when. P3 adds:
 *    table_json (the table as read: headers, rows, totals, the lines above it), mapping_json + mapping_source ('template'
 *    | 'detected'), layout ('totals' | 'per-sub'), effect_json (P1's ApplyResult when applied), sender, subject,
 *    superseded_by (a later statement for exactly the same period that replaced it), sender_verified (email only: 1 when
 *    Gmail's own Authentication-Results said DKIM or DMARC passed for the From address's domain, else 0; only a verified
 *    email statement applies itself).
 *  - statement_rows: the parsed table rows (raw cells as JSON), the fundraiser ref / name, a sale date or period, the
 *    confirmed (and cancelled) count, the amount, and the matched person (match 'auto' | 'manual' | 'none'; manual with
 *    no person = "not one of ours").
 *  - user_client_refs: each person's fundraiser ID at a client (Team → person → "Client IDs"); one per (person,
 *    campaign), and a ref belongs to one person per campaign.
 *  - statement_allocations (P3): per applied statement, person and pay week, the subs logged and confirmed on the
 *    statement's own days, and the whole-week figure sent to pay — so a later statement of the same client that covers
 *    the rest of a week (a monthly statement splits weeks) keeps this one's confirmation.
 *  - meta `ext:statements:mail`: the Gmail address, the app password ENCRYPTED with the app-secret key (lib/crypto.ts),
 *    whether the 15-minute check is on, last check, last error, the mailbox, its UIDVALIDITY and the last seen UID.
 *    Never returned by an API, never in the audit trail.
 *  - meta `ext:statements:demo`: the demo seed's statements as PDF specs, drawn the first time someone opens them.
 * Rules: ./types.ts. The seed writes only these tables and its own meta keys (never a core row).
 */
import { seedDemoStatements } from '../../lib/statements/demo.ts';
import { addColumnIfMissing, type DbExtension } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS campaign_statement_senders (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (campaign_id, address)
);

CREATE TABLE IF NOT EXISTS statement_templates (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  mapping TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  message_id TEXT UNIQUE,
  received_at TEXT NOT NULL,
  file_path TEXT,
  file_name TEXT,
  file_sha256 TEXT,
  period_start TEXT,
  period_end TEXT,
  status TEXT NOT NULL DEFAULT 'parsed',
  error TEXT,
  applied_at TEXT,
  applied_by INTEGER,
  table_json TEXT,
  mapping_json TEXT,
  mapping_source TEXT,
  layout TEXT,
  effect_json TEXT,
  sender TEXT,
  subject TEXT,
  superseded_by INTEGER,
  sender_verified INTEGER
);
CREATE INDEX IF NOT EXISTS idx_statements_campaign ON statements(campaign_id, received_at);
CREATE INDEX IF NOT EXISTS idx_statements_status ON statements(status);

CREATE TABLE IF NOT EXISTS statement_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  fundraiser_ref TEXT,
  name TEXT,
  period_start TEXT,
  period_end TEXT,
  sale_date TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER,
  amount REAL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  match TEXT NOT NULL DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS idx_statement_rows_statement ON statement_rows(statement_id);
CREATE INDEX IF NOT EXISTS idx_statement_rows_user ON statement_rows(user_id);

CREATE TABLE IF NOT EXISTS user_client_refs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ref TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (user_id, campaign_id),
  UNIQUE (campaign_id, ref)
);

CREATE TABLE IF NOT EXISTS statement_allocations (
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  logged INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  week_confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (statement_id, user_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_statement_allocations_user ON statement_allocations(user_id, week_start);
`;

/**
 * P3's columns on its own statements table: in the CREATE TABLE above for a new database, and added here (nullable) to
 * a database created at the foundation commit, whose statements table predates them.
 */
const STATEMENT_COLUMNS: [string, string][] = [
  ['table_json', 'TEXT'],
  ['mapping_json', 'TEXT'],
  ['mapping_source', 'TEXT'],
  ['layout', 'TEXT'],
  ['effect_json', 'TEXT'],
  ['sender', 'TEXT'],
  ['subject', 'TEXT'],
  ['superseded_by', 'INTEGER'],
  ['sender_verified', 'INTEGER'],
];

export const extension: DbExtension = {
  name: 'statements',
  sql: SQL,
  upgrade: (db) => {
    const changed: string[] = [];
    for (const [column, ddl] of STATEMENT_COLUMNS) {
      const added = addColumnIfMissing(db, 'statements', column, ddl);
      if (added) changed.push(added);
    }
    return changed;
  },
  seed: (db, ctx) => seedDemoStatements(db, ctx),
};
