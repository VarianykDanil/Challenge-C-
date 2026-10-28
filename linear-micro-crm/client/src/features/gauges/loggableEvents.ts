// Events a person can log gauges against — OWNED BY p7-signal-proof-logging.
//
// One query for Log gauges and the tally (same key, so whichever opens first fills the cache for the other): the last
// three weeks up to today, own team for reps and leaders, every team for admins. When that query has no data (no
// signal: TanStack Query pauses it, or it failed), the lists already in the cache stand in — the dashboard's upcoming
// events, any event list or event page seen this session — so a rep who loses signal can still log today's event.
// When the app was opened with no signal the cache is empty: the events kept in the field kit (src/offline/) stand in,
// and every time the list loads online it is kept there for next time. While Linear Hub is known to be out of reach the
// fallback shows straight away, without waiting for the request to give up.
import { useEffect, useMemo } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { subDays } from 'date-fns';
import type { Dashboard, SalesEventWithMeta, UserWithTeam } from '@lm/shared';
import { isNetworkError } from '@/api/client';
import { useEvents } from '@/api/hooks';
import { useAppReachable } from '@/api/useAppReachable';
import { useCurrentUser } from '@/auth/AuthProvider';
import { todayISO, toISODate } from '@/lib/dates';
import { kitEvents, rememberKitEvents } from '@/offline/fieldKit';

const isEvent = (v: unknown): v is SalesEventWithMeta =>
  !!v && typeof v === 'object' && typeof (v as SalesEventWithMeta).id === 'number' && typeof (v as SalesEventWithMeta).date === 'string' && typeof (v as SalesEventWithMeta).teamId === 'number';

/** Every event the query cache holds (event lists, event pages, the dashboard's upcoming list), newest first. */
export function cachedEvents(qc: QueryClient, keep: (e: SalesEventWithMeta) => boolean): SalesEventWithMeta[] {
  const byId = new Map<number, SalesEventWithMeta>();
  const add = (e: unknown) => {
    if (isEvent(e) && keep(e) && !byId.has(e.id)) byId.set(e.id, e);
  };
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: ['events', 'list'] })) if (Array.isArray(data)) data.forEach(add);
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: ['events', 'detail'] })) add(data);
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: ['dashboard'] })) {
    const upcoming = data && typeof data === 'object' ? (data as Partial<Dashboard>).upcomingEvents : undefined;
    if (Array.isArray(upcoming)) upcoming.forEach(add);
  }
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime) || a.id - b.id);
}

/** Team members the cache already knows (for a leader's rep picker without signal). */
export function cachedMembers(qc: QueryClient, teamId: number): UserWithTeam[] {
  const byId = new Map<number, UserWithTeam>();
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: ['users', 'list'] })) {
    if (!Array.isArray(data)) continue;
    for (const u of data as UserWithTeam[]) if (u && typeof u.id === 'number' && u.teamId === teamId && !byId.has(u.id)) byId.set(u.id, u);
  }
  return [...byId.values()].sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName));
}

/** The query params Log gauges has always used (kept identical so the cache is shared). */
export function loggableEventsParams(me: UserWithTeam, today: string) {
  return { from: toISODate(subDays(new Date(), 21)), to: today, teamId: me.role === 'rep' || me.role === 'leader' ? me.teamId : undefined };
}

export interface LoggableEvents {
  /** Not cancelled, dated today or earlier, newest first; undefined while nothing is known yet. */
  events: SalesEventWithMeta[] | undefined;
  /** True when the list came from the cache because the query has no data (no signal). */
  fromCache: boolean;
  isLoading: boolean;
  /** The query cannot reach the server (paused while the browser is offline, or a network error). */
  offline: boolean;
}

export function useLoggableEvents(opts: { enabled?: boolean } = {}): LoggableEvents {
  const me = useCurrentUser();
  const qc = useQueryClient();
  const today = todayISO();
  const params = useMemo(() => loggableEventsParams(me, today), [me, today]);
  const q = useEvents(params, { enabled: opts.enabled ?? true });
  const live = q.data;
  // also while Linear Hub is known to be out of reach and the list is still being asked for (a weak signal): the saved
  // events show at once instead of after the request gives up
  const reachable = useAppReachable();
  const offline = q.fetchStatus === 'paused' || (!reachable && !live) || (q.isError && !q.isFetching && isNetworkError(q.error));
  useEffect(() => {
    if (live) rememberKitEvents(me.id, live);
  }, [live, me.id]);
  const fallback = useMemo(() => {
    if (live || !offline) return null;
    const inWindow = (e: SalesEventWithMeta) => e.date >= params.from && e.date <= params.to && (params.teamId == null || e.teamId === params.teamId);
    const list = cachedEvents(qc, inWindow);
    if (list.length) return list;
    const kept = kitEvents(me.id).filter(inWindow);
    return kept.length ? kept : null;
  }, [live, offline, qc, params, me.id]);
  const events = useMemo(() => (live ?? fallback ?? undefined)?.filter((e) => e.status !== 'cancelled' && e.date <= today), [live, fallback, today]);
  return { events, fromCache: !live && !!fallback, isLoading: q.isLoading, offline };
}
