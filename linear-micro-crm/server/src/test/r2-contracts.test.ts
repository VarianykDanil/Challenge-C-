/**
 * Release 1.2 foundation contract (r2-foundation): the database extension hooks and the mounting of every 1.2 router.
 * Written to keep holding once L1–L2 and U1–U5 replace the stubs: it checks the extension registry, idempotent
 * upgrades, the fresh-install order (upgrade before seed), that the extension seeds leave every core table byte-for-byte
 * the same (hashed under a pinned clock), and that each new path is mounted behind
 * requireAuth (anonymous → 401, signed in → never 404 / 5xx). Owned by the foundation; packages test their own
 * behaviour in their own files.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, type Db } from '../db/connection.ts';
import { EXTENSIONS, upgradeExtensions } from '../db/extensions/index.ts';
import { createSchema, SCHEMA_SQL, upgradeSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { setBusinessClock, todayISO } from '../lib/dates.ts';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

test('extensions: five, in the fixed order, with unique names and the DbExtension shape', () => {
  // Release 1.3 appends its extensions after these five (r3-contracts.test.ts checks the whole list).
  assert.deepEqual(EXTENSIONS.slice(0, 5).map((e) => e.name), ['learning', 'pitches', 'pin', 'audit', 'checkins']);
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

test('a fresh demo seed (with every extension seed) is deterministic and adds no gauge rows, payroll runs or users', () => {
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

/**
 * The core tables (what the core schema alone creates; extension tables are left out) and the columns hashed for each:
 * every column the core schema, its column upgrades and the five 1.2 extensions give it. Release 1.3 (r3-foundation):
 * only the columns the 1.3 extensions add to core tables are left out — each 1.3 extension's seed may fill its own
 * (extensions/types.ts), and r3-contracts.test.ts checks that it writes no other — so a 1.2 column (a PIN on a demo
 * account, a check-in) written by any extension seed still changes the hash, as in 1.2.
 */
function coreColumns(): Map<string, string[]> {
  const db = openDb(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    upgradeSchema(db);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[])
      .map((r) => r.name);
    for (const e of EXTENSIONS.slice(0, 5)) {
      if (e.sql.trim()) db.exec(e.sql);
      e.upgrade(db);
    }
    return new Map(tables.map((t) => [t, (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)]));
  } finally {
    db.close();
  }
}

/**
 * A sha256 per core table over every row and every hashed column (rows sorted, so the order rows went in does not
 * matter). In `meta` the extensions' own `ext:%` keys are left out: an extension may record its flags; every core key
 * is compared. Any inserted or deleted row changes the hash. Release 1.3: the one row exception the plan makes is
 * announcements a client portal account posted (P6's published demo posts).
 */
function coreHashes(db: Db): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [table, columns] of coreColumns()) {
    const where =
      table === 'meta' ? ` WHERE key NOT LIKE 'ext:%'`
      : table === 'announcements' ? ` WHERE author_id NOT IN (SELECT id FROM users WHERE role = 'client')`
      : '';
    const rows = (db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table}${where}`).all() as Record<string, unknown>[]).map((r) => JSON.stringify(r)).sort();
    out[table] = `${rows.length}:${createHash('sha256').update(rows.join('\n')).digest('hex')}`;
  }
  return out;
}

test('every extension seed leaves the core demo data byte-for-byte the same (pinned business clock)', (t) => {
  // Freeze the clock so nowIso (announcements.created_at, gauge submitted_at, meta.seeded_at) is identical on both runs.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T15:00:00') });
  setBusinessClock(null);
  const today = todayISO();
  const seeded = (extensionSeeds: boolean) => {
    const db = openDb(':memory:');
    try {
      createSchema(db);
      seed(db, today, { extensionSeeds });
      return coreHashes(db);
    } finally {
      db.close();
    }
  };
  const core = seeded(false);
  const full = seeded(true);
  assert.ok(Object.keys(core).length >= 15, `hashed ${Object.keys(core).length} core tables`);
  assert.ok(Number(core.users!.split(':')[0]) > 0 && Number(core.gauge_entries!.split(':')[0]) > 0, 'the seed filled the core tables');
  for (const table of Object.keys(core)) assert.equal(full[table], core[table], `core table ${table} changed by an extension seed`);
  assert.deepEqual(seeded(true), full, 'the full seed is deterministic under a pinned clock');
});

test('fresh install order: upgrades run on empty core tables, then seed; the first restart upgrades nothing', () => {
  // index.ts and resetAndSeed call createSchema BEFORE seed, so every extension upgrade first sees an empty database.
  const db = openDb(':memory:');
  try {
    createSchema(db);
    for (const t of ['users', 'campaigns', 'events', 'teams']) {
      assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n), 0, `${t} is empty when upgrades run`);
    }
    seed(db, todayISO());
    // A data step that skipped on the empty database (its rows missing) now finds them: it must insert nothing new over
    // what seed() wrote (INSERT OR IGNORE) and report nothing (types.ts "ORDER ON A FRESH INSTALL").
    assert.deepEqual(createSchema(db), [], 'a restart after a fresh seed reports no extension change');
    assert.deepEqual(createSchema(db), [], 'and stays idempotent');
  } finally {
    db.close();
  }
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
