/**
 * Release 1.3 — P6 client-portal: the client PIN rule (lib/pin.ts accountFlags, pinStatusFor), the demo rows of the
 * client extension (campaign briefs, Hannah Price's posts, the office's read receipts, the link to a client rate in the
 * pay history), and the upgrade of a database created at the foundation commit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECURITY_SETTINGS, accountFlags, clientPinRequired, pinStatusFor } from '../lib/pin.ts';
import { openDb, type Db } from '../db/connection.ts';
import { upgradeExtensions } from '../db/extensions/index.ts';
import { columnsOf } from '../db/extensions/types.ts';
import { CAMPAIGN_BRIEFS, seedClientDemo } from '../db/extensions/client.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { nowISO, setBusinessClock } from '../lib/dates.ts';
import { addClientUser, startTestServer, type Json } from './helpers.ts';

// ───────────────────────────── the PIN rule ─────────────────────────────

test('accountFlags: a client account needs a PIN until it has one; the demo client and staff only when the admin requires one', () => {
  const off = DEFAULT_SECURITY_SETTINGS;
  const on = { ...DEFAULT_SECURITY_SETTINGS, requirePin: true };
  const who = (role: 'client' | 'rep' | 'admin', hasPin: boolean, demoClient = false) => ({ role, hasPin, twoFactorEnabled: false, demoClient, demoSignIn: demoClient });
  // [settings, subject, pinSetupRequired] — the whole truth table
  const table: [typeof off, ReturnType<typeof who>, boolean][] = [
    [off, who('client', false), true],
    [off, who('client', true), false],
    [off, who('client', false, true), false],
    [off, who('client', true, true), false],
    [off, who('rep', false), false],
    [off, who('admin', false), false],
    [on, who('client', false), true],
    [on, who('client', false, true), true],
    [on, who('client', true, true), false],
    [on, who('rep', false), true],
    [on, who('rep', true), false],
  ];
  for (const [settings, subject, expected] of table) {
    assert.equal(accountFlags(settings, subject).pinSetupRequired, expected, `${JSON.stringify(settings.requirePin)} ${JSON.stringify(subject)}`);
    assert.equal(accountFlags(settings, subject).hasPin, subject.hasPin);
  }
  // Release 1.4 (package S): two-step verification is for every account, client accounts included; the demo sign-in
  // accounts (the demo client among them) are exempt while still the demo. The old admin-only switch decides nothing.
  for (const settings of [off, { ...off, requireAdminTwoFactor: true }]) {
    assert.equal(accountFlags(settings, who('client', true)).twoFactorSetupRequired, true, 'an invited client sets it up');
    assert.equal(accountFlags(settings, who('rep', false)).twoFactorSetupRequired, true, 'staff too');
    assert.equal(accountFlags(settings, who('client', false, true)).twoFactorSetupRequired, false, 'the demo client is exempt');
    assert.equal(accountFlags(settings, { ...who('client', true), twoFactorEnabled: true }).twoFactorSetupRequired, false, 'once it is on');
  }
});

// ───────────────────────────── the demo seed ─────────────────────────────

test('demo seed: Hannah signs in without a PIN, her portal shows the demo posts, the office has its items', async () => {
  const demo = await startTestServer({ seed: true });
  try {
    const db = demo.db;
    const bcn = Number((db.prepare(`SELECT id FROM campaigns WHERE code = 'BCN'`).get() as { id: number }).id);
    const hannah = await demo.login('client');
    const me = (await hannah.get('/auth/me')).json.user;
    assert.equal(me.pinSetupRequired, false, 'the demo client is exempt from the client PIN rule');
    assert.equal((await hannah.get('/auth/pin')).json.required, false);
    const portal = (await hannah.get('/client/portal')).json;
    assert.equal(portal.campaign.code, 'BCN');
    const posts = portal.posts as Json[];
    const own = posts.filter((p) => p.status !== 'approved');
    assert.deepEqual(own.map((p) => `${p.kind}:${p.status}`), ['commission:pending', 'update:published', 'announcement:published', 'commission:declined'], 'newest first');
    const pending = own[0];
    assert.equal(pending.rateRep, 22);
    assert.equal(pending.ratePayout, null);
    assert.equal(new Date(`${pending.effectiveFrom}T00:00:00Z`).getUTCDay(), 1, 'from a Monday');
    assert.match(own[3].decisionNote, /We agreed £120 per sub/);
    for (const p of posts) assert.equal(p.decidedBy, null);
    for (const p of posts.filter((x) => x.status === 'approved')) {
      // only once P1's demo history records a client rate change: linked both ways
      assert.ok(db.prepare(`SELECT 1 FROM campaign_rates WHERE client_post_id = ? AND source = 'client'`).get(p.id), 'approved demo post is linked to its rate');
    }

    // Announcements: the two published posts carry the badge
    const owner = await demo.login('admin');
    const anns = (await owner.get('/announcements')).json as Json[];
    const fromBcn = anns.filter((a) => a.fromClient?.campaignCode === 'BCN').map((a) => a.title);
    assert.deepEqual(fromBcn.sort(), ['New welcome pack for October donors', 'Pink Ribbon Walk: tell your supporters']);
    // …and some of the team have read them ("Read by 22 of 28", never "0 of 28"): more for the older one, at times
    // between the post and now, never the client herself
    const bcnAnns = anns.filter((a) => a.fromClient?.campaignCode === 'BCN');
    const reads = (await owner.get(`/announcements/reads?ids=${bcnAnns.map((a) => a.id).join(',')}`)).json as Json[];
    const readsOf = (title: string) => reads.find((r) => r.announcementId === bcnAnns.find((a) => a.title === title)!.id)!;
    const walkReads = readsOf('Pink Ribbon Walk: tell your supporters');
    const packReads = readsOf('New welcome pack for October donors');
    assert.ok(packReads.readCount > 0 && walkReads.readCount > packReads.readCount, `${walkReads.readCount} and ${packReads.readCount} readers`);
    assert.ok(walkReads.readCount < walkReads.audience, 'not quite everyone');
    for (const a of bcnAnns) {
      const bad = db
        .prepare(`SELECT COUNT(*) AS n FROM announcement_reads r JOIN announcements a ON a.id = r.announcement_id JOIN users u ON u.id = r.user_id
                  WHERE a.id = ? AND (r.read_at < a.created_at OR r.read_at > ? OR u.role = 'client' OR u.status <> 'active')`)
        .get(a.id, nowISO()) as { n: number }; // the seed writes business-clock times
      assert.equal(Number(bad.n), 0, `${a.title}: every read after the post, before now, by active staff`);
    }

    // The office: the owner has read the older posts; the update and the change to approve are new
    assert.equal((await owner.get('/client-posts/unread')).json.count, 2);
    const items = ((await owner.get('/me/attention')).json.items as Json[]).filter((i) => i.kind === 'client');
    assert.deepEqual(items.map((i) => i.severity).sort(), ['info', 'warning']);
    assert.ok(items.some((i) => i.key === `client:commission:${pending.id}` && i.title === 'Breast Cancer Now asks to change commission'));
    const leader = await demo.login('leader');
    assert.equal((await leader.get('/client-posts/unread')).json.count, 3, 'the leader has read the announcement only');

    // The campaign page: the brief for everyone, the money for the office
    const rep = await demo.login('rep');
    const page = (await rep.get(`/campaigns/${bcn}/page`)).json;
    assert.equal(page.campaign.contactName, null, 'the client contact is for the office');
    assert.equal(page.campaign.brief, CAMPAIGN_BRIEFS.BCN!.brief);
    assert.ok(!('payoutPerSale' in page.campaign));
    assert.deepEqual(page.posts.map((p: Json) => p.kind).sort(), ['announcement', 'update']);
    const full = (await owner.get(`/campaigns/${bcn}/page`)).json;
    assert.equal(full.campaign.contactName, 'Hannah Price');
    assert.equal(full.campaign.contactPhone, CAMPAIGN_BRIEFS.BCN!.contactPhone);
    assert.equal(full.clientAccounts.length, 1);
    assert.equal(full.clientAccounts[0].accessCode, 'CL-0001');
    assert.equal(full.clientAccounts[0].hasPin, false);
    for (const code of ['CHN', 'VLT', 'FCB']) {
      const row = db.prepare(`SELECT contact_name AS n, long_description AS d FROM campaigns WHERE code = ?`).get(code) as { n: string; d: string };
      assert.equal(row.n, CAMPAIGN_BRIEFS[code]!.contactName);
      assert.ok(row.d.length > 80);
    }
    // Every demo timestamp is in the past of the seed's clock
    const latest = (db.prepare(`SELECT MAX(created_at) AS m FROM client_posts`).get() as { m: string }).m;
    assert.ok(latest <= nowISO());

    // Once the demo account is edited it is an ordinary client: a PIN is required
    const hannahId = Number((db.prepare(`SELECT id FROM users WHERE employee_id = 'CL-0001'`).get() as { id: number }).id);
    assert.equal(clientPinRequired(db, hannahId), false);
    db.prepare(`UPDATE users SET email = 'h.price@breastcancernow.example' WHERE id = ?`).run(hannahId);
    assert.equal(clientPinRequired(db, hannahId), true);
    assert.equal(pinStatusFor(db, hannahId)!.required, true);
    const signIn = await demo.anon().post('/auth/login', { email: 'h.price@breastcancernow.example', employeeId: 'CL-0001' });
    assert.equal(signIn.json.user.pinSetupRequired, true);
    assert.equal(clientPinRequired(db, Number((db.prepare(`SELECT id FROM users WHERE employee_id = 'LM-0010'`).get() as { id: number }).id)), false, 'staff: the admin decides');
  } finally {
    await demo.close();
  }
});

// ───────────────────────────── the seed helper ─────────────────────────────

/** A fresh database with the core demo rows only (no extension seeds), on a pinned business clock. */
function coreDb(): { db: Db; today: string; nowIso: string } {
  setBusinessClock(new Date('2026-10-21T15:00:00'));
  const db = openDb(':memory:');
  createSchema(db);
  const today = '2026-10-21';
  seed(db, today, { extensionSeeds: false });
  return { db, today, nowIso: nowISO() };
}

function ctxOf(db: Db, today: string, nowIso: string) {
  const users = db.prepare(`SELECT id, employee_id AS employeeId, first_name AS firstName, last_name AS lastName, role, position, team_id AS teamId, status, start_date AS startDate FROM users WHERE role <> 'client'`).all() as never[];
  const clients = db.prepare(`SELECT id, employee_id AS employeeId, first_name AS firstName, last_name AS lastName, email, client_campaign_id AS campaignId FROM users WHERE role = 'client'`).all() as never[];
  const campaigns = db.prepare(`SELECT id, code, name FROM campaigns ORDER BY id`).all() as never[];
  return { today, nowIso, users, clients, campaigns };
}

test('seed: hand-checked dates of the demo posts on Wed 21 Oct 2026, and a client rate in the pay history gets its approved post', () => {
  const { db, today, nowIso } = coreDb();
  try {
    const bcn = Number((db.prepare(`SELECT id FROM campaigns WHERE code = 'BCN'`).get() as { id: number }).id);
    // P1's demo history: BCN's rate changed at a client's request on Thu 10 Sep 2026 (six weeks before this Monday, a
    // Thursday). Once P1's core seed writes that row itself it is used as it is; until then the test writes it.
    const existing = db.prepare(`SELECT id FROM campaign_rates WHERE campaign_id = ? AND source = 'client'`).all(bcn) as { id: number }[];
    assert.ok(existing.length <= 1);
    const rateId = existing[0]?.id ?? Number(
      db.prepare(`INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 20, 120, '2026-09-10', 'client', NULL, NULL, ?)`)
        .run(bcn, nowIso).lastInsertRowid,
    );
    seedClientDemo(db, ctxOf(db, today, nowIso));
    const posts = db.prepare(`SELECT id, kind, status, effective_from AS effectiveFrom, created_at AS createdAt, decided_at AS decidedAt, rate_rep AS rateRep FROM client_posts ORDER BY created_at`).all() as Json[];
    assert.deepEqual(posts.map((p) => `${p.kind}:${p.status}`), ['commission:approved', 'commission:declined', 'announcement:published', 'update:published', 'commission:pending']);
    const [approved, declined, walk, update, pending] = posts;
    // approved: posted 6 days before 10 Sep (Fri 4 Sep), decided 3 days before (Mon 7 Sep), linked to the rate row
    assert.equal(approved.effectiveFrom, '2026-09-10');
    assert.equal(approved.createdAt.slice(0, 10), '2026-09-04');
    assert.equal(approved.decidedAt.slice(0, 10), '2026-09-07');
    assert.equal(approved.rateRep, 20);
    assert.equal((db.prepare(`SELECT client_post_id AS p FROM campaign_rates WHERE id = ?`).get(rateId) as { p: number }).p, approved.id);
    // declined: posted 24 days before (Sun 27 Sep), asking from the Monday of that week + 70 days (Mon 30 Nov)
    assert.equal(declined.createdAt.slice(0, 10), '2026-09-27');
    assert.equal(declined.effectiveFrom, '2026-11-30');
    assert.equal(declined.decidedAt.slice(0, 10), '2026-09-29');
    assert.equal(walk.createdAt.slice(0, 10), '2026-10-12', 'nine days before');
    assert.equal(update.createdAt.slice(0, 10), '2026-10-18', 'three days before');
    // pending: yesterday, from the Monday after next (19 Oct + 14 = Mon 2 Nov)
    assert.equal(pending.createdAt.slice(0, 10), '2026-10-20');
    assert.equal(pending.effectiveFrom, '2026-11-02');
    assert.ok(posts.every((p) => p.createdAt <= nowIso));
    // read receipts: the owner the declined, the walk and the approved one; each leader the walk
    const owner = Number((db.prepare(`SELECT id FROM users WHERE employee_id = 'LM-0001'`).get() as { id: number }).id);
    const ownerRead = (db.prepare(`SELECT post_id AS p FROM client_post_reads WHERE user_id = ? ORDER BY post_id`).all(owner) as { p: number }[]).map((r) => r.p);
    assert.deepEqual(ownerRead, [declined.id, walk.id, approved.id].sort((a, b) => a - b));
    const leaders = Number((db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'leader' AND status = 'active'`).get() as { n: number }).n);
    assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM client_post_reads WHERE post_id = ?`).get(walk.id) as { n: number }).n), leaders + 1);
    // the two published posts are in Announcements, written by Hannah
    const anns = db.prepare(`SELECT a.title, u.role FROM announcements a JOIN users u ON u.id = a.author_id WHERE u.role = 'client'`).all() as Json[];
    assert.equal(anns.length, 2);
  } finally {
    db.close();
    setBusinessClock(null);
  }
});

test('seed: no demo client, no posts (an extension seed never invents a client account); the briefs still fill', () => {
  const { db, today, nowIso } = coreDb();
  try {
    db.prepare(`DELETE FROM users WHERE role = 'client'`).run();
    seedClientDemo(db, ctxOf(db, today, nowIso));
    assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM client_posts`).get() as { n: number }).n), 0);
    assert.equal((db.prepare(`SELECT contact_email AS e FROM campaigns WHERE code = 'VLT'`).get() as { e: string }).e, 'tom.ashworth@voltenergy.example');
  } finally {
    db.close();
    setBusinessClock(null);
  }
});

// ───────────────────────────── upgrades ─────────────────────────────

test('upgrade: a database from the foundation commit gains requested_from, posted_at and the read receipts once, keeping its posts', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    // the foundation's shape: client_posts without requested_from and posted_at, no client_post_reads
    db.exec(`DROP TABLE client_post_reads`);
    db.exec(`ALTER TABLE client_posts DROP COLUMN requested_from`);
    db.exec(`ALTER TABLE client_posts DROP COLUMN posted_at`);
    // a client account needs a pay plan to attach to (lib/client.ts clientPayPlanId)
    db.prepare(`INSERT INTO pay_plans (name, position, base_per_day, commission_per_sale, bonus_threshold, bonus_amount, override_per_team_sale) VALUES ('Owner', 'owner', 0, 0, 0, 0, 0)`).run();
    const cid = Number(db.prepare(`INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date) VALUES ('C', 'CCC', 'charity', 'fundraising', 100, 20, '#123456', 1, '2026-01-05')`).run().lastInsertRowid);
    const uid = addClientUser(db, { campaignId: cid, email: 'old@client.test' });
    db.prepare(`INSERT INTO client_posts (campaign_id, author_id, kind, title, body, status, created_at) VALUES (?, ?, 'update', 'Kept', 'b', 'published', '2026-10-01T10:00:00.000Z')`).run(cid, uid);
    assert.ok(!columnsOf(db, 'client_posts').includes('requested_from'));
    const changed = upgradeExtensions(db).filter((n) => n.startsWith('client:'));
    assert.deepEqual(changed, ['client:client_posts.requested_from', 'client:client_posts.posted_at'], 'the client extension reports only the columns it added');
    assert.ok(columnsOf(db, 'client_posts').includes('posted_at'));
    assert.ok(columnsOf(db, 'client_post_reads').includes('post_id'), 'the read receipts table exists');
    assert.deepEqual(upgradeExtensions(db).filter((n) => n.startsWith('client:')), [], 'once');
    assert.equal((db.prepare(`SELECT title FROM client_posts`).get() as { title: string }).title, 'Kept');
  } finally {
    db.close();
  }
});
