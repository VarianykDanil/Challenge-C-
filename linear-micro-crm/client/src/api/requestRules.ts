// When a request to Linear Hub counts as "can't reach Linear Hub" (a NetworkError in api/client.ts) rather than an
// answer from the app. Pure functions with no app imports, so `npm test` runs them in Node (requestRules.test.ts).
//
// - No answer at all: fetch throws (no signal, the hotspot dropped, the server is off).
// - No first answer in time: a weak signal or a server that accepts the connection and never answers.
// - A proxy's error page: behind Caddy, a stopped, crashed or restarting app is a 502, 503 or 504 that the app itself
//   never sent. Linear Hub answers every one of its own errors as JSON { error }, so a 5xx without that is the proxy.
// In all three the app carries on as with no signal: the offline strip shows, gauges and check-ins wait on the phone
// (a gauge day or a check-in sent twice is stored once), and a phone opened from scratch uses the field kit.

/** What a proxy answers when the app behind it did not: Bad Gateway, Service Unavailable, Gateway Timeout. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** True for a proxy's error page (no answer from the app), false for anything the app itself said. */
export function isGatewayFailure(status: number, body: unknown): boolean {
  if (!GATEWAY_STATUSES.has(status)) return false;
  const fromApp = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string';
  return !fromApp;
}

/** The sign-in check when the app opens: a phone in a weak spot opens as the person last signed in after this long. */
export const AUTH_PROBE_TIMEOUT_MS = 6_000;
/** Any other read: after this long with no first answer the page says "You're offline" instead of loading forever. */
export const GET_TIMEOUT_MS = 15_000;

/**
 * How long a request may wait for the server's first answer (its headers; a long download after that is not cut
 * short). Reads only: a save that took too long may still have been made, so saves wait as long as the browser does.
 * `explicit` (a number, or null for no limit) overrides the rule.
 */
export function requestTimeoutMs(method: string | undefined, explicit?: number | null): number | null {
  if (explicit !== undefined) return explicit;
  return (method ?? 'GET').toUpperCase() === 'GET' ? GET_TIMEOUT_MS : null;
}

/** The time limit passed with no answer from the server. */
export class RequestTimeout extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`No answer from Linear Hub within ${Math.round(ms / 1000)} seconds`);
    this.name = 'RequestTimeout';
    this.ms = ms;
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * fetch with a time limit on the first answer. The caller's own signal (TanStack Query cancelling a query) still
 * aborts it and rejects as before; only the time limit rejects with RequestTimeout. No limit (null): plain fetch.
 */
export async function fetchWithin(doFetch: FetchLike, input: string, init: RequestInit, ms: number | null): Promise<Response> {
  if (ms === null) return doFetch(input, init);
  const ctl = new AbortController();
  const outer = init.signal ?? null;
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctl.abort(outer.reason), { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  try {
    return await doFetch(input, { ...init, signal: ctl.signal });
  } catch (e) {
    if (timedOut) throw new RequestTimeout(ms);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
