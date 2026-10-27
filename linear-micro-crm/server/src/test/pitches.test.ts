/**
 * Release 1.2 — L2 learning-pitch: /pitches routes, role rules, the BCN seed in `seed` and `upgrade`.
 * Assert shapes and scoping; the demo seed's dates move with today, the pitch text does not.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePitchFacts, parsePitchScript, pitchFactFlags, pitchLinesToCheck, type CampaignPitch, type PitchListItem } from '@lm/shared';
import { openDb } from '../db/connection.ts';
import { BCN_PITCH_BODY, BCN_PITCH_FACTS, BCN_PITCH_FACTS_V1, BCN_PITCH_TITLE } from '../db/extensions/pitches.ts';
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

  test('PUT: a leader may not write fact-check notes on a new pitch (403, nothing saved)', async () => {
    for (const facts of ['- "Hello there": fine.', 'a general note']) {
      const r = await leader.put('/pitches/FXC', { title: 'Fixture pitch', body: 'Hello there', facts });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'Only the office can change the fact-check notes');
    }
    assert.equal((await rep.get('/pitches/FXC')).status, 404, 'nothing was saved');
  });

  test('PUT: a leader creates (201), everyone reads it, the list shows it; CRLF and padding are normalised', async () => {
    await rep.get('/pitches');
    assert.equal((await rep.get('/pitches')).headers.get('x-cache'), 'HIT', 'the list is cached');
    // No notes yet: a blank or null `facts` from a leader changes nothing, so it is allowed.
    const created = await leader.put('/pitches/fxc', { title: '  Fixture   pitch ', body: '\r\nHello there\r\n(Pause)\r\nYes - great\r\n\r\n', facts: '  ' });
    assert.equal(created.status, 201);
    const p = created.json as CampaignPitch;
    assert.equal(p.campaignCode, 'FXC');
    assert.equal(p.campaignId, srv.fixture!.campaignId);
    assert.equal(p.title, 'Fixture pitch');
    assert.equal(p.body, 'Hello there\n(Pause)\nYes - great');
    assert.equal(p.facts, null);
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

  test('PUT: the office writes the notes; a leader edits the title and script but a change to the notes is 403', async () => {
    const office = await admin.put('/pitches/FXC', { title: 'Fixture pitch', body: 'Hello there\n(Pause)\nYes - great', facts: '- "Hello there": fine.' });
    assert.equal(office.status, 200);
    assert.equal(office.json.facts, '- "Hello there": fine.');
    assert.equal(office.json.updatedBy, srv.fixture!.users.admin);

    // Notes left out, or sent back unchanged (CRLF and padding aside), are kept: the leader's title and script save.
    const omitted = await leader.put('/pitches/FXC', { title: 'Fixture pitch v1', body: 'Hello there, leader' });
    assert.equal(omitted.status, 200);
    assert.equal(omitted.json.title, 'Fixture pitch v1');
    assert.equal(omitted.json.facts, '- "Hello there": fine.');
    assert.equal(omitted.json.updatedBy, srv.fixture!.users.leader);
    const same = await leader.put('/pitches/FXC', { title: 'Fixture pitch v1b', body: 'Hello there, leader', facts: '\r\n- "Hello there": fine.\r\n ' });
    assert.equal(same.status, 200);
    assert.equal(same.json.facts, '- "Hello there": fine.');

    // Any change to the notes, clearing them included, is refused and nothing is saved.
    for (const facts of ['- "Hello there": wrong.', null, '   ', '']) {
      const r = await leader.put('/pitches/FXC', { title: 'Sneaky', body: 'Changed', facts });
      assert.equal(r.status, 403, JSON.stringify(facts));
      assert.equal(r.json.error, 'Only the office can change the fact-check notes');
    }
    const now = (await rep.get('/pitches/FXC')).json as CampaignPitch;
    assert.equal(now.title, 'Fixture pitch v1b');
    assert.equal(now.body, 'Hello there, leader');
    assert.equal(now.facts, '- "Hello there": fine.');
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
      assert.equal(p.updatedByName, 'Morgan Blake');
      const list = (await c.get('/pitches')).json as PitchListItem[];
      assert.deepEqual(list.filter((x) => x.hasPitch).map((x) => x.campaignCode), ['BCN']);
      assert.ok(list.length >= 4);
      const firstInactive = list.findIndex((x) => !x.campaignActive);
      if (firstInactive >= 0) assert.ok(list.slice(firstInactive).every((x) => !x.campaignActive), 'active campaigns first');
    }
  });

  test('the seeded pitch parses: a Yes / No branch, 19 spoken lines, one fact note per quoted line', () => {
    const s = parsePitchScript(BCN_PITCH_BODY);
    assert.equal(s.lineCount, 19);
    assert.equal(s.blocks.filter((b) => b.kind === 'branch').length, 1);
    const facts = parsePitchFacts(BCN_PITCH_FACTS, BCN_PITCH_BODY);
    assert.deepEqual(facts.map((f) => f.lines), [[1], [4], [20], [22], [24], [40], []], 'each note sits on its own line');
    assert.deepEqual(facts.map((f) => f.tone), ['check', 'check', 'check', 'verified', 'check', 'check', 'info']);
    assert.equal(facts[0]!.suggestion, 'Nearly 1,000 women are dying from breast cancer in the UK every month');
    assert.equal(facts[1]!.suggestion, "That's every 45 minutes someone is losing a mother, a daughter or a wife");
    assert.deepEqual(facts.map((f) => f.suggestion != null), [true, true, false, false, false, false, false]);
    assert.equal(facts[0]!.sources[0], facts[1]!.sources[0], 'both figures cite the same Breast Cancer Now statement');
    assert.deepEqual(pitchFactFlags(facts).get(1)!.map((x) => x.fact.suggestion), [facts[0]!.suggestion]);
    assert.equal(pitchLinesToCheck(facts), 5);
    // The script is the owner's, word for word: the notes never change it.
    assert.ok(BCN_PITCH_BODY.startsWith('Over 1000 women are dying from breast cancer every month\n'));
    assert.ok(BCN_PITCH_BODY.includes("That's every 43 minutes someone is losing a mother, a daughter or a wife"));
  });
});

describe('the 1.2.0 → split fact check upgrade (ext:pitches:facts-v2)', () => {
  /** A demo database as 1.2.0 left it: the BCN pitch with the old merged notes, no facts-v2 flag. */
  function oldDatabase(edit?: (db: ReturnType<typeof openDb>) => void) {
    const db = openDb(':memory:');
    createSchema(db);
    seed(db, todayISO());
    db.prepare(`UPDATE campaign_pitches SET facts = ?`).run(BCN_PITCH_FACTS_V1);
    db.prepare(`DELETE FROM meta WHERE key = 'ext:pitches:facts-v2'`).run();
    edit?.(db);
    return db;
  }
  const row = (db: ReturnType<typeof openDb>) =>
    db.prepare(`SELECT title, body, facts, updated_by AS updatedBy, updated_at AS updatedAt FROM campaign_pitches`).get() as {
      title: string;
      body: string;
      facts: string | null;
      updatedBy: number | null;
      updatedAt: string;
    };
  const flagged = (db: ReturnType<typeof openDb>) => Boolean(db.prepare(`SELECT 1 FROM meta WHERE key = 'ext:pitches:facts-v2'`).get());

  test('a fresh seed has the split notes and the flag; a restart changes nothing', () => {
    const db = openDb(':memory:');
    try {
      createSchema(db);
      seed(db, todayISO());
      assert.equal(row(db).facts, BCN_PITCH_FACTS);
      assert.ok(flagged(db));
      assert.deepEqual(createSchema(db), []);
    } finally {
      db.close();
    }
  });

  test('an untouched seeded pitch gets the split notes once; who saved it and when stay as they were', () => {
    const db = oldDatabase();
    try {
      const before = row(db);
      assert.equal(before.facts, BCN_PITCH_FACTS_V1);
      assert.deepEqual(createSchema(db), ['pitches:campaign_pitches.bcn-facts-v2']);
      const after = row(db);
      assert.equal(after.facts, BCN_PITCH_FACTS);
      assert.equal(after.body, BCN_PITCH_BODY, 'the script is never changed');
      assert.equal(after.title, before.title);
      assert.equal(after.updatedBy, before.updatedBy);
      assert.equal(after.updatedAt, before.updatedAt);
      assert.ok(flagged(db));
      assert.deepEqual(createSchema(db), [], 'runs once');
      const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      const gauges = n('gauge_entries');
      const runs = n('payroll_runs');
      db.prepare(`UPDATE campaign_pitches SET facts = ?`).run(BCN_PITCH_FACTS_V1);
      db.prepare(`DELETE FROM meta WHERE key = 'ext:pitches:facts-v2'`).run();
      createSchema(db);
      assert.equal(n('gauge_entries'), gauges, 'no gauge rows as a side effect');
      assert.equal(n('payroll_runs'), runs, 'no payroll runs as a side effect');
    } finally {
      db.close();
    }
  });

  const edits: [string, (db: ReturnType<typeof openDb>) => void][] = [
    ['the script was edited', (db) => db.prepare(`UPDATE campaign_pitches SET body = body || '\nThank you'`).run()],
    ['the title was edited', (db) => db.prepare(`UPDATE campaign_pitches SET title = 'Our BCN pitch'`).run()],
    ['the notes were edited', (db) => db.prepare(`UPDATE campaign_pitches SET facts = facts || '\n- office note'`).run()],
    [
      'a leader saved it unchanged',
      (db) => db.prepare(`UPDATE campaign_pitches SET updated_by = (SELECT id FROM users WHERE role = 'leader' ORDER BY id LIMIT 1)`).run(),
    ],
  ];
  for (const [what, edit] of edits) {
    test(`a pitch a person edited is never touched: ${what}`, () => {
      const db = oldDatabase(edit);
      try {
        const before = row(db);
        assert.deepEqual(createSchema(db), []);
        assert.deepEqual(row(db), before);
        assert.ok(flagged(db), 'the step ran (and will not run again)');
      } finally {
        db.close();
      }
    });
  }

  test('a database without a BCN pitch skips the step without setting the flag', () => {
    const db = openDb(':memory:');
    try {
      createSchema(db);
      seed(db, todayISO(), { extensionSeeds: false });
      db.prepare(`DELETE FROM meta WHERE key LIKE 'ext:pitches:%'`).run();
      db.prepare(`UPDATE campaigns SET code = 'BCX' WHERE code = 'BCN'`).run();
      assert.deepEqual(createSchema(db), []);
      assert.ok(!flagged(db));
    } finally {
      db.close();
    }
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
