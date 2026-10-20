// Owned by the Frontend Developer.
import type { ApiError as ApiErrorBody, PinSetupRequiredError } from '@lm/shared';

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.details = body?.details;
  }
}

/**
 * The request never got an HTTP answer: no signal, the hotspot dropped, or the server is not running (fetch threw a
 * TypeError). Every HTTP error response is still an ApiError, exactly as before. (Signal-proof logging, p7.)
 */
export class NetworkError extends Error {
  /** The TypeError fetch threw. */
  readonly original: unknown;
  constructor(original?: unknown) {
    super("Can't reach Linear Hub — check the hotspot or Wi-Fi and try again.");
    this.name = 'NetworkError';
    this.original = original;
  }
}

export function isNetworkError(e: unknown): e is NetworkError {
  return e instanceof NetworkError;
}

// A request that could not reach the server is already announced (lm:network → the offline banner). A caller that
// does not catch it — signing out without signal, for one — must not add an "Uncaught (in promise)" error on top.
// Only NetworkError is quietened; every other rejection still reaches the console.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof NetworkError) e.preventDefault();
  });
}

/**
 * Window event, `detail: { online }`: false when a request could not reach the server, true whenever any HTTP
 * response arrives (whatever its status). The offline banner and the gauge outbox listen to it.
 */
export const NETWORK_EVENT = 'lm:network';
export interface NetworkEventDetail { online: boolean }

function announceNetwork(online: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent<NetworkEventDetail>(NETWORK_EVENT, { detail: { online } }));
  } catch {
    /* a listener's problem never breaks the request */
  }
}

/** A successful response with its status and headers (for `201 vs 200` and paging headers such as `X-Total-Count`). */
export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export type ApiInit = RequestInit & { json?: unknown };

/** Like `api()`, but keeps the response status and headers alongside the parsed body. */
export async function apiRaw<T>(path: string, init: ApiInit = {}): Promise<ApiResponse<T>> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'include',
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      ...rest,
    });
  } catch (e) {
    // fetch rejects with a TypeError only when no HTTP answer came back. An abort (TanStack Query cancelling a query)
    // is a DOMException and passes through untouched.
    if (e instanceof TypeError) {
      announceNetwork(false);
      throw new NetworkError(e);
    }
    throw e;
  }
  announceNetwork(true);
  if (res.status === 204) {
    // Drain the (empty) body: an unread fetch body is reported by Chromium as an aborted request in DevTools.
    await res.text().catch(() => undefined);
    return { data: undefined as T, status: res.status, headers: res.headers };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // A 401 on anything but the auth probes means the session ended (expired, deactivated, signed out elsewhere):
    // let the app clear its state and route to sign-in once, instead of every page showing a raw error.
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    // Release 1.2 (U1's PIN gate): once an admin requires a PIN, a signed-in person without one gets 403
    // { pinSetupRequired: true } from every API. Tell the app, so an already open session shows "Create your PIN"
    // (auth/PinSetupGate.tsx re-reads /auth/me) instead of every card failing until a reload.
    if (res.status === 403 && isPinSetupRequiredBody(body) && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PIN_SETUP_REQUIRED_EVENT));
    throw new ApiError(res.status, body);
  }
  return { data: body as T, status: res.status, headers: res.headers };
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return (await apiRaw<T>(path, init)).data;
}

/** `X-Total-Count` as a number, or null when the server did not send one (older servers do not page). */
export function totalCount(headers: Headers): number | null {
  const raw = headers.get('X-Total-Count');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Window event fired when a signed-in request is answered with 401. */
export const UNAUTHENTICATED_EVENT = 'lm:unauthenticated';

/**
 * Release 1.2 (r2-foundation contract for U1): window event fired when any request is answered 403 with the PIN gate's
 * body `{ error, pinSetupRequired: true }` (shared `PinSetupRequiredError`). U1 listens in `auth/PinSetupGate.tsx`.
 */
export const PIN_SETUP_REQUIRED_EVENT = 'lm:pin-setup-required';

function isPinSetupRequiredBody(body: unknown): body is PinSetupRequiredError {
  return typeof body === 'object' && body !== null && (body as { pinSetupRequired?: unknown }).pinSetupRequired === true;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
