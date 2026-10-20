import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlusCircle, RefreshCw } from 'lucide-react';
import type { GaugeGroupBy, GaugeSummaryRow } from '@lm/shared';
import { BENCHMARK_DANGER_THRESHOLD, BENCHMARK_TOLERANCE } from '@lm/shared';
import { Button, Card, CardHeader, EmptyState, PageHeader, SegmentedControl, Select, Tabs } from '@/components/ui';
import { TrendChart } from '@/components/charts';
import { useEvent, useGaugeSummary, useTeams, useUserPerformance } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ChartSkeleton, ErrorBoundary, ErrorState, ExportButton, RangePicker, useRangeState } from '@/features/common';
import { GaugeSummaryTable, LogGaugesModal, PerformancePanel, gaugeSummaryCsvColumns } from '@/features/gauges';
import { LazyTallyMode, TallyButton, type TallyRequest } from '@/features/gauges/TallyLinks';
import { BulkEntryLink } from '@/features/gauges/BulkEntryLink';
import { idFromParam, useActionParam } from '@/lib/useActionParam';
import { csvFilename, sortRows } from '@/lib/csv';
import { formatDateShort } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { COPY } from '@/content/copy';

type Scope = 'me' | 'team' | 'company';
const GROUP_ITEMS: { value: GaugeGroupBy; label: string }[] = [
  { value: 'user', label: 'By person' },
  { value: 'team', label: 'By team' },
  { value: 'campaign', label: 'By campaign' },
  { value: 'day', label: 'By day' },
  { value: 'week', label: 'By week' },
];

export function GaugesPage() {
  usePageTitle(COPY.nav.gauges.title);
  const me = useCurrentUser();
  const isLeader = me.role === 'leader';
  const isAdmin = me.role === 'admin';
  const [scope, setScope] = useState<Scope>('me');
  const [range, setRange] = useRangeState('this_week');
  const [logOpen, setLogOpen] = useState(false);
  // Deep links (p1): /gauges?log=1[&eventId][&userId] opens Log gauges; /gauges?tally=1[&eventId] opens the tally (p7).
  const [linked, setLinked] = useState<{ eventId: number | null; userId: number | null } | null>(null);
  const [tally, setTally] = useState<TallyRequest | null>(null);
  useActionParam(['log', 'tally', 'eventId', 'userId'], (p) => {
    if (p.log === '1') setLinked({ eventId: idFromParam(p.eventId), userId: idFromParam(p.userId) });
    else if (p.tally === '1') setTally({ eventId: idFromParam(p.eventId) });
  });
  const linkedEvent = useEvent(linked?.eventId);
  // Wait for the linked event before opening (the modal reads its props once, on open). A missing event, or another
  // team's event for a rep / leader, falls back to the normal event picker.
  const linkedReady = linked !== null && (linked.eventId === null || !linkedEvent.isPending);
  const ev = linkedEvent.data && (isAdmin || linkedEvent.data.teamId === me.teamId) ? linkedEvent.data : undefined;
  // `userId` is honoured only for an admin or that team's leader; reps always log for themselves.
  const linkedUserId = linked?.userId != null && ev && (isAdmin || (isLeader && ev.teamId === me.teamId)) ? linked.userId : undefined;

  const tabs = useMemo(() => {
    const items: { value: Scope; label: string }[] = [{ value: 'me', label: 'My performance' }];
    if (isLeader || isAdmin) items.push({ value: 'team', label: 'Team' });
    if (isAdmin) items.push({ value: 'company', label: 'Company' });
    return items;
  }, [isLeader, isAdmin]);

  return (
    <>
      <PageHeader
        title={COPY.nav.gauges.title}
        description={COPY.nav.gauges.description}
        actions={
          <>
            {/* Release 1.2 slot (U2): bulk entry for the team; nothing until the package lands. */}
            {(isLeader || isAdmin) && (
              <ErrorBoundary name="bulk-entry" fallback={null}>
                <BulkEntryLink />
              </ErrorBoundary>
            )}
            {/* p7 slots: a throwing tally never takes the page (and its Log gauges button) down with it. */}
            <ErrorBoundary
              name="tally-button"
              fallback={({ reset }) => (
                <Button variant="outline" onClick={reset} data-error-boundary="tally-button" leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}>Tally · try again</Button>
              )}
            >
              <TallyButton onOpen={() => setTally({ eventId: null })} />
            </ErrorBoundary>
            <Button onClick={() => setLogOpen(true)} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />}>Log gauges</Button>
          </>
        }
      />
      <ErrorBoundary name="tally" title="The tally hit a problem" className="mb-5" resetKeys={[tally]}>
        <LazyTallyMode request={tally} onClose={() => setTally(null)} />
      </ErrorBoundary>
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {tabs.length > 1 ? <Tabs items={tabs} value={scope} onChange={(v) => setScope(v as Scope)} /> : <span />}
        <RangePicker value={range} onChange={setRange} />
      </div>

      {scope === 'me' && <MyPerformance userId={me.id} range={range} />}
      {scope === 'team' && <SummaryView range={range} teamId={isLeader ? me.teamId : undefined} allowTeamPick={isAdmin} defaultGroupBy="user" />}
      {scope === 'company' && <SummaryView range={range} allowTeamPick={false} defaultGroupBy="team" />}

      <LogGaugesModal
        open={logOpen || linkedReady}
        onClose={() => {
          setLogOpen(false);
          setLinked(null);
        }}
        event={linkedReady ? ev : undefined}
        defaultUserId={linkedReady ? linkedUserId : undefined}
      />
    </>
  );
}

function MyPerformance({ userId, range }: { userId: number; range: { from: string; to: string } }) {
  const q = useUserPerformance(userId, { from: range.from, to: range.to });
  // CoachingInsights (p4) and GaugeSummaryTable (p4) render inside the panel; a throw there keeps the page usable.
  return (
    <ErrorBoundary name="my-performance" resetKeys={[range.from, range.to]}>
      <PerformancePanel data={q.data} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} range={range} userId={userId} />
    </ErrorBoundary>
  );
}

function SummaryView({ range, teamId, allowTeamPick, defaultGroupBy }: { range: { from: string; to: string }; teamId?: number | null; allowTeamPick: boolean; defaultGroupBy: GaugeGroupBy }) {
  const navigate = useNavigate();
  const [groupBy, setGroupBy] = useState<GaugeGroupBy>(defaultGroupBy);
  const [pickedTeam, setPickedTeam] = useState<string>('');
  const teams = useTeams();
  const effectiveTeam = allowTeamPick ? (pickedTeam ? Number(pickedTeam) : undefined) : teamId ?? undefined;
  const q = useGaugeSummary({ groupBy, from: range.from, to: range.to, teamId: effectiveTeam });
  const rows = q.data ?? [];
  const isTime = groupBy === 'day' || groupBy === 'week';
  const teamName = effectiveTeam != null ? teams.data?.find((t) => t.id === effectiveTeam)?.name : undefined;
  // Same order as the table's default sort, so the file reads like the screen.
  const exportRows = isTime ? sortRows(rows, (r) => r.key, 'asc') : sortRows(rows, (r) => r.sales, 'desc');

  const onRow = (r: GaugeSummaryRow) => {
    if (groupBy === 'user') navigate(`/team/${r.key}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <SegmentedControl<GaugeGroupBy> aria-label="Group by" size="sm" options={GROUP_ITEMS} value={groupBy} onChange={setGroupBy} className="max-w-full overflow-x-auto" />
        <div className="flex items-center gap-2 [&>span]:flex-1 md:[&>span]:flex-none">
          {allowTeamPick && (
            <Select aria-label="Team" value={pickedTeam} onChange={(e) => setPickedTeam(e.target.value)} placeholder="All teams" options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} size="sm" className="w-full md:w-56" />
          )}
          <ExportButton filename={csvFilename(['gauges-by', groupBy, teamName].filter(Boolean).join('-'), range)} rows={exportRows} columns={gaugeSummaryCsvColumns(groupBy)} disabled={q.isLoading} />
        </div>
      </div>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {isTime && (
            <Card>
              <CardHeader title="Trend" description={groupBy === 'day' ? 'Per day' : 'Per week (w/c Monday)'} />
              {q.isLoading ? <ChartSkeleton /> : rows.length ? (
                <TrendChart data={rows.map((r) => ({ date: r.key, sales: r.sales, stops: r.stops, presentations: r.presentations }))} xKey="date" series={[{ key: 'sales', label: 'Sales' }, { key: 'stops', label: 'Stops' }, { key: 'presentations', label: 'Presentations' }]} kind={groupBy === 'week' ? 'bar' : 'area'} xFormatter={formatDateShort} height={260} />
              ) : (
                <EmptyState title={COPY.empty.gauges.title} description={COPY.empty.gauges.description} size="sm" className="border-0" />
              )}
            </Card>
          )}
          <ErrorBoundary name="gauge-summary" resetKeys={[groupBy, effectiveTeam, range.from, range.to]}>
            <GaugeSummaryTable rows={rows} groupBy={groupBy} loading={q.isLoading} onRowClick={groupBy === 'user' ? onRow : undefined} />
          </ErrorBoundary>
          <p className="text-xs text-muted">Ratio cells are tinted against the law of averages: green within {Math.round(BENCHMARK_TOLERANCE * 100)}% of benchmark or above, amber {Math.round(BENCHMARK_TOLERANCE * 100)}–{Math.round(BENCHMARK_DANGER_THRESHOLD * 100)}% below, red more than {Math.round(BENCHMARK_DANGER_THRESHOLD * 100)}% below.</p>
        </>
      )}
    </div>
  );
}
