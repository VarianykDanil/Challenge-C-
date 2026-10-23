// Release 1.4 — OWNED BY package S (security). The Log gauges form's unsent draft.
//
// A session now ends 14 hours after sign-in, so a rep can be signed out with the form open and counts typed but not
// saved (the phone comes out of a pocket, the app re-reads /auth/me, the sign-in page opens). When the form goes away
// without being saved or closed by the person, what they typed is kept here — one localStorage key per person,
// 'lm-gauge-draft:<userId>', for 24 hours — and the next Log gauges they open (for that event, or with no event fixed)
// starts from it and says so. Saving or closing the form forgets it. Every storage call is wrapped (private modes).
import type { GaugeTotals } from '@lm/shared';
import { GAUGE_KEYS } from '@lm/shared';

export interface GaugeDraft {
  eventId: number;
  userId: number;
  gauges: GaugeTotals;
  /** "YYYY-MM-DDTHH:mm" as typed, or ''. */
  checkIn: string;
  notes: string;
  savedAt: string;
}

const PREFIX = 'lm-gauge-draft:';
const MAX_AGE_MS = 24 * 3_600_000;

const key = (ownerId: number) => `${PREFIX}${ownerId}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function valid(v: unknown): v is GaugeDraft {
  if (!v || typeof v !== 'object') return false;
  const d = v as Partial<GaugeDraft>;
  return Number.isInteger(d.eventId) && Number.isInteger(d.userId) && typeof d.checkIn === 'string' && typeof d.notes === 'string' &&
    typeof d.savedAt === 'string' && !!d.gauges && GAUGE_KEYS.every((k) => isCount((d.gauges as GaugeTotals)[k]));
}

/** Keep what was typed (the form went away unsaved). */
export function saveGaugeDraft(ownerId: number, draft: Omit<GaugeDraft, 'savedAt'>): void {
  try {
    storage()?.setItem(key(ownerId), JSON.stringify({ ...draft, savedAt: new Date().toISOString() } satisfies GaugeDraft));
  } catch {
    /* storage full or blocked: nothing to keep it in */
  }
}

/** Forget the draft (saved, or closed by the person). */
export function clearGaugeDraft(ownerId: number): void {
  try {
    storage()?.removeItem(key(ownerId));
  } catch {
    /* ignore */
  }
}

/**
 * The person's draft, once (it is forgotten as it is handed over), when it is under a day old and fits the form being
 * opened: the same event when the form is for a fixed one.
 */
export function takeGaugeDraft(ownerId: number, fixedEventId: number | null | undefined, now = Date.now()): GaugeDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key(ownerId));
    if (!raw) return null;
    const draft: unknown = JSON.parse(raw);
    if (!valid(draft) || now - Date.parse(draft.savedAt) > MAX_AGE_MS) {
      s.removeItem(key(ownerId));
      return null;
    }
    if (fixedEventId != null && draft.eventId !== fixedEventId) return null;
    s.removeItem(key(ownerId));
    return draft;
  } catch {
    return null;
  }
}
