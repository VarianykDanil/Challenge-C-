// Payslip breakdown for a single payroll run.
import type { PayrollRunWithUser } from '@lm/shared';
import { POSITION_LABELS } from '@lm/shared';
import { Badge, Modal, Skeleton } from '@/components/ui';
import { usePayslip } from '@/api/hooks';
import { ErrorState, OnTimeBadge, PayrollStatusBadge } from '@/features/common';
import { GaugeEntriesTable } from '@/features/gauges';
import { formatDate, formatGBP, formatNumber, formatRangeLabel } from '@/lib/format';

export function PayslipModal({ run, onClose }: { run: PayrollRunWithUser | null; onClose: () => void }) {
  return (
    <Modal open={!!run} onClose={onClose} title={run ? `Payslip · ${run.reference}` : 'Payslip'} description={run ? `${run.userName} · ${POSITION_LABELS[run.position]} · week ${formatRangeLabel(run.weekStart, run.weekEnd)}` : undefined} size="xl">
      {run && <PayslipBody run={run} />}
    </Modal>
  );
}

function PayslipBody({ run }: { run: PayrollRunWithUser }) {
  const q = usePayslip(run.id);
  const p = q.data;
  const lines: { label: string; value: number; hint?: string }[] = [
    { label: 'Base pay', value: run.basePay, hint: p ? `${formatNumber(run.daysWorked)} day${run.daysWorked === 1 ? '' : 's'} × ${formatGBP(p.plan.basePerDay, { cents: true })}` : `${formatNumber(run.daysWorked)} days` },
    { label: 'Commission', value: run.commission, hint: p ? `${formatNumber(run.sales)} sale${run.sales === 1 ? '' : 's'} × ${formatGBP(p.plan.commissionPerSale, { cents: true })}` : `${formatNumber(run.sales)} sales` },
    { label: 'Bonus', value: run.bonus, hint: p && p.plan.bonusThreshold > 0 ? `${formatNumber(p.plan.bonusThreshold)}+ sales unlocks ${formatGBP(p.plan.bonusAmount)}` : undefined },
    { label: 'Overrides', value: run.overrides, hint: p && p.plan.overridePerTeamSale > 0 ? `${formatNumber(run.teamSales)} team sales × ${formatGBP(p.plan.overridePerTeamSale, { cents: true })}` : undefined },
    { label: 'Deductions', value: -run.deductions },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <PayrollStatusBadge status={run.status} />
        <OnTimeBadge value={run.onTime} labels={{ yes: 'Paid on time', no: 'Paid late', none: 'Not yet paid' }} />
        <span className="text-muted">Due {formatDate(run.dueDate)}{run.paidDate ? ` · paid ${formatDate(run.paidDate)}` : ''}</span>
        {run.teamName && <Badge tone="neutral">{run.teamName}</Badge>}
      </div>
      <div className="grid gap-5 md:grid-cols-5">
        <table className="w-full text-sm md:col-span-3">
          <caption className="sr-only">Pay breakdown</caption>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label} className="border-b border-border">
                <th scope="row" className="py-2 text-left font-medium text-fg">{l.label}{l.hint && <span className="block text-xs font-normal text-muted">{l.hint}</span>}</th>
                <td className={`py-2 text-right tabular-nums ${l.value < 0 ? 'text-danger' : 'text-fg'}`}>{l.value < 0 ? `−${formatGBP(Math.abs(l.value), { cents: true })}` : formatGBP(l.value, { cents: true })}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-3 text-left text-base font-semibold text-fg">Gross pay</th>
              <td className="py-3 text-right text-base font-semibold tabular-nums text-fg">{formatGBP(run.gross, { cents: true })}</td>
            </tr>
          </tbody>
        </table>
        <div className="rounded-lg bg-surface-2 p-4 text-sm md:col-span-2">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Pay plan</div>
          {q.isLoading ? <div className="space-y-2"><Skeleton /><Skeleton /><Skeleton /></div> : q.isError ? <ErrorState error={q.error} className="p-3" /> : p && (
            <dl className="space-y-1.5">
              <div className="flex justify-between gap-2"><dt className="text-muted">Plan</dt><dd className="font-medium text-fg">{p.plan.name}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Base per day</dt><dd className="tabular-nums">{formatGBP(p.plan.basePerDay, { cents: true })}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Commission per sale</dt><dd className="tabular-nums">{formatGBP(p.plan.commissionPerSale, { cents: true })}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Bonus</dt><dd className="tabular-nums">{p.plan.bonusThreshold > 0 ? `${formatGBP(p.plan.bonusAmount)} at ${p.plan.bonusThreshold} sales` : '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Override per team sale</dt><dd className="tabular-nums">{p.plan.overridePerTeamSale > 0 ? formatGBP(p.plan.overridePerTeamSale, { cents: true }) : '—'}</dd></div>
              <div className="flex justify-between gap-2 border-t border-border pt-1.5"><dt className="text-muted">Employee ID</dt><dd>{run.employeeId}</dd></div>
            </dl>
          )}
        </div>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">The week's gauges</div>
        <GaugeEntriesTable rows={p?.entries ?? []} loading={q.isLoading} showPerson={false} emptyMessage="No gauge entries this week" />
      </div>
    </div>
  );
}
