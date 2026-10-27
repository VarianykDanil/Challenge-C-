/**
 * The packages the server runs with are past the versions that fixed their published security advisories, and what
 * those advisories describe does not happen here:
 * - a list far longer than allowed is refused at once with one short answer, not checked item by item (zod);
 * - a compressed body with extra bytes after it gets an answer and the server stays up (body-parser);
 * - a refused request lists a handful of problems in plain words, never thousands.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import zlib from 'node:zlib';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

const require = createRequire(import.meta.url);

/** The version Node actually loads for `name`, looked up from where `from` sits (as the server resolves it). */
function installedVersion(name: string, from?: string): string {
  const req = from ? createRequire(require.resolve(from)) : require;
  return (req(`${name}/package.json`) as { version: string }).version;
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(/[.-]/).slice(0, 3).map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

test('the server runs with versions past the published fixes', () => {
  const checks = [
    { name: 'body-parser', from: 'express', floor: '2.4.0', advisory: 'GHSA-27r3-jxmh-p828 (denial of service, compressed bodies)' },
    { name: 'zod', floor: '4.6.6', advisory: 'GHSA-mrhx-c7xc-m3w5 (memory exhaustion, oversized lists)' },
    { name: 'nodemailer', from: 'mailparser', floor: '10.1.4', advisory: 'GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h (address parsing)' },
  ];
  for (const c of checks) {
    const v = installedVersion(c.name, c.from);
    assert.ok(atLeast(v, c.floor), `${c.name} ${v} is older than ${c.floor}, which fixed ${c.advisory}: run npm install`);
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

test('a list far over its limit is refused with one problem, before any item is checked', async () => {
  // PUT /recruitment/questions/order takes at most 200 ids; send 100,000 things that are not ids
  const started = Date.now();
  const r = await admin.put('/recruitment/questions/order', { interviewType: 'final', ids: Array.from({ length: 100_000 }, () => 'x') });
  const ms = Date.now() - started;
  const size = JSON.stringify(r.json).length;
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Validation failed');
  const details = r.json.details as { path: string; message: string }[];
  // counts first: a deepEqual diff of 100,000 problems would take the test runner down with it
  assert.equal(details.length, 1, `${details.length} problems listed, ${size} characters, ${ms} ms`);
  assert.deepEqual(details, [{ path: 'ids', message: 'At most 200' }]);
  assert.ok(size < 500, `${size} characters`);
  assert.ok(ms < 2_000, `answered in ${ms} ms`);
});

test('a refused request lists at most 20 problems, then says how many more there are', async () => {
  // 200 ids is allowed, so each of the 200 bad ones is a problem of its own
  const r = await admin.put('/recruitment/questions/order', { interviewType: 'final', ids: Array.from({ length: 200 }, () => 'x') });
  assert.equal(r.status, 400);
  const details = r.json.details as { path: string; message: string }[];
  assert.equal(details.length, 21);
  assert.deepEqual(details[0], { path: 'ids.0', message: 'Expected a number' });
  assert.deepEqual(details[20], { path: '', message: 'And 180 more problems' });
});

test("zod's own messages are plain words; a schema's own message still wins", async () => {
  const campaignId = srv.fixture!.campaignId;
  const cases: [string, unknown, { path: string; message: string }[]][] = [
    ['empty text', { name: '   ' }, [{ path: 'name', message: 'Required' }]],
    ['too long', { code: 'ABCDEFGH' }, [{ path: 'code', message: 'Use at most 6 characters' }]],
    ['wrong choice', { sector: 'shipping' }, [{ path: 'sector', message: 'Choose one of: charity, energy, telecoms, broadband, other' }]],
    ['wrong type', { active: 'yes' }, [{ path: 'active', message: 'Expected true or false' }]],
    ['too small', { payoutPerSale: 0 }, [{ path: 'payoutPerSale', message: 'Must be more than 0' }]],
    ['own message', { color: 'red' }, [{ path: 'color', message: 'Expected a hex colour like #4F46E5' }]],
  ];
  for (const [what, body, details] of cases) {
    const r = await admin.patch(`/campaigns/${campaignId}`, body);
    assert.equal(r.status, 400, what);
    assert.deepEqual(r.json.details, details, what);
  }
  const missing = await admin.post('/events', {});
  assert.equal(missing.status, 400);
  assert.ok((missing.json.details as { path: string; message: string }[]).some((d) => d.path === 'campaignId' && d.message === 'Required'), JSON.stringify(missing.json));
});

/** A raw request: Node's fetch cannot send a body longer than its compressed JSON. */
function rawPost(port: number, path: string, headers: Record<string, string>, chunks: Buffer[], gapMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.write(chunks[0]);
    setTimeout(() => {
      for (const c of chunks.slice(1)) req.write(c);
      req.end();
    }, gapMs);
  });
}

test('a compressed body with extra bytes after it gets an answer, and the server stays up', async () => {
  const port = Number(new URL(srv.base).port);
  const json = Buffer.from(JSON.stringify({ email: 'nobody@example.test', employeeId: 'LM-9999' }));
  const junk = Buffer.alloc(64 * 1024, 0x41);
  for (const [encoding, packed] of [['gzip', zlib.gzipSync(json)], ['deflate', zlib.deflateSync(json)], ['br', zlib.brotliCompressSync(json)]] as const) {
    for (const gapMs of [0, 150]) {
      const r = await rawPost(
        port,
        '/api/auth/login',
        { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': String(packed.length + junk.length) },
        [packed, junk],
        gapMs,
      );
      assert.ok(r.status >= 400 && r.status < 500, `${encoding}, extra bytes after ${gapMs} ms: ${r.status} ${r.body.slice(0, 120)}`);
      const health = await srv.anon().get('/health');
      assert.equal(health.status, 200, `${encoding}: still answering`);
    }
  }
});
