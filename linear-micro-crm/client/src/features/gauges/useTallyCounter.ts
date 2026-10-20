// The tally's counting logic — shared by the Tally card on the Gauges page (TallyMode.tsx) and the full-screen Quick
// gauges page (/quick, pages/QuickGauges.tsx). Both read and write the same store (tallyStore.ts: one localStorage
// key per person, event and date), so a tally started on one shows the same numbers on the other.
// Never import this from the shell: it is shared by two lazily loaded chunks and should stay out of the first download.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GaugeKey, GaugeTotals, SalesEventWithMeta } from '@lm/shared';
import { EMPTY_TOTALS, GAUGE_KEYS, GAUGE_LABELS, tallyPerson } from '@lm/shared';
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

// ───────────── What a tap means (one person, at the furthest stage they reached: tallyPerson) ─────────────

/** What one tap on each stage adds, as a tile's second line. Named up to two earlier stages, then counted: each fits a
 * 320 px phone's tile at 11 px ("+ stop, table, pres." would need 97 px where a 360 px phone leaves 91). */
export const TALLY_ADDS: Record<GaugeKey, string> = {
  stops: 'just a stop',
  table: '+ stop',
  presentations: '+ stop, table',
  closes: '+ 3 earlier',
  taps: '+ 4 earlier',
  sales: '+ all 5 earlier',
};

const ONE: Record<GaugeKey, string> = { stops: 'a stop', table: 'a table', presentations: 'a presentation', closes: 'a close', taps: 'a tap', sales: 'a sale' };
/** "a", "a and b", "a, b and c" (no serial comma). */
const listOf = (words: string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
const earlierOf = (k: GaugeKey) => GAUGE_KEYS.slice(0, GAUGE_KEYS.indexOf(k)).map((e) => ONE[e]);

/** A +1's label: "Add one person who reached Presentations (also adds a stop and a table), now 5". */
export function addPersonLabel(k: GaugeKey, now: number): string {
  const earlier = earlierOf(k);
  return earlier.length ? `Add one person who reached ${GAUGE_LABELS[k]} (also adds ${listOf(earlier)}), now ${now}` : `Add one person who just stopped, now ${now}`;
}

/** A −1's label: "Take one person off Presentations (also takes off a stop and a table), now 5". */
export function takePersonLabel(k: GaugeKey, now: number): string {
  const earlier = earlierOf(k);
  return earlier.length ? `Take one person off ${GAUGE_LABELS[k]} (also takes off ${listOf(earlier)}), now ${now}` : `Take one off Stops, now ${now}`;
}

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * The brief highlight on a stage that went up with a tap, so the cascade is visible: `pulse` is the tap's number when
 * this stage went up with it (see TallyCounterState.raised), else null. `ring` (an overlay, opacity 0 at rest) fades
 * out over 300 ms; `count` gets a small scale pulse, left out when the person prefers reduced motion. Each new tap
 * restarts it. Web Animations only, so the shared stylesheet needs no keyframes for it; without them nothing happens.
 */
export function useRaiseFlash<C extends HTMLElement = HTMLElement>(pulse: number | null) {
  const ring = useRef<HTMLSpanElement>(null);
  const count = useRef<C>(null);
  useEffect(() => {
    if (pulse == null) return;
    const anims: Animation[] = [];
    try {
      const r = ring.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' });
      if (r) anims.push(r);
      if (!reducedMotion()) {
        const c = count.current?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
        if (c) anims.push(c);
      }
    } catch {
      /* no Web Animations: no highlight */
    }
    return () => anims.forEach((a) => a.cancel());
  }, [pulse]);
  return { ring, count };
}

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
  /** Why the last tap was refused (a −1 the funnel needs elsewhere first, or the daily maximum), for a few seconds. */
  hint: string | null;
  /** The stages the last accepted +1 raised, and that tap's number (it changes on every +1, to restart the
   * highlight); null after a −1, a reset or before the first tap. */
  raised: { keys: readonly GaugeKey[]; n: number } | null;
  /** One person +1 / −1 (tallyPerson): every stage from Stops to `key` moves; false when refused (the hint says why). */
  tap: (key: GaugeKey, delta: 1 | -1) => boolean;
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
  const [raised, setRaised] = useState<TallyCounterState['raised']>(null);
  const pulses = useRef(0);
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
    const id = window.setTimeout(() => setHint(null), hintMs);
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

  const tap = useCallback(
    (k: GaugeKey, delta: 1 | -1) => {
      const before = countsRef.current;
      const r = tallyPerson(before, k, delta);
      if (!r.ok) {
        setHint(r.hint);
        vibrate([30, 40, 30]);
        return false;
      }
      setHint(null);
      setConfirmReset(false);
      setRaised(delta === 1 ? { keys: GAUGE_KEYS.filter((s) => r.counts[s] > before[s]), n: ++pulses.current } : null);
      commit(r.counts);
      vibrate(8);
      return true;
    },
    [commit],
  );

  const reset = useCallback(() => {
    setConfirmReset(false);
    setRaised(null);
    commit({ ...EMPTY_TOTALS });
  }, [commit]);

  const finished = useCallback(() => {
    clearTally(me.id, event.id, event.date);
    countsRef.current = { ...EMPTY_TOTALS };
    setCounts({ ...EMPTY_TOTALS });
    setRaised(null);
    onFinished.current?.();
  }, [me.id, event.id, event.date]);

  return {
    counts,
    total: tallyTotal(counts),
    stopsPerSale: counts.sales > 0 ? Math.round(counts.stops / counts.sales) : null,
    persisted,
    hint,
    raised,
    tap,
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
