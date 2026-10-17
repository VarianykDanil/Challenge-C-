/**
 * Short-TTL response cache for the read-mostly aggregate endpoints (dashboard, finance/recruitment/gauges
 * summaries, leaderboard). Entries are keyed by (user, role, URL) so nobody ever sees another person's view, live
 * for `CACHE_TTL_MS`, and are all invalidated the moment the data version moves: every mutating `/api` request and
 * every maintenance job that changes rows bumps it (`bumpDataVersion`), so a write is visible on the next read.
 * The map is a small LRU (`CACHE_MAX_ENTRIES`); only `200` JSON bodies are stored, never errors. Responses carry
 * `X-Cache: HIT | MISS` so the behaviour can be verified.
 */
import type { RequestHandler } from 'express';

export const CACHE_TTL_MS = 20_000;
export const CACHE_MAX_ENTRIES = 500;
/** Response headers that are stored with the body and replayed on a hit. */
const REPLAYED_HEADERS = ['x-total-count'];

interface Entry {
  version: number;
  expires: number;
  body: string;
  headers: Record<string, string>;
}

let dataVersion = 0;
const store = new Map<string, Entry>();

/** Call after anything that changes data the cached endpoints read; every cached entry becomes stale at once. */
export function bumpDataVersion(): void {
  dataVersion++;
}

export function currentDataVersion(): number {
  return dataVersion;
}

/** Test hook. */
export function clearResponseCache(): void {
  store.clear();
}

export function responseCache(ttlMs = CACHE_TTL_MS): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' || !req.user) return next();
    const key = `${req.user.id}|${req.user.role}|${req.originalUrl}`;
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.version === dataVersion && hit.expires > now) {
      store.delete(key);
      store.set(key, hit); // most recently used last
      for (const [h, v] of Object.entries(hit.headers)) res.setHeader(h, v);
      res.setHeader('X-Cache', 'HIT');
      res.status(200).set('Content-Type', 'application/json; charset=utf-8').send(hit.body);
      return;
    }
    if (hit) store.delete(key);
    res.setHeader('X-Cache', 'MISS');
    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 200) {
        const text = JSON.stringify(body);
        const headers: Record<string, string> = {};
        for (const h of REPLAYED_HEADERS) {
          const v = res.getHeader(h);
          if (v !== undefined) headers[h] = String(v);
        }
        while (store.size >= CACHE_MAX_ENTRIES) {
          const oldest = store.keys().next().value;
          if (oldest === undefined) break;
          store.delete(oldest);
        }
        store.set(key, { version: dataVersion, expires: Date.now() + ttlMs, body: text, headers });
        return res.set('Content-Type', 'application/json; charset=utf-8').send(text);
      }
      return original(body);
    }) as typeof res.json;
    next();
  };
}
