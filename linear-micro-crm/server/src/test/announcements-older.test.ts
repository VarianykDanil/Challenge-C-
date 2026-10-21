/**
 * UI fix group UC (release 1.2): the dashboard's "Older announcements" (GET /announcements?offset=5&limit=20 and
 * `olderAnnouncements` on GET /me/dashboard), their read receipts, and lesson titles in the learning audit summaries.
 * On the small fixture: assert order, paging, role scoping and wording, never seeded names.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_TITLES, QUIZ_ANSWER_KEY } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { lessonLabel } from '../lib/auditSpecs.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { ANNOUNCEMENTS_PAGE_MAX } from '../routes/announcements.ts';
import { DASHBOARD_ANNOUNCEMENTS } from '../routes/dashboard.ts';
import { startTestServer, type Json, type TestClient, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15';
setBusinessClock(new Date(`${TODAY}T15:00:00`)); // TZ=Europe/London in the server test script

let srv: TestServer;
let admin: TestClient;
let leader: TestClient;
let recruiter: TestClient;
let rep: TestClient;
let repB: TestClient;
const fx = () => srv.fixture!;
const ids = (list: Json[]) => list.map((a) => a.id as number);
const total = () => Number(get<{ n: number }>(srv.db, 'SELECT COUNT(*) AS n FROM announcements')!.n);

/** Inserts an announcement directly, `hoursAgo` before the business clock's 15:00 today (and clears cached reads). */
function addAnnouncement(authorId: number, title: string, hoursAgo: number, pinned = false): number {
  const at = new Date(Date.parse(`${TODAY}T14:00:00.000Z`) - hoursAgo * 3_600_000).toISOString();
  const id = Number(run(srv.db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES (?, ?, ?, ?, ?)`, [title, `Body of ${title}`, authorId, at, pinned ? 1 : 0]).lastInsertRowid);
  bumpDataVersion();
  return id;
}

before(async () => {
  srv = await startTestServer({ today: TODAY });
  [admin, leader, recruiter, rep, repB] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep'), srv.login('repB')]);
});

after(async () => {
  await srv.close();
  setBusinessClock(null);
});

test('dashboard: no older announcements while there are five or fewer', async () => {
  const existing = total();
  for (let i = existing; i < DASHBOARD_ANNOUNCEMENTS; i++) addAnnouncement(fx().users.admin, `Early notice ${i}`, 500 + i);
  const d = (await rep.get('/me/dashboard')).json;
  assert.equal(d.announcements.length, Math.min(DASHBOARD_ANNOUNCEMENTS, total()));
  assert.equal(d.olderAnnouncements, Math.max(0, total() - DASHBOARD_ANNOUNCEMENTS));
  assert.equal((await rep.get('/announcements?offset=5&limit=20')).json.length, d.olderAnnouncements);
});

test('GET /announcements pages in the dashboard order; without limit it lists every one, as before', async () => {
  const f = fx();
  // 30 more: one pinned (old, but listed first), the rest by the leader and the admin an hour apart
  addAnnouncement(f.users.admin, 'Pinned rota', 900, true);
  for (let i = 0; i < 29; i++) addAnnouncement(i % 2 ? f.users.admin : f.users.leader, `Notice ${i}`, 400 - i * 10);
  // two at the same moment: the id breaks the tie, so the pages never repeat or skip one
  const twinA = addAnnouncement(f.users.leader, 'Twin A', 1);
  const twinB = addAnnouncement(f.users.leader, 'Twin B', 1);

  const everything = (await rep.get('/announcements')).json as Json[];
  assert.equal(everything.length, total(), 'no limit: all of them');
  assert.equal(everything[0].title, 'Pinned rota', 'pinned first');
  const unpinned = everything.filter((a) => !a.pinned);
  for (let i = 1; i < unpinned.length; i++) {
    const [a, b] = [unpinned[i - 1], unpinned[i]];
    assert.ok(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id), `newest first: ${a.title} before ${b.title}`);
  }
  assert.ok(ids(everything).indexOf(twinB) < ids(everything).indexOf(twinA), 'same moment: the later id first');

  const d = (await rep.get('/me/dashboard')).json;
  assert.deepEqual(ids(d.announcements), ids(everything.slice(0, DASHBOARD_ANNOUNCEMENTS)), 'the dashboard shows the first five');
  assert.equal(d.olderAnnouncements, total() - DASHBOARD_ANNOUNCEMENTS);
  const older = (await rep.get('/announcements?offset=5&limit=20')).json as Json[];
  assert.deepEqual(ids(older), ids(everything.slice(5, 25)), 'the twenty after the dashboard’s five');
  assert.ok(older.every((a) => typeof a.title === 'string' && typeof a.body === 'string' && typeof a.authorName === 'string' && typeof a.pinned === 'boolean'));

  // pages join up with no gap and no repeat
  const pages: number[] = [];
  for (let offset = 0; offset < total(); offset += 7) pages.push(...ids((await rep.get(`/announcements?limit=7&offset=${offset}`)).json));
  assert.deepEqual(pages, ids(everything));
  assert.deepEqual((await rep.get(`/announcements?offset=${total()}&limit=5`)).json, [], 'past the end: empty');
  assert.equal((await rep.get('/announcements?limit=500')).json.length, Math.min(ANNOUNCEMENTS_PAGE_MAX, total()), 'limit is capped');
  assert.deepEqual(ids((await rep.get('/announcements?offset=3')).json), ids(everything.slice(3)), 'offset alone: the rest');
});

test('GET /announcements: a bad limit or offset is refused', async () => {
  // beyond 2^53 − 1 the offset would reach SQLite as a REAL and fail with "datatype mismatch" (a 500 before)
  for (const q of ['limit=0', 'limit=-2', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=x', 'offset=99999999999999999999', 'offset=9007199254740992', 'offset=1e300']) {
    assert.equal((await rep.get(`/announcements?${q}`)).status, 400, q);
  }
  assert.equal((await rep.get('/announcements?limit=&offset=')).status, 200, 'empty values are ignored');
  assert.deepEqual((await rep.get('/announcements?offset=9007199254740991&limit=5')).json, [], 'the largest safe offset: an empty page');
});

test('the shared offset rule refuses an out-of-range offset on /audit and /gauges too (400, not a 500)', async () => {
  for (const path of ['/audit', '/gauges']) {
    const huge = await admin.get(`${path}?offset=99999999999999999999`);
    assert.equal(huge.status, 400, `${path} huge offset`);
    assert.equal((await admin.get(`${path}?offset=9007199254740991&limit=5`)).status, 200, `${path} largest safe offset`);
  }
});

test('every role reads the older announcements, as on the dashboard; read receipts stay with the author and admins', async () => {
  const older = ids((await admin.get('/announcements?offset=5&limit=20')).json);
  for (const c of [leader, recruiter, rep, repB]) assert.deepEqual(ids((await c.get('/announcements?offset=5&limit=20')).json), older);

  // the dashboard's single reads request (no ids: the newest 50, pinned first) covers the five and the twenty older
  const adminStats = (await admin.get('/announcements/reads')).json as Json[];
  const shown = ids((await admin.get('/announcements?limit=25')).json);
  for (const id of shown) assert.ok(adminStats.some((s) => s.announcementId === id), `admin has stats for ${id}`);

  const leaderStats = (await leader.get('/announcements/reads')).json as Json[];
  const leaderOlder = all<{ id: number }>(srv.db, `SELECT id FROM announcements WHERE author_id = ?`, [fx().users.leader]).map((r) => r.id).filter((id) => older.includes(id));
  assert.ok(leaderOlder.length > 0, 'the leader wrote some of the older ones');
  for (const id of leaderOlder) assert.ok(leaderStats.some((s) => s.announcementId === id), `the author has stats for ${id}`);
  assert.ok(leaderStats.every((s) => get<{ a: number }>(srv.db, 'SELECT author_id AS a FROM announcements WHERE id = ?', [s.announcementId])!.a === fx().users.leader), 'only their own');
  assert.deepEqual((await rep.get('/announcements/reads')).json, [], 'a rep sees no figures');
  assert.deepEqual((await recruiter.get('/announcements/reads')).json, [], 'nor does a recruiter who wrote none');

  // reading an older one counts like a dashboard read
  const target = leaderOlder[leaderOlder.length - 1]!;
  const beforeCount = leaderStats.find((s) => s.announcementId === target)!.readCount as number;
  assert.equal((await rep.post(`/announcements/${target}/read`)).status, 204);
  const after = ((await leader.get(`/announcements/reads?ids=${target}`)).json as Json[])[0];
  assert.equal(after.readCount, beforeCount + 1);
  assert.ok(after.readers.some((r: Json) => r.userId === fx().users.rep));
});

test('learning audit summaries name the lesson by its title, not its key', async () => {
  const key = 'pre-emptive-strike';
  const title = LESSON_TITLES[key];
  assert.equal(title, 'Pre-emptive strike');
  assert.equal((await rep.post(`/learning/progress/${key}/quiz`, { answers: [...QUIZ_ANSWER_KEY[key]] })).status, 200);
  assert.equal((await rep.post(`/learning/progress/${key}/teachback`, { text: 'Attack the negative before it comes up, then follow straight up with urgency.' })).status, 200);
  assert.equal((await leader.post(`/learning/progress/${fx().users.rep}/${key}/signoff`, { signedOff: true })).status, 200);
  assert.equal((await rep.post('/learning/progress/can-cant-controls/quiz', { answers: QUIZ_ANSWER_KEY['can-cant-controls'].map((a) => (a + 1) % 4) })).status, 200);

  const summaries = all<{ s: string }>(srv.db, `SELECT summary AS s FROM audit_log WHERE entity = 'learning' ORDER BY id`).map((r) => r.s);
  assert.deepEqual(summaries, [
    'Learned “Pre-emptive strike”: self-check passed',
    'Wrote a teach-back: “Pre-emptive strike”',
    'Signed off a teach-back: Remy Rep, “Pre-emptive strike”',
    'Took the self-check: “Can and can’t controls”',
  ]);
  const page = (await admin.get('/audit?entity=learning&q=pre-emptive')).json;
  assert.equal(page.total, 3, 'the title is what the audit search finds');
  assert.equal((await admin.get('/audit?entity=learning&q=pre emptive')).json.total, 0, 'the key in words is no longer written');

  // apostrophes and quotes as a phone keyboard types them find the typographic ones in the summary
  const found = async (q: string) => (await admin.get(`/audit?entity=learning&q=${encodeURIComponent(q)}`)).json.total as number;
  for (const q of ['can’t controls', "can't controls", 'cant controls', 'CANT CONTROLS', 'Can‘t controls']) assert.equal(await found(q), 1, q);
  assert.equal(await found('"pre-emptive strike"'), 3, 'straight double quotes match the curly ones');
  assert.equal(await found('“pre-emptive strike”'), 3, 'and the curly ones still match');
  assert.equal(await found('can not controls'), 0, 'other words still have to match');
  assert.equal((await admin.get(`/audit?entity=learning&q=${encodeURIComponent("'’")}`)).status, 200, 'only apostrophes: no filter');
  assert.equal(await found("'’"), (await admin.get('/audit?entity=learning')).json.total, 'only apostrophes: every row');
  assert.equal(await found('100%'), 0, '% is still literal');
});

test('lessonLabel: every key reads as its title; an unknown key in words', () => {
  for (const [key, title] of Object.entries(LESSON_TITLES)) assert.equal(lessonLabel(key), `“${title}”`);
  assert.equal(lessonLabel('feel-felt-found'), '“Feel felt found”');
  assert.equal(lessonLabel(undefined), 'a lesson');
  assert.equal(lessonLabel(''), 'a lesson');
});
