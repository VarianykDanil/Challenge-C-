/**
 * Release 1.3 foundation contract (r3-foundation): the database extensions, the client role and its guard, the demo
 * client account, the route table, the audit spec registry, the attention providers and the mounting of every 1.3
 * router. Written to keep holding once P1–P9 replace the stubs: it checks shapes and rules, never stub answers.
 * Owned by the foundation; packages test their own behaviour in their own files.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.ts';
import { EXTENSIONS, upgradeExtensions } from '../db/extensions/index.ts';
import { columnsOf } from '../db/extensions/types.ts';
import { createSchema, SCHEMA_SQL, upgradeSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { createApp } from '../app.ts';
import { AUDIT_ROUTES } from '../lib/auditSpecs.ts';
import { allAuditSpecs, matchAuditSpec } from '../lib/audit/registry.ts';
import { ATTENTION_PROVIDERS, withProviderItems } from '../lib/attention/index.ts';
import { listApiRoutes } from '../lib/routeTable.ts';
import { clientMayCall } from '../middleware/clientGuard.ts';
import {
  CLIENT_HIDDEN_USER_FIELDS, DEMO_CLIENT_ACCESS_CODES, DEMO_CLIENTS_META_KEY, demoClientMarkers, isDemoClientAccount, nextClientAccessCode,
} from '../lib/client.ts';
import { CLIENT_ACCOUNTS } from '../db/seed-data.ts';
import { setBusinessClock, todayISO } from '../lib/dates.ts';
import { addClientUser, addClientUserWithPin, FIXTURE_ACCOUNTS, startTestServer, type TestClient, type TestServer } from './helpers.ts';

const R2_EXTENSIONS = ['learning', 'pitches', 'pin', 'audit', 'checkins'];
const R3_EXTENSIONS = ['pay', 'invoices', 'statements', 'videos', 'client', 'recruitment', 'venues'];

/** The tables and core-table columns the 1.3 extensions lay down (STABLE: owners may add, never rename or drop). */
const R3_TABLES = [
  'campaign_rates', 'pay_adjustments', 'sale_confirmations', // P1
  'self_billing_agreements', 'invoices', // P2
  'campaign_statement_senders', 'statement_templates', 'statements', 'statement_rows', 'user_client_refs', // P3
  'learning_videos', 'video_views', // P5
  'client_posts', // P6
  'interview_questions', 'interview_answers', 'interview_changes', // P7
  'event_roster', // P8
];
const R3_CORE_COLUMNS: Record<string, string[]> = {
  payroll_runs: ['paid_as', 'sales_logged', 'sales_confirmed', 'sales_cancelled', 'adjustments_total'], // P1
  users: ['address_line1', 'address_line2', 'address_town', 'postcode', 'utr', 'vat_number', 'client_campaign_id'], // P2, P6
  campaigns: ['long_description', 'brief', 'contact_name', 'contact_email', 'contact_phone'], // P6
  candidates: ['date_of_birth'], // P7
};

test('extensions: the 1.2 five, then the seven 1.3 ones in package order, unique names, the DbExtension shape', () => {
  assert.deepEqual(EXTENSIONS.map((e) => e.name), [...R2_EXTENSIONS, ...R3_EXTENSIONS]);
  assert.equal(new Set(EXTENSIONS.map((e) => e.name)).size, EXTENSIONS.length);
  for (const e of EXTENSIONS) {
    assert.equal(typeof e.sql, 'string', `${e.name}.sql`);
    assert.equal(typeof e.upgrade, 'function', `${e.name}.upgrade`);
  }
});

test('a fresh schema has every 1.3 table and core-table column; a second createSchema changes nothing', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    for (const t of R3_TABLES) assert.ok(columnsOf(db, t).length > 0, `table ${t}`);
    for (const [t, cols] of Object.entries(R3_CORE_COLUMNS)) for (const c of cols) assert.ok(columnsOf(db, t).includes(c), `${t}.${c}`);
    assert.deepEqual(createSchema(db), [], 'idempotent');
    assert.deepEqual(upgradeExtensions(db), [], 'extension upgrades are idempotent');
  } finally {
    db.close();
  }
});

test('a 1.2 database upgrades cleanly: new tables and columns appear, every row is kept, changes are reported once', () => {
  const db = openDb(':memory:');
  try {
    // The 1.2 shape: the core schema and the five 1.2 extensions only.
    db.exec(SCHEMA_SQL);
    upgradeSchema(db);
    for (const e of EXTENSIONS.filter((x) => R2_EXTENSIONS.includes(x.name))) {
      if (e.sql.trim()) db.exec(e.sql);
      e.upgrade(db);
    }
    db.exec(`INSERT INTO teams (name, leader_id, color) VALUES ('Old team', NULL, '#2563EB')`);
    db.exec(`INSERT INTO pay_plans (name, position, base_per_day) VALUES ('Old plan', 'field_rep', 60)`);
    db.exec(`INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, avatar_color)
             VALUES ('LM-0001', 'old@example.test', 'Old', 'Person', 'rep', 'field_rep', 1, 1, '2025-01-06', '#4F46E5')`);
    db.exec(`INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, start_date)
             VALUES ('Old charity', 'OLD', 'charity', 'fundraising', 100, 40, '#DB2777', '2025-01-06')`);
    db.exec(`INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, base_pay, commission, gross, due_date, paid_date, status, reference)
             VALUES (1, '2026-10-05', '2026-10-11', 4, 10, 240, 400, 640, '2026-10-16', '2026-10-16', 'paid', 'PAY-202641-LM-0001')`);
    db.exec(`INSERT INTO candidates (first_name, last_name, email, applied_at, stage_updated_at) VALUES ('Cand', 'Idate', 'c@example.test', '2026-10-01', '2026-10-01')`);
    const before = db.prepare(`SELECT * FROM payroll_runs`).all();
    const changed = createSchema(db);
    for (const name of changed) assert.ok(R3_EXTENSIONS.includes(name.split(':')[0]!), `only 1.3 extensions report: ${name}`);
    for (const [t, cols] of Object.entries(R3_CORE_COLUMNS)) for (const c of cols) assert.ok(changed.some((n) => n.endsWith(`:${t}.${c}`)), `reported ${t}.${c}`);
    for (const t of R3_TABLES) assert.ok(columnsOf(db, t).length > 0, `table ${t}`);
    const afterRows = db.prepare(`SELECT id, user_id, week_start, gross, status, reference, paid_as FROM payroll_runs`).all() as Record<string, unknown>[];
    assert.equal(afterRows.length, before.length, 'payroll rows kept');
    assert.equal(afterRows[0]!.gross, 640);
    assert.equal(afterRows[0]!.paid_as, null, 'new columns start empty');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n, 1);
    assert.deepEqual(createSchema(db), [], 'the second start upgrades nothing');
  } finally {
    db.close();
  }
});

test('the demo seed adds exactly one client account (Hannah Price, BCN, CL-0001), counted in stats.users', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    const stats = seed(db, todayISO());
    const clients = db.prepare(`SELECT u.employee_id AS code, u.email, u.first_name AS firstName, u.last_name AS lastName, u.role, u.position,
                                       u.team_id AS teamId, u.status, c.code AS campaign, u.pin_hash AS pin
                                FROM users u LEFT JOIN campaigns c ON c.id = u.client_campaign_id WHERE u.role = 'client'`).all().map((r) => ({ ...r }));
    assert.deepEqual(clients, [{
      code: 'CL-0001', email: 'hannah.price@breastcancernow.example', firstName: 'Hannah', lastName: 'Price', role: 'client',
      position: 'client', teamId: null, status: 'active', campaign: 'BCN', pin: null,
    }]);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n, stats.users);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM payroll_runs p JOIN users u ON u.id = p.user_id WHERE u.role = 'client'`).get() as { n: number }).n, 0, 'never paid');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE u.role = 'client'`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role <> 'client' AND client_campaign_id IS NOT NULL`).get() as { n: number }).n, 0);
    // The marker that makes her THE demo client (and nobody else): written by the core seed only.
    const hannah = db.prepare(`SELECT id, role, email, employee_id AS employeeId FROM users WHERE role = 'client'`).get() as { id: number; role: 'client'; email: string; employeeId: string };
    assert.deepEqual(demoClientMarkers(db), [{ id: hannah.id, employeeId: 'CL-0001', email: 'hannah.price@breastcancernow.example' }]);
    assert.equal(isDemoClientAccount(db, hannah), true);
    const owner = db.prepare(`SELECT id, role, email, employee_id AS employeeId FROM users WHERE employee_id = 'LM-0001'`).get() as typeof hannah;
    assert.equal(isDemoClientAccount(db, owner), false, 'staff are never the demo client');
    assert.equal(isDemoClientAccount(db, { ...hannah, email: 'someone.else@breastcancernow.example' }), false, 'an edited email is no longer the demo');
    assert.equal(isDemoClientAccount(db, { ...hannah, employeeId: 'CL-0009' }), false, 'nor an edited access code');
    const invited = addClientUser(db, { campaignId: Number(hannah.id && (db.prepare(`SELECT id FROM campaigns WHERE code = 'CHN'`).get() as { id: number }).id), email: 'contact@chn.example' });
    const invitedRow = db.prepare(`SELECT id, role, email, employee_id AS employeeId FROM users WHERE id = ?`).get(invited) as typeof hannah;
    assert.equal(invitedRow.employeeId, 'CL-0002');
    assert.equal(isDemoClientAccount(db, invitedRow), false, 'an invited client is never the demo client');
  } finally {
    db.close();
  }
});

test('access codes: the demo codes are the seed\'s, and nextClientAccessCode never hands one out (even with no demo client)', () => {
  assert.deepEqual([...DEMO_CLIENT_ACCESS_CODES].sort(), CLIENT_ACCOUNTS.map((c) => c.code).sort(), 'lib/client.ts and seed-data.ts agree');
  const db = openDb(':memory:');
  try {
    createSchema(db); // an upgraded or empty database: no client, no demo marker
    assert.deepEqual(demoClientMarkers(db), []);
    assert.equal(nextClientAccessCode(db), 'CL-0002', 'the first real client is CL-0002, never the demo CL-0001');
    db.exec(`INSERT INTO meta (key, value) VALUES ('${DEMO_CLIENTS_META_KEY}', 'not json')`);
    assert.deepEqual(demoClientMarkers(db), [], 'an unreadable marker means no demo client');
  } finally {
    db.close();
  }
});

/** Every column of each core table (what the core schema alone creates), keyed `table.column`, after `exts` ran. */
function coreTableColumns(db: ReturnType<typeof openDb>, tables: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tables) for (const c of columnsOf(db, t)) out.add(`${t}.${c}`);
  return out;
}

test('each 1.3 extension seed, run after the extensions before it, writes only its own columns of core tables', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T15:00:00') });
  setBusinessClock(null);
  const today = todayISO();
  // Which core-table columns each extension adds (applied in the fixed order on the core schema).
  const shape = openDb(':memory:');
  const own = new Map<string, Set<string>>();
  let tables: string[];
  try {
    shape.exec(SCHEMA_SQL);
    upgradeSchema(shape);
    tables = (shape.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    for (const e of EXTENSIONS) {
      const before = coreTableColumns(shape, tables);
      if (e.sql.trim()) shape.exec(e.sql);
      e.upgrade(shape);
      own.set(e.name, new Set([...coreTableColumns(shape, tables)].filter((c) => !before.has(c))));
    }
  } finally {
    shape.close();
  }
  assert.ok(own.get('client')!.has('users.client_campaign_id') && own.get('pin')!.has('users.pin_hash'), 'columns attributed to their extension');
  /** Every core row (meta without `ext:%` keys) of a demo seed that ran only `only` of the extension seeds. */
  const rowsAfter = (only: string[]) => {
    const db = openDb(':memory:');
    try {
      createSchema(db);
      seed(db, today, { onlyExtensions: only });
      return new Map(tables.map((tbl) => [tbl, db.prepare(`SELECT * FROM ${tbl}${tbl === 'meta' ? ` WHERE key NOT LIKE 'ext:%'` : ''}`).all() as Record<string, unknown>[]]));
    } finally {
      db.close();
    }
  };
  const clientIds = (rows: Map<string, Record<string, unknown>[]>) => new Set(rows.get('users')!.filter((u) => u.role === 'client').map((u) => u.id));
  /** Sorted JSON rows of one table without `ext`'s own columns (and, for P6, without client-authored announcements). */
  const view = (rows: Map<string, Record<string, unknown>[]>, tbl: string, ext: string) => {
    const skip = own.get(ext)!;
    const clients = clientIds(rows);
    return rows.get(tbl)!
      .filter((r) => !(ext === 'client' && tbl === 'announcements' && clients.has(r.author_id)))
      .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([c]) => !skip.has(`${tbl}.${c}`)))))
      .sort();
  };
  let prev = rowsAfter(R2_EXTENSIONS);
  for (let i = 0; i < R3_EXTENSIONS.length; i++) {
    const name = R3_EXTENSIONS[i]!;
    const next = rowsAfter([...R2_EXTENSIONS, ...R3_EXTENSIONS.slice(0, i + 1)]);
    for (const tbl of tables) assert.deepEqual(view(next, tbl, name), view(prev, tbl, name), `the ${name} seed changed core table ${tbl} outside its own columns`);
    prev = next;
  }
});

test('client guard: the portal paths a client may call, and nothing else', () => {
  for (const p of ['/health', '/auth/me', '/auth/logout', '/auth/login', '/auth/login/2fa', '/auth/demo-accounts', '/auth/pin', '/auth/pin/remove', '/client', '/client/portal', '/client/posts/', '/AUTH/ME']) {
    assert.ok(clientMayCall(p), p);
  }
  for (const p of ['/client-posts', '/client-accounts/1', '/clientx', '/auth/2fa', '/auth/security-settings', '/me/dashboard', '/users', '/', '/finance/me', '/audit/events']) {
    assert.ok(!clientMayCall(p), p);
  }
});

test('audit registry: package specs first, every 1.2 spec kept, POST /audit/events skipped while it is a stub', () => {
  const all = allAuditSpecs();
  for (const spec of AUDIT_ROUTES) assert.ok(all.includes(spec), `${spec.method} ${spec.pattern}`);
  assert.equal(matchAuditSpec('POST', '/audit/events')?.spec.skip, true);
  assert.equal(matchAuditSpec('POST', '/finance/payroll/12/pay')?.spec.pattern, '/finance/payroll/:id/pay');
  assert.deepEqual(matchAuditSpec('POST', '/finance/payroll/12/pay')?.params, { id: '12' });
  assert.equal(matchAuditSpec('GET', '/finance/payroll/12'), null);
});

test('attention providers: three, and with no extra items the 1.1 feed passes through unchanged', () => {
  assert.deepEqual(ATTENTION_PROVIDERS.map((p) => p.name), ['invoices', 'statements', 'client-posts']);
  const core = [{ key: 'a', kind: 'pay' as const, severity: 'info' as const, title: 't', body: 'b', href: '/' }];
  assert.equal(withProviderItems(core, []), core);
  const merged = withProviderItems(core, [{ key: 'client:post:1', kind: 'client', severity: 'warning', title: 'New update', body: 'b', href: '/campaigns/1' }]);
  assert.deepEqual(merged.map((i) => i.key), ['client:post:1', 'a'], 'sorted by severity like every item');
});

// ───────────────────────────── routes (fixture) ─────────────────────────────

let srv: TestServer;
let admin: TestClient;
let rep: TestClient;
let client: TestClient;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
  rep = await srv.login('rep');
  client = await srv.login('client');
});
after(async () => {
  await srv.close();
});

const fx = () => srv.fixture!;

/** Every 1.3 path that must be mounted behind requireAuth: [method, path]. */
const R3_ROUTES = (): [string, string][] => [
  ['GET', '/pay/settings'], ['PUT', '/pay/settings'], ['GET', '/pay/rates'], ['POST', '/pay/rates'],
  ['GET', `/pay/breakdown?userId=${fx().users.rep}&weekStart=2026-10-05`], ['GET', '/pay/adjustments'],
  ['POST', '/pay/bonuses'], ['POST', '/pay/adjustments'], ['DELETE', '/pay/adjustments/1'],
  ['GET', '/invoices'], ['GET', '/invoices/agreement'], ['POST', '/invoices/agreement/accept'], ['GET', '/invoices/profile'],
  ['GET', '/invoices/company'], ['GET', '/invoices/disputes'], ['GET', '/invoices/by-run/1'], ['GET', '/invoices/1'],
  ['POST', '/invoices/1/accept'], ['POST', '/invoices/1/dispute'], ['POST', '/invoices/1/resolve'],
  ['GET', '/statements'], ['GET', '/statements/mail'], ['PUT', '/statements/mail'], ['POST', '/statements/mail/test'],
  ['GET', '/statements/senders'], ['GET', '/statements/client-refs'], ['POST', '/statements/check-now'],
  ['POST', '/statements/upload'], ['GET', '/statements/1'], ['POST', '/statements/1/apply'],
  ['GET', '/videos'], ['GET', '/videos/settings'], ['GET', '/videos/team'], ['POST', '/videos'], ['GET', '/videos/1'],
  ['GET', '/videos/1/stream'], ['POST', '/videos/1/progress'],
  ['GET', '/client-posts'], ['GET', '/client-posts/unread'], ['POST', '/client-posts/1/approve'],
  ['PATCH', '/client-accounts/1'], ['GET', `/campaigns/${fx().campaignId}/page`], ['GET', `/campaigns/${fx().campaignId}/client-accounts`],
  ['POST', `/campaigns/${fx().campaignId}/client-accounts`],
  ['GET', '/recruitment/schedule'], ['GET', '/recruitment/candidates/1/timeline'], ['GET', '/recruitment/questions'],
  ['POST', '/recruitment/questions'], ['GET', '/recruitment/interviews/1/sheet'], ['PUT', '/recruitment/interviews/1/answers'],
  ['GET', '/venues'], ['GET', '/venues/golden-square--manchester'],
  ['GET', `/events/${fx().events.todayA}/plan`], ['GET', `/events/${fx().events.todayA}/roster`], ['PUT', `/events/${fx().events.todayA}/roster`],
  ['POST', `/events/${fx().events.todayA}/roster/me`],
  ['POST', '/audit/events'],
];

test('1.3 routes: anonymous → 401 on every new path', async () => {
  const anon = srv.anon();
  for (const [method, path] of R3_ROUTES()) {
    const r = await anon.req(method, path, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${path}`);
  }
  assert.equal((await anon.get('/client/portal')).status, 401);
});

test('1.3 routes: mounted for a signed-in admin (never the JSON 404 of an unknown path, never a 5xx except 501 stubs)', async () => {
  for (const [method, path] of R3_ROUTES()) {
    const r = await admin.req(method, path, method === 'GET' ? undefined : {});
    assert.ok(r.status < 500 || r.status === 501, `${method} ${path} → ${r.status}`);
    if (r.status === 404) assert.notEqual(r.json?.error, 'Not found', `${method} ${path} is not mounted`);
  }
});

test('role checks of the 1.3 stubs, and /client never swallows /client-posts or /client-accounts', async () => {
  assert.equal((await admin.get('/client-posts')).status, 200);
  assert.deepEqual((await admin.get('/client-posts/unread')).json, { count: 0 });
  assert.equal((await rep.get('/client-posts')).status, 403);
  assert.equal((await rep.patch('/client-accounts/1', {})).status, 403);
  // P6 fills the stub: user 1 is a staff member, so it is not a client account (404), never a 403 or a 5xx.
  const notClient = await admin.patch('/client-accounts/1', {});
  assert.ok(notClient.status === 501 || (notClient.status === 404 && notClient.json?.error === 'Client account not found'), `PATCH /client-accounts/1 → ${notClient.status}`);
  assert.equal((await rep.get('/statements')).status, 403);
  assert.equal((await rep.get('/pay/settings')).status, 403);
  assert.equal((await rep.get('/invoices/disputes')).status, 403);
  assert.equal((await rep.get('/videos/team')).status, 403);
  assert.equal((await rep.get('/recruitment/schedule')).status, 403);
  assert.equal((await rep.get(`/campaigns/${fx().campaignId}/client-accounts`)).status, 403);
  assert.equal((await rep.get('/venues')).status, 200);
  assert.equal((await rep.get('/venues/not a key')).status, 400);
  assert.equal((await rep.post('/audit/events', { kind: 'export', what: 'test' })).status, 204);
});

test('statement upload contract: a raw PDF body over 1 MB reaches P3\'s route through every middleware', async () => {
  const upload = (cookie: string) =>
    fetch(`${srv.base}/statements/upload?fileName=${encodeURIComponent('BCN statement.pdf')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', cookie },
      body: new Uint8Array(1_500_000),
    });
  // the stub answered 501; P3's route reads the whole body and answers 422 for bytes that are not a PDF. Either way the
  // 1.5 MB body got past express.json (no 413) to the route.
  const res = await upload(admin.cookie);
  const body = res.status === 501 ? null : ((await res.json()) as { error?: string });
  assert.ok(res.status === 501 || (res.status === 422 && /not a PDF/.test(body?.error ?? '')), `POST /statements/upload → ${res.status} ${JSON.stringify(body)}`);
  assert.equal((await upload(rep.cookie)).status, 403);
});

test('the routers mounted before a 1.0 router leave its paths alone', async () => {
  assert.equal((await admin.get('/campaigns')).status, 200);
  assert.equal((await admin.get(`/events/${fx().events.todayA}`)).status, 200);
  const forecast = await admin.get('/events/forecast');
  assert.ok(forecast.status !== 404 && forecast.status < 500, `GET /events/forecast → ${forecast.status}`);
  assert.equal((await admin.get('/recruitment/candidates')).status, 200);
  assert.equal((await rep.get('/recruitment/candidates')).status, 403, 'the 1.0 recruitment role check still applies');
  assert.equal((await admin.get('/audit')).status, 200);
});

test('route table: every mounted route is listed with its full path', () => {
  const routes = listApiRoutes(createApp(srv.db));
  const has = (m: string, p: string) => routes.some((r) => r.method === m && r.path === p);
  assert.ok(has('POST', '/finance/payroll/:id/pay'));
  assert.ok(has('GET', '/auth/me'));
  assert.ok(has('GET', '/client/portal'));
  assert.ok(has('GET', '/campaigns/:id/page'));
  assert.ok(has('POST', '/audit/events'));
  assert.ok(has('GET', '/venues/:key'));
  assert.ok(routes.length > 150, `${routes.length} routes`);
});

test('client session: /auth/me carries the campaign; the portal answers; staff get 403 there', async () => {
  const me = await client.get('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'client');
  assert.equal(me.json.user.clientCampaignId, fx().campaignId);
  const portal = await client.get('/client/portal');
  assert.equal(portal.status, 200);
  assert.equal(portal.json.campaign.id, fx().campaignId);
  assert.equal(portal.json.campaign.code, 'FXC');
  assert.deepEqual(Object.keys(portal.json).sort(), ['campaign', 'me', 'posts']);
  assert.equal((await client.get('/health')).status, 200);
  assert.equal((await client.get('/auth/pin')).status, 200, 'their own PIN status');
  assert.equal((await admin.get('/client/portal')).status, 403);
  assert.equal((await rep.get('/client/portal')).status, 403);
  const staffMe = await admin.get('/auth/me');
  assert.ok(!('clientCampaignId' in staffMe.json.user), 'staff sessions carry no client campaign');
  // A client sees nothing of the office: not the pay plan its account is attached to, not team fields.
  for (const k of CLIENT_HIDDEN_USER_FIELDS) {
    assert.ok(!(k in me.json.user), `client /auth/me has no ${k}`);
    assert.ok(k in staffMe.json.user, `staff /auth/me keeps ${k}`);
  }
  assert.deepEqual(CLIENT_HIDDEN_USER_FIELDS, ['teamId', 'teamName', 'payPlanId', 'payPlanName']);
});

test('client sign-in: the fixture client has a PIN; the response carries the campaign and no office fields', async () => {
  const anon = srv.anon();
  const { email, employeeId, pin } = FIXTURE_ACCOUNTS.client;
  const challenge = await anon.post('/auth/login', { email, employeeId });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.json.requiresPin, true, 'an invited client signs in with a PIN');
  assert.ok(!anon.cookie, 'no session without the PIN');
  const signedIn = await anon.post('/auth/login', { email, employeeId, pin });
  assert.equal(signedIn.status, 200);
  const user = signedIn.json.user;
  assert.equal(user.role, 'client');
  assert.equal(user.clientCampaignId, fx().campaignId);
  assert.equal(user.hasPin, true);
  assert.equal(user.pinSetupRequired, false);
  for (const k of CLIENT_HIDDEN_USER_FIELDS) assert.ok(!(k in user), `login response has no ${k}`);
  const staff = await srv.anon().post('/auth/login', FIXTURE_ACCOUNTS.rep);
  assert.equal(staff.json.user.payPlanId, fx().plans.rep, 'staff sign-in unchanged');
  assert.ok(!('clientCampaignId' in staff.json.user));
  // A client with a PIN from addClientUserWithPin signs in the same way.
  const other = { email: 'with.pin@client.test', employeeId: nextClientAccessCode(srv.db), pin: '7390' };
  await addClientUserWithPin(srv.db, { campaignId: fx().campaignId, email: other.email, employeeId: other.employeeId }, other.pin);
  assert.equal((await srv.login(other)).cookie.startsWith('lm_session='), true);
});

test('client guard: a client session gets 403 clientPortalOnly on every other route in the app', async () => {
  const routes = listApiRoutes(createApp(srv.db));
  let checked = 0;
  for (const r of routes) {
    const path = r.path.replace(/:[A-Za-z]+/g, '1');
    if (clientMayCall(path)) continue;
    const res = await client.req(r.method, path, r.method === 'GET' ? undefined : {});
    assert.equal(res.status, 403, `${r.method} ${path} → ${res.status}`);
    assert.equal(res.json?.clientPortalOnly, true, `${r.method} ${path}`);
    checked++;
  }
  assert.ok(checked > 140, `checked ${checked} routes`);
  const unknown = await client.get('/no/such/path');
  assert.equal(unknown.status, 403, 'deny by default: even an unknown path');
  // and nothing was written on the way: the fixture client's audit rows are its sign-ins only
  const rows = srv.db.prepare(`SELECT action FROM audit_log WHERE user_id = (SELECT id FROM users WHERE employee_id = ?)`).all(FIXTURE_ACCOUNTS.client.employeeId) as { action: string }[];
  assert.ok(rows.length >= 1);
  assert.deepEqual([...new Set(rows.map((r) => r.action))], ['POST /auth/login'], 'only sign-ins');
});

test('client accounts never appear in staff lists', async () => {
  const clientId = Number((srv.db.prepare(`SELECT id FROM users WHERE role = 'client'`).get() as { id: number }).id);
  const all = await admin.get('/users?status=all');
  assert.ok(!all.json.some((u: { id: number }) => u.id === clientId), 'Team list');
  assert.equal((await admin.get(`/users/${clientId}`)).status, 404);
  assert.equal((await admin.get(`/users/${clientId}/performance`)).status, 404);
  const search = await admin.get('/search?q=cleo');
  assert.ok(!search.json.results.some((r: { kind: string; id: number }) => r.kind === 'person' && r.id === clientId), 'search');
  const team = await admin.get('/learning/team');
  assert.ok(!team.json.rows.some((r: { userId: number }) => r.userId === clientId), 'learning team');
});

test('announcements: a client-authored one carries fromClient; the office ones answer as before', async () => {
  const clientId = Number((srv.db.prepare(`SELECT id FROM users WHERE role = 'client'`).get() as { id: number }).id);
  addClientUser(srv.db, { campaignId: fx().campaignId, email: 'second@client.test', status: 'left' });
  srv.db.prepare(`INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES ('From the client', 'Hello', ?, ?, 0)`).run(clientId, new Date().toISOString());
  srv.db.prepare(`INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES ('From the office', 'Hi', ?, ?, 0)`).run(fx().users.admin, new Date(Date.now() - 1000).toISOString());
  srv.resetCache();
  const list = await rep.get('/announcements');
  assert.equal(list.status, 200);
  const rows = Array.isArray(list.json) ? list.json : list.json.items;
  const fromClient = rows.find((a: { title: string }) => a.title === 'From the client');
  const fromOffice = rows.find((a: { title: string }) => a.title === 'From the office');
  assert.deepEqual(fromClient.fromClient, { campaignId: fx().campaignId, campaignCode: 'FXC', campaignName: 'Fixture Charity', campaignColor: '#DB2777' });
  assert.ok(!('fromClient' in fromOffice), 'no key on office announcements');
});

test('payroll and candidate payloads gain no keys while the 1.3 columns are empty', async () => {
  srv.db.prepare(`INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, base_pay, commission, gross, due_date, status, reference)
                  VALUES (?, '2026-01-05', '2026-01-11', 1, 1, 60, 45, 105, '2026-01-16', 'pending', 'PAY-R3-TEST')`).run(fx().users.rep);
  const runs = await admin.get('/finance/payroll?from=2026-01-01&to=2026-01-31');
  assert.equal(runs.status, 200);
  const row = runs.json.find((r: { reference: string }) => r.reference === 'PAY-R3-TEST');
  for (const k of ['paidAs', 'salesLogged', 'salesConfirmed', 'salesCancelled', 'adjustmentsTotal', 'invoice']) assert.ok(!(k in row), k);
  srv.db.prepare(`INSERT INTO candidates (first_name, last_name, email, applied_at, stage_updated_at) VALUES ('Dee', 'Obe', 'd@example.test', '2026-10-01', '2026-10-01')`).run();
  const c = await admin.get('/recruitment/candidates');
  assert.ok(c.json.every((x: Record<string, unknown>) => !('dateOfBirth' in x)), 'no dateOfBirth key until recorded');
});

test('response cache covers the 1.3 aggregating reads', async () => {
  srv.resetCache();
  const a = await admin.get('/venues');
  const b = await admin.get('/venues');
  assert.equal(a.headers.get('x-cache'), 'MISS');
  assert.equal(b.headers.get('x-cache'), 'HIT');
});

// ───────────────────────────── the demo seed ─────────────────────────────

test('demo seed: the client account signs in, is listed apart from the four staff demo accounts, and is nowhere else', async () => {
  const demo = await startTestServer({ seed: true });
  try {
    const accounts = await demo.anon().get('/auth/demo-accounts');
    assert.equal(accounts.json.accounts.length, 4, 'the four staff accounts, unchanged');
    assert.deepEqual(accounts.json.clientAccounts, [{ label: 'Hannah Price (Client)', role: 'client', email: 'hannah.price@breastcancernow.example', employeeId: 'CL-0001' }]);
    const hannah = await demo.login('client');
    const portal = await hannah.get('/client/portal');
    assert.equal(portal.json.campaign.code, 'BCN');
    assert.equal(portal.json.me.name, 'Hannah Price');
    assert.equal((await hannah.get('/me/dashboard')).status, 403);
    const owner = await demo.login('admin');
    const users = await owner.get('/users?status=all');
    assert.ok(!users.json.some((u: { role: string }) => u.role === 'client'));
    const reads = await owner.get('/announcements/reads');
    const staffActive = Number((demo.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND role <> 'client'`).get() as { n: number }).n);
    assert.ok(reads.json.length > 0);
    for (const r of reads.json) assert.ok(r.audience === staffActive || r.audience === staffActive - 1, `read receipts count staff only: ${r.audience} of ${staffActive}`);
    // Hannah's own payload: her campaign, no office fields.
    const me = await hannah.get('/auth/me');
    assert.equal(me.json.user.clientCampaignId, Number((demo.db.prepare(`SELECT id FROM campaigns WHERE code = 'BCN'`).get() as { id: number }).id));
    for (const k of CLIENT_HIDDEN_USER_FIELDS) assert.ok(!(k in me.json.user), `no ${k}`);
  } finally {
    await demo.close();
  }
});

test('demo-accounts lists a client only when the demo seed recorded it: never by access code alone', async () => {
  const demo = await startTestServer({ seed: true });
  try {
    const db = demo.db;
    const listed = async () => (await demo.anon().get('/auth/demo-accounts')).json;
    const chn = Number((db.prepare(`SELECT id FROM campaigns WHERE code = 'CHN'`).get() as { id: number }).id);
    // An invited client without a PIN is never listed, whatever its code.
    addClientUser(db, { campaignId: chn, email: 'real.person@childrenshospice.example', firstName: 'Real', lastName: 'Contact' });
    assert.deepEqual((await listed()).clientAccounts.map((a: { employeeId: string }) => a.employeeId), ['CL-0001'], 'only Hannah');
    // Hannah with a PIN, or deactivated, or with an edited email, is not listed either.
    const hannahId = Number((db.prepare(`SELECT id FROM users WHERE employee_id = 'CL-0001'`).get() as { id: number }).id);
    db.prepare(`UPDATE users SET email = 'h.price@breastcancernow.example' WHERE id = ?`).run(hannahId);
    assert.ok(!('clientAccounts' in (await listed())), 'an edited demo account is a real one');
    db.prepare(`UPDATE users SET email = 'hannah.price@breastcancernow.example' WHERE id = ?`).run(hannahId);
    db.prepare(`UPDATE users SET status = 'left' WHERE id = ?`).run(hannahId);
    assert.ok(!('clientAccounts' in (await listed())));
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(hannahId);
    assert.equal((await listed()).clientAccounts.length, 1);
    // An upgraded 1.2 database: the four staff demo accounts, no marker, and a PIN-less client holding CL-0001 (a real
    // contact). Nothing is listed, and the next code handed out is never a demo one.
    db.prepare(`DELETE FROM meta WHERE key = ?`).run(DEMO_CLIENTS_META_KEY);
    const upgraded = await listed();
    assert.equal(upgraded.accounts.length, 4, 'the staff demo accounts as before');
    assert.ok(!('clientAccounts' in upgraded), 'no client account without the demo seed\'s marker');
    const hannah = db.prepare(`SELECT id, role, email, employee_id AS employeeId FROM users WHERE id = ?`).get(hannahId) as { id: number; role: 'client'; email: string; employeeId: string };
    assert.equal(isDemoClientAccount(db, hannah), false, 'and no client is treated as the demo one (P6 PIN rule)');
    assert.equal(nextClientAccessCode(db), 'CL-0003');
  } finally {
    await demo.close();
  }
});
