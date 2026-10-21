import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { CalendarDays, MapPin, PlusCircle } from 'lucide-react';
import type { EventForecast, SalesEventWithMeta } from '@lm/shared';
import { EmptyState } from '@/components/ui';
import { useEvents } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { CheckInButton } from '@/features/checkins/CheckInButton';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { EventStatusBadge } from '@/features/common';
import { DirectionsLink, EventForecastChip } from '@/features/events';
// Release 1.3 slot (P8): the booked person's plan for each event.
import { EventPlanStrip } from '@/features/venues/EventPlanStrip';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatRelative, formatTime } from '@/lib/format';
import { actionHref } from '@/lib/useActionParam';

/**
 * The dashboard's next five events (from /me/dashboard, already role-scoped). Smart release 1.1 (p6): each row gets a
 * directions link, today's started events a one-tap "Log gauges" for people who can log there, and the forecast chip.
 * /me/dashboard never carries forecasts (lead's decision): they come from the /events list for the same dates, matched
 * by id; a row without one renders exactly as before.
 */
export function UpcomingEvents({ events }: { events: SalesEventWithMeta[] }) {
  const me = useCurrentUser();
  const first = events[0];
  const last = events[events.length - 1];
  const teamIds = new Set(events.map((e) => e.teamId));
  const singleTeam = teamIds.size === 1 ? first?.teamId : undefined;
  const list = useEvents({ from: first?.date, to: last?.date, teamId: singleTeam }, { enabled: !!first && !!last });
  const forecasts = useMemo(() => {
    const map = new Map<number, EventForecast>();
    for (const e of list.data ?? []) if (e.forecast) map.set(e.id, e.forecast);
    return map;
  }, [list.data]);

  if (!events.length) return <EmptyState icon={<CalendarDays className="h-6 w-6" aria-hidden />} title="Nothing scheduled" description="Upcoming events for your team will appear here." size="sm" className="border-0" />;

  const today = todayISO();
  const now = format(new Date(), 'HH:mm');
  // Mirrors the API's write rule: admins anywhere, leaders and reps at their own team's events.
  const canLogAt = (e: SalesEventWithMeta) => me.role === 'admin' || ((me.role === 'leader' || me.role === 'rep') && me.teamId != null && e.teamId === me.teamId);
  const loggableNow = (e: SalesEventWithMeta) => e.date === today && e.status !== 'cancelled' && e.startTime <= now && canLogAt(e);

  return (
    <ul className="divide-y divide-border">
      {events.map((e) => {
        const forecast = forecasts.get(e.id);
        return (
          <li key={e.id} className="py-1.5">
            <div className="flex items-start gap-1">
              <Link
                to={`/events/${e.id}`}
                className="block min-w-0 flex-1 rounded-md py-1 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-start gap-3">
                  <span className="mt-0.5 h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: e.campaignColor }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 text-sm font-medium leading-snug text-fg">{e.name}</span>
                      <EventStatusBadge status={e.status} />
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      <span className="font-semibold text-fg">{formatDateShort(e.date)}</span> · {formatTime(e.startTime)} · {formatRelative(e.date)}
                    </span>
                    <span className="mt-0.5 flex items-start gap-1 text-xs text-muted"><MapPin className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /><span className="min-w-0 truncate">{e.venue}, {e.city} · {e.teamName}</span></span>
                    {forecast && <EventForecastChip forecast={forecast} targetSales={e.targetSales} campaignCode={e.campaignCode} type={e.type} teamName={e.teamName} side="bottom" className="mt-1" />}
                    <ErrorBoundary name="event-plan" fallback={null}><EventPlanStrip event={e} variant="upcoming" className="mt-1" /></ErrorBoundary>
                  </span>
                </span>
              </Link>
              <DirectionsLink venue={e.venue} city={e.city} />
            </div>
            {loggableNow(e) && (
              <div className="mt-1 pl-4">
                <Link
                  to={actionHref.logGauges({ eventId: e.id })}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary-soft px-3 text-sm font-medium text-primary transition hover:bg-primary/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
                >
                  <PlusCircle className="h-4 w-4" aria-hidden />
                  Log gauges
                </Link>
              </div>
            )}
            {/* Release 1.2 slot (U4): one-tap check-in on today's events; nothing until the package lands. */}
            {e.date === today && (
              <ErrorBoundary name="check-in" fallback={null}>
                <CheckInButton event={e} variant="row" className="mt-1 pl-4" />
              </ErrorBoundary>
            )}
          </li>
        );
      })}
    </ul>
  );
}
