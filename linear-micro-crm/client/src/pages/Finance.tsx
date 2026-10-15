import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Expense, PayrollRunWithUser } from '@lm/shared';
import { EXPENSE_CATEGORY_LABELS } from '@lm/shared';
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, KpiTile, PageHeader, Tabs, useToast, type Column } from '@/components/ui';
import { DonutChart, TrendChart } from '@/components/charts';
import { useCampaigns, useDeleteExpense, useExpenses, useFinanceSummary, useMyFinance, usePayRun, usePayroll } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ChartSkeleton, ColourChip, ConfirmDialog, ErrorState, KpiSkeletons, RangePicker, StopRowEvents, errorMessage, useRangeState } from '@/features/common';
import { AddExpenseModal, PayrollRunsTable, PayslipModal } from '@/features/finance';
import { todayISO } from '@/lib/dates';
import { formatDate, formatDateShort, formatDecimal, formatGBP, formatNumber, formatPct, formatRangeLabel, formatRelative } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { COPY } from '@/content/copy';

type Tab = 'me' | 'team' | 'company';
const EXPENSE_PAGE = 25;
/** Above this many runs, the to-pay table is grouped by pay week in collapsible sections. */
const GROUP_RUNS_ABOVE = 20;

/** "Next payday" tile: an unpaid run whose due date has passed is overdue, not upcoming. */
function nextPaydayTile(nextPayday: string | null, nextPayAmount: number | null, none: string): { value: string; hint: string; tone: 'default' | 'danger' } {
  if (!nextPayday) return { value: '—', hint: none, tone: 'default' };
  const amount = nextPayAmount != null ? formatGBP(nextPayAmount, { cents: true }) : 'amount pending';
  const overdue = nextPayday < todayISO();
  return { value: formatDateShort(nextPayday), hint: `${amount} · ${overdue ? 'overdue · ' : ''}${formatRelative(nextPayday)}`, tone: overdue ? 'danger' : 'default' };
}

export function FinancePage() {
  usePageTitle(COPY.nav.finance.title);
  const me = useCurrentUser();
  const tabs = useMemo(() => {
    const t: { value: Tab; label: string }[] = [{ value: 'me', label: 'My pay' }];
    if (me.role === 'leader' && me.teamId != null) t.push({ value: 'team', label: 'Team pay' });
    if (me.role === 'admin') t.push({ value: 'company', label: 'Company' });
    return t;
  }, [me.role, me.teamId]);
  const [tab, setTab] = useState<Tab>('me');
  const [payslip, setPayslip] = useState<PayrollRunWithUser | null>(null);

  return (
    <>
      <PageHeader title={COPY.nav.finance.title} description={tab === 'me' ? COPY.nav.finance.description : tab === 'team' ? 'Payroll for your team, week by week.' : 'Revenue, payroll, expenses and profit across the company.'} />
      {tabs.length > 1 && <Tabs items={tabs} value={tab} onChange={(v) => setTab(v as Tab)} className="mb-6" />}
      {tab === 'me' && <MyPay onOpen={setPayslip} />}
      {tab === 'team' && me.teamId != null && <TeamPay teamId={me.teamId} onOpen={setPayslip} />}
      {tab === 'company' && <Company onOpen={setPayslip} />}
      <PayslipModal run={payslip} onClose={() => setPayslip(null)} />
    </>
  );
}

function MyPay({ onOpen }: { onOpen: (r: PayrollRunWithUser) => void }) {
  const q = useMyFinance(12);
  const d = q.data;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const trend = d ? [...d.runs].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map((r) => ({ week: r.weekStart, base: r.basePay, commission: r.commission, bonus: r.bonus, overrides: r.overrides })) : [];
  // Only plot the pay components this person actually earns (a trainee has no overrides, an owner no base).
  const paySeries = ([
    { key: 'base', label: 'Base' },
    { key: 'commission', label: 'Commission' },
    { key: 'bonus', label: 'Bonus' },
    { key: 'overrides', label: 'Overrides' },
  ] as const).filter((s) => trend.some((t) => t[s.key] > 0));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {!d ? <KpiSkeletons count={4} /> : (
          <>
            <KpiTile label="Earned · last 12 weeks" value={formatGBP(d.totals.gross)} tone="primary" hint={`${formatNumber(d.runs.length)} payslips`} />
            <KpiTile label="Commission" value={formatGBP(d.totals.commission)} hint={d.totals.gross ? `${formatPct(d.totals.commission / d.totals.gross)} of gross` : undefined} />
            <KpiTile label="Paid on time" value={d.totals.onTimeRate == null ? '—' : formatPct(d.totals.onTimeRate)} tone={d.totals.onTimeRate == null ? 'default' : d.totals.onTimeRate >= 0.95 ? 'success' : 'warning'} hint="of paid runs" />
            <KpiTile label="Next payday" {...nextPaydayTile(d.nextPayday, d.nextPayAmount, 'Nothing pending')} />
          </>
        )}
      </div>
      <Card>
        <CardHeader title="Earnings" description="Gross pay per week, split by pay component" />
        {!d ? <ChartSkeleton /> : trend.length && paySeries.length ? (
          <TrendChart data={trend} xKey="week" series={[...paySeries]} kind="bar" stacked xFormatter={formatDateShort} yFormatter={(v) => formatGBP(v)} height={240} />
        ) : <EmptyState title={COPY.empty.payroll.title} description={COPY.empty.payroll.description} size="sm" className="border-0" />}
      </Card>
      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="p-5 pb-3"><CardHeader title="Payslips" description="Select a week to see the full breakdown" className="mb-0" /></div>
        <PayrollRunsTable rows={d?.runs ?? []} loading={q.isLoading} onRowClick={onOpen} emptyMessage={`${COPY.empty.payroll.title} — ${COPY.empty.payroll.description}`} bare className="border-t border-border" />
      </Card>
    </div>
  );
}

function TeamPay({ teamId, onOpen }: { teamId: number; onOpen: (r: PayrollRunWithUser) => void }) {
  const [range, setRange] = useRangeState('last_4_weeks');
  const q = usePayroll({ teamId, from: range.from, to: range.to });
  const rows = q.data ?? [];
  const totals = useMemo(() => rows.reduce((a, r) => ({ gross: a.gross + r.gross, commission: a.commission + r.commission, pending: a.pending + (r.status === 'pending' ? r.gross : 0) }), { gross: 0, commission: 0, pending: 0 }), [rows]);
  return (
    <div className="space-y-6">
      <RangePicker value={range} onChange={setRange} presets={['this_week', 'last_week', 'last_4_weeks', 'last_12_weeks', 'this_month']} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {q.isLoading ? <KpiSkeletons count={4} /> : (
              <>
                <KpiTile label="Team payroll" value={formatGBP(totals.gross)} tone="primary" hint={`${formatNumber(rows.length)} runs`} />
                <KpiTile label="Commission" value={formatGBP(totals.commission)} />
                <KpiTile label="Awaiting payment" value={formatGBP(totals.pending)} tone={totals.pending > 0 ? 'warning' : 'default'} />
                <KpiTile label="People paid" value={formatNumber(new Set(rows.map((r) => r.userId)).size)} />
              </>
            )}
          </div>
          <PayrollRunsTable rows={rows} loading={q.isLoading} showUser onRowClick={onOpen} />
        </>
      )}
    </div>
  );
}

/** Runs grouped by pay week, newest week first. */
function groupByWeek(rows: PayrollRunWithUser[]): [string, PayrollRunWithUser[]][] {
  const m = new Map<string, PayrollRunWithUser[]>();
  for (const r of [...rows].sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.userName.localeCompare(b.userName))) {
    const list = m.get(r.weekStart) ?? [];
    list.push(r);
    m.set(r.weekStart, list);
  }
  return [...m.entries()];
}

function Company({ onOpen }: { onOpen: (r: PayrollRunWithUser) => void }) {
  const toast = useToast();
  const [range, setRange] = useRangeState('last_12_weeks');
  const summary = useFinanceSummary({ from: range.from, to: range.to });
  // Everything still to pay: pending runs plus failed transfers (both can be marked paid).
  const pending = usePayroll({ status: 'pending,failed' });
  const [expenseLimit, setExpenseLimit] = useState(EXPENSE_PAGE);
  const expenses = useExpenses({ from: range.from, to: range.to });
  const campaigns = useCampaigns();
  const pay = usePayRun();
  const delExpense = useDeleteExpense();
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [markingId, setMarkingId] = useState<number | null>(null);
  const s = summary.data;
  // The week in progress has no runs yet; the server marks it `estimated` and uses the live pay estimate.
  const hasEstimate = (s?.weeks ?? []).some((w) => w.estimated === true);
  const campaignName = (id: number | null) => (id == null ? null : campaigns.data?.find((c) => c.id === id) ?? null);

  const expenseColumns: Column<Expense>[] = [
    { key: 'date', header: 'Date', render: (e) => <span className="whitespace-nowrap">{formatDate(e.date)}</span>, sortValue: (e) => e.date },
    { key: 'category', header: 'Category', render: (e) => <Badge tone={e.category === 'venue' ? 'primary' : e.category === 'travel' ? 'info' : e.category === 'recruitment' ? 'accent' : 'neutral'}>{EXPENSE_CATEGORY_LABELS[e.category]}</Badge>, sortValue: (e) => e.category },
    { key: 'description', header: 'Description', render: (e) => <span className="text-fg">{e.description}</span>, sortValue: (e) => e.description },
    { key: 'campaign', header: 'Campaign', render: (e) => { const c = campaignName(e.campaignId); return c ? <ColourChip color={c.color} label={c.name} /> : <span className="text-muted">—</span>; }, sortValue: (e) => campaignName(e.campaignId)?.name ?? '' },
    { key: 'amount', header: 'Amount', align: 'right', render: (e) => <span className="font-medium tabular-nums text-fg">{formatGBP(e.amount, { cents: true })}</span>, sortValue: (e) => e.amount },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: (e) => <StopRowEvents className="inline-flex"><Button size="sm" variant="ghost" className="text-danger" aria-label={`Delete expense ${e.description}`} onClick={() => setDeleting(e)}><Trash2 className="h-4 w-4" aria-hidden /></Button></StopRowEvents> },
  ];

  const markPaid = (run: PayrollRunWithUser) => {
    setMarkingId(run.id);
    pay.mutate({ id: run.id }, {
      onSuccess: (r) => toast.success(r.status === 'late' ? 'Marked paid (late)' : 'Marked paid', `${r.userName} · ${formatGBP(r.gross, { cents: true })}`),
      onError: (e) => toast.error('Could not mark as paid', errorMessage(e)),
      onSettled: () => setMarkingId(null),
    });
  };

  return (
    <div className="space-y-6">
      <RangePicker value={range} onChange={setRange} presets={['last_4_weeks', 'last_12_weeks', 'quarter', 'this_month', 'last_month']} />
      {summary.isError ? <ErrorState error={summary.error} onRetry={() => void summary.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {!s ? <KpiSkeletons count={5} /> : (
              <>
                <KpiTile label="Revenue" value={formatGBP(s.totals.revenue)} tone="primary" hint="client payouts" />
                <KpiTile label="Payroll" value={formatGBP(s.totals.payroll)} hint={[s.totals.revenue ? `${formatPct(s.totals.payroll / s.totals.revenue)} of revenue` : null, hasEstimate ? "incl. this week's estimate" : null].filter(Boolean).join(' · ') || undefined} />
                <KpiTile label="Expenses" value={formatGBP(s.totals.expenses)} />
                <KpiTile label="Profit" value={formatGBP(s.totals.profit)} tone={s.totals.profit >= 0 ? 'success' : 'danger'} hint={[s.totals.revenue ? `${formatPct(s.totals.profit / s.totals.revenue)} margin` : null, hasEstimate ? "incl. this week's estimate" : null].filter(Boolean).join(' · ') || undefined} />
                <KpiTile label="Sales" value={formatNumber(s.totals.sales)} hint={s.totals.sales ? `${formatGBP(s.totals.revenue / s.totals.sales)} per sale` : undefined} />
              </>
            )}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader title="Weekly money flow" description={s ? `Revenue against payroll and expenses per pay week (Mon–Sun) · ${formatRangeLabel(s.from, s.to)}` : 'Revenue against payroll and expenses per pay week (Mon–Sun)'} />
              {!s ? <ChartSkeleton /> : s.weeks.length ? (
                <TrendChart data={s.weeks.map((w) => ({ week: w.weekStart, revenue: w.revenue, payroll: w.payroll, expenses: w.expenses }))} xKey="week" series={[{ key: 'revenue', label: 'Revenue' }, { key: 'payroll', label: 'Payroll' }, { key: 'expenses', label: 'Expenses' }]} kind="bar" xFormatter={formatDateShort} yFormatter={(v) => formatGBP(v)} height={260} />
              ) : <EmptyState title="No weeks in range" size="sm" className="border-0" />}
            </Card>
            <Card className="min-w-0">
              <CardHeader title="Payroll punctuality" description={s ? `${formatNumber(s.payroll.runs)} runs · avg ${formatDecimal(s.payroll.avgDaysLate)} days late when late` : undefined} />
              {!s ? <ChartSkeleton height={200} /> : (
                <>
                  <DonutChart data={[{ label: 'Paid on time', value: s.payroll.paid - s.payroll.late, color: 'var(--color-success)' }, { label: 'Paid late', value: s.payroll.late, color: 'var(--color-warning)' }, { label: 'Pending', value: s.payroll.pending, color: 'var(--color-info)' }, { label: 'Failed', value: Math.max(0, s.payroll.runs - s.payroll.paid - s.payroll.pending), color: 'var(--color-danger)' }].filter((d) => d.value > 0)} centerLabel="On time" centerValue={formatPct(s.payroll.onTimeRate)} height={200} />
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1"><dt className="text-muted">Paid</dt><dd className="font-medium text-fg">{formatNumber(s.payroll.paid)}</dd></div>
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1"><dt className="text-muted">Late</dt><dd className="font-medium text-fg">{formatNumber(s.payroll.late)}</dd></div>
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1"><dt className="text-muted">Pending</dt><dd className="font-medium text-fg">{formatNumber(s.payroll.pending)}</dd></div>
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1"><dt className="text-muted">On-time rate</dt><dd className="font-medium text-fg">{formatPct(s.payroll.onTimeRate)}</dd></div>
                  </dl>
                </>
              )}
            </Card>
          </div>
          <Card padded={false} className="min-w-0 overflow-hidden">
            <div className="p-5 pb-3"><CardHeader title="By campaign" description="Sales, revenue, rep commission and margin" className="mb-0" /></div>
            <DataTable
              rows={s?.byCampaign ?? []}
              loading={!s}
              rowKey={(r) => r.campaignId}
              bare className="border-t border-border"
              initialSort={{ key: 'revenue', dir: 'desc' }}
              columns={[
                { key: 'name', header: 'Campaign', render: (r) => <ColourChip color={r.campaignColor} label={r.campaignName} className="font-medium text-fg" />, sortValue: (r) => r.campaignName },
                { key: 'sales', header: 'Sales', align: 'right', render: (r) => formatNumber(r.sales), sortValue: (r) => r.sales },
                { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => <span className="tabular-nums">{formatGBP(r.revenue)}</span>, sortValue: (r) => r.revenue },
                { key: 'commission', header: 'Commission', align: 'right', render: (r) => <span className="tabular-nums">{formatGBP(r.commission)}</span>, sortValue: (r) => r.commission },
                { key: 'margin', header: 'Margin', align: 'right', render: (r) => <span className={`font-medium tabular-nums ${r.margin >= 0 ? 'text-success' : 'text-danger'}`}>{formatGBP(r.margin)}{r.revenue ? <span className="ml-1 text-xs font-normal text-muted">({formatPct(r.margin / r.revenue)})</span> : null}</span>, sortValue: (r) => r.margin },
              ]}
            />
          </Card>
        </>
      )}

      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="p-5 pb-3"><CardHeader title="Runs to pay" description={`Pending and failed runs — mark them paid once the transfer has gone${pending.data?.some((r) => r.status === 'failed') ? ' · failed transfers are flagged' : ''}`} className="mb-0" /></div>
        {pending.isError ? <ErrorState error={pending.error} onRetry={() => void pending.refetch()} className="m-5" /> : (pending.data?.length ?? 0) > GROUP_RUNS_ABOVE ? (
          <div className="divide-y divide-border border-t border-border">
            {groupByWeek(pending.data ?? []).map(([weekStart, runs], i) => (
              <details key={weekStart} open={i === 0} className="group">
                <summary className="focus-ring flex cursor-pointer select-none items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-surface-2/60">
                  <span className="font-medium text-fg">Week {formatRangeLabel(weekStart, runs[0]!.weekEnd)}</span>
                  <span className="text-xs text-muted">{formatNumber(runs.length)} run{runs.length === 1 ? '' : 's'} · {formatGBP(runs.reduce((a, r) => a + r.gross, 0))}{runs.some((r) => r.status === 'failed') ? ` · ${formatNumber(runs.filter((r) => r.status === 'failed').length)} failed` : ''}<span className="ml-2 inline-block transition-transform group-open:rotate-180" aria-hidden>⌄</span></span>
                </summary>
                <PayrollRunsTable rows={runs} showUser onRowClick={onOpen} onMarkPaid={markPaid} markingId={markingId} bare className="border-t border-border" />
              </details>
            ))}
          </div>
        ) : (
          <PayrollRunsTable rows={pending.data ?? []} loading={pending.isLoading} showUser onRowClick={onOpen} onMarkPaid={markPaid} markingId={markingId} emptyMessage="Everyone is paid up" bare className="border-t border-border" />
        )}
      </Card>

      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <CardHeader title="Expenses" description={expenses.data ? `${formatNumber(expenses.data.length)} items · ${formatGBP(expenses.data.reduce((a, e) => a + e.amount, 0))}` : undefined} className="mb-0" />
          <Button size="sm" onClick={() => setAddOpen(true)} leftIcon={<Plus className="h-4 w-4" aria-hidden />}>Add expense</Button>
        </div>
        {expenses.isError ? <ErrorState error={expenses.error} onRetry={() => void expenses.refetch()} className="m-5" /> : (
          <DataTable
            columns={expenseColumns}
            rows={[...(expenses.data ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, expenseLimit)}
            rowKey={(e) => e.id}
            loading={expenses.isLoading}
            emptyMessage="No expenses in this range"
            initialSort={{ key: 'date', dir: 'desc' }}
            bare className="border-t border-border"
            footer={(expenses.data?.length ?? 0) > expenseLimit ? (
              <div className="flex items-center justify-between gap-3 px-5 py-3 text-xs text-muted">
                <span>Showing {formatNumber(expenseLimit)} of {formatNumber(expenses.data?.length ?? 0)} expenses</span>
                <Button size="sm" variant="outline" onClick={() => setExpenseLimit((n) => n + EXPENSE_PAGE)}>Show {formatNumber(Math.min(EXPENSE_PAGE, (expenses.data?.length ?? 0) - expenseLimit))} more</Button>
              </div>
            ) : undefined}
          />
        )}
      </Card>

      <AddExpenseModal open={addOpen} onClose={() => setAddOpen(false)} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this expense?"
        description={deleting ? `${deleting.description} · ${formatGBP(deleting.amount, { cents: true })}` : undefined}
        confirmLabel="Delete"
        tone="danger"
        loading={delExpense.isPending}
        onConfirm={() => deleting && delExpense.mutate(deleting.id, { onSuccess: () => { toast.success('Expense deleted'); setDeleting(null); }, onError: (e) => toast.error('Could not delete expense', errorMessage(e)) })}
      />
    </div>
  );
}
