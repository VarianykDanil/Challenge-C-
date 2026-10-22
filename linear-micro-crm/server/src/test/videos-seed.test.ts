/**
 * P5 learning-videos on the full demo seed: three example LINK videos (marked as examples, no file), viewing for the
 * demo people (Jordan Lee watched the required one and is a third through another; Amelia Hart's team view), the
 * demo client sees none of it; and a database made at the foundation commit gains the P5 columns once.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.ts';
import { extension } from '../db/extensions/videos.ts';
import { columnsOf } from '../db/extensions/types.ts';
import { configureMediaRoot } from '../lib/videos/files.ts';
import { startTestServer, type Json, type TestServer } from './helpers.ts';

const mediaRoot = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-seed-'));
configureMediaRoot(mediaRoot);
let srv: TestServer;

before(async () => {
  srv = await startTestServer({ seed: true });
});
after(async () => {
  await srv.close();
  configureMediaRoot(null);
  rmSync(mediaRoot, { recursive: true, force: true });
});

test('the demo has three example link videos, two of them required, and no uploaded file', () => {
  const rows = srv.db.prepare(`SELECT title, kind, url, file_path AS filePath, example, required, audience, topic, duration_s AS d FROM learning_videos ORDER BY id`).all() as Json[];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.kind === 'link' && r.example === 1 && r.filePath === null && /^https:\/\/www\.youtube\.com\/watch\?v=/.test(r.url)));
  assert.deepEqual(rows.map((r) => [r.topic, r.audience, r.required, r.d]), [
    ['pitching', 'everyone', 1, 598],
    ['interviews', 'everyone', 0, 1262],
    ['leadership', 'leaders', 1, 1084],
  ]);
  assert.equal(srv.db.prepare(`SELECT value FROM meta WHERE key = 'ext:videos:leaders_can_add'`).get(), undefined, 'leaders may not add until Matt says so');
  const clientViews = srv.db.prepare(`SELECT COUNT(*) AS n FROM video_views vv JOIN users u ON u.id = vv.user_id WHERE u.role = 'client'`).get() as { n: number };
  assert.equal(clientViews.n, 0);
});

test('Jordan Lee (demo rep): the two videos for everyone, one watched, one a third of the way through', async () => {
  const rep = await srv.login('rep');
  const list = (await rep.get('/videos')).json as Json[];
  assert.deepEqual(list.map((v) => v.title).sort(), ['How to speak so that people want to listen', 'Your body language may shape who you are']);
  assert.ok(list.every((v) => v.example === true && v.provider === 'youtube' && v.thumbnailUrl?.startsWith('https://i.ytimg.com/')));
  const speak = list.find((v) => v.required);
  assert.ok(speak.my.completedAt, 'watched');
  assert.equal(speak.my.watchedS, 598);
  const body = list.find((v) => !v.required);
  // 1,262 × 0.34 = 429.08 → 429 s seen, resume there
  assert.equal(body.my.watchedS, 429);
  assert.equal(body.my.positionS, 429);
  assert.equal(body.my.completedAt, null);
  assert.equal((await rep.get('/videos/team')).status, 403);
  const client = await srv.login('client');
  assert.equal((await client.get('/videos')).status, 403);
});

test('Amelia Hart (demo leader): her team’s required videos; she still has the leaders’ one to finish', async () => {
  const leader = await srv.login('leader');
  const team = (await leader.get('/videos/team')).json;
  assert.equal(team.required, 2);
  const me = team.rows.find((r: Json) => r.userName === 'Amelia Hart');
  assert.deepEqual({ total: me.requiredTotal, watched: me.watchedRequired }, { total: 2, watched: 1 });
  const leadersTalk = me.cells.find((c: Json) => c.videoId === team.videos.find((v: Json) => v.audience === 'leaders').id);
  assert.equal(leadersTalk.watchedS, 542, '1,084 × 0.5 = 542 s');
  assert.equal(leadersTalk.completedAt, null);
  const jordan = team.rows.find((r: Json) => r.userName === 'Jordan Lee');
  assert.deepEqual({ total: jordan.requiredTotal, watched: jordan.watchedRequired }, { total: 1, watched: 1 });
  assert.ok(team.rows.length > 3);
  const admin = await srv.login('admin');
  const everyone = (await admin.get('/videos/team')).json;
  assert.ok(everyone.rows.length > team.rows.length);
  assert.ok(!everyone.rows.some((r: Json) => r.userName === 'Hannah Price'), 'never the demo client');
  const views = (await admin.get(`/videos/${team.videos[0].id}/views`)).json as Json[];
  assert.ok(views.length > 0 && views.every((v) => v.marked === false), 'the demo was watched, not ticked');
});

test('a database made at the foundation commit gains the P5 columns once', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
    db.exec(`CREATE TABLE learning_videos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT 'other',
      kind TEXT NOT NULL, url TEXT, file_path TEXT, mime TEXT, size INTEGER, duration_s INTEGER, required INTEGER NOT NULL DEFAULT 0,
      audience TEXT NOT NULL DEFAULT 'everyone', example INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE video_views (video_id INTEGER NOT NULL, user_id INTEGER NOT NULL, watched_s INTEGER NOT NULL DEFAULT 0, position_s INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT, last_at TEXT, PRIMARY KEY (video_id, user_id))`);
    db.exec(`INSERT INTO users (id) VALUES (1)`);
    db.exec(`INSERT INTO learning_videos (title, kind, url, created_at) VALUES ('Kept', 'link', 'https://youtu.be/eIho2S0ZahI', '2026-10-01T09:00:00Z')`);
    db.exec(`INSERT INTO video_views (video_id, user_id, watched_s, completed_at, last_at) VALUES (1, 1, 540, '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z')`);
    db.exec(extension.sql);
    assert.deepEqual(extension.upgrade(db), ['learning_videos.poster_path', 'video_views.ranges', 'video_views.marked', 'video_views.credit_s', 'video_views.credit_at']);
    assert.deepEqual(extension.upgrade(db), [], 'the second start changes nothing');
    assert.ok(columnsOf(db, 'learning_videos').includes('poster_path'));
    for (const c of ['ranges', 'marked', 'credit_s', 'credit_at']) assert.ok(columnsOf(db, 'video_views').includes(c), c);
    // the viewing kept: watched by watching (not marked), no credit used yet (a first report gets the full credit)
    assert.deepEqual({ ...(db.prepare(`SELECT watched_s AS w, completed_at AS c, marked AS m, credit_s AS cs, credit_at AS ca FROM video_views`).get() as object) }, {
      w: 540,
      c: '2026-10-02T09:00:00Z',
      m: 0,
      cs: null,
      ca: null,
    });
    assert.equal((db.prepare(`SELECT title FROM learning_videos`).get() as { title: string }).title, 'Kept');
    // a fresh database has them from the CREATE statements: nothing to add
    const fresh = openDb(':memory:');
    fresh.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
    fresh.exec(extension.sql);
    assert.deepEqual(extension.upgrade(fresh), []);
    fresh.close();
  } finally {
    db.close();
  }
});
