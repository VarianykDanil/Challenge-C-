// What the offline service worker (sw/sw.ts) does with each request. Pure functions, so they can be tested in Node.
//
// - 'network': not handled at all; the browser fetches as if there were no service worker. Every /api/ request is
//   here, so nothing the server says about people (pay, gauges, names) is ever kept by the service worker. Saves made
//   with no signal are kept by the app's own outbox (src/features/gauges/outbox.ts), as before.
// - 'page': a page opened by address (a navigation). The network first, the saved app shell when there is no signal.
// - 'asset': a hashed bundle under /assets/ (its name changes whenever its content does): the cache first.
// - 'file': other files of the app (icons, manifest, lesson pictures): the cache first, then the network.

export type Route = 'network' | 'page' | 'asset' | 'file';

export interface RequestLike {
  method: string;
  url: string;
  mode: string;
}

/** The saved copy of the page every address opens (the app is one page; the router picks the screen). */
export const SHELL_URL = '/index.html';

/** Files fetched while the app is used (lesson pictures, other alphabets of the font, PDF tools), kept for later. */
export const RUNTIME_CACHE = 'lm-runtime-v1';
/** At most this many files in the runtime cache; the oldest go first. */
export const RUNTIME_LIMIT = 120;

/** The previous release's bundles that this release does not have, for a page still running it (sw/handlers.ts). */
export const PREVIOUS_CACHE = 'lm-previous-v1';

const SHELL_PREFIX = 'lm-shell-';

/** The cache that holds one release's app shell: a new release gets a new cache and the old one is removed. */
export function shellCacheName(version: string): string {
  return `${SHELL_PREFIX}${version}`;
}

export function isShellCache(name: string): boolean {
  return name.startsWith(SHELL_PREFIX);
}

/** A file whose content can be copied from the last release's cache: hashed bundles never change under one name. */
export function reusableFromOldCache(path: string): boolean {
  return path.startsWith('/assets/');
}

/**
 * A page answered with this status gets the saved app shell instead (when one is saved): a 5xx means the app did not
 * answer properly. Behind a proxy (Caddy) a stopped, crashed or restarting app is a 502, 503 or 504 page from the
 * proxy, which would otherwise replace the app on the phone.
 */
export function servesSavedShell(status: number): boolean {
  return status >= 500;
}

export function routeFor(req: RequestLike, origin: string): Route {
  if (req.method !== 'GET') return 'network';
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return 'network';
  }
  if (url.origin !== origin) return 'network';
  const path = url.pathname;
  // Checked before navigations: a payslip PDF opened in a new tab is still an API answer.
  if (path === '/api' || path.startsWith('/api/')) return 'network';
  if (path === '/sw.js') return 'network';
  if (req.mode === 'navigate') return 'page';
  if (path.startsWith('/assets/')) return 'asset';
  return 'file';
}
