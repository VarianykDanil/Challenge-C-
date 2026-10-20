// Check-in outbox — OWNED BY U4 check-ins (release 1.2).
//
// One-tap check-ins tapped while Linear Hub cannot be reached wait here, on the phone, and are sent later by
// CheckInOutboxReplay (mounted once in the AppShell, so from any page). The same pattern as the gauge outbox
// (features/gauges/outbox.ts), kept apart because that one carries GaugeUpsertInput only:
//  - one localStorage key per signed-in person, 'lm-checkin-outbox:<userId>', at most SHIFT_CHECK_IN_QUEUE_LIMIT items;
//  - every storage call is wrapped; a failed write returns null / false so the button keeps its error path (nothing is
//    dropped silently);
//  - each item IS a ShiftCheckInInput — the tapped `checkedInAt` (the phone's wall-clock time, like Log gauges'
//    "Now") and `source: 'offline'` — plus what the phone shows about it (event name and times, when it was queued);
//  - one item per (event, date), the earliest tap kept (shared addToShiftCheckInQueue);
//  - replayCheckIns() is single-flight and POSTs each waiting item; POST /checkins is idempotent on (user, event,
//    date), so a repeated send is harmless: 201 → sent, 200 → it was already there, no answer / 401 / PIN / 5xx →
//    stop and keep, any other 4xx → 'failed' with Linear Hub's reason, until the person dismisses it.
// Replay only ever reads the signed-in person's key, and the server still enforces who may check in where.
import { useSyncExternalStore } from 'react';
import type { ShiftCheckIn, ShiftCheckInInput } from '@lm/shared';
import { addToShiftCheckInQueue, shiftCheckInLabel, shiftCheckInReplayOutcome, shiftCheckInStatus } from '@lm/shared';
import { ApiError, apiRaw, isNetworkError, PIN_SETUP_REQUIRED_EVENT } from '@/api/client';

export interface QueuedCheckIn extends ShiftCheckInInput {
  date: string;
  /** Naive wall-clock time of the tap ("YYYY-MM-DDTHH:MM:SS"). */
  checkedInAt: string;
  source: 'offline';
  /** When it was kept on the phone (the phone's clock, ISO). */
  queuedAt: string;
  eventName: string;
  /** "HH:MM", so the phone can say "on time" / "6 min late" before it is sent. */
  startTime: string;
  status: 'waiting' | 'failed';
  /** Linear Hub's reason for a failed item, or the last problem of a waiting one. */
  error?: string;
}

const PREFIX = 'lm-checkin-outbox:';
const EMPTY: QueuedCheckIn[] = [];

export const checkInOutboxKey = (ownerId: number) => `${PREFIX}${ownerId}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function validItem(v: unknown): v is QueuedCheckIn {
  return (
    isObj(v) &&
    typeof v.eventId === 'number' && Number.isSafeInteger(v.eventId) && v.eventId > 0 &&
    typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date) &&
    typeof v.checkedInAt === 'string' && v.checkedInAt.startsWith(v.date) &&
    (v.status === 'waiting' || v.status === 'failed')
  );
}

function read(ownerId: number): QueuedCheckIn[] {
  const s = storage();
  if (!s) return EMPTY;
  try {
    const raw = s.getItem(checkInOutboxKey(ownerId));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validItem).map((i) => ({ ...i, source: 'offline' as const })) : EMPTY;
  } catch {
    return EMPTY;
  }
}

// ── A tiny external store, so the button, the banner note and Log gauges all see the same list ──
const cache = new Map<number, QueuedCheckIn[]>();
const listeners = new Set<() => void>();

function changed(): void {
  cache.clear();
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent): void {
  if (e.key === null || e.key.startsWith(PREFIX)) changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** The signed-in person's queued check-ins, oldest first. */
export function getCheckInOutbox(ownerId: number): QueuedCheckIn[] {
  let items = cache.get(ownerId);
  if (!items) {
    items = read(ownerId);
    cache.set(ownerId, items);
  }
  return items;
}

export function useCheckInOutbox(ownerId: number | null | undefined): QueuedCheckIn[] {
  return useSyncExternalStore(subscribe, () => (ownerId ? getCheckInOutbox(ownerId) : EMPTY), () => EMPTY);
}

function write(ownerId: number, items: QueuedCheckIn[]): boolean {
  const s = storage();
  if (!s) return false;
  try {
    if (items.length) s.setItem(checkInOutboxKey(ownerId), JSON.stringify(items));
    else s.removeItem(checkInOutboxKey(ownerId));
  } catch {
    return false;
  }
  changed();
  return true;
}

/** The phone's wall-clock time as "YYYY-MM-DDTHH:MM:SS" (the zone the phone is set to: Europe/London in the field). */
export function phoneNow(d: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** "Checked in 09:24 · on time" for a queued item (the phone's own reading, before Linear Hub confirms). */
export function queuedLabel(i: Pick<QueuedCheckIn, 'date' | 'startTime' | 'checkedInAt'>): string {
  return shiftCheckInLabel(i.checkedInAt, shiftCheckInStatus(i.date, i.startTime, i.checkedInAt));
}

/** The queued check-in for one event and day, if any. */
export function queuedCheckInFor(items: readonly QueuedCheckIn[], eventId: number | null | undefined, date: string | null | undefined): QueuedCheckIn | null {
  if (eventId == null || !date) return null;
  return items.find((i) => i.eventId === eventId && i.date === date) ?? null;
}

/**
 * Keep a tap on the phone. A second tap for the same event and day keeps the earlier time. Returns the kept item, or
 * null when the phone cannot keep it (no storage, storage full, or the queue is full): the caller then shows an error.
 */
export function enqueueCheckIn(ownerId: number, e: { eventId: number; date: string; checkedInAt: string; eventName: string; startTime: string }): QueuedCheckIn | null {
  if (!storage()) return null;
  const item: QueuedCheckIn = {
    eventId: e.eventId,
    date: e.date,
    checkedInAt: e.checkedInAt,
    source: 'offline',
    queuedAt: new Date().toISOString(),
    eventName: e.eventName,
    startTime: e.startTime,
    status: 'waiting',
  };
  const next = addToShiftCheckInQueue(getCheckInOutbox(ownerId).filter((i) => !(i.eventId === e.eventId && i.date === e.date && i.status === 'failed')), item);
  if (!next || !write(ownerId, next)) return null;
  return queuedCheckInFor(next, e.eventId, e.date);
}

/** Remove one item (sent, undone or dismissed). */
export function discardQueuedCheckIn(ownerId: number, eventId: number, date: string): boolean {
  const items = getCheckInOutbox(ownerId);
  if (!items.some((i) => i.eventId === eventId && i.date === date)) return true;
  return write(ownerId, items.filter((i) => !(i.eventId === eventId && i.date === date)));
}

function patchItem(ownerId: number, eventId: number, date: string, patch: Partial<QueuedCheckIn>): void {
  const items = getCheckInOutbox(ownerId);
  if (!items.some((i) => i.eventId === eventId && i.date === date)) return;
  write(ownerId, items.map((i) => (i.eventId === eventId && i.date === date ? { ...i, ...patch } : i)));
}

// ───────────────────────────── Replay ─────────────────────────────

export interface CheckInReplayReport {
  /** Sent now (`already`: Linear Hub had a check-in for that day, which stands). */
  sent: Array<{ item: QueuedCheckIn; checkIn: ShiftCheckIn; already: boolean }>;
  failed: QueuedCheckIn[];
  /** Why the loop ended early: no signal, the session ended, or the server had a problem. */
  stopped: 'network' | 'signed-out' | 'server' | null;
}

/** The input actually sent: exactly the ShiftCheckInInput fields. */
const inputOf = (i: QueuedCheckIn): ShiftCheckInInput => ({ eventId: i.eventId, date: i.date, checkedInAt: i.checkedInAt, source: 'offline' });

/**
 * POST one item, noting whether the answer was the PIN gate's 403 (api/client.ts announces it with
 * PIN_SETUP_REQUIRED_EVENT before it throws): that check-in waits until the PIN exists instead of failing.
 */
async function post(item: QueuedCheckIn): Promise<{ status: number; data: ShiftCheckIn } | { error: unknown; pinSetupRequired: boolean }> {
  let pinSetupRequired = false;
  const onPin = () => {
    pinSetupRequired = true;
  };
  window.addEventListener(PIN_SETUP_REQUIRED_EVENT, onPin);
  try {
    const r = await apiRaw<ShiftCheckIn>('/checkins', { method: 'POST', json: inputOf(item) });
    return { status: r.status, data: r.data };
  } catch (error) {
    return { error, pinSetupRequired };
  } finally {
    window.removeEventListener(PIN_SETUP_REQUIRED_EVENT, onPin);
  }
}

let inflight: Promise<CheckInReplayReport> | null = null;

/**
 * Send every waiting check-in, oldest first. Single-flight: a call while one is running gets the running one (which
 * re-reads the list after each item, so a tap queued meanwhile goes too).
 */
export function replayCheckIns(ownerId: number): Promise<CheckInReplayReport> {
  if (inflight) return inflight;
  inflight = (async () => {
    const report: CheckInReplayReport = { sent: [], failed: [], stopped: null };
    const tried = new Set<string>();
    for (;;) {
      const next = getCheckInOutbox(ownerId).find((i) => i.status === 'waiting' && !tried.has(`${i.eventId}|${i.date}`));
      if (!next) break;
      tried.add(`${next.eventId}|${next.date}`);
      const r = await post(next);
      if (!('error' in r)) {
        discardQueuedCheckIn(ownerId, next.eventId, next.date);
        report.sent.push({ item: next, checkIn: r.data, already: shiftCheckInReplayOutcome(r.status) === 'already' });
        continue;
      }
      const e = r.error;
      if (isNetworkError(e)) {
        report.stopped = 'network';
        break;
      }
      if (e instanceof ApiError) {
        const outcome = shiftCheckInReplayOutcome(e.status, { pinSetupRequired: r.pinSetupRequired });
        if (outcome === 'failed') {
          patchItem(ownerId, next.eventId, next.date, { status: 'failed', error: e.message });
          report.failed.push({ ...next, status: 'failed', error: e.message });
          continue;
        }
        report.stopped = e.status === 401 ? 'signed-out' : 'server';
        if (e.status >= 500) patchItem(ownerId, next.eventId, next.date, { error: `Linear Hub had a problem (${e.status}) — it will try again.` });
        break;
      }
      report.stopped = 'server';
      break;
    }
    return report;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** "2 check-ins" / "1 check-in". */
export const checkInsLabel = (n: number) => `${n} check-in${n === 1 ? '' : 's'}`;
