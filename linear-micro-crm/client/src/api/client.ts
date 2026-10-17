// Owned by the Frontend Developer.
import type { ApiError as ApiErrorBody } from '@lm/shared';

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.details = body?.details;
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
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    ...rest,
  });
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

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
