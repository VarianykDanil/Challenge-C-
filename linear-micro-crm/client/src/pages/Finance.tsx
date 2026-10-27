import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, ChevronDown, Info, Plus, Trash2, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { Expense, PayForecast, PayrollRunWithUser } from '@lm/shared';
import { EXPENSE_CATEGORY_LABELS, payMoney } from '@lm/shared';
import { Badge, Button, Card, CardHeader, DataTable, EmptyState, KpiTile, Modal, PageHeader, ProgressBar, Skeleton, Tabs, Tooltip, useToast, type Column } from '@/components/ui';
import { DonutChart, TrendChart, formatGBPCompact } from '@/components/charts';
import { useCampaigns, useDeleteExpense, useExpenses, useFinanceSummary, useMyFinance, usePayRun, usePayroll } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ChartSkeleton, ColourChip, ConfirmDialog, ErrorBoundary, ErrorState, ExportButton, KpiSkeletons, RangePicker, StopRowEvents, errorMessage, useRangeState } from '@/features/common';
import { PayExportButton } from '@/features/office/PayExportButton';
// Release 1.3 slot (P2): disputed self-billing invoices, at the top of Company.
import { DisputesCard } from '@/features/invoices/DisputesCard';
// Release 1.4 (F): Runs to pay → Pay people (the selection comes along).
import { PayFromHubLink } from '@/features/payments';
import { AddExpenseModal, FlaggedRunsList, LazyBulkPayBar, PayrollRunsTable, PayslipModal, campaignFinanceCsvColumns, expenseCsvColumns, financeWeekCsvColumns, payrollRunCsvColumns, payrollRunsRange, useBulkMarkPaid, warningFlags, type PayrollRunSelection } from '@/features/finance';
import { FORECAST_LABEL, bonusLine, forecastMethod, forecastNoRangeReason, forecastRange, forecastRule, ruleLine } from '@/features/smart/weekPayCopy';
// Release 1.3 (P1): the base-or-commission rule — the week's breakdown, bonuses and corrections
import { AdjustmentsCard } from '@/features/pay/AdjustmentsCard';
import { BreakdownBody } from '@/features/pay/PayBreakdown';
import { commissionWeeks } from '@/features/pay/payCopy';
import { usePayBreakdown } from '@/api/pay';
import { csvFilename, sortRows } from '@/lib/csv';
import { todayISO } from '@/lib/dates';
import { formatDate, formatDateShort, formatDecimal, formatGBP, formatNumber, formatPct, formatRangeLabel, formatRelative } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { idFromParam, useActionParam } from '@/lib/useActionParam';
import { financeTabs, openingFinanceTab } from './financeTabs';
import { COPY } from '@/content/copy';
// Release 1.3 (P2): bulk Mark paid skips runs whose invoice is not accepted; the confirm step counts only the rest.
import { bulkConfirmDescription, payableRuns } from '@/features/finance/bulkPay';

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
  const tabs = useMemo(() => financeTabs(me.role, me.teamId), [me.role, me.teamId]);
  // Deep links (p1): /finance?tab=me|team|company picks a tab this person has; #runs (admin) lands on Runs to pay;
  // &run=<id> opens that payslip (the "Check and accept your invoice" item). With no link the owner and office open on
  // Company, everyone else on My pay (pages/financeTabs.ts).
  const location = useLocation();
  const linkTab = (tabParam: string | null, hash: string): Tab | null => {
    if (hash === '#runs' && me.role === 'admin' && (tabParam === null || tabParam === 'company')) return 'company';
    return tabs.find((t) => t.value === tabParam)?.value ?? null;
  };
  const [tab, setTab] = useState<Tab>(() => {
    const q = new URLSearchParams(location.search);
    return openingFinanceTab(me.role, me.teamId, { tab: q.get('tab'), hash: location.hash, run: q.get('run') });
  });
  // Only a link that resolves to Company scrolls (?tab=me#runs opens My pay and must not jump later when Company is
  // opened by hand). On the first render `tab` is the resolved link tab.
  const [scrollToRuns, setScrollToRuns] = useState(() => location.hash === '#runs' && me.role === 'admin' && tab === 'company');
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  useActionParam(['tab', 'run'], (p, hash) => {
    const next = linkTab(p.tab, hash) ?? (p.run ? 'me' : null);
    if (next) setTab(next);
    setScrollToRuns(hash === '#runs' && me.role === 'admin' && next === 'company');
    setOpenRunId(idFromParam(p.run));
  }, { hashes: ['#runs'] });
  const [payslip, setPayslip] = useState<PayrollRunWithUser | null>(null);

  return (
    <>
      <PageHeader title={COPY.nav.finance.title} description={tab === 'me' ? COPY.nav.finance.description : tab === 'team' ? 'Payroll for your team, week by week.' : 'Revenue, payroll, expenses and profit across the company.'} />
      {tabs.length > 1 && <Tabs items={tabs} value={tab} onChange={(v) => setTab(v as Tab)} className="mb-6" />}
      {tab === 'me' && <MyPay onOpen={setPayslip} openRunId={openRunId} onOpened={() => setOpenRunId(null)} />}
      {tab === 'team' && me.teamId != null && <TeamPay teamId={me.teamId} onOpen={setPayslip} />}
      {tab === 'company' && <Company onOpen={setPayslip} scrollToRuns={scrollToRuns} onScrolled={() => setScrollToRuns(false)} />}
      <PayslipModal run={payslip} onClose={() => setPayslip(null)} />
    </>
  );
}

function MyPay({ onOpen, openRunId, onOpened }: { onOpen: (r: PayrollRunWithUser) => void; openRunId?: number | null; onOpened?: () => void }) {
  const me = useCurrentUser();
  const q = useMyFinance(12);
  const d = q.data;
  // a link to one payslip (?run=<id>) opens it once the list has loaded
  useEffect(() => {
    if (openRunId == null || !d) return;
    const run = d.runs.find((r) => r.id === openRunId);
    if (run) onOpen(run);
    onOpened?.();
  }, [openRunId, d, onOpen, onOpened]);
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
            <CommissionTile runs={d.runs} commission={d.totals.commission} gross={d.totals.gross} />
            <KpiTile label="Paid on time" value={d.totals.onTimeRate == null ? '—' : formatPct(d.totals.onTimeRate)} tone={d.totals.onTimeRate == null ? 'default' : d.totals.onTimeRate >= 0.95 ? 'success' : 'warning'} hint="of paid runs" />
            <KpiTile label="Next payday" {...nextPaydayTile(d.nextPayday, d.nextPayAmount, 'Nothing pending')} />
          </>
        )}
      </div>
      {d?.forecast && <ThisWeekSoFar f={d.forecast} />}
      <Card>
        <CardHeader title="Earnings" description="Gross pay per week, split by pay component" />
        {!d ? <ChartSkeleton /> : trend.length && paySeries.length ? (
          <TrendChart data={trend} xKey="week" series={[...paySeries]} kind="bar" stacked xFormatter={formatDateShort} yFormatter={(v) => formatGBP(v)} height={240} />
        ) : <EmptyState title={COPY.empty.payroll.title} description={COPY.empty.payroll.description} size="sm" className="border-0" />}
      </Card>
      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="p-5 pb-3"><CardHeader title="Payslips" description="Select a week to see the full breakdown" className="mb-0" actions={<ExportButton filename={csvFilename('payslips', payrollRunsRange(d?.runs ?? []))} rows={sortRows(d?.runs ?? [], (r) => r.weekStart, 'desc')} columns={payrollRunCsvColumns(false, me.position)} disabled={q.isLoading} />} /></div>
        <PayrollRunsTable rows={d?.runs ?? []} loading={q.isLoading} onRowClick={onOpen} emptyMessage={`${COPY.empty.payroll.title} — ${COPY.empty.payroll.description}`} bare className="border-t border-border" />
      </Card>
    </div>
  );
}

/** Sunday of the Mon–Sun week starting `monday` (ISO dates, calendar arithmetic only). */
function sundayAfter(monday: string): string {
  const d = new Date(`${monday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Smart release 1.1 (p3): "This week so far" — the same estimate as the dashboard strip, with the workings. Reps and
 * leaders only (the server sends forecast: null otherwise). Never the official figure: Friday's payslip is.
 */
function ThisWeekSoFar({ f }: { f: PayForecast }) {
  // The range (a single figure when low = high), or why there is none: the card always says one or the other.
  const note = forecastNoRangeReason(f) ?? `range ${forecastRange(f)}`;
  const bonus = bonusLine(f);
  const showBonus = f.bonusLikelihood !== 'none' && f.bonusThreshold > 0;
  const method = `Based on ${forecastMethod(f)}. ${FORECAST_LABEL}.`;
  // Release 1.3 (P1): weeks from the rule date — base or commission, and how close the commission is to the base
  const rule = forecastRule(f);
  const line = rule ? ruleLine(f) : null;
  const [open, setOpen] = useState(false);
  return (
    <Card data-week-pay-card="">
      <CardHeader
        title={<span className="inline-flex items-center gap-2">This week so far <Badge tone="info" size="sm">Estimate</Badge></span>}
        description={`Week ${formatRangeLabel(f.weekStart, sundayAfter(f.weekStart))} · payslip on ${formatDate(f.payday)}`}
        actions={(
          <Tooltip side="left" content={method}>
            <button type="button" aria-label={`How this estimate works: ${method}`} className="focus-ring -m-2 inline-flex h-10 w-10 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
              <Info className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        )}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:items-end">
        <div className="min-w-0">
          <p className="text-xs text-muted">Likely gross</p>
          <p className="kpi-number text-3xl font-semibold tabular-nums text-fg">about {formatGBP(f.likely)}</p>
          <p className="mt-0.5 text-sm tabular-nums text-muted">{note}</p>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">Logged so far</dt>
            <dd className="font-semibold tabular-nums text-fg">{formatGBP(f.soFar.gross)}</dd>
          </div>
          <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">Days · sales</dt>
            <dd className="font-semibold tabular-nums text-fg">{formatNumber(f.soFar.days)} · {formatNumber(f.soFar.sales)}</dd>
          </div>
          <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">Event days left</dt>
            <dd className="font-semibold tabular-nums text-fg">{formatNumber(f.remainingDays)}</dd>
          </div>
        </dl>
      </div>
      {showBonus && bonus && (
        <div className="mt-4 space-y-1.5">
          <ProgressBar
            value={Math.min(f.soFar.sales, f.bonusThreshold)}
            max={f.bonusThreshold}
            size="sm"
            tone={f.bonusLikelihood === 'reached' ? 'success' : 'primary'}
            label={`${formatNumber(f.soFar.sales)} of ${formatNumber(f.bonusThreshold)} sales for the ${formatGBP(f.bonusAmount)} bonus`}
          />
          <p className={clsx('text-sm', f.bonusLikelihood === 'reached' ? 'font-medium text-success' : 'text-fg')}>{bonus}</p>
        </div>
      )}
      {rule && rule.baseLikely > 0 && (
        <div className="mt-4 space-y-1.5" data-week-pay-rule="">
          <ProgressBar
            value={Math.min(rule.commissionSoFar, rule.baseLikely)}
            max={rule.baseLikely}
            size="sm"
            tone={rule.commissionSoFar >= rule.baseLikely ? 'success' : 'primary'}
            label={`Commission so far ${payMoney(rule.commissionSoFar)}, against a base of ${payMoney(rule.baseLikely)} if you work ${formatNumber(rule.projectedDays)} day${rule.projectedDays === 1 ? '' : 's'}`}
          />
          {line && <p className={clsx('text-sm', rule.commissionSoFar >= rule.baseLikely ? 'font-medium text-success' : 'text-fg')}>{line}</p>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">{FORECAST_LABEL}.</p>
        {rule && <Button size="sm" variant="ghost" className="h-10 sm:h-8" onClick={() => setOpen(true)}>How this week is worked out</Button>}
      </div>
      {rule && <ThisWeekBreakdown open={open} onClose={() => setOpen(false)} weekStart={f.weekStart} />}
    </Card>
  );
}

/** Release 1.3 (P1): the week in progress line by line (the same breakdown a run's payslip shows). */
function ThisWeekBreakdown({ open, onClose, weekStart }: { open: boolean; onClose: () => void; weekStart: string }) {
  const me = useCurrentUser();
  const q = usePayBreakdown(me.id, weekStart, { enabled: open });
  return (
    <Modal open={open} onClose={onClose} title="This week so far" description={`Week ${formatRangeLabel(weekStart, sundayAfter(weekStart))} · an estimate until the week closes`} size="lg">
      {q.data ? <BreakdownBody b={q.data} /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <div className="space-y-2" aria-busy><Skeleton className="h-4 w-48" /><Skeleton className="h-20" /></div>
      )}
    </Modal>
  );
}

/**
 * Release 1.3 (P1): the commission tile. Weeks paid by the base-or-commission rule pay one or the other, so the tile
 * counts the weeks the commission beat the base; with only 1.2 runs it keeps the commission total.
 */
function CommissionTile({ runs, commission, gross, team }: { runs: PayrollRunWithUser[]; commission: number; gross: number; team?: boolean }) {
  const weeks = commissionWeeks(runs);
  if (!weeks) return <KpiTile label="Commission" value={formatGBP(commission)} hint={!team && gross ? `${formatPct(commission / gross)} of gross` : undefined} />;
  return (
    <KpiTile
      label={team ? 'Paid as commission' : 'Commission weeks'}
      value={`${formatNumber(weeks.commission)} of ${formatNumber(weeks.rule)}`}
      hint={`${formatGBP(commission)} · beat the base`}
    />
  );
}

function TeamPay({ teamId, onOpen }: { teamId: number; onOpen: (r: PayrollRunWithUser) => void }) {
  const [range, setRange] = useRangeState('last_4_weeks');
  const q = usePayroll({ teamId, from: range.from, to: range.to });
  const rows = q.data ?? [];
  // "Awaiting payment" is everything still owed: pending runs and failed transfers (both can still be marked paid).
  const totals = useMemo(
    () => rows.reduce((a, r) => ({ gross: a.gross + r.gross, commission: a.commission + r.commission, pending: a.pending + (r.status === 'pending' || r.status === 'failed' ? r.gross : 0), failed: a.failed + (r.status === 'failed' ? 1 : 0) }), { gross: 0, commission: 0, pending: 0, failed: 0 }),
    [rows],
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker value={range} onChange={setRange} presets={['this_week', 'last_week', 'last_4_weeks', 'last_12_weeks', 'this_month']} />
        <ExportButton filename={csvFilename('team-pay', range)} rows={sortRows(rows, (r) => r.weekStart, 'desc')} columns={payrollRunCsvColumns(true)} disabled={q.isLoading} />
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {q.isLoading ? <KpiSkeletons count={4} /> : (
              <>
                <KpiTile label="Team payroll" value={formatGBP(totals.gross)} tone="primary" hint={`${formatNumber(rows.length)} runs`} />
                <CommissionTile runs={rows} commission={totals.commission} gross={totals.gross} team />
                <KpiTile label="Awaiting payment" value={formatGBP(totals.pending)} tone={totals.pending > 0 ? 'warning' : 'default'} hint={totals.failed > 0 ? `incl. ${formatNumber(totals.failed)} failed transfer${totals.failed === 1 ? '' : 's'}` : 'pending and failed runs'} />
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

function Company({ onOpen, scrollToRuns = false, onScrolled }: { onOpen: (r: PayrollRunWithUser) => void; scrollToRuns?: boolean; onScrolled?: () => void }) {
  const toast = useToast();
  const [range, setRange] = useRangeState('last_12_weeks');
  const summary = useFinanceSummary({ from: range.from, to: range.to });
  // Everything still to pay: pending runs (last 12 weeks) plus failed transfers of any age (both can be marked paid).
  const pending = usePayroll({ status: 'pending,failed' });
  const [expenseLimit, setExpenseLimit] = useState(EXPENSE_PAGE);
  // The expenses table is sorted here (whole range) and only then paged, so "Amount ↓" really shows the biggest costs.
  const [expenseSort, setExpenseSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>({ key: 'date', dir: 'desc' });
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

  // #runs deep link: once the cards above have their data (so nothing shifts afterwards), bring Runs to pay into view.
  const settled = !summary.isLoading && !pending.isLoading && !expenses.isLoading;
  useEffect(() => {
    if (!scrollToRuns || !settled) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById('runs')?.scrollIntoView({ block: 'start' });
      onScrolled?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollToRuns, settled, onScrolled]);

  const expenseColumns: Column<Expense>[] = [
    { key: 'date', header: 'Date', sortWords: ['oldest first', 'newest first'], render: (e) => <span className="whitespace-nowrap">{formatDate(e.date)}</span>, sortValue: (e) => e.date },
    { key: 'category', header: 'Category', render: (e) => <Badge tone={e.category === 'venue' ? 'primary' : e.category === 'travel' ? 'info' : e.category === 'recruitment' ? 'accent' : 'neutral'}>{EXPENSE_CATEGORY_LABELS[e.category]}</Badge>, sortValue: (e) => e.category },
    { key: 'description', header: 'Description', card: 'title', render: (e) => <span className="text-fg">{e.description}</span>, sortValue: (e) => e.description },
    { key: 'campaign', header: 'Campaign', render: (e) => { const c = campaignName(e.campaignId); return c ? <ColourChip color={c.color} label={c.name} /> : <span className="text-muted">—</span>; }, sortValue: (e) => campaignName(e.campaignId)?.name ?? '' },
    { key: 'amount', header: 'Amount', card: 'aside', align: 'right', render: (e) => <span className="font-medium tabular-nums text-fg">{formatGBP(e.amount, { cents: true })}</span>, sortValue: (e) => e.amount },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: (e) => <StopRowEvents className="inline-flex"><Button size="sm" variant="ghost" className="text-danger" aria-label={`Delete expense ${e.description}`} onClick={() => setDeleting(e)}><Trash2 className="h-4 w-4" aria-hidden /></Button></StopRowEvents> },
  ];

  // Newest first by default; a column sort reorders the full set (stable, so same-date rows keep the default order).
  const sortedExpenses = (() => {
    const byDate = [...(expenses.data ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const col = expenseSort ? expenseColumns.find((c) => c.key === expenseSort.key) : undefined;
    return col?.sortValue && expenseSort ? sortRows(byDate, col.sortValue, expenseSort.dir) : byDate;
  })();

  const markPaid = (run: PayrollRunWithUser) => {
    setMarkingId(run.id);
    pay.mutate({ id: run.id }, {
      onSuccess: (r) => toast.success(r.status === 'late' ? 'Marked paid (late)' : 'Marked paid', `${r.userName} · ${formatGBP(r.gross, { cents: true })}`),
      onError: (e) => toast.error('Could not mark as paid', errorMessage(e)),
      onSettled: () => setMarkingId(null),
    });
  };

  // ── Smart release 1.1 (p3): advisory checks and bulk "Mark paid" ──
  const today = todayISO();
  const toPay = useMemo(() => pending.data ?? [], [pending.data]);
  const bulk = useBulkMarkPaid();
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [includeFailed, setIncludeFailed] = useState(false);
  const [paidDate, setPaidDate] = useState(today);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmRun, setConfirmRun] = useState<PayrollRunWithUser | null>(null);
  /** Week groups the admin opened or closed; null = the default (newest week open). */
  const [openWeeks, setOpenWeeks] = useState<ReadonlySet<string> | null>(null);
  // Failed transfers join a bulk selection only after the explicit "Include failed transfers" tick.
  const canSelect = useCallback((r: PayrollRunWithUser) => r.status === 'pending' || (includeFailed && r.status === 'failed'), [includeFailed]);
  const selectedRuns = useMemo(() => toPay.filter((r) => selected.has(r.id) && canSelect(r)), [toPay, selected, canSelect]);
  const flaggedRuns = useMemo(() => toPay.filter((r) => warningFlags(r).length > 0), [toPay]);
  const failedCount = toPay.filter((r) => r.status === 'failed').length;
  // Release 1.3 (P2): runs whose invoice is not accepted are skipped, so the confirm step counts and lists only the rest
  const payableSelected = payableRuns(selectedRuns);
  const flaggedSelected = payableSelected.filter((r) => warningFlags(r).length > 0);
  // Drop ids that left the list (paid elsewhere, refetched) or became unselectable (failed tick cleared).
  useEffect(() => {
    setSelected((prev) => {
      const keep = new Set([...prev].filter((id) => toPay.some((r) => r.id === id && canSelect(r))));
      return keep.size === prev.size ? prev : keep;
    });
  }, [toPay, canSelect]);
  const changeSelection = useCallback((runs: PayrollRunWithUser[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of runs) if (checked) next.add(r.id); else next.delete(r.id);
      return next;
    });
  }, []);
  const selection: PayrollRunSelection = {
    selected,
    canSelect: (r) => !bulk.busy && canSelect(r),
    onChange: changeSelection,
    disabledReason: (r) => (r.status === 'failed' && !includeFailed ? 'tick "Include failed transfers" first' : bulk.busy ? 'marking paid' : undefined),
  };
  const toggleWeek = (weekStart: string, open: boolean, defaults: string[]) => setOpenWeeks((prev) => {
    const next = new Set(prev ?? defaults);
    if (open) next.add(weekStart); else next.delete(weekStart);
    return next;
  });
  /** "Mark week paid": selects the week's pending runs (plus failed ones once ticked) and opens the group. */
  const selectWeek = (weekStart: string, runs: PayrollRunWithUser[], defaults: string[]) => {
    const pick = runs.filter(canSelect);
    const all = pick.length > 0 && pick.every((r) => selected.has(r.id));
    changeSelection(pick, !all);
    if (!all) toggleWeek(weekStart, true, defaults);
  };
  /** A single Mark paid on a run with warning checks asks first (advisory: it never blocks). */
  // Never while a bulk batch is running: the run may be later in the batch, and the race would report it as skipped.
  const requestMarkPaid = (run: PayrollRunWithUser) => {
    if (bulk.busy) return;
    if (warningFlags(run).length) setConfirmRun(run);
    else markPaid(run);
  };
  const payNow = async () => {
    setConfirmBulk(false);
    const batch = [...selectedRuns].sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.userName.localeCompare(b.userName));
    // The server defaults to today; only send the date when the admin picked another one.
    const outcome = await bulk.markPaid(batch, paidDate === today ? undefined : paidDate);
    // Runs that did not go through stay selected so they can be retried.
    setSelected(new Set(outcome.failed.map((f) => f.run.id)));
  };
  const requestBulkPay = () => (flaggedSelected.length ? setConfirmBulk(true) : void payNow());
  const runsTableProps = { showUser: true, onRowClick: onOpen, onMarkPaid: requestMarkPaid, markingId, markPaidDisabled: bulk.busy, selection } as const;

  return (
    <div className="space-y-6">
      {/* Release 1.3 slot (P2): nothing until the package lands. */}
      <ErrorBoundary name="invoice-disputes" fallback={null}><DisputesCard /></ErrorBoundary>
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
              <CardHeader title="Weekly money flow" description={s ? `Revenue against payroll and expenses per pay week (Mon–Sun) · ${formatRangeLabel(s.from, s.to)}` : 'Revenue against payroll and expenses per pay week (Mon–Sun)'} actions={<ExportButton filename={csvFilename('weekly-money-flow', range)} rows={sortRows(s?.weeks ?? [], (w) => w.weekStart)} columns={financeWeekCsvColumns} disabled={!s} />} />
              {!s ? <ChartSkeleton /> : s.weeks.length ? (
                <TrendChart data={s.weeks.map((w) => ({ week: w.weekStart, revenue: w.revenue, payroll: w.payroll, expenses: w.expenses }))} xKey="week" series={[{ key: 'revenue', label: 'Revenue' }, { key: 'payroll', label: 'Payroll' }, { key: 'expenses', label: 'Expenses' }]} kind="bar" xFormatter={formatDateShort} yFormatter={(v) => formatGBP(v)} yTickFormatter={formatGBPCompact} height={260} />
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
            <div className="p-5 pb-3"><CardHeader title="By campaign" description="Sales, revenue, commission at each campaign's rate per sub, and margin" className="mb-0" actions={<ExportButton filename={csvFilename('finance-by-campaign', range)} rows={sortRows(s?.byCampaign ?? [], (r) => r.revenue, 'desc')} columns={campaignFinanceCsvColumns} disabled={!s} />} /></div>
            <DataTable
              rows={s?.byCampaign ?? []}
              loading={!s}
              rowKey={(r) => r.campaignId}
              bare className="border-t border-border"
              initialSort={{ key: 'revenue', dir: 'desc' }}
              columns={[
                { key: 'name', header: 'Campaign', render: (r) => <ColourChip color={r.campaignColor} label={r.campaignName} className="font-medium text-fg" />, sortValue: (r) => r.campaignName },
                { key: 'sales', header: 'Sales', align: 'right', render: (r) => formatNumber(r.sales), sortValue: (r) => r.sales },
                { key: 'revenue', header: 'Revenue', card: 'aside', align: 'right', render: (r) => <span className="tabular-nums">{formatGBP(r.revenue)}</span>, sortValue: (r) => r.revenue },
                { key: 'commission', header: 'Commission', align: 'right', render: (r) => <span className="tabular-nums">{formatGBP(r.commission)}</span>, sortValue: (r) => r.commission },
                { key: 'margin', header: 'Margin', align: 'right', render: (r) => <span className={`font-medium tabular-nums ${r.margin >= 0 ? 'text-success' : 'text-danger'}`}>{formatGBP(r.margin)}{r.revenue ? <span className="ml-1 text-xs font-normal text-muted">({formatPct(r.margin / r.revenue)})</span> : null}</span>, sortValue: (r) => r.margin },
              ]}
            />
          </Card>
        </>
      )}

      <Card id="runs" padded={false} className="min-w-0 scroll-mt-20 overflow-clip">
        <div className="p-5 pb-3">
          <CardHeader
            title="Runs to pay"
            description={(
              <>
                {flaggedRuns.length > 0 && (
                  <span className="mb-0.5 flex items-center gap-1.5 text-sm font-medium text-warning" data-runs-need-a-look="">
                    <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
                    {flaggedRuns.length === 1 ? '1 run needs a look' : `${formatNumber(flaggedRuns.length)} runs need a look`}
                  </span>
                )}
                Pending runs of the last 12 weeks and failed transfers from any week — mark them paid once the transfer has gone{failedCount > 0 ? ' · failed transfers are flagged' : ''}
              </>
            )}
            className="mb-0"
            actions={
              <>
                {/* Release 1.2 slot (U5): export for Xero / Sage; nothing until the package lands. */}
                <ErrorBoundary name="pay-export" fallback={null}>
                  <PayExportButton runs={toPay} />
                </ErrorBoundary>
                <ExportButton filename={csvFilename('runs-to-pay')} rows={sortRows(toPay, (r) => r.weekStart, 'desc')} columns={payrollRunCsvColumns(true)} disabled={pending.isLoading} />
                <PayFromHubLink runIds={payableSelected.map((r) => r.id)} />
              </>
            }
          />
          {failedCount > 0 && (
            <label className="mt-2 inline-flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-fg">
              <input
                type="checkbox"
                className="focus-ring h-4 w-4 cursor-pointer rounded border-control-border accent-[var(--color-primary)]"
                checked={includeFailed}
                disabled={bulk.busy}
                onChange={(e) => setIncludeFailed(e.target.checked)}
              />
              Include failed transfers ({formatNumber(failedCount)})
            </label>
          )}
        </div>
        {pending.isError ? <ErrorState error={pending.error} onRetry={() => void pending.refetch()} className="m-5" /> : toPay.length > GROUP_RUNS_ABOVE ? (
          <div className="divide-y divide-border border-t border-border">
            {(() => {
              const groups = groupByWeek(toPay);
              const defaults = groups.length ? [groups[0]![0]] : [];
              return groups.map(([weekStart, runs]) => {
                const open = (openWeeks ?? new Set(defaults)).has(weekStart);
                const pick = runs.filter(canSelect);
                const picked = pick.length > 0 && pick.every((r) => selected.has(r.id));
                const failed = runs.filter((r) => r.status === 'failed').length;
                const toCheck = runs.filter((r) => warningFlags(r).length > 0).length;
                const label = formatRangeLabel(weekStart, runs[0]!.weekEnd);
                return (
                  <section key={weekStart} aria-label={`Week ${label}`}>
                    <div className="flex items-center gap-2 pr-3 hover:bg-surface-2/60 sm:pr-5">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={`runs-week-${weekStart}`}
                        onClick={() => toggleWeek(weekStart, !open, defaults)}
                        className="focus-ring-inset flex min-h-12 min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-3 pl-5 text-left text-sm"
                      >
                        <span className="font-medium text-fg">Week {label}</span>
                        <span className="flex items-center text-xs text-muted">
                          {/* One text item, so it wraps as a sentence beside the chevron (pence, as in the bar). */}
                          <span>
                            {formatNumber(runs.length)} run{runs.length === 1 ? '' : 's'} · <span className="tabular-nums">{formatGBP(runs.reduce((a, r) => a + r.gross, 0), { cents: true })}</span>
                            {failed > 0 ? ` · ${formatNumber(failed)} failed` : ''}
                            {toCheck > 0 ? ` · ${formatNumber(toCheck)} to check` : ''}
                          </span>
                          <ChevronDown className={clsx('ml-1.5 h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
                        </span>
                      </button>
                      <Button
                        size="sm"
                        variant={picked ? 'soft' : 'outline'}
                        className="h-10 shrink-0 sm:h-8"
                        aria-pressed={picked}
                        disabled={!pick.length || bulk.busy}
                        title={pick.length ? 'Selects this week\'s pending runs; confirm in the bar below' : failed > 0 && !includeFailed ? 'Tick "Include failed transfers" to select failed transfers' : 'Nothing in this week can be selected'}
                        leftIcon={picked ? <Check className="h-4 w-4" aria-hidden /> : undefined}
                        onClick={() => selectWeek(weekStart, runs, defaults)}
                      >
                        Mark week paid
                      </Button>
                    </div>
                    {open && (
                      <div id={`runs-week-${weekStart}`}>
                        <PayrollRunsTable rows={runs} {...runsTableProps} hideWeek bare className="border-t border-border" />
                      </div>
                    )}
                  </section>
                );
              });
            })()}
          </div>
        ) : (
          <PayrollRunsTable rows={toPay} loading={pending.isLoading} {...runsTableProps} emptyMessage="Everyone is paid up" bare className="border-t border-border" />
        )}
        <LazyBulkPayBar
          runs={selectedRuns}
          flagged={flaggedSelected.length}
          paidDate={paidDate}
          onPaidDateChange={setPaidDate}
          today={today}
          progress={bulk.progress}
          onPay={requestBulkPay}
          onClear={() => setSelected(new Set())}
        />
      </Card>
      {/* Release 1.3 (P1): Matt's bonuses, manual lines and the statements' corrections on recent weeks */}
      <ErrorBoundary name="pay-adjustments" fallback={null}><AdjustmentsCard /></ErrorBoundary>
      <ConfirmDialog
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        title={flaggedSelected.length === 1 ? '1 selected run needs a look' : `${formatNumber(flaggedSelected.length)} selected runs need a look`}
        description={bulkConfirmDescription(selectedRuns.length, payableSelected.length)}
        confirmLabel={`Mark ${formatNumber(payableSelected.length)} paid`}
        onConfirm={() => void payNow()}
      >
        <FlaggedRunsList runs={flaggedSelected} />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!confirmRun}
        onClose={() => setConfirmRun(null)}
        title="This run needs a look"
        description={confirmRun ? `${confirmRun.userName} · week ${formatRangeLabel(confirmRun.weekStart, confirmRun.weekEnd)} · ${formatGBP(confirmRun.gross, { cents: true })}. Advisory only — you can still mark it paid.` : undefined}
        confirmLabel="Mark paid"
        onConfirm={() => { if (confirmRun) markPaid(confirmRun); setConfirmRun(null); }}
      >
        {confirmRun && <FlaggedRunsList runs={[confirmRun]} hideHeading />}
      </ConfirmDialog>

      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <CardHeader title="Expenses" description={expenses.data ? `${formatNumber(expenses.data.length)} items · ${formatGBP(expenses.data.reduce((a, e) => a + e.amount, 0))}` : undefined} className="mb-0" />
          <div className="flex shrink-0 items-center gap-2">
            {/* Every expense in the range, not only the page shown — the card's count/total describe the same set. */}
            <ExportButton filename={csvFilename('expenses', range)} rows={sortedExpenses} columns={expenseCsvColumns((id) => campaignName(id)?.name ?? null)} disabled={expenses.isLoading} />
            <Button size="sm" onClick={() => setAddOpen(true)} leftIcon={<Plus className="h-4 w-4" aria-hidden />}>Add expense</Button>
          </div>
        </div>
        {expenses.isError ? <ErrorState error={expenses.error} onRetry={() => void expenses.refetch()} className="m-5" /> : (
          <DataTable
            columns={expenseColumns}
            rows={sortedExpenses.slice(0, expenseLimit)}
            rowKey={(e) => e.id}
            loading={expenses.isLoading}
            emptyMessage="No expenses in this range"
            sort={expenseSort}
            onSortChange={setExpenseSort}
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
