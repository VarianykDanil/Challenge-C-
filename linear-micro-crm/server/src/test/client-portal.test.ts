/**
 * Release 1.3 — P6 client-portal: every route for every role (admin, leader, recruiter, rep, a client account and
 * anonymous), the post rules (publish, wait, double tap, daily limit), the office's decisions (approve through P1's
 * rate history, decline with a reason, unpublish), read receipts and the sidebar count, the Needs-attention items,
 * client accounts (invite, first sign-in creates the PIN, deactivate, reset PIN), the campaign page per role, the
 * campaign brief, the audit rows, and the client guard over every route in the app. Fixture data, real clock.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, businessNow, todayISO } from '../lib/dates.ts';
import { get, run } from '../db/connection.ts';
import { createApp } from '../app.ts';
import { listApiRoutes } from '../lib/routeTable.ts';
import { clientMayCall } from '../middleware/clientGuard.ts';
import { clientPostDayLabel } from '@lm/shared';
import { addClientUserWithPin, addEvent, addGauge, currentCode, FIXTURE_ACCOUNTS, startTestServer, type Json, type TestClient, type TestResponse, type TestServer } from './helpers.ts';
import { totp } from '../lib/totp.ts';

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repB: TestClient;
let client: TestClient;
let otherClient: TestClient;
let otherCampaignId: number;
let clientId: number;
/** The one-time setup code the invite below showed (Jo's first sign-in needs it). */
let joSetupCode = '';

const fx = () => srv.fixture!;
const today = () => todayISO();
const nextWeek = () => addDays(todayISO(), 7);

function is(r: TestResponse, status: number, label: string): Json {
  assert.equal(r.status, status, `${label} → ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);
  return r.json;
}

/** A client portal session is refused everywhere outside /client by the guard (403 clientPortalOnly). */
function portalOnly(r: TestResponse, label: string): void {
  is(r, 403, label);
  assert.equal(r.json?.clientPortalOnly, true, `${label}: the client guard answered`);
}

const auditRows = (where: string, params: (string | number)[] = []) =>
  srv.db.prepare(`SELECT user_id AS userId, action, entity, entity_id AS entityId, summary, before_json AS beforeJson, after_json AS afterJson FROM audit_log WHERE ${where} ORDER BY id`).all(...params) as {
    userId: number | null; action: string; entity: string | null; entityId: number | null; summary: string; beforeJson: string | null; afterJson: string | null;
  }[];

const attentionKeys = async (c: TestClient) => {
  srv.resetCache();
  const r = await c.get('/me/attention');
  return (r.json.items as { key: string; severity: string; kind: string; title: string; href: string }[]).filter((i) => i.kind === 'client');
};

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
  leader = await srv.login('leader');
  recruiter = await srv.login('recruiter');
  rep = await srv.login('rep');
  repB = await srv.login('repB');
  client = await srv.login('client', FIXTURE_ACCOUNTS.client.pin);
  clientId = Number(get<{ id: number }>(srv.db, `SELECT id FROM users WHERE employee_id = ?`, [FIXTURE_ACCOUNTS.client.employeeId])!.id);
  // A second campaign with a client of its own: nothing of it may ever reach the fixture client.
  otherCampaignId = run(
    srv.db,
    `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
     VALUES ('Other Charity', 'OTH', 'charity', 'fundraising', 100, 30, '#0EA5E9', 1, '2025-01-06', NULL)`,
  ).lastInsertRowid;
  const other = { email: 'olly.other@client.test', employeeId: 'CL-0050', pin: '7391' };
  await addClientUserWithPin(srv.db, { campaignId: otherCampaignId, email: other.email, employeeId: other.employeeId, firstName: 'Olly', lastName: 'Other' }, other.pin);
  otherClient = await srv.login(other);
});

after(async () => {
  await srv.close();
});

// ───────────────────────────── roles ─────────────────────────────

test('role matrix: the portal is the client’s alone; the office routes are admin (and leader where they read)', async () => {
  const anon = srv.anon();
  const staff = { admin, leader, recruiter, rep };
  const cid = fx().campaignId;
  // the portal
  for (const path of ['/client/portal', '/client/posts']) {
    is(await anon.get(path), 401, `anon GET ${path}`);
    is(await client.get(path), 200, `client GET ${path}`);
    for (const [role, c] of Object.entries(staff)) is(await c.get(path), 403, `${role} GET ${path}`);
  }
  is(await anon.post('/client/posts', {}), 401, 'anon POST /client/posts');
  for (const [role, c] of Object.entries(staff)) is(await c.post('/client/posts', { kind: 'update', title: 't', body: 'b' }), 403, `${role} POST /client/posts`);
  // the office's lists (admin, leader)
  for (const path of ['/client-posts', '/client-posts/unread']) {
    is(await anon.get(path), 401, `anon GET ${path}`);
    portalOnly(await client.get(path), `client GET ${path}`);
    is(await admin.get(path), 200, `admin GET ${path}`);
    is(await leader.get(path), 200, `leader GET ${path}`);
    is(await recruiter.get(path), 403, `recruiter GET ${path}`);
    is(await rep.get(path), 403, `rep GET ${path}`);
  }
  // decisions and accounts (admin only); a leader may mark read
  const writes: [string, string][] = [
    ['POST', '/client-posts/999999/approve'], ['POST', '/client-posts/999999/decline'], ['POST', '/client-posts/999999/unpublish'],
    ['PATCH', `/client-accounts/${clientId}`], ['POST', `/client-accounts/${clientId}/reset-pin`],
    ['GET', `/campaigns/${cid}/client-accounts`], ['POST', `/campaigns/${cid}/client-accounts`],
  ];
  for (const [method, path] of writes) {
    const body = method === 'GET' ? undefined : {};
    is(await anon.req(method, path, body), 401, `anon ${method} ${path}`);
    portalOnly(await client.req(method, path, body), `client ${method} ${path}`);
    is(await leader.req(method, path, body), 403, `leader ${method} ${path}`);
    is(await recruiter.req(method, path, body), 403, `recruiter ${method} ${path}`);
    is(await rep.req(method, path, body), 403, `rep ${method} ${path}`);
  }
  is(await anon.post('/client-posts/999999/read'), 401, 'anon read');
  portalOnly(await client.post('/client-posts/999999/read'), 'client read');
  is(await rep.post('/client-posts/999999/read'), 403, 'rep read');
  is(await recruiter.post('/client-posts/999999/read'), 403, 'recruiter read');
  is(await leader.post('/client-posts/999999/read'), 404, 'leader read of an unknown post');
  is(await admin.post('/client-posts/999999/approve'), 404, 'admin approve of an unknown post');
  // the campaign page (every staff role), never a client
  is(await anon.get(`/campaigns/${cid}/page`), 401, 'anon page');
  portalOnly(await client.get(`/campaigns/${cid}/page`), 'client page');
  for (const [role, c] of Object.entries(staff)) is(await c.get(`/campaigns/${cid}/page`), 200, `${role} page`);
  is(await admin.get('/campaigns/999999/page'), 404, 'unknown campaign');
  is(await admin.get('/campaigns/999999/client-accounts'), 404, 'unknown campaign accounts');
});

// ───────────────────────────── posting ─────────────────────────────

let updateId: number;
let commissionId: number;

test('an update publishes straight to Announcements with the badge; the portal lists it; staff see fromClient', async () => {
  const posted = is(await client.post('/client/posts', { kind: 'update', title: '  New leaflets  ', body: 'The winter leaflets arrive on Monday.' }), 201, 'post an update');
  updateId = posted.id;
  assert.equal(posted.status, 'published');
  assert.equal(posted.title, 'New leaflets', 'trimmed');
  assert.equal(posted.campaignId, fx().campaignId);
  assert.equal(posted.authorName, 'Cleo Client');
  assert.ok(posted.announcementId > 0);
  assert.equal(posted.decidedBy, null);
  assert.ok(!('decidedByName' in posted) && !('unread' in posted), 'the client copy carries nothing of the office');
  assert.equal(posted.rateRep, null);

  const list = is(await rep.get('/announcements'), 200, 'rep announcements');
  const a = list.find((x: Json) => x.id === posted.announcementId);
  assert.equal(a.title, 'New leaflets');
  assert.deepEqual(a.fromClient, { campaignId: fx().campaignId, campaignCode: 'FXC', campaignName: 'Fixture Charity', campaignColor: '#DB2777' });
  const dashboard = is(await rep.get('/me/dashboard'), 200, 'dashboard');
  assert.ok(dashboard.announcements.some((x: Json) => x.id === posted.announcementId && x.fromClient), 'on the dashboard too');

  const portal = is(await client.get('/client/portal'), 200, 'portal');
  assert.deepEqual(Object.keys(portal).sort(), ['campaign', 'me', 'posts']);
  assert.deepEqual(portal.campaign, { id: fx().campaignId, code: 'FXC', name: 'Fixture Charity', color: '#DB2777' });
  assert.deepEqual(portal.me, { id: clientId, name: 'Cleo Client', email: FIXTURE_ACCOUNTS.client.email });
  assert.equal(portal.posts[0].id, updateId);
  assert.deepEqual((await client.get('/client/posts')).json.map((p: Json) => p.id), portal.posts.map((p: Json) => p.id));
});

test('an announcement publishes too; rates sent with it are ignored', async () => {
  const posted = is(await client.post('/client/posts', { kind: 'announcement', title: 'Walk in June', body: 'Tell supporters.', rateRep: 99, effectiveFrom: nextWeek() }), 201, 'announcement');
  assert.equal(posted.status, 'published');
  assert.equal(posted.kind, 'announcement');
  assert.equal(posted.rateRep, null);
  assert.equal(posted.effectiveFrom, null);
});

test('the post rules: 400 with the field for each problem, as the portal form says', async () => {
  const bad = async (body: Json, field: string) => {
    const r = await client.post('/client/posts', body);
    is(r, 400, JSON.stringify(body));
    assert.ok(r.json.details.some((d: Json) => d.path === field), `${field} in ${JSON.stringify(r.json.details)}`);
  };
  await bad({ kind: 'update', title: '', body: 'b' }, 'title');
  await bad({ kind: 'update', title: 't', body: '   ' }, 'body');
  await bad({ kind: 'update', title: 'x'.repeat(121), body: 'b' }, 'title');
  await bad({ kind: 'commission', rateRep: null, ratePayout: null, effectiveFrom: nextWeek() }, 'rateRep');
  await bad({ kind: 'commission', rateRep: 0, effectiveFrom: nextWeek() }, 'rateRep');
  await bad({ kind: 'commission', rateRep: 12.345, effectiveFrom: nextWeek() }, 'rateRep');
  await bad({ kind: 'commission', ratePayout: 5000, effectiveFrom: nextWeek() }, 'ratePayout');
  await bad({ kind: 'commission', rateRep: 20, effectiveFrom: addDays(today(), -1) }, 'effectiveFrom');
  await bad({ kind: 'commission', rateRep: 20, effectiveFrom: addDays(today(), 367) }, 'effectiveFrom');
  await bad({ kind: 'commission', rateRep: 20 }, 'effectiveFrom');
  is(await client.post('/client/posts', { kind: 'gossip', title: 't', body: 'b' }), 400, 'unknown kind');
  is(await client.post('/client/posts', { kind: 'commission', rateRep: '20', effectiveFrom: nextWeek() }), 400, 'a rate must be a number');
});

test('a commission change waits for Linear: no announcement, a default title, the requested date kept', async () => {
  const before = Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM announcements`)!.n);
  const posted = is(await client.post('/client/posts', { kind: 'commission', rateRep: 22, ratePayout: null, effectiveFrom: nextWeek() }), 201, 'commission');
  commissionId = posted.id;
  assert.equal(posted.status, 'pending');
  assert.equal(posted.announcementId, null);
  assert.match(posted.title, /^Commission change from (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/);
  assert.equal(posted.body, '');
  assert.equal(posted.rateRep, 22);
  assert.equal(posted.effectiveFrom, nextWeek());
  assert.equal(posted.requestedFrom, nextWeek());
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM announcements`)!.n), before, 'nothing in Announcements');
});

test('a double tap answers the first post (200) instead of publishing it twice', async () => {
  const body = { kind: 'update', title: 'Twice?', body: 'Only once, please.' };
  const first = is(await client.post('/client/posts', body), 201, 'first');
  const second = is(await client.post('/client/posts', body), 200, 'second');
  assert.equal(second.id, first.id);
  assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM client_posts WHERE title = 'Twice?'`)!.n), 1);
  assert.equal(auditRows(`entity = 'client_post' AND entity_id = ?`, [first.id]).length, 1, 'one audit row');
  // tidy: this test's post is not part of what follows
  run(srv.db, `DELETE FROM announcements WHERE id = ?`, [first.announcementId]);
  run(srv.db, `DELETE FROM client_posts WHERE id = ?`, [first.id]);
});

test('at most 20 posts in 24 hours per client account (429 after that), counted on the real clock', async () => {
  const solo = { email: 'busy.client@client.test', employeeId: 'CL-0060', pin: '6482' };
  const id = await addClientUserWithPin(srv.db, { campaignId: otherCampaignId, email: solo.email, employeeId: solo.employeeId }, solo.pin);
  const real = new Date().toISOString();
  // The business clock may be pinned or moved (LM_BUSINESS_NOW): created_at says three days ago, posted_at (the real
  // clock) says now, so all 20 count.
  const businessThreeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  for (let i = 0; i < 20; i++) {
    run(srv.db, `INSERT INTO client_posts (campaign_id, author_id, kind, title, body, status, created_at, posted_at) VALUES (?, ?, 'commission', ?, '', 'pending', ?, ?)`, [otherCampaignId, id, `Old ${i}`, businessThreeDaysAgo, real]);
  }
  const busy = await srv.login(solo);
  const r = await busy.post('/client/posts', { kind: 'update', title: 'One more', body: 'b' });
  is(r, 429, '21st post');
  assert.match(r.json.error, /20 posts in the last 24 hours/);
  // The other way round: created "now" on the business clock but posted over a day ago in real time: none count.
  run(srv.db, `UPDATE client_posts SET created_at = ?, posted_at = ? WHERE author_id = ?`, [real, new Date(Date.now() - 25 * 3_600_000).toISOString(), id]);
  const posted = is(await busy.post('/client/posts', { kind: 'update', title: 'One more', body: 'b' }), 201, 'after the real window');
  const stored = get<{ postedAt: string }>(srv.db, `SELECT posted_at AS postedAt FROM client_posts WHERE id = ?`, [posted.id])!;
  assert.ok(Math.abs(Date.parse(stored.postedAt) - Date.now()) < 60_000, 'posted_at is the real clock');
  run(srv.db, `DELETE FROM announcements WHERE author_id = ?`, [id]);
  run(srv.db, `DELETE FROM client_posts WHERE author_id = ?`, [id]);
});

test('the double-tap window is on the real clock too', async () => {
  const body = { kind: 'update', title: 'Clock test', body: 'Once.' };
  const first = is(await client.post('/client/posts', body), 201, 'first');
  // a business clock pinned an hour back: created_at an hour ago, but a real moment ago → still a double tap
  run(srv.db, `UPDATE client_posts SET created_at = ? WHERE id = ?`, [new Date(Date.now() - 3_600_000).toISOString(), first.id]);
  assert.equal(is(await client.post('/client/posts', body), 200, 'a real moment later').id, first.id);
  // three real minutes ago, even if created_at reads "now": a new post
  run(srv.db, `UPDATE client_posts SET created_at = ?, posted_at = ? WHERE id = ?`, [new Date().toISOString(), new Date(Date.now() - 3 * 60_000).toISOString(), first.id]);
  const second = is(await client.post('/client/posts', body), 201, 'three real minutes later');
  assert.notEqual(second.id, first.id);
  run(srv.db, `DELETE FROM announcements WHERE id IN (?, ?)`, [first.announcementId, second.announcementId]);
  run(srv.db, `DELETE FROM client_posts WHERE id IN (?, ?)`, [first.id, second.id]);
});

test('a client sees only its own campaign: another campaign’s client never sees these posts, nor they its', async () => {
  const o = is(await otherClient.post('/client/posts', { kind: 'update', title: 'Other news', body: 'From OTH.' }), 201, 'other client posts');
  assert.equal(o.campaignId, otherCampaignId, 'the campaign comes from the session, never the body');
  const mine = (await client.get('/client/posts')).json as Json[];
  assert.ok(mine.every((p) => p.campaignId === fx().campaignId));
  assert.ok(!mine.some((p) => p.id === o.id));
  const theirs = (await otherClient.get('/client/posts')).json as Json[];
  assert.ok(theirs.every((p) => p.campaignId === otherCampaignId));
  // a campaignId in the body is ignored
  const sneaky = is(await client.post('/client/posts', { kind: 'update', title: 'Sneaky', body: 'b', campaignId: otherCampaignId }), 201, 'with a campaignId');
  assert.equal(sneaky.campaignId, fx().campaignId);
  run(srv.db, `DELETE FROM announcements WHERE id IN (?, ?)`, [o.announcementId, sneaky.announcementId]);
  run(srv.db, `DELETE FROM client_posts WHERE id IN (?, ?)`, [o.id, sneaky.id]);
});

// ───────────────────────────── the office ─────────────────────────────

test('the office list: newest first with unread flags; filters by status and campaign; bad status 400', async () => {
  const all = is(await admin.get('/client-posts'), 200, 'admin list') as Json[];
  assert.ok(all.length >= 3);
  assert.deepEqual(all.map((p) => p.createdAt), [...all.map((p) => p.createdAt)].sort().reverse(), 'newest first');
  assert.ok(all.every((p) => p.unread === true), 'nothing read yet');
  assert.ok('decidedByName' in all[0], 'the office copy names the decider');
  const pending = is(await admin.get('/client-posts?status=pending'), 200, 'pending') as Json[];
  assert.deepEqual(pending.map((p) => p.id), [commissionId]);
  assert.deepEqual((await leader.get(`/client-posts?campaignId=${otherCampaignId}`)).json, []);
  is(await admin.get('/client-posts?status=nonsense'), 400, 'bad status');
  is(await admin.get('/client-posts?campaignId=abc'), 400, 'bad campaignId');
});

test('Needs attention: admin gets a warning for the change to approve and info for each unread post; leader info; others nothing', async () => {
  const a = await attentionKeys(admin);
  assert.ok(a.some((i) => i.key === `client:commission:${commissionId}` && i.severity === 'warning' && i.href === `/campaigns/${fx().campaignId}?post=${commissionId}`), JSON.stringify(a));
  assert.ok(a.some((i) => i.key === `client:post:${updateId}` && i.severity === 'info' && i.title === 'Update from Fixture Charity'));
  const l = await attentionKeys(leader);
  assert.ok(l.some((i) => i.key === `client:post:${commissionId}` && i.severity === 'info'), 'a leader is told, not asked');
  assert.ok(!l.some((i) => i.key.startsWith('client:commission:')));
  for (const c of [rep, recruiter]) assert.deepEqual(await attentionKeys(c), []);
});

test('Needs attention: a change to approve is never pushed out by newer unread posts; the info items stay capped at 8', async () => {
  // the business clock, the one client posts made through the API are stamped with (LM_BUSINESS_NOW)
  const base = businessNow().getTime();
  const flood: number[] = [];
  for (let i = 0; i < 9; i++) {
    flood.push(run(
      srv.db,
      `INSERT INTO client_posts (campaign_id, author_id, kind, title, body, status, created_at) VALUES (?, ?, 'update', ?, 'b', 'published', ?)`,
      [fx().campaignId, clientId, `Flood ${i}`, new Date(base + (i + 1) * 1000).toISOString()],
    ).lastInsertRowid);
  }
  try {
    const a = await attentionKeys(admin);
    assert.ok(a.some((i) => i.key === `client:commission:${commissionId}` && i.severity === 'warning'), `the change to approve is still there: ${JSON.stringify(a.map((i) => i.key))}`);
    const info = a.filter((i) => i.severity === 'info').map((i) => i.key);
    assert.deepEqual(info, [...flood].reverse().slice(0, 8).map((id) => `client:post:${id}`), 'the eight newest unread posts');
    const l = (await attentionKeys(leader)).map((i) => i.key);
    assert.deepEqual(l, [...flood].reverse().slice(0, 8).map((id) => `client:post:${id}`), 'a leader: the eight newest, a pending change among them as info');
    assert.deepEqual((await admin.get('/client-posts?status=pending')).json.map((p: Json) => p.id), [commissionId]);
  } finally {
    run(srv.db, `DELETE FROM client_posts WHERE id IN (${flood.join(', ')})`);
  }
  assert.ok((await attentionKeys(leader)).some((i) => i.key === `client:post:${commissionId}`), 'back as before');
});

test('read receipts: per person, idempotent; the sidebar count and the attention item follow', async () => {
  const before = is(await admin.get('/client-posts/unread'), 200, 'unread').count;
  const leaderBefore = (await leader.get('/client-posts/unread')).json.count;
  assert.ok(before >= 3);
  is(await admin.post(`/client-posts/${updateId}/read`), 204, 'read');
  is(await admin.post(`/client-posts/${updateId}/read`), 204, 'read again');
  assert.equal((await admin.get('/client-posts/unread')).json.count, before - 1);
  assert.equal((await leader.get('/client-posts/unread')).json.count, leaderBefore, 'the leader’s own count is unchanged');
  assert.ok(!(await attentionKeys(admin)).some((i) => i.key === `client:post:${updateId}`), 'the item is gone');
  const listed = (await admin.get('/client-posts')).json.find((p: Json) => p.id === updateId);
  assert.equal(listed.unread, false);
  // reading a pending change keeps the item to approve
  is(await admin.post(`/client-posts/${commissionId}/read`), 204, 'read the change');
  assert.ok((await attentionKeys(admin)).some((i) => i.key === `client:commission:${commissionId}`), 'still waiting for a decision');
  assert.equal(auditRows(`action LIKE '%/read'`).length, 0, 'read receipts write no audit rows');
  // a post older than 30 days counts as read (30 days on the business clock, which the unread count uses: LM_BUSINESS_NOW)
  run(srv.db, `UPDATE client_posts SET created_at = ? WHERE id = ?`, [new Date(businessNow().getTime() - 31 * 86_400_000).toISOString(), updateId]);
  const l = (await leader.get('/client-posts/unread')).json.count;
  assert.equal(l, leaderBefore - 1);
  run(srv.db, `UPDATE client_posts SET created_at = ? WHERE id = ?`, [new Date().toISOString(), updateId]);
});

test('read receipts in one go: POST /client-posts/read { ids } (the campaign page), one write; roles; bad bodies', async () => {
  const anon = srv.anon();
  is(await anon.post('/client-posts/read', { ids: [1] }), 401, 'anon');
  portalOnly(await client.post('/client-posts/read', { ids: [1] }), 'client');
  is(await rep.post('/client-posts/read', { ids: [1] }), 403, 'rep');
  is(await recruiter.post('/client-posts/read', { ids: [1] }), 403, 'recruiter');
  is(await leader.post('/client-posts/read', {}), 400, 'no ids');
  is(await leader.post('/client-posts/read', { ids: 'all' }), 400, 'not a list');
  is(await leader.post('/client-posts/read', { ids: [0] }), 400, 'not an id');
  is(await leader.post('/client-posts/read', { ids: Array.from({ length: 201 }, (_, i) => i + 1) }), 400, 'more than a page shows');
  const leaderId = fx().users.leader;
  const had = (srv.db.prepare(`SELECT post_id AS id FROM client_post_reads WHERE user_id = ?`).all(leaderId) as { id: number }[]).map((r) => r.id);
  const unreadIds = ((await leader.get('/client-posts')).json as Json[]).filter((p) => p.unread).map((p) => p.id as number);
  assert.ok(unreadIds.length >= 2, `${unreadIds.length} unread`);
  const count = (await leader.get('/client-posts/unread')).json.count;
  is(await leader.post('/client-posts/read', { ids: [...unreadIds, 999999] }), 204, 'read them all (an unknown id is ignored)');
  assert.equal((await leader.get('/client-posts/unread')).json.count, count - unreadIds.length);
  assert.ok(((await leader.get('/client-posts')).json as Json[]).every((p) => !unreadIds.includes(p.id) || p.unread === false));
  is(await leader.post('/client-posts/read', { ids: unreadIds }), 204, 'again: idempotent');
  is(await leader.post('/client-posts/read', { ids: [] }), 204, 'nothing to read');
  assert.equal(auditRows(`action = 'POST /client-posts/read'`).length, 0, 'read receipts write no audit rows');
  // tidy: the leader's receipts as they were
  run(srv.db, `DELETE FROM client_post_reads WHERE user_id = ?${had.length ? ` AND post_id NOT IN (${had.join(', ')})` : ''}`, [leaderId]);
});

test('decline: only a pending commission change, with a reason the client sees', async () => {
  is(await admin.post(`/client-posts/${commissionId}/decline`, {}), 400, 'no reason');
  is(await admin.post(`/client-posts/${commissionId}/decline`, { note: '   ' }), 400, 'blank reason');
  is(await admin.post(`/client-posts/${updateId}/decline`, { note: 'x' }), 409, 'an update cannot be declined');
  const extra = is(await client.post('/client/posts', { kind: 'commission', ratePayout: 90, effectiveFrom: nextWeek(), title: 'Lower payout', body: 'Budget.' }), 201, 'a change to decline');
  const declined = is(await admin.post(`/client-posts/${extra.id}/decline`, { note: 'We agreed £120 until March.' }), 200, 'decline');
  assert.equal(declined.status, 'declined');
  assert.equal(declined.decisionNote, 'We agreed £120 until March.');
  assert.equal(declined.decidedByName, 'Ada Admin');
  is(await admin.post(`/client-posts/${extra.id}/decline`, { note: 'again' }), 409, 'twice');
  is(await admin.post(`/client-posts/${extra.id}/approve`, {}), 409, 'approve after decline');
  const seen = (await client.get('/client/posts')).json.find((p: Json) => p.id === extra.id);
  assert.equal(seen.status, 'declined');
  assert.equal(seen.decisionNote, 'We agreed £120 until March.');
  assert.equal(seen.decidedBy, null, 'the client never sees who in the office decided');
  assert.ok(!('decidedByName' in seen));
  const rows = auditRows(`entity = 'client_post' AND entity_id = ? AND action = 'POST /client-posts/:id/decline'`, [extra.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.summary, `Declined Fixture Charity’s commission change (£90.00 per sub to Linear, from ${clientPostDayLabel(nextWeek())}): We agreed £120 until March.`);
});

test('approve: a pending commission change becomes a campaign rate through P1 (or nothing at all while P1’s stub is in)', async () => {
  is(await admin.post(`/client-posts/${updateId}/approve`, {}), 409, 'an update needs no approval');
  is(await admin.post(`/client-posts/${commissionId}/approve`, { effectiveFrom: 'soon' }), 400, 'not a date');
  is(await admin.post(`/client-posts/${commissionId}/approve`, { effectiveFrom: addDays(today(), 400) }), 400, 'over a year ahead');
  is(await admin.post(`/client-posts/${commissionId}/approve`, { effectiveFrom: '2000-01-03' }), 400, 'before the campaign started');
  const confirmed = addDays(today(), 14);
  const officeNote = 'Agreed on the phone with the client';
  const r = await admin.post(`/client-posts/${commissionId}/approve`, { effectiveFrom: confirmed, note: officeNote });
  const stored = get<{ status: string; effectiveFrom: string; requestedFrom: string }>(srv.db, `SELECT status, effective_from AS effectiveFrom, requested_from AS requestedFrom FROM client_posts WHERE id = ?`, [commissionId])!;
  if (r.status === 501) {
    // P1's lib/payRule.ts addCampaignRate is still the foundation's stub: the approval writes nothing at all.
    assert.equal(stored.status, 'pending');
    assert.equal(stored.effectiveFrom, nextWeek());
    assert.equal(Number(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM campaign_rates WHERE client_post_id = ?`, [commissionId])!.n), 0);
    assert.equal(auditRows(`action = 'POST /client-posts/:id/approve'`).length, 0, 'a refused approval is not recorded');
    // finish the story by hand so the client side below can be checked: approved from the confirmed date
    run(srv.db, `UPDATE client_posts SET status = 'approved', effective_from = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`, [confirmed, fx().users.admin, new Date().toISOString(), officeNote, commissionId]);
  } else {
    const post = is(r, 200, 'approve');
    assert.equal(post.status, 'approved');
    assert.equal(post.effectiveFrom, confirmed, 'the date Matt confirmed');
    assert.equal(post.requestedFrom, nextWeek(), 'the client’s own date kept');
    const rate = get<{ repRate: number; source: string; effectiveFrom: string; approvedBy: number }>(
      srv.db, `SELECT rep_rate AS repRate, source, effective_from AS effectiveFrom, approved_by AS approvedBy FROM campaign_rates WHERE client_post_id = ?`, [commissionId],
    )!;
    assert.deepEqual({ ...rate }, { repRate: 22, source: 'client', effectiveFrom: confirmed, approvedBy: fx().users.admin });
    const rows = auditRows(`action = 'POST /client-posts/:id/approve'`);
    assert.ok(rows.some((x) => x.entity === 'client_post' && /^Approved Fixture Charity’s commission change: £22\.00 per sub to the fundraiser, from /.test(x.summary)));
    assert.ok(rows.some((x) => x.entity === 'campaign_rate'), 'the rate row is recorded too');
  }
  is(await admin.post(`/client-posts/${commissionId}/approve`, {}), 409, 'twice');
  const seen = (await client.get('/client/posts')).json.find((p: Json) => p.id === commissionId);
  assert.equal(seen.status, 'approved');
  assert.equal(seen.effectiveFrom, confirmed);
  // The approval note is the office's own record: never in the client's copy (portal and history alike).
  assert.equal(seen.decisionNote, null, 'the client never gets the office’s note');
  assert.equal((await client.get('/client/portal')).json.posts.find((p: Json) => p.id === commissionId).decisionNote, null);
  assert.equal((await admin.get('/client-posts')).json.find((p: Json) => p.id === commissionId).decisionNote, officeNote, 'the office keeps it');
  assert.ok(!(await attentionKeys(admin)).some((i) => i.key === `client:commission:${commissionId}`), 'nothing left to approve');
});

test('unpublish: the announcement is removed, the client sees "unpublished", and it happens once', async () => {
  const post = (await admin.get('/client-posts')).json.find((p: Json) => p.id === updateId);
  const annId = post.announcementId;
  assert.ok(annId);
  is(await admin.post(`/client-posts/${commissionId}/unpublish`, {}), 409, 'a commission change is never published');
  const done = is(await admin.post(`/client-posts/${updateId}/unpublish`, { note: 'Sent twice by mistake' }), 200, 'unpublish');
  assert.equal(done.status, 'unpublished');
  assert.equal(done.announcementId, null);
  assert.equal(get(srv.db, `SELECT 1 FROM announcements WHERE id = ?`, [annId]), undefined, 'the Announcements row is gone');
  assert.ok(!(await rep.get('/announcements')).json.some((a: Json) => a.id === annId));
  is(await admin.post(`/client-posts/${updateId}/unpublish`, {}), 409, 'twice');
  const seen = (await client.get('/client/posts')).json.find((p: Json) => p.id === updateId);
  assert.equal(seen.status, 'unpublished');
  assert.equal(seen.decisionNote, null, 'the note for the record stays in the office');
  assert.ok(!JSON.stringify((await client.get('/client/portal')).json).includes('Sent twice by mistake'), 'nowhere in the portal');
  assert.equal((await admin.get('/client-posts')).json.find((p: Json) => p.id === updateId).decisionNote, 'Sent twice by mistake');
  const rows = auditRows(`action = 'POST /client-posts/:id/unpublish'`);
  assert.equal(rows.length, 2, 'the post and the removed announcement');
  assert.equal(rows[0]!.summary, 'Unpublished Fixture Charity’s update “New leaflets” from Announcements: Sent twice by mistake');
  assert.equal(rows[1]!.entity, 'announcement');
  assert.equal(rows[1]!.entityId, annId);
  assert.match(rows[1]!.beforeJson!, /The winter leaflets arrive on Monday/, 'its text stays in the trail');
});

test('the client post audit rows: the client account is the actor, in plain words, never a PIN', async () => {
  const rows = auditRows(`action = 'POST /client/posts' AND user_id = ?`, [clientId]);
  assert.ok(rows.some((r) => r.summary === 'Fixture Charity posted an update: “New leaflets”'), JSON.stringify(rows.map((r) => r.summary)));
  assert.ok(rows.some((r) => r.summary === 'Fixture Charity posted an announcement: “Walk in June”'));
  assert.ok(rows.some((r) => /^Fixture Charity asked for a commission change: £22\.00 per sub to the fundraiser, from /.test(r.summary)));
  for (const r of rows) assert.equal(r.entity, 'client_post');
});

// ───────────────────────────── client accounts ─────────────────────────────

test('invite: the next access code (never a demo code), the instructions, and 409 / 400 / 404 where due', async () => {
  const cid = fx().campaignId;
  const r = is(await admin.post(`/campaigns/${cid}/client-accounts`, { firstName: 'Jo', lastName: 'Bloggs', email: ' Jo.Bloggs@Charity.example ', signInUrl: 'https://hub.example/login' }), 201, 'invite');
  assert.equal(r.accessCode, 'CL-0061', 'the next after the highest code in use (CL-0060)');
  assert.deepEqual(
    { ...r.account, createdAt: undefined },
    { id: r.account.id, firstName: 'Jo', lastName: 'Bloggs', email: 'jo.bloggs@charity.example', accessCode: 'CL-0061', campaignId: cid, status: 'active', hasPin: false, createdAt: undefined, twoFactorEnabled: false },
  );
  assert.match(r.instructions, /1\. Open https:\/\/hub\.example\/login\./);
  assert.match(r.instructions, /\(jo\.bloggs@charity\.example\) and your access code: CL-0061/);
  // the first sign-in needs the one-time setup code shown here once; then the PIN, then two-step verification
  joSetupCode = r.setupCode;
  assert.match(joSetupCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(r.instructions.includes(`\n3. The first time, type your one-time setup code: ${joSetupCode}.`));
  assert.match(r.instructions, /\n5\. Then set up two-step verification\. You need an authenticator app on your phone/);
  const row = get<{ role: string; position: string; teamId: number | null; payPlanId: number }>(srv.db, `SELECT role, position, team_id AS teamId, pay_plan_id AS payPlanId FROM users WHERE id = ?`, [r.account.id])!;
  assert.deepEqual({ ...row }, { role: 'client', position: 'client', teamId: null, payPlanId: fx().plans.owner });
  is(await admin.post(`/campaigns/${cid}/client-accounts`, { firstName: 'Jo', lastName: 'Again', email: 'jo.bloggs@charity.example' }), 409, 'same email');
  is(await admin.post(`/campaigns/${cid}/client-accounts`, { firstName: 'Ada', lastName: 'Copy', email: FIXTURE_ACCOUNTS.admin.email }), 409, 'a staff email');
  is(await admin.post(`/campaigns/${cid}/client-accounts`, { firstName: '', lastName: 'X', email: 'x@y.example' }), 400, 'no first name');
  is(await admin.post(`/campaigns/${cid}/client-accounts`, { firstName: 'X', lastName: 'Y', email: 'not an email' }), 400, 'bad email');
  is(await admin.post(`/campaigns/${cid}/client-accounts`, { firstName: 'X', lastName: 'Y', email: 'x@y.example', signInUrl: 'javascript:alert(1)' }), 400, 'bad sign-in URL');
  is(await admin.post('/campaigns/999999/client-accounts', { firstName: 'X', lastName: 'Y', email: 'x@y.example' }), 404, 'unknown campaign');
  const listed = is(await admin.get(`/campaigns/${cid}/client-accounts`), 200, 'list') as Json[];
  assert.deepEqual(listed.map((a) => a.accessCode).sort(), ['CL-0001', 'CL-0061']);
  const audit = auditRows(`action = 'POST /campaigns/:id/client-accounts'`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.summary, 'Invited Jo Bloggs (CL-0061) to the Fixture Charity client portal');
  assert.equal(audit[0]!.entity, 'client_account');
});

test('an invited client’s first sign-in creates the PIN (the gate holds them until then), then every sign-in needs it', async () => {
  const creds = { email: 'jo.bloggs@charity.example', employeeId: 'CL-0061' };
  const jo = srv.anon();
  // the email and access code alone start nothing: the setup code from the invite comes with them
  assert.deepEqual(is(await jo.post('/auth/login', creds), 200, 'asks for the setup code'), { requiresSetupCode: true });
  const first = is(await jo.post('/auth/login', { ...creds, setupCode: joSetupCode }), 200, 'first sign-in');
  assert.equal(first.user.pinSetupRequired, true, 'a client account must create a PIN');
  assert.equal(first.user.hasPin, false);
  const held = await jo.get('/client/portal');
  is(held, 403, 'held at "Create your PIN"');
  assert.equal(held.json.pinSetupRequired, true);
  assert.equal((await jo.get('/auth/pin')).json.required, true, 'PIN status says it is required');
  is(await jo.post('/auth/pin', { pin: '0061' }), 400, 'not the digits of the access code');
  is(await jo.post('/auth/pin', { pin: '4826' }), 204, 'create the PIN');
  // Release 1.4 (package S): then two-step verification, required for client accounts too (after the PIN step)
  const twoStep = await jo.get('/client/portal');
  is(twoStep, 403, 'held at "Set up two-step verification"');
  assert.equal(twoStep.json.twoFactorSetupRequired, true);
  const setup = is(await jo.post('/auth/2fa/setup'), 201, 'two-step setup');
  is(await jo.post('/auth/2fa/enable', { code: totp(setup.secret) }), 200, 'two-step on');
  is(await jo.get('/client/portal'), 200, 'the portal opens');
  const removal = await jo.post('/auth/pin/remove', { currentPin: '4826' });
  is(removal, 409, 'a client account cannot remove its PIN');
  assert.match(removal.json.error, /required/i);
  assert.ok(get<{ hash: string | null }>(srv.db, `SELECT pin_hash AS hash FROM users WHERE employee_id = 'CL-0061'`)!.hash, 'the PIN stays');
  const again = await srv.anon().post('/auth/login', creds);
  assert.equal(again.json.requiresPin, true, 'the next sign-in asks for the PIN');
  const withPin = is(await srv.anon().post('/auth/login', { ...creds, pin: '4826' }), 200, 'with the PIN');
  assert.equal(withPin.requiresTwoFactor, true, 'then the two-step code (release 1.4)');
});

test('deactivate signs the client out everywhere and stops sign-in; reactivate; edit; 404 for staff', async () => {
  const id = Number(get<{ id: number }>(srv.db, `SELECT id FROM users WHERE employee_id = 'CL-0061'`)!.id);
  const jo = await srv.login({ email: 'jo.bloggs@charity.example', employeeId: 'CL-0061', pin: '4826' });
  is(await jo.get('/client/portal'), 200, 'signed in');
  const off = is(await admin.patch(`/client-accounts/${id}`, { status: 'left' }), 200, 'deactivate');
  assert.equal(off.status, 'left');
  is(await jo.get('/client/portal'), 401, 'their session ended');
  is(await srv.anon().post('/auth/login', { email: 'jo.bloggs@charity.example', employeeId: 'CL-0061', pin: '4826' }), 401, 'no sign-in');
  // a new sign-in email is a step-up action: the admin's fresh two-step code
  const noCode = is(await admin.patch(`/client-accounts/${id}`, { status: 'active', email: 'jo@charity.example' }), 400, 'a new email needs the admin’s code');
  assert.match(noCode.error, /6-digit code/);
  is(await admin.patch(`/client-accounts/${id}`, { status: 'active', email: 'jo@charity.example', code: currentCode(srv.db, fx().users.admin) }), 200, 'reactivate with a new email');
  is(await srv.anon().post('/auth/login', { email: 'jo@charity.example', employeeId: 'CL-0061', pin: '4826' }), 200, 'signs in again');
  is(await admin.patch(`/client-accounts/${id}`, {}), 400, 'nothing to change');
  is(await admin.patch(`/client-accounts/${id}`, { email: FIXTURE_ACCOUNTS.rep.email, code: currentCode(srv.db, fx().users.admin) }), 409, 'an email in use');
  is(await admin.patch(`/client-accounts/${id}`, { status: 'gone' }), 400, 'bad status');
  is(await admin.patch(`/client-accounts/${fx().users.rep}`, { status: 'left' }), 404, 'a staff member is not a client account');
  is(await admin.post(`/client-accounts/${fx().users.rep}/reset-pin`, { code: '123456' }), 404, 'nor for a PIN reset');
  assert.equal(get<{ status: string }>(srv.db, `SELECT status FROM users WHERE id = ?`, [fx().users.rep])!.status, 'active');
  const summaries = auditRows(`action = 'PATCH /client-accounts/:id'`).map((r) => r.summary);
  assert.equal(summaries[0], 'Deactivated the client account of Jo Bloggs (Fixture Charity)');
  assert.match(summaries[1]!, /^Reactivated the client account of Jo Bloggs \(Fixture Charity\): email jo\.bloggs@charity\.example → jo@charity\.example$/);
  is(await admin.patch(`/client-accounts/${id}`, { status: 'left' }), 200, 'off again');
  is(await admin.patch(`/client-accounts/${id}`, { status: 'active' }), 200, 'on again, nothing else changed');
  const later = auditRows(`action = 'PATCH /client-accounts/:id'`).map((r) => r.summary);
  assert.equal(later[3], 'Reactivated the client account of Jo Bloggs (Fixture Charity)', 'no "(no changes)" when only the status changed');
});

test('reset PIN: cleared, signed out; the next sign-in creates a new one', async () => {
  const id = Number(get<{ id: number }>(srv.db, `SELECT id FROM users WHERE employee_id = 'CL-0061'`)!.id);
  const jo = await srv.login({ email: 'jo@charity.example', employeeId: 'CL-0061', pin: '4826' });
  // a reset needs the admin's fresh two-step code and hands out the setup code the next sign-in needs
  is(await admin.post(`/client-accounts/${id}/reset-pin`), 400, 'no code');
  const reset = is(await admin.post(`/client-accounts/${id}/reset-pin`, { code: currentCode(srv.db, fx().users.admin) }), 200, 'reset');
  assert.equal(reset.hasPin, false);
  assert.match(reset.setupCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  is(await jo.get('/client/portal'), 401, 'signed out');
  const anon = srv.anon();
  const creds = { email: 'jo@charity.example', employeeId: 'CL-0061' };
  assert.deepEqual(is(await anon.post('/auth/login', creds), 200, 'the setup code first'), { requiresSetupCode: true });
  const step = is(await anon.post('/auth/login', { ...creds, setupCode: reset.setupCode }), 200, 'sign in without a PIN');
  assert.equal(step.requiresTwoFactor, true, 'release 1.4: two-step stays on after a PIN reset');
  const back = is(await anon.post('/auth/login/2fa', { challengeToken: step.challengeToken, code: currentCode(srv.db, id) }), 200, 'the code');
  assert.equal(back.user.pinSetupRequired, true);
  const rows = auditRows(`action = 'POST /client-accounts/:id/reset-pin'`);
  assert.equal(rows[0]!.summary, 'Reset the PIN of Jo Bloggs (Fixture Charity); they create a new one at their next sign-in');
  for (const r of rows) assert.ok(!/scrypt|pin_hash|pinHash/i.test(`${r.beforeJson}${r.afterJson}`), 'no PIN hash in the trail');
  assert.match(rows[0]!.beforeJson!, /"pinSet":true/);
  assert.match(rows[0]!.afterJson!, /"pinSet":false/);
});

// ───────────────────────────── the campaign page ─────────────────────────────

test('campaign page: admins and leaders in full, reps and recruiters the brief without money', async () => {
  const cid = fx().campaignId;
  const a = is(await admin.get(`/campaigns/${cid}/page`), 200, 'admin');
  assert.equal(a.full, true);
  assert.equal(a.campaign.payoutPerSale, 120);
  assert.equal(a.campaign.repCommissionPerSale, 45);
  assert.ok(Array.isArray(a.rates));
  assert.ok(Array.isArray(a.clientAccounts) && a.clientAccounts.length === 2);
  assert.ok(a.posts.some((p: Json) => p.kind === 'commission'), 'commission changes for the office');
  assert.ok(a.posts.every((p: Json) => typeof p.unread === 'boolean'));
  assert.ok(a.announcements.every((x: Json) => x.fromClient?.campaignId === cid), 'only this client’s announcements');
  assert.ok(a.announcements.some((x: Json) => x.title === 'Walk in June'));
  assert.deepEqual(Object.keys(a.sales).sort(), ['lastMonth', 'thisMonth']);
  for (const k of ['longDescription', 'brief', 'contactName', 'contactEmail', 'contactPhone']) assert.ok(k in a.campaign, k);

  const l = is(await leader.get(`/campaigns/${cid}/page`), 200, 'leader');
  assert.equal(l.full, true);
  assert.equal(l.campaign.payoutPerSale, 120);
  assert.ok(!('clientAccounts' in l), 'client accounts are the admin’s');

  for (const [role, c] of [['rep', rep], ['recruiter', recruiter]] as const) {
    const p = is(await c.get(`/campaigns/${cid}/page`), 200, role);
    assert.equal(p.full, false);
    assert.ok(!('payoutPerSale' in p.campaign) && !('repCommissionPerSale' in p.campaign), `${role}: no money`);
    assert.ok(!('rates' in p) && !('clientAccounts' in p), `${role}: no rates, no accounts`);
    assert.ok(p.posts.every((x: Json) => x.status === 'published' && x.kind !== 'commission'), `${role}: published updates only`);
    assert.ok(p.posts.every((x: Json) => x.decidedBy === null && !('decidedByName' in x) && !('unread' in x)));
    assert.deepEqual([p.campaign.contactName, p.campaign.contactEmail, p.campaign.contactPhone], [null, null, null], `${role}: no client contact details`);
    assert.ok(!('paidThrough' in p), `${role}: nothing about pay weeks`);
  }
  // the approve dialog's warning: the last day of the latest paid pay week (admins only)
  const paid = get<{ d: string | null }>(srv.db, `SELECT MAX(week_end) AS d FROM payroll_runs WHERE status = 'paid'`)!.d;
  assert.equal(a.paidThrough, paid ?? null);
  assert.ok(!('paidThrough' in l), 'a leader decides nothing');
  // this month's events: every team for the office and recruiters, a rep's own team only
  const teams = (page: Json) => [...new Set(page.eventsThisMonth.map((e: Json) => e.teamId))].sort();
  assert.deepEqual(teams(a), [fx().teams.a, fx().teams.b].sort());
  assert.deepEqual(teams((await rep.get(`/campaigns/${cid}/page`)).json), [fx().teams.a]);
  assert.deepEqual(teams((await repB.get(`/campaigns/${cid}/page`)).json), [fx().teams.b]);
  assert.deepEqual(teams((await recruiter.get(`/campaigns/${cid}/page`)).json), [fx().teams.a, fx().teams.b].sort());
});

test('campaign page sales: this month and last month, hand-counted from gauge rows', async () => {
  const cid = otherCampaignId;
  const monthStart = `${today().slice(0, 8)}01`;
  const lastMonthDay = addDays(monthStart, -3);
  const thisEvent = addEvent(srv.db, { campaignId: cid, teamId: fx().teams.a, date: monthStart, name: 'OTH this month' });
  const lastEvent = addEvent(srv.db, { campaignId: cid, teamId: fx().teams.b, date: lastMonthDay, name: 'OTH last month' });
  addGauge(srv.db, { eventId: thisEvent, userId: fx().users.rep, date: monthStart, stops: 50, sales: 3 });
  addGauge(srv.db, { eventId: thisEvent, userId: fx().users.repA2, date: monthStart, stops: 40, sales: 2 });
  addGauge(srv.db, { eventId: lastEvent, userId: fx().users.repB, date: lastMonthDay, stops: 60, sales: 4 });
  srv.resetCache();
  const page = is(await admin.get(`/campaigns/${cid}/page`), 200, 'page');
  assert.deepEqual(page.sales, { thisMonth: 5, lastMonth: 4 }, '3 + 2 this month; 4 last month');
  assert.deepEqual(page.eventsThisMonth.map((e: Json) => e.name), ['OTH this month']);
  assert.equal(page.eventsThisMonth[0].totals.sales, 5);
});

test('campaign page is cached per person and refreshed by any write', async () => {
  const cid = fx().campaignId;
  srv.resetCache();
  assert.equal((await admin.get(`/campaigns/${cid}/page`)).headers.get('x-cache'), 'MISS');
  assert.equal((await admin.get(`/campaigns/${cid}/page`)).headers.get('x-cache'), 'HIT');
  assert.equal((await leader.get(`/campaigns/${cid}/page`)).headers.get('x-cache'), 'MISS', 'per person');
  await client.post('/client/posts', { kind: 'update', title: 'Fresh news', body: 'b' });
  const fresh = await admin.get(`/campaigns/${cid}/page`);
  assert.equal(fresh.headers.get('x-cache'), 'MISS');
  assert.ok(fresh.json.posts.some((p: Json) => p.title === 'Fresh news'));
});

test('the campaign brief: saved with POST / PATCH /campaigns, cleared with "", shown on the page, audited', async () => {
  const cid = fx().campaignId;
  const patched = is(
    await admin.patch(`/campaigns/${cid}`, { longDescription: 'All about FXC.', brief: 'Lead with the nurses.', contactName: 'Cleo Client', contactEmail: 'Cleo@Charity.example', contactPhone: '0161 496 0000' }),
    200,
    'patch brief',
  );
  assert.equal(patched.contactEmail, 'cleo@charity.example');
  assert.equal(patched.code, 'FXC', 'the 1.0 fields are unchanged');
  const page = (await rep.get(`/campaigns/${cid}/page`)).json;
  assert.equal(page.campaign.brief, 'Lead with the nurses.');
  assert.equal(page.campaign.contactPhone, null, 'a rep gets the brief, not the client’s phone');
  const office = (await leader.get(`/campaigns/${cid}/page`)).json;
  assert.deepEqual([office.campaign.contactName, office.campaign.contactEmail, office.campaign.contactPhone], ['Cleo Client', 'cleo@charity.example', '0161 496 0000']);
  is(await admin.patch(`/campaigns/${cid}`, { contactEmail: 'nope' }), 400, 'bad contact email');
  is(await leader.patch(`/campaigns/${cid}`, { brief: 'x' }), 403, 'admins only, as before');
  const cleared = is(await admin.patch(`/campaigns/${cid}`, { brief: '', contactPhone: null }), 200, 'clear two');
  assert.equal(cleared.brief, null);
  assert.equal(cleared.contactPhone, null);
  assert.equal(cleared.longDescription, 'All about FXC.', 'a field left out keeps its value');
  const created = is(
    await admin.post('/campaigns', { name: 'Brief Test', code: 'BRF', sector: 'charity', type: 'fundraising', payoutPerSale: 100, repCommissionPerSale: 20, color: '#334455', brief: 'From day one.' }),
    201,
    'create with a brief',
  );
  assert.equal(created.brief, 'From day one.');
  const rows = auditRows(`action = 'PATCH /campaigns/:id' AND entity_id = ?`, [cid]);
  assert.match(rows[0]!.summary, /^Updated campaign Fixture Charity \(FXC\): long description — → All about FXC\., brief — → Lead with the nurses\., contact name — → Cleo Client and 2 more$/);
  assert.match(rows[1]!.summary, /^Updated campaign Fixture Charity \(FXC\): brief Lead with the nurses\. → —, contact phone 0161 496 0000 → —$/);
  assert.equal(auditRows(`action = 'POST /campaigns' AND entity_id = ?`, [created.id])[0]!.summary, 'Added campaign: Brief Test (BRF)');
});

// ───────────────────────────── the guard ─────────────────────────────

test('client guard: a client session gets 403 clientPortalOnly on every route outside the portal, and the portal works', async () => {
  const routes = listApiRoutes(createApp(srv.db));
  let refused = 0;
  for (const r of routes) {
    const path = r.path.replace(/:[A-Za-z]+/g, '1');
    if (clientMayCall(path)) continue;
    portalOnly(await otherClient.req(r.method, path, r.method === 'GET' ? undefined : {}), `${r.method} ${path}`);
    refused++;
  }
  assert.ok(refused > 140, `${refused} routes refused`);
  for (const p of ['/client-posts', '/client-accounts/1', `/campaigns/${otherCampaignId}/page`, '/announcements', '/me/attention', '/users', '/no/such/path']) {
    portalOnly(await otherClient.get(p), p);
  }
  is(await otherClient.get('/client/portal'), 200, 'the portal itself');
  is(await otherClient.get('/auth/me'), 200, 'their own account');
});
