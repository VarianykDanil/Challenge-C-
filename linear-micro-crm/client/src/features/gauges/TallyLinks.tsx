// Tally entry points — OWNED BY p7-signal-proof-logging (lead's addition). Split out of TallyMode.tsx (lead decision on
// the bundle) so the dashboard and the Gauges header carry only these light pieces; the full-screen counter
// (TallyMode.tsx) is loaded on demand through LazyTallyMode, the first time the tally opens.
// - TallyButton: Gauges page header actions, before "Log gauges" (compact fallback if it throws).
// - LazyTallyMode: Gauges page, right under the page header (card fallback if it throws, or if its code cannot load).
// - TodayTallyLink: the dashboard's "Upcoming events" card, above the list, for GAUGE_ROLES only. This is the
//   "reachable from the dashboard's today event" entry point, so p7 never needs to edit UpcomingEvents.tsx (p6's file).
// The deep link /gauges?tally=1[&eventId=<id>] (lib/useActionParam actionHref.tally) sets `request`.
import { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Tally5 } from 'lucide-react';
import type { SalesEventWithMeta } from '@lm/shared';
import { Button, Card, Skeleton } from '@/components/ui';
import { useCurrentUser } from '@/auth/AuthProvider';
import { todayISO } from '@/lib/dates';
import { formatTime } from '@/lib/format';
import { actionHref } from '@/lib/useActionParam';
import type { TallyModeProps } from './TallyMode';
import { useStoredTallies } from './tallyStore';

/** What opened the tally: the header button (eventId null) or a deep link. */
export interface TallyRequest {
  eventId: number | null;
}

export interface TallyButtonProps {
  onOpen: () => void;
}

/** "Tally" in the Gauges header; shows today's running stop count when a tally is under way. */
export function TallyButton({ onOpen }: TallyButtonProps) {
  const me = useCurrentUser();
  const today = todayISO();
  const running = useStoredTallies(me.id).filter((t) => t.date === today);
  const stops = running.reduce((n, t) => n + t.counts.stops, 0);
  return (
    <Button variant="outline" onClick={onOpen} leftIcon={<Tally5 className="h-4 w-4" aria-hidden />} aria-label={running.length ? `Tally: ${stops} stops counted today` : 'Tally: count your shift as you go'}>
      Tally
      {running.length > 0 && <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">{stops}</span>}
    </Button>
  );
}

const TallyModeChunk = lazy(() => import('./TallyMode').then((m) => ({ default: m.TallyMode })));

/** The tally, fetched the first time it opens; a quiet card-shaped placeholder while its code arrives. */
export function LazyTallyMode(props: TallyModeProps) {
  if (!props.request) return null;
  return (
    <Suspense
      fallback={
        <div className="mb-5" aria-hidden>
          <Card>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-4 h-24 w-full" />
          </Card>
        </div>
      }
    >
      <TallyModeChunk {...props} />
    </Suspense>
  );
}

export interface TodayTallyLinkProps {
  /**
   * The dashboard's upcomingEvents (already role-scoped by /me/dashboard; an admin's list spans every team). p7 picks
   * today's own-team scheduled or live event (date === todayISO()) and renders a ≥ 40 px link to
   * actionHref.tally({ eventId }); null when there is none (e.g. Sundays, when the seed has no events).
   */
  events: SalesEventWithMeta[];
}

export function TodayTallyLink({ events }: TodayTallyLinkProps) {
  const me = useCurrentUser();
  const today = todayISO();
  const stored = useStoredTallies(me.id);
  const todays = events.filter((e) => e.date === today && e.teamId === me.teamId && (e.status === 'scheduled' || e.status === 'live'));
  if (!todays.length) return null;
  const live = todays.filter((e) => e.status === 'live');
  const target = todays.length === 1 ? todays[0]! : live.length === 1 ? live[0]! : null;
  const counting = target ? stored.find((t) => t.eventId === target.id && t.date === today) : undefined;
  return (
    <Link
      to={actionHref.tally({ eventId: target?.id })}
      data-today-tally
      className="focus-ring flex min-h-14 items-center gap-3 rounded-xl border border-primary/20 bg-primary-soft px-3 py-2 transition-colors hover:bg-primary/15"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-primary" aria-hidden>
        <Tally5 className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-primary">{counting ? 'Carry on counting' : 'Count your shift'}</span>
        <span className="block truncate text-xs text-muted">
          {target ? `${target.name} · ${formatTime(target.startTime)}` : `${todays.length} events today`}
          {counting ? ` · ${counting.counts.stops} stops, ${counting.counts.sales} sales so far` : ' · one tap per person'}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden />
    </Link>
  );
}
