// Sortable summary table of GaugeSummaryRow[] with benchmark-tinted ratio cells.
// Smart release 1.1 (p4): grouped by person, each row with enough stops gets a "Focus: stop → table" chip naming the
// stage furthest below its benchmark (shared weakestStage), so a leader sees at a glance what to practise with whom.
import { Crosshair } from 'lucide-react';
import type { GaugeGroupBy, GaugeSummaryRow } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, MIN_STOPS_FOR_INSIGHTS, weakestStage } from '@lm/shared';
import { Badge, DataTable, type Column } from '@/components/ui';
import { ColourChip, RatioCell } from '@/features/common';
import { formatDate, formatDateShort, formatDecimal, formatNumber } from '@/lib/format';
import { RATIO_SHORT_LABELS, type RatioKey } from '@/lib/ratios';

const RATIO_COLUMNS: RatioKey[] = ['stopToTable', 'tableToPresentation', 'presentationToClose', 'closeToTap', 'tapToSale', 'overallConversion'];

function labelFor(groupBy: GaugeGroupBy, row: GaugeSummaryRow): string {
  if (groupBy === 'day') return formatDate(row.key);
  if (groupBy === 'week') return `w/c ${formatDateShort(row.key)}`;
  return row.label;
}

/**
 * The stage to practise for one person's row: the weakest stage (lowest actual ÷ benchmark) when it is below its
 * benchmark and the row has at least MIN_STOPS_FOR_INSIGHTS stops; null otherwise (too few stops, or nothing below).
 */
function focusStageFor(row: Pick<GaugeSummaryRow, 'stops' | 'ratios'>) {
  if (!(row.stops >= MIN_STOPS_FOR_INSIGHTS)) return null;
  const weakest = weakestStage(row.ratios);
  return weakest && weakest.status === 'below' ? weakest : null;
}

function FocusChip({ row }: { row: GaugeSummaryRow }) {
  const focus = focusStageFor(row);
  if (!focus) return null;
  const label = focus.label.toLowerCase();
  return (
    <Badge size="sm" tone="info" title={`${label}: ${Math.round(focus.actual * 100)}% against the ${Math.round(focus.benchmark * 100)}% benchmark`}>
      <Crosshair aria-hidden />Focus: {label}
    </Badge>
  );
}

export function GaugeSummaryTable({ rows, groupBy, loading, onRowClick, showDays = true, perRep = groupBy !== 'user', emptyMessage = 'No gauges logged for this range', className, bare }: {
  rows: GaugeSummaryRow[];
  groupBy: GaugeGroupBy;
  loading?: boolean;
  onRowClick?: (row: GaugeSummaryRow) => void;
  showDays?: boolean;
  /** `days` counts distinct rep × day pairs (API: rep-days). Only for a single person does that equal days worked — pass false then. */
  perRep?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Render without the outer border (inside a Card with padded={false}). */
  bare?: boolean;
}) {
  const firstHeader = { user: 'Person', team: 'Team', campaign: 'Campaign', day: 'Day', week: 'Week' }[groupBy];
  const daysHeader = perRep ? 'Rep-days' : 'Days';
  const spdHeader = perRep ? 'Sales/rep-day' : 'Sales/day';
  const columns: Column<GaugeSummaryRow>[] = [
    {
      key: 'label',
      header: firstHeader,
      render: (r) =>
        groupBy === 'user' ? (
          <span className="flex min-w-[9rem] flex-wrap items-center gap-x-2 gap-y-1">
            <ColourChip color={r.color} label={labelFor(groupBy, r)} className="font-medium text-fg" />
            <FocusChip row={r} />
          </span>
        ) : (
          <ColourChip color={groupBy === 'day' || groupBy === 'week' ? null : r.color} label={labelFor(groupBy, r)} className="font-medium text-fg" />
        ),
      sortValue: (r) => (groupBy === 'day' || groupBy === 'week' ? r.key : r.label),
    },
    ...(showDays ? [{ key: 'days', header: <span title={perRep ? 'Distinct rep × day combinations in the range' : 'Days worked'}>{daysHeader}</span>, align: 'right' as const, render: (r: GaugeSummaryRow) => formatNumber(r.days), sortValue: (r: GaugeSummaryRow) => r.days }] : []),
    ...GAUGE_KEYS.map(
      (k): Column<GaugeSummaryRow> => ({
        key: k,
        header: GAUGE_LABELS[k],
        align: 'right',
        render: (r) => <span className={k === 'sales' ? 'font-semibold text-fg' : undefined}>{formatNumber(r[k])}</span>,
        sortValue: (r) => r[k],
      }),
    ),
    { key: 'salesPerDay', header: spdHeader, align: 'right', render: (r) => formatDecimal(r.salesPerDay), sortValue: (r) => r.salesPerDay },
    ...RATIO_COLUMNS.map(
      (k): Column<GaugeSummaryRow> => ({
        key: k,
        header: RATIO_SHORT_LABELS[k],
        align: 'center',
        render: (r) => <RatioCell keyName={k} value={r.ratios[k]} digits={k === 'overallConversion' ? 1 : 0} />,
        sortValue: (r) => r.ratios[k],
      }),
    ),
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      loading={loading}
      dense
      onRowClick={onRowClick}
      emptyMessage={emptyMessage}
      initialSort={groupBy === 'day' || groupBy === 'week' ? { key: 'label', dir: 'asc' } : { key: 'sales', dir: 'desc' }}
      className={className}
      bare={bare}
    />
  );
}
