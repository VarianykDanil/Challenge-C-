// The offline service worker's request handling (sw/handlers.ts), run in Node against fake caches. Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAtRuntime, precache, retireOldReleases, serveSaved, servePage, type CacheLike, type CachesLike, type WorkerDeps } from './handlers.ts';
import { PREVIOUS_CACHE, RUNTIME_CACHE, RUNTIME_LIMIT, shellCacheName } from './policy.ts';

const ORIGIN = 'https://hub.example.test';
const url = (path: string) => `${ORIGIN}${path}`;

/**
 * Like a browser Cache: one entry per URL, and a lookup honours the stored response's Vary header (the request
 * headers it names must match the ones it was saved with) unless `ignoreVary` is set. The app sends
 * `Vary: Origin, Accept-Encoding` on its bundles, and a module import carries an Origin header.
 */
class FakeCache implements CacheLike {
  readonly items = new Map<string, { headers: Headers; res: Response }>();
  private key(r: Request | string): string {
    return typeof r === 'string' ? new URL(r, ORIGIN).href : r.url;
  }
  async match(r: Request | string, options?: { ignoreVary?: boolean }) {
    const hit = this.items.get(this.key(r));
    if (!hit) return undefined;
    if (!options?.ignoreVary) {
      const asked = typeof r === 'string' ? new Headers() : r.headers;
      const vary = (hit.res.headers.get('Vary') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
      if (vary.some((h) => h === '*' || asked.get(h) !== hit.headers.get(h))) return undefined;
    }
    return hit.res.clone();
  }
  async put(r: Request | string, res: Response) {
    // a real cache stores the whole body, and the request's headers for Vary
    const body = await res.arrayBuffer();
    this.items.set(this.key(r), { headers: typeof r === 'string' ? new Headers() : new Headers(r.headers), res: new Response(body, { status: res.status, headers: res.headers }) });
  }
  async keys() {
    return [...this.items.keys()].map((u) => new Request(u));
  }
  async delete(r: Request | string) {
    return this.items.delete(this.key(r));
  }
}

class FakeCaches implements CachesLike {
  readonly all = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.all.get(name);
    if (!c) this.all.set(name, (c = new FakeCache()));
    return c;
  }
  async match(r: Request | string, options?: { cacheName?: string; ignoreVary?: boolean }) {
    if (options?.cacheName) return this.all.get(options.cacheName)?.match(r, options);
    for (const c of this.all.values()) {
      const hit = await c.match(r, options);
      if (hit) return hit;
    }
    return undefined;
  }
  async keys() {
    return [...this.all.keys()];
  }
  async delete(name: string) {
    return this.all.delete(name);
  }
  /** Seed a cache with files: path → body. */
  async seed(name: string, files: Record<string, string>, type = 'application/javascript') {
    const c = await this.open(name);
    // saved as install does: a plain request, and the app's real Vary header
    for (const [path, body] of Object.entries(files)) await c.put(url(path), new Response(body, { headers: { 'Content-Type': type, Vary: 'Origin, Accept-Encoding' } }));
  }
}

const SHELL_A = shellCacheName('aaaaaaaaaaaa');
const SHELL_B = shellCacheName('bbbbbbbbbbbb');

/** The network: answers from `routes` (path → response maker), or fails like a phone with no signal. */
function network(routes: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: string[] = [];
  const fetch = async (req: Request) => {
    const path = new URL(req.url).pathname;
    calls.push(path);
    const make = routes[path];
    if (!make) throw new TypeError('Failed to fetch');
    return make();
  };
  return { fetch, calls };
}

function deps(caches: FakeCaches, fetch: WorkerDeps['fetch'], shell = SHELL_A, pageTimeoutMs = 200): WorkerDeps {
  return { caches, fetch, shell, origin: ORIGIN, pageTimeoutMs };
}

/** A request as the page makes it for a module script: same-origin, with an Origin header. */
const req = (path: string) => new Request(url(path), { headers: { Origin: ORIGIN } });
const text = async (res: Response) => res.text();

test('with no signal, a bundle saved by the release waiting to take over is used (a page already running that release)', async () => {
  // Release A is in charge; release B has installed and waits. The page was reopened online and runs B's code.
  const caches = new FakeCaches();
  await caches.seed(SHELL_A, { '/index.html': 'A page', '/assets/index-A.js': 'A entry', '/assets/Gauges-A.js': 'A gauges' });
  await caches.seed(SHELL_B, { '/index.html': 'B page', '/assets/index-B.js': 'B entry', '/assets/Gauges-B.js': 'B gauges' });
  const net = network();
  const res = await serveSaved(deps(caches, net.fetch), req('/assets/Gauges-B.js'));
  assert.equal(await text(res), 'B gauges');
  assert.deepEqual(net.calls, [], 'no network needed');
});

test("this release's own copy comes first, then any other saved copy, then the network", async () => {
  const caches = new FakeCaches();
  await caches.seed(SHELL_A, { '/assets/shared-1.js': 'from A' });
  await caches.seed(RUNTIME_CACHE, { '/cod-pack/step-1.png': 'picture' }, 'image/png');
  const net = network({ '/assets/new-2.js': () => new Response('from network', { headers: { 'Content-Type': 'application/javascript' } }) });
  const d = deps(caches, net.fetch);
  assert.equal(await text(await serveSaved(d, req('/assets/shared-1.js'))), 'from A');
  assert.equal(await text(await serveSaved(d, req('/cod-pack/step-1.png'))), 'picture');
  assert.equal(await text(await serveSaved(d, req('/assets/new-2.js'))), 'from network');
  await assert.rejects(serveSaved(d, req('/assets/missing-3.js')), TypeError, 'nothing saved and no signal: the request fails as before');
});

test('a page gets the saved app when the server is down behind a proxy (502, 503, 504) or any other 5xx', async () => {
  for (const status of [500, 502, 503, 504]) {
    const caches = new FakeCaches();
    await caches.seed(SHELL_A, { '/index.html': 'saved app' }, 'text/html');
    const net = network({ '/gauges': () => new Response('502 Bad Gateway', { status, headers: { 'Content-Type': 'text/plain' } }) });
    const res = await servePage(deps(caches, net.fetch), new Request(url('/gauges')));
    assert.equal(res.status, 200, String(status));
    assert.equal(await text(res), 'saved app', String(status));
  }
});

test('a page comes from the network when the server answers, and from the saved app with no signal or no answer in time', async () => {
  const caches = new FakeCaches();
  await caches.seed(SHELL_A, { '/index.html': 'saved app' }, 'text/html');
  const online = network({ '/': () => new Response('fresh app', { headers: { 'Content-Type': 'text/html' } }) });
  assert.equal(await text(await servePage(deps(caches, online.fetch), new Request(url('/')))), 'fresh app');
  // a 404 or a redirect is the server's real answer
  const notFound = network({ '/nope': () => new Response('not found', { status: 404 }) });
  assert.equal((await servePage(deps(caches, notFound.fetch), new Request(url('/nope')))).status, 404);

  const offline = network();
  assert.equal(await text(await servePage(deps(caches, offline.fetch), new Request(url('/events')))), 'saved app');

  const stalled = { fetch: () => new Promise<Response>(() => undefined) };
  const started = Date.now();
  assert.equal(await text(await servePage(deps(caches, stalled.fetch, SHELL_A, 50), new Request(url('/quick')))), 'saved app');
  assert.ok(Date.now() - started < 1000);
});

test('with nothing saved yet, a 502 is passed on, and no signal gives a short page that says what to do', async () => {
  const caches = new FakeCaches();
  const bad = network({ '/': () => new Response('502 Bad Gateway', { status: 502 }) });
  assert.equal((await servePage(deps(caches, bad.fetch), new Request(url('/')))).status, 502);
  const res = await servePage(deps(caches, network().fetch), new Request(url('/')));
  assert.equal(res.status, 503);
  assert.match(await text(res), /Open it once with signal/);
});

test("a file request answered with a page (the server's fallback for a missing file) is never kept as that file", async () => {
  const caches = new FakeCaches();
  const d = deps(caches, network().fetch);
  await keepAtRuntime(d, req('/assets/gone-1.js'), new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  await keepAtRuntime(d, req('/assets/gone-2.js'), new Response('not found', { status: 404 }));
  await keepAtRuntime(d, req('/cod-pack/step-2.png'), new Response('png', { headers: { 'Content-Type': 'image/png' } }));
  const runtime = await caches.open(RUNTIME_CACHE);
  assert.deepEqual((await runtime.keys()).map((r) => new URL(r.url).pathname), ['/cod-pack/step-2.png']);
});

test('the runtime cache keeps at most RUNTIME_LIMIT files, dropping the oldest', async () => {
  const caches = new FakeCaches();
  const d = deps(caches, network().fetch);
  for (let i = 0; i < RUNTIME_LIMIT + 3; i++) await keepAtRuntime(d, req(`/cod-pack/p${i}.png`), new Response('x', { headers: { 'Content-Type': 'image/png' } }));
  const keys = (await (await caches.open(RUNTIME_CACHE)).keys()).map((r) => new URL(r.url).pathname);
  assert.equal(keys.length, RUNTIME_LIMIT);
  assert.equal(keys[0], '/cod-pack/p3.png');
});

test('a new release taking over keeps the old release’s own bundles one release back, for a page still running it', async () => {
  const caches = new FakeCaches();
  await caches.seed(SHELL_A, { '/index.html': 'A page', '/assets/shared.js': 'same in both', '/assets/Events-A.js': 'A events' });
  await caches.seed(SHELL_B, { '/index.html': 'B page', '/assets/shared.js': 'same in both', '/assets/Events-B.js': 'B events' });
  await caches.seed(PREVIOUS_CACHE, { '/assets/ancient.js': 'two releases back' });
  const d = deps(caches, network().fetch, SHELL_B);
  await retireOldReleases(d);
  assert.deepEqual([...caches.all.keys()].sort(), [SHELL_B, PREVIOUS_CACHE].sort(), 'the old shell cache is gone');
  const previous = (await (await caches.open(PREVIOUS_CACHE)).keys()).map((r) => new URL(r.url).pathname);
  assert.deepEqual(previous, ['/assets/Events-A.js'], 'only what B lacks; no old page, nothing two releases back');
  // the tab still on release A opens Events with no signal
  assert.equal(await text(await serveSaved(d, req('/assets/Events-A.js'))), 'A events');
});

test('install copies bundles the phone already has (from any earlier release) and downloads the rest', async () => {
  const caches = new FakeCaches();
  await caches.seed(SHELL_A, { '/index.html': 'A page', '/assets/kept.js': 'kept' });
  await caches.seed(PREVIOUS_CACHE, { '/assets/older.js': 'older' });
  const net = network({
    '/index.html': () => new Response('B page', { headers: { 'Content-Type': 'text/html' } }),
    '/assets/fresh.js': () => new Response('fresh', { headers: { 'Content-Type': 'application/javascript' } }),
  });
  await precache(deps(caches, net.fetch, SHELL_B), ['/index.html', '/assets/kept.js', '/assets/older.js', '/assets/fresh.js']);
  assert.deepEqual(net.calls.sort(), ['/assets/fresh.js', '/index.html'], 'the page is always fetched again');
  const b = await caches.open(SHELL_B);
  assert.equal(await text((await b.match(url('/assets/older.js')))!), 'older');
  assert.equal(await text((await b.match(url('/index.html')))!), 'B page');
});

test('install fails (and the old release stays in charge) when a file cannot be saved', async () => {
  const caches = new FakeCaches();
  const net = network({ '/index.html': () => new Response('502 Bad Gateway', { status: 502 }) });
  await assert.rejects(precache(deps(caches, net.fetch, SHELL_B), ['/index.html']), /Could not save \/index.html: 502/);
});
