import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Megaphone, PlusCircle, Quote } from 'lucide-react';
import type { DashboardRange } from '@lm/shared';
import { DASHBOARD_RANGE_LABELS, POSITION_LABELS } from '@lm/shared';
import { Button, Card, CardHeader, EmptyState, KpiTile, PageHeader, SegmentedControl, Skeleton } from '@/components/ui';
import { FunnelChart, TrendChart } from '@/components/charts';
import { useDashboard, useLeaderboard } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { GAUGE_ROLES, hasRole } from '@/auth/RequireRole';
import { Announcements, CompanySection, MiniLeaderboard, NewAnnouncementModal, RecruiterSection, UpcomingEvents } from '@/features/dashboard';
import { ChartSkeleton, ErrorState, KpiSkeletons } from '@/features/common';
import { CoachingInsights, LogGaugesModal } from '@/features/gauges';
import { COPY, greetingFor, motivationForDate } from '@/content/copy';
import { todayISO } from '@/lib/dates';
import { formatDate, formatDateShort, formatGBP, formatNumber, formatPct, formatRangeLabel, formatRelative } from '@/lib/format';
import { ratioTone } from '@/lib/ratios';
import { usePageTitle } from '@/lib/usePageTitle';

const RANGE_ITEMS: { value: DashboardRange; label: string }[] = (['week', 'month', 'quarter'] as DashboardRange[]).map((value) => ({ value, label: DASHBOARD_RANGE_LABELS[value] }));

export function DashboardPage() {
  usePageTitle(COPY.nav.dashboard.title);
  const me = useCurrentUser();
  const [range, setRange] = useState<DashboardRange>('week');
  const [logOpen, setLogOpen] = useState(false);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const canAnnounce = me.role === 'admin' || me.role === 'leader';
  const q = useDashboard(range);
  const d = q.data;
  const rangeLabel = useMemo(() => (d ? formatRangeLabel(d.from, d.to) : ''), [d]);
  // Deltas compare with the same to-date span of the previous period (server `previous`), e.g. "vs 5 Oct – 8 Oct".
  const deltaLabel = d?.previous ? `vs ${formatDateShort(d.previous.from)} – ${formatDateShort(d.previous.to)}` : undefined;
  // Recruiters run the pipeline, not a pitch: their dashboard leads with recruitment instead of gauges.
  const recruiterFirst = me.role === 'recruiter';
  const canLog = hasRole(me.role, GAUGE_ROLES);
  // Owners/admins run the business rather than a pitch: lead with the company view.
  const companyFirst = me.role === 'admin';
  // People without a team (owner, office, recruiters) see the company-wide top performers instead of a team card.
  const companyBoard = useLeaderboard({ period: range, metric: 'sales' });

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
          {companyFirst && d?.company && <CompanySection company={d.company} rangeLabel={`${formatDate(d.from)} – ${formatDate(d.to)}`} />}

          {companyFirst && (
            <div>
              <h2 className="text-lg font-semibold text-fg">Your activity</h2>
              <p className="text-sm text-muted">Days you worked in the field yourself{rangeLabel ? ` · ${rangeLabel}` : ''}</p>
            </div>
          )}

          {recruiterFirst && <RecruiterSection range={range} />}

          {/* KPI tiles */}
          {!recruiterFirst && <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {!d ? (
              <KpiSkeletons count={6} />
            ) : (
              <>
                <KpiTile label="Sales" value={formatNumber(d.personal.totals.sales)} delta={d.personal.deltas.sales} deltaLabel={deltaLabel} tone="primary" hint={d.personal.rank ? `Ranked #${d.personal.rank} of ${d.personal.rankOutOf} ${me.role === 'rep' ? 'in your team' : 'company-wide'}` : `${formatNumber(d.personal.days)} days worked`} />
                <KpiTile label="Conversion" value={formatPct(d.personal.ratios.overallConversion, 1)} delta={d.personal.deltas.conversion} deltaLabel={deltaLabel} tone={ratioTone('overallConversion', d.personal.ratios.overallConversion)} hint="sales ÷ stops" />
                <KpiTile label="Stops" value={formatNumber(d.personal.totals.stops)} delta={d.personal.deltas.stops} deltaLabel={deltaLabel} hint={`${formatNumber(d.personal.totals.presentations)} presentations`} />
                <KpiTile label="Earnings to date" value={formatGBP(d.personal.earningsToDate)} hint="gross, this period" />
                <KpiTile label="Next payday" value={d.personal.nextPayday ? formatDateShort(d.personal.nextPayday) : '—'} tone={d.personal.nextPayday && d.personal.nextPayday < todayISO() ? 'danger' : 'default'} hint={d.personal.nextPayday ? `${d.personal.nextPayAmount != null ? formatGBP(d.personal.nextPayAmount, { cents: true }) : 'amount pending'} · ${d.personal.nextPayday < todayISO() ? 'overdue · ' : ''}${formatRelative(d.personal.nextPayday)}` : 'No pending run'} />
                <KpiTile label="Punctuality" value={d.personal.punctualityRate == null ? '—' : formatPct(d.personal.punctualityRate)} tone={d.personal.punctualityRate == null ? 'default' : d.personal.punctualityRate >= 0.9 ? 'success' : d.personal.punctualityRate >= 0.75 ? 'warning' : 'danger'} hint="check-ins on time" />
              </>
            )}
          </div>}

          {/* Personal charts */}
          {!recruiterFirst && <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <Card className="min-w-0 lg:col-span-3">
              <CardHeader title="Your trend" description="Sales and stops per day" />
              {!d ? <ChartSkeleton /> : d.personal.trend.length ? (
                <TrendChart data={d.personal.trend.map((t) => ({ date: t.date, sales: t.sales, stops: t.stops }))} xKey="date" series={[{ key: 'sales', label: 'Sales' }, { key: 'stops', label: 'Stops' }]} kind="area" xFormatter={formatDateShort} height={240} />
              ) : (
                <EmptyState title="No days logged yet" description="Log your gauges after a shift and your trend will build up here." size="sm" className="border-0" action={canLog ? <Button size="sm" onClick={() => setLogOpen(true)}>Log gauges</Button> : undefined} />
              )}
            </Card>
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader title="Your funnel" description="Against the law of averages" />
              {!d ? <ChartSkeleton /> : (
                <>
                  <FunnelChart totals={d.personal.totals} ratios={d.personal.ratios} showBenchmarks compact />
                  <CoachingInsights totals={d.personal.totals} ratios={d.personal.ratios} className="mt-3" />
                </>
              )}
            </Card>
          </div>}

          {/* Team, events, announcements */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
            <Card className="min-w-0">
              <CardHeader title={d?.team ? d.team.teamName : 'Top performers'} description={d?.team ? `${formatNumber(d.team.members)} members · ${formatNumber(d.team.totals.sales)} sales` : d ? 'Across every team this period' : undefined} actions={<Link to="/leaderboard" className="flex items-center gap-1 text-xs text-primary hover:underline">Leaderboard <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
              {!d ? (
                <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
              ) : !d.team ? (
                companyBoard.data ? <MiniLeaderboard rows={companyBoard.data} highlightUserId={me.id} /> : companyBoard.isError ? <EmptyState title="Leaderboard unavailable" size="sm" className="border-0" /> : <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
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
            <Card className="min-w-0">
              <CardHeader title="Upcoming events" actions={<Link to="/events" className="flex items-center gap-1 text-xs text-primary hover:underline">All events <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
              {!d ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : <UpcomingEvents events={d.upcomingEvents} />}
            </Card>
            <Card className="min-w-0">
              <CardHeader title="Announcements" actions={canAnnounce ? <Button size="sm" variant="outline" onClick={() => setAnnounceOpen(true)} leftIcon={<Megaphone className="h-3.5 w-3.5" aria-hidden />}>New announcement</Button> : undefined} />
              {/* Capped so the row's other cards are not stretched by a long notice board. */}
              <div className="max-h-[32rem] overflow-y-auto scrollbar-thin">{!d ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : <Announcements items={d.announcements} />}</div>
            </Card>
          </div>

          {!companyFirst && d?.company && <CompanySection company={d.company} rangeLabel={`${formatDate(d.from)} – ${formatDate(d.to)}`} />}
        </div>
      )}

      {canLog && <LogGaugesModal open={logOpen} onClose={() => setLogOpen(false)} />}
      {canAnnounce && <NewAnnouncementModal open={announceOpen} onClose={() => setAnnounceOpen(false)} />}
    </>
  );
}
