// Linear Hub's offline service worker. Built into dist/sw.js by build/serviceWorkerPlugin.ts, which puts the release
// version and the list of files to save in front of this code (self.__LM_SW__).
//
// - Install: saves the app shell (index.html, every page's code, the stylesheet, the fonts, the icons) in a cache for
//   this release. Hashed bundles that the last release already saved are copied, not downloaded again.
// - Pages: the network first; with no signal (or no answer within a few seconds) the saved index.html, so the app
//   opens and the router shows the page.
// - /assets/ bundles and app files: the cache first.
// - /api/: never touched (sw/policy.ts), so no personal data is ever kept here.
// - A new release installs in the background and waits; the app asks the person to reload (src/offline/), and the
//   reload tells this worker to take over (message 'SKIP_WAITING'). The old release's cache is then removed.
/// <reference lib="webworker" />
import { RUNTIME_CACHE, RUNTIME_LIMIT, SHELL_URL, isShellCache, reusableFromOldCache, routeFor, shellCacheName } from './policy.ts';

declare const self: ServiceWorkerGlobalScope & { __LM_SW__?: { version: string; precache: string[] } };

const BUILD = self.__LM_SW__ ?? { version: 'dev', precache: [SHELL_URL] };
const SHELL = shellCacheName(BUILD.version);
/** A page request waits this long for the server before the saved copy is shown (a hotspot that is out of range). */
const PAGE_TIMEOUT_MS = 4000;

async function precache(): Promise<void> {
  const cache = await caches.open(SHELL);
  const old = (await caches.keys()).filter((n) => isShellCache(n) && n !== SHELL);
  await Promise.all(
    BUILD.precache.map(async (url) => {
      if (await cache.match(url)) return;
      if (reusableFromOldCache(url)) {
        for (const name of old) {
          const hit = await (await caches.open(name)).match(url);
          if (hit) return cache.put(url, hit);
        }
      }
      // 'no-cache' revalidates with the server, so a stale HTTP cache never gets saved as the new release
      const res = await fetch(new Request(url, { cache: 'no-cache', credentials: 'same-origin' }));
      if (!res.ok) throw new Error(`Could not save ${url}: ${res.status}`);
      await cache.put(url, res);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (isShellCache(name) && name !== SHELL) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (data?.type === 'GET_VERSION') event.ports[0]?.postMessage({ version: BUILD.version });
});

async function fromShell(url: string): Promise<Response | undefined> {
  return (await caches.open(SHELL)).match(url);
}

async function keepAtRuntime(req: Request, res: Response): Promise<void> {
  if (!res.ok || res.type !== 'basic') return;
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(req, res);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - RUNTIME_LIMIT))) await cache.delete(k);
}

/** The network with a time limit; rejects when offline, on a network error or when it takes too long. */
function fetchWithin(req: Request, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function page(req: Request): Promise<Response> {
  try {
    return await fetchWithin(req, PAGE_TIMEOUT_MS);
  } catch {
    const shell = await fromShell(SHELL_URL);
    if (shell) return shell;
    return new Response('<!doctype html><meta charset="utf-8"><title>Linear Hub</title><p>Linear Hub is not saved on this phone yet. Open it once with signal.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const hit = (await fromShell(path)) ?? (await caches.match(req, { cacheName: RUNTIME_CACHE }));
  if (hit) return hit;
  const res = await fetch(req);
  void keepAtRuntime(req, res.clone()).catch(() => undefined);
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const route = routeFor({ method: req.method, url: req.url, mode: req.mode }, self.location.origin);
  if (route === 'network') return;
  if (route === 'page') event.respondWith(page(req));
  else event.respondWith(cacheFirst(req));
});
