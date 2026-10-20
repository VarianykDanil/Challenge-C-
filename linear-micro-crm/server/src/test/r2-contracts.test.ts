/**
 * Release 1.2 foundation contract (r2-foundation): the database extension hooks and the mounting of every 1.2 router.
 * Written to keep holding once L1–L2 and U1–U5 replace the stubs: it checks the extension registry, idempotent
 * upgrades, that a fresh seed leaves the core demo data unchanged, and that each new path is mounted behind
 * requireAuth (anonymous → 401, signed in → never 404 / 5xx). Owned by the foundation; packages test their own
 * behaviour in their own files.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.ts';
import { EXTENSIONS, upgradeExtensions } from '../db/extensions/index.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { todayISO } from '../lib/dates.ts';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

test('extensions: five, in the fixed order, with unique names and the DbExtension shape', () => {
  assert.deepEqual(EXTENSIONS.map((e) => e.name), ['learning', 'pitches', 'pin', 'audit', 'checkins']);
  for (const e of EXTENSIONS) {
    assert.equal(typeof e.sql, 'string', `${e.name}.sql`);
    assert.equal(typeof e.upgrade, 'function', `${e.name}.upgrade`);
    assert.ok(e.seed === undefined || typeof e.seed === 'function', `${e.name}.seed`);
  }
});

test('createSchema runs the extensions idempotently: a second run changes nothing', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    assert.deepEqual(createSchema(db), [], 'second createSchema adds nothing');
    assert.deepEqual(upgradeExtensions(db), [], 'extension upgrades are idempotent');
    for (const name of createSchema(db)) assert.ok(!name.includes(':'), `no extension change left over: ${name}`);
  } finally {
    db.close();
  }
});

test('a fresh demo seed (with every extension seed) keeps the core demo data: same counts on two databases', () => {
  const today = todayISO();
  const counts = () => {
    const db = openDb(':memory:');
    try {
      createSchema(db);
      const stats = seed(db, today);
      const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      return { stats, gauges: n('gauge_entries'), payroll: n('payroll_runs'), users: n('users') };
    } finally {
      db.close();
    }
  };
  const a = counts();
  const b = counts();
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.gauges, a.stats.gauges, 'extensions add no gauge rows');
  assert.equal(a.payroll, a.stats.payrollRuns, 'extensions add no payroll runs');
  assert.equal(a.users, a.stats.users, 'extensions add no users');
});

let srv: TestServer;
let admin: TestClient;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
});
after(async () => {
  await srv.close();
});

const fx = () => srv.fixture!;

/** Every 1.2 path that must be mounted behind requireAuth: [method, path]. */
const ROUTES = (): [string, string][] => [
  ['GET', '/learning/progress'],
  ['GET', '/learning/team'],
  ['GET', `/learning/progression/${fx().users.rep}`],
  ['POST', '/learning/progress/five-steps/quiz'],
  ['GET', '/pitches'],
  ['GET', '/pitches/FXC'],
  ['PUT', '/pitches/FXC'],
  ['POST', '/gauges/bulk'],
  ['GET', '/audit'],
  ['GET', `/audit/payroll_run/1`],
  ['GET', '/announcements/reads'],
  ['POST', '/announcements/1/read'],
  ['GET', `/checkins?eventId=${fx().events.todayA}`],
  ['POST', '/checkins'],
  ['GET', '/search?q=re'],
  ['GET', '/finance/payroll/export?weekStart=2026-01-05&format=xero'],
];

test('1.2 routes: anonymous → 401 on every new path', async () => {
  const anon = srv.anon();
  for (const [method, path] of ROUTES()) {
    const r = await anon.req(method, path, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('1.2 routes: mounted for a signed-in admin (never the JSON 404 of an unknown path, never a 5xx except 501 stubs)', async () => {
  for (const [method, path] of ROUTES()) {
    const r = await admin.req(method, path, method === 'GET' ? undefined : {});
    assert.ok(r.status < 500 || r.status === 501, `${method} ${path} → ${r.status}`);
    // A mounted router may still answer 404 for a missing record (e.g. no pitch for FXC), but never "Not found" for the path itself.
    if (r.status === 404) assert.notEqual(r.json?.error, 'Not found', `${method} ${path} is not mounted`);
  }
});

test('existing paths beside the new mounts still answer as before', async () => {
  assert.equal((await admin.get('/announcements')).status, 200);
  assert.equal((await admin.get('/finance/payroll?status=pending')).status, 200);
  assert.equal((await admin.get(`/gauges?eventId=${fx().events.yesterdayA}`)).status, 200);
});
