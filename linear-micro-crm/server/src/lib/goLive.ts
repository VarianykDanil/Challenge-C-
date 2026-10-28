/**
 * Going live: the trial database becomes the office's own (`npm run golive`, src/golive.ts, runs this after its checks
 * and backup).
 *
 * Removed: the demo company's people (lib/trialMode.ts demoPeopleIds: the seed's staff and demo client accounts, and
 * the example starter team), with their history (gauges, pay, invoices, sessions…), and the records the demo seed made
 * (rows at or below the seed marks) unless the office made or changed them in the app, they name one of the office's
 * people, or something that stays uses them (demoRecordsToRemove says exactly how).
 * Kept: settings (pay plans, payment connections, security settings…), every other person, every record made in the
 * app after the seed, and the demo records those use. An announcement a demo account wrote passes to the owner.
 * Statement PDFs stay on disk: the database backup golive makes does not hold them, so removing them could not be
 * undone (a demo PDF nothing points at is harmless).
 * Then trial mode is off for good: no one-tap sign-ins, no demo start-up steps, and nobody signs in without their own
 * setup code and two-step verification. Everyone is signed out (sessions and half-finished two-step sign-ins), so no
 * session made under the trial's rules lives on. When no administrator of the office's own is left, the first real owner is
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
import { isTwoFactorEnabled } from './twofactor.ts';
import { changesInApp, madeInAppIds, tableExists } from './demoRecords.ts';
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
  /** Demo people who were used since the seed (signed in, changed something): they go too, so the plan names them. */
  usedDemoPeople: GoLiveUsedPerson[];
  /** Records the demo seed made that stay, and why. */
  keptDemoRecords: GoLiveRecordNote[];
  /** Demo records changed in the trial, but only by demo accounts: they go. */
  removedUsedRecords: GoLiveRecordNote[];
}

export interface GoLiveUsedPerson extends GoLivePerson {
  changes: number;
  signIns: number;
  /** When they last did something (ISO). */
  lastAt: string;
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
  /** Sessions ended: going live signs everyone out (a trial session must not outlive the trial's rules). */
  signedOut: number;
}

const PERSON_SELECT = `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email, employee_id AS employeeId, role, status FROM users`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ───────────────────────────── which demo records go ─────────────────────────────

/** Deleted in this order: a row before the rows it points at (events before their campaign and team). */
const ORDER: SeedMarkTable[] = ['expenses', 'events', 'candidates', 'announcements', 'statements', 'learning_videos', 'campaigns', 'teams'];

/** How each table names a record in the plan. */
const LABEL: Record<SeedMarkTable, string> = {
  teams: `name`,
  campaigns: `name || COALESCE(' (' || code || ')', '')`,
  events: `COALESCE(NULLIF(name, ''), 'event') || COALESCE(', ' || NULLIF(venue, ''), '') || ', ' || date`,
  expenses: `COALESCE(NULLIF(description, ''), category) || ' (' || date || ')'`,
  candidates: `TRIM(first_name || ' ' || last_name)`,
  announcements: `COALESCE(title, 'announcement ' || id)`,
  statements: `COALESCE(file_name, 'statement ' || id)`,
  learning_videos: `title`,
};
const SINGULAR: Record<SeedMarkTable, string> = {
  teams: 'team', campaigns: 'campaign', events: 'event', expenses: 'expense', candidates: 'candidate',
  announcements: 'announcement', statements: 'statement', learning_videos: 'learning video',
};

/** "candidate", "learning video": how the plan names one record of a table. */
export const recordName = (table: SeedMarkTable): string => SINGULAR[table];

/** "1 campaign", "599 events". */
export function recordCountText(table: SeedMarkTable, n: number): string {
  const one = SINGULAR[table];
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** Columns that hold a person's id without a foreign key (the ones with one are read from the schema). */
const LOOSE_USER_COLUMNS: Record<string, readonly string[]> = {
  teams: ['leader_id'],
  learning_videos: ['created_by'],
  statements: ['applied_by'],
  campaign_rates: ['approved_by'],
  statement_templates: ['updated_by'],
  pay_adjustments: ['created_by'],
  event_roster: ['booked_by'],
  interview_answers: ['updated_by'],
  interview_changes: ['changed_by'],
};

/** References without a foreign key that still tie a row to a company record. */
const LOOSE_REFERENCES: readonly { table: string; column: string; parent: SeedMarkTable }[] = [
  { table: 'users', column: 'client_campaign_id', parent: 'campaigns' },
  { table: 'pay_adjustments', column: 'campaign_id', parent: 'campaigns' },
  { table: 'pay_adjustments', column: 'statement_id', parent: 'statements' },
  { table: 'sale_confirmations', column: 'statement_id', parent: 'statements' },
];

/** Rows that only say someone saw a record: they never keep it. */
const SEEN_ONLY = new Set(['announcement_reads', 'client_post_reads', 'video_views', 'audit_log']);

/** How the plan says a person is tied to a record ("client ID of Casey Lee"). Fallback: "<table> of". */
const TIE: Record<string, string> = {
  'teams.leader_id': 'led by',
  'candidates.owner_id': 'looked after by',
  'candidates.referred_by_id': 'referred by',
  'candidates.hired_user_id': 'hired as',
  'announcements.author_id': 'written by',
  'statements.applied_by': 'applied by',
  'learning_videos.created_by': 'added by',
  user_client_refs: 'client ID of',
  sale_confirmations: 'confirmed sales of',
  statement_allocations: 'statement sales of',
  statement_rows: 'statement line of',
  campaign_rates: 'pay rate set by',
  campaign_pitches: 'pitch edited by',
  statement_templates: 'statement layout set by',
  client_posts: 'client post by',
  gauge_entries: 'gauges of',
  check_ins: 'check-in of',
  event_roster: 'booking of',
  interviews: 'interview with',
  stage_changes: 'stage change by',
  pay_adjustments: 'pay adjustment of',
};

interface UserColumn {
  column: string;
  /** Deleting the person deletes the row (ON DELETE CASCADE). */
  cascade: boolean;
}

interface Reference {
  table: string;
  column: string;
  parent: SeedMarkTable;
}

interface Schema {
  userColumns: Map<string, UserColumn[]>;
  references: Reference[];
}

function readSchema(db: Db): Schema {
  const tables = all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((r) => r.name);
  const staged = new Set<string>(SEED_MARK_TABLES);
  const userColumns = new Map<string, UserColumn[]>();
  const references: Reference[] = [];
  for (const table of tables) {
    const columns = new Set(all<{ name: string }>(db, `PRAGMA table_info("${table}")`).map((c) => c.name));
    const cols: UserColumn[] = [];
    for (const fk of all<{ table: string; from: string; on_delete: string }>(db, `PRAGMA foreign_key_list("${table}")`)) {
      if (fk.table === 'users') cols.push({ column: fk.from, cascade: fk.on_delete.toUpperCase() === 'CASCADE' });
      else if (staged.has(fk.table) && fk.table !== table && !SEEN_ONLY.has(table)) references.push({ table, column: fk.from, parent: fk.table as SeedMarkTable });
    }
    for (const c of LOOSE_USER_COLUMNS[table] ?? []) if (columns.has(c) && !cols.some((u) => u.column === c)) cols.push({ column: c, cascade: false });
    if (cols.length) userColumns.set(table, cols);
    for (const r of LOOSE_REFERENCES) if (r.table === table && columns.has(r.column)) references.push(r);
  }
  return { userColumns, references };
}

export interface GoLiveRecordNote {
  table: SeedMarkTable;
  id: number;
  label: string;
  /** Kept records: why ("client ID of Casey Lee", "changed by Robin Ash"). Removed records: who changed them. */
  reason: string;
}

interface Removal {
  /** The demo records that go, per table. */
  remove: Map<SeedMarkTable, Set<number>>;
  /** Records the demo seed made that stay, and why. */
  kept: GoLiveRecordNote[];
  /** Demo records changed in the trial, but only by demo accounts: they go. */
  removedUsed: GoLiveRecordNote[];
}

/**
 * The demo records that go. A row the demo seed made (at or below its table's seed mark) goes unless:
 *  - the audit trail shows it was made in the app (a create request names it), or a person of the office's own changed
 *    it in the app;
 *  - it names a person of the office's own (a team they lead, a candidate hired as them, a statement they applied);
 *  - something that stays points at it: a record of the office's own (any table with a foreign key to it, found in the
 *    schema), a person of the office's own (in a team, a client account of a campaign), or a demo record that stays
 *    for one of these reasons. A row of another table counts as the office's own when it names one of the office's
 *    people and no demo person whose removal would delete it. Rows that only say someone saw a record (reads, video
 *    views) never keep it.
 * Rows above the mark were made after the seed and always stay.
 */
function demoRecordsToRemove(db: Db, ids: readonly number[]): Removal {
  const demo = new Set(ids);
  const names = new Map(all<{ id: number; name: string }>(db, `SELECT id, TRIM(first_name || ' ' || last_name) AS name FROM users`).map((u) => [u.id, u.name || 'someone']));
  const ownPerson = (id: unknown): id is number => typeof id === 'number' && names.has(id) && !demo.has(id);
  const marks = readSeedMarks(db);
  const schema = readSchema(db);
  const remove = new Map<SeedMarkTable, Set<number>>();
  const reasons = new Map<string, { table: SeedMarkTable; id: number; reasons: string[] }>();
  const keep = (table: SeedMarkTable, id: number, reason: string) => {
    const key = `${table}:${id}`;
    const note = reasons.get(key) ?? { table, id, reasons: [] };
    if (!note.reasons.includes(reason) && note.reasons.length < 3) note.reasons.push(reason);
    reasons.set(key, note);
    remove.get(table)?.delete(id);
  };
  const tie = (table: string, column: string) => TIE[`${table}.${column}`] ?? TIE[table] ?? `${table.replace(/_/g, ' ')} of`;
  const demoChanges = new Map<string, number>();

  // 1. each table's seed rows, less those the office made, changed or is named in
  for (const t of SEED_MARK_TABLES) {
    if (!tableExists(db, t)) continue;
    const userCols = schema.userColumns.get(t) ?? [];
    const select = ['id', ...userCols.map((c) => `"${c.column}" AS "${c.column}"`)].join(', ');
    const rows = all<Record<string, unknown> & { id: number }>(db, `SELECT ${select} FROM ${t} WHERE id <= ?`, [marks[t] ?? 0]);
    const made = madeInAppIds(db, t);
    const changes = changesInApp(db, t);
    const set = new Set<number>();
    remove.set(t, set);
    for (const row of rows) {
      set.add(row.id);
      if (made.has(row.id)) keep(t, row.id, 'made in the app after the demo was set up');
      const byWhom = changes.get(row.id);
      if (byWhom) {
        const office = [...byWhom.keys()].filter((u) => !demo.has(u));
        if (office.length) keep(t, row.id, `changed by ${office.map((u) => names.get(u) ?? 'someone no longer here').join(', ')}`);
        const byDemo = [...byWhom].filter(([u]) => demo.has(u)).reduce((a, [, n]) => a + n, 0);
        if (byDemo) demoChanges.set(`${t}:${row.id}`, byDemo);
      }
      for (const c of userCols) if (ownPerson(row[c.column])) keep(t, row.id, `${tie(t, c.column)} ${names.get(row[c.column] as number)}`);
    }
  }

  // 2. what still points at a demo record keeps it, until nothing more changes (a kept event keeps its campaign…)
  const labelOf = (table: SeedMarkTable, id: number) =>
    get<{ label: string | null }>(db, `SELECT ${LABEL[table]} AS label FROM ${table} WHERE id = ?`, [id])?.label ?? `#${id}`;
  for (let changed = true; changed; ) {
    changed = false;
    for (const ref of schema.references) {
      const targets = remove.get(ref.parent);
      if (!targets?.size || !tableExists(db, ref.table)) continue;
      const staged = (SEED_MARK_TABLES as readonly string[]).includes(ref.table) ? (ref.table as SeedMarkTable) : null;
      const userCols = schema.userColumns.get(ref.table) ?? [];
      if (!staged && ref.table !== 'users' && !userCols.length) continue; // nothing says whose it is: it goes with its parent
      const select = [
        `"${ref.column}" AS parent`,
        ...(staged || ref.table === 'users' ? ['id'] : []),
        ...userCols.map((c) => `"${c.column}" AS "${c.column}"`),
      ].join(', ');
      const rows = all<Record<string, unknown> & { parent: number; id?: number }>(
        db,
        `SELECT ${select} FROM "${ref.table}" WHERE "${ref.column}" IN (SELECT value FROM json_each(?))`,
        [JSON.stringify([...targets])],
      );
      for (const row of rows) {
        if (!targets.has(row.parent)) continue;
        let reason: string | null = null;
        if (staged) {
          if (!remove.get(staged)?.has(row.id!)) reason = `${SINGULAR[staged]} “${labelOf(staged, row.id!)}”`;
        } else if (ref.table === 'users') {
          if (ownPerson(row.id)) reason = ref.column === 'team_id' ? `${names.get(row.id)} is in it` : `client account of ${names.get(row.id)}`;
        } else {
          const goesWithDemo = userCols.some((c) => c.cascade && typeof row[c.column] === 'number' && demo.has(row[c.column] as number));
          const own = goesWithDemo ? undefined : userCols.find((c) => ownPerson(row[c.column]));
          if (own) reason = `${tie(ref.table, own.column)} ${names.get(row[own.column] as number)}`;
        }
        if (reason) {
          keep(ref.parent, row.parent, reason);
          changed = true;
        }
      }
    }
  }

  const kept = [...reasons.values()]
    .sort((a, b) => SEED_MARK_TABLES.indexOf(a.table) - SEED_MARK_TABLES.indexOf(b.table) || a.id - b.id)
    .map((n) => ({ table: n.table, id: n.id, label: labelOf(n.table, n.id), reason: n.reasons.join('; ') }));
  const removedUsed: GoLiveRecordNote[] = [];
  for (const [key, n] of demoChanges) {
    const [table, raw] = key.split(':') as [SeedMarkTable, string];
    const id = Number(raw);
    if (remove.get(table)?.has(id)) removedUsed.push({ table, id, label: labelOf(table, id), reason: `${n} ${n === 1 ? 'change' : 'changes'} by demo accounts` });
  }
  removedUsed.sort((a, b) => SEED_MARK_TABLES.indexOf(a.table) - SEED_MARK_TABLES.indexOf(b.table) || a.id - b.id);
  return { remove, kept, removedUsed };
}

/** The demo company's people who were used since the seed (any audit row of theirs: a sign-in, a change). */
function usedDemoPeople(db: Db, people: GoLivePerson[]): GoLiveUsedPerson[] {
  if (!tableExists(db, 'audit_log') || !people.length) return [];
  const rows = all<{ userId: number; changes: number; signIns: number; lastAt: string }>(
    db,
    `SELECT user_id AS userId, SUM(COALESCE(kind, 'change') IN ('change', 'client')) AS changes, SUM(kind = 'sign_in') AS signIns, MAX(at) AS lastAt
     FROM audit_log WHERE user_id IN (SELECT value FROM json_each(?)) GROUP BY user_id`,
    [JSON.stringify(people.map((p) => p.id))],
  );
  const byId = new Map(rows.map((r) => [r.userId, r]));
  return people.flatMap((p) => {
    const r = byId.get(p.id);
    return r ? [{ ...p, changes: Number(r.changes ?? 0), signIns: Number(r.signIns ?? 0), lastAt: r.lastAt }] : [];
  });
}

/** What going live would do, without changing anything. */
export function planGoLive(db: Db): GoLivePlan {
  if (!isTrialMode(db)) {
    return { trialMode: false, removePeople: [], keepPeople: [], removeRecords: {}, ownerNeeded: false, usedDemoPeople: [], keptDemoRecords: [], removedUsedRecords: [] };
  }
  const ids = demoPeopleIds(db);
  const people = all<GoLivePerson>(db, `${PERSON_SELECT} ORDER BY id`);
  const isDemo = new Set(ids);
  const removePeople = people.filter((p) => isDemo.has(p.id));
  const keepPeople = people.filter((p) => !isDemo.has(p.id));
  const removal = demoRecordsToRemove(db, ids);
  const removeRecords: Partial<Record<SeedMarkTable, number>> = {};
  for (const t of SEED_MARK_TABLES) {
    const n = removal.remove.get(t)?.size ?? 0;
    if (n) removeRecords[t] = n;
  }
  const ownerNeeded = !keepPeople.some((p) => p.role === 'admin' && p.status !== 'left');
  return {
    trialMode: true, removePeople, keepPeople, removeRecords, ownerNeeded,
    usedDemoPeople: usedDemoPeople(db, removePeople), keptDemoRecords: removal.kept, removedUsedRecords: removal.removedUsed,
  };
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
  // the owner: needed when no administrator of the office's own stays; made anyway when asked for (the person going live
  // used a demo account, and a colleague they added is the only administrator of their own)
  const makeOwner = plan.ownerNeeded || Boolean(opts.owner);
  if (makeOwner) {
    const problem = ownerProblem(db, opts.owner, plan);
    if (problem) throw new Error(problem);
  }
  const now = opts.now ?? new Date();
  const ids = demoPeopleIds(db);
  const demo = JSON.stringify(ids);

  const result = transaction(db, (): GoLiveResult => {
    // the first real owner, before anything that needs one; their email and employee ID may be a demo person's (the
    // demo owner's LM-0001, say), so placeholders until the demo people are gone
    let ownerId: number | null = null;
    if (makeOwner && opts.owner) {
      const o = opts.owner;
      // an owner's plan (position 'owner', e.g. "Owner (salaried)"), else the plan of an administrator going away (the
      // demo owner's), else the first plan: never the trainee plan just because it comes first
      const plan0 = get<{ id: number }>(
        db,
        `SELECT id FROM pay_plans
         ORDER BY (position = 'owner') DESC,
                  (id IN (SELECT pay_plan_id FROM users WHERE role = 'admin' AND id IN (SELECT value FROM json_each(?)))) DESC,
                  id
         LIMIT 1`,
        [demo],
      );
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
    const { remove } = demoRecordsToRemove(db, ids);
    const removedRecords: Partial<Record<SeedMarkTable, number>> = {};
    for (const t of ORDER) {
      const gone = [...(remove.get(t) ?? [])];
      if (!gone.length) continue;
      const n = run(db, `DELETE FROM ${t} WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(gone)]).changes;
      if (n) removedRecords[t] = n;
    }
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

    // everyone signs out, and half-finished two-step sign-ins start again: a session made in the trial (one tap, or a
    // 1.4 session made with an email and employee ID only) must not outlive it, or it could set up two-step without a
    // setup code. Each person signs in again under the live rules: two-step, or a setup code until they have it.
    const signedOut = run(db, `DELETE FROM sessions`).changes;
    run(db, `DELETE FROM two_factor_challenges`);

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
        (owner ? `; made ${owner.name} the owner` : '') + '; signed everyone out',
      before: { trialMode: true },
      after: { trialMode: false },
    });

    const notSetUp = all<{ id: number; name: string; email: string }>(
      db, `SELECT id, TRIM(first_name || ' ' || last_name) AS name, email FROM users WHERE status <> 'left' ORDER BY id`,
    )
      .filter((p) => p.id !== owner?.id && !isTwoFactorEnabled(db, p.id))
      .map(({ name, email }) => ({ name, email }));
    return { removedPeople, removedRecords, owner, notSetUp, signedOut };
  });
  return result;
}
