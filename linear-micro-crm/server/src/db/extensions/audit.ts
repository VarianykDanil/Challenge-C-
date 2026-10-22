/**
 * Release 1.2 — OWNED BY U3 audit-trail. Rules: ./types.ts.
 *
 *  - audit_log: one row per successful write through the API (lib/audit.ts records it): when (`at`, real clock, UTC
 *    ISO), who (`user_id`, no foreign key so a row outlives anything), the method and route pattern (`action`), the
 *    entity and its id when the route is registered, a readable `summary`, redacted before/after snapshots as JSON and
 *    the caller's IP. Indexed for the /audit filters (date, person) and the entity history. Kept two years
 *    (`purgeAuditLog`). No seed rows: the log starts when the release goes live.
 *  - announcement_reads: who has read which announcement, once per person (idempotent on the primary key).
 *    The demo seed marks a plausible share of the active people as having read each seeded announcement, so the
 *    dashboard's "Read by 18 of 34" has something to show; an existing database starts empty.
 *
 * Release 1.3 — OWNED BY P9 audit-everything from here on:
 *  - audit_log.kind: what kind of action the row records — 'change' | 'sign_in' | 'export' | 'opened' | 'automatic' |
 *    'client' (shared AuditEventKind) — written with every row by lib/audit.ts recordAudit, indexed with `at` for the
 *    Audit page's kind filter. `upgrade` adds the column to a 1.2 database and classifies its rows once, by the same
 *    rules as shared auditKindOf (KIND_CASE below; a test holds the two equal): the payroll export → export, sign-ins
 *    and sign-outs → sign_in, a client account's rows → client, everything else → change. It runs on every start
 *    but only touches rows whose kind is still NULL (none, once classified), so a second start changes nothing.
 *
 * Nothing here touches a core table: `upgrade` writes audit_log only, `seed` writes announcement_reads only.
 */
import type { DbExtension, SeedContext } from './types.ts';
import { addColumnIfMissing } from './types.ts';
import type { Db } from '../connection.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_user_at ON audit_log(user_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, at);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id);
`;

const HOUR = 3_600_000;
/** This extension's own random stream (SeedContext.rng): the core demo data never changes because of it. */
const SEED_SALT = 0x0a0d17;

/**
 * Demo read receipts: for each seeded announcement, every active person other than the author has read it with a
 * chance that grows with its age (35% when just posted, 90% after a week), at a time between the post and now.
 */
function seedReads(db: Db, ctx: SeedContext): void {
  const announcements = db.prepare(`SELECT id, author_id AS authorId, created_at AS createdAt FROM announcements ORDER BY id`).all() as {
    id: number;
    authorId: number;
    createdAt: string;
  }[];
  if (!announcements.length) return;
  const readers = ctx.users.filter((u) => u.status === 'active');
  const rng = ctx.rng(SEED_SALT);
  const nowMs = Date.parse(ctx.nowIso);
  const insert = db.prepare(`INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)`);
  for (const a of announcements) {
    const postedMs = Date.parse(a.createdAt);
    if (!Number.isFinite(postedMs) || postedMs > nowMs) continue;
    const ageHours = (nowMs - postedMs) / HOUR;
    const share = Math.min(0.9, 0.35 + (ageHours / 168) * 0.55);
    for (const u of readers) {
      if (u.id === a.authorId || !rng.chance(share)) continue;
      const after = Math.min(ageHours, rng.float(0.1, 48));
      insert.run(a.id, u.id, new Date(postedMs + after * HOUR).toISOString());
    }
  }
}

/**
 * shared auditKindOf in SQL, for rows written before audit_log.kind existed (same order of rules; the test
 * audit-everything.test.ts checks both give the same kind for every action the app writes).
 */
export const KIND_CASE = `CASE
  WHEN action LIKE 'SYSTEM %' THEN 'automatic'
  WHEN action LIKE 'EVENT export%' OR action = 'GET /finance/payroll/export' THEN 'export'
  WHEN action LIKE 'EVENT opened%' THEN 'opened'
  WHEN action IN ('POST /auth/login', 'POST /auth/login/2fa', 'POST /auth/logout') THEN 'sign_in'
  WHEN user_id IN (SELECT id FROM users WHERE role = 'client') OR action LIKE '% /client' OR action LIKE '% /client/%' THEN 'client'
  ELSE 'change'
END`;

/** Adds audit_log.kind (+ its index) and classifies the rows that have none yet; reports only real changes. */
function upgrade(db: Db): string[] {
  const changed: string[] = [];
  const added = addColumnIfMissing(db, 'audit_log', 'kind', 'TEXT');
  if (added) changed.push(added);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_kind_at ON audit_log(kind, at)`);
  const classified = Number(db.prepare(`UPDATE audit_log SET kind = ${KIND_CASE} WHERE kind IS NULL`).run().changes);
  if (classified > 0) changed.push('audit_log.kind (rows classified)');
  return changed;
}

export const extension: DbExtension = {
  name: 'audit',
  sql: SQL,
  upgrade,
  seed: seedReads,
};
