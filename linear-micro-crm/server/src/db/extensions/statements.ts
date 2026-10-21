/**
 * Release 1.3 — OWNED BY P3 statements (laid down by r3-foundation: tables are the contract; P3 adds data steps, seed
 * rows — demo BCN / CHN statement PDFs — and further columns with addColumnIfMissing).
 *
 *  - campaign_statement_senders: the address(es) each campaign's statements come from (the mail job searches only these).
 *  - statement_templates: a per-campaign column mapping the admin sets from a preview when auto-detection is unsure.
 *  - statements: one per PDF (source 'email' | 'upload'; message_id UNIQUE for mail so a message is fetched once), the
 *    stored file under server/data/statements/ (git-ignored), the period, status 'parsed' | 'needs_review' | 'applied' |
 *    'failed', the error in plain words, and who applied it when.
 *  - statement_rows: the parsed table rows (raw cells as JSON), the fundraiser ref / name, a sale date or period, the
 *    confirmed (and cancelled) count, the amount, and the matched person (match 'auto' | 'manual' | 'none').
 *  - user_client_refs: each person's fundraiser ID at a client (Team → person → "Client IDs"); one per (person,
 *    campaign), and a ref belongs to one person per campaign.
 *  - meta `ext:statements:mail`: the Gmail address, the app password ENCRYPTED with the app-secret key (lib/crypto.ts),
 *    last check, last error and the last seen UID. Never returned by an API, never in the audit trail.
 * Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

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
  applied_by INTEGER
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
`;

export const extension: DbExtension = {
  name: 'statements',
  sql: SQL,
  upgrade: () => [],
};
