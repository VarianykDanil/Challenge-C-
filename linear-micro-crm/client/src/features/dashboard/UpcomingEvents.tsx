import { Link } from 'react-router-dom';
import { CalendarDays, MapPin } from 'lucide-react';
import type { SalesEventWithMeta } from '@lm/shared';
import { EmptyState } from '@/components/ui';
import { EventStatusBadge } from '@/features/common';
import { formatDateShort, formatRelative, formatTime } from '@/lib/format';

export function UpcomingEvents({ events }: { events: SalesEventWithMeta[] }) {
  if (!events.length) return <EmptyState icon={<CalendarDays className="h-6 w-6" aria-hidden />} title="Nothing scheduled" description="Upcoming events for your team will appear here." size="sm" className="border-0" />;
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id}>
          <Link to={`/events/${e.id}`} className="flex items-center gap-3 rounded-md py-2.5 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: e.campaignColor }} aria-hidden />
            <span className="flex w-14 shrink-0 flex-col text-xs text-muted">
              <span className="font-semibold text-fg">{formatDateShort(e.date)}</span>
              <span>{formatTime(e.startTime)}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{e.name}</span>
              <span className="flex items-center gap-1 truncate text-xs text-muted"><MapPin className="h-3 w-3" aria-hidden />{e.venue}, {e.city} · {e.teamName}</span>
            </span>
            <span className="hidden text-xs text-muted sm:block">{formatRelative(e.date)}</span>
            <EventStatusBadge status={e.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
