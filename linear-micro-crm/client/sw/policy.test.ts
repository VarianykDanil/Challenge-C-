// What the offline service worker does with each request (sw/policy.ts). Run by `npm test` (node:test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_CACHE, isShellCache, reusableFromOldCache, routeFor, shellCacheName } from './policy.ts';

const ORIGIN = 'https://hub.example.test';
const req = (path: string, init: { method?: string; mode?: string; origin?: string } = {}) => ({
  method: init.method ?? 'GET',
  url: `${init.origin ?? ORIGIN}${path}`,
  mode: init.mode ?? 'cors',
});

test('API requests are never handled, so no personal data is ever cached', () => {
  for (const path of ['/api/auth/me', '/api/finance/payroll?mine=1', '/api/pay/breakdown', '/api', '/api/']) {
    assert.equal(routeFor(req(path), ORIGIN), 'network', path);
  }
  // a file the app opens as a page (a payslip PDF) is still the API
  assert.equal(routeFor(req('/api/invoices/12/pdf', { mode: 'navigate' }), ORIGIN), 'network');
  assert.equal(routeFor(req('/api/gauges', { method: 'POST' }), ORIGIN), 'network');
});

test('only GET requests to this server are handled', () => {
  assert.equal(routeFor(req('/assets/app-1.js', { method: 'POST' }), ORIGIN), 'network');
  assert.equal(routeFor(req('/assets/app-1.js', { origin: 'https://www.youtube.com' }), ORIGIN), 'network');
  assert.equal(routeFor(req('/vi/abc/hqdefault.jpg', { origin: 'https://i.ytimg.com' }), ORIGIN), 'network');
});

test('pages open from the saved app shell when there is no signal', () => {
  for (const path of ['/', '/gauges', '/events/12', '/finance?tab=me', '/learning/pack/five-steps', '/login']) {
    assert.equal(routeFor(req(path, { mode: 'navigate' }), ORIGIN), 'page', path);
  }
});

test('hashed bundles and other app files come from the cache first', () => {
  assert.equal(routeFor(req('/assets/index-Abc123.js'), ORIGIN), 'asset');
  assert.equal(routeFor(req('/assets/inter-latin-wght-normal-Dx4k.woff2'), ORIGIN), 'asset');
  assert.equal(routeFor(req('/icons/icon-192.png'), ORIGIN), 'file');
  assert.equal(routeFor(req('/cod-pack/five-steps.png'), ORIGIN), 'file');
  assert.equal(routeFor(req('/manifest.webmanifest'), ORIGIN), 'file');
});

test('the service worker script itself always comes from the network', () => {
  assert.equal(routeFor(req('/sw.js'), ORIGIN), 'network');
});

test('cache names: one shell cache per release, old ones recognised for clean-up', () => {
  assert.equal(shellCacheName('abc123'), 'lm-shell-abc123');
  assert.ok(isShellCache('lm-shell-0f0f0f'));
  assert.ok(!isShellCache(RUNTIME_CACHE));
  assert.ok(!isShellCache('some-other-cache'));
});

test('only hashed bundles are copied from the previous release; the page and icons are fetched again', () => {
  assert.ok(reusableFromOldCache('/assets/Gauges-B9zj-xMe.js'));
  assert.ok(!reusableFromOldCache('/index.html'));
  assert.ok(!reusableFromOldCache('/manifest.webmanifest'));
  assert.ok(!reusableFromOldCache('/icons/icon-192.png'));
});
