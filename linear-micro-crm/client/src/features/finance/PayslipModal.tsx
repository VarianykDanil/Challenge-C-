// Payslip breakdown for a single payroll run, with a "Print payslip" action that lays it out on A4.
// Release 1.3 (P2 invoices, which owns this file in 1.3): a run with a self-billing invoice (reps and leaders) opens as
// the invoice — the document replaces the pay table and plan box, with Accept / Something's wrong (or the office's
// actions) above it, "Print invoice" and "Download PDF". Runs without an invoice (office
// roles, weeks paid before invoices began) keep the payslip; for a field person's week under the 1.3 base-or-commission
// rule, P1's breakdown (same query, fetched once) replaces the 1.2 pay table and plan box, whose plan figures (commission
// per sale £0.00, "Base pay 4 days × £63.50 £0.00") contradicted it.
import { useRef, useState, type RefObject } from 'react';
import { CheckCircle2, Download, Info, Printer, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { PayrollFlag, PayrollRunWithUser } from '@lm/shared';
import { BRAND, POSITION_LABELS } from '@lm/shared';
import { Badge, Button, Modal, Skeleton, useToast } from '@/components/ui';
import { usePayslip } from '@/api/hooks';
import { usePayBreakdown } from '@/api/pay';
import { useInvoiceForRun } from '@/api/invoices';
import { reportAuditEvent } from '@/api/auditEvents';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorBoundary, ErrorState, OnTimeBadge, PayrollStatusBadge, errorMessage } from '@/features/common';
import { EntityHistory } from '@/features/audit/EntityHistory';
// Release 1.3 slots: the invoice's Accept / Dispute bar (P2), the 1.3 pay breakdown (P1), "opened" for the trail (P9).
import { RecordOpened } from '@/features/audit/RecordOpened';
import { InvoiceActionsBar } from '@/features/invoices/InvoiceActionsBar';
import { InvoiceDocument } from '@/features/invoices/InvoiceDocument';
import { InvoiceStatusBadge } from '@/features/invoices/InvoiceStatusBadge';
import { PayBreakdown } from '@/features/pay/PayBreakdown';
import { GaugeEntriesTable } from '@/features/gauges';
import { PDF_EXPORTS_READY } from '@/lib/pdf';
import { formatDate, formatDateTime, formatGBP, formatNumber, formatRangeLabel } from '@/lib/format';
import { PAYROLL_STATUS_LABELS } from '@/lib/labels';

/** A run the server recalculated after it was paid carries `adjustedAt` (optional in the contract; older servers omit it). */
export type PayrollRunMaybeAdjusted = PayrollRunWithUser & { adjustedAt?: string | null };

/** ISO timestamp of a post-payment adjustment, or null. */
export function runAdjustedAt(run: PayrollRunWithUser): string | null {
  const v = (run as PayrollRunMaybeAdjusted).adjustedAt;
  return typeof v === 'string' && v ? v : null;
}

/** Smart release 1.1 (p3): the advisory checks attached to an unpaid run for admins (`undefined` = not checked). */
export function runFlags(run: Pick<PayrollRunWithUser, 'flags'> | null | undefined): PayrollFlag[] | undefined {
  return Array.isArray(run?.flags) ? run.flags : undefined;
}

/** The warning-level checks on a run (what earns the amber "Check" badge and the confirm step before paying). */
export function warningFlags(run: Pick<PayrollRunWithUser, 'flags'> | null | undefined): PayrollFlag[] {
  return (runFlags(run) ?? []).filter((f) => f.severity === 'warning');
}

/**
 * "Checks before paying": every flag on the run, warnings first. Advisory only — nothing here blocks paying.
 * `flags` = [] renders the all-clear line; undefined renders nothing (the run was not checked).
 */
export function PayrollChecksList({ flags, className, compact }: { flags: PayrollFlag[] | undefined; className?: string; compact?: boolean }) {
  if (!flags) return null;
  if (!flags.length) {
    return (
      <p className={clsx('flex items-center gap-2 text-xs text-success', className)}>
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> Nothing unusual about this run
      </p>
    );
  }
  const ordered = [...flags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));
  return (
    <ul className={clsx('space-y-1.5', className)}>
      {ordered.map((f) => (
        <li key={f.code} className={clsx('flex items-start gap-2 leading-snug', compact ? 'text-xs' : 'text-sm')}>
          {f.severity === 'warning'
            ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Check" />
            : <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-label="Note" />}
          <span className="min-w-0 text-fg">{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Recruiters are paid on hires: the payroll `sales` column holds their hire count (LOGIC.md §4). */
export const payUnit = (run: Pick<PayrollRunWithUser, 'position'>): 'sale' | 'hire' => (run.position === 'recruiter' ? 'hire' : 'sale');
export const payUnits = (run: Pick<PayrollRunWithUser, 'position'>, n: number): string => `${formatNumber(n)} ${payUnit(run)}${n === 1 ? '' : 's'}`;

export function PayslipModal({ run, onClose }: { run: PayrollRunWithUser | null; onClose: () => void }) {
  const hasInvoice = !!run?.invoice;
  const invoice = useInvoiceForRun(run?.id, { enabled: hasInvoice });
  const inv = hasInvoice ? invoice.data : undefined;
  const toast = useToast();
  const [pdfBusy, setPdfBusy] = useState(false);
  // Focus starts at the top of the body (the status row), not on the gauges table further down: the invoice loads in
  // above it, and focusing the table first left the dialog opened half-way down.
  const topRef = useRef<HTMLDivElement>(null);
  const print = () => {
    if (inv) reportAuditEvent({ kind: 'export', format: 'print', what: `invoice ${inv.number}`, entity: 'invoice', entityId: inv.id });
    window.print();
  };
  const downloadPdf = async () => {
    if (!inv) return;
    setPdfBusy(true);
    try {
      const { downloadInvoicePdf } = await import('@/features/invoices/invoicePdf');
      await downloadInvoicePdf(inv);
    } catch (e) {
      toast.error('Could not make the PDF', errorMessage(e));
    } finally {
      setPdfBusy(false);
    }
  };
  return (
    <Modal
      open={!!run}
      onClose={onClose}
      title={run ? (run.invoice ? `Invoice · ${run.invoice.number}` : `Payslip · ${run.reference}`) : 'Payslip'}
      description={run ? `${run.userName} · ${POSITION_LABELS[run.position]} · week ${formatRangeLabel(run.weekStart, run.weekEnd)}` : undefined}
      size="xl"
      initialFocusRef={topRef}
      footer={run ? (
        <>
          {hasInvoice && PDF_EXPORTS_READY && (
            <Button variant="outline" onClick={() => void downloadPdf()} loading={pdfBusy} disabled={!inv} leftIcon={<Download aria-hidden />}>
              Download PDF
            </Button>
          )}
          <Button variant="outline" onClick={print} leftIcon={<Printer aria-hidden />}>
            {hasInvoice ? 'Print invoice' : 'Print payslip'}
          </Button>
        </>
      ) : undefined}
    >
      {run && <PayslipBody run={run} topRef={topRef} />}
    </Modal>
  );
}

/**
 * Print rules, scoped to the time the payslip is open (the <style> unmounts with the modal). Only the
 * element marked `data-print-root` is printed; every ancestor (the fixed, scrolling dialog chrome) is
 * flattened so the payslip flows top-down over as many A4 pages as it needs, and siblings on the way
 * down (backdrop, dialog header/footer, the app behind it) take no space. The page itself is white in
 * both themes (dark mode with "Background graphics" on printed a near-black page).
 */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  /* more specific than the flattening rule below (which makes every ancestor transparent), so the page is white */
  html:has([data-print-root]), html:has([data-print-root]) body { background: #fff !important; color-scheme: light !important; }
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

function PayslipBody({ run, topRef }: { run: PayrollRunWithUser; topRef?: RefObject<HTMLDivElement | null> }) {
  const me = useCurrentUser();
  const q = usePayslip(run.id);
  const p = q.data;
  // The payslip's copy is the fresher one (e.g. just marked paid from the invoice's "Mark paid anyway").
  const current: PayrollRunWithUser = p ?? run;
  const hasInvoice = !!(current.invoice ?? run.invoice);
  const iq = useInvoiceForRun(run.id, { enabled: hasInvoice });
  // Release 1.3: the same query PayBreakdown below makes (one request). A field person's week under the base-or-commission
  // rule is explained by the breakdown alone; the 1.2 table stays for the plan rules, salaried office weeks and when the
  // breakdown cannot be read.
  const bq = usePayBreakdown(run.userId, run.weekStart, { enabled: !hasInvoice });
  const ruleWeek = !hasInvoice && bq.data?.rule === 'base-or-commission' && !bq.data.salaried;
  const payTable = !hasInvoice && !bq.isLoading && !ruleWeek;
  const unit = payUnit(run);
  const isRecruiter = unit === 'hire';
  const adjustedAt = runAdjustedAt(run) ?? (p ? runAdjustedAt(p) : null);
  // Admin, unpaid runs only: the server attaches `flags` (the payslip's copy is the fresher one).
  const unpaid = run.status === 'pending' || run.status === 'failed';
  const checks = unpaid ? runFlags(p) ?? runFlags(run) : undefined;
  const lines: { label: string; value: number; hint?: string }[] = [
    { label: 'Base pay', value: run.basePay, hint: p ? `${formatNumber(run.daysWorked)} day${run.daysWorked === 1 ? '' : 's'} × ${formatGBP(p.plan.basePerDay, { cents: true })}` : `${formatNumber(run.daysWorked)} days` },
    { label: 'Commission', value: run.commission, hint: p ? `${payUnits(run, run.sales)} × ${formatGBP(p.plan.commissionPerSale, { cents: true })}` : payUnits(run, run.sales) },
    { label: 'Bonus', value: run.bonus, hint: p && p.plan.bonusThreshold > 0 ? `${formatNumber(p.plan.bonusThreshold)}+ ${unit}s unlocks ${formatGBP(p.plan.bonusAmount)}` : undefined },
    { label: 'Overrides', value: run.overrides, hint: p && p.plan.overridePerTeamSale > 0 ? `${formatNumber(run.teamSales)} team sales × ${formatGBP(p.plan.overridePerTeamSale, { cents: true })}` : undefined },
    { label: 'Deductions', value: -run.deductions || 0 },
    // A plan without commission (recruiters) has no commission line to show — the hire count sits in the plan box instead.
  ].filter((l) => !(l.label === 'Commission' && isRecruiter && run.commission === 0 && (!p || p.plan.commissionPerSale === 0)));
  return (
    // overflow-anchor none: the invoice and the actions bar load in above the gauges; the view must stay at the top
    <div className="space-y-5 [overflow-anchor:none]" data-print-root>
      <style>{PRINT_CSS}</style>

      {/* Letterhead — print only. On screen the dialog title carries the same facts. An invoice is its own letterhead. */}
      <header className={clsx('hidden', !hasInvoice && 'print:block')} data-print-keep>
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
          <div className="flex justify-between gap-2 border-b border-border py-1"><dt className="text-muted">Status</dt><dd className="font-medium text-fg">{PAYROLL_STATUS_LABELS[run.status]} · due {formatDate(run.dueDate)}{run.paidDate ? `, paid ${formatDate(run.paidDate)}` : ''}{adjustedAt ? ` · adjusted after payment ${formatDateTime(adjustedAt)}` : ''}</dd></div>
        </dl>
      </header>

      <div ref={topRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 text-sm outline-none print:hidden">
        <PayrollStatusBadge status={current.status} />
        <ErrorBoundary name="invoice-status-modal" fallback={null}><InvoiceStatusBadge run={current} /></ErrorBoundary>
        <OnTimeBadge value={current.onTime} labels={{ yes: 'Paid on time', no: 'Paid late', none: 'Not yet paid' }} />
        {adjustedAt && <Badge tone="warning" title={`Recalculated ${formatDateTime(adjustedAt)} from gauges logged or corrected after the run was paid`}>Adjusted after payment</Badge>}
        <span className="text-muted">Due {formatDate(current.dueDate)}{current.paidDate ? ` · paid ${formatDate(current.paidDate)}` : ''}</span>
        {run.teamName && <Badge tone="neutral">{run.teamName}</Badge>}
      </div>
      {/* Release 1.3 (P2): Accept / Something's wrong, or the office's actions; P9 records the opening. */}
      <ErrorBoundary name="invoice-actions" fallback={null}>
        <InvoiceActionsBar run={current.invoice ? current : run} className="print:hidden" />
      </ErrorBoundary>
      <ErrorBoundary name="payslip-opened" fallback={null}>
        {hasInvoice
          ? iq.data && <RecordOpened entity="invoice" entityId={iq.data.id} what={`invoice ${iq.data.number}`} />
          : <RecordOpened entity="payroll_run" entityId={run.id} what="payslip" />}
      </ErrorBoundary>
      {adjustedAt && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning print:hidden" role="note">
          This payslip was recalculated on {formatDateTime(adjustedAt)}, after it had been paid — gauges logged or corrected late changed the figures below. The difference is settled separately.
        </p>
      )}
      {checks && (
        <section aria-labelledby="payslip-checks" className={clsx('rounded-lg border p-3 print:hidden', warningFlags({ flags: checks }).length ? 'border-warning/40 bg-warning/5' : 'border-border bg-surface-2/60')}>
          <h4 id="payslip-checks" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Checks before paying</h4>
          <PayrollChecksList flags={checks} />
          {checks.length > 0 && <p className="mt-2 text-xs text-muted">Advisory only — you can still mark this run paid.</p>}
        </section>
      )}
      {hasInvoice ? (
        iq.isLoading ? (
          <div className="space-y-3 rounded-xl border border-border p-5"><Skeleton className="h-6 w-48" /><Skeleton /><Skeleton /><Skeleton className="w-2/3" /></div>
        ) : iq.isError ? (
          <ErrorState error={iq.error} onRetry={() => void iq.refetch()} title="Could not load the invoice" />
        ) : iq.data ? (
          <InvoiceDocument invoice={iq.data} mine={iq.data.userId === me.id} />
        ) : null
      ) : !payTable ? null : (
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
              {isRecruiter ? (
                <div className="flex justify-between gap-2"><dt className="text-muted">Hires this week</dt><dd className="tabular-nums">{formatNumber(run.sales)}</dd></div>
              ) : (
                <div className="flex justify-between gap-2"><dt className="text-muted">Commission per sale</dt><dd className="tabular-nums">{formatGBP(p.plan.commissionPerSale, { cents: true })}</dd></div>
              )}
              <div className="flex justify-between gap-2"><dt className="text-muted">Bonus</dt><dd className="tabular-nums">{p.plan.bonusThreshold > 0 ? `${formatGBP(p.plan.bonusAmount)} at ${formatNumber(p.plan.bonusThreshold)} ${unit}s` : '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Override per team sale</dt><dd className="tabular-nums">{p.plan.overridePerTeamSale > 0 ? formatGBP(p.plan.overridePerTeamSale, { cents: true }) : '—'}</dd></div>
              {run.employeeId && <div className="flex justify-between gap-2 border-t border-border pt-1.5"><dt className="text-muted">Employee ID</dt><dd>{run.employeeId}</dd></div>}
            </dl>
          )}
        </div>
      </div>
      )}
      {/* Release 1.3 slot (P1): the week under the base-or-commission rule; nothing until the package lands. An invoice
          prints as the invoice alone, so the breakdown and the gauges stay on screen (print:hidden) for invoiced runs. */}
      <div className={clsx('min-w-0 empty:hidden', hasInvoice && 'print:hidden')}>
        <ErrorBoundary name="pay-breakdown" fallback={null}>
          <PayBreakdown run={run} />
        </ErrorBoundary>
      </div>
      <div className={clsx('min-w-0', hasInvoice && 'print:hidden')}>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">The week's gauges</div>
        <GaugeEntriesTable rows={p?.entries ?? []} loading={q.isLoading} showPerson={false} emptyMessage={isRecruiter ? 'Recruiters do not log gauges' : 'No gauge entries this week'} />
      </div>
      {/* Release 1.2 slot (U3): the run's change history; nothing until the package lands. */}
      <ErrorBoundary name="payslip-history" fallback={null}>
        <EntityHistory entity="payroll_run" entityId={run.id} className="print:hidden" />
      </ErrorBoundary>
    </div>
  );
}
