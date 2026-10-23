/**
 * Release 1.3.1: team Sapiens and its seven blank demo accounts (Theo, Daniel, Ridwan, Jamie as Team Leaders; Olivia,
 * Owens, Yasmin as trainees). A fresh demo seed inserts them at its very end (after every extension seed); an existing
 * demo database gains them once on start-up (db/extensions/sapiens.ts); a database the demo seed did not create never
 * does. The sign-in page lists them only from the marker the seed or that step wrote.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TEAM_ACCOUNTS, DEMO_TEAMS } from '../db/seed-data.ts';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { extension as sapiensExtension } from '../db/extensions/sapiens.ts';
import { EXTENSIONS } from '../db/extensions/index.ts';
import { demoTeamMarkers, DEMO_TEAMS_DONE_KEY, DEMO_TEAMS_META_KEY, isDemoDatabase } from '../lib/demoTeams.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { buildFixture, startTestServer, type TestServer } from './helpers.ts';

const TODAY = '2026-10-21';
const SEVEN = [
  ['LM-0101', 'Theo', 'leader', 'team_leader'],
  ['LM-0102', 'Daniel', 'leader', 'team_leader'],
  ['LM-0103', 'Ridwan', 'leader', 'team_leader'],
  ['LM-0104', 'Jamie', 'leader', 'team_leader'],
  ['LM-0105', 'Olivia', 'rep', 'trainee'],
  ['LM-0106', 'Owens', 'rep', 'trainee'],
  ['LM-0107', 'Yasmin', 'rep', 'trainee'],
] as const;
const emailOf = (first: string) => `${first.toLowerCase()}@linear-mcr.co.uk`;

interface UserRow {
  id: number; employeeId: string; email: string; firstName: string; lastName: string; role: string; position: string;
  teamId: number | null; status: string; startDate: string; city: string | null; payPlanId: number; phone: string | null; pinHash: string | null;
}
const USER_COLS = `id, employee_id AS employeeId, email, first_name AS firstName, last_name AS lastName, role, position, team_id AS teamId,
  status, start_date AS startDate, city, pay_plan_id AS payPlanId, phone, pin_hash AS pinHash`;

function sapiensTeam(db: Db): { id: number; name: string; color: string; leaderId: number | null } | undefined {
  return get(db, `SELECT id, name, color, leader_id AS leaderId FROM teams WHERE lower(name) = 'sapiens'`);
}
function sapiensUsers(db: Db): UserRow[] {
  return all<UserRow>(db, `SELECT ${USER_COLS} FROM users WHERE lower(email) IN (${SEVEN.map(() => '?').join(', ')}) ORDER BY employee_id`, SEVEN.map(([, f]) => emailOf(f)));
}
const count = (db: Db, sql: string, params: (string | number)[] = []) => Number(get<{ n: number }>(db, sql, params)!.n);

/** A fresh demo database on the pinned business clock (Wed 21 Oct 2026, 15:00). */
function freshDemo(options: Parameters<typeof seed>[2] = {}): { db: Db; stats: ReturnType<typeof seed> } {
  setBusinessClock(new Date(`${TODAY}T15:00:00`));
  const db = openDb(':memory:');
  createSchema(db);
  const stats = seed(db, TODAY, options);
  return { db, stats };
}

before(() => setBusinessClock(new Date(`${TODAY}T15:00:00`)));
after(() => setBusinessClock(null));

test('seed data: the seven accounts and team Sapiens as the owner listed them (ids and emails free in the demo)', () => {
  assert.deepEqual(DEMO_TEAMS.map((t) => t.name), ['Sapiens']);
  assert.deepEqual(DEMO_TEAM_ACCOUNTS.map((a) => [a.employeeId, a.firstName, a.role, a.position]), SEVEN.map((s) => [...s]));
  assert.ok(DEMO_TEAM_ACCOUNTS.every((a) => a.team === 'Sapiens' && a.email === emailOf(a.firstName)));
  assert.equal(DEMO_TEAM_ACCOUNTS.filter((a) => a.leadsTeam).map((a) => a.firstName).join(), 'Theo');
  assert.ok(EXTENSIONS.at(-1)?.name === 'sapiens' && sapiensExtension.seed === undefined, 'appended last; its seed does nothing');
});

test('fresh demo seed: team Sapiens (its own colour, Theo leads) with seven active, blank accounts at the very end', () => {
  const { db, stats } = freshDemo();
  try {
    const team = sapiensTeam(db)!;
    assert.ok(team, 'team Sapiens');
    const others = all<{ color: string }>(db, `SELECT color FROM teams WHERE id <> ?`, [team.id]).map((t) => t.color.toLowerCase());
    assert.equal(others.length, 4);
    assert.ok(!others.includes(team.color.toLowerCase()), 'a colour none of the four demo teams has');
    const people = sapiensUsers(db);
    assert.deepEqual(people.map((u) => [u.employeeId, u.firstName, u.role, u.position]), SEVEN.map((s) => [...s]));
    for (const u of people) {
      assert.equal(u.lastName, '', `${u.firstName}: no surname`);
      assert.equal(u.email, emailOf(u.firstName));
      assert.equal(u.teamId, team.id);
      assert.equal(u.status, 'active');
      assert.equal(u.startDate, TODAY, 'start date = business today');
      assert.equal(u.city, 'Manchester');
      assert.equal(u.phone, null);
      assert.equal(u.pinHash, null, 'PIN off');
      const plan = get<{ id: number }>(db, `SELECT id FROM pay_plans WHERE position = ? ORDER BY id LIMIT 1`, [u.position])!;
      assert.equal(u.payPlanId, plan.id, `${u.firstName}: the default plan for ${u.position}`);
    }
    assert.equal(team.leaderId, people[0]!.id, 'Theo is the team leader');
    // inserted last: every other person (staff and the demo client) has a lower row id
    const maxOther = count(db, `SELECT MAX(id) AS n FROM users WHERE team_id IS NOT ? OR team_id IS NULL`, [team.id]);
    assert.ok(people.every((u) => u.id > maxOther), 'after every other user, the demo client included');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`), stats.users, 'counted in stats.users');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM teams`), stats.teams, 'counted in stats.teams');
    // the marker: exactly the seven, with their ids, employee IDs and emails, and the one-off step marked done
    const markers = demoTeamMarkers(db);
    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.teamId, team.id);
    assert.deepEqual(markers[0]!.accounts.map((a) => [a.id, a.employeeId, a.email]), people.map((u) => [u.id, u.employeeId, u.email]));
    assert.ok(get(db, `SELECT 1 FROM meta WHERE key = ?`, [DEMO_TEAMS_DONE_KEY]));
    assert.ok(isDemoDatabase(db));
  } finally {
    db.close();
  }
});

test('fresh demo seed: no data row anywhere refers to the seven (no gauges, pay, invoices, learning, audit…)', () => {
  const { db } = freshDemo();
  try {
    const ids = sapiensUsers(db).map((u) => u.id);
    assert.equal(ids.length, 7);
    const team = sapiensTeam(db)!;
    const tables = all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((t) => t.name);
    const USERISH = /^(user_id|author_id|created_by|updated_by|approved_by|decided_by|resolved_by|applied_by|booked_by|changed_by|changed_by_id|owner_id|referred_by_id|hired_user_id|interviewer_id|taught_signed_off_by|paid_override_by|leader_id|actor_id)$/;
    let checked = 0;
    for (const t of tables) {
      const fkCols = all<{ table: string; from: string }>(db, `PRAGMA foreign_key_list(${t})`).filter((f) => f.table === 'users').map((f) => f.from);
      const named = all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name).filter((c) => USERISH.test(c));
      for (const col of new Set([...fkCols, ...named])) {
        if (t === 'users') continue;
        checked++;
        const rows = all<{ id: unknown }>(db, `SELECT rowid AS id FROM ${t} WHERE ${col} IN (${ids.map(() => '?').join(', ')})`, ids);
        if (t === 'teams' && col === 'leader_id') {
          assert.equal(rows.length, 1, 'only team Sapiens names Theo as its leader');
          assert.equal(count(db, `SELECT COUNT(*) AS n FROM teams WHERE leader_id = ? AND id = ?`, [ids[0]!, team.id]), 1);
          continue;
        }
        assert.equal(rows.length, 0, `${t}.${col} refers to a Sapiens account`);
      }
    }
    assert.ok(checked >= 30, `checked ${checked} columns that refer to people`);
    for (const t of ['events', 'gauge_entries', 'payroll_runs', 'check_ins', 'event_roster']) {
      const teamCol = all<{ name: string }>(db, `PRAGMA table_info(${t})`).some((c) => c.name === 'team_id');
      if (teamCol) assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE team_id = ?`, [team.id]), 0, `${t}: nothing for team Sapiens`);
    }
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'user' AND entity_id IN (${ids.join(',')})`), 0, 'no audit rows from the seed');
  } finally {
    db.close();
  }
});

test('fresh demo seed: a restart reports no change and inserts nothing; the seed without them (a 1.3.0 database) matches otherwise', () => {
  const { db } = freshDemo();
  const plain = freshDemo({ demoTeams: false }).db;
  try {
    const before = count(db, `SELECT COUNT(*) AS n FROM users`);
    assert.deepEqual(createSchema(db), [], 'the first restart after a fresh seed reports nothing');
    assert.deepEqual(createSchema(db), []);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`), before);
    // the seven are the only difference between the two seeds' people
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`) - count(plain, `SELECT COUNT(*) AS n FROM users`), 7);
    assert.equal(sapiensTeam(plain), undefined);
    const firstRows = (d: Db) => all<Record<string, unknown>>(d, `SELECT * FROM users WHERE id <= ? ORDER BY id`, [count(plain, `SELECT MAX(id) AS n FROM users`)]);
    assert.deepEqual(firstRows(db), firstRows(plain), 'every other user row is exactly as before');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM gauge_entries`), count(plain, `SELECT COUNT(*) AS n FROM gauge_entries`));
  } finally {
    db.close();
    plain.close();
  }
});

test('an existing demo database (seeded by 1.3.0) gains Sapiens once on start-up; a second start changes nothing', () => {
  const { db } = freshDemo({ demoTeams: false });
  try {
    assert.equal(sapiensTeam(db), undefined);
    assert.ok(isDemoDatabase(db));
    const usersBefore = count(db, `SELECT COUNT(*) AS n FROM users`);
    const changed = createSchema(db);
    assert.deepEqual(changed, ['sapiens:team.sapiens'], 'reported once, under the extension');
    const team = sapiensTeam(db)!;
    const people = sapiensUsers(db);
    assert.deepEqual(people.map((u) => [u.employeeId, u.firstName, u.role, u.position, u.teamId, u.lastName, u.status]), SEVEN.map((s) => [...s, team.id, '', 'active']));
    assert.equal(team.leaderId, people[0]!.id);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`), usersBefore + 7);
    assert.equal(demoTeamMarkers(db)[0]!.accounts.length, 7);
    const snapshot = JSON.stringify(all(db, `SELECT * FROM users ORDER BY id`)) + JSON.stringify(all(db, `SELECT * FROM teams ORDER BY id`));
    assert.deepEqual(createSchema(db), [], 'the second start reports nothing');
    assert.equal(JSON.stringify(all(db, `SELECT * FROM users ORDER BY id`)) + JSON.stringify(all(db, `SELECT * FROM teams ORDER BY id`)), snapshot, 'and changes nothing');
    // deleted by hand later: the step is done, it never comes back
    run(db, `UPDATE teams SET leader_id = NULL WHERE id = ?`, [team.id]);
    run(db, `DELETE FROM users WHERE team_id = ?`, [team.id]);
    run(db, `DELETE FROM teams WHERE id = ?`, [team.id]);
    assert.deepEqual(createSchema(db), []);
    assert.equal(sapiensTeam(db), undefined, 'once means once');
  } finally {
    db.close();
  }
});

test('a "Sapiens" team made by hand is reused: only the missing accounts are added (matched by email), nothing duplicated', () => {
  const { db } = freshDemo({ demoTeams: false });
  try {
    const plan = get<{ id: number }>(db, `SELECT id FROM pay_plans WHERE position = 'team_leader'`)!.id;
    const teamId = run(db, `INSERT INTO teams (name, leader_id, color) VALUES ('sapiens', NULL, '#123456')`).lastInsertRowid;
    const theo = run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES ('LM-0035', 'Theo@linear-mcr.co.uk', 'Theo', 'Byhand', 'leader', 'team_leader', ?, ?, '2026-10-01', 'active', NULL, '#4F46E5', 'Salford')`,
      [teamId, plan],
    ).lastInsertRowid;
    // someone else already holds LM-0103: Ridwan gets the next free ID instead
    run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES ('LM-0103', 'someone.else@linear-mcr.co.uk', 'Some', 'One', 'rep', 'field_rep', NULL, ?, '2026-10-01', 'active', NULL, '#4F46E5', NULL)`,
      [plan],
    );
    assert.deepEqual(createSchema(db), ['sapiens:team.sapiens']);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM teams WHERE lower(name) = 'sapiens'`), 1, 'no second Sapiens team');
    const team = sapiensTeam(db)!;
    assert.equal(team.color, '#123456', 'the hand-made team is left as it was');
    const people = sapiensUsers(db);
    assert.equal(people.length, 7);
    assert.ok(people.every((u) => u.teamId === teamId));
    const handTheo = people.find((u) => u.firstName === 'Theo')!;
    assert.deepEqual([handTheo.id, handTheo.employeeId, handTheo.lastName, handTheo.city], [theo, 'LM-0035', 'Byhand', 'Salford'], 'Theo by hand untouched');
    assert.equal(team.leaderId, theo, 'a team without a leader gets Theo (already on it)');
    const ridwan = people.find((u) => u.firstName === 'Ridwan')!;
    assert.notEqual(ridwan.employeeId, 'LM-0103');
    assert.match(ridwan.employeeId, /^LM-\d{4}$/);
    const marked = demoTeamMarkers(db)[0]!;
    assert.equal(marked.teamId, teamId);
    assert.deepEqual(marked.accounts.map((a) => a.email), SEVEN.slice(1).map(([, f]) => emailOf(f)), 'the marker lists only the six it inserted');
    assert.equal(marked.accounts.find((a) => a.email === emailOf('Ridwan'))!.employeeId, ridwan.employeeId);
    assert.deepEqual(createSchema(db), []);
  } finally {
    db.close();
  }
});

test('a database the demo seed did not create never gains them (the test fixture, a bare install, a 1.2-shaped database)', () => {
  // the route-test fixture writes `seeded_at` but is not the demo seed
  const fx = openDb(':memory:');
  try {
    createSchema(fx);
    buildFixture(fx, TODAY);
    assert.equal(isDemoDatabase(fx), false);
    assert.ok(!createSchema(fx).some((c) => c.startsWith('sapiens:')), 'other extensions may backfill the fixture; this one does nothing');
    assert.equal(sapiensTeam(fx), undefined);
    assert.equal(get(fx, `SELECT 1 FROM meta WHERE key = ?`, [DEMO_TEAMS_DONE_KEY]), undefined, 'no flag: nothing was done');
  } finally {
    fx.close();
  }
  // a database with people but no demo seed meta at all
  const bare = openDb(':memory:');
  try {
    createSchema(bare);
    bare.exec(`INSERT INTO teams (name, leader_id, color) VALUES ('Real team', NULL, '#2563EB')`);
    bare.exec(`INSERT INTO pay_plans (name, position, base_per_day) VALUES ('Trainee', 'trainee', 60), ('Leader', 'team_leader', 60)`);
    bare.exec(`INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, avatar_color)
               VALUES ('LM-0001', 'owner@real.example', 'Real', 'Owner', 'admin', 'owner', NULL, 1, '2025-01-06', '#4F46E5')`);
    assert.deepEqual(sapiensExtension.upgrade(bare), []);
    assert.ok(!createSchema(bare).some((c) => c.startsWith('sapiens:')));
    assert.equal(sapiensTeam(bare), undefined);
    assert.equal(count(bare, `SELECT COUNT(*) AS n FROM users`), 1);
  } finally {
    bare.close();
  }
  // an empty database (the fresh-install upgrade before the seed): skipped without setting the flag
  const empty = openDb(':memory:');
  try {
    createSchema(empty);
    empty.exec(`INSERT INTO meta (key, value) VALUES ('seeded_at', 'x'), ('seed_today', '${TODAY}')`);
    assert.deepEqual(sapiensExtension.upgrade(empty), []);
    assert.equal(get(empty, `SELECT 1 FROM meta WHERE key = ?`, [DEMO_TEAMS_DONE_KEY]), undefined);
    assert.equal(count(empty, `SELECT COUNT(*) AS n FROM users`), 0);
  } finally {
    empty.close();
  }
});

test('a demo-born database in real use never gains them: LM_DEMO_ACCOUNTS=0 waits, changed demo staff end the step', () => {
  const off = freshDemo({ demoTeams: false }).db;
  try {
    process.env.LM_DEMO_ACCOUNTS = '0';
    try {
      assert.deepEqual(createSchema(off), []);
      assert.equal(sapiensTeam(off), undefined);
      assert.equal(get(off, `SELECT 1 FROM meta WHERE key = ?`, [DEMO_TEAMS_DONE_KEY]), undefined, 'asked again next start');
    } finally {
      delete process.env.LM_DEMO_ACCOUNTS;
    }
    assert.deepEqual(createSchema(off), ['sapiens:team.sapiens'], 'still a demo once the variable is gone');
  } finally {
    off.close();
  }
  const live = freshDemo({ demoTeams: false }).db;
  try {
    run(live, `UPDATE users SET status = 'left' WHERE employee_id IN ('LM-0002', 'LM-0003', 'LM-0010')`);
    assert.deepEqual(createSchema(live), []);
    assert.equal(sapiensTeam(live), undefined);
    assert.ok(get(live, `SELECT 1 FROM meta WHERE key = ?`, [DEMO_TEAMS_DONE_KEY]), 'done: a database in real use');
    run(live, `UPDATE users SET status = 'active'`);
    assert.deepEqual(createSchema(live), [], 'and stays done');
  } finally {
    live.close();
  }
});

test('marker: an unreadable value lists nobody', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    for (const bad of ['not json', '{}', '[{"teamId":"x"}]', '[{"teamId":1,"accounts":[{"id":"1"}]}]']) {
      run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [DEMO_TEAMS_META_KEY, bad]);
      assert.ok(demoTeamMarkers(db).every((m) => m.accounts.length === 0), bad);
    }
  } finally {
    db.close();
  }
});

// ───────────────────────────── the sign-in page and the accounts in use ─────────────────────────────

let srv: TestServer;
before(async () => {
  srv = await startTestServer({ seed: true, today: TODAY });
});
after(async () => {
  await srv.close();
});

test('GET /auth/demo-accounts: the four, then the Sapiens group with the seven one-click sign-ins in order', async () => {
  const r = await srv.anon().get('/auth/demo-accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.accounts.map((a: { employeeId: string }) => a.employeeId), ['LM-0001', 'LM-0002', 'LM-0003', 'LM-0010'], 'the four keep their shape and order');
  assert.equal(r.json.demoTeams.length, 1);
  const group = r.json.demoTeams[0];
  assert.equal(group.name, 'Sapiens');
  assert.match(group.color, /^#[0-9A-Fa-f]{6}$/);
  assert.deepEqual(group.accounts.map((a: { employeeId: string }) => a.employeeId), SEVEN.map(([id]) => id));
  assert.deepEqual(group.accounts[0], {
    label: 'Theo (Team Leader)', name: 'Theo', role: 'leader', position: 'team_leader', email: 'theo@linear-mcr.co.uk', employeeId: 'LM-0101',
  });
  assert.equal(group.accounts[4].label, 'Olivia (Trainee)');
  assert.ok(group.accounts.every((a: { label: string }) => !a.label.includes('  ') && !a.label.includes(' (', a.label.indexOf('(') + 1)));
});

test('GET /auth/demo-accounts: hidden with LM_DEMO_ACCOUNTS=0; an account whose email changed or who left drops out', async () => {
  process.env.LM_DEMO_ACCOUNTS = '0';
  try {
    assert.deepEqual((await srv.anon().get('/auth/demo-accounts')).json, { accounts: [] });
  } finally {
    delete process.env.LM_DEMO_ACCOUNTS;
  }
  const owens = get<{ id: number }>(srv.db, `SELECT id FROM users WHERE email = 'owens@linear-mcr.co.uk'`)!.id;
  const yasmin = get<{ id: number }>(srv.db, `SELECT id FROM users WHERE email = 'yasmin@linear-mcr.co.uk'`)!.id;
  try {
    run(srv.db, `UPDATE users SET email = 'owens.real@example.test' WHERE id = ?`, [owens]);
    run(srv.db, `UPDATE users SET status = 'left' WHERE id = ?`, [yasmin]);
    const ids = (await srv.anon().get('/auth/demo-accounts')).json.demoTeams[0].accounts.map((a: { employeeId: string }) => a.employeeId);
    assert.deepEqual(ids, ['LM-0101', 'LM-0102', 'LM-0103', 'LM-0104', 'LM-0105'], 'a real email or a leaver is never offered on the sign-in page');
  } finally {
    run(srv.db, `UPDATE users SET email = 'owens@linear-mcr.co.uk' WHERE id = ?`, [owens]);
    run(srv.db, `UPDATE users SET status = 'active' WHERE id = ?`, [yasmin]);
  }
});

test('GET /auth/demo-accounts: never by email or ID alone — no marker, no group', async () => {
  const fx = await startTestServer();
  try {
    const plan = fx.fixture!.plans.leader;
    run(fx.db, `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, avatar_color)
                VALUES ('LM-0101', 'theo@linear-mcr.co.uk', 'Theo', '', 'leader', 'team_leader', ?, ?, '2026-10-01', 'active', '#4F46E5')`, [fx.fixture!.teams.a, plan]);
    const r = await fx.anon().get('/auth/demo-accounts');
    assert.equal(r.status, 200);
    assert.equal(r.json.demoTeams, undefined);
    assert.ok(!JSON.stringify(r.json).includes('LM-0101'));
  } finally {
    await fx.close();
  }
});

test('Theo and Olivia sign in with the one-click details; their pages work with no data at all', async () => {
  const theo = await srv.login({ email: 'theo@linear-mcr.co.uk', employeeId: 'LM-0101' });
  const me = (await theo.get('/auth/me')).json.user;
  assert.equal(me.firstName, 'Theo');
  assert.equal(me.lastName, '');
  assert.equal(me.teamName, 'Sapiens');
  assert.equal(me.role, 'leader');
  assert.equal(me.pinSetupRequired, false, 'no PIN to create on the demo');
  for (const path of ['/me/dashboard', '/finance/me', '/leaderboard', '/events', '/gauges', '/me/attention', `/users/${me.id}/performance`, '/learning/team']) {
    const r = await theo.get(path);
    assert.ok(r.status === 200, `${path} → ${r.status}`);
  }
  const team = (await theo.get(`/users?teamId=${me.teamId}`)).json as { firstName: string; employeeId: string }[];
  assert.deepEqual(team.map((u) => u.firstName), ['Daniel', 'Jamie', 'Olivia', 'Owens', 'Ridwan', 'Theo', 'Yasmin'], 'sorted by name, first names standing in for surnames');
  assert.ok(team.every((u) => u.firstName === 'Theo' ? u.employeeId === 'LM-0101' : u.employeeId === ''), 'employee IDs stay hidden from a leader');
  const teams = (await theo.get('/teams')).json as { name: string; leaderName: string | null; memberCount?: number }[];
  const sap = teams.find((t) => t.name === 'Sapiens')!;
  assert.equal(sap.leaderName, 'Theo', 'no trailing space');
  const olivia = await srv.login({ email: 'olivia@linear-mcr.co.uk', employeeId: 'LM-0105' });
  for (const path of ['/me/dashboard', '/finance/me', '/me/digest', '/learning/progress']) {
    const r = await olivia.get(path);
    assert.ok(r.status === 200, `${path} → ${r.status}`);
  }
  const perf = (await olivia.get('/me/dashboard')).json;
  assert.ok(perf, 'a dashboard with nothing in it');
});

test('names without a surname read well: the Team list sorts them among the others, audit sentences have no double space', async () => {
  const admin = await srv.login('admin');
  const all = (await admin.get('/users')).json as { firstName: string; lastName: string }[];
  const keys = all.map((u) => (u.lastName || u.firstName).toLowerCase());
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)), 'one alphabetical list');
  const theoId = get<{ id: number }>(srv.db, `SELECT id FROM users WHERE email = 'theo@linear-mcr.co.uk'`)!.id;
  // Edit without adding a surname still saves (it stays blank); adding one later works; clearing a real one does not
  const p1 = await admin.patch(`/users/${theoId}`, { phone: '07700 900101', lastName: '' });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  assert.equal(p1.json.lastName, '');
  const summary = get<{ s: string }>(srv.db, `SELECT summary AS s FROM audit_log WHERE entity = 'user' AND entity_id = ? ORDER BY id DESC LIMIT 1`, [theoId])!.s;
  assert.match(summary, /^Updated Theo\b/);
  assert.ok(!summary.includes('  '), summary);
  const p2 = await admin.patch(`/users/${theoId}`, { lastName: 'Example' });
  assert.equal(p2.json.lastName, 'Example');
  const p3 = await admin.patch(`/users/${theoId}`, { lastName: '' });
  assert.equal(p3.status, 400, 'a surname, once given, cannot be cleared');
  assert.match(JSON.stringify(p3.json), /last name/i);
  run(srv.db, `UPDATE users SET last_name = '', phone = NULL WHERE id = ?`, [theoId]);
});
