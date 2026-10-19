// The tally's counting logic — shared by the Tally card on the Gauges page (TallyMode.tsx) and the full-screen Quick
// gauges page (/quick, pages/QuickGauges.tsx). Both read and write the same store (tallyStore.ts: one localStorage
// key per person, event and date), so a tally started on one shows the same numbers on the other.
// Never import this from the shell: it is shared by two lazily loaded chunks and should stay out of the first download.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GaugeKey, GaugeTotals, SalesEventWithMeta } from '@lm/shared';
import { EMPTY_TOTALS, GAUGE_KEYS, tallyStep, tallyStepThrough, tallyThroughOffer, type TallyThroughOffer } from '@lm/shared';
import { useCurrentUser } from '@/auth/AuthProvider';
import { todayISO } from '@/lib/dates';
import { useLoggableEvents } from './loggableEvents';
import { clearTally, readTally, subscribeTallies, tallyStorageAvailable, tallyTotal, writeTally, type StoredTally } from './tallyStore';

/** Events the person can count: today's (own team for reps and leaders; admins any team), plus any unfinished tally. */
export function useTallyEvents(stored: StoredTally[]) {
  const me = useCurrentUser();
  const today = todayISO();
  const loggable = useLoggableEvents();
  const options = useMemo(() => {
    const list = loggable.events ?? [];
    const unfinished = new Set(stored.map((t) => t.eventId));
    return list
      .filter((e) => e.date === today || unfinished.has(e.id))
      .sort((a, b) => (a.date === b.date ? Number(b.teamId === me.teamId) - Number(a.teamId === me.teamId) || a.startTime.localeCompare(b.startTime) : b.date.localeCompare(a.date)));
  }, [loggable.events, stored, today, me.teamId]);
  return { options, loading: loggable.isLoading && !loggable.events, offline: loggable.offline && !loggable.events };
}

/** The event to count without asking: the one already being counted today, else the one live event, else the only one. */
export function defaultEvent(options: SalesEventWithMeta[], stored: StoredTally[], today: string): SalesEventWithMeta | null {
  const counting = options.find((e) => e.date === today && stored.some((t) => t.eventId === e.id && t.date === e.date));
  if (counting) return counting;
  const todays = options.filter((e) => e.date === today);
  const live = todays.filter((e) => e.status === 'live');
  if (live.length === 1) return live[0]!;
  return todays.length === 1 ? todays[0]! : null;
}

const sameCounts = (a: GaugeTotals, b: GaugeTotals) => GAUGE_KEYS.every((k) => a[k] === b[k]);

/** A short buzz where the phone supports it (Android Chrome); silently nothing elsewhere. */
export const vibrate = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
};

export interface TallyCounterOptions {
  /** Called once the shift's counts were saved (or kept on the phone by the outbox) and the tally cleared. */
  onFinished?: () => void;
  /** How long a refused tap's hint stays, in ms (default 5 s). */
  hintMs?: number;
}

export interface TallyCounterState {
  counts: GaugeTotals;
  /** Sum of the six counts (0 = nothing to reset or finish). */
  total: number;
  /** "1 in N" stops per sale, or null before the first sale. */
  stopsPerSale: number | null;
  /** False when this browser can't keep the counts across a reload (they still count in memory). */
  persisted: boolean;
  /** Why the last tap was refused, for a few seconds; null otherwise. */
  hint: string | null;
  /** When the last refused tap was a +1 the funnel blocked: the one-tap way to count it through. */
  offer: (TallyThroughOffer & { key: GaugeKey }) | null;
  /** One +1 / −1 (tallyStep); false when the funnel refused it (the hint says why). */
  tap: (key: GaugeKey, delta: 1 | -1) => boolean;
  /** +1 on `key`, raising the earlier stages with it (tallyStepThrough). */
  tapThrough: (key: GaugeKey) => boolean;
  /** Reset asks first: confirmReset is true between askReset and reset / cancelReset. */
  confirmReset: boolean;
  askReset: () => void;
  cancelReset: () => void;
  reset: () => void;
  /** Log gauges is open, prefilled with the counts. */
  finishing: boolean;
  startFinish: () => void;
  cancelFinish: () => void;
  /** For Log gauges' onSaved / onQueued: clears the tally and calls onFinished. */
  finished: () => void;
}

/** The counting logic for one event's tally, for the signed-in person. Mount it per event (key it by id and date). */
export function useTallyCounter(event: SalesEventWithMeta, opts: TallyCounterOptions = {}): TallyCounterState {
  const me = useCurrentUser();
  const { hintMs = 5000 } = opts;
  const [counts, setCounts] = useState<GaugeTotals>(() => readTally(me.id, event.id, event.date));
  const countsRef = useRef(counts);
  const [persisted, setPersisted] = useState(tallyStorageAvailable);
  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;
  const [hint, setHint] = useState<string | null>(null);
  const [refused, setRefused] = useState<GaugeKey | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const onFinished = useRef(opts.onFinished);
  onFinished.current = opts.onFinished;

  // Follow the store: another tab (a Quick gauges page left open all shift, or the Gauges page) may have counted since
  // this one read it, and a tap here must add to those counts, never write stale ones over them. Re-read on every
  // change of the store (the storage event from other tabs) and whenever this tab comes back into view. Without
  // working storage there is nothing reliable to read back, so the counts in memory stay.
  useEffect(() => {
    const sync = () => {
      if (!persistedRef.current) return;
      const stored = readTally(me.id, event.id, event.date);
      if (sameCounts(stored, countsRef.current)) return;
      countsRef.current = stored;
      setCounts(stored);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    const unsubscribe = subscribeTallies(sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [me.id, event.id, event.date]);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => {
      setHint(null);
      setRefused(null);
    }, hintMs);
    return () => window.clearTimeout(id);
  }, [hint, hintMs]);

  const commit = useCallback(
    (next: GaugeTotals) => {
      countsRef.current = next;
      setCounts(next);
      setPersisted(writeTally(me.id, event.id, event.date, next));
    },
    [me.id, event.id, event.date],
  );

  const accepted = useCallback(
    (next: GaugeTotals) => {
      setHint(null);
      setRefused(null);
      setConfirmReset(false);
      commit(next);
      vibrate(8);
    },
    [commit],
  );

  const tap = useCallback(
    (k: GaugeKey, delta: 1 | -1) => {
      const r = tallyStep(countsRef.current, k, delta);
      if (!r.ok) {
        setHint(r.hint);
        setRefused(delta === 1 ? k : null);
        vibrate([30, 40, 30]);
        return false;
      }
      accepted(r.counts);
      return true;
    },
    [accepted],
  );

  const tapThrough = useCallback(
    (k: GaugeKey) => {
      const r = tallyStepThrough(countsRef.current, k);
      if (!r.ok) {
        setHint(r.hint);
        setRefused(null);
        vibrate([30, 40, 30]);
        return false;
      }
      accepted(r.counts);
      return true;
    },
    [accepted],
  );

  const reset = useCallback(() => {
    setConfirmReset(false);
    commit({ ...EMPTY_TOTALS });
  }, [commit]);

  const finished = useCallback(() => {
    clearTally(me.id, event.id, event.date);
    countsRef.current = { ...EMPTY_TOTALS };
    setCounts({ ...EMPTY_TOTALS });
    onFinished.current?.();
  }, [me.id, event.id, event.date]);

  const offer = useMemo(() => {
    if (!refused) return null;
    const o = tallyThroughOffer(counts, refused);
    return o ? { ...o, key: refused } : null;
  }, [counts, refused]);

  return {
    counts,
    total: tallyTotal(counts),
    stopsPerSale: counts.sales > 0 ? Math.round(counts.stops / counts.sales) : null,
    persisted,
    hint,
    offer,
    tap,
    tapThrough,
    confirmReset,
    askReset: useCallback(() => setConfirmReset(true), []),
    cancelReset: useCallback(() => setConfirmReset(false), []),
    reset,
    finishing,
    startFinish: useCallback(() => setFinishing(true), []),
    cancelFinish: useCallback(() => setFinishing(false), []),
    finished,
  };
}
