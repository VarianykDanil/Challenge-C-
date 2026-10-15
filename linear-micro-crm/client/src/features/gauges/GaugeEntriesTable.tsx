// Table of individual gauge entries (per rep / per day) with punctuality and conversion.
import { Link } from 'react-router-dom';
import type { GaugeEntryWithMeta } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, POSITION_LABELS, funnelRatios, isCheckInOnTime } from '@lm/shared';
import { Avatar, Button, DataTable, type Column } from '@/components/ui';
import { ColourChip, OnTimeBadge, RatioCell, StopRowEvents } from '@/features/common';
import { formatDate, formatNumber, formatTime } from '@/lib/format';

export function GaugeEntriesTable({ rows, loading, showEvent = true, showPerson = true, showDate = true, onEdit, onDelete, canEditRow, emptyMessage = 'No gauge entries yet', className, bare }: {
  rows: GaugeEntryWithMeta[];
  loading?: boolean;
  showEvent?: boolean;
  showPerson?: boolean;
  showDate?: boolean;
  onEdit?: (row: GaugeEntryWithMeta) => void;
  onDelete?: (row: GaugeEntryWithMeta) => void;
  /** Show Edit/Delete only on rows the viewer may change (e.g. a rep's own entry). Defaults to every row. */
  canEditRow?: (row: GaugeEntryWithMeta) => boolean;
  emptyMessage?: string;
  className?: string;
  /** Render without the outer border (inside a Card with padded={false}). */
  bare?: boolean;
}) {
  const columns: Column<GaugeEntryWithMeta>[] = [];
  if (showDate) columns.push({ key: 'date', header: 'Date', render: (r) => <span className="whitespace-nowrap">{formatDate(r.date)}</span>, sortValue: (r) => r.date });
  if (showPerson)
    columns.push({
      key: 'user',
      header: 'Rep',
      render: (r) => (
        <Link to={`/team/${r.userId}`} className="flex items-center gap-2 hover:underline" onClick={(e) => e.stopPropagation()}>
          <Avatar name={r.userName} color={r.userAvatarColor} size="sm" />
          <span>
            <span className="block font-medium text-fg">{r.userName}</span>
            <span className="block text-xs text-muted">{POSITION_LABELS[r.userPosition]}</span>
          </span>
        </Link>
      ),
      sortValue: (r) => r.userName,
    });
  if (showEvent)
    columns.push({
      key: 'event',
      header: 'Event',
      render: (r) => (
        <Link to={`/events/${r.eventId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
          <span className="block font-medium text-fg">{r.eventName}</span>
          <ColourChip color={r.campaignColor} label={r.campaignName} className="text-xs text-muted" />
        </Link>
      ),
      sortValue: (r) => r.eventName,
    });
  for (const k of GAUGE_KEYS) {
    columns.push({ key: k, header: GAUGE_LABELS[k], align: 'right', render: (r) => <span className={k === 'sales' ? 'font-semibold text-fg' : undefined}>{formatNumber(r[k])}</span>, sortValue: (r) => r[k] });
  }
  columns.push({
    key: 'conversion',
    header: 'Conv.',
    align: 'center',
    render: (r) => <RatioCell keyName="overallConversion" value={funnelRatios(r).overallConversion} digits={1} />,
    sortValue: (r) => funnelRatios(r).overallConversion,
  });
  columns.push({
    key: 'checkin',
    header: 'Check-in',
    render: (r) => (
      <span className="flex items-center gap-2 whitespace-nowrap">
        <OnTimeBadge value={isCheckInOnTime(r.date, r.eventStartTime, r.checkedInAt)} />
        {r.checkedInAt && <span className="text-xs text-muted">{formatTime(r.checkedInAt)}</span>}
      </span>
    ),
    sortValue: (r) => r.checkedInAt ?? '',
  });
  if (onEdit || onDelete)
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (r) => (canEditRow && !canEditRow(r) ? null : (
        <StopRowEvents className="flex justify-end gap-1">
          {onEdit && <Button variant="ghost" size="sm" onClick={() => onEdit(r)} aria-label={`Edit ${r.userName}'s entry`}>Edit</Button>}
          {onDelete && <Button variant="ghost" size="sm" className="text-danger" onClick={() => onDelete(r)} aria-label={`Delete ${r.userName}'s entry`}>Delete</Button>}
        </StopRowEvents>
      )),
    });

  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} dense emptyMessage={emptyMessage} initialSort={{ key: 'date', dir: 'desc' }} className={className} bare={bare} />;
}
