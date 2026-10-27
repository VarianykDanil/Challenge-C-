import { useEffect, useRef } from 'react';
import type { PayrollRunWithUser } from '@lm/shared';
import { paySignedMoney } from '@lm/shared';
import { Avatar, Badge, Button, DataTable, Tooltip, type Column } from '@/components/ui';
import { OnTimeBadge, PayrollStatusBadge, StopRowEvents } from '@/features/common';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
// Release 1.3 slot (P2): the self-billing invoice's status on each run.
import { InvoiceStatusBadge } from '@/features/invoices/InvoiceStatusBadge';
// Release 1.4 (F): a run's payment from Linear Hub (admin: on its way, or failed with the reason).
import { PaymentRunBadge, RunChecksBadges } from '@/features/payments';
import { todayISO } from '@/lib/dates';
import { formatDate, formatDateTime, formatGBP, formatNumber, formatRangeLabel } from '@/lib/format';
import { runAdjustedAt, warningFlags } from './PayslipModal';
// Release 1.3 (P1): the base-or-commission rule
import { PAID_AS_LABELS, paidAmount } from '@/features/pay/payCopy';

/** Row selection for bulk "Mark paid" (admin Runs to pay). Rows that cannot be selected show a disabled box. */
export interface PayrollRunSelection {
  selected: ReadonlySet<number>;
  /** False for runs the current mode does not allow (e.g. failed transfers until "include failed transfers" is ticked). */
  canSelect: (run: PayrollRunWithUser) => boolean;
  onChange: (runs: PayrollRunWithUser[], checked: boolean) => void;
  /** Why a row cannot be selected (tooltip / accessible description). */
  disabledReason?: (run: PayrollRunWithUser) => string | undefined;
}

/** A native checkbox inside a 40 × 40 px tap target; supports the indeterminate (some selected) state. */
function SelectBox({ checked, indeterminate, disabled, label, title, onChange }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; title?: string; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label className="-my-2 -ml-2 inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md hover:bg-surface-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent" title={title}>
      <input
        ref={ref}
        type="checkbox"
        className="focus-ring h-4 w-4 cursor-pointer rounded border-control-border accent-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function PayrollRunsTable({ rows, loading, showUser, onRowClick, onMarkPaid, markingId, markPaidDisabled, emptyMessage = 'No payroll runs in this range', className, bare, selection, hideWeek }: {
  rows: PayrollRunWithUser[];
  loading?: boolean;
  showUser?: boolean;
  onRowClick?: (run: PayrollRunWithUser) => void;
  onMarkPaid?: (run: PayrollRunWithUser) => void;
  markingId?: number | null;
  /** Disable every row's Mark paid (e.g. while a bulk Mark paid is running, so a single click cannot race the batch). */
  markPaidDisabled?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Render without the outer border (inside a Card with padded={false}). */
  bare?: boolean;
  /** Adds a checkbox column for bulk "Mark paid" (admin). */
  selection?: PayrollRunSelection;
  /** Leave out the Week column (inside a week group, where every row is the same week). */
  hideWeek?: boolean;
}) {
  const today = todayISO();
  // Recruiters are paid on hires, which the payroll `sales` column holds: label the column by who is in the table.
  const recruiters = rows.filter((r) => r.position === 'recruiter').length;
  const salesHeader = rows.length > 0 && recruiters === rows.length ? 'Hires' : recruiters > 0 ? 'Sales / hires' : 'Sales';
  const mixed = recruiters > 0 && recruiters < rows.length;
  const columns: Column<PayrollRunWithUser>[] = [];
  if (selection) {
    const selectable = rows.filter(selection.canSelect);
    const picked = selectable.filter((r) => selection.selected.has(r.id)).length;
    columns.push({
      key: 'select',
      width: '48px',
      header: selectable.length ? (
        <SelectBox
          checked={picked > 0 && picked === selectable.length}
          indeterminate={picked > 0}
          label={picked === selectable.length ? 'Clear the selection in this list' : `Select all ${formatNumber(selectable.length)} runs in this list`}
          onChange={(checked) => selection.onChange(selectable, checked)}
        />
      ) : <span className="sr-only">Select</span>,
      render: (r) => {
        const can = selection.canSelect(r);
        const reason = can ? undefined : selection.disabledReason?.(r);
        return (
          <StopRowEvents className="inline-flex">
            <SelectBox
              checked={can && selection.selected.has(r.id)}
              disabled={!can}
              title={reason}
              label={`Select ${r.userName}, week ${formatRangeLabel(r.weekStart, r.weekEnd)}${reason ? ` (${reason})` : ''}`}
              onChange={(checked) => selection.onChange([r], checked)}
            />
          </StopRowEvents>
        );
      },
    });
  }
  if (!hideWeek) columns.push({ key: 'week', header: 'Week', render: (r) => <span className="whitespace-nowrap font-medium text-fg">{formatRangeLabel(r.weekStart, r.weekEnd)}</span>, sortValue: (r) => r.weekStart });
  if (showUser) columns.push({ key: 'user', header: 'Person', render: (r) => <span className="flex items-center gap-2"><Avatar name={r.userName} size="xs" /><span>{r.userName}<span className="block text-xs text-muted">{[r.employeeId, r.teamName].filter(Boolean).join(' · ')}</span></span></span>, sortValue: (r) => r.userName });
  columns.push(
    { key: 'days', header: 'Days', align: 'right', render: (r) => formatNumber(r.daysWorked), sortValue: (r) => r.daysWorked },
    {
      key: 'sales',
      header: salesHeader,
      align: 'right',
      render: (r) => (
        <span className="whitespace-nowrap">
          {mixed && r.position === 'recruiter' ? <>{formatNumber(r.sales)}<span className="ml-1 text-xs text-muted">hire{r.sales === 1 ? '' : 's'}</span></> : formatNumber(r.sales)}
          {/* Release 1.3 (P1): subs a client's statement cancelled */}
          {(r.salesCancelled ?? 0) > 0 && <span className="block text-xs text-warning">{formatNumber(r.salesCancelled!)} cancelled</span>}
        </span>
      ),
      sortValue: (r) => r.sales,
    },
    // Release 1.3 (P1): which of base or commission the week paid (the 1.2 runs paid both, by the plan)
    {
      key: 'paidAs',
      header: 'Paid as',
      render: (r) => (
        <span className="whitespace-nowrap">
          {r.paidAs ? <Badge tone={r.paidAs === 'commission' ? 'success' : 'primary'} size="sm">{PAID_AS_LABELS[r.paidAs]}</Badge> : <span className="text-xs text-muted">Plan</span>}
          <span className="block text-xs tabular-nums text-muted">{formatGBP(paidAmount(r), { cents: true })}</span>
        </span>
      ),
      sortValue: (r) => `${r.paidAs ?? 'plan'}${String(Math.round(paidAmount(r) * 100)).padStart(9, '0')}`,
    },
    {
      key: 'gross',
      header: 'Gross',
      align: 'right',
      render: (r) => {
        const extras = [r.bonus > 0 ? `incl. ${formatGBP(r.bonus, { cents: true })} bonus` : null, (r.adjustmentsTotal ?? 0) !== 0 ? `incl. ${paySignedMoney(r.adjustmentsTotal!)} corrections` : null, r.deductions > 0 ? `after ${formatGBP(r.deductions, { cents: true })} deductions` : null].filter(Boolean);
        return (
          <span className="whitespace-nowrap">
            <span className={`font-semibold tabular-nums ${r.gross < 0 ? 'text-danger' : 'text-fg'}`}>{formatGBP(r.gross, { cents: true })}</span>
            {extras.map((x) => <span key={x} className="block text-xs text-muted">{x}</span>)}
          </span>
        );
      },
      sortValue: (r) => r.gross,
    },
    { key: 'due', header: 'Due', render: (r) => <span className="whitespace-nowrap">{formatDate(r.dueDate)}</span>, sortValue: (r) => r.dueDate },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const owed = r.status === 'pending' || r.status === 'failed';
        const adjustedAt = runAdjustedAt(r);
        const warnings = owed ? warningFlags(r) : [];
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <PayrollStatusBadge status={r.status} />
            <ErrorBoundary name="invoice-status" fallback={null}><InvoiceStatusBadge run={r} /></ErrorBoundary>
            {owed && <PaymentRunBadge payment={r.payment} />}
            {owed && <RunChecksBadges checks={r.checks} />}
            {/* Pending runs and failed transfers past their due date are both overdue money. */}
            {owed && r.dueDate < today ? <Badge tone="danger">Overdue</Badge> : <OnTimeBadge value={r.onTime} labels={{ yes: 'On time', no: 'Late', none: r.status === 'pending' ? 'Awaiting' : 'Unpaid' }} />}
            {adjustedAt && <Badge tone="warning" title={`Recalculated ${formatDateTime(adjustedAt)}`}>Adjusted after payment</Badge>}
            {/* p3: advisory checks — the tooltip lists them; opening the run shows them in "Checks before paying". */}
            {warnings.length > 0 && (
              <Tooltip side="left" content={<ul className="list-disc space-y-1 pl-3.5 text-left">{warnings.map((f) => <li key={f.code}>{f.text}</li>)}</ul>}>
                <span tabIndex={0} className="focus-ring inline-flex rounded-full" aria-label={`Check before paying: ${warnings.map((f) => f.text).join('; ')}`} data-payroll-check="">
                  <Badge tone="warning" variant="solid">Check</Badge>
                </span>
              </Tooltip>
            )}
          </span>
        );
      },
      sortValue: (r) => r.status,
    },
  );
  if (onMarkPaid)
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (r) => r.status === 'pending' || r.status === 'failed' ? <StopRowEvents className="inline-flex"><Button size="sm" variant="outline" className="h-10 sm:h-8" loading={markingId === r.id} disabled={markPaidDisabled} onClick={() => onMarkPaid(r)}>Mark paid</Button></StopRowEvents> : null,
    });
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      loading={loading}
      onRowClick={onRowClick}
      emptyMessage={emptyMessage}
      initialSort={hideWeek ? undefined : { key: 'week', dir: 'desc' }}
      className={className}
      bare={bare}
      rowClassName={selection ? (r) => (selection.selected.has(r.id) ? 'bg-primary-soft/40' : undefined) : undefined}
    />
  );
}
