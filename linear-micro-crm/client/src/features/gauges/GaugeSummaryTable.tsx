// Sortable summary table of GaugeSummaryRow[] with benchmark-tinted ratio cells.
import type { GaugeGroupBy, GaugeSummaryRow } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS } from '@lm/shared';
import { DataTable, type Column } from '@/components/ui';
import { ColourChip, RatioCell } from '@/features/common';
import { formatDate, formatDateShort, formatDecimal, formatNumber } from '@/lib/format';
import { RATIO_SHORT_LABELS, type RatioKey } from '@/lib/ratios';

const RATIO_COLUMNS: RatioKey[] = ['stopToTable', 'tableToPresentation', 'presentationToClose', 'closeToTap', 'tapToSale', 'overallConversion'];

function labelFor(groupBy: GaugeGroupBy, row: GaugeSummaryRow): string {
  if (groupBy === 'day') return formatDate(row.key);
  if (groupBy === 'week') return `w/c ${formatDateShort(row.key)}`;
  return row.label;
}

export function GaugeSummaryTable({ rows, groupBy, loading, onRowClick, showDays = true, emptyMessage = 'No gauges logged for this range', className, bare }: {
  rows: GaugeSummaryRow[];
  groupBy: GaugeGroupBy;
  loading?: boolean;
  onRowClick?: (row: GaugeSummaryRow) => void;
  showDays?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Render without the outer border (inside a Card with padded={false}). */
  bare?: boolean;
}) {
  const firstHeader = { user: 'Person', team: 'Team', campaign: 'Campaign', day: 'Day', week: 'Week' }[groupBy];
  const columns: Column<GaugeSummaryRow>[] = [
    {
      key: 'label',
      header: firstHeader,
      render: (r) => <ColourChip color={groupBy === 'day' || groupBy === 'week' ? null : r.color} label={labelFor(groupBy, r)} className="font-medium text-fg" />,
      sortValue: (r) => (groupBy === 'day' || groupBy === 'week' ? r.key : r.label),
    },
    ...(showDays ? [{ key: 'days', header: 'Days', align: 'right' as const, render: (r: GaugeSummaryRow) => formatNumber(r.days), sortValue: (r: GaugeSummaryRow) => r.days }] : []),
    ...GAUGE_KEYS.map(
      (k): Column<GaugeSummaryRow> => ({
        key: k,
        header: GAUGE_LABELS[k],
        align: 'right',
        render: (r) => <span className={k === 'sales' ? 'font-semibold text-fg' : undefined}>{formatNumber(r[k])}</span>,
        sortValue: (r) => r[k],
      }),
    ),
    { key: 'salesPerDay', header: 'Sales/day', align: 'right', render: (r) => formatDecimal(r.salesPerDay), sortValue: (r) => r.salesPerDay },
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
