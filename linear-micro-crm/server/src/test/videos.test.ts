/**
 * P5 learning-videos routes on the fixture: every endpoint for every role (admin, leader, recruiter, rep, client,
 * anonymous), link videos and audiences, multipart uploads streamed to disk, byte-range streaming, watch progress
 * (merged ranges, worked by hand), the team view, who watched, settings and the audit trail.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_MAX_BYTES } from '@lm/shared';
import { createApp } from '../app.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { configureMediaRoot } from '../lib/videos/files.ts';
import { configureWatchCredit } from '../lib/videos/progress.ts';
import { receiveVideoUpload } from '../lib/videos/upload.ts';
import { HttpError } from '../lib/errors.ts';
import { UPLOAD_REQUEST_TIMEOUT_MS } from '../routes/videos.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';
import { JPEG_BYTES, payload, sampleMp4, sampleWebm, uploadVideo } from './videoFixtures.ts';

const mediaRoot = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-routes-'));
const videosDir = path.join(mediaRoot, 'videos');
configureMediaRoot(mediaRoot);
// These tests send minutes of ranges in one report to check the merging maths: the watch credit (double speed since
// the last report) has its own tests in videos-trust.test.ts, so here it never runs out.
configureWatchCredit({ rate: 2, maxS: 1e9 });

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repA2: TestClient;
let repB: TestClient;
let client: TestClient;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
  leader = await srv.login('leader');
  recruiter = await srv.login('recruiter');
  rep = await srv.login('rep');
  repA2 = await srv.login('repA2');
  repB = await srv.login('repB');
  client = await srv.login('client');
});
after(async () => {
  await srv.close();
  configureMediaRoot(null);
  configureWatchCredit(null);
  rmSync(mediaRoot, { recursive: true, force: true });
});

const fx = () => srv.fixture!;
const files = () => (existsSync(videosDir) ? readdirSync(videosDir).sort() : []);
const auditRows = (like: string) =>
  srv.db.prepare(`SELECT action, entity, entity_id AS entityId, summary, user_id AS userId FROM audit_log WHERE action LIKE ? ORDER BY id`).all(like) as {
    action: string; entity: string | null; entityId: number | null; summary: string; userId: number | null;
  }[];

const LINK = (over: Json = {}) => ({ title: 'How to speak so that people want to listen', topic: 'pitching', url: 'https://www.youtube.com/watch?v=eIho2S0ZahI', durationS: 600, ...over });

/** Raw request, for what fetch will not send (a false Content-Length, a body cut off half way). */
function rawRequest(opts: http.RequestOptions & { body?: Buffer; abortAfter?: number }): Promise<{ status: number | null; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(srv.base);
  return new Promise((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path: `/api${opts.path}`, method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? null, headers: res.headers, body }));
      res.on('error', () => resolve({ status: res.statusCode ?? null, headers: res.headers, body }));
    });
    req.on('error', () => resolve({ status: null, headers: {}, body: '' }));
    if (opts.body && opts.abortAfter !== undefined) {
      req.write(opts.body.subarray(0, opts.abortAfter));
      setTimeout(() => {
        req.destroy();
        resolve({ status: null, headers: {}, body: '' });
      }, 150);
      return;
    }
    if (opts.body) req.end(opts.body);
    else req.end();
  });
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  return check();
};

// ───────────────────────────── who may call what ─────────────────────────────

const ROUTES: [string, string][] = [
  ['GET', '/videos'], ['GET', '/videos/access'], ['GET', '/videos/settings'], ['PUT', '/videos/settings'], ['GET', '/videos/team'],
  ['POST', '/videos'], ['POST', '/videos/upload'], ['GET', '/videos/1'], ['GET', '/videos/1/stream'], ['GET', '/videos/1/poster'],
  ['GET', '/videos/1/views'], ['PATCH', '/videos/1'], ['DELETE', '/videos/1'], ['POST', '/videos/1/progress'], ['POST', '/videos/1/poster'],
];

test('anonymous: 401 on every route; a client portal account: 403 clientPortalOnly on every route', async () => {
  const anon = srv.anon();
  for (const [method, p] of ROUTES) {
    assert.equal((await anon.req(method, p, method === 'GET' ? undefined : {})).status, 401, `anon ${method} ${p}`);
    const r = await client.req(method, p, method === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `client ${method} ${p}`);
    assert.equal(r.json?.clientPortalOnly, true, `client ${method} ${p}`);
  }
  assert.equal((await uploadVideo(srv.base, null, { fields: { title: 'x', topic: 'other' }, video: { bytes: sampleMp4(), name: 'a.mp4', type: 'video/mp4' } })).status, 401);
  assert.deepEqual(files().filter((f) => !f.startsWith('.')), [], 'nothing written for an anonymous upload');
});

test('empty to start with; only administrators may add videos until leaders are allowed', async () => {
  for (const who of [admin, leader, recruiter, rep]) assert.deepEqual((await who.get('/videos')).json, []);
  const access = (await admin.get('/videos/access')).json;
  assert.equal(access.canAdd, true);
  assert.ok(access.uploadRoomBytes === null || (Number.isSafeInteger(access.uploadRoomBytes) && access.uploadRoomBytes >= 0), 'the room an upload has on the disk');
  for (const who of [leader, recruiter, rep]) assert.deepEqual((await who.get('/videos/access')).json, { canAdd: false });
  const settings = await admin.get('/videos/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.json.leadersCanAdd, false);
  assert.deepEqual({ ...settings.json.storage, folder: undefined }, { uploads: 0, bytes: 0, folder: undefined });
  assert.equal(settings.json.storage.folder, videosDir);
  for (const who of [leader, recruiter, rep]) {
    assert.equal((await who.get('/videos/settings')).status, 403);
    assert.equal((await who.put('/videos/settings', { leadersCanAdd: true })).status, 403);
    assert.equal((await who.get('/videos/1/views')).status, 403);
  }
  for (const who of [recruiter, rep]) assert.equal((await who.get('/videos/team')).status, 403);
  const refused = await leader.post('/videos', LINK());
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /Settings → Learning videos/);
  assert.equal((await rep.post('/videos', LINK())).status, 403);
  assert.equal((await recruiter.post('/videos', LINK())).status, 403);
  assert.equal((await uploadVideo(srv.base, rep, { fields: { title: 'x', topic: 'other' }, video: { bytes: sampleMp4(), name: 'a.mp4', type: 'video/mp4' } })).status, 403);
  assert.equal((await admin.put('/videos/settings', {})).status, 400);
  assert.equal((await admin.put('/videos/settings', { leadersCanAdd: 'yes' })).status, 400);
});

// ───────────────────────────── links and audiences ─────────────────────────────

let linkId = 0;
let leadersId = 0;
let repsId = 0;

test('admin adds a YouTube link: the embed, the thumbnail, no stream; bad and repeated links are refused', async () => {
  const r = await admin.post('/videos', LINK({ required: true, description: 'Voice and pace.' }));
  assert.equal(r.status, 201);
  const v = r.json;
  linkId = v.id;
  assert.equal(v.kind, 'link');
  assert.equal(v.provider, 'youtube');
  assert.equal(v.embedUrl, 'https://www.youtube-nocookie.com/embed/eIho2S0ZahI?rel=0&playsinline=1&modestbranding=1');
  assert.equal(v.thumbnailUrl, 'https://i.ytimg.com/vi/eIho2S0ZahI/hqdefault.jpg');
  assert.equal(v.streamUrl, null);
  assert.equal(v.required, true);
  assert.equal(v.audience, 'everyone');
  assert.equal(v.durationS, 600);
  assert.equal(v.createdByName, 'Ada Admin');
  assert.equal(v.example, false);
  assert.equal(v.canEdit, true);
  assert.equal(v.my, null);
  assert.ok(!('filePath' in v) && !('posterPath' in v), 'no file paths in the payload');

  const notAVideo = await admin.post('/videos', LINK({ url: 'https://example.com/talk.mp4' }));
  assert.equal(notAVideo.status, 400);
  assert.match(notAVideo.json.error, /YouTube, Vimeo or Google Drive/);
  const again = await admin.post('/videos', LINK({ url: 'https://youtu.be/eIho2S0ZahI?t=30', title: 'Same talk' }));
  assert.equal(again.status, 409, 'the same video in another form of link');
  assert.match(again.json.error, /already in Learning/);
  assert.equal((await admin.post('/videos', LINK({ title: ' ' , url: 'https://vimeo.com/76979871' }))).status, 400, 'a title');
  assert.equal((await admin.post('/videos', LINK({ topic: 'dancing', url: 'https://vimeo.com/76979871' }))).status, 400, 'a known topic');
  assert.equal((await admin.post('/videos', LINK({ audience: 'clients', url: 'https://vimeo.com/76979871' }))).status, 400, 'a known audience');
  assert.equal((await admin.post('/videos', LINK({ durationS: 0, url: 'https://vimeo.com/76979871' }))).status, 400, 'a possible length');

  const vimeo = await admin.post('/videos', LINK({ title: 'How great leaders inspire action', topic: 'leadership', url: 'vimeo.com/76979871', required: true, audience: 'leaders', durationS: 1000 }));
  leadersId = vimeo.json.id;
  assert.equal(vimeo.json.url, 'https://vimeo.com/76979871', 'stored with its scheme, so it opens as a link');
  repsId = (await admin.post('/videos', LINK({ title: 'Objections on the street', topic: 'objections', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing', required: true, audience: 'reps', durationS: null }))).json.id;
  assert.ok(leadersId && repsId);
});

test('audiences: each role sees its own; outside it a video is 404, like one that does not exist', async () => {
  const titles = async (who: TestClient) => ((await who.get('/videos')).json as Json[]).map((v) => v.id).sort((a: number, b: number) => a - b);
  assert.deepEqual(await titles(admin), [linkId, leadersId, repsId]);
  assert.deepEqual(await titles(leader), [linkId, leadersId, repsId], 'leaders see the reps’ videos too: they coach them');
  assert.deepEqual(await titles(rep), [linkId, repsId]);
  assert.deepEqual(await titles(recruiter), [linkId]);
  assert.equal((await rep.get(`/videos/${leadersId}`)).status, 404);
  assert.equal((await recruiter.get(`/videos/${repsId}`)).status, 404);
  assert.equal((await rep.post(`/videos/${leadersId}/progress`, { watchedS: 10 })).status, 404);
  assert.equal((await rep.get('/videos/99999')).status, 404);
  assert.equal((await rep.get('/videos/abc')).status, 400);
  const drive = (await rep.get(`/videos/${repsId}`)).json;
  assert.equal(drive.provider, 'drive');
  assert.equal(drive.embedUrl, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/preview');
  assert.equal(drive.thumbnailUrl, null);
  assert.equal(drive.canEdit, false);
});

test('editing: admins any video; nobody else while leaders may not add; a leader only their own once allowed', async () => {
  assert.equal((await rep.patch(`/videos/${linkId}`, { required: false })).status, 403);
  assert.equal((await leader.patch(`/videos/${linkId}`, { required: false })).status, 403);
  assert.equal((await rep.del(`/videos/${linkId}`)).status, 403);
  assert.equal((await rep.patch(`/videos/${leadersId}`, { title: 'x' })).status, 404, 'not in their audience');
  const r = await admin.patch(`/videos/${linkId}`, { description: 'Voice, pace and silence.', durationS: 598 });
  assert.equal(r.status, 200);
  assert.equal(r.json.description, 'Voice, pace and silence.');
  assert.equal(r.json.durationS, 598);
  assert.equal((await admin.patch(`/videos/${linkId}`, {})).status, 400, 'nothing to change');
  assert.equal((await admin.patch(`/videos/${linkId}`, { url: 'https://youtu.be/x' })).status, 400, 'the link itself stays');

  assert.equal((await admin.put('/videos/settings', { leadersCanAdd: true })).json.leadersCanAdd, true);
  assert.equal((await leader.get('/videos/access')).json.canAdd, true);
  assert.deepEqual((await rep.get('/videos/access')).json, { canAdd: false });
  const mine = await leader.post('/videos', LINK({ title: 'Our Monday huddle', topic: 'leadership', url: 'https://vimeo.com/123456789/abcdef1234', audience: 'reps' }));
  assert.equal(mine.status, 201);
  assert.equal(mine.json.canEdit, true);
  assert.equal(mine.json.createdByName, 'Lee Leader');
  assert.equal((await leader.patch(`/videos/${mine.json.id}`, { required: true })).json.required, true);
  const notMine = await leader.patch(`/videos/${linkId}`, { required: false });
  assert.equal(notMine.status, 403);
  assert.match(notMine.json.error, /only the videos you added/);
  assert.equal(((await leader.get(`/videos/${linkId}`)).json as Json).canEdit, false);
  assert.equal((await leader.del(`/videos/${mine.json.id}`)).status, 204);
  assert.equal((await leader.get(`/videos/${mine.json.id}`)).status, 404);
  await admin.put('/videos/settings', { leadersCanAdd: false });
  assert.deepEqual((await leader.get('/videos/access')).json, { canAdd: false });
});

// ───────────────────────────── progress ─────────────────────────────

test('progress: the parts seen are merged, a replay counts once, 90 % of 598 s (538.2 s) makes it watched', async () => {
  const report = (who: TestClient, body: Json) => who.post(`/videos/${linkId}/progress`, body);
  let r = await report(rep, { watchedS: 100, positionS: 100, ranges: [[0, 100]] });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.json, lastAt: undefined }, { videoId: linkId, watchedS: 100, positionS: 100, completedAt: null, lastAt: undefined, marked: false, owedS: 0 });
  // 50–200 overlaps 0–100: together 0–200 = 200 s
  r = await report(rep, { watchedS: 150, positionS: 200, ranges: [[50, 200]] });
  assert.equal(r.json.watchedS, 200);
  // watching 0–200 again adds nothing
  r = await report(rep, { watchedS: 200, positionS: 200, ranges: [[0, 200]] });
  assert.equal(r.json.watchedS, 200);
  // skipping to 500 and watching 500–530: 230 s, still under 538.2
  r = await report(rep, { watchedS: 30, positionS: 530, ranges: [[500, 530]] });
  assert.equal(r.json.watchedS, 230);
  assert.equal(r.json.completedAt, null);
  // 200–500 fills the gap: 0–530 = 530 s, still short by 8.2 s
  r = await report(rep, { watchedS: 300, positionS: 500, ranges: [[200, 500]] });
  assert.equal(r.json.watchedS, 530);
  assert.equal(r.json.completedAt, null);
  // 530–540 → 540 s ≥ 538.2: watched
  r = await report(rep, { watchedS: 10, positionS: 540, ranges: [[530, 540]] });
  assert.equal(r.json.watchedS, 540);
  assert.ok(r.json.completedAt, 'watched at 90 %');
  const completedAt = r.json.completedAt;
  // the end: the position goes back to the start; a later report never takes "watched" back
  r = await report(rep, { watchedS: 0, positionS: 598, ended: true, ranges: [] });
  assert.equal(r.json.positionS, 0);
  r = await report(rep, { watchedS: 5, positionS: 5, ranges: [[0, 5]] });
  assert.equal(r.json.completedAt, completedAt);
  assert.equal(r.json.watchedS, 540);
  // ranges past the end are cut at the length (598)
  r = await report(repA2, { watchedS: 0, positionS: 598, ranges: [[590, 5000]] });
  assert.equal(r.json.watchedS, 8);
  // their own progress only
  const mine = ((await rep.get('/videos')).json as Json[]).find((v) => v.id === linkId);
  assert.equal(mine.my.watchedS, 540);
  assert.equal(mine.my.completedAt, completedAt);
  const theirs = ((await repB.get('/videos')).json as Json[]).find((v) => v.id === linkId);
  assert.equal(theirs.my, null, 'nothing of someone else’s progress');
});

test('progress without ranges keeps the larger count; bad reports are refused', async () => {
  let r = await repB.post(`/videos/${linkId}/progress`, { watchedS: 50, positionS: 50 });
  assert.equal(r.json.watchedS, 50);
  r = await repB.post(`/videos/${linkId}/progress`, { watchedS: 30, positionS: 30 });
  assert.equal(r.json.watchedS, 50, 'never goes down');
  assert.equal(r.json.positionS, 30, 'but the place to resume moves');
  for (const bad of [{}, { watchedS: -1 }, { watchedS: 'ten' }, { watchedS: 1, ranges: [[1]] }, { watchedS: 1, ranges: Array.from({ length: 201 }, (_, i) => [i, i + 1]) }, { watchedS: 1e9 }]) {
    assert.equal((await repB.post(`/videos/${linkId}/progress`, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('Mark as watched (links only); a length reported by the player fills a missing one only from someone who may edit it', async () => {
  // the Drive video has no length: a rep's player says 300 s; it counts for the rep, and the video keeps no length
  let r = await rep.post(`/videos/${repsId}/progress`, { watchedS: 0, positionS: 0, durationS: 300, ranges: [[0, 290]] });
  assert.equal(r.json.watchedS, 290);
  assert.ok(r.json.completedAt, '290 of the reported 300 s is over 90 % (270 s)');
  assert.equal(r.json.marked, true, 're-review fix: on a length only their own player reported, it is their own word (Marked)');
  assert.equal((await admin.get(`/videos/${repsId}`)).json.durationS, null, 'a rep cannot set everyone’s length');
  // the admin's player fills it in: Remy's 290 of 312 s (92.9 %) is a measured watch now
  r = await admin.post(`/videos/${repsId}/progress`, { watchedS: 0, positionS: 10, durationS: 312.4, ranges: [[0, 10]] });
  assert.equal((await admin.get(`/videos/${repsId}`)).json.durationS, 312);
  assert.equal((await rep.get(`/videos/${repsId}`)).json.my.marked, false);
  // Google Drive cannot report: "Mark as watched"
  r = await repA2.post(`/videos/${repsId}/progress`, { watchedS: 0, markWatched: true });
  assert.ok(r.json.completedAt);
  assert.equal(r.json.watchedS, 0);
});

// ───────────────────────────── uploads and streaming ─────────────────────────────

let uploadId = 0;
const MP4 = sampleMp4({ timescale: 1000, duration: 95_000, moovLast: true, mdatBytes: 20_000 });

test('upload: streamed to media/videos/<uuid>.mp4 with its still; the file’s own length wins over the form’s', async () => {
  const r = await uploadVideo(srv.base, admin, {
    fields: { title: 'Monday team talk', description: 'Recorded at Golden Square.', topic: 'leadership', audience: 'everyone', required: 'true', durationS: '12' },
    poster: JPEG_BYTES,
    video: { bytes: MP4, name: 'IMG_0042.MP4', type: 'video/mp4' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const v = r.json;
  uploadId = v.id;
  assert.equal(v.kind, 'upload');
  assert.equal(v.mime, 'video/mp4');
  assert.equal(v.size, MP4.length);
  assert.equal(v.durationS, 95, 'mvhd: 95,000 / 1,000 = 95 s, not the 12 typed');
  assert.equal(v.required, true);
  assert.equal(v.streamUrl, `/api/videos/${v.id}/stream`);
  assert.equal(v.thumbnailUrl, `/api/videos/${v.id}/poster`);
  assert.equal(v.url, null);
  assert.equal(v.embedUrl, null);
  const stored = files();
  assert.equal(stored.length, 2);
  assert.ok(stored.some((f) => /^[0-9a-f-]{36}\.mp4$/.test(f)) && stored.some((f) => /^[0-9a-f-]{36}\.jpg$/.test(f)), stored.join(', '));
  assert.ok(!stored.some((f) => f.endsWith('.upload')), 'no unfinished file left');
  const settings = (await admin.get('/videos/settings')).json;
  assert.deepEqual({ uploads: settings.storage.uploads, bytes: settings.storage.bytes }, { uploads: 1, bytes: MP4.length });
});

test('streaming: the whole file, byte ranges (206), suffixes, 416 past the end, HEAD; private and never cached', async () => {
  const get = (range?: string, method = 'GET') =>
    fetch(`${srv.base}/videos/${uploadId}/stream`, { method, headers: { cookie: rep.cookie, ...(range ? { range } : {}) } });
  let res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), String(MP4.length));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('content-encoding'), null, 'never compressed');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(MP4));

  res = await get('bytes=0-1');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1/${MP4.length}`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(MP4.subarray(0, 2)));

  res = await get('bytes=1000-1999');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '1000');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(MP4.subarray(1000, 2000)));

  res = await get('bytes=-16');
  assert.equal(res.headers.get('content-range'), `bytes ${MP4.length - 16}-${MP4.length - 1}/${MP4.length}`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(MP4.subarray(MP4.length - 16)));

  res = await get(`bytes=${MP4.length}-`);
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${MP4.length}`);
  await res.arrayBuffer();

  res = await get('bytes=0-99', 'HEAD');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '100');
  assert.equal((await res.arrayBuffer()).byteLength, 0);

  // If-Range with another validator: the whole file
  res = await fetch(`${srv.base}/videos/${uploadId}/stream`, { headers: { cookie: rep.cookie, range: 'bytes=0-9', 'if-range': '"stale"' } });
  assert.equal(res.status, 200);
  await res.arrayBuffer();

  const poster = await fetch(`${srv.base}/videos/${uploadId}/poster`, { headers: { cookie: recruiter.cookie } });
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await poster.arrayBuffer()).equals(JPEG_BYTES));
  assert.equal((await fetch(`${srv.base}/videos/${uploadId}/stream`)).status, 401, 'never without a session');
  assert.equal((await rep.get(`/videos/${linkId}/stream`)).status, 404, 'a link has no file');
  assert.equal((await rep.get(`/videos/${linkId}/poster`)).status, 404);
});

test('upload refusals: not a video whatever its name, fields checked before the file, no file, not multipart', async () => {
  const fields = { title: 'A talk', topic: 'other' };
  let r = await uploadVideo(srv.base, admin, { fields, video: { bytes: Buffer.from('<html>this is not a video at all</html>'), name: 'talk.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 415);
  assert.match(r.json.error, /MP4, WebM or MOV/);
  r = await uploadVideo(srv.base, admin, { fields, video: { bytes: Buffer.from('plain text'), name: 'notes.txt', type: 'text/plain' } });
  assert.equal(r.status, 415);
  r = await uploadVideo(srv.base, admin, { fields: { topic: 'other' }, video: { bytes: MP4, name: 'a.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Validation failed');
  assert.ok(r.json.details.some((d: Json) => d.path === 'title'));
  r = await uploadVideo(srv.base, admin, { fields, video: null });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Choose a video file/);
  r = await uploadVideo(srv.base, admin, { fields, video: { bytes: new Uint8Array(0), name: 'empty.mp4', type: 'video/mp4' } });
  assert.equal(r.status, 400);
  r = await admin.post('/videos/upload', { title: 'json' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /multipart/);
  assert.equal(files().length, 2, 'nothing left behind by the refusals');
});

test('upload: WebM and MOV are recognised by their bytes; a poster that is not a JPEG is left out', async () => {
  const webm = await uploadVideo(srv.base, admin, { fields: { title: 'Webm clip', topic: 'other', durationS: '42' }, poster: Buffer.from('GIF89a…'), video: { bytes: sampleWebm(), name: 'clip.bin', type: 'video/webm' } });
  assert.equal(webm.status, 201);
  assert.equal(webm.json.mime, 'video/webm');
  assert.equal(webm.json.durationS, 42, 'no mvhd in a WebM: the length the browser read');
  assert.equal(webm.json.thumbnailUrl, null);
  const mov = await uploadVideo(srv.base, admin, { fields: { title: 'iPhone clip', topic: 'interviews', audience: 'leaders' }, video: { bytes: sampleMp4({ brand: 'qt  ', duration: 30_000 }), name: 'IMG_1.MOV', type: 'application/octet-stream' } });
  assert.equal(mov.status, 201);
  assert.equal(mov.json.mime, 'video/quicktime');
  assert.equal(mov.json.durationS, 30);
  assert.equal(mov.json.audience, 'leaders');
  assert.ok(files().some((f) => f.endsWith('.webm')) && files().some((f) => f.endsWith('.mov')));
  // a rep cannot stream the leaders' clip
  assert.equal((await rep.get(`/videos/${mov.json.id}/stream`)).status, 404);
  // delete both: the files go with them
  assert.equal((await admin.del(`/videos/${webm.json.id}`)).status, 204);
  assert.equal((await admin.del(`/videos/${mov.json.id}`)).status, 204);
  assert.ok(!files().some((f) => f.endsWith('.webm') || f.endsWith('.mov')));
});

test('the still and a missing length come from an editor’s browser (POST /videos/:id/poster)', async () => {
  const webm = await uploadVideo(srv.base, admin, { fields: { title: 'Recorded on a laptop', topic: 'other' }, video: { bytes: sampleWebm(), name: 'rec.webm', type: 'video/webm' } });
  assert.equal(webm.status, 201);
  const id = webm.json.id;
  assert.equal(webm.json.durationS, null, 'a WebM has no mvhd and the form sent no length');
  assert.equal(webm.json.thumbnailUrl, null);
  const image = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
  assert.equal((await rep.post(`/videos/${id}/poster`, { image })).status, 403);
  assert.equal((await leader.post(`/videos/${id}/poster`, { image })).status, 403);
  assert.equal((await admin.post(`/videos/${linkId}/poster`, { image })).status, 400, 'a link has no still of its own');
  assert.equal((await admin.post(`/videos/${id}/poster`, { image: 'data:image/png;base64,iVBORw0KGgo=' })).status, 400);
  assert.equal((await admin.post(`/videos/${id}/poster`, { image: `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}` })).status, 400);
  const r = await admin.post(`/videos/${id}/poster`, { image, durationS: 42.4 });
  assert.equal(r.status, 200);
  assert.equal(r.json.thumbnailUrl, `/api/videos/${id}/poster`);
  assert.equal(r.json.durationS, 42);
  const stored = srv.db.prepare(`SELECT file_path AS f, poster_path AS p FROM learning_videos WHERE id = ?`).get(id) as { f: string; p: string };
  assert.equal(stored.p, stored.f.replace(/\.webm$/, '.jpg'), 'the still sits next to the video under the same name');
  const poster = await fetch(`${srv.base}/videos/${id}/poster`, { headers: { cookie: rep.cookie } });
  assert.ok(Buffer.from(await poster.arrayBuffer()).equals(JPEG_BYTES));
  // a second still replaces the first; a length already known stays
  assert.equal((await admin.post(`/videos/${id}/poster`, { image, durationS: 99 })).json.durationS, 42);
  const rows = auditRows('POST /videos/:id/poster').map((x) => x.summary);
  assert.deepEqual(rows, ['Added a still to video “Recorded on a laptop” (length 0:42)', 'Replaced the still of video “Recorded on a laptop”']);
  assert.equal((await admin.del(`/videos/${id}`)).status, 204);
  assert.ok(!files().some((f) => f.endsWith('.webm')) && files().length === 2, 'both files went with it');
});

test('a still fits the 1 MB JSON limit: up to 600 KB is kept, more is refused with words; an unknown upload length can be typed in', async () => {
  const webm = await uploadVideo(srv.base, admin, { fields: { title: 'Long recording', topic: 'other' }, video: { bytes: sampleWebm(), name: 'long.webm', type: 'video/webm' } });
  const id = webm.json.id;
  const jpeg = (bytes: number) => `data:image/jpeg;base64,${Buffer.concat([JPEG_BYTES.subarray(0, 3), payload(bytes - 3, 5)]).toString('base64')}`;
  // 600 KB exactly: 819,223 characters as a data URL, under express.json's 1 MB
  const fits = await admin.post(`/videos/${id}/poster`, { image: jpeg(600 * 1024) });
  assert.equal(fits.status, 200, JSON.stringify(fits.json).slice(0, 200));
  const over = await admin.post(`/videos/${id}/poster`, { image: jpeg(600 * 1024 + 3) });
  assert.equal(over.status, 400);
  assert.match(JSON.stringify(over.json), /up to 600 KB/);
  // the length: a rep may not set it, the admin may (Edit video asks for it while it is not known)
  assert.equal((await rep.patch(`/videos/${id}`, { durationS: 1500 })).status, 403);
  const typed = await admin.patch(`/videos/${id}`, { durationS: 1500 });
  assert.equal(typed.status, 200);
  assert.equal(typed.json.durationS, 1500);
  assert.equal((await admin.del(`/videos/${id}`)).status, 204);
});

test('upload limits: a declared size over 2 GB is refused at once; a cut-off upload leaves no file', async () => {
  const big = await rawRequest({
    path: '/videos/upload',
    headers: { cookie: admin.cookie, 'content-type': 'multipart/form-data; boundary=xyz', 'content-length': String(VIDEO_MAX_BYTES + 3 * 1024 * 1024) },
  });
  assert.equal(big.status, 413);
  assert.match(big.body, /2 GB/);

  const boundary = 'cutoff';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nCut off\r\n--${boundary}\r\nContent-Disposition: form-data; name="topic"\r\n\r\nother\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="cut.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
  );
  const body = Buffer.concat([head, sampleMp4({ mdatBytes: 200_000 }), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  await rawRequest({
    path: '/videos/upload',
    headers: { cookie: admin.cookie, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
    body,
    abortAfter: head.length + 50_000,
  });
  assert.ok(await waitFor(() => !files().some((f) => f.endsWith('.upload'))), `left: ${files().join(', ')}`);
  assert.equal(files().length, 2, 'only the first upload and its still');
});

test('the receiver stops at its size limit and removes the partial file (413)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-limit-'));
  const server = http.createServer((req, res) => {
    receiveVideoUpload(req as never, dir, { maxBytes: 5000 }).then(
      (r) => res.writeHead(201).end(JSON.stringify({ size: r.video.size })),
      (err: HttpError) => res.writeHead(err.status ?? 500, { connection: 'close' }).end(JSON.stringify({ error: err.message })),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const send = (bytes: Buffer) => {
      const form = new FormData();
      form.append('title', 't');
      form.append('video', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), 'v.mp4');
      return fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: form });
    };
    const over = await send(sampleMp4({ mdatBytes: 20_000 }));
    assert.equal(over.status, 413);
    assert.match((await over.json()).error, /up to/);
    assert.ok(await waitFor(() => readdirSync(dir).length === 0), 'partial file removed');
    const under = await send(sampleMp4({ mdatBytes: 1000 }));
    assert.equal(under.status, 201);
    assert.equal((await under.json()).size, sampleMp4({ mdatBytes: 1000 }).length);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an upload lifts the server’s 5-minute request limit while it arrives (2 GB over a hotspot), then puts it back', async () => {
  const server = http.createServer(createApp(srv.db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    assert.equal(server.requestTimeout, 300_000, "Node's default");
    const port = (server.address() as AddressInfo).port;
    const boundary = 'slowupload';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nTimeout check\r\n--${boundary}\r\nContent-Disposition: form-data; name="topic"\r\n\r\nother\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="t.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    );
    const rest = Buffer.concat([sampleMp4(), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    let status = 0;
    let body = '';
    const finished = new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/videos/upload', method: 'POST', headers: { cookie: admin.cookie, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(head.length + rest.length) } },
        (res) => {
          status = res.statusCode ?? 0;
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve());
        },
      );
      req.write(head);
      // half way through the upload: the limit is raised for as long as it arrives
      void waitFor(() => server.requestTimeout === UPLOAD_REQUEST_TIMEOUT_MS).then((raised) => {
        assert.ok(raised, 'raised while the upload arrives');
        req.end(rest);
      });
    });
    await finished;
    assert.equal(status, 201, body);
    assert.ok(await waitFor(() => server.requestTimeout === 300_000), 'back to the usual 5 minutes once it has finished');
    assert.equal((await admin.del(`/videos/${JSON.parse(body).id}`)).status, 204);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('uploads count by watching, never by "Mark as watched"; a missing file says how to put it back', async () => {
  const r = await rep.post(`/videos/${uploadId}/progress`, { watchedS: 0, markWatched: true });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /90%/);
  // 0–86 of 95 s: 86 ≥ 85.5 → watched
  const watched = await rep.post(`/videos/${uploadId}/progress`, { watchedS: 86, positionS: 86, ranges: [[0, 86]] });
  assert.ok(watched.json.completedAt);
  {
    const row = srv.db.prepare(`SELECT file_path AS f FROM learning_videos WHERE id = ?`).get(uploadId) as { f: string };
    const file = path.join(mediaRoot, row.f);
    const bytes = await (await fetch(`${srv.base}/videos/${uploadId}/stream`, { headers: { cookie: admin.cookie } })).arrayBuffer();
    unlinkSync(file);
    const missing = await admin.get(`/videos/${uploadId}/stream`);
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /missing on the server/);
    // put it back for the next tests
    writeFileSync(file, Buffer.from(bytes));
  }
});

// ───────────────────────────── the team view and who watched ─────────────────────────────

test('team view (hand-counted): the leader’s team, required videos per role, one person; cached until a write', async () => {
  // Required now: the YouTube link (everyone), the Vimeo one (leaders), the Drive one (reps), the upload (everyone).
  const t = await leader.get('/videos/team');
  assert.equal(t.status, 200);
  assert.equal(t.headers.get('x-cache'), 'MISS');
  assert.equal(t.json.required, 4);
  assert.deepEqual(t.json.videos.map((v: Json) => v.id).sort((a: number, b: number) => a - b), [linkId, leadersId, repsId, uploadId].sort((a, b) => a - b));
  const byName = new Map((t.json.rows as Json[]).map((r) => [r.userName, r]));
  assert.deepEqual([...byName.keys()].sort(), ['Lee Leader', 'Remy Rep', 'Rita Rep'], 'own team only: not Bo (team B), not the admin, not a client');
  // Remy (rep): everyone ×2 + reps = 3 required; watched the link (540 s), the Drive one (290 of 300) and the upload → 3 of 3
  assert.deepEqual(pick(byName.get('Remy Rep')), { requiredTotal: 3, watchedRequired: 3, watched: 3 });
  // Rita (rep): 3 required; only the Drive one (marked as watched) → 1 of 3; the link has 8 s of 598
  assert.deepEqual(pick(byName.get('Rita Rep')), { requiredTotal: 3, watchedRequired: 1, watched: 1 });
  const ritaLink = byName.get('Rita Rep').cells.find((c: Json) => c.videoId === linkId);
  assert.deepEqual(ritaLink, { videoId: linkId, watchedS: 8, completedAt: null });
  // Lee (leader): everyone ×2 + leaders = 3 required, none watched
  assert.deepEqual(pick(byName.get('Lee Leader')), { requiredTotal: 3, watchedRequired: 0, watched: 0 });
  assert.equal((await leader.get('/videos/team')).headers.get('x-cache'), 'HIT');
  await repA2.post(`/videos/${linkId}/progress`, { watchedS: 0, positionS: 20, ranges: [[8, 20]] });
  // P5 merge note, applied: a report that does not make a video watched leaves the cached views warm (they refresh
  // within the cache's time, or at once when a report makes a video watched)
  assert.equal((await leader.get('/videos/team')).headers.get('x-cache'), 'HIT', 'an in-between progress report keeps the cache');
  bumpDataVersion();
  const fresh = await leader.get('/videos/team');
  assert.equal(fresh.headers.get('x-cache'), 'MISS');
  // 8–20 added to 590–598: 12 + 8 = 20 s
  assert.equal(fresh.json.rows.find((r: Json) => r.userName === 'Rita Rep').cells.find((c: Json) => c.videoId === linkId).watchedS, 20);

  const one = await leader.get(`/videos/team?userId=${fx().users.rep}`);
  assert.deepEqual(one.json.rows.map((r: Json) => r.userId), [fx().users.rep]);
  assert.equal((await leader.get(`/videos/team?userId=${fx().users.repB}`)).status, 403, 'not their team');
  assert.equal((await leader.get('/videos/team?userId=abc')).status, 400);
  const clientId = (srv.db.prepare(`SELECT id FROM users WHERE role = 'client'`).get() as { id: number }).id;
  assert.equal((await admin.get(`/videos/team?userId=${clientId}`)).status, 404, 'a client account is nobody here');

  const all = await admin.get('/videos/team');
  const names = (all.json.rows as Json[]).map((r) => r.userName).sort();
  assert.deepEqual(names, ['Ada Admin', 'Bo Rep', 'Lee Leader', 'Rae Recruiter', 'Remy Rep', 'Rita Rep'], 'every active member of staff, never a client');
  // Rae (recruiter): only the two "everyone" videos are required
  assert.equal(all.json.rows.find((r: Json) => r.userName === 'Rae Recruiter').requiredTotal, 2);
  // Ada (admin): the two "everyone" ones; 10 s of the Drive one (reps; not required for her) is not watched yet
  assert.deepEqual(pick(all.json.rows.find((r: Json) => r.userName === 'Ada Admin')), { requiredTotal: 2, watchedRequired: 0, watched: 0 });
});

function pick(row: Json) {
  return { requiredTotal: row.requiredTotal, watchedRequired: row.watchedRequired, watched: row.watched };
}

test('who watched (admin): names, watched first, "marked" when ticked by hand', async () => {
  const r = await admin.get(`/videos/${repsId}/views`);
  assert.equal(r.status, 200);
  const rows = r.json as Json[];
  // watched first, the latest first (Rita marked it after Remy watched it), then still watching
  assert.deepEqual(rows.map((x) => x.userName), ['Rita Rep', 'Remy Rep', 'Ada Admin']);
  const [rita, remy, ada] = rows;
  assert.equal(rita.marked, true, 'Mark as watched, with no time seen');
  assert.equal(rita.watchedS, 0);
  assert.equal(remy.marked, false, '290 of 312 s seen: 92.9 %');
  assert.equal(remy.watchedS, 290);
  assert.equal(remy.teamName, 'Team A');
  assert.equal(ada.completedAt, null);
  assert.equal(ada.watchedS, 10);
  assert.equal(ada.positionS, 10);
  assert.equal((await admin.get('/videos/99999/views')).status, 404);
  assert.equal((await leader.get(`/videos/${repsId}/views`)).status, 403);
});

// ───────────────────────────── the audit trail ─────────────────────────────

test('audit: adds, edits, deletes and settings are recorded; progress only when it makes a video watched', () => {
  const adds = auditRows('POST /videos%').filter((r) => r.summary.startsWith('Added video'));
  assert.ok(adds.some((r) => r.summary === 'Added video: “How to speak so that people want to listen” (YouTube link)' && r.entity === 'video' && r.entityId === linkId));
  assert.ok(adds.some((r) => r.summary === 'Added video: “Objections on the street” (Google Drive link)'));
  assert.ok(adds.some((r) => /^Added video: “Monday team talk” \(upload, 1 MB\)$/.test(r.summary)), adds.map((r) => r.summary).join(' | '));
  const edits = auditRows('PATCH /videos/%');
  assert.ok(edits.some((r) => r.summary === 'Updated video “How to speak so that people want to listen”: description, length 10:00 → 9:58'), edits.map((r) => r.summary).join(' | '));
  assert.ok(auditRows('DELETE /videos/%').some((r) => r.summary === 'Deleted video “Webm clip”'));
  const settings = auditRows('PUT /videos/settings');
  assert.deepEqual(settings.map((r) => r.summary), ['Changed learning video settings: leaders can add videos no → yes', 'Changed learning video settings: leaders can add videos yes → no']);
  assert.equal(settings[0]!.entity, 'settings');
  const progress = auditRows('POST /videos/:id/progress');
  // completions: Remy (link, upload, and the Drive one on his own player's length: Marked then), Rita (Drive, marked),
  // the admin's player giving the Drive one its length, and nothing for the dozens of other reports
  assert.deepEqual(
    progress.map((r) => r.summary).sort(),
    [
      'Marked “Objections on the street” as watched',
      'Marked “Objections on the street” as watched',
      'Set the length of video “Objections on the street” to 5:12 (from Ada Admin’s player)',
      'Watched “How to speak so that people want to listen”',
      'Watched “Monday team talk”',
    ].sort(),
  );
  assert.ok(progress.every((r) => r.entity === 'video'));
  // a refused write writes nothing
  assert.equal(auditRows('%').filter((r) => r.summary.includes('Same talk')).length, 0);
});
