/**
 * p10 (lead's addition): on-the-fly gzip / brotli. Negotiation, which responses are compressed, exact Content-Length,
 * Vary, response-cache replays (X-Cache: HIT), 304s, HEAD, ranges, and the /assets LRU.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../app.ts';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { assetCacheStats, bodyCacheStats, chooseEncoding, clearAssetCache, isCompressibleType } from '../lib/compress.ts';
import { startTestServer, type TestServer } from './helpers.ts';

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A request without fetch's automatic decompression, so the bytes on the wire can be checked. */
function raw(base: string, url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const req = http.request({ host: u.hostname, port: Number(u.port), path: u.pathname + u.search, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function decode(r: Raw): Buffer {
  const enc = r.headers['content-encoding'];
  if (enc === 'gzip') return zlib.gunzipSync(r.body);
  if (enc === 'br') return zlib.brotliDecompressSync(r.body);
  return r.body;
}

describe('negotiation', () => {
  test('chooseEncoding: gzip, or brotli when the client prefers it, else none', () => {
    assert.equal(chooseEncoding('gzip, deflate'), 'gzip'); // Node's fetch
    assert.equal(chooseEncoding('gzip, deflate, br, zstd'), 'gzip'); // Chrome: a tie goes to gzip
    assert.equal(chooseEncoding('br;q=0.5, gzip'), 'gzip');
    assert.equal(chooseEncoding('gzip;q=0.8, br'), 'br'); // prefers brotli
    assert.equal(chooseEncoding('br'), 'br'); // accepts only brotli
    assert.equal(chooseEncoding('gzip;q=0, br;q=0'), null);
    assert.equal(chooseEncoding('br;q=0, gzip;q=0.1'), 'gzip');
    assert.equal(chooseEncoding('identity'), null);
    assert.equal(chooseEncoding('*'), 'gzip');
    assert.equal(chooseEncoding('*;q=0.5, br;q=0'), 'gzip');
    assert.equal(chooseEncoding('*;q=0.5, br'), 'br');
    assert.equal(chooseEncoding('GZIP'), 'gzip');
    assert.equal(chooseEncoding(''), null);
    assert.equal(chooseEncoding(undefined), null);
  });

  test('compressible types: JSON, HTML, JS, CSS and SVG only', () => {
    for (const t of ['application/json; charset=utf-8', 'text/html; charset=UTF-8', 'text/javascript', 'application/javascript; charset=utf-8', 'text/css', 'image/svg+xml', 'application/manifest+json']) {
      assert.ok(isCompressibleType(t), t);
    }
    for (const t of ['image/png', 'font/woff2', 'text/plain', 'application/octet-stream', 'application/jsonp', undefined]) assert.equal(isCompressibleType(t), false, String(t));
  });
});

describe('API responses', () => {
  let srv: TestServer;
  let cookie: string;
  let host: string;
  before(async () => {
    srv = await startTestServer({ seed: true });
    const admin = await srv.login('admin');
    cookie = admin.cookie;
    host = srv.base.replace(/\/api$/, '');
  });
  after(async () => {
    await srv.close();
  });

  test('gzip and brotli bodies decode to the identity body, with exact Content-Length and Vary', async () => {
    srv.resetCache();
    const plain = await raw(host, '/api/me/dashboard?range=week', { cookie, 'accept-encoding': 'identity' });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(String(plain.headers.vary), /Accept-Encoding/);
    assert.ok(plain.body.length > 1024, 'the dashboard is big enough to compress');

    for (const [ae, enc] of [['gzip, deflate', 'gzip'], ['gzip, deflate, br, zstd', 'gzip'], ['br, gzip;q=0.9', 'br']] as const) {
      const r = await raw(host, '/api/me/dashboard?range=week', { cookie, 'accept-encoding': ae });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], enc);
      assert.equal(Number(r.headers['content-length']), r.body.length, 'Content-Length is the compressed size');
      assert.match(String(r.headers.vary), /Accept-Encoding/);
      assert.equal(r.headers['x-cache'], 'HIT', 'a response-cache replay is compressed too');
      assert.ok(r.body.length < plain.body.length / 2, `${enc} ${r.body.length} < ${plain.body.length}`);
      assert.deepEqual(JSON.parse(decode(r).toString('utf8')), JSON.parse(plain.body.toString('utf8')));
    }
    // the same bytes again (a response-cache replay) reuse the compressed copy instead of compressing again
    const entries = bodyCacheStats().entries;
    const again = await raw(host, '/api/me/dashboard?range=week', { cookie, 'accept-encoding': 'gzip' });
    assert.equal(again.headers['x-cache'], 'HIT');
    assert.equal(bodyCacheStats().entries, entries);
    assert.deepEqual(JSON.parse(decode(again).toString('utf8')), JSON.parse(plain.body.toString('utf8')));
  });

  test('small bodies, HEAD and 304 are left alone; fetch still reads compressed JSON', async () => {
    const health = await raw(host, '/api/health', { 'accept-encoding': 'gzip, br' });
    assert.equal(health.headers['content-encoding'], undefined, 'under 1 KB');
    assert.equal(JSON.parse(health.body.toString()).ok, true);

    const head = await raw(host, '/api/me/dashboard?range=week', { cookie, 'accept-encoding': 'gzip' }, 'HEAD');
    assert.equal(head.headers['content-encoding'], undefined);

    const users = await raw(host, '/api/users', { cookie, 'accept-encoding': 'gzip' });
    assert.equal(users.headers['content-encoding'], 'gzip');
    const etag = String(users.headers.etag);
    const again = await raw(host, '/api/users', { cookie, 'accept-encoding': 'gzip', 'if-none-match': etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers['content-encoding'], undefined);

    // the tests' own fetch client (Accept-Encoding: gzip, deflate) decodes transparently
    const viaFetch = await fetch(`${srv.base}/users`, { headers: { cookie } });
    assert.equal(viaFetch.headers.get('content-encoding'), 'gzip');
    assert.ok(Array.isArray(await viaFetch.json()));
  });
});

describe('static files', () => {
  let tmp: string;
  let base: string;
  let server: http.Server;
  const js = `export const big = ${JSON.stringify('linear hub '.repeat(4000))};\n`;
  const html = `<!doctype html><html><head><title>Linear Hub</title></head><body>${'<p>shell</p>'.repeat(200)}<script type="module" src="/assets/app-abc123.js"></script></body></html>`;
  const png = Buffer.alloc(4096, 7);

  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-compress-'));
    mkdirSync(path.join(tmp, 'assets'));
    writeFileSync(path.join(tmp, 'index.html'), html);
    writeFileSync(path.join(tmp, 'assets', 'app-abc123.js'), js);
    writeFileSync(path.join(tmp, 'assets', 'logo-abc123.png'), png);
    const db = openDb(':memory:');
    createSchema(db);
    server = http.createServer(createApp(db, { staticDir: tmp }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    clearAssetCache();
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  test('hashed bundles are compressed once and then served from the in-memory cache', async () => {
    const first = await raw(base, '/assets/app-abc123.js', { 'accept-encoding': 'br, gzip;q=0.5' });
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-encoding'], 'br');
    assert.match(String(first.headers['cache-control']), /immutable/);
    assert.equal(Number(first.headers['content-length']), first.body.length);
    assert.equal(first.headers['accept-ranges'], undefined);
    assert.equal(decode(first).toString(), js);
    assert.equal(assetCacheStats().entries, 1);
    const second = await raw(base, '/assets/app-abc123.js', { 'accept-encoding': 'br, gzip;q=0.5' });
    assert.deepEqual(second.body, first.body);
    assert.equal(assetCacheStats().entries, 1, 'served from the cache');
    const gz = await raw(base, '/assets/app-abc123.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(decode(gz).toString(), js);
    assert.equal(assetCacheStats().entries, 2, 'one entry per encoding');
  });

  test('the SPA shell and its fallback are compressed; images, ranges and identity are not', async () => {
    for (const url of ['/', '/login', '/finance?tab=me']) {
      const r = await raw(base, url, { 'accept-encoding': 'gzip' });
      assert.equal(r.status, 200, url);
      assert.equal(r.headers['content-encoding'], 'gzip', url);
      assert.equal(r.headers['cache-control'], 'no-cache', url);
      assert.equal(decode(r).toString(), html, url);
    }
    const img = await raw(base, '/assets/logo-abc123.png', { 'accept-encoding': 'gzip, br' });
    assert.equal(img.headers['content-encoding'], undefined);
    assert.equal(img.body.length, png.length);
    const range = await raw(base, '/assets/app-abc123.js', { 'accept-encoding': 'gzip', range: 'bytes=0-99' });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-encoding'], undefined);
    assert.equal(range.body.length, 100);
    const plain = await raw(base, '/assets/app-abc123.js', { 'accept-encoding': 'identity' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), js);
    assert.match(String(plain.headers.vary), /Accept-Encoding/);
    const unknownApi = await raw(base, '/api/nope', { 'accept-encoding': 'gzip' });
    assert.equal(unknownApi.status, 404);
  });
});
