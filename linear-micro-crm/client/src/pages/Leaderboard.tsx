import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Minus, Sparkles, Trophy } from 'lucide-react';
import type { DashboardRange, LeaderboardRow } from '@lm/shared';
import { DASHBOARD_RANGE_LABELS, POSITION_LABELS } from '@lm/shared';
import { COPY } from '@/content/copy';
import clsx from 'clsx';
import { Avatar, Badge, DataTable, EmptyState, PageHeader, SegmentedControl, Select, Skeleton, type Column } from '@/components/ui';
import { useLeaderboard, useTeams } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, ExportButton } from '@/features/common';
import { StreakFlame } from '@/features/smart/StreakFlame';
import { csvFilename, csvLabel, csvPct, sortRows, type CsvColumn } from '@/lib/csv';
import { formatNumber, formatPct } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

type Metric = 'sales' | 'conversion';
const PERIODS: { value: DashboardRange; label: string }[] = (['week', 'month', 'quarter'] as DashboardRange[]).map((value) => ({ value, label: DASHBOARD_RANGE_LABELS[value] }));
const METRICS: { value: Metric; label: string }[] = [
  { value: 'sales', label: 'Sales' },
  { value: 'conversion', label: 'Conversion' },
];

function Movement({ value }: { value: number | null }) {
  if (value === null) return <Badge tone="info"><Sparkles className="h-3 w-3" aria-hidden />New</Badge>;
  if (value > 0) return <span className="inline-flex items-center gap-0.5 text-xs font-medium text-success"><ArrowUp className="h-3.5 w-3.5" aria-hidden />{value}<span className="sr-only"> places up</span></span>;
  if (value < 0) return <span className="inline-flex items-center gap-0.5 text-xs font-medium text-danger"><ArrowDown className="h-3.5 w-3.5" aria-hidden />{Math.abs(value)}<span className="sr-only"> places down</span></span>;
  return <span className="inline-flex items-center text-xs text-muted"><Minus className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">No change</span></span>;
}

const CSV_COLUMNS: CsvColumn<LeaderboardRow>[] = [
  { key: 'rank', header: 'Rank' },
  { key: 'userName', header: 'Rep' },
  { key: 'position', header: 'Position', format: csvLabel(POSITION_LABELS) },
  { key: 'teamName', header: 'Team' },
  { key: 'sales', header: 'Sales' },
  { key: 'stops', header: 'Stops' },
  { key: 'conversion', header: 'Conversion (sales ÷ stops)', format: csvPct(1) },
  { key: 'days', header: 'Days' },
  { key: 'movement', header: 'Movement (places)', format: (v) => (v == null ? 'New' : String(v)) },
];

const PODIUM_ORDER = [1, 0, 2];
const PODIUM_HEIGHT = ['h-24', 'h-32', 'h-20'];

export function LeaderboardPage() {
  usePageTitle(COPY.nav.leaderboard.title);
  const me = useCurrentUser();
  const [period, setPeriod] = useState<DashboardRange>('week');
  const [metric, setMetric] = useState<Metric>('sales');
  const [teamId, setTeamId] = useState('');
  const teams = useTeams();
  const q = useLeaderboard({ period, metric, teamId: teamId ? Number(teamId) : undefined });
  const rows = q.data ?? [];
  const top3 = rows.slice(0, 3);
  const valueOf = (r: LeaderboardRow) => (metric === 'sales' ? formatNumber(r.sales) : formatPct(r.conversion, 1));

  const columns = useMemo<Column<LeaderboardRow>[]>(
    () => [
      { key: 'rank', header: '#', width: '3rem', align: 'center', render: (r) => <span className={clsx('font-semibold tabular-nums', r.rank <= 3 ? 'text-accent' : 'text-muted')}>{r.rank}</span>, sortValue: (r) => r.rank },
      {
        key: 'name',
        header: 'Rep',
        render: (r) => {
          const isMe = r.userId === me.id;
          return (
            <Link to={`/team/${r.userId}`} className={clsx('flex items-center gap-3 hover:underline', isMe && 'font-semibold text-primary')}>
              <Avatar name={r.userName} color={r.avatarColor} size="sm" />
              <span>
                <span className="flex items-center gap-2 text-fg">{r.userName}{isMe && <Badge tone="primary">You</Badge>}<StreakFlame streak={r.streak} /></span>
                <span className="block text-xs font-normal text-muted">{POSITION_LABELS[r.position]}</span>
              </span>
            </Link>
          );
        },
        sortValue: (r) => r.userName,
      },
      { key: 'team', header: 'Team', render: (r) => (r.teamName ? <Badge tone="neutral" dot color={r.teamColor ?? undefined}>{r.teamName}</Badge> : <span className="text-muted">—</span>), sortValue: (r) => r.teamName ?? '' },
      { key: 'sales', header: 'Sales', align: 'right', render: (r) => <span className={clsx('tabular-nums', metric === 'sales' && 'font-semibold text-fg')}>{formatNumber(r.sales)}</span>, sortValue: (r) => r.sales },
      { key: 'stops', header: 'Stops', align: 'right', render: (r) => <span className="tabular-nums">{formatNumber(r.stops)}</span>, sortValue: (r) => r.stops },
      { key: 'conversion', header: 'Conv.', align: 'right', render: (r) => <span className={clsx('tabular-nums', metric === 'conversion' && 'font-semibold text-fg')}>{formatPct(r.conversion, 1)}</span>, sortValue: (r) => r.conversion },
      { key: 'days', header: 'Days', align: 'right', render: (r) => <span className="tabular-nums">{formatNumber(r.days)}</span>, sortValue: (r) => r.days },
      { key: 'movement', header: 'Move', align: 'center', render: (r) => <Movement value={r.movement} />, sortValue: (r) => r.movement ?? -999 },
    ],
    [me.id, metric],
  );

  const myRow = rows.find((r) => r.userId === me.id);

  return (
    <>
      {/* Only people with a row are ranked (admins/recruiters with no sales just see the board). */}
      <PageHeader title={COPY.nav.leaderboard.title} description={myRow ? `${COPY.nav.leaderboard.description} You're #${myRow.rank} of ${rows.length} this ${period}.` : COPY.nav.leaderboard.description} />

      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<DashboardRange> aria-label="Period" options={PERIODS} value={period} onChange={setPeriod} />
          <SegmentedControl<Metric> aria-label="Metric" options={METRICS} value={metric} onChange={setMetric} />
        </div>
        <div className="flex items-center gap-2 [&>span]:flex-1 lg:[&>span]:flex-none">
          {me.role === 'rep' ? (
            // The server scopes reps to their own team, so a team picker would silently lie.
            <span className="inline-flex items-center gap-2 text-sm text-muted">Team <Badge tone="neutral" dot color={teams.data?.find((t) => t.id === me.teamId)?.color}>{me.teamName ?? 'No team'}</Badge></span>
          ) : (
            <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="All teams" options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} size="sm" className="w-full lg:w-56" />
          )}
          <ExportButton filename={csvFilename(`leaderboard-${period}-${metric}`)} rows={sortRows(rows, (r) => r.rank)} columns={CSV_COLUMNS} disabled={q.isLoading} />
        </div>
      </div>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3"><Skeleton className="h-40" /><Skeleton className="h-48" /><Skeleton className="h-36" /></div>
          <Skeleton className="h-64" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Trophy className="h-8 w-8" aria-hidden />} title="No sales logged yet" description="The board fills up as gauges are logged for this period." />
      ) : (
        <div className="space-y-6">
          {top3.length > 0 && (
            <ol className="grid grid-cols-3 items-end gap-3" aria-label="Podium">
              {PODIUM_ORDER.filter((i) => top3[i]).map((i) => {
                const r = top3[i]!;
                const isMe = r.userId === me.id;
                return (
                  <li key={r.userId} className="flex flex-col items-center gap-2 text-center" style={{ order: PODIUM_ORDER.indexOf(i) }}>
                    <Avatar name={r.userName} color={r.avatarColor} size={i === 0 ? 'xl' : 'lg'} />
                    <Link to={`/team/${r.userId}`} className={clsx('text-sm font-semibold hover:underline', isMe ? 'text-primary' : 'text-fg')}>{r.userName}</Link>
                    {r.teamName && <Badge tone="neutral" dot color={r.teamColor ?? undefined}>{r.teamName}</Badge>}
                    <div className={clsx('flex w-full flex-col items-center justify-start rounded-t-xl border border-b-0 border-border pt-3', PODIUM_HEIGHT[i], i === 0 ? 'bg-accent/15' : 'bg-surface-2')}>
                      <span className={clsx('text-xs font-semibold', i === 0 ? 'text-accent' : 'text-muted')}>#{r.rank}</span>
                      <span className="text-xl font-bold tabular-nums text-fg">{valueOf(r)}</span>
                      <span className="text-[11px] text-muted">{metric === 'sales' ? `${formatPct(r.conversion, 1)} conv.` : `${formatNumber(r.sales)} sales`}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.userId} initialSort={{ key: 'rank', dir: 'asc' }} rowClassName={(r) => (r.userId === me.id ? 'bg-primary/5' : undefined)} caption="Leaderboard" />
        </div>
      )}
    </>
  );
}
