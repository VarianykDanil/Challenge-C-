// Owned by the Frontend Developer.
import type { ApiError as ApiErrorBody, PinSetupRequiredError, TwoFactorSetupRequiredError } from '@lm/shared';
import { isSessionEndedDetails, noteSessionEnded } from './sessionEnd';
import { RequestTimeout, fetchWithin, isGatewayFailure, requestTimeoutMs } from './requestRules';

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
 * Why a request counts as "can't reach Linear Hub" (api/requestRules.ts): no answer at all (fetch threw), no first
 * answer in time, or a proxy's 502/503/504 page because the app behind it is stopped or restarting.
 */
export type NetworkFailure = 'unreachable' | 'timeout' | 'gateway';

/**
 * The app never answered: no signal, the hotspot dropped, the server is not running, no answer in time, or a proxy
 * said the app is down. Every answer from the app itself is still an ApiError. (Signal-proof logging, p7.)
 */
export class NetworkError extends Error {
  /** What fetch threw, the time-out, or the proxy's status. */
  readonly original: unknown;
  readonly reason: NetworkFailure;
  constructor(original?: unknown, reason: NetworkFailure = 'unreachable') {
    super("Can't reach Linear Hub — check the hotspot or Wi-Fi and try again.");
    this.name = 'NetworkError';
    this.original = original;
    this.reason = reason;
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
 * Window event, `detail: { online }`: false when a request could not reach the app (a NetworkError), true whenever the
 * app answers (whatever the status). The offline banner and the gauge outbox listen to it.
 */
export const NETWORK_EVENT = 'lm:network';
export interface NetworkEventDetail { online: boolean }

/** Whether the last request reached Linear Hub (true until one fails). */
let reachable = true;

/** False while the last request could not reach Linear Hub; true again as soon as anything answers. */
export function appReachable(): boolean {
  return reachable;
}

function announceNetwork(online: boolean): void {
  reachable = online;
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

export type ApiInit = RequestInit & {
  json?: unknown;
  /** Wait at most this long for the first answer (null: no limit). Default: reads 15 s, saves no limit. */
  timeoutMs?: number | null;
};

/** Like `api()`, but keeps the response status and headers alongside the parsed body. */
export async function apiRaw<T>(path: string, init: ApiInit = {}): Promise<ApiResponse<T>> {
  const { json, headers, timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetchWithin(
      (input, req) => fetch(input, req),
      `/api${path}`,
      {
        credentials: 'include',
        headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
        body: json !== undefined ? JSON.stringify(json) : rest.body,
        ...rest,
      },
      requestTimeoutMs(rest.method, timeoutMs, reachable),
    );
  } catch (e) {
    // fetch rejects with a TypeError only when no HTTP answer came back. An abort (TanStack Query cancelling a query)
    // is a DOMException and passes through untouched.
    if (e instanceof TypeError || e instanceof RequestTimeout) {
      announceNetwork(false);
      throw new NetworkError(e, e instanceof RequestTimeout ? 'timeout' : 'unreachable');
    }
    throw e;
  }
  if (res.status === 204) {
    announceNetwork(true);
    // Drain the (empty) body: an unread fetch body is reported by Chromium as an aborted request in DevTools.
    await res.text().catch(() => undefined);
    return { data: undefined as T, status: res.status, headers: res.headers };
  }
  const body = await res.json().catch(() => null);
  // A proxy's 502/503/504 page (the app behind it is stopped or restarting) is no answer from the app.
  if (isGatewayFailure(res.status, body)) {
    announceNetwork(false);
    throw new NetworkError(res.status, 'gateway');
  }
  announceNetwork(true);
  if (!res.ok) {
    // Release 1.4 (package S): the request that found the session past its hours-from-sign-in limit says so (any path,
    // /auth/me included); the sign-in page shows the sentence (api/sessionEnd.ts).
    const details: unknown = (body as ApiErrorBody | null)?.details;
    if (res.status === 401 && isSessionEndedDetails(details)) noteSessionEnded(details);
    // A 401 on anything but the auth probes means the session ended (expired, deactivated, signed out elsewhere):
    // let the app clear its state and route to sign-in once, instead of every page showing a raw error.
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    // Release 1.2 (U1's PIN gate): once an admin requires a PIN, a signed-in person without one gets 403
    // { pinSetupRequired: true } from every API. Tell the app, so an already open session shows "Create your PIN"
    // (auth/PinSetupGate.tsx re-reads /auth/me) instead of every card failing until a reload. Release 1.4: the same for
    // { twoFactorSetupRequired: true } — after the upgrade, someone signed in without two-step meets its setup step.
    if (res.status === 403 && (isPinSetupRequiredBody(body) || isTwoFactorSetupRequiredBody(body)) && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PIN_SETUP_REQUIRED_EVENT));
    }
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

function isTwoFactorSetupRequiredBody(body: unknown): body is TwoFactorSetupRequiredError {
  return typeof body === 'object' && body !== null && (body as { twoFactorSetupRequired?: unknown }).twoFactorSetupRequired === true;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
