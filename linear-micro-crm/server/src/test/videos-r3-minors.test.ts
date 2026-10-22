/**
 * P5 learning-videos, last fix round (re-review minors):
 *  - a viewing starts with a small watch credit (40 s, about two reports), so one report cannot make a short upload
 *    watched; the player's first report when it starts playing sets the credit's clock, so honest viewers lose nothing;
 *  - the answer says how much was seen but not counted yet (`owedS`), so the player sends again;
 *  - a link with no length of its own: a viewer's own reported length still decides their "watched", but it is stored
 *    as Marked (self-reported); once the link has a length, a viewing measured to 90% of it is a real watch;
 *  - progress reports have a per-person limit, and the ones in between no longer clear the whole response cache;
 *  - the side effects of a length arriving (the video's length set, other people counted as watched) are audited;
 *  - the room for an upload counts the uploads already arriving, and running out mid-upload says what to do.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_PROGRESS_PER_MINUTE, VIDEO_WATCH_CREDIT_START_S } from '@lm/shared';
import { currentDataVersion } from '../lib/cache.ts';
import { configureDiskSpace, configureMediaRoot, holdUploadRoom, uploadRoomBytes, VIDEO_DISK_FULL_MESSAGE } from '../lib/videos/files.ts';
import { configureProgressClock } from '../lib/videos/progress.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { sampleMp4, sampleWebm, uploadVideo } from './videoFixtures.ts';

const mediaRoot = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-minors-'));
configureMediaRoot(mediaRoot);
let clockMs = 2_000_000_000;
configureProgressClock(() => clockMs);
const tick = (seconds: number) => void (clockMs += seconds * 1000);

let srv: TestServer;
let admin: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
  rep = await srv.login('rep');
  repA2 = await srv.login('repA2');
  repB = await srv.login('repB');
});
after(async () => {
  await srv.close();
  configureMediaRoot(null);
  configureProgressClock(null);
  configureDiskSpace(null);
  rmSync(mediaRoot, { recursive: true, force: true });
});

async function addUpload(title: string, seconds: number | null): Promise<number> {
  const bytes = seconds === null ? sampleWebm() : sampleMp4({ timescale: 1000, duration: seconds * 1000 });
  const r = await uploadVideo(srv.base, admin, { fields: { title, topic: 'other', required: 'true' }, video: { bytes, name: seconds === null ? 'clip.webm' : 'clip.mp4', type: seconds === null ? 'video/webm' : 'video/mp4' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id as number;
}
const report = (who: TestClient, id: number, body: Json) => who.post(`/videos/${id}/progress`, body);

test('a short upload is not watched by one report: a viewing starts with a 40 s credit; the start report sets its clock', async () => {
  assert.equal(VIDEO_WATCH_CREDIT_START_S, 40);
  // the reviewer's case: a 100 s upload claimed in full by the first report (was 100 s, watched)
  const short = await addUpload('Hundred seconds', 100);
  let r = await report(rep, short, { watchedS: 100, positionS: 100, ranges: [[0, 100]] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.watchedS, r.json.completedAt, r.json.owedS], [40, null, 60], 'the rest is owed, not lost');
  // a 130 s upload: 40, not 120
  const longer = await addUpload('Hundred and thirty seconds', 130);
  r = await report(rep, longer, { watchedS: 130, ranges: [[0, 130]] });
  assert.deepEqual([r.json.watchedS, r.json.completedAt], [40, null]);
  // an honest viewer: the player reports when it starts (nothing seen yet), then every 15 s at normal speed
  const honest = await addUpload('Honest', 100);
  r = await report(repA2, honest, { watchedS: 0, positionS: 0 });
  assert.deepEqual([r.json.watchedS, r.json.owedS], [0, 0]);
  for (let t = 15; t <= 90; t += 15) {
    tick(15);
    r = await report(repA2, honest, { watchedS: t, positionS: t, ranges: [[0, t]] });
    assert.deepEqual([r.json.watchedS, r.json.owedS], [t, 0], `at ${t} s`);
  }
  assert.ok(r.json.completedAt, '90 of 100 s');
  // a viewer back after a long break starts a new viewing: 40 s again, never a banked two minutes
  tick(3600);
  const again = await addUpload('Again', 600);
  r = await report(repA2, again, { watchedS: 0 });
  tick(3600);
  r = await report(repA2, again, { watchedS: 600, ranges: [[0, 600]] });
  assert.equal(r.json.watchedS, 40);
});

test('a link with no length: a viewer’s own length still decides their "watched", stored as Marked; a measured watch once it has one', async () => {
  const link = await admin.post('/videos', { title: 'No length link', topic: 'pitching', url: 'https://vimeo.com/76979871' });
  assert.equal(link.status, 201, JSON.stringify(link.json));
  const id = link.json.id as number;
  assert.equal(link.json.durationS, null);
  tick(60);
  // the reviewer's report: {watchedS: 1, durationS: 1}
  let r = await report(rep, id, { watchedS: 1, durationS: 1 });
  assert.ok(r.json.completedAt);
  assert.equal(r.json.marked, true, 'self-reported: Marked, not Watched');
  assert.equal((await admin.get(`/videos/${id}`)).json.durationS, null, 'the link keeps no length');
  // a genuine viewer: 95 of what their player says is 100 s, over a few reports
  r = await report(repA2, id, { watchedS: 0, positionS: 0 });
  for (let t = 30; t <= 90; t += 30) {
    tick(15);
    r = await report(repA2, id, { watchedS: t, positionS: t, ranges: [[0, t]], durationS: 100 });
  }
  tick(15);
  r = await report(repA2, id, { watchedS: 95, positionS: 95, ranges: [[0, 95]], durationS: 100 });
  assert.equal(r.json.watchedS, 95);
  assert.deepEqual([Boolean(r.json.completedAt), r.json.marked], [true, true]);
  // the admin gives it its length: Rita's 95 of 100 s is a measured watch now; Remy's 1 s stays Marked
  assert.equal((await admin.patch(`/videos/${id}`, { durationS: 100 })).status, 200);
  const views = new Map(((await admin.get(`/videos/${id}/views`)).json as Json[]).map((v) => [v.userName, v.marked]));
  assert.deepEqual(Object.fromEntries(views), { 'Rita Rep': false, 'Remy Rep': true });
});

test('progress reports: a per-person limit per video, and the reports in between no longer clear the response cache', async () => {
  const id = await addUpload('Limited', 300);
  tick(60);
  let v0 = currentDataVersion();
  let r = await report(repB, id, { watchedS: 5, ranges: [[0, 5]] });
  assert.equal(r.status, 200);
  assert.equal(currentDataVersion() - v0, 0, 'still watching: the cached views stay warm');
  for (let i = 1; i < VIDEO_PROGRESS_PER_MINUTE; i++) assert.equal((await report(repB, id, { watchedS: 5, ranges: [[0, 5]] })).status, 200, `report ${i + 1}`);
  r = await report(repB, id, { watchedS: 5, ranges: [[0, 5]] });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, `That is more than ${VIDEO_PROGRESS_PER_MINUTE} progress reports for this video in a minute. What you watch is kept and counted from your next report.`);
  assert.equal((await report(rep, id, { watchedS: 5, ranges: [[0, 5]] })).status, 200, 'someone else is not held up');
  // a report that makes a video watched still clears it (once: the route's own bump)
  const done = await addUpload('Cache', 20);
  tick(60);
  await report(rep, done, { watchedS: 5, ranges: [[0, 5]] });
  v0 = currentDataVersion();
  await report(rep, done, { watchedS: 19, ranges: [[0, 19]] });
  assert.equal(currentDataVersion() - v0, 1);
});

test('a length arriving from an editor’s player, the still step or Edit video is audited, with the people it counted as watched', async () => {
  const id = await addUpload('Team talk (no length)', null);
  tick(60);
  // Remy has seen 60 s of what his player says is 64 s
  await report(rep, id, { watchedS: 0 });
  tick(30);
  await report(rep, id, { watchedS: 60, ranges: [[0, 60]], durationS: 64 });
  // the admin's player reports the length
  await report(admin, id, { watchedS: 2, ranges: [[0, 2]], durationS: 64 });
  const rows = srv.db.prepare(`SELECT summary FROM audit_log WHERE entity = 'video' AND entity_id = ? ORDER BY id`).all(id) as { summary: string }[];
  assert.deepEqual(rows.map((x) => x.summary), [
    'Added video: “Team talk (no length)” (upload, 1 MB)',
    'Set the length of video “Team talk (no length)” to 1:04 (from Ada Admin’s player); counted 1 person as watched',
  ]);
  // Edit video on another one
  const other = await addUpload('Another talk (no length)', null);
  tick(60);
  await report(repA2, other, { watchedS: 0 });
  tick(30);
  await report(repA2, other, { watchedS: 50, ranges: [[0, 50]], durationS: 50 });
  assert.equal((await admin.patch(`/videos/${other}`, { durationS: 50 })).status, 200);
  const last = srv.db.prepare(`SELECT summary FROM audit_log WHERE entity = 'video' AND entity_id = ? ORDER BY id DESC LIMIT 1`).get(other) as { summary: string };
  assert.equal(last.summary, 'Updated video “Another talk (no length)”: length — → 0:50; counted 1 person as watched');
});

test('the room for an upload counts the uploads already arriving; running out of space mid-upload says what to do', async () => {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  configureDiskSpace(() => ({ freeBytes: Math.floor(GB / 10) + 10 * MB, totalBytes: GB }));
  assert.equal(uploadRoomBytes({ freeBytes: Math.floor(GB / 10) + 10 * MB, totalBytes: GB }), 10 * MB);
  // another upload of 9.9 MB is arriving (nothing written yet)
  const held = holdUploadRoom(Math.round(9.9 * MB));
  try {
    assert.equal((await admin.get('/videos/access')).json.uploadRoomBytes, 10 * MB - Math.round(9.9 * MB));
    const video = sampleMp4({ timescale: 1000, duration: 12_000, mdatBytes: 200_000 });
    const r = await uploadVideo(srv.base, admin, { fields: { title: 'Second at once', topic: 'other' }, video: { bytes: video, name: 'b.mp4', type: 'video/mp4' } });
    assert.equal(r.status, 507);
    assert.match(r.json.error, /^The server has room for \d+ KB more and this video is 19\d KB\. Free some disk space on the server, or add the video as a YouTube, Vimeo or Google Drive link\.$/);
    // what it has written so far is on the disk already: only the rest is held
    held.wrote(Math.round(9.9 * MB) - 100 * 1024);
    assert.equal((await admin.get('/videos/access')).json.uploadRoomBytes, 10 * MB - 100 * 1024);
  } finally {
    held.release();
  }
  assert.equal((await admin.get('/videos/access')).json.uploadRoomBytes, 10 * MB);
  assert.equal(VIDEO_DISK_FULL_MESSAGE, 'The server ran out of disk space while this video arrived. Free some disk space on the server, or add the video as a YouTube, Vimeo or Google Drive link.');
  configureDiskSpace(null);
});
