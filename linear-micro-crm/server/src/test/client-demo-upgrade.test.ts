/**
 * Release 1.3.1: the demo charity account (Hannah Price, Breast Cancer Now, CL-0001) on an OLDER demo database. A demo
 * database first seeded before 1.3 has no demo client, so nothing showed under the demo accounts; on start-up it gains
 * her once (db/extensions/client.ts addDemoClientAccount): the same row the fresh seed makes, the same marker, and her
 * demo posts. A fresh 1.3 seed is unchanged and a database the demo seed did not create never gains her.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { addDemoClientAccount, DEMO_CLIENT_STEP_KEY } from '../db/extensions/client.ts';
import { demoClientMarkers, isDemoClientAccount } from '../lib/client.ts';
import { demoTeamMarkers } from '../lib/demoTeams.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { buildFixture, startTestServer } from './helpers.ts';

/** How the server starts (index.ts): the demo-account steps may run. A maintenance command passes nothing. */
const START = { demoSteps: true } as const;

const TODAY = '2026-10-21';
const HANNAH = 'hannah.price@breastcancernow.example';
const count = (db: Db, sql: string, params: (string | number)[] = []) => Number(get<{ n: number }>(db, sql, params)!.n);
const flagOf = (db: Db) => get(db, `SELECT 1 FROM meta WHERE key = ?`, [DEMO_CLIENT_STEP_KEY]);

/** Hannah's user row without its id (the ids differ between a fresh seed and an upgraded database). */
function hannahRow(db: Db): Record<string, unknown> | undefined {
  const r = get<Record<string, unknown>>(
    db,
    `SELECT u.employee_id, u.email, u.first_name, u.last_name, u.role, u.position, u.team_id, u.start_date, u.status, u.phone,
            u.avatar_color, u.city, u.pin_hash, c.code AS campaign, pp.position AS plan
     FROM users u JOIN campaigns c ON c.id = u.client_campaign_id JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.role = 'client'`,
  );
  return r ? { ...r } : undefined;
}

/** Her portal posts in a stable, id-free shape. */
function postsOf(db: Db): Record<string, unknown>[] {
  return all<Record<string, unknown>>(
    db,
    `SELECT p.kind, p.title, p.status, p.rate_rep AS rateRep, p.rate_payout AS ratePayout, p.effective_from AS effectiveFrom,
            p.created_at AS createdAt, (p.announcement_id IS NOT NULL) AS published
     FROM client_posts p JOIN users u ON u.id = p.author_id WHERE u.email = ? ORDER BY p.created_at, p.title`,
    [HANNAH],
  ).map((r) => ({ ...r }));
}

function demo(options: Parameters<typeof seed>[2] = {}): Db {
  setBusinessClock(new Date(`${TODAY}T15:00:00`));
  const db = openDb(':memory:');
  createSchema(db, START);
  seed(db, TODAY, options);
  return db;
}

before(() => setBusinessClock(new Date(`${TODAY}T15:00:00`)));
after(() => setBusinessClock(null));

test('an older demo database (no demo client) gains the charity account and her posts once; a second start changes nothing', () => {
  const fresh = demo();
  const older = demo({ demoClients: false });
  try {
    assert.equal(hannahRow(older), undefined, 'a 1.2-shaped demo database has no demo client');
    assert.deepEqual(demoClientMarkers(older), []);
    const usersBefore = count(older, `SELECT COUNT(*) AS n FROM users`);

    assert.deepEqual(createSchema(older, START), ['client:demo-account'], 'reported once, under the extension');
    assert.deepEqual(hannahRow(older), hannahRow(fresh), 'the same row the fresh seed makes');
    assert.equal(count(older, `SELECT COUNT(*) AS n FROM users`), usersBefore + 1);
    const hannah = get<{ id: number; role: 'client'; email: string; employeeId: string }>(older, `SELECT id, role, email, employee_id AS employeeId FROM users WHERE email = ?`, [HANNAH])!;
    assert.deepEqual(demoClientMarkers(older), [{ id: hannah.id, employeeId: 'CL-0001', email: HANNAH }]);
    assert.equal(isDemoClientAccount(older, hannah), true, 'the demo one: no PIN needed, listed on the sign-in page');
    assert.ok(flagOf(older));

    // her demo posts, as the fresh seed makes them
    assert.deepEqual(postsOf(older), postsOf(fresh));
    assert.ok(postsOf(older).length >= 4, 'the declined and pending changes, an announcement and an update (and approved changes)');
    assert.equal(count(older, `SELECT COUNT(*) AS n FROM announcements WHERE author_id = ?`, [hannah.id]), 2, 'her two published posts in Announcements');
    assert.equal(count(older, `SELECT COUNT(*) AS n FROM client_posts WHERE status = 'pending'`), 1, 'one change waiting for Matt');
    assert.ok(count(older, `SELECT COUNT(*) AS n FROM client_post_reads`) > 0, 'the owner has read the older ones');

    // team Sapiens stays blank: no read flag or read receipt from the seven
    const blank = demoTeamMarkers(older).flatMap((m) => m.accounts.map((a) => a.id));
    assert.equal(blank.length, 7);
    const ids = blank.join(', ');
    assert.equal(count(older, `SELECT COUNT(*) AS n FROM client_post_reads WHERE user_id IN (${ids})`), 0);
    assert.equal(count(older, `SELECT COUNT(*) AS n FROM announcement_reads WHERE user_id IN (${ids})`), 0);

    const snapshot = () =>
      JSON.stringify([all(older, `SELECT * FROM users ORDER BY id`), all(older, `SELECT * FROM client_posts ORDER BY id`), all(older, `SELECT * FROM announcements ORDER BY id`)]);
    const once = snapshot();
    assert.deepEqual(createSchema(older, START), [], 'the second start reports nothing');
    assert.equal(snapshot(), once, 'and changes nothing');

    // turned into a real account later (new code and email, no marker): the step is done, she never comes back
    run(older, `DELETE FROM meta WHERE key = 'seed_demo_clients'`);
    run(older, `UPDATE users SET employee_id = 'CL-0007', email = 'h.price@breastcancernow.example' WHERE id = ?`, [hannah.id]);
    assert.deepEqual(createSchema(older, START), []);
    assert.equal(get(older, `SELECT 1 FROM users WHERE email = ? OR employee_id = 'CL-0001'`, [HANNAH]), undefined, 'once means once');
  } finally {
    fresh.close();
    older.close();
  }
});

test('a fresh demo seed is unchanged: Hannah once, a restart reports nothing and adds nothing', () => {
  const db = demo();
  try {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'client'`), 1);
    const posts = postsOf(db).length;
    assert.deepEqual(createSchema(db, START), []);
    assert.equal(addDemoClientAccount(db), false);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'client'`), 1);
    assert.equal(postsOf(db).length, posts);
  } finally {
    db.close();
  }
});

test('the campaign brief is filled only where it is still empty: nothing Matt typed is replaced', () => {
  const db = demo({ demoClients: false });
  try {
    run(db, `UPDATE campaigns SET long_description = NULL, brief = NULL, contact_name = NULL, contact_email = NULL, contact_phone = NULL`);
    run(db, `UPDATE campaigns SET brief = 'Our own brief' WHERE code = 'CHN'`);
    assert.deepEqual(createSchema(db, START), ['client:demo-account']);
    const briefs = Object.fromEntries(all<{ code: string; brief: string | null; contact: string | null }>(db, `SELECT code, brief, contact_name AS contact FROM campaigns`).map((c) => [c.code, c]));
    assert.ok(briefs.BCN!.brief && briefs.BCN!.contact, 'an empty brief gets the demo one');
    assert.equal(briefs.CHN!.brief, 'Our own brief');
    assert.equal(briefs.CHN!.contact, null, 'a campaign with anything typed in is left as it was');
  } finally {
    db.close();
  }
});

test('never on a database the demo seed did not create; skipped without the flag while the tables are empty; never over a real holder', () => {
  // the route-test fixture writes `seeded_at` but is not the demo seed
  const fx = openDb(':memory:');
  try {
    createSchema(fx, START);
    buildFixture(fx, TODAY);
    assert.ok(!createSchema(fx, START).includes('client:demo-account'));
    assert.equal(get(fx, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined);
    assert.equal(flagOf(fx), undefined, 'no flag: nothing was decided');
  } finally {
    fx.close();
  }
  // an empty demo database (the fresh-install upgrade before the seed): try again later
  const empty = openDb(':memory:');
  try {
    createSchema(empty, START);
    empty.exec(`INSERT INTO meta (key, value) VALUES ('seeded_at', 'x'), ('seed_today', '${TODAY}')`);
    assert.equal(addDemoClientAccount(empty), false);
    assert.equal(flagOf(empty), undefined);
  } finally {
    empty.close();
  }
  // someone already holds her access code (a real contact): left alone, and the step is done
  const held = demo({ demoClients: false });
  try {
    const chn = get<{ id: number }>(held, `SELECT id FROM campaigns WHERE code = 'CHN'`)!.id;
    const plan = get<{ id: number }>(held, `SELECT id FROM pay_plans WHERE position = 'owner'`)!.id;
    run(
      held,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, avatar_color, client_campaign_id)
       VALUES ('CL-0001', 'real.contact@chn.example', 'Real', 'Contact', 'client', 'client', NULL, ?, '2026-10-01', 'active', '#4F46E5', ?)`,
      [plan, chn],
    );
    assert.deepEqual(createSchema(held, START), []);
    assert.equal(get(held, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined);
    assert.deepEqual(demoClientMarkers(held), [], 'the real contact is never treated as the demo one');
    assert.ok(flagOf(held));
  } finally {
    held.close();
  }
  // no Breast Cancer Now campaign: skipped quietly
  const noBcn = demo({ demoClients: false });
  try {
    run(noBcn, `UPDATE campaigns SET code = 'BCX' WHERE code = 'BCN'`);
    assert.deepEqual(createSchema(noBcn, START), []);
    assert.equal(get(noBcn, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined);
  } finally {
    noBcn.close();
  }
});

test('a database in real use never gains her: LM_DEMO_ACCOUNTS=0 (later), the demo staff changed (never), BCN with a real client (never)', () => {
  // LM_DEMO_ACCOUNTS=0: the operator says real people use it — nothing now, and no flag (decided again on the next start)
  const off = demo({ demoClients: false });
  try {
    process.env.LM_DEMO_ACCOUNTS = '0';
    try {
      assert.ok(!createSchema(off, START).includes('client:demo-account'));
      assert.equal(get(off, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined);
      assert.equal(flagOf(off), undefined);
    } finally {
      delete process.env.LM_DEMO_ACCOUNTS;
    }
  } finally {
    off.close();
  }
  // the demo staff are gone or changed (a demo-born database now in real use): done for good, nothing added
  for (const change of [`UPDATE users SET status = 'left' WHERE employee_id = 'LM-0002'`, `UPDATE users SET role = 'leader' WHERE employee_id = 'LM-0010'`, `UPDATE users SET employee_id = 'LM-0901' WHERE employee_id = 'LM-0001'`]) {
    const live = demo({ demoClients: false });
    try {
      run(live, change);
      assert.deepEqual(createSchema(live, START), [], change);
      assert.equal(get(live, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined, change);
      assert.ok(flagOf(live), `${change}: the step is done`);
      run(live, `UPDATE users SET status = 'active', role = CASE employee_id WHEN 'LM-0010' THEN 'rep' ELSE role END`);
      assert.deepEqual(createSchema(live, START), [], 'and stays done');
    } finally {
      live.close();
    }
  }
  // Breast Cancer Now already has a client account (an invited contact): its portal never gets the demo posts
  const invited = demo({ demoClients: false });
  try {
    const bcn = get<{ id: number }>(invited, `SELECT id FROM campaigns WHERE code = 'BCN'`)!.id;
    const plan = get<{ id: number }>(invited, `SELECT id FROM pay_plans WHERE position = 'owner'`)!.id;
    run(
      invited,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, avatar_color, client_campaign_id)
       VALUES ('CL-0002', 'contact@bcn.example', 'Real', 'Contact', 'client', 'client', NULL, ?, '2026-10-01', 'active', '#4F46E5', ?)`,
      [plan, bcn],
    );
    assert.deepEqual(createSchema(invited, START), []);
    assert.equal(get(invited, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined);
    assert.equal(count(invited, `SELECT COUNT(*) AS n FROM client_posts`), 0, 'no demo posts beside the real contact');
    assert.ok(flagOf(invited));
  } finally {
    invited.close();
  }
});

test('a maintenance command never runs the demo steps: npm run pin:reset on an older demo database adds nobody', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-pinreset-'));
  const file = path.join(dir, 'linear.sqlite');
  try {
    const db = openDb(file);
    createSchema(db);
    seed(db, TODAY, { demoClients: false, demoTeams: false });
    db.close();
    // what pin:reset does to the schema: createSchema without the server's start option
    const check = openDb(file);
    assert.ok(!createSchema(check).some((c) => c === 'client:demo-account' || c === 'sapiens:team.sapiens'));
    check.close();
    // and the real command, with no LM_DEMO_ACCOUNTS in its environment
    const env: NodeJS.ProcessEnv = { ...process.env, DB_PATH: file, LM_APP_SECRET_FILE: path.join(dir, 'app-secret'), NODE_NO_WARNINGS: '1' };
    delete env.LM_DEMO_ACCOUNTS;
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'pinReset.ts'), 'morgan.blake@linearhub.example'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const after = openDb(file);
    try {
      assert.equal(get(after, `SELECT 1 FROM users WHERE email = ?`, [HANNAH]), undefined, 'no charity account');
      assert.equal(count(after, `SELECT COUNT(*) AS n FROM users WHERE employee_id BETWEEN 'LM-0101' AND 'LM-0107'`), 0, 'no Sapiens');
      assert.equal(flagOf(after), undefined, 'and the server decides on its next start');
      assert.deepEqual(createSchema(after, START).filter((c) => c.includes('demo-account') || c.includes('sapiens')), ['client:demo-account', 'sapiens:team.sapiens'], 'which it does');
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after the start-up step the sign-in page lists her under the charity accounts, and one click opens her portal', async () => {
  const srv = await startTestServer({ seed: true, seedOptions: { demoClients: false } });
  try {
    assert.ok(!('clientAccounts' in (await srv.anon().get('/auth/demo-accounts')).json), 'before: nothing under the demo accounts');
    assert.deepEqual(createSchema(srv.db, START), ['client:demo-account'], 'the next start');
    const r = await srv.anon().get('/auth/demo-accounts');
    assert.equal(r.json.accounts.length, 4, 'the four staff accounts as before');
    assert.deepEqual(r.json.clientAccounts, [{
      label: 'Hannah Price (Breast Cancer Now)', role: 'client', email: HANNAH, employeeId: 'CL-0001',
      name: 'Hannah Price', organisation: 'Breast Cancer Now', sector: 'charity',
    }]);
    const hannah = await srv.login({ email: HANNAH, employeeId: 'CL-0001' });
    const portal = await hannah.get('/client/portal');
    assert.equal(portal.status, 200);
    assert.equal(portal.json.campaign.name, 'Breast Cancer Now');
    assert.ok(portal.json.posts.length >= 4, 'her portal is not empty');
    assert.equal((await hannah.get('/dashboard')).status, 403, 'still the portal only');
    process.env.LM_DEMO_ACCOUNTS = '0';
    try {
      assert.deepEqual((await srv.anon().get('/auth/demo-accounts')).json, { accounts: [] });
    } finally {
      delete process.env.LM_DEMO_ACCOUNTS;
    }
  } finally {
    await srv.close();
  }
});
