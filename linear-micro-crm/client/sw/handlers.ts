// What the offline service worker does with requests and caches. Written against the Cache API and fetch passed in
// (WorkerDeps), so sw/handlers.test.ts runs it in Node with fake caches; sw/sw.ts wires it to the browser's.
import { PREVIOUS_CACHE, RUNTIME_CACHE, RUNTIME_LIMIT, SHELL_URL, isShellCache, reusableFromOldCache, servesSavedShell } from './policy.ts';

/** Lookups ignore the Vary header: the app sends `Vary: Origin, Accept-Encoding`, a page's module import carries an
 * Origin header that install's own requests do not, and a saved file is the same whatever either says. */
const ANY_VARY = { ignoreVary: true } as const;

/** The parts of a browser Cache this worker uses. */
export interface CacheLike {
  match(request: Request | string, options?: { ignoreVary?: boolean }): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  keys(): Promise<readonly Request[]>;
  delete(request: Request | string): Promise<boolean>;
}

/** The parts of the browser's CacheStorage (self.caches) this worker uses. */
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  /** Looks in every cache of this site, or only in `cacheName`. */
  match(request: Request | string, options?: { cacheName?: string; ignoreVary?: boolean }): Promise<Response | undefined>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface WorkerDeps {
  caches: CachesLike;
  fetch: (request: Request) => Promise<Response>;
  /** This release's shell cache (policy.ts shellCacheName). */
  shell: string;
  /** The site's origin, e.g. https://hub.example.test. */
  origin: string;
  /** A page waits this long for the server before the saved copy is shown. */
  pageTimeoutMs: number;
}

const OFFLINE_PAGE = '<!doctype html><meta charset="utf-8"><title>Linear Hub</title><p>Linear Hub is not saved on this phone yet. Open it once with signal.</p>';

function absolute(deps: WorkerDeps, path: string): string {
  return new URL(path, deps.origin).href;
}

/** The network with a time limit; rejects when offline, on a network error or when it takes too long. */
function fetchWithin(deps: WorkerDeps, req: Request, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    deps.fetch(req).then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Install: save every file of this release. Hashed bundles the last release already saved are copied, not downloaded. */
export async function precache(deps: WorkerDeps, urls: readonly string[]): Promise<void> {
  const cache = await deps.caches.open(deps.shell);
  const older = (await deps.caches.keys()).filter((n) => (isShellCache(n) && n !== deps.shell) || n === PREVIOUS_CACHE);
  await Promise.all(
    urls.map(async (url) => {
      const key = absolute(deps, url);
      if (await cache.match(key, ANY_VARY)) return;
      if (reusableFromOldCache(url)) {
        for (const name of older) {
          const hit = await (await deps.caches.open(name)).match(key, ANY_VARY);
          if (hit) return cache.put(key, hit);
        }
      }
      // 'no-cache' revalidates with the server, so a stale HTTP cache never gets saved as the new release
      // (cast: Node's RequestInit, used when this file is tested, has no `cache`)
      const res = await deps.fetch(new Request(key, { cache: 'no-cache', credentials: 'same-origin' } as RequestInit));
      if (!res.ok) throw new Error(`Could not save ${url}: ${res.status}`);
      await cache.put(key, res);
    }),
  );
}

/**
 * Activate: the old release's shell cache goes. Its bundles that this release does not have are kept in one
 * "previous release" cache, so a page still running the old release (another tab, or the home-screen app) can open
 * its other screens with no signal until it reloads. Only one release back is kept.
 */
export async function retireOldReleases(deps: WorkerDeps): Promise<void> {
  const names = await deps.caches.keys();
  const old = names.filter((n) => isShellCache(n) && n !== deps.shell);
  if (!old.length) return;
  const current = await deps.caches.open(deps.shell);
  await deps.caches.delete(PREVIOUS_CACHE);
  const previous = await deps.caches.open(PREVIOUS_CACHE);
  for (const name of old) {
    const cache = await deps.caches.open(name);
    for (const req of await cache.keys()) {
      if (!reusableFromOldCache(new URL(req.url).pathname) || (await current.match(req, ANY_VARY))) continue;
      const res = await cache.match(req, ANY_VARY);
      if (res) await previous.put(req, res);
    }
    await deps.caches.delete(name);
  }
}

/**
 * A page opened by address: the network first. With no signal, no answer in time, or a server error (5xx: the app
 * behind the proxy is stopped or restarting, so the proxy says 502), the saved app shell, so the app still opens.
 */
export async function servePage(deps: WorkerDeps, req: Request): Promise<Response> {
  let res: Response | null = null;
  try {
    res = await fetchWithin(deps, req, deps.pageTimeoutMs);
    if (!servesSavedShell(res.status)) return res;
  } catch {
    res = null;
  }
  const shell = await (await deps.caches.open(deps.shell)).match(absolute(deps, SHELL_URL), ANY_VARY);
  if (shell) return shell;
  return res ?? new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Keeps a file fetched while the app is used (lesson pictures, other alphabets of the font), at most RUNTIME_LIMIT. */
export async function keepAtRuntime(deps: WorkerDeps, req: Request, res: Response): Promise<void> {
  if (!res.ok || res.type === 'opaque' || res.type === 'error') return;
  // A file request answered with a page is the server's "no such file" fallback (index.html), never the file.
  if ((res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html')) return;
  const cache = await deps.caches.open(RUNTIME_CACHE);
  await cache.put(req, res);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - RUNTIME_LIMIT))) await cache.delete(k);
}

/**
 * A bundle or other app file: the saved copy first. This release's shell, then every other cache of the site: the
 * release waiting to take over (a page already running it needs its bundles) and the previous release (a page still
 * running that one). Hashed bundles never change under one name, so any saved copy is the right one.
 */
export async function serveSaved(deps: WorkerDeps, req: Request, waitUntil: (p: Promise<unknown>) => void = () => undefined): Promise<Response> {
  const path = new URL(req.url).pathname;
  const hit = (await (await deps.caches.open(deps.shell)).match(absolute(deps, path), ANY_VARY)) ?? (await deps.caches.match(req, ANY_VARY));
  if (hit) return hit;
  const res = await deps.fetch(req);
  // kept in the background, so the page gets the file without waiting for the copy
  waitUntil(keepAtRuntime(deps, req, res.clone()).catch(() => undefined));
  return res;
}
