// Tally counts on this phone — OWNED BY p7-signal-proof-logging.
//
// One localStorage key per (signed-in person, event, date): 'lm-tally:<userId>:<eventId>:<date>' → { counts, updatedAt }.
// The counts survive reloads and dropped signal; they never leave the phone until "Finish shift" saves them through
// Log gauges. Every storage call is wrapped: without storage the tally still counts, in memory, while the page is open.
import { useSyncExternalStore } from 'react';
import type { GaugeTotals } from '@lm/shared';
import { EMPTY_TOTALS, normaliseTally } from '@lm/shared';

const PREFIX = 'lm-tally:';
/** Unfinished tallies older than this are dropped (a shift's counts are logged that day or soon after). */
const KEEP_DAYS = 14;

export interface StoredTally {
  eventId: number;
  date: string;
  counts: GaugeTotals;
  updatedAt: string;
}

export const tallyKey = (userId: number, eventId: number, date: string) => `${PREFIX}${userId}:${eventId}:${date}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether this browser can keep the tally across reloads. */
export function tallyStorageAvailable(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem('lm-probe', '1');
    s.removeItem('lm-probe');
    return true;
  } catch {
    return false;
  }
}

export const tallyTotal = (c: GaugeTotals) => c.stops + c.table + c.presentations + c.closes + c.taps + c.sales;

const cache = new Map<number, StoredTally[]>();
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

/** A local calendar day as YYYY-MM-DD (the same day lib/dates' todayISO gives, without date-fns in the shell). */
export function localDayISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cutoffISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - KEEP_DAYS);
  return localDayISO(d);
}

function scan(userId: number): StoredTally[] {
  const s = storage();
  if (!s) return [];
  const mine = `${PREFIX}${userId}:`;
  const out: StoredTally[] = [];
  const stale: string[] = [];
  const cutoff = cutoffISO();
  try {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key || !key.startsWith(mine)) continue;
      const m = /^(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key.slice(mine.length));
      if (!m) continue;
      const date = m[2]!;
      if (date < cutoff) {
        stale.push(key);
        continue;
      }
      let parsed: { counts?: unknown; updatedAt?: unknown } | null = null;
      try {
        parsed = JSON.parse(s.getItem(key) ?? 'null') as { counts?: unknown; updatedAt?: unknown } | null;
      } catch {
        parsed = null;
      }
      const counts = normaliseTally(parsed?.counts);
      if (tallyTotal(counts) === 0) continue;
      out.push({ eventId: Number(m[1]), date, counts, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '' });
    }
    for (const key of stale) s.removeItem(key);
  } catch {
    return out;
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.eventId - b.eventId);
}

/** Every unfinished (non-zero) tally the signed-in person has on this phone, newest date first. */
export function getStoredTallies(userId: number): StoredTally[] {
  let list = cache.get(userId);
  if (!list) {
    list = scan(userId);
    cache.set(userId, list);
  }
  return list;
}

const EMPTY: StoredTally[] = [];

export function useStoredTallies(userId: number | null | undefined): StoredTally[] {
  return useSyncExternalStore(subscribe, () => (userId ? getStoredTallies(userId) : EMPTY), () => EMPTY);
}

export function readTally(userId: number, eventId: number, date: string): GaugeTotals {
  const s = storage();
  if (!s) return { ...EMPTY_TOTALS };
  try {
    const raw = s.getItem(tallyKey(userId, eventId, date));
    return normaliseTally(raw ? (JSON.parse(raw) as { counts?: unknown }).counts : null);
  } catch {
    return { ...EMPTY_TOTALS };
  }
}

/** Keep the counts on the phone; false when they could not be stored (the tally keeps counting in memory). */
export function writeTally(userId: number, eventId: number, date: string, counts: GaugeTotals): boolean {
  const s = storage();
  if (!s) return false;
  try {
    if (tallyTotal(counts) === 0) s.removeItem(tallyKey(userId, eventId, date));
    else s.setItem(tallyKey(userId, eventId, date), JSON.stringify({ counts, updatedAt: new Date().toISOString() }));
  } catch {
    return false;
  }
  changed();
  return true;
}

export function clearTally(userId: number, eventId: number, date: string): void {
  const s = storage();
  try {
    s?.removeItem(tallyKey(userId, eventId, date));
  } catch {
    /* nothing to clear */
  }
  changed();
}
