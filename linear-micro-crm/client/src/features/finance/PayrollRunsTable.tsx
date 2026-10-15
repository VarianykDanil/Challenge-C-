import type { PayrollRunWithUser } from '@lm/shared';
import { Avatar, Button, DataTable, type Column } from '@/components/ui';
import { OnTimeBadge, PayrollStatusBadge } from '@/features/common';
import { formatDate, formatGBP, formatNumber, formatRangeLabel } from '@/lib/format';

export function PayrollRunsTable({ rows, loading, showUser, onRowClick, onMarkPaid, markingId, emptyMessage = 'No payroll runs in this range', className, bare }: {
  rows: PayrollRunWithUser[];
  loading?: boolean;
  showUser?: boolean;
  onRowClick?: (run: PayrollRunWithUser) => void;
  onMarkPaid?: (run: PayrollRunWithUser) => void;
  markingId?: number | null;
  emptyMessage?: string;
  className?: string;
  /** Render without the outer border (inside a Card with padded={false}). */
  bare?: boolean;
}) {
  const columns: Column<PayrollRunWithUser>[] = [
    { key: 'week', header: 'Week', render: (r) => <span className="whitespace-nowrap font-medium text-fg">{formatRangeLabel(r.weekStart, r.weekEnd)}</span>, sortValue: (r) => r.weekStart },
  ];
  if (showUser) columns.push({ key: 'user', header: 'Person', render: (r) => <span className="flex items-center gap-2"><Avatar name={r.userName} size="xs" /><span>{r.userName}<span className="block text-xs text-muted">{r.employeeId}{r.teamName ? ` · ${r.teamName}` : ''}</span></span></span>, sortValue: (r) => r.userName });
  columns.push(
    { key: 'days', header: 'Days', align: 'right', render: (r) => formatNumber(r.daysWorked), sortValue: (r) => r.daysWorked },
    { key: 'sales', header: 'Sales', align: 'right', render: (r) => formatNumber(r.sales), sortValue: (r) => r.sales },
    { key: 'commission', header: 'Commission', align: 'right', render: (r) => <span className="tabular-nums">{formatGBP(r.commission, { cents: true })}</span>, sortValue: (r) => r.commission },
    { key: 'gross', header: 'Gross', align: 'right', render: (r) => <span className="font-semibold tabular-nums text-fg">{formatGBP(r.gross, { cents: true })}</span>, sortValue: (r) => r.gross },
    { key: 'due', header: 'Due', render: (r) => <span className="whitespace-nowrap">{formatDate(r.dueDate)}</span>, sortValue: (r) => r.dueDate },
    { key: 'status', header: 'Status', render: (r) => <span className="flex flex-wrap items-center gap-1.5"><PayrollStatusBadge status={r.status} /><OnTimeBadge value={r.onTime} labels={{ yes: 'On time', no: 'Late', none: r.status === 'pending' ? 'Awaiting' : 'Unpaid' }} /></span>, sortValue: (r) => r.status },
  );
  if (onMarkPaid)
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (r) => r.status === 'pending' || r.status === 'failed' ? <Button size="sm" variant="outline" loading={markingId === r.id} onClick={(e) => { e.stopPropagation(); onMarkPaid(r); }}>Mark paid</Button> : null,
    });
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} onRowClick={onRowClick} emptyMessage={emptyMessage} initialSort={{ key: 'week', dir: 'desc' }} className={className} bare={bare} />;
}
