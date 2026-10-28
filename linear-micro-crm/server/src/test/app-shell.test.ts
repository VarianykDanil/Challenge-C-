/**
 * The built app shell as a phone sees it: the page and its fallback, the offline service worker and the web app
 * manifest, and the Content-Security-Policy that lets them load (fonts are served from here, never from Google).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { contentSecurityPolicy, createApp } from '../app.ts';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';

const html = '<!doctype html><html><head><title>Linear Hub</title><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div></body></html>';
const sw = "self.addEventListener('fetch', () => {});\n";
const manifest = JSON.stringify({ name: 'Linear Hub', start_url: '/', display: 'standalone' });

/** A built client in a folder whose path has a dot-folder in it (an install under ~/.local, or a git worktree). */
function makeDist(): { root: string; dist: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linear-shell-'));
  const dist = path.join(root, '.hidden', 'client', 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), html);
  writeFileSync(path.join(dist, 'sw.js'), sw);
  writeFileSync(path.join(dist, 'manifest.webmanifest'), manifest);
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'export {};\n');
  return { root, dist };
}

describe('app shell', () => {
  let root: string;
  let base: string;
  let server: http.Server;

  before(async () => {
    const made = makeDist();
    root = made.root;
    const db = openDb(':memory:');
    createSchema(db);
    server = http.createServer(createApp(db, { staticDir: made.dist }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  test('every page path gets the shell, even when the app is installed under a dot-folder', async () => {
    for (const url of ['/', '/login', '/gauges', '/finance?tab=company', '/events/12']) {
      const r = await fetch(base + url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers.get('cache-control'), 'no-cache', url);
      assert.equal(await r.text(), html, url);
    }
    assert.equal((await fetch(base + '/api/nope')).status, 404, 'API paths never get the shell');
  });

  test('a bundle that does not exist is a 404, never the page (the service worker must not keep a page as code)', async () => {
    const ok = await fetch(base + '/assets/app-abc123.js');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control') ?? '', /immutable/);
    for (const url of ['/assets/Gauges-gone99.js', '/assets/index-old.css', '/assets/']) {
      const r = await fetch(base + url);
      assert.equal(r.status, 404, url);
      assert.doesNotMatch(r.headers.get('content-type') ?? '', /text\/html/, url);
      assert.notEqual(await r.text(), html, url);
    }
  });

  test('the service worker is never cached by the browser, so a new release is picked up at once', async () => {
    const r = await fetch(base + '/sw.js');
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('content-type')), /javascript/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('service-worker-allowed'), '/');
    assert.equal(await r.text(), sw);
  });

  test('the web app manifest is served with its own type and revalidated', async () => {
    const r = await fetch(base + '/manifest.webmanifest');
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('content-type')), /application\/manifest\+json/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(await r.json(), JSON.parse(manifest));
  });
});

describe('content security policy', () => {
  test('fonts come from this server only: no Google Fonts', () => {
    const csp = contentSecurityPolicy();
    assert.doesNotMatch(csp, /googleapis|gstatic/);
    assert.match(csp, /font-src 'self'(;|$| data:)/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'(;|$)/);
  });

  test('the offline service worker and the manifest may load, from this server only', () => {
    const csp = contentSecurityPolicy();
    assert.match(csp, /worker-src 'self'(;|$)/);
    assert.match(csp, /manifest-src 'self'(;|$)/);
  });
});
