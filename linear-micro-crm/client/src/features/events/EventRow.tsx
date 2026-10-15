import { Link } from 'react-router-dom';
import { Clock, MapPin, Users } from 'lucide-react';
import type { SalesEventWithMeta } from '@lm/shared';
import { Badge, ProgressBar } from '@/components/ui';
import { EventStatusBadge, EventTypeBadge } from '@/features/common';
import { formatNumber, formatTime } from '@/lib/format';

export function EventRow({ event: e }: { event: SalesEventWithMeta }) {
  const pct = e.targetSales > 0 ? e.totals.sales / e.targetSales : 0;
  const tone = e.status === 'cancelled' ? 'danger' : pct >= 1 ? 'success' : pct >= 0.5 ? 'primary' : 'warning';
  return (
    <li>
      <Link
        to={`/events/${e.id}`}
        className="grid grid-cols-[4px_1fr] items-stretch gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm transition hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[4px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(140px,1fr)_auto] md:items-center"
        aria-label={`${e.name}, ${e.campaignName}, ${e.venue}`}
      >
        <span className="rounded-full" style={{ backgroundColor: e.campaignColor }} aria-hidden />
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
        <span>
          <ProgressBar value={e.totals.sales} max={Math.max(e.targetSales, 1)} tone={tone} size="sm" label={`${formatNumber(e.totals.sales)} / ${formatNumber(e.targetSales)} sales`} />
        </span>
        <span className="flex items-center justify-between gap-3 md:justify-end">
          <span className="flex items-center gap-1 text-xs text-muted" title="Reps with gauges logged"><Users className="h-3.5 w-3.5" aria-hidden />{formatNumber(e.repCount)}</span>
          <EventStatusBadge status={e.status} />
        </span>
      </Link>
    </li>
  );
}
