import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlusCircle } from 'lucide-react';
import type { GaugeGroupBy, GaugeSummaryRow } from '@lm/shared';
import { BENCHMARK_DANGER_THRESHOLD, BENCHMARK_TOLERANCE } from '@lm/shared';
import { Button, Card, CardHeader, EmptyState, PageHeader, SegmentedControl, Select, Tabs } from '@/components/ui';
import { TrendChart } from '@/components/charts';
import { useGaugeSummary, useTeams, useUserPerformance } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ChartSkeleton, ErrorState, ExportButton, RangePicker, useRangeState } from '@/features/common';
import { GaugeSummaryTable, LogGaugesModal, PerformancePanel, gaugeSummaryCsvColumns } from '@/features/gauges';
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
        actions={<Button onClick={() => setLogOpen(true)} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />}>Log gauges</Button>}
      />
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {tabs.length > 1 ? <Tabs items={tabs} value={scope} onChange={(v) => setScope(v as Scope)} /> : <span />}
        <RangePicker value={range} onChange={setRange} />
      </div>

      {scope === 'me' && <MyPerformance userId={me.id} range={range} />}
      {scope === 'team' && <SummaryView range={range} teamId={isLeader ? me.teamId : undefined} allowTeamPick={isAdmin} defaultGroupBy="user" />}
      {scope === 'company' && <SummaryView range={range} allowTeamPick={false} defaultGroupBy="team" />}

      <LogGaugesModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

function MyPerformance({ userId, range }: { userId: number; range: { from: string; to: string } }) {
  const q = useUserPerformance(userId, { from: range.from, to: range.to });
  return <PerformancePanel data={q.data} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} range={range} userId={userId} />;
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
          <GaugeSummaryTable rows={rows} groupBy={groupBy} loading={q.isLoading} onRowClick={groupBy === 'user' ? onRow : undefined} />
          <p className="text-xs text-muted">Ratio cells are tinted against the law of averages: green within {Math.round(BENCHMARK_TOLERANCE * 100)}% of benchmark or above, amber {Math.round(BENCHMARK_TOLERANCE * 100)}–{Math.round(BENCHMARK_DANGER_THRESHOLD * 100)}% below, red more than {Math.round(BENCHMARK_DANGER_THRESHOLD * 100)}% below.</p>
        </>
      )}
    </div>
  );
}
