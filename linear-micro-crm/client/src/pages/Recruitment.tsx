import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Columns3, List, Search, UserPlus } from 'lucide-react';
import type { CandidateSource, CandidateWithMeta } from '@lm/shared';
import { PIPELINE_STAGES, SOURCE_LABELS, STAGE_LABELS, stageIndex } from '@lm/shared';
import { COPY } from '@/content/copy';
import { Avatar, Button, Card, CardHeader, DataTable, EmptyState, Input, KpiTile, PageHeader, Select, Skeleton, Switch, type Column } from '@/components/ui';
import { BarsChart, TrendChart } from '@/components/charts';
import { useCandidates, useRecruitmentSummary, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ChartSkeleton, ErrorState, KpiSkeletons, RangePicker, SourceBadge, StageBadge, StarRating, ViewToggle, useRangeState } from '@/features/common';
import { AddCandidateModal, CandidateCard, MoveStageControl, isOverdue } from '@/features/recruitment';
import { formatDate, formatDateShort, formatDecimal, formatNumber, formatPct, fullName } from '@/lib/format';
import { optionsFrom } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';

type View = 'board' | 'list';

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

  const summary = useRecruitmentSummary({ from: range.from, to: range.to });
  const owners = useUsers({});
  const candidates = useCandidates({ source, ownerId: ownerId ? Number(ownerId) : undefined, q: search.trim() || undefined, open: view === 'board' ? true : !showClosed });
  const list = candidates.data ?? [];

  const byStage = useMemo(() => {
    const m = new Map<string, CandidateWithMeta[]>();
    for (const s of PIPELINE_STAGES) m.set(s, []);
    for (const c of list) m.get(c.stage)?.push(c);
    return m;
  }, [list]);

  const s = summary.data;
  const inInterview = s ? s.openByStage.interview + s.openByStage.observation : 0;

  const columns = useMemo<Column<CandidateWithMeta>[]>(
    () => [
      { key: 'name', header: 'Candidate', render: (c) => <span className="flex items-center gap-2 font-medium text-fg">{isOverdue(c) && <AlertCircle className="h-3.5 w-3.5 text-danger" aria-label="Overdue" />}{fullName(c)}</span>, sortValue: (c) => fullName(c) },
      { key: 'stage', header: 'Stage', render: (c) => <StageBadge stage={c.stage} />, sortValue: (c) => stageIndex(c.stage) },
      { key: 'source', header: 'Source', render: (c) => <SourceBadge source={c.source} />, sortValue: (c) => c.source },
      { key: 'rating', header: 'Rating', render: (c) => <StarRating value={c.rating} size="sm" />, sortValue: (c) => c.rating ?? 0 },
      { key: 'owner', header: 'Owner', render: (c) => (c.ownerName ? <span className="flex items-center gap-2"><Avatar name={c.ownerName} size="xs" />{c.ownerName}</span> : <span className="text-muted">Unassigned</span>), sortValue: (c) => c.ownerName ?? '' },
      { key: 'applied', header: 'Applied', render: (c) => formatDate(c.appliedAt), sortValue: (c) => c.appliedAt },
      { key: 'days', header: 'Days', align: 'right', render: (c) => formatNumber(c.daysInPipeline), sortValue: (c) => c.daysInPipeline },
      { key: 'next', header: 'Next action', render: (c) => (c.nextAction ? <span className={isOverdue(c) ? 'text-danger' : undefined}>{c.nextAction}{c.nextActionAt ? <span className="block text-xs text-muted">{formatDate(c.nextActionAt)}</span> : null}</span> : <span className="text-muted">—</span>), sortValue: (c) => c.nextActionAt ?? '' },
      ...(canWrite ? [{ key: 'move', header: <span className="sr-only">Move stage</span>, render: (c: CandidateWithMeta) => <div className="w-36"><MoveStageControl candidate={c} compact /></div> }] : []),
    ],
    [canWrite],
  );

  return (
    <>
      <PageHeader
        title={COPY.nav.recruitment.title}
        description={COPY.nav.recruitment.description}
        actions={canWrite ? <Button onClick={() => setAddOpen(true)} leftIcon={<UserPlus className="h-4 w-4" aria-hidden />}>Add candidate</Button> : undefined}
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
                <KpiTile label="Hired" value={formatNumber(s.hired)} tone="success" hint={s.applied ? `${formatPct(s.hired / s.applied)} of applied` : undefined} />
                <KpiTile label="Avg time to hire" value={`${formatDecimal(s.avgTimeToHireDays)} days`} />
                <KpiTile label="Overdue actions" value={formatNumber(s.overdueActions)} tone={s.overdueActions > 0 ? 'danger' : 'default'} hint="open candidates past next action" />
              </>
            )}
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Weekly activity" description="Applications, interviews and hires per week" />
              {!s ? <ChartSkeleton /> : s.weekly.length ? (
                <TrendChart data={s.weekly.map((w) => ({ week: w.weekStart, applied: w.applied, interviews: w.interviews, hired: w.hired }))} xKey="week" series={[{ key: 'applied', label: 'Applied' }, { key: 'interviews', label: 'Interviews' }, { key: 'hired', label: 'Hired' }]} kind="bar" xFormatter={formatDateShort} height={240} />
              ) : <EmptyState title="No activity in range" size="sm" className="border-0" />}
            </Card>
            <Card>
              <CardHeader title="Conversion by source" description="Applied → hired" />
              {!s ? <ChartSkeleton /> : s.bySource.length ? (
                <BarsChart data={s.bySource.map((b) => ({ label: SOURCE_LABELS[b.source], value: b.conversion, secondary: b.applied }))} horizontal valueFormatter={(v) => formatPct(v)} secondaryLabel="applied" height={240} />
              ) : <EmptyState title="No sources yet" size="sm" className="border-0" />}
            </Card>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-3">
          <Input aria-label="Search candidates" placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} leftIcon={<Search className="h-4 w-4" aria-hidden />} size="sm" />
          <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as CandidateSource | '')} placeholder="All sources" options={optionsFrom(SOURCE_LABELS)} size="sm" />
          <Select aria-label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="Any owner" options={(owners.data ?? []).filter((u) => u.role !== 'rep').map((u) => ({ value: String(u.id), label: fullName(u) }))} size="sm" />
        </div>
        <div className="flex items-center gap-3">
          {view === 'list' && (
            <Switch size="sm" checked={showClosed} onChange={setShowClosed} label={<span className="text-xs text-muted">Include closed</span>} />
          )}
          <ViewToggle value={view} onChange={setView} options={[{ value: 'board', label: 'Board view', icon: <Columns3 className="h-4 w-4" aria-hidden /> }, { value: 'list', label: 'List view', icon: <List className="h-4 w-4" aria-hidden /> }]} />
        </div>
      </div>

      {candidates.isError ? (
        <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
      ) : view === 'board' ? (
        <div className="-mx-1 overflow-x-auto px-1 pb-2">
          <div className="grid min-w-[900px] grid-cols-6 gap-3">
            {PIPELINE_STAGES.map((stage) => {
              const items = byStage.get(stage) ?? [];
              return (
                <section key={stage} aria-labelledby={`col-${stage}`} className="flex min-h-[200px] flex-col rounded-xl bg-surface-2 p-2">
                  <h3 id={`col-${stage}`} className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                    {STAGE_LABELS[stage]}<span className="rounded-full bg-surface px-1.5 py-0.5 text-[11px] tabular-nums text-fg">{candidates.isLoading ? '…' : items.length}</span>
                  </h3>
                  {candidates.isLoading ? (
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
        <DataTable columns={columns} rows={list} rowKey={(c) => c.id} loading={candidates.isLoading} onRowClick={(c) => navigate(`/recruitment/${c.id}`)} empty={<EmptyState title={COPY.empty.candidates.title} description={COPY.empty.candidates.description} size="sm" className="border-0" />} initialSort={{ key: 'applied', dir: 'desc' }} />
      )}

      {canWrite && <AddCandidateModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(id) => navigate(`/recruitment/${id}`)} />}
    </>
  );
}
