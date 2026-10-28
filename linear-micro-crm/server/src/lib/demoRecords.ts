/**
 * Telling the demo seed's records from the office's own: what `npm run golive` (lib/goLive.ts) and the upgrade of an
 * older demo database (db/extensions/access.ts) read.
 *
 * The seed writes no audit rows, so the audit trail is the evidence of use:
 *  - made in the app: an audit row of one of the requests that create a row of that table (CREATE_ACTIONS) names it;
 *  - changed in the app: any change row (kind 'change' or 'client') by a signed-in person names it.
 * The one path that makes a company record without an audit row is the statement mail check, so a statement is also
 * told by when it arrived: the seed never dates one after `seeded_at`.
 */
import { all, get, type Db } from '../db/connection.ts';
import { SEED_MARK_TABLES, type SeedMarkTable, type SeedMarks } from './trialMode.ts';

/** The audit trail's entity for each company table (null: no request writes it; teams only come from the seed). */
export const AUDIT_ENTITY: Record<SeedMarkTable, string | null> = {
  teams: null,
  campaigns: 'campaign',
  events: 'event',
  expenses: 'expense',
  candidates: 'candidate',
  announcements: 'announcement',
  statements: 'statement',
  learning_videos: 'video',
};

/** The requests that create a row of each table, as the audit trail writes them ("METHOD /pattern"). */
export const CREATE_ACTIONS: Record<SeedMarkTable, readonly string[]> = {
  teams: [],
  campaigns: ['POST /campaigns'],
  events: ['POST /events'],
  expenses: ['POST /finance/expenses'],
  candidates: ['POST /recruitment/candidates'],
  announcements: ['POST /announcements'],
  statements: ['POST /statements/upload'],
  learning_videos: ['POST /videos', 'POST /videos/upload'],
};

export function tableExists(db: Db, table: string): boolean {
  return Boolean(get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]));
}

const hasAudit = (db: Db) => tableExists(db, 'audit_log');

/** Ids of `table` rows the audit trail shows were created through the app. */
export function madeInAppIds(db: Db, table: SeedMarkTable): Set<number> {
  const entity = AUDIT_ENTITY[table];
  const actions = CREATE_ACTIONS[table];
  if (!entity || !actions.length || !hasAudit(db)) return new Set();
  const rows = all<{ id: number }>(
    db,
    `SELECT DISTINCT entity_id AS id FROM audit_log
     WHERE entity = ? AND entity_id IS NOT NULL AND action IN (SELECT value FROM json_each(?))`,
    [entity, JSON.stringify(actions)],
  );
  return new Set(rows.map((r) => r.id));
}

/** Who changed which `table` rows through the app: row id → person id → number of changes. */
export function changesInApp(db: Db, table: SeedMarkTable): Map<number, Map<number, number>> {
  const entity = AUDIT_ENTITY[table];
  const out = new Map<number, Map<number, number>>();
  if (!entity || !hasAudit(db)) return out;
  const rows = all<{ id: number; userId: number; n: number }>(
    db,
    `SELECT entity_id AS id, user_id AS userId, COUNT(*) AS n FROM audit_log
     WHERE entity = ? AND entity_id IS NOT NULL AND user_id IS NOT NULL AND COALESCE(kind, 'change') IN ('change', 'client')
     GROUP BY entity_id, user_id`,
    [entity],
  );
  for (const r of rows) {
    const byUser = out.get(r.id) ?? new Map<number, number>();
    byUser.set(r.userId, Number(r.n));
    out.set(r.id, byUser);
  }
  return out;
}

/**
 * Seed marks for a demo database from before trial mode (the upgrade, once): the highest id of each table that the
 * seed could have made. That is the highest id now, but never as high as the first row the app made since (an audit
 * create, or a statement that arrived after the seed). Rows made in the app before the upgrade stay above the mark,
 * so `npm run golive` keeps them.
 */
export function seedMarksFromEvidence(db: Db): SeedMarks {
  const seededAt = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'seeded_at'`)?.value ?? '';
  const marks: SeedMarks = {};
  for (const t of SEED_MARK_TABLES) {
    if (!tableExists(db, t)) {
      marks[t] = 0;
      continue;
    }
    let mark = Number(get<{ n: number | null }>(db, `SELECT MAX(id) AS n FROM ${t}`)?.n ?? 0);
    const made = [...madeInAppIds(db, t)];
    if (made.length) mark = Math.min(mark, Math.min(...made) - 1);
    if (t === 'statements' && seededAt) {
      const first = get<{ n: number | null }>(db, `SELECT MIN(id) AS n FROM statements WHERE received_at > ?`, [seededAt])?.n;
      if (first) mark = Math.min(mark, first - 1);
    }
    marks[t] = Math.max(0, mark);
  }
  return marks;
}
