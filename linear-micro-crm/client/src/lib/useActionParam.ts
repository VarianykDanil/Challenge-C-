// Smart release 1.1 (p1): one-shot deep links such as /gauges?log=1&eventId=42 or /finance?tab=company#runs.
import { useEffect, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { qs } from '@/api/client';

export type ActionValues<K extends string> = Record<K, string | null>;

export interface ActionParamOptions {
  /** URL hashes that trigger the action on their own (e.g. ['#runs']); they are stripped too. */
  hashes?: readonly string[];
}

/**
 * Reads the listed search params once per navigation when any of them (or one of `opts.hashes`) is present, hands
 * the values and the hash to `onAction`, then strips them with setSearchParams(…, { replace: true }). The guard is
 * keyed on the history entry (location.key), so StrictMode's double effect never fires twice and Back never reopens
 * anything (the stripped URL replaced the entry); following the same link again is a new entry and fires again.
 * Other search params are kept; the hash is dropped by the replace (it was already delivered to onAction).
 */
export function useActionParam<K extends string>(names: readonly K[], onAction: (values: ActionValues<K>, hash: string) => void, opts: ActionParamOptions = {}): void {
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const handled = useRef<string | null>(null);
  const callback = useRef(onAction);
  callback.current = onAction;
  const namesKey = names.join('|');
  const hashesKey = (opts.hashes ?? []).join('|');

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const hashHit = hashesKey !== '' && hashesKey.split('|').includes(location.hash);
    const keys = namesKey.split('|') as K[];
    if (!hashHit && !keys.some((k) => params.has(k))) return;
    if (handled.current === location.key) return;
    handled.current = location.key;
    const values = {} as ActionValues<K>;
    for (const k of keys) values[k] = params.get(k);
    callback.current(values, location.hash);
    for (const k of keys) params.delete(k);
    setSearchParams(params, { replace: true, state: location.state });
  }, [location.key, location.search, location.hash, location.state, namesKey, hashesKey, setSearchParams]);
}

/** A positive integer id from a search param, or null. */
export function idFromParam(value: string | null | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Deep links other features build (attention items, upcoming events, toasts) — one place for the URL shapes. */
export const actionHref = {
  /** Open Log gauges, optionally for an event and (admin / that team's leader only) a person. */
  logGauges: (p: { eventId?: number | null; userId?: number | null } = {}) => `/gauges${qs({ log: 1, eventId: p.eventId, userId: p.userId })}`,
  /** Open the live tally counter (p7), optionally for an event. */
  tally: (p: { eventId?: number | null } = {}) => `/gauges${qs({ tally: 1, eventId: p.eventId })}`,
  /** A Finance tab; `runs` (admin) lands on Runs to pay. */
  finance: (tab: 'me' | 'team' | 'company', opts: { runs?: boolean } = {}) => `/finance${qs({ tab })}${opts.runs ? '#runs' : ''}`,
};
