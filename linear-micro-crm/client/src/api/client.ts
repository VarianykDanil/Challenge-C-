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

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    ...rest,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // A 401 on anything but the auth probes means the session ended (expired, deactivated, signed out elsewhere):
    // let the app clear its state and route to sign-in once, instead of every page showing a raw error.
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(res.status, body);
  }
  return body as T;
}

/** Window event fired when a signed-in request is answered with 401. */
export const UNAUTHENTICATED_EVENT = 'lm:unauthenticated';

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
