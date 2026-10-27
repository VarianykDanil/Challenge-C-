/**
 * Going live: the trial database becomes the office's own (`npm run golive`, src/golive.ts, runs this after its checks
 * and backup).
 *
 * Removed: the demo company's people (lib/trialMode.ts demoPeopleIds: the seed's staff and demo client accounts, and
 * the example starter team), with their history (gauges, pay, invoices, sessions…), and the records the demo seed made
 * (rows at or below the seed marks) unless something of the office's own hangs on them: an event someone of the
 * office logged on, its campaign and team, a team with one of the office's people in it.
 * Kept: settings (pay plans, payment connections, security settings…), every other person, and every record made in
 * the app after the seed. An announcement a demo account wrote after the seed passes to the owner.
 * Then trial mode is off for good: no one-tap sign-ins, no demo start-up steps, and nobody signs in without their own
 * setup code and two-step verification. When no administrator of the office's own is left, the first real owner is
 * made (LM-0001 when free) with a one-time setup code.
 */
import { AVATAR_PALETTE } from '../db/seed-data.ts';
import { all, get, run, transaction, type Db } from '../db/connection.ts';
import { setMetaFlag } from '../db/extensions/types.ts';
import { DEMO_CLIENT_STEP_KEY } from '../db/extensions/client.ts';
import { recordAudit } from './audit.ts';
import { DEMO_CLIENTS_META_KEY } from './client.ts';
import { DEMO_TEAMS_DONE_KEY, DEMO_TEAMS_META_KEY } from './demoTeams.ts';
import { issueSetupCode } from './setupCodes.ts';
import { removeStatementFileIfUnused } from './statements/files.ts';
import { isTwoFactorEnabled } from './twofactor.ts';
import { DEMO_PEOPLE_KEY, SEED_MARK_TABLES, demoPeopleIds, isTrialMode, readSeedMarks, setTrialMode, type SeedMarkTable } from './trialMode.ts';

export interface GoLivePerson {
  id: number;
  name: string;
  email: string;
  employeeId: string;
  role: string;
  status: string;
}

export interface GoLivePlan {
  /** False: already live, nothing to do. */
  trialMode: boolean;
  removePeople: GoLivePerson[];
  /** Everyone else, the office's own (left people included). */
  keepPeople: GoLivePerson[];
  /** Demo records that go, per table. */
  removeRecords: Partial<Record<SeedMarkTable, number>>;
  /** No active administrator of the office's own would be left, so golive makes the first owner. */
  ownerNeeded: boolean;
}

export interface GoLiveOwnerInput {
  firstName: string;
  lastName: string;
  email: string;
}

export interface GoLiveResult {
  removedPeople: number;
  removedRecords: Partial<Record<SeedMarkTable, number>>;
  owner: { id: number; name: string; email: string; employeeId: string; setupCode: string; expiresAt: string } | null;
  /** Active people of the office who have not finished setting up (they need a setup code from an administrator). */
  notSetUp: { name: string; email: string }[];
}

const PERSON_SELECT = `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email, employee_id AS employeeId, role, status FROM users`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The seed rows of each table that go, as SQL conditions on that table (with `?1` = the demo people as JSON and
 * `?2` = the table's seed mark). Order matters: events before campaigns and teams (they reference both).
 */
const REMOVE_WHERE: Record<SeedMarkTable, string> = {
  events: `id <= ?2
    AND NOT EXISTS (SELECT 1 FROM gauge_entries g WHERE g.event_id = events.id AND g.user_id NOT IN (SELECT value FROM json_each(?1)))
    AND NOT EXISTS (SELECT 1 FROM check_ins c WHERE c.event_id = events.id AND c.user_id NOT IN (SELECT value FROM json_each(?1)))
    AND NOT EXISTS (SELECT 1 FROM event_roster r WHERE r.event_id = events.id AND r.user_id NOT IN (SELECT value FROM json_each(?1)))`,
  expenses: `id <= ?2`,
  candidates: `id <= ?2 AND (hired_user_id IS NULL OR hired_user_id IN (SELECT value FROM json_each(?1)))`,
  announcements: `id <= ?2`,
  statements: `id <= ?2`,
  learning_videos: `id <= ?2`,
  campaigns: `id <= ?2
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.campaign_id = campaigns.id AND e.id NOT IN (SELECT id FROM golive_events))
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.client_campaign_id = campaigns.id AND u.id NOT IN (SELECT value FROM json_each(?1)))`,
  teams: `id <= ?2
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.team_id = teams.id AND e.id NOT IN (SELECT id FROM golive_events))
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.team_id = teams.id AND u.id NOT IN (SELECT value FROM json_each(?1)))
    AND (leader_id IS NULL OR leader_id IN (SELECT value FROM json_each(?1)))`,
};
const ORDER: SeedMarkTable[] = ['events', 'expenses', 'candidates', 'announcements', 'statements', 'learning_videos', 'campaigns', 'teams'];

function tableExists(db: Db, table: string): boolean {
  return Boolean(get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]));
}

/** The events that would go, in a temp table the campaign and team rules read (they keep what kept events need). */
function stageEvents(db: Db, demo: string, mark: number): void {
  run(db, `DROP TABLE IF EXISTS temp.golive_events`);
  run(db, `CREATE TEMP TABLE golive_events (id INTEGER PRIMARY KEY)`);
  run(db, `INSERT INTO golive_events (id) SELECT id FROM events WHERE ${REMOVE_WHERE.events}`, [demo, mark]);
}

/** What going live would do, without changing anything (the temp table aside). */
export function planGoLive(db: Db): GoLivePlan {
  if (!isTrialMode(db)) return { trialMode: false, removePeople: [], keepPeople: [], removeRecords: {}, ownerNeeded: false };
  const ids = demoPeopleIds(db);
  const demo = JSON.stringify(ids);
  const people = all<GoLivePerson>(db, `${PERSON_SELECT} ORDER BY id`);
  const isDemo = new Set(ids);
  const removePeople = people.filter((p) => isDemo.has(p.id));
  const keepPeople = people.filter((p) => !isDemo.has(p.id));
  const marks = readSeedMarks(db);
  stageEvents(db, demo, marks.events ?? 0);
  const removeRecords: Partial<Record<SeedMarkTable, number>> = {};
  for (const t of SEED_MARK_TABLES) {
    if (!tableExists(db, t)) continue;
    const n = Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${REMOVE_WHERE[t]}`, [demo, marks[t] ?? 0])?.n ?? 0);
    if (n) removeRecords[t] = n;
  }
  run(db, `DROP TABLE IF EXISTS temp.golive_events`);
  const ownerNeeded = !keepPeople.some((p) => p.role === 'admin' && p.status !== 'left');
  return { trialMode: true, removePeople, keepPeople, removeRecords, ownerNeeded };
}

/** A sentence saying what is wrong with the owner's details, or null when they will do. */
export function ownerProblem(db: Db, owner: GoLiveOwnerInput | undefined, plan: GoLivePlan = planGoLive(db)): string | null {
  if (!owner) {
    return 'No administrator of your own would be left, so going live makes the first owner: give their first name, last name and sign-in email.';
  }
  if (!owner.firstName.trim()) return 'The owner needs a first name.';
  if (owner.firstName.trim().length > 60 || owner.lastName.trim().length > 60) return 'Names can be at most 60 characters.';
  const email = owner.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return `"${owner.email}" is not an email address.`;
  const taken = plan.keepPeople.find((p) => p.email.toLowerCase() === email);
  if (taken) return `${owner.email} is already used by ${taken.name}: use another email, or make ${taken.name} an administrator after going live.`;
  return null;
}

/** LM-0001 when nobody has it (the demo people are gone by then), else the next free LM number. */
function ownerEmployeeId(db: Db): string {
  const used = new Set(all<{ e: string }>(db, `SELECT upper(employee_id) AS e FROM users`).map((r) => r.e));
  for (let n = 1; n < 10_000; n++) {
    const id = `LM-${String(n).padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new Error('No free employee ID is left between LM-0001 and LM-9999.');
}

/**
 * Goes live (in one transaction). Throws a sentence when the database is already live, or when an owner is needed and
 * `owner` is missing or unusable; nothing is changed then.
 */
export function goLive(db: Db, opts: { owner?: GoLiveOwnerInput; now?: Date }): GoLiveResult {
  const plan = planGoLive(db);
  if (!plan.trialMode) throw new Error('Linear Hub is already live: there is no demo company to remove.');
  if (plan.ownerNeeded) {
    const problem = ownerProblem(db, opts.owner, plan);
    if (problem) throw new Error(problem);
  }
  const now = opts.now ?? new Date();
  const ids = demoPeopleIds(db);
  const demo = JSON.stringify(ids);
  const marks = readSeedMarks(db);
  const statementFiles = tableExists(db, 'statements')
    ? all<{ f: string | null }>(db, `SELECT file_path AS f FROM statements WHERE ${REMOVE_WHERE.statements}`, [demo, marks.statements ?? 0]).map((r) => r.f)
    : [];

  const result = transaction(db, (): GoLiveResult => {
    // the first real owner, before anything that needs one; their email and employee ID may be a demo person's (the
    // demo owner's LM-0001, say), so placeholders until the demo people are gone
    let ownerId: number | null = null;
    if (plan.ownerNeeded && opts.owner) {
      const o = opts.owner;
      const plan0 = get<{ id: number }>(db, `SELECT id FROM pay_plans ORDER BY id LIMIT 1`);
      if (!plan0) throw new Error('This database has no pay plan, so no owner can be made. Restore a backup or start again.');
      ownerId = run(
        db,
        `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
         VALUES ('LM-GOLIVE', 'golive-owner@placeholder.invalid', ?, ?, 'admin', 'owner', NULL, ?, ?, 'active', NULL, ?, NULL)`,
        [o.firstName.trim(), o.lastName.trim(), plan0.id, now.toISOString().slice(0, 10), AVATAR_PALETTE[0] ?? '#4F46E5'],
      ).lastInsertRowid;
    }
    const heir = ownerId ?? get<{ id: number }>(
      db,
      `SELECT id FROM users WHERE role = 'admin' AND status <> 'left' AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1`,
      [demo],
    )?.id;

    // the demo records, then the people
    stageEvents(db, demo, marks.events ?? 0);
    const removedRecords: Partial<Record<SeedMarkTable, number>> = {};
    for (const t of ORDER) {
      if (!tableExists(db, t)) continue;
      const n = run(db, `DELETE FROM ${t} WHERE ${REMOVE_WHERE[t]}`, [demo, marks[t] ?? 0]).changes;
      if (n) removedRecords[t] = n;
    }
    run(db, `DROP TABLE IF EXISTS temp.golive_events`);
    if (heir) run(db, `UPDATE announcements SET author_id = ? WHERE author_id IN (SELECT value FROM json_each(?))`, [heir, demo]);
    run(db, `DELETE FROM announcements WHERE author_id IN (SELECT value FROM json_each(?))`, [demo]);
    run(db, `UPDATE teams SET leader_id = NULL WHERE leader_id IN (SELECT value FROM json_each(?))`, [demo]);
    // payment batches of demo people only (test-mode pay in the trial), and rows that name them without a foreign key
    if (tableExists(db, 'payment_items')) {
      run(
        db,
        `DELETE FROM payment_batches WHERE id IN (SELECT batch_id FROM payment_items WHERE user_id IN (SELECT value FROM json_each(?1)))
           AND NOT EXISTS (SELECT 1 FROM payment_items i WHERE i.batch_id = payment_batches.id AND i.user_id NOT IN (SELECT value FROM json_each(?1)))`,
        [demo],
      );
      run(db, `DELETE FROM payment_items WHERE user_id IN (SELECT value FROM json_each(?))`, [demo]);
    }
    if (tableExists(db, 'invoice_voids')) run(db, `DELETE FROM invoice_voids WHERE user_id IN (SELECT value FROM json_each(?))`, [demo]);
    const removedPeople = run(db, `DELETE FROM users WHERE id IN (SELECT value FROM json_each(?))`, [demo]).changes;
    if (tableExists(db, 'invoice_refreshes')) run(db, `DELETE FROM invoice_refreshes WHERE invoice_id NOT IN (SELECT id FROM invoices)`);

    let owner: GoLiveResult['owner'] = null;
    if (ownerId && opts.owner) {
      const email = opts.owner.email.trim().toLowerCase();
      const employeeId = ownerEmployeeId(db);
      run(db, `UPDATE users SET employee_id = ?, email = ? WHERE id = ?`, [employeeId, email, ownerId]);
      const issued = issueSetupCode(db, ownerId, { createdBy: null, reason: 'golive', now });
      const name = `${opts.owner.firstName.trim()} ${opts.owner.lastName.trim()}`.trim();
      owner = { id: ownerId, name, email, employeeId, setupCode: issued.code, expiresAt: issued.expiresAt };
    }

    // trial mode off for good: no one-tap sign-ins and no demo start-up steps ever again (seeded_at stays, so the
    // server never seeds it again)
    setTrialMode(db, false);
    run(db, `DELETE FROM meta WHERE key IN (?, ?, ?, 'seed_today')`, [DEMO_PEOPLE_KEY, DEMO_TEAMS_META_KEY, DEMO_CLIENTS_META_KEY]);
    setMetaFlag(db, DEMO_TEAMS_DONE_KEY);
    setMetaFlag(db, DEMO_CLIENT_STEP_KEY);

    const records = Object.values(removedRecords).reduce((a, b) => a + (b ?? 0), 0);
    recordAudit(db, {
      userId: null,
      action: 'npm run golive',
      entity: 'settings',
      entityId: null,
      summary: `Went live from the server command: removed the demo company (${removedPeople} people, ${records} records)` +
        (owner ? `; made ${owner.name} the owner` : ''),
      before: { trialMode: true },
      after: { trialMode: false },
    });

    const notSetUp = all<{ id: number; name: string; email: string }>(
      db, `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email FROM users WHERE status <> 'left' ORDER BY id`,
    )
      .filter((p) => p.id !== owner?.id && !isTwoFactorEnabled(db, p.id))
      .map(({ name, email }) => ({ name, email }));
    return { removedPeople, removedRecords, owner, notSetUp };
  });
  // the demo statement PDFs nobody points at any more (outside the transaction: files are not rolled back)
  for (const f of statementFiles) removeStatementFileIfUnused(db, f);
  return result;
}
