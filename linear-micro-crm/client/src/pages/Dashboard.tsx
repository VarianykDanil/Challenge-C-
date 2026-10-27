import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, PlusCircle, Quote } from 'lucide-react';
import type { DashboardRange } from '@lm/shared';
import { DASHBOARD_RANGE_LABELS, POSITION_LABELS } from '@lm/shared';
import { Button, Card, CardHeader, PageHeader, SegmentedControl, Skeleton } from '@/components/ui';
import { useDashboard, useInsights, useLeaderboard } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { GAUGE_ROLES, hasRole } from '@/auth/RequireRole';
import { AnnouncementsCard, CompanySection, NewAnnouncementModal, PersonalCharts, PersonalKpis, RecruiterSection, TeamCard, UpcomingEvents } from '@/features/dashboard';
import { ErrorBoundary, ErrorState } from '@/features/common';
import { LogGaugesModal } from '@/features/gauges';
import { ProgressCard } from '@/features/learning/ProgressCard';
import { TodayTallyLink } from '@/features/gauges/TallyLinks';
import { TodayShift } from '@/features/dashboard/TodayShift';
import { showsTodayCard } from '@/features/dashboard/todayShift';
import { LazyAttentionCard, LazyWeekInReview, LazyWeekPayStrip } from '@/features/smart';
import { COPY, greetingFor, motivationForDate } from '@/content/copy';
import { formatDate, formatDateShort, formatRangeLabel } from '@/lib/format';
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
  // Smart release 1.1: one cached payload feeds every smart slot (each slot renders nothing until its owner fills it).
  const insights = useInsights().data;
  const showPayStrip = me.role === 'rep' || me.role === 'leader';
  // Release 1.2 (L1): "Your next level" under the tiles, for the field ladder (reps and leaders).
  const showProgress = me.role === 'rep' || me.role === 'leader';
  // Reps and leaders: today's event (Check in, Log gauges) first, then what needs doing, their numbers and the next
  // events; the charts come after them (on a phone they were the second and third screens).
  const fieldFirst = showsTodayCard(me);

  return (
    <>
      <PageHeader
        title={greetingFor(new Date(), me.firstName)}
        description={`${POSITION_LABELS[me.position]}${me.teamName ? ` · ${me.teamName}` : ''}${rangeLabel ? ` · ${rangeLabel}` : ''}`}
        actions={
          <>
            <SegmentedControl<DashboardRange> aria-label="Period" options={RANGE_ITEMS} value={range} onChange={setRange} />
            {canLog && (
              <Button onClick={() => setLogOpen(true)} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />} className="max-sm:h-11">
                Log gauges
              </Button>
            )}
          </>
        }
      />

      <p className="-mt-3 mb-6 flex items-center gap-2 text-sm italic text-muted"><Quote className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />{motivationForDate()}</p>

      {/* shown even when the dashboard cannot load (no signal): it works from the events kept on the phone */}
      {fieldFirst && <ErrorBoundary name="today-shift" fallback={null} className="mb-8"><TodayShift onLog={() => setLogOpen(true)} /></ErrorBoundary>}

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load your dashboard" />
      ) : (
        <div className="space-y-8">
          <ErrorBoundary name="attention"><LazyAttentionCard /></ErrorBoundary>

          {/* Sections and cards another package edits (CompanySection: p4, RecruiterSection: p8, UpcomingEvents: p6) each sit in their own boundary. */}
          {companyFirst && d?.company && <ErrorBoundary name="company"><CompanySection company={d.company} rangeLabel={`${formatDate(d.from)} – ${formatDate(d.to)}`} checkIns={insights?.company?.checkIns} /></ErrorBoundary>}

          {companyFirst && (
            <div>
              <h2 className="text-lg font-semibold text-fg">Your activity</h2>
              <p className="text-sm text-muted">Days you worked in the field yourself{rangeLabel ? ` · ${rangeLabel}` : ''}</p>
            </div>
          )}

          {recruiterFirst && <ErrorBoundary name="recruiter"><RecruiterSection range={range} /></ErrorBoundary>}

          {/* KPI tiles, with the week's pay estimate (p3) right under them */}
          {!recruiterFirst && (
            <div>
              <PersonalKpis dashboard={d} role={me.role} deltaLabel={deltaLabel} streaks={insights?.personal.streaks} />
              {showPayStrip && <ErrorBoundary name="week-pay" className="mt-3"><LazyWeekPayStrip forecast={insights?.personal.payForecast} /></ErrorBoundary>}
              {showProgress && <ErrorBoundary name="learning-progress" fallback={null}><ProgressCard className="mt-3" /></ErrorBoundary>}
            </div>
          )}

          {/* Personal charts (for reps and leaders, after the events below) */}
          {!recruiterFirst && !fieldFirst && <PersonalCharts dashboard={d} canLog={canLog} onLog={() => setLogOpen(true)} baseline={insights?.personal.baseline} direction={insights?.personal.direction} />}

          {/* Team, events, announcements: two columns (announcements across both) until 1360 px, where three cards still
              leave room for names beside the sidebar (1.3.1 UI review: at 1024 px a third of the row cut them to "H.") */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start min-[1360px]:grid-cols-3">
            <TeamCard dashboard={d} meId={me.id} role={me.role} companyBoard={companyBoard} streaks={insights?.boardStreaks} checkIns={insights?.team?.checkIns} />
            <Card className="min-w-0">
              <CardHeader title="Upcoming events" actions={<Link to="/events" className="flex items-center gap-1 text-xs text-primary hover:underline">All events <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
              {!d ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : (
                <>
                  {/* p7: the tally entry point for today's event ("reachable from the dashboard's today event"). */}
                  {canLog && <ErrorBoundary name="today-tally" className="mb-3"><TodayTallyLink events={d.upcomingEvents} /></ErrorBoundary>}
                  <ErrorBoundary name="upcoming-events"><UpcomingEvents events={d.upcomingEvents} /></ErrorBoundary>
                </>
              )}
            </Card>
            <AnnouncementsCard dashboard={d} canAnnounce={canAnnounce} onNew={() => setAnnounceOpen(true)} className="lg:col-span-2 min-[1360px]:col-span-1" />
          </div>

          {fieldFirst && <PersonalCharts dashboard={d} canLog={canLog} onLog={() => setLogOpen(true)} baseline={insights?.personal.baseline} direction={insights?.personal.direction} />}

          <ErrorBoundary name="week-in-review"><LazyWeekInReview /></ErrorBoundary>

          {!companyFirst && d?.company && <ErrorBoundary name="company"><CompanySection company={d.company} rangeLabel={`${formatDate(d.from)} – ${formatDate(d.to)}`} checkIns={insights?.company?.checkIns} /></ErrorBoundary>}
        </div>
      )}

      {canLog && <LogGaugesModal open={logOpen} onClose={() => setLogOpen(false)} />}
      {canAnnounce && <NewAnnouncementModal open={announceOpen} onClose={() => setAnnounceOpen(false)} />}
    </>
  );
}
