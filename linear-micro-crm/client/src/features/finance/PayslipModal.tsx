// Payslip breakdown for a single payroll run, with a "Print payslip" action that lays it out on A4.
import { Printer } from 'lucide-react';
import type { PayrollRunWithUser } from '@lm/shared';
import { BRAND, POSITION_LABELS } from '@lm/shared';
import { Badge, Button, Modal, Skeleton } from '@/components/ui';
import { usePayslip } from '@/api/hooks';
import { ErrorState, OnTimeBadge, PayrollStatusBadge } from '@/features/common';
import { GaugeEntriesTable } from '@/features/gauges';
import { formatDate, formatGBP, formatNumber, formatRangeLabel } from '@/lib/format';
import { PAYROLL_STATUS_LABELS } from '@/lib/labels';

export function PayslipModal({ run, onClose }: { run: PayrollRunWithUser | null; onClose: () => void }) {
  return (
    <Modal
      open={!!run}
      onClose={onClose}
      title={run ? `Payslip · ${run.reference}` : 'Payslip'}
      description={run ? `${run.userName} · ${POSITION_LABELS[run.position]} · week ${formatRangeLabel(run.weekStart, run.weekEnd)}` : undefined}
      size="xl"
      footer={run ? (
        <Button variant="outline" onClick={() => window.print()} leftIcon={<Printer aria-hidden />}>
          Print payslip
        </Button>
      ) : undefined}
    >
      {run && <PayslipBody run={run} />}
    </Modal>
  );
}

/**
 * Print rules, scoped to the time the payslip is open (the <style> unmounts with the modal). Only the
 * element marked `data-print-root` is printed; every ancestor (the fixed, scrolling dialog chrome) is
 * flattened so the payslip flows top-down over as many A4 pages as it needs, and siblings on the way
 * down (backdrop, dialog header/footer, the app behind it) take no space.
 */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  body > * { visibility: hidden !important; }
  [data-print-root], [data-print-root] * { visibility: visible !important; }
  *:has([data-print-root]) {
    position: static !important; display: block !important; overflow: visible !important;
    width: auto !important; max-width: none !important; height: auto !important; max-height: none !important;
    inset: auto !important; margin: 0 !important; padding: 0 !important; border: 0 !important;
    transform: none !important; animation: none !important; box-shadow: none !important;
    background: transparent !important; backdrop-filter: none !important;
  }
  *:has([data-print-root]) > *:not([data-print-root]):not(:has([data-print-root])) { display: none !important; }
  [data-print-root] { position: static !important; color: black; font-size: 12px; line-height: 1.4; }
  [data-print-root] * { color: black !important; background: transparent !important; box-shadow: none !important; border-color: rgba(0, 0, 0, 0.35) !important; }
  [data-print-root] [class*="overflow-"] { overflow: visible !important; }
  [data-print-root] thead { position: static !important; }
  [data-print-root] tr, [data-print-root] [data-print-keep] { break-inside: avoid; }
  [data-print-root] [aria-hidden="true"]:not(svg) { display: none !important; }
}
`;

function PayslipBody({ run }: { run: PayrollRunWithUser }) {
  const q = usePayslip(run.id);
  const p = q.data;
  const lines: { label: string; value: number; hint?: string }[] = [
    { label: 'Base pay', value: run.basePay, hint: p ? `${formatNumber(run.daysWorked)} day${run.daysWorked === 1 ? '' : 's'} × ${formatGBP(p.plan.basePerDay, { cents: true })}` : `${formatNumber(run.daysWorked)} days` },
    { label: 'Commission', value: run.commission, hint: p ? `${formatNumber(run.sales)} sale${run.sales === 1 ? '' : 's'} × ${formatGBP(p.plan.commissionPerSale, { cents: true })}` : `${formatNumber(run.sales)} sales` },
    { label: 'Bonus', value: run.bonus, hint: p && p.plan.bonusThreshold > 0 ? `${formatNumber(p.plan.bonusThreshold)}+ sales unlocks ${formatGBP(p.plan.bonusAmount)}` : undefined },
    { label: 'Overrides', value: run.overrides, hint: p && p.plan.overridePerTeamSale > 0 ? `${formatNumber(run.teamSales)} team sales × ${formatGBP(p.plan.overridePerTeamSale, { cents: true })}` : undefined },
    { label: 'Deductions', value: -run.deductions || 0 },
  ];
  return (
    <div className="space-y-5" data-print-root>
      <style>{PRINT_CSS}</style>

      {/* Letterhead — print only. On screen the dialog title carries the same facts. */}
      <header className="hidden print:block" data-print-keep>
        <div className="flex items-start justify-between gap-6 border-b border-border pb-3">
          <div>
            <div className="text-lg font-bold text-fg">{BRAND.legalName}</div>
            <div className="text-xs text-muted">{BRAND.address}</div>
            <div className="text-xs text-muted">{BRAND.website}</div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold text-fg">Payslip</div>
            <div className="text-xs text-muted">Reference {run.reference}</div>
            <div className="text-xs text-muted">Printed {formatDate(new Date())}</div>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div className="flex justify-between gap-2 border-b border-border py-1"><dt className="text-muted">Employee</dt><dd className="font-medium text-fg">{run.userName}{run.employeeId ? ` · ${run.employeeId}` : ''}</dd></div>
          <div className="flex justify-between gap-2 border-b border-border py-1"><dt className="text-muted">Position</dt><dd className="font-medium text-fg">{POSITION_LABELS[run.position]}{run.teamName ? ` · ${run.teamName}` : ''}</dd></div>
          <div className="flex justify-between gap-2 border-b border-border py-1"><dt className="text-muted">Pay week</dt><dd className="font-medium text-fg">{formatRangeLabel(run.weekStart, run.weekEnd)}</dd></div>
          <div className="flex justify-between gap-2 border-b border-border py-1"><dt className="text-muted">Status</dt><dd className="font-medium text-fg">{PAYROLL_STATUS_LABELS[run.status]} · due {formatDate(run.dueDate)}{run.paidDate ? `, paid ${formatDate(run.paidDate)}` : ''}</dd></div>
        </dl>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm print:hidden">
        <PayrollStatusBadge status={run.status} />
        <OnTimeBadge value={run.onTime} labels={{ yes: 'Paid on time', no: 'Paid late', none: 'Not yet paid' }} />
        <span className="text-muted">Due {formatDate(run.dueDate)}{run.paidDate ? ` · paid ${formatDate(run.paidDate)}` : ''}</span>
        {run.teamName && <Badge tone="neutral">{run.teamName}</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-5 print:grid-cols-5" data-print-keep>
        <table className="w-full min-w-0 text-sm md:col-span-3 print:col-span-3">
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
        <div className="min-w-0 rounded-lg bg-surface-2 p-4 text-sm md:col-span-2 print:col-span-2 print:border print:border-border">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Pay plan</div>
          {q.isLoading ? <div className="space-y-2"><Skeleton /><Skeleton /><Skeleton /></div> : q.isError ? <ErrorState error={q.error} className="p-3" /> : p && (
            <dl className="space-y-1.5">
              <div className="flex justify-between gap-2"><dt className="text-muted">Plan</dt><dd className="font-medium text-fg">{p.plan.name}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Base per day</dt><dd className="tabular-nums">{formatGBP(p.plan.basePerDay, { cents: true })}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Commission per sale</dt><dd className="tabular-nums">{formatGBP(p.plan.commissionPerSale, { cents: true })}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Bonus</dt><dd className="tabular-nums">{p.plan.bonusThreshold > 0 ? `${formatGBP(p.plan.bonusAmount)} at ${p.plan.bonusThreshold} sales` : '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Override per team sale</dt><dd className="tabular-nums">{p.plan.overridePerTeamSale > 0 ? formatGBP(p.plan.overridePerTeamSale, { cents: true }) : '—'}</dd></div>
              {run.employeeId && <div className="flex justify-between gap-2 border-t border-border pt-1.5"><dt className="text-muted">Employee ID</dt><dd>{run.employeeId}</dd></div>}
            </dl>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">The week's gauges</div>
        <GaugeEntriesTable rows={p?.entries ?? []} loading={q.isLoading} showPerson={false} emptyMessage="No gauge entries this week" />
      </div>
    </div>
  );
}
