import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, CalendarClock, Columns3, List, Search, UserPlus } from 'lucide-react';
import type { CandidateSource, CandidateWithMeta } from '@lm/shared';
import { PIPELINE_STAGES, SOURCE_LABELS, STAGE_LABELS, compareLongestIdle, stageIndex } from '@lm/shared';
import { COPY } from '@/content/copy';
import { Avatar, Button, Card, CardHeader, DataTable, EmptyState, Input, KpiTile, PageHeader, Select, Skeleton, Switch, type Column } from '@/components/ui';
import { BarsChart, TrendChart } from '@/components/charts';
import { useCandidates, useRecruitmentSummary, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ChartSkeleton, ErrorState, ExportButton, KpiSkeletons, RangePicker, SourceBadge, StageBadge, StarRating, StopRowEvents, ViewToggle, useRangeState } from '@/features/common';
import { AddCandidateModal, CandidateCard, IdleBadge, MoveStageControl, candidateCsvColumns, isOverdue } from '@/features/recruitment';
import { buttonLinkClass } from '@/features/recruitment/linkStyles';
import { csvFilename, sortRows } from '@/lib/csv';
import { formatDate, formatDateShort, formatDecimal, formatNumber, formatPct, fullName } from '@/lib/format';
import { optionsFrom } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';

type View = 'board' | 'list';
/**
 * Card / row order. `moved`: most recently moved first (the server's order; the board's default, and the list's when a
 * column sort is cleared). `applied`: newest applicants first (list only, its default). `idle`: longest idle first.
 */
type Order = 'moved' | 'applied' | 'idle';
type SortSpec = { key: string; dir: 'asc' | 'desc' };
/** null = no column sort: rows stay in the server's order (most recently moved first). */
type ListSort = SortSpec | null;

const DEFAULT_LIST_SORT: SortSpec = { key: 'applied', dir: 'desc' };
const IDLE_LIST_SORT: SortSpec = { key: 'idle', dir: 'desc' };

/** "Longest idle first" (shared rule): idle candidates first, furthest past their stage target first; closed last. */
function byLongestIdle(rows: CandidateWithMeta[]): CandidateWithMeta[] {
  const now = new Date();
  return [...rows].sort((a, b) => compareLongestIdle(a, b, now));
}

/** Phones get 40 px filter controls (tap targets); from `sm` up they shrink back to the compact 32 px row. */
const FILTER_CONTROL = 'sm:h-8';

export function RecruitmentPage() {
  usePageTitle(COPY.nav.recruitment.title);
  const me = useCurrentUser();
  const navigate = useNavigate();
  const canWrite = me.role === 'admin' || me.role === 'recruiter' || me.role === 'leader';
  const [range, setRange] = useRangeState('last_12_weeks');
  const [view, setView] = useState<View>('board');
  const [source, setSource] = useState<CandidateSource | ''>('');
  const [ownerId, setOwnerId] = useState('');
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [order, setOrder] = useState<Exclude<Order, 'applied'>>('moved');
  const [listSort, setListSort] = useState<ListSort>(DEFAULT_LIST_SORT);

  const summary = useRecruitmentSummary({ from: range.from, to: range.to });
  const owners = useUsers({});
  const candidates = useCandidates({ source, ownerId: ownerId ? Number(ownerId) : undefined, q: search.trim() || undefined, open: view === 'board' ? true : !showClosed });
  const list = candidates.data ?? [];
  // Hired candidates leave the open pipeline, so the board's Hired column is fed separately: hires made within the selected range.
  const hiredQuery = useCandidates({ stage: 'hired', source, ownerId: ownerId ? Number(ownerId) : undefined, q: search.trim() || undefined }, { enabled: view === 'board' });
  const hiredInRange = useMemo(() => (hiredQuery.data ?? []).filter((c) => { const d = c.stageUpdatedAt.slice(0, 10); return d >= range.from && d <= range.to; }).sort((a, b) => b.stageUpdatedAt.localeCompare(a.stageUpdatedAt)), [hiredQuery.data, range.from, range.to]);
  // The Hired column's Export sits away from the filter bar, so its PDF is told the filters in words (as the list
  // view's PDF reads them beside its button): the column is filtered by source, owner and search too.
  const ownerPicked = ownerId ? (owners.data ?? []).find((u) => String(u.id) === ownerId) : undefined;
  const hiredPdfFilters = [
    ...(source ? [`Source: ${SOURCE_LABELS[source]}`] : []),
    ...(ownerPicked ? [`Owner: ${fullName(ownerPicked)}`] : []),
    ...(search.trim() ? [`Search: “${search.trim()}”`] : []),
  ];

  const byStage = useMemo(() => {
    const m = new Map<string, CandidateWithMeta[]>();
    for (const s of PIPELINE_STAGES) m.set(s, []);
    for (const c of list) m.get(c.stage)?.push(c);
    if (order === 'idle') for (const [stage, items] of m) m.set(stage, byLongestIdle(items));
    return m;
  }, [list, order]);

  const s = summary.data;
  const inInterview = s ? s.openByStage.interview + s.openByStage.observation : 0;
  // Two different cohorts, kept apart on screen: the Hired tile counts stage changes to Hired within the range, while
  // the applied-cohort hire rate (candidates who applied in range and have since been hired) sits with the funnel and
  // by-source chart that use the same cohort.
  const cohortHired = s ? (s.funnel.find((f) => f.stage === 'hired')?.count ?? 0) : 0;
  const cohortRate = s && s.applied ? `${formatNumber(cohortHired)} of the ${formatNumber(s.applied)} who applied in range hired (${formatPct(cohortHired / s.applied)})` : null;

  const columns = useMemo<Column<CandidateWithMeta>[]>(
    () => [
      { key: 'name', header: 'Candidate', render: (c) => <span className="flex items-center gap-2 font-medium text-fg">{isOverdue(c) && <AlertCircle className="h-3.5 w-3.5 text-danger" aria-label="Overdue" />}{fullName(c)}</span>, sortValue: (c) => fullName(c) },
      // The idle badge sits under the stage (no extra column, so the list still fits a 1440 px screen).
      { key: 'stage', header: 'Stage', render: (c) => <span className="flex flex-col items-start gap-1"><StageBadge stage={c.stage} /><IdleBadge candidate={c} /></span>, sortValue: (c) => stageIndex(c.stage) },
      { key: 'source', header: 'Source', render: (c) => <SourceBadge source={c.source} />, sortValue: (c) => c.source },
      { key: 'rating', header: 'Rating', render: (c) => <StarRating value={c.rating} size="sm" />, sortValue: (c) => c.rating ?? 0 },
      { key: 'owner', header: 'Owner', render: (c) => (c.ownerName ? <span className="flex items-center gap-2"><Avatar name={c.ownerName} size="xs" />{c.ownerName}</span> : <span className="text-muted">Unassigned</span>), sortValue: (c) => c.ownerName ?? '' },
      { key: 'applied', header: 'Applied', render: (c) => formatDate(c.appliedAt), sortValue: (c) => c.appliedAt },
      { key: 'days', header: 'Days', align: 'right', render: (c) => formatNumber(c.daysInPipeline), sortValue: (c) => c.daysInPipeline },
      { key: 'next', header: 'Next action', render: (c) => (c.nextAction ? <span className={isOverdue(c) ? 'text-danger' : undefined}>{c.nextAction}{c.nextActionAt ? <span className="block text-xs text-muted">{formatDate(c.nextActionAt)}</span> : null}</span> : <span className="text-muted">—</span>), sortValue: (c) => c.nextActionAt ?? '' },
      ...(canWrite ? [{ key: 'move', header: <span className="sr-only">Move stage</span>, render: (c: CandidateWithMeta) => <StopRowEvents className="w-36"><MoveStageControl candidate={c} compact /></StopRowEvents> }] : []),
    ],
    [canWrite],
  );

  // The list sorts here (controlled), so the order select and the column headers always agree. "Longest idle first" is
  // a sort key of its own (the select's), not a column.
  const sortedList = useMemo(() => {
    if (!listSort) return list;
    if (listSort.key === IDLE_LIST_SORT.key) {
      const idleFirst = byLongestIdle(list);
      return listSort.dir === 'desc' ? idleFirst : idleFirst.reverse();
    }
    const value = columns.find((c) => c.key === listSort.key)?.sortValue;
    return value ? sortRows(list, value, listSort.dir) : list;
  }, [list, listSort, columns]);
  // The select always names the order on screen: a cleared column sort is the server's "recently moved" order, and any
  // other column sort shows "Sorted by column".
  const orderValue: Order | '' =
    view === 'board'
      ? order
      : !listSort
        ? 'moved'
        : listSort.dir !== 'desc'
          ? ''
          : listSort.key === IDLE_LIST_SORT.key
            ? 'idle'
            : listSort.key === DEFAULT_LIST_SORT.key
              ? 'applied'
              : '';
  const changeOrder = (next: Order | '') => {
    if (!next) return;
    // One choice for both views (the board has no "newest applicants" order, so that keeps it on "recently moved").
    setOrder(next === 'idle' ? 'idle' : 'moved');
    setListSort(next === 'idle' ? IDLE_LIST_SORT : next === 'applied' ? DEFAULT_LIST_SORT : null);
  };
  const orderOptions =
    view === 'board'
      ? [{ value: 'moved', label: 'Recently moved first' }, { value: 'idle', label: 'Longest idle first' }]
      : [{ value: 'applied', label: 'Newest applicants first' }, { value: 'moved', label: 'Recently moved first' }, { value: 'idle', label: 'Longest idle first' }];

  // The board scroller is `relative` so absolutely positioned bits inside the cards (select chevrons) are clipped by it
  // instead of widening the whole page on phones.
  return (
    <>
      <PageHeader
        title={COPY.nav.recruitment.title}
        description={COPY.nav.recruitment.description}
        actions={
          <>
            {/* Release 1.3 (P7): every interview by day, with its interviewer. */}
            <Link to="/recruitment/schedule" className={buttonLinkClass('outline')} data-testid="recruitment-schedule-link"><CalendarClock aria-hidden /> Schedule</Link>
            {canWrite && <Button onClick={() => setAddOpen(true)} leftIcon={<UserPlus className="h-4 w-4" aria-hidden />}>Add candidate</Button>}
          </>
        }
      />

      <div className="mb-4"><RangePicker value={range} onChange={setRange} presets={['last_4_weeks', 'last_12_weeks', 'quarter', 'this_month', 'last_month']} /></div>

      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} className="mb-6" />
      ) : (
        <div className="mb-6 space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {!s ? <KpiSkeletons count={5} /> : (
              <>
                <KpiTile label="Applied" value={formatNumber(s.applied)} hint="in range" />
                <KpiTile label="In interview" value={formatNumber(inInterview)} hint="interview + observation" />
                <KpiTile label="Hired" value={formatNumber(s.hired)} tone="success" hint="moved to Hired in range" />
                <KpiTile label="Avg time to hire" value={`${formatDecimal(s.avgTimeToHireDays)} days`} />
                <KpiTile label="Overdue actions" value={formatNumber(s.overdueActions)} tone={s.overdueActions > 0 ? 'danger' : 'default'} hint="open candidates past next action" />
              </>
            )}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader title="Weekly activity" description="Applications, interviews and hires per week" />
              {!s ? <ChartSkeleton /> : s.weekly.length ? (
                <TrendChart data={s.weekly.map((w) => ({ week: w.weekStart, applied: w.applied, interviews: w.interviews, hired: w.hired }))} xKey="week" series={[{ key: 'applied', label: 'Applied' }, { key: 'interviews', label: 'Interviews' }, { key: 'hired', label: 'Hired' }]} kind="bar" xFormatter={formatDateShort} height={240} />
              ) : <EmptyState title="No activity in range" size="sm" className="border-0" />}
            </Card>
            <Card className="min-w-0">
              <CardHeader title="Conversion by source" description={cohortRate ? `Applied → hired · ${cohortRate}` : 'Applied → hired, for candidates who applied in range'} />
              {!s ? <ChartSkeleton /> : s.bySource.length ? (
                <BarsChart
                  data={[...s.bySource].sort((a, b) => b.applied - a.applied).map((b) => ({ label: `${SOURCE_LABELS[b.source]} · ${b.hired}/${b.applied}`, value: b.conversion }))}
                  horizontal
                  label="Hired"
                  valueFormatter={(v) => formatPct(v)}
                  height={240}
                />
              ) : <EmptyState title="No sources yet" size="sm" className="border-0" />}
            </Card>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-[1.3fr_1fr_1fr_1.2fr]">
          <Input aria-label="Search candidates" placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} leftIcon={<Search className="h-4 w-4" aria-hidden />} className={FILTER_CONTROL} />
          <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as CandidateSource | '')} placeholder="All sources" options={optionsFrom(SOURCE_LABELS)} className={FILTER_CONTROL} />
          <Select aria-label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="Any owner" options={(owners.data ?? []).filter((u) => u.role !== 'rep').map((u) => ({ value: String(u.id), label: fullName(u) }))} className={FILTER_CONTROL} />
          <Select
            aria-label="Order"
            value={orderValue}
            onChange={(e) => changeOrder(e.target.value as Order | '')}
            placeholder={orderValue === '' ? 'Sorted by column' : undefined}
            options={orderOptions}
            className={FILTER_CONTROL}
          />
        </div>
        <div className="flex items-center gap-3">
          {view === 'list' && (
            <Switch size="sm" checked={showClosed} onChange={setShowClosed} label={<span className="text-xs text-muted">Include closed</span>} />
          )}
          {view === 'list' && (
            <ExportButton filename={csvFilename(showClosed ? 'candidates-all' : 'candidates-open')} rows={sortRows(list, (c) => c.appliedAt, 'desc')} columns={candidateCsvColumns} disabled={candidates.isLoading} />
          )}
          <ViewToggle value={view} onChange={setView} options={[{ value: 'board', label: 'Board view', icon: <Columns3 className="h-4 w-4" aria-hidden /> }, { value: 'list', label: 'List view', icon: <List className="h-4 w-4" aria-hidden /> }]} />
        </div>
      </div>

      {candidates.isError ? (
        <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
      ) : view === 'board' ? (
        <div className="relative -mx-1 overflow-x-auto px-1 pb-2">
          <div className="grid min-w-[1320px] grid-cols-[repeat(6,minmax(220px,1fr))] gap-3">
            {PIPELINE_STAGES.map((stage) => {
              const isHired = stage === 'hired';
              const items = isHired ? hiredInRange : byStage.get(stage) ?? [];
              const loading = isHired ? hiredQuery.isLoading : candidates.isLoading;
              return (
                <section key={stage} aria-labelledby={`col-${stage}`} className="flex min-h-[200px] flex-col rounded-xl bg-surface-2 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <h3 id={`col-${stage}`} className="text-xs font-semibold uppercase tracking-wide text-muted">{STAGE_LABELS[stage]}</h3>
                    <span className="flex items-center gap-1.5">
                      <span className="rounded-full bg-surface px-1.5 py-0.5 text-[11px] tabular-nums text-fg">{loading ? '…' : isHired ? `${items.length} hired` : items.length}</span>
                      {isHired && <ExportButton size="icon-xs" label="Export hired candidates" filename={csvFilename('hired', range)} rows={items} columns={candidateCsvColumns} disabled={loading} pdfScreenFilters={hiredPdfFilters} />}
                    </span>
                  </div>
                  {isHired && <p className="mb-1 px-1 text-[11px] normal-case text-muted">Hired {formatDateShort(range.from)} – {formatDateShort(range.to)}</p>}
                  {loading ? (
                    <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
                  ) : items.length === 0 ? (
                    <p className="px-1 py-6 text-center text-xs text-muted">Empty</p>
                  ) : (
                    <ul className="space-y-2">{items.map((c) => <CandidateCard key={c.id} candidate={c} canMove={canWrite} />)}</ul>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <DataTable columns={columns} rows={sortedList} sort={listSort} onSortChange={setListSort} rowKey={(c) => c.id} loading={candidates.isLoading} className="min-w-0 max-w-full" onRowClick={(c) => navigate(`/recruitment/${c.id}`)} empty={<EmptyState title={COPY.empty.candidates.title} description={COPY.empty.candidates.description} size="sm" className="border-0" />} />
      )}

      {canWrite && <AddCandidateModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(id) => navigate(`/recruitment/${id}`)} />}
    </>
  );
}
