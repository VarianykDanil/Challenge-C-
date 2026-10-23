// Release 1.4 — OWNED BY package S (security). Why the session ended, for the sign-in page.
//
// A session ends a fixed number of hours after sign-in (14 by default), whatever the activity, and its cookie ends with
// it. The sign-in page then says so: "For security you are signed out 14 hours after signing in. Sign in again to
// carry on." It learns it two ways, so the sentence shows whichever way the session went:
//  - the request that finds the session over its limit answers 401 with details { sessionEnded: 'max_age', maxHours }
//    (api/client.ts calls noteSessionEnded);
//  - usually the browser has already dropped the cookie at that moment (same Max-Age), so the next request is a plain
//    401: then the end time the server gave at sign-in and on /auth/me (`session.endsAt`, kept here in localStorage,
//    per device) says it was the limit.
// Nothing here is a secret: an end time and a number of hours. Every storage call is wrapped (private modes).
import { sessionMaxAgeMessage, type SessionEndedDetails, type SessionInfo } from '@lm/shared';

const KEY = 'lm-session-end';
/** A plain 401 this close to the stored end time (or after it) is the limit (clocks and requests are not exact). */
const SKEW_MS = 2 * 60_000;

interface Stored {
  endsAt: string;
  maxHours: number;
}

let noted: SessionEndedDetails | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(): Stored | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    return typeof v.endsAt === 'string' && typeof v.maxHours === 'number' ? { endsAt: v.endsAt, maxHours: v.maxHours } : null;
  } catch {
    return null;
  }
}

/** After a sign-in and every /auth/me: when this session ends (nothing to keep for a demo account's 14-day session). */
export function rememberSession(info: SessionInfo | undefined): void {
  const s = storage();
  if (!s) return;
  try {
    if (info && info.maxHours !== null) s.setItem(KEY, JSON.stringify({ endsAt: info.endsAt, maxHours: info.maxHours } satisfies Stored));
    else s.removeItem(KEY);
  } catch {
    /* storage full or blocked: the 401's own reason still works */
  }
}

/** Signing out by hand: nothing to explain at the next sign-in. */
export function forgetSession(): void {
  noted = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** A 401 said the session reached its limit. */
export function noteSessionEnded(details: SessionEndedDetails): void {
  noted = details;
  for (const l of listeners) l();
}

/** True for a 401 body (`details`) that carries the limit's reason. */
export function isSessionEndedDetails(details: unknown): details is SessionEndedDetails {
  return typeof details === 'object' && details !== null && (details as { sessionEnded?: unknown }).sessionEnded === 'max_age' &&
    typeof (details as { maxHours?: unknown }).maxHours === 'number';
}

/** The sentence for the sign-in page, without using it up (null when the session did not end by the limit). */
export function peekSessionEndNotice(now = Date.now()): string | null {
  if (noted) return sessionMaxAgeMessage(noted.maxHours);
  const stored = readStored();
  const ends = stored ? Date.parse(stored.endsAt) : Number.NaN;
  return stored && Number.isFinite(ends) && now >= ends - SKEW_MS ? sessionMaxAgeMessage(stored.maxHours) : null;
}

/** The sentence once: the sign-in page shows it and it is forgotten. */
export function takeSessionEndNotice(now = Date.now()): string | null {
  const notice = peekSessionEndNotice(now);
  if (notice) forgetSession();
  return notice;
}

/** Called when a reason arrives after the sign-in page is already open (several requests were in flight). */
export function onSessionEnded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
