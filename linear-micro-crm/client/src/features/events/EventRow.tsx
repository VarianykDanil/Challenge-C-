import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Clock, MapPin, Users } from 'lucide-react';
import { EVENT_ROSTER_LOOKBACK_DAYS, inRosterWindow as inSharedRosterWindow, type SalesEventWithMeta } from '@lm/shared';
import { Badge, ProgressBar } from '@/components/ui';
import { EventStatusBadge, EventTypeBadge } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { formatNumber, formatTime } from '@/lib/format';
import { DirectionsLink } from './DirectionsLink';
import { EventForecastChip, forecastAriaText } from './EventForecastChip';

/** Logged-of-team counts are shown for completed / live events from this many days back (older gaps are history). */
export const ROSTER_LOOKBACK_DAYS = EVENT_ROSTER_LOOKBACK_DAYS;

/** Before the day starts there is nothing to judge: scheduled events, and live ones whose start time has not come. */
export function eventNotStarted(e: Pick<SalesEventWithMeta, 'status' | 'date' | 'startTime'>, today = todayISO(), nowHHMM = format(new Date(), 'HH:mm')): boolean {
  if (e.status === 'scheduled') return true;
  return e.status === 'live' && (e.date > today || (e.date === today && e.startTime > nowHHMM));
}

/** Completed or live events dated today − 2 … today: the window where "4 / 7 logged" is worth chasing. */
export function inRosterWindow(e: Pick<SalesEventWithMeta, 'status' | 'date'>, today = todayISO()): boolean {
  return inSharedRosterWindow(e, today);
}

export interface EventRowProps {
  event: SalesEventWithMeta;
}

export function EventRow({ event: e }: EventRowProps) {
  const pct = e.targetSales > 0 ? e.totals.sales / e.targetSales : 0;
  const notStarted = eventNotStarted(e);
  // Not started: a neutral track and the target as text (nothing is "behind" yet). Started or done: coloured by result.
  const tone = e.status === 'cancelled' ? 'danger' : pct >= 1 ? 'success' : pct >= 0.5 ? 'primary' : 'warning';
  // "4 / 7 logged" comes from the server (`roster`, recent completed / live events only): the event team's own members
  // who had started by that day, so it matches the event page's "Not logged yet" list and never reads 8 / 7.
  const roster = e.roster && e.roster.members > 0 ? e.roster : null;
  const missing = !!roster && roster.logged < roster.members;
  const label = [e.name, e.campaignName, e.venue, e.forecast ? forecastAriaText(e.forecast) : null, roster ? `${roster.logged} of ${roster.members} team members logged` : null].filter(Boolean).join(', ');
  return (
    <li className="flex items-stretch rounded-xl border border-border bg-surface shadow-sm">
      <Link
        to={`/events/${e.id}`}
        className="grid min-w-0 flex-1 grid-cols-[4px_minmax(0,1fr)] items-stretch gap-x-3 gap-y-2 rounded-l-xl p-3 transition hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[4px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(150px,1fr)_auto] md:items-center md:gap-3"
        aria-label={label}
      >
        {/* phones: the colour bar runs down the whole card and every block sits beside it (one row each) */}
        <span className="row-span-5 rounded-full md:row-span-1 md:self-stretch" style={{ backgroundColor: e.campaignColor }} aria-hidden />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{e.name}</span>
            <Badge tone="neutral" dot color={e.campaignColor}>{e.campaignCode}</Badge>
          </span>
          <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted"><MapPin className="h-3 w-3 shrink-0" aria-hidden />{e.venue}, {e.city}</span>
        </span>
        <span className="flex items-center gap-1 text-xs text-muted"><Clock className="h-3 w-3 shrink-0" aria-hidden />{formatTime(e.startTime)} – {formatTime(e.endTime)}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral" dot color={e.teamColor}>{e.teamName}</Badge>
          <EventTypeBadge type={e.type} />
        </span>
        <span className="min-w-0 space-y-1.5">
          {notStarted ? (
            <ProgressBar value={e.totals.sales} max={Math.max(e.targetSales, 1)} color="var(--color-subtle)" size="sm" label={`Target ${formatNumber(e.targetSales)}`} />
          ) : (
            <ProgressBar value={e.totals.sales} max={Math.max(e.targetSales, 1)} tone={tone} size="sm" label={`${formatNumber(e.totals.sales)} / ${formatNumber(e.targetSales)} sales`} />
          )}
          {e.forecast && <EventForecastChip forecast={e.forecast} targetSales={e.targetSales} campaignCode={e.campaignCode} type={e.type} teamName={e.teamName} side="bottom" />}
        </span>
        <span className="flex items-center justify-between gap-3 md:justify-end">
          {roster ? (
            <span className={`flex items-center gap-1 whitespace-nowrap text-xs ${missing ? 'font-semibold text-warning' : 'text-muted'}`} title="Team members with gauges logged">
              <Users className="h-3.5 w-3.5" aria-hidden />{formatNumber(roster.logged)} / {formatNumber(roster.members)} logged
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-muted" title="Reps with gauges logged"><Users className="h-3.5 w-3.5" aria-hidden />{formatNumber(e.repCount)}</span>
          )}
          <EventStatusBadge status={e.status} />
        </span>
      </Link>
      <DirectionsLink venue={e.venue} city={e.city} stretch className="rounded-r-xl border-l border-border" />
    </li>
  );
}
