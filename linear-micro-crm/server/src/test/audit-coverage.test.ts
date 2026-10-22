/**
 * Release 1.3 — P9 audit-everything: the audit COVERAGE test. Every write route in the Express app (lib/routeTable.ts
 * listApiRoutes: every POST, PUT, PATCH and DELETE) must have an audit spec in the registry (lib/audit/registry.ts:
 * the 1.3 packages' spec files, then lib/auditSpecs.ts), matched by its OWN pattern (no spec of another route catching
 * it first), or be a `skip: true` spec — a deliberate decision (read receipts of one record or a batch, POST /audit/events,
 * which records itself).
 *
 * A route still answering 501 for every role is a 1.3 stub whose package has not landed yet: it writes nothing, so it
 * needs no spec yet. The moment it answers anything else (it was built), the test fails until its package registers a
 * spec. Only routes WITHOUT a spec are probed, with a made-up id and an empty body, so a merged release probes nothing.
 * And every spec must name a route that exists (a typo in a pattern would otherwise never match anything).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.ts';
import { allAuditSpecs, matchAuditSpec } from '../lib/audit/registry.ts';
import { listApiRoutes, type ApiRoute } from '../lib/routeTable.ts';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** "/learning/progress/:userId/:lessonKey/signoff" → "/learning/progress/:/:/signoff" (lower case). */
const shape = (path: string) => path.toLowerCase().replace(/:[A-Za-z0-9_]+/g, ':').replace(/\/+$/, '') || '/';
/** A concrete path for a pattern: every parameter becomes a made-up id. */
const sample = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, '987654');

let srv: TestServer;
let clients: Record<string, TestClient>;
let routes: ApiRoute[];

before(async () => {
  srv = await startTestServer();
  const [admin, leader, recruiter, rep, client] = await Promise.all(['admin', 'leader', 'recruiter', 'rep', 'client'].map((r) => srv.login(r as 'admin')));
  clients = { admin: admin!, leader: leader!, recruiter: recruiter!, rep: rep!, client: client! };
  routes = listApiRoutes(createApp(srv.db)).filter((r) => WRITES.has(r.method));
});

after(async () => {
  await srv.close();
});

/** Does any role get 501 (a stub) from this route? */
async function isStub(route: ApiRoute): Promise<boolean> {
  for (const role of ['admin', 'leader', 'recruiter', 'rep', 'client']) {
    const res = await clients[role]!.req(route.method, sample(route.path), {});
    if (res.status === 501) return true;
  }
  return false;
}

test('every write route in the app has an audit spec of its own (or is a 501 stub whose package has not landed)', async (t) => {
  assert.ok(routes.length > 60, `${routes.length} write routes`);
  const missing: string[] = [];
  const shadowed: string[] = [];
  const stubs: string[] = [];
  for (const r of routes) {
    const match = matchAuditSpec(r.method, sample(r.path));
    const label = `${r.method} ${r.path}`;
    if (match) {
      if (shape(match.spec.pattern) !== shape(r.path)) shadowed.push(`${label} is caught by the spec for ${match.spec.pattern}`);
      continue;
    }
    if (await isStub(r)) stubs.push(label);
    else missing.push(label);
  }
  if (stubs.length) t.diagnostic(`1.3 stubs awaiting their package's audit spec (${stubs.length}): ${stubs.join(', ')}`);
  assert.deepEqual(missing, [], 'write routes without an audit spec (add one in your package\'s lib/audit/<package>Specs.ts)');
  assert.deepEqual(shadowed, [], 'write routes matched by another route\'s spec (list literal paths before :param ones)');
});

test('every audit spec names a route that exists, with the same method', () => {
  const known = new Set(routes.map((r) => `${r.method} ${shape(r.path)}`));
  const dead = allAuditSpecs().filter((s) => !known.has(`${s.method} ${shape(s.pattern)}`)).map((s) => `${s.method} ${s.pattern}`);
  assert.deepEqual(dead, [], 'specs whose route does not exist');
});

test('no two specs share a method and pattern unless a package refines a 1.2 spec (the first one wins)', () => {
  const seen = new Map<string, number>();
  for (const s of allAuditSpecs()) {
    const key = `${s.method} ${shape(s.pattern)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seen) assert.ok(n <= 2, `${key} has ${n} specs`);
});

/**
 * A read receipt: `POST /<prefix>/:id/read` (one record, e.g. POST /announcements/:id/read) or `POST /<prefix>/read`
 * (a batch, e.g. P6's POST /client-posts/read). Each keeps its own table of who read what, so the trail skips it.
 */
const READ_RECEIPT = /^POST \/[a-z-]+(\/:id)?\/read$/;

test('the read-receipt rule: one record or a batch, POST only, nothing else that ends in "read"', () => {
  for (const ok of ['POST /announcements/:id/read', 'POST /client-posts/:id/read', 'POST /client-posts/read']) assert.ok(READ_RECEIPT.test(ok), ok);
  for (const no of ['POST /client-posts/:id/approve', 'POST /client-posts', 'DELETE /client-posts/:id/read', 'PUT /client-posts/read', 'POST /client-posts/:id/reader', 'POST /a/:id/b/:id/read', 'POST /audit/events']) {
    assert.ok(!READ_RECEIPT.test(no), no);
  }
});

test('only read receipts (their own table) and the page reports that record themselves are skipped', () => {
  const skipped = allAuditSpecs().filter((s) => s.skip).map((s) => `${s.method} ${s.pattern}`);
  assert.ok(skipped.includes('POST /announcements/:id/read') && skipped.includes('POST /audit/events'));
  const other = skipped.filter((s) => s !== 'POST /audit/events' && !READ_RECEIPT.test(s));
  assert.deepEqual(other, [], 'every other write is recorded (a write that changed nothing answers [] from `after` instead)');
});
