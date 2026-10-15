import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, PlusCircle, Quote } from 'lucide-react';
import type { DashboardRange } from '@lm/shared';
import { DASHBOARD_RANGE_LABELS, POSITION_LABELS } from '@lm/shared';
import { Button, Card, CardHeader, EmptyState, KpiTile, PageHeader, SegmentedControl, Skeleton } from '@/components/ui';
import { FunnelChart, TrendChart } from '@/components/charts';
import { useDashboard } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { GAUGE_ROLES, hasRole } from '@/auth/RequireRole';
import { Announcements, CompanySection, MiniLeaderboard, UpcomingEvents } from '@/features/dashboard';
import { ChartSkeleton, ErrorState, KpiSkeletons, RatioCell } from '@/features/common';
import { CoachingInsights, LogGaugesModal } from '@/features/gauges';
import { COPY, greetingFor, motivationForDate } from '@/content/copy';
import { formatDate, formatDateShort, formatGBP, formatNumber, formatPct, formatRangeLabel, formatRelative } from '@/lib/format';
import { BENCHMARK_KEYS, RATIO_SHORT_LABELS, ratioTone } from '@/lib/ratios';
import { usePageTitle } from '@/lib/usePageTitle';

const RANGE_ITEMS: { value: DashboardRange; label: string }[] = (['week', 'month', 'quarter'] as DashboardRange[]).map((value) => ({ value, label: DASHBOARD_RANGE_LABELS[value] }));

export function DashboardPage() {
  usePageTitle(COPY.nav.dashboard.title);
  const me = useCurrentUser();
  const [range, setRange] = useState<DashboardRange>('week');
  const [logOpen, setLogOpen] = useState(false);
  const q = useDashboard(range);
  const d = q.data;
  const rangeLabel = useMemo(() => (d ? formatRangeLabel(d.from, d.to) : ''), [d]);
  const canLog = hasRole(me.role, GAUGE_ROLES);

  return (
    <>
      <PageHeader
        title={greetingFor(new Date(), me.firstName)}
        description={`${POSITION_LABELS[me.position]}${me.teamName ? ` · ${me.teamName}` : ''}${rangeLabel ? ` · ${rangeLabel}` : ''}`}
        actions={
          <>
            <SegmentedControl<DashboardRange> aria-label="Period" options={RANGE_ITEMS} value={range} onChange={setRange} />
            {canLog && (
              <Button onClick={() => setLogOpen(true)} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />}>
                Log gauges
              </Button>
            )}
          </>
        }
      />

      <p className="-mt-3 mb-6 flex items-center gap-2 text-sm italic text-muted"><Quote className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />{motivationForDate()}</p>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load your dashboard" />
      ) : (
        <div className="space-y-8">
          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {!d ? (
              <KpiSkeletons count={6} />
            ) : (
              <>
                <KpiTile label="Sales" value={formatNumber(d.personal.totals.sales)} delta={d.personal.deltas.sales} tone="primary" hint={d.personal.rank ? `Ranked #${d.personal.rank} of ${d.personal.rankOutOf}` : `${formatNumber(d.personal.days)} days worked`} />
                <KpiTile label="Conversion" value={formatPct(d.personal.ratios.overallConversion, 1)} delta={d.personal.deltas.conversion} tone={ratioTone('overallConversion', d.personal.ratios.overallConversion)} hint="sales ÷ stops" />
                <KpiTile label="Stops" value={formatNumber(d.personal.totals.stops)} delta={d.personal.deltas.stops} hint={`${formatNumber(d.personal.totals.presentations)} presentations`} />
                <KpiTile label="Earnings to date" value={formatGBP(d.personal.earningsToDate)} hint="gross, this period" />
                <KpiTile label="Next payday" value={d.personal.nextPayday ? formatDateShort(d.personal.nextPayday) : '—'} hint={d.personal.nextPayday ? `${d.personal.nextPayAmount != null ? formatGBP(d.personal.nextPayAmount, { cents: true }) : 'amount pending'} · ${formatRelative(d.personal.nextPayday)}` : 'No pending run'} />
                <KpiTile label="Punctuality" value={d.personal.punctualityRate == null ? '—' : formatPct(d.personal.punctualityRate)} tone={d.personal.punctualityRate == null ? 'default' : d.personal.punctualityRate >= 0.9 ? 'success' : d.personal.punctualityRate >= 0.75 ? 'warning' : 'danger'} hint="check-ins on time" />
              </>
            )}
          </div>

          {/* Personal charts */}
          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader title="Your trend" description="Sales and stops per day" />
              {!d ? <ChartSkeleton /> : d.personal.trend.length ? (
                <TrendChart data={d.personal.trend.map((t) => ({ date: t.date, sales: t.sales, stops: t.stops }))} xKey="date" series={[{ key: 'sales', label: 'Sales' }, { key: 'stops', label: 'Stops' }]} kind="area" xFormatter={formatDateShort} height={240} />
              ) : (
                <EmptyState title="No days logged yet" description="Log your gauges after a shift and your trend will build up here." size="sm" className="border-0" action={canLog ? <Button size="sm" onClick={() => setLogOpen(true)}>Log gauges</Button> : undefined} />
              )}
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader title="Your funnel" description="Against the law of averages" />
              {!d ? <ChartSkeleton /> : (
                <>
                  <FunnelChart totals={d.personal.totals} ratios={d.personal.ratios} showBenchmarks compact />
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {BENCHMARK_KEYS.map((k) => (
                      <span key={k} className="flex items-center gap-1 text-[11px] text-muted">{RATIO_SHORT_LABELS[k]} <RatioCell keyName={k} value={d.personal.ratios[k]} /></span>
                    ))}
                  </div>
                  <CoachingInsights totals={d.personal.totals} ratios={d.personal.ratios} className="mt-3" />
                </>
              )}
            </Card>
          </div>

          {/* Team, events, announcements */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader title={d?.team ? d.team.teamName : 'Team'} description={d?.team ? `${formatNumber(d.team.members)} members · ${formatNumber(d.team.totals.sales)} sales` : undefined} actions={<Link to="/leaderboard" className="flex items-center gap-1 text-xs text-primary hover:underline">Leaderboard <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
              {!d ? (
                <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
              ) : !d.team ? (
                <EmptyState title="You're not in a team yet" size="sm" className="border-0" />
              ) : (
                <>
                  <dl className="mb-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-surface-2 p-2"><dt className="text-[11px] text-muted">Stops</dt><dd className="text-sm font-semibold tabular-nums text-fg">{formatNumber(d.team.totals.stops)}</dd></div>
                    <div className="rounded-lg bg-surface-2 p-2"><dt className="text-[11px] text-muted">Sales</dt><dd className="text-sm font-semibold tabular-nums text-fg">{formatNumber(d.team.totals.sales)}</dd></div>
                    <div className="rounded-lg bg-surface-2 p-2"><dt className="text-[11px] text-muted">Conv.</dt><dd className="text-sm font-semibold tabular-nums text-fg">{formatPct(d.team.ratios.overallConversion, 1)}</dd></div>
                  </dl>
                  <MiniLeaderboard rows={d.team.leaderboard} highlightUserId={me.id} />
                </>
              )}
            </Card>
            <Card>
              <CardHeader title="Upcoming events" actions={<Link to="/events" className="flex items-center gap-1 text-xs text-primary hover:underline">All events <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
              {!d ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : <UpcomingEvents events={d.upcomingEvents} />}
            </Card>
            <Card>
              <CardHeader title="Announcements" />
              {!d ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : <Announcements items={d.announcements} />}
            </Card>
          </div>

          {d?.company && <CompanySection company={d.company} rangeLabel={`${formatDate(d.from)} – ${formatDate(d.to)}`} />}
        </div>
      )}

      {canLog && <LogGaugesModal open={logOpen} onClose={() => setLogOpen(false)} />}
    </>
  );
}
