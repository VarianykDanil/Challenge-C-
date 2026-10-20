/**
 * Release 1.2 — L2 learning-pitch: /pitches routes, role rules, the BCN seed in `seed` and `upgrade`.
 * Assert shapes and scoping; the demo seed's dates move with today, the pitch text does not.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePitchFacts, parsePitchScript, type CampaignPitch, type PitchListItem } from '@lm/shared';
import { openDb } from '../db/connection.ts';
import { BCN_PITCH_BODY, BCN_PITCH_FACTS, BCN_PITCH_TITLE } from '../db/extensions/pitches.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { todayISO } from '../lib/dates.ts';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

describe('pitches on the small fixture', () => {
  let srv: TestServer;
  let admin: TestClient;
  let leader: TestClient;
  let rep: TestClient;
  let recruiter: TestClient;

  before(async () => {
    srv = await startTestServer();
    [admin, leader, rep, recruiter] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('rep'), srv.login('recruiter')]);
  });
  after(async () => {
    await srv.close();
  });

  test('anonymous → 401 on every pitch path', async () => {
    const anon = srv.anon();
    assert.equal((await anon.get('/pitches')).status, 401);
    assert.equal((await anon.get('/pitches/FXC')).status, 401);
    assert.equal((await anon.put('/pitches/FXC', { title: 'x', body: 'y' })).status, 401);
  });

  test('list: one row per campaign, no pitch yet, every role reads it', async () => {
    for (const c of [admin, leader, rep, recruiter]) {
      const r = await c.get('/pitches');
      assert.equal(r.status, 200);
      const rows = r.json as PitchListItem[];
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        campaignId: srv.fixture!.campaignId,
        campaignCode: 'FXC',
        campaignName: 'Fixture Charity',
        campaignColor: '#DB2777',
        campaignActive: true,
        hasPitch: false,
        title: null,
        updatedAt: null,
      });
    }
  });

  test('detail: 404 "Pitch not found" for a campaign without one, "Campaign not found" for an unknown or malformed code', async () => {
    const none = await rep.get('/pitches/FXC');
    assert.equal(none.status, 404);
    assert.equal(none.json.error, 'Pitch not found');
    for (const code of ['NOPE', 'x', 'TOOLONGCODE', '..%2F']) {
      const r = await rep.get(`/pitches/${code}`);
      assert.equal(r.status, 404, code);
      assert.equal(r.json.error, 'Campaign not found', code);
    }
  });

  test('PUT: reps and recruiters may not write; an unknown campaign is 404', async () => {
    assert.equal((await rep.put('/pitches/FXC', { title: 'Mine', body: 'Hello' })).status, 403);
    assert.equal((await recruiter.put('/pitches/FXC', { title: 'Mine', body: 'Hello' })).status, 403);
    assert.equal((await admin.put('/pitches/NOPE', { title: 'Mine', body: 'Hello' })).status, 404);
  });

  test('PUT: validation — title and body required, limits enforced', async () => {
    const bad = [
      {},
      { title: '', body: 'Hello' },
      { title: '   ', body: 'Hello' },
      { title: 'Ok', body: '  \n ' },
      { title: 'x'.repeat(121), body: 'Hello' },
      { title: 'Ok', body: 'x'.repeat(20_001) },
      { title: 'Ok', body: 'Hello', facts: 'x'.repeat(10_001) },
      { title: 'Ok', body: 42 },
    ];
    for (const b of bad) {
      const r = await leader.put('/pitches/FXC', b);
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 60));
      assert.equal(r.json.error, 'Validation failed');
    }
    assert.equal((await rep.get('/pitches/FXC')).status, 404, 'nothing was saved');
  });

  test('PUT: a leader creates (201), everyone reads it, the list shows it; CRLF and padding are normalised', async () => {
    await rep.get('/pitches');
    assert.equal((await rep.get('/pitches')).headers.get('x-cache'), 'HIT', 'the list is cached');
    const created = await leader.put('/pitches/fxc', { title: '  Fixture   pitch ', body: '\r\nHello there\r\n(Pause)\r\nYes - great\r\n\r\n', facts: '- "Hello there": fine.' });
    assert.equal(created.status, 201);
    const p = created.json as CampaignPitch;
    assert.equal(p.campaignCode, 'FXC');
    assert.equal(p.campaignId, srv.fixture!.campaignId);
    assert.equal(p.title, 'Fixture pitch');
    assert.equal(p.body, 'Hello there\n(Pause)\nYes - great');
    assert.equal(p.facts, '- "Hello there": fine.');
    assert.equal(p.updatedBy, srv.fixture!.users.leader);
    assert.equal(p.updatedByName, 'Lee Leader');
    assert.match(p.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof p.id, 'number');

    for (const c of [rep, recruiter, admin]) {
      const r = await c.get('/pitches/FXC');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, p);
    }
    const list = await rep.get('/pitches');
    assert.equal(list.headers.get('x-cache'), 'MISS', 'the write invalidated the cached list');
    assert.equal((list.json as PitchListItem[])[0]!.hasPitch, true);
    assert.equal((list.json as PitchListItem[])[0]!.title, 'Fixture pitch');
    assert.equal((list.json as PitchListItem[])[0]!.updatedAt, p.updatedAt);
  });

  test('PUT: an admin replaces (200); facts left out are kept, null or blank clears them', async () => {
    const kept = await admin.put('/pitches/FXC', { title: 'Fixture pitch v2', body: 'Hi again' });
    assert.equal(kept.status, 200);
    assert.equal(kept.json.title, 'Fixture pitch v2');
    assert.equal(kept.json.body, 'Hi again');
    assert.equal(kept.json.facts, '- "Hello there": fine.');
    assert.equal(kept.json.updatedBy, srv.fixture!.users.admin);
    assert.equal(kept.json.updatedByName, 'Ada Admin');

    const blank = await admin.put('/pitches/FXC', { title: 'v3', body: 'Hi', facts: '   ' });
    assert.equal(blank.json.facts, null);
    await admin.put('/pitches/FXC', { title: 'v4', body: 'Hi', facts: 'note' });
    const cleared = await admin.put('/pitches/FXC', { title: 'v5', body: 'Hi', facts: null });
    assert.equal(cleared.json.facts, null);
    const rows = srv.db.prepare(`SELECT COUNT(*) AS n FROM campaign_pitches`).get() as { n: number };
    assert.equal(Number(rows.n), 1, 'one pitch per campaign');
  });

  test('a pitch never creates gauge rows or payroll runs', () => {
    const n = (t: string) => Number((srv.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    assert.equal(n('gauge_entries'), 0);
    assert.equal(n('payroll_runs'), 0);
  });
});

describe('the BCN pitch in the demo seed', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ seed: true });
  });
  after(async () => {
    await srv.close();
  });

  test('every role reads the owner\'s BCN pitch word for word, with its fact-check notes; other campaigns have none', async () => {
    for (const role of ['admin', 'leader', 'recruiter', 'rep'] as const) {
      const c = await srv.login(role);
      const r = await c.get('/pitches/bcn');
      assert.equal(r.status, 200, role);
      const p = r.json as CampaignPitch;
      assert.equal(p.campaignCode, 'BCN');
      assert.equal(p.campaignName, 'Breast Cancer Now');
      assert.equal(p.title, BCN_PITCH_TITLE);
      assert.equal(p.body, BCN_PITCH_BODY);
      assert.equal(p.facts, BCN_PITCH_FACTS);
      assert.equal(p.updatedByName, 'Danil Varianyk');
      const list = (await c.get('/pitches')).json as PitchListItem[];
      assert.deepEqual(list.filter((x) => x.hasPitch).map((x) => x.campaignCode), ['BCN']);
      assert.ok(list.length >= 4);
      const firstInactive = list.findIndex((x) => !x.campaignActive);
      if (firstInactive >= 0) assert.ok(list.slice(firstInactive).every((x) => !x.campaignActive), 'active campaigns first');
    }
  });

  test('the seeded pitch parses: a Yes / No branch, 19 spoken lines, four fact notes matched to their lines', () => {
    const s = parsePitchScript(BCN_PITCH_BODY);
    assert.equal(s.lineCount, 19);
    assert.equal(s.blocks.filter((b) => b.kind === 'branch').length, 1);
    const facts = parsePitchFacts(BCN_PITCH_FACTS, BCN_PITCH_BODY);
    assert.deepEqual(facts.map((f) => f.lines), [[1, 4], [22], [24], []]);
  });
});

test('upgrade adds the BCN pitch once to an existing database that has none; a fresh install leaves it to the seed', () => {
  const db = openDb(':memory:');
  try {
    // An existing 1.1 database: seeded without the extension seeds, so no pitch and no flag.
    createSchema(db);
    seed(db, todayISO(), { extensionSeeds: false });
    db.prepare(`DELETE FROM meta WHERE key LIKE 'ext:pitches:%'`).run();
    assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM campaign_pitches`).get() as { n: number }).n), 0);
    assert.deepEqual(createSchema(db), ['pitches:campaign_pitches.bcn']);
    const row = db.prepare(`SELECT p.title, p.body, p.facts, c.code, u.position FROM campaign_pitches p JOIN campaigns c ON c.id = p.campaign_id LEFT JOIN users u ON u.id = p.updated_by`).get() as Record<string, unknown>;
    assert.equal(row.code, 'BCN');
    assert.equal(row.body, BCN_PITCH_BODY);
    assert.equal(row.facts, BCN_PITCH_FACTS);
    assert.equal(row.position, 'owner');
    assert.deepEqual(createSchema(db), [], 'runs once');
    // Edited later by the office: a restart never puts the original back.
    db.prepare(`UPDATE campaign_pitches SET body = 'Edited'`).run();
    db.prepare(`DELETE FROM meta WHERE key LIKE 'ext:pitches:%'`).run();
    assert.deepEqual(createSchema(db), [], 'INSERT OR IGNORE: an existing pitch is never replaced');
    assert.equal((db.prepare(`SELECT body FROM campaign_pitches`).get() as { body: string }).body, 'Edited');
  } finally {
    db.close();
  }

  const fresh = openDb(':memory:');
  try {
    createSchema(fresh);
    assert.equal(fresh.prepare(`SELECT 1 FROM meta WHERE key LIKE 'ext:pitches:%'`).get(), undefined, 'no flag on an empty database');
    seed(fresh, todayISO());
    assert.equal(Number((fresh.prepare(`SELECT COUNT(*) AS n FROM campaign_pitches`).get() as { n: number }).n), 1);
    assert.deepEqual(createSchema(fresh), []);
  } finally {
    fresh.close();
  }
});
