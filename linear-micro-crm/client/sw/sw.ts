// Linear Hub's offline service worker. Built into dist/sw.js by build/serviceWorkerPlugin.ts, which puts the release
// version and the list of files to save in front of this code (self.__LM_SW__).
//
// - Install: saves the app shell (index.html, every page's code, the stylesheet, the fonts, the icons) in a cache for
//   this release. Hashed bundles an earlier release already saved are copied, not downloaded again.
// - Pages: the network first; with no signal, no answer within a few seconds, or a server error (the app behind the
//   proxy is stopped or restarting), the saved index.html, so the app opens and the router shows the page.
// - /assets/ bundles and app files: the saved copy first, from this release or any other saved one.
// - /api/: never touched (sw/policy.ts), so no personal data is ever kept here.
// - A new release installs in the background and waits; the app asks the person to reload (src/offline/), and the
//   reload tells this worker to take over (message 'SKIP_WAITING'). The old release's cache is then removed, except
//   its own bundles, which are kept one release back for a page still running it.
// The request handling itself is in sw/handlers.ts (tested in Node).
/// <reference lib="webworker" />
import { precache, retireOldReleases, serveSaved, servePage, type WorkerDeps } from './handlers.ts';
import { SHELL_URL, routeFor, shellCacheName } from './policy.ts';

declare const self: ServiceWorkerGlobalScope & { __LM_SW__?: { version: string; precache: string[] } };

const BUILD = self.__LM_SW__ ?? { version: 'dev', precache: [SHELL_URL] };

const deps: WorkerDeps = {
  caches: self.caches,
  fetch: (req) => fetch(req),
  shell: shellCacheName(BUILD.version),
  origin: self.location.origin,
  // a page request waits this long for the server before the saved copy is shown (a hotspot that is out of range)
  pageTimeoutMs: 4000,
};

self.addEventListener('install', (event) => {
  event.waitUntil(precache(deps, BUILD.precache));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await retireOldReleases(deps);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (data?.type === 'GET_VERSION') event.ports[0]?.postMessage({ version: BUILD.version });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const route = routeFor({ method: req.method, url: req.url, mode: req.mode }, self.location.origin);
  if (route === 'network') return;
  if (route === 'page') event.respondWith(servePage(deps, req));
  else event.respondWith(serveSaved(deps, req, (p) => event.waitUntil(p)));
});
