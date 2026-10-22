/**
 * P5 learning-videos: what a progress report may count (review r3 P5 findings 2, 3, 5 and 6).
 *  - the watch credit: a report adds at most what a player at double speed could have shown since the last one
 *    (from a two-minute credit, on the real clock), so "watched" cannot be claimed in one POST; honest viewers at
 *    normal or double speed lose nothing (worked by hand with a fake clock);
 *  - a bare `watchedS` (no ranges) counts for a link only, never for an upload;
 *  - an upload without a length of its own is never made watched by a length a non-editor's player reports: it
 *    counts once it has a length (an editor's player, the still step or Edit video), for everyone who has seen 90%;
 *  - "Marked" is stored when Mark as watched made it watched, never worked out from the length later;
 *  - a report that makes a video watched clears the response cache itself;
 *  - an upload is refused (507) before it is read when the disk has no room for it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentDataVersion } from '../lib/cache.ts';
import { configureDiskSpace, configureMediaRoot, uploadReserveBytes, uploadRoomBytes } from '../lib/videos/files.ts';
import { configureProgressClock, isVideoProgressReport } from '../lib/videos/progress.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { sampleMp4, sampleWebm, uploadVideo } from './videoFixtures.ts';

const mediaRoot = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-trust-'));
const videosDir = path.join(mediaRoot, 'videos');
configureMediaRoot(mediaRoot);
let clockMs = 1_000_000_000;
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

const files = () => (existsSync(videosDir) ? readdirSync(videosDir).sort() : []);

async function addUpload(title: string, seconds: number | null): Promise<number> {
  const bytes = seconds === null ? sampleWebm() : sampleMp4({ timescale: 1000, duration: seconds * 1000 });
  const r = await uploadVideo(srv.base, admin, { fields: { title, topic: 'other', required: 'true' }, video: { bytes, name: seconds === null ? 'clip.webm' : 'clip.mp4', type: seconds === null ? 'video/webm' : 'video/mp4' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.durationS, seconds);
  return r.json.id as number;
}

const report = (who: TestClient, id: number, body: Json) => who.post(`/videos/${id}/progress`, body);

test('an upload is not watched by one report: a bare count adds nothing, a claim of every second gets the two-minute credit', async () => {
  const forty = await addUpload('Forty seconds', 40);
  // the reviewer's report: {watchedS: 40} with no ranges on a 40 s upload
  let r = await report(rep, forty, { watchedS: 40 });
  assert.equal(r.status, 200);
  assert.equal(r.json.watchedS, 0, 'an upload’s player always sends the parts it showed: a bare count adds nothing');
  assert.equal(r.json.completedAt, null);

  const ten = await addUpload('Ten minutes', 600);
  // every second claimed at once: 120 s counted (the credit), not watched
  r = await report(rep, ten, { watchedS: 600, positionS: 600, ranges: [[0, 600]] });
  assert.equal(r.json.watchedS, 120);
  assert.equal(r.json.completedAt, null);
  // the same claim again at once: nothing more (the credit is spent and no time has passed)
  r = await report(rep, ten, { watchedS: 600, ranges: [[0, 600]] });
  assert.equal(r.json.watchedS, 120);
  // claimed again every 15 s: + 30 s a time (double speed). 120 + 30 × 13 = 510 is short of 540 (90% of 600);
  // the 14th makes 540: watched after 14 × 15 s = 3.5 minutes, as fast as playing it at double speed could
  for (let i = 1; i <= 13; i++) {
    tick(15);
    r = await report(rep, ten, { watchedS: 600, ranges: [[0, 600]] });
    assert.equal(r.json.watchedS, 120 + 30 * i);
  }
  assert.equal(r.json.completedAt, null);
  tick(15);
  r = await report(rep, ten, { watchedS: 600, ranges: [[0, 600]] });
  assert.equal(r.json.watchedS, 540);
  assert.ok(r.json.completedAt);
});

test('honest viewers lose nothing: normal speed counts every second; a report every 100 ms gains no more than double speed', async () => {
  const id = await addUpload('Five minutes', 300);
  // normal speed, reports every 15 s with the session's ranges so far: exactly the seconds seen
  let r;
  for (let t = 15; t <= 270; t += 15) {
    tick(15);
    r = await report(repA2, id, { watchedS: t, positionS: t, ranges: [[0, t]] });
    assert.equal(r.json.watchedS, t);
  }
  assert.ok(r!.json.completedAt, '270 of 300 s is 90%');

  // someone sending the whole video every 100 ms for 10 s: 120 s at the start + 2 × 10 s = 140 s
  const other = await addUpload('Five minutes again', 300);
  for (let i = 0; i < 100; i++) {
    r = await report(repB, other, { watchedS: 300, ranges: [[0, 300]] });
    clockMs += 100;
  }
  assert.ok(r!.json.watchedS >= 138 && r!.json.watchedS <= 140, String(r!.json.watchedS));
  assert.equal(r!.json.completedAt, null);
  // a viewer whose reports were lost for two minutes: what is over the credit counts on the next reports
  const lost = await addUpload('Lost signal', 600);
  tick(15);
  r = await report(repA2, lost, { watchedS: 15, ranges: [[0, 15]] });
  assert.equal(r.json.watchedS, 15);
  tick(135); // 2 m 15 s later, 150 s seen in all
  r = await report(repA2, lost, { watchedS: 150, ranges: [[0, 150]] });
  assert.equal(r.json.watchedS, 135, '15 + the full 120 s credit');
  tick(15); // 165 s seen: 15 s new + the 15 s still owed; the credit has 30 s
  r = await report(repA2, lost, { watchedS: 165, ranges: [[0, 165]] });
  assert.equal(r.json.watchedS, 165, 'caught up');
});

test('a link still counts a bare count (within the credit): its player may not send ranges', async () => {
  const link = await admin.post('/videos', { title: 'Speak', topic: 'pitching', url: 'https://www.youtube.com/watch?v=eIho2S0ZahI', durationS: 598 });
  tick(60);
  let r = await report(rep, link.json.id, { watchedS: 50, positionS: 50 });
  assert.equal(r.json.watchedS, 50);
  r = await report(rep, link.json.id, { watchedS: 598 });
  assert.equal(r.json.watchedS, 120, '50 + the 70 s of credit left');
  assert.equal(r.json.completedAt, null);
});

test('an upload with no length is never watched by a length a non-editor reports; it is once an editor gives it one', async () => {
  const id = await addUpload('No length', null);
  // the reviewer's report: a 2 s length and 0–2 seen
  tick(60);
  let r = await report(rep, id, { watchedS: 2, ranges: [[0, 2]], durationS: 2 });
  assert.equal(r.json.completedAt, null, 'not watched');
  assert.equal(r.json.watchedS, 2);
  assert.equal((await admin.get(`/videos/${id}`)).json.durationS, null, 'and the video keeps no length');
  // a genuine viewer: 0–100 of what their player says is 100 s
  r = await report(repA2, id, { watchedS: 100, ranges: [[0, 100]], durationS: 100 });
  assert.equal(r.json.watchedS, 100);
  assert.equal(r.json.completedAt, null);
  // the admin types the length in Edit video: 1:40 → repA2's 100 s counts (90% is 90 s); the 2 s one does not
  const v0 = currentDataVersion();
  assert.equal((await admin.patch(`/videos/${id}`, { durationS: 100 })).status, 200);
  assert.ok(currentDataVersion() > v0);
  const views = (await admin.get(`/videos/${id}/views`)).json as Json[];
  const byName = new Map(views.map((v) => [v.userName, v]));
  assert.ok(byName.get('Rita Rep').completedAt, 'watched once the length is known');
  assert.equal(byName.get('Rita Rep').marked, false);
  assert.equal(byName.get('Remy Rep').completedAt, null, '2 of 100 s');

  // the same through the editor's own player (a WebM learns its length as it plays)
  const other = await addUpload('No length either', null);
  tick(60);
  await report(repA2, other, { watchedS: 95, ranges: [[0, 95]], durationS: 100 });
  r = await report(admin, other, { watchedS: 10, ranges: [[0, 10]], durationS: 100.4 });
  assert.equal((await admin.get(`/videos/${other}`)).json.durationS, 100);
  const rita = ((await admin.get(`/videos/${other}/views`)).json as Json[]).find((v) => v.userName === 'Rita Rep');
  assert.ok(rita.completedAt, '95 of 100 s, counted when the admin’s player gave it its length');
});

test('"Marked" is stored: a real watch stays a watch when the length changes; Mark as watched stays marked', async () => {
  const link = await admin.post('/videos', { title: 'Body language', topic: 'interviews', url: 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc', durationS: 100 });
  const id = link.json.id as number;
  tick(60);
  let r = await report(rep, id, { watchedS: 95, ranges: [[0, 95]] });
  assert.ok(r.json.completedAt);
  assert.equal(r.json.marked, false);
  r = await report(repA2, id, { watchedS: 0, markWatched: true });
  assert.ok(r.json.completedAt);
  assert.equal(r.json.marked, true);
  // Mark as watched on a video already seen to 90% is a watch
  await report(repB, id, { watchedS: 92, ranges: [[0, 92]] }); // 92 of 100: watched by watching already
  tick(60);
  const repB2 = await report(repB, id, { watchedS: 0, markWatched: true });
  assert.equal(repB2.json.marked, false);
  // the reviewer's case: an editor raises the length; nobody pressed Mark as watched
  await admin.patch(`/videos/${id}`, { durationS: 1000 });
  const views = new Map(((await admin.get(`/videos/${id}/views`)).json as Json[]).map((v) => [v.userName, v.marked]));
  assert.deepEqual(Object.fromEntries(views), { 'Remy Rep': false, 'Rita Rep': true, 'Bo Rep': false });
  // the player page reads the same flag
  assert.equal((await rep.get(`/videos/${id}`)).json.my.marked, false);
  assert.equal((await repA2.get(`/videos/${id}`)).json.my.marked, true);
  // and the audit trail says "Marked" only for Rita
  const rows = srv.db.prepare(`SELECT summary, user_id AS userId FROM audit_log WHERE action = 'POST /videos/:id/progress' AND entity_id = ?`).all(id) as { summary: string; userId: number }[];
  assert.deepEqual(rows.map((x) => x.summary).sort(), ['Marked “Body language” as watched', 'Watched “Body language”', 'Watched “Body language”']);
});

test('a report that makes a video watched clears the response cache itself (the reports in between need not)', async () => {
  assert.equal(isVideoProgressReport('POST', '/videos/12/progress'), true);
  assert.equal(isVideoProgressReport('POST', '/videos/12/poster'), false);
  assert.equal(isVideoProgressReport('PATCH', '/videos/12'), false);
  assert.equal(isVideoProgressReport('GET', '/videos/12/progress'), false);
  const id = await addUpload('Cache', 20);
  tick(60);
  // app.ts bumps once for every write today; the route adds its own bump only when the report makes it watched
  let v0 = currentDataVersion();
  await report(rep, id, { watchedS: 5, ranges: [[0, 5]] });
  assert.equal(currentDataVersion() - v0, 1, 'still watching: only the app’s blanket bump');
  v0 = currentDataVersion();
  await report(rep, id, { watchedS: 19, ranges: [[0, 19]] });
  assert.equal(currentDataVersion() - v0, 2, 'watched now: the route’s own bump too');
});

test('an upload is refused before it is read when the disk has no room for it (507), with words', async () => {
  const GB = 1024 ** 3;
  // a 1 GB cloud volume keeps a tenth free (102 MB); a big disk keeps 500 MB
  assert.equal(uploadReserveBytes(GB), Math.floor(GB / 10));
  assert.equal(uploadReserveBytes(2 * 1024 * GB), 500 * 1024 * 1024);
  assert.equal(uploadRoomBytes({ freeBytes: 50 * 1024 ** 2, totalBytes: GB }), 0);
  const video = sampleMp4({ timescale: 1000, duration: 12_000, mdatBytes: 200_000 });
  const before = files();
  const auditBefore = (srv.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'POST /videos/upload'`).get() as { n: number }).n;
  // room for 100 KB more: a 200 KB video is refused
  configureDiskSpace(() => ({ freeBytes: Math.floor(GB / 10) + 100 * 1024, totalBytes: GB }));
  // Add video is told first (admins and allowed leaders only), so it can say so before sending the file
  assert.deepEqual((await admin.get('/videos/access')).json, { canAdd: true, uploadRoomBytes: 100 * 1024 });
  assert.deepEqual((await rep.get('/videos/access')).json, { canAdd: false }, 'nothing about the disk for anyone else');
  let r = await uploadVideo(srv.base, admin, { fields: { title: 'Too big for the disk', topic: 'other' }, video: { bytes: video, name: 'big.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 507);
  assert.match(r.json.error, /^The server has room for 100 KB more and this video is 19\d KB\. Free some disk space on the server, or add the video as a YouTube, Vimeo or Google Drive link\.$/);
  assert.deepEqual(files(), before, 'nothing written, not even a partial file');
  // a disk already at its reserve
  configureDiskSpace(() => ({ freeBytes: 10 * 1024 ** 2, totalBytes: GB }));
  r = await uploadVideo(srv.base, admin, { fields: { title: 'Full disk', topic: 'other' }, video: { bytes: video, name: 'big.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 507);
  assert.match(r.json.error, /room for|almost out of disk space/);
  // room enough: accepted
  configureDiskSpace(() => ({ freeBytes: GB / 2, totalBytes: GB }));
  r = await uploadVideo(srv.base, admin, { fields: { title: 'Fits', topic: 'other' }, video: { bytes: video, name: 'ok.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 201);
  // a refusal writes no audit row; the accepted one does
  const auditAfter = (srv.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'POST /videos/upload'`).get() as { n: number }).n;
  assert.equal(auditAfter - auditBefore, 1);
  // the system's own answer (no fake): a real number for the test machine's disk
  configureDiskSpace(null);
  r = await uploadVideo(srv.base, admin, { fields: { title: 'Real disk', topic: 'other' }, video: { bytes: video, name: 'real.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 201);
  // a rep is still refused first (403, not 507)
  configureDiskSpace(() => ({ freeBytes: 0, totalBytes: GB }));
  r = await uploadVideo(srv.base, rep, { fields: { title: 'Rep', topic: 'other' }, video: { bytes: video, name: 'rep.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 403);
  configureDiskSpace(null);
});
