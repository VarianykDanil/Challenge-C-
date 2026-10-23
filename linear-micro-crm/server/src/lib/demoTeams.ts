/**
 * Release 1.3.1: the demo teams whose accounts start blank — team Sapiens and its seven sign-ins (db/seed-data.ts
 * DEMO_TEAMS, DEMO_TEAM_ACCOUNTS). One function adds them for both paths:
 *  - a fresh demo seed calls addDemoTeams at its very end, after every extension seed (db/seed.ts), and marks the
 *    one-off step done;
 *  - an existing demo database gains them once on start-up (db/extensions/sapiens.ts), guarded by the same flag.
 * They are recognised as the demo accounts by the marker written here (meta `seed_demo_teams`: the team and each
 * account's id, employee ID and email), never by their email or ID alone — the sign-in page lists only those, and only
 * while the id, ID and email still match (routes/auth.ts GET /auth/demo-accounts), like the demo client account.
 */
import type { Role } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { AVATAR_PALETTE, DEMO_TEAM_ACCOUNTS, DEMO_TEAMS, type DemoTeamAccountSeed, type DemoTeamSeed } from '../db/seed-data.ts';
import { formatEmployeeId, maxEmployeeNumber } from './people.ts';

/** meta key: JSON `DemoTeamMarker[]`, the demo team accounts the seed or the start-up step inserted. */
export const DEMO_TEAMS_META_KEY = 'seed_demo_teams';
/** meta flag: the one-off step has run on this database (set by the fresh seed too), so it never runs again. */
export const DEMO_TEAMS_DONE_KEY = 'ext:sapiens:accounts';

export interface DemoTeamAccountMarker {
  id: number;
  employeeId: string;
  email: string;
}

export interface DemoTeamMarker {
  teamId: number;
  accounts: DemoTeamAccountMarker[];
}

/**
 * True for a database the demo seed created: it writes both `seeded_at` and `seed_today` (the route-test fixture writes
 * only `seeded_at`; a database the seed did not build has neither).
 */
export function isDemoDatabase(db: Db): boolean {
  const n = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM meta WHERE key IN ('seeded_at', 'seed_today') AND COALESCE(value, '') <> ''`);
  return Number(n?.n ?? 0) === 2;
}

/**
 * The four seeded staff demo accounts (the sign-in page's one-click buttons). GET /auth/demo-accounts lists them, and the
 * demo start-up steps run, only while all four are present with these roles and none has left (demoStaffIntact).
 */
export const DEMO_STAFF: readonly { employeeId: string; role: Role; label: string }[] = [
  { employeeId: 'LM-0001', role: 'admin', label: 'Owner' },
  { employeeId: 'LM-0002', role: 'leader', label: 'Crew Leader' },
  { employeeId: 'LM-0003', role: 'recruiter', label: 'Recruiter' },
  { employeeId: 'LM-0010', role: 'rep', label: 'Field Rep' },
];

/** True while the four seeded staff demo accounts are all there, with their demo roles, and none has left. */
export function demoStaffIntact(db: Db): boolean {
  const rows = all<{ employeeId: string; role: string; status: string }>(
    db,
    `SELECT upper(employee_id) AS employeeId, role, status FROM users WHERE upper(employee_id) IN (${DEMO_STAFF.map(() => '?').join(', ')})`,
    DEMO_STAFF.map((d) => d.employeeId),
  );
  return DEMO_STAFF.every((d) => rows.some((r) => r.employeeId === d.employeeId && r.role === d.role && r.status !== 'left'));
}

/**
 * Whether a one-off demo start-up step (the Sapiens accounts, the demo charity account) may add its accounts now:
 * - 'later': not now, ask again on the next start — the server runs with LM_DEMO_ACCOUNTS=0 (the operator says real
 *   people use it), the database is not one the demo seed created, or its core rows are not there yet (a fresh install
 *   before its seed);
 * - 'never': the database began as the demo but its demo staff are gone or changed — it is in real use now, so the step
 *   is done without adding anything (the caller sets its flag);
 * - 'yes': a demo database whose four demo staff are intact.
 * Every Linear Hub database starts from the demo seed, so the seed's meta alone never decides this.
 */
export function demoStepAllowed(db: Db): 'yes' | 'later' | 'never' {
  if (process.env.LM_DEMO_ACCOUNTS === '0') return 'later';
  if (!isDemoDatabase(db)) return 'later';
  if (!get(db, `SELECT 1 FROM users LIMIT 1`) || !get(db, `SELECT 1 FROM pay_plans LIMIT 1`)) return 'later';
  return demoStaffIntact(db) ? 'yes' : 'never';
}

const isAccount = (a: unknown): a is DemoTeamAccountMarker =>
  typeof a === 'object' && a !== null && Number.isInteger((a as DemoTeamAccountMarker).id) &&
  typeof (a as DemoTeamAccountMarker).employeeId === 'string' && typeof (a as DemoTeamAccountMarker).email === 'string';

/** The demo team accounts recorded on this database ([] when none, or the value is unreadable). */
export function demoTeamMarkers(db: Db): DemoTeamMarker[] {
  const raw = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [DEMO_TEAMS_META_KEY])?.value;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((m): DemoTeamMarker[] => {
      if (typeof m !== 'object' || m === null || !Number.isInteger((m as DemoTeamMarker).teamId)) return [];
      const accounts = Array.isArray((m as DemoTeamMarker).accounts) ? (m as DemoTeamMarker).accounts.filter(isAccount) : [];
      return [{ teamId: (m as DemoTeamMarker).teamId, accounts: accounts.map(({ id, employeeId, email }) => ({ id, employeeId, email })) }];
    });
  } catch {
    return [];
  }
}

function writeDemoTeamMarkers(db: Db, markers: readonly DemoTeamMarker[]): void {
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [DEMO_TEAMS_META_KEY, JSON.stringify(markers)]);
}

export interface AddDemoTeamsResult {
  teamsCreated: number;
  inserted: DemoTeamAccountMarker[];
}

const employeeNumber = (id: string) => Number(id.slice(3));

/**
 * Adds each demo team (reusing a team of that name, any case, when one exists) and its accounts that are missing,
 * matched by email: active, no surname, start date `today`, Manchester, the default pay plan for the position, no
 * phone, no PIN. An account keeps its fixed employee ID unless someone already has it; then it gets the next number
 * above both the IDs in use and the demo's own. A team without a leader gets its `leadsTeam` account when that person
 * is on it. Writes nothing else (no gauges, events, pay or audit rows). Records what it inserted in the marker. The
 * caller holds the transaction and sets DEMO_TEAMS_DONE_KEY.
 */
export function addDemoTeams(
  db: Db,
  today: string,
  teams: readonly DemoTeamSeed[] = DEMO_TEAMS,
  accounts: readonly DemoTeamAccountSeed[] = DEMO_TEAM_ACCOUNTS,
): AddDemoTeamsResult {
  const markers = demoTeamMarkers(db);
  const result: AddDemoTeamsResult = { teamsCreated: 0, inserted: [] };
  const reservedTop = Math.max(0, ...accounts.map((a) => employeeNumber(a.employeeId)));
  const insertUser = db.prepare(
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 'active', NULL, ?, 'Manchester')`,
  );
  for (const t of teams) {
    let team = get<{ id: number; leaderId: number | null }>(db, `SELECT id, leader_id AS leaderId FROM teams WHERE lower(name) = lower(?) ORDER BY id LIMIT 1`, [t.name]);
    if (!team) {
      team = { id: run(db, `INSERT INTO teams (name, leader_id, color) VALUES (?, NULL, ?)`, [t.name, t.color]).lastInsertRowid, leaderId: null };
      result.teamsCreated++;
    }
    const added: DemoTeamAccountMarker[] = [];
    for (const a of accounts.filter((x) => x.team === t.name)) {
      if (get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?)`, [a.email])) continue;
      const plan = get<{ id: number }>(db, `SELECT id FROM pay_plans WHERE position = ? ORDER BY id LIMIT 1`, [a.position]);
      if (!plan) continue;
      const taken = get(db, `SELECT 1 FROM users WHERE lower(employee_id) = lower(?)`, [a.employeeId]);
      const employeeId = taken ? formatEmployeeId(Math.max(maxEmployeeNumber(db), reservedTop) + 1) : a.employeeId;
      const color = AVATAR_PALETTE[(employeeNumber(employeeId) - 1) % AVATAR_PALETTE.length]!;
      const id = Number(insertUser.run(employeeId, a.email, a.firstName, a.role, a.position, team.id, plan.id, today, color).lastInsertRowid);
      added.push({ id, employeeId, email: a.email });
    }
    const lead = accounts.find((x) => x.team === t.name && x.leadsTeam);
    if (team.leaderId === null && lead) {
      const leader = get<{ id: number }>(db, `SELECT id FROM users WHERE lower(email) = lower(?) AND team_id = ? AND status <> 'left'`, [lead.email, team.id]);
      if (leader) run(db, `UPDATE teams SET leader_id = ? WHERE id = ?`, [leader.id, team.id]);
    }
    if (added.length) {
      const existing = markers.find((m) => m.teamId === team.id);
      if (existing) existing.accounts.push(...added);
      else markers.push({ teamId: team.id, accounts: added });
      result.inserted.push(...added);
    }
  }
  if (result.inserted.length) writeDemoTeamMarkers(db, markers);
  return result;
}
