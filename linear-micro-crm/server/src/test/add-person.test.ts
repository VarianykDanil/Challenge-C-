/**
 * Release 1.3.1: who may add people (POST /users). Administrators as before; recruiters add trainees and field reps to
 * any team; leaders (Team Leaders and Crew Leaders) to their own team only; reps, clients and anonymous callers never.
 * Non-administrators cannot choose a role other than rep, a pay plan, a status other than active, an avatar colour or an
 * employee ID — trying is refused with 403 and a sentence. The employee ID is given automatically and shown once, in
 * the 201 answer, with copyable sign-in instructions; every later read hides it again. PATCH stays admin only.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { get, run } from '../db/connection.ts';
import { isWriteLimited } from '../middleware/writeLimit.ts';
import { clearPin, hashPin, savePinHash, writeSecuritySettings } from '../lib/pin.ts';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let n = 0;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
  leader = await srv.login('leader');
  recruiter = await srv.login('recruiter');
  rep = await srv.login('rep');
});
after(async () => {
  await srv.close();
});
beforeEach(() => {
  n++;
});

const fx = () => srv.fixture!;
const person = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Sam', lastName: `Tester${n}`, email: `sam.tester${n}@linear-mcr.co.uk`, position: 'trainee', ...extra,
});
const usersCount = () => Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM users`)!.n);

test('a leader adds a trainee to their own team: rep, active, the standard plan, the next employee ID shown once', async () => {
  const before = usersCount();
  const r = await leader.post('/users', { ...person(), phone: '07700 900555', startDate: fx().today, signInUrl: 'http://192.168.1.20:4000/login' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(usersCount(), before + 1);
  const u = r.json;
  assert.equal(u.teamId, fx().teams.a, 'the team defaults to the leader’s own');
  assert.equal(u.teamName, 'Team A');
  assert.equal(u.role, 'rep');
  assert.equal(u.position, 'trainee');
  assert.equal(u.status, 'active');
  assert.equal(u.payPlanId, fx().plans.trainee, 'the default plan for the position');
  assert.equal(u.phone, '07700 900555');
  assert.match(u.avatarColor, /^#[0-9A-Fa-f]{6}$/);
  const stored = get<{ e: string }>(srv.db, `SELECT employee_id AS e FROM users WHERE id = ?`, [u.id])!.e;
  assert.match(stored, /^LM-\d{4}$/, 'an automatic LM- employee ID');
  assert.equal(u.employeeId, stored, 'shown in the 201 answer, this once');
  assert.match(u.signInInstructions, /^Hello Sam,/);
  assert.match(u.signInInstructions, /Team A team/);
  assert.ok(u.signInInstructions.includes('1. Open http://192.168.1.20:4000/login.'));
  assert.ok(u.signInInstructions.includes(`your employee ID: ${stored}.`));
  assert.ok(u.signInInstructions.includes(`(${u.email})`));
  assert.doesNotMatch(u.signInInstructions, /PIN/, 'no PIN step while the office does not require one');
  // every later read hides it again from the leader
  assert.equal((await leader.get(`/users/${u.id}`)).json.employeeId, '');
  assert.equal(((await leader.get(`/users?teamId=${fx().teams.a}`)).json as { id: number; employeeId: string }[]).find((x) => x.id === u.id)!.employeeId, '');
  assert.equal((await leader.get(`/users/${u.id}/performance`)).json.user.employeeId, '');
  assert.equal((await admin.get(`/users/${u.id}`)).json.employeeId, stored, 'administrators still see it');
  // the new person can sign in with those details
  const fresh = await srv.login({ email: u.email, employeeId: stored });
  assert.equal((await fresh.get('/auth/me')).json.user.employeeId, stored, 'and sees their own');
});

test('empty office-only fields from a leader are not attempts: they are ignored, not refused', async () => {
  const r = await leader.post('/users', person({ role: null, payPlanId: null, status: '', avatarColor: '', employeeId: '  ' }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.role, 'rep');
  assert.equal(r.json.status, 'active');
  assert.match(r.json.employeeId, /^LM-\d{4}$/);
});

test('a leader may name their own team, never another (403 with a sentence), and adds field reps too', async () => {
  const own = await leader.post('/users', person({ position: 'field_rep', teamId: fx().teams.a, role: 'rep', status: 'active' }));
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal(own.json.position, 'field_rep');
  const before = usersCount();
  const other = await leader.post('/users', person({ teamId: fx().teams.b }));
  assert.equal(other.status, 403);
  assert.equal(other.json.error, 'You can add people to your own team (Team A) only.');
  const none = await leader.post('/users', person({ teamId: null }));
  assert.equal(none.status, 403);
  assert.equal(usersCount(), before, 'nothing added');
});

test('escalation attempts by a leader or a recruiter are refused with 403 and a plain sentence, never ignored', async () => {
  const attempts: [Record<string, unknown>, RegExp][] = [
    [{ role: 'leader' }, /Only an administrator can make someone a leader, recruiter or administrator/],
    [{ role: 'admin' }, /Only an administrator/],
    [{ role: 'recruiter' }, /Only an administrator/],
    [{ role: 'client' }, /Only an administrator/],
    [{ position: 'team_leader' }, /You can add trainees and field representatives/],
    [{ position: 'crew_leader' }, /trainees and field representatives/],
    [{ position: 'owner' }, /trainees and field representatives/],
    [{ position: 'recruiter' }, /trainees and field representatives/],
    [{ payPlanId: fx().plans.leader }, /Only an administrator can choose a pay plan/],
    [{ status: 'left' }, /New people start as active/],
    [{ status: 'on_leave' }, /New people start as active/],
    [{ avatarColor: '#123456' }, /Only an administrator can choose an avatar colour/],
    [{ employeeId: 'LM-0999' }, /Employee IDs are given automatically/],
  ];
  const before = usersCount();
  for (const [who, client, team] of [['leader', leader, fx().teams.a], ['recruiter', recruiter, fx().teams.b]] as const) {
    for (const [extra, message] of attempts) {
      const r = await client.post('/users', person({ teamId: team, ...extra }));
      assert.equal(r.status, 403, `${who} ${JSON.stringify(extra)} → ${r.status} ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, message);
    }
  }
  assert.equal(usersCount(), before, 'none of them added anyone');
});

test('a recruiter adds to any team, but must choose one', async () => {
  const b = await recruiter.post('/users', person({ teamId: fx().teams.b, position: 'field_rep' }));
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.equal(b.json.teamId, fx().teams.b);
  assert.equal(b.json.role, 'rep');
  assert.match(b.json.employeeId, /^LM-\d{4}$/);
  assert.equal((await recruiter.get(`/users/${b.json.id}`)).json.employeeId, '', 'hidden from the recruiter afterwards');
  const none = await recruiter.post('/users', person());
  assert.equal(none.status, 400);
  assert.equal(none.json.error, 'Choose a team for them.');
  const unknown = await recruiter.post('/users', person({ teamId: 99999, email: `unknown.team${n}@linear-mcr.co.uk` }));
  assert.equal(unknown.status, 400);
});

test('reps, clients and anonymous callers cannot add anyone; PATCH and the 2FA reset stay admin only', async () => {
  const client = await srv.login('client');
  const before = usersCount();
  assert.equal((await rep.post('/users', person({ teamId: fx().teams.a }))).status, 403);
  assert.equal((await client.post('/users', person())).status, 403);
  assert.equal((await srv.anon().post('/users', person())).status, 401);
  assert.equal(usersCount(), before);
  const target = fx().users.repA2;
  assert.equal((await leader.patch(`/users/${target}`, { phone: '07700 900111' })).status, 403);
  assert.equal((await recruiter.patch(`/users/${target}`, { phone: '07700 900111' })).status, 403);
  assert.equal((await leader.post(`/users/${target}/2fa/reset`, {})).status, 403);
});

test('a leader without a team cannot add people', async () => {
  const id = fx().users.leader;
  run(srv.db, `UPDATE users SET team_id = NULL WHERE id = ?`, [id]);
  try {
    const teamless = await srv.login('leader');
    const r = await teamless.post('/users', person());
    assert.equal(r.status, 403);
    assert.match(r.json.error, /not on a team yet/);
  } finally {
    run(srv.db, `UPDATE users SET team_id = ? WHERE id = ?`, [fx().teams.a, id]);
  }
});

test('validation and duplicates: a last name is still required for new people; a used email is 409', async () => {
  const noLast = await leader.post('/users', person({ lastName: '' }));
  assert.equal(noLast.status, 400);
  assert.equal((await admin.post('/users', { ...person({ lastName: ' ' }), role: 'rep', teamId: fx().teams.a })).status, 400);
  const first = await leader.post('/users', person());
  assert.equal(first.status, 201);
  const dup = await leader.post('/users', { ...person(), email: first.json.email.toUpperCase() });
  assert.equal(dup.status, 409);
  assert.equal((await leader.post('/users', person({ email: 'not-an-email' }))).status, 400);
});

test('an administrator: as before, and the employee ID is now optional (the next one is given)', async () => {
  const chosen = await admin.post('/users', { ...person(), employeeId: `LM-09${String(n).padStart(2, '0')}`, role: 'leader', position: 'team_leader', teamId: fx().teams.b, payPlanId: fx().plans.leader, avatarColor: '#0E7490' });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.json));
  assert.equal(chosen.json.role, 'leader');
  assert.equal(chosen.json.avatarColor, '#0E7490');
  assert.equal(chosen.json.employeeId, `LM-09${String(n).padStart(2, '0')}`);
  const auto = await admin.post('/users', { ...person({ email: `auto${n}@linear-mcr.co.uk` }), role: 'rep', teamId: null });
  assert.equal(auto.status, 201, JSON.stringify(auto.json));
  const max = Number(get<{ m: number }>(srv.db, `SELECT MAX(CAST(substr(employee_id, 4) AS INTEGER)) AS m FROM users WHERE employee_id LIKE 'LM-%' AND id <> ?`, [auto.json.id])!.m);
  assert.equal(auto.json.employeeId, `LM-${String(max + 1).padStart(4, '0')}`);
  assert.equal(auto.json.teamId, null, 'an administrator may still add someone with no team');
  assert.equal((await admin.post('/users', { ...person({ email: `norole${n}@linear-mcr.co.uk` }) })).status, 400, 'an administrator still chooses the role');
});

test('the sign-in instructions add the PIN step while the office requires a PIN for everyone', async () => {
  // the leader has a PIN, so the "create your PIN" gate lets their session through while a PIN is required
  savePinHash(srv.db, fx().users.leader, await hashPin('2580'));
  writeSecuritySettings(srv.db, { requirePin: true });
  try {
    const r = await leader.post('/users', person());
    assert.equal(r.status, 201);
    assert.match(r.json.signInInstructions, /3\. The first time, create a PIN of 4 to 6 digits\./);
    assert.match(r.json.signInInstructions, /1\. Open the Linear Hub sign-in page\./, 'no address given: the plain wording');
  } finally {
    writeSecuritySettings(srv.db, { requirePin: false });
    clearPin(srv.db, fx().users.leader);
  }
  assert.equal((await leader.post('/users', person({ signInUrl: 'javascript:alert(1)' }))).status, 400, 'only an http(s) address');
});

test('audit: the row names the leader who added them and reads well; the trail stays admin only', async () => {
  const r = await leader.post('/users', person({ firstName: 'Alex', lastName: 'Audit' }));
  assert.equal(r.status, 201);
  const row = get<{ userId: number; summary: string; action: string; after: string }>(
    srv.db,
    `SELECT user_id AS userId, summary, action, after_json AS after FROM audit_log WHERE entity = 'user' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [r.json.id],
  )!;
  assert.ok(row, 'one audit row');
  assert.equal(row.userId, fx().users.leader, 'the actor is the leader');
  assert.equal(row.action, 'POST /users');
  assert.equal(row.summary, 'Added Alex Audit: Representative, Trainee, Team A');
  const after = JSON.parse(row.after) as Record<string, unknown>;
  assert.equal(after.name, 'Alex Audit');
  assert.ok(!('signInInstructions' in after) && !JSON.stringify(after).includes('Hello'), 'the instructions are not stored');
  for (const k of Object.keys(after)) assert.doesNotMatch(k, /pin_hash|secret|token|password/i);
  assert.equal((await leader.get('/audit')).status, 403);
  assert.equal((await leader.get(`/audit/user/${r.json.id}`)).status, 403);
  assert.equal((await admin.get(`/audit/user/${r.json.id}`)).status, 200);
});

test('POST /users counts towards the per-person write limit', () => {
  assert.equal(isWriteLimited('POST', '/users'), true);
  assert.equal(isWriteLimited('POST', '/USERS'), true);
  assert.equal(isWriteLimited('GET', '/users'), false);
  assert.equal(isWriteLimited('PATCH', '/users/3'), false);
});

test('POST /users over the limit: 429 with the sentence, nothing added', async () => {
  const limited = await startTestServer();
  const http = await import('node:http');
  const { createApp } = await import('../app.ts');
  // a second app on the same database with a limit of 2 writes a minute
  const server = http.createServer(createApp(limited.db, { writeLimitPerMinute: 2 }));
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const { TestClient } = await import('./helpers.ts');
    const c = new TestClient(`http://127.0.0.1:${port}/api`);
    assert.equal((await c.post('/auth/login', { email: 'lee.leader@fixture.test', employeeId: 'FX-0002' })).status, 200);
    const add = (i: number) => c.post('/users', { firstName: 'Lim', lastName: `It${i}`, email: `lim.it${i}@linear-mcr.co.uk`, position: 'trainee' });
    assert.equal((await add(1)).status, 201);
    assert.equal((await add(2)).status, 201);
    const third = await add(3);
    assert.equal(third.status, 429);
    assert.match(third.json.error, /more than 60 changes in a minute|Wait a minute/);
    assert.equal(get(limited.db, `SELECT 1 FROM users WHERE email = 'lim.it3@linear-mcr.co.uk'`), undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await limited.close();
  }
});
