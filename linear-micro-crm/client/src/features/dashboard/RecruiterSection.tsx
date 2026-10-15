// Recruitment-first dashboard for recruiters: pipeline KPIs, upcoming interviews, overdue follow-ups and weekly activity.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, CalendarClock } from 'lucide-react';
import type { DashboardRange, Interview } from '@lm/shared';
import { DASHBOARD_RANGE_LABELS, STAGE_LABELS } from '@lm/shared';
import { addDays, endOfWeek } from 'date-fns';
import { Avatar, Card, CardHeader, EmptyState, KpiTile } from '@/components/ui';
import { TrendChart } from '@/components/charts';
import { useCandidates, useInterviews, useRecruitmentSummary } from '@/api/hooks';
import { ChartSkeleton, ErrorState, KpiSkeletons } from '@/features/common';
import { isOverdue } from '@/features/recruitment';
import { WEEK_OPTS, dashboardRangePreset, presetRange, toISODate, weekStartISO } from '@/lib/dates';
import { formatDateShort, formatDateTime, formatDecimal, formatNumber, formatRelative, fullName } from '@/lib/format';
import { INTERVIEW_TYPE_LABELS } from '@/lib/labels';

const LIST_LIMIT = 6;

export function RecruiterSection({ range }: { range: DashboardRange }) {
  const r = useMemo(() => presetRange(dashboardRangePreset(range), new Date(), true), [range]);
  const summary = useRecruitmentSummary({ from: r.from, to: r.to });
  const activityRange = useMemo(() => presetRange('last_12_weeks'), []);
  const activity = useRecruitmentSummary(activityRange);
  const open = useCandidates({ open: true });
  const interviews = useInterviews(); // server default: Monday of this week → today + 14 days
  const s = summary.data;

  const now = new Date();
  const weekFrom = weekStartISO(now);
  const weekTo = toISODate(endOfWeek(now, WEEK_OPTS));
  const interviewsThisWeek = (interviews.data ?? []).filter((iv) => { const d = iv.scheduledAt.slice(0, 10); return d >= weekFrom && d <= weekTo; }).length;
  const upcoming = useMemo(() => (interviews.data ?? []).filter((iv) => iv.outcome === 'pending' && new Date(iv.scheduledAt).getTime() >= Date.now() - 60 * 60_000).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, LIST_LIMIT), [interviews.data]);
  const overdue = useMemo(() => (open.data ?? []).filter(isOverdue).sort((a, b) => (a.nextActionAt ?? '').localeCompare(b.nextActionAt ?? '')).slice(0, LIST_LIMIT), [open.data]);
  const candidateById = useMemo(() => new Map((open.data ?? []).map((c) => [c.id, c])), [open.data]);
  const nameFor = (iv: Interview) => { const c = candidateById.get(iv.candidateId); return c ? fullName(c) : `Candidate #${iv.candidateId}`; };
  const soon = toISODate(addDays(now, 7));

  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} title="Could not load recruitment" />;

  return (
    <section aria-labelledby="recruiting-heading" className="space-y-6">
      <div>
        <h2 id="recruiting-heading" className="text-lg font-semibold text-fg">Recruitment</h2>
        <p className="text-sm text-muted">Pipeline health · {DASHBOARD_RANGE_LABELS[range].toLowerCase()}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {!s ? <KpiSkeletons count={5} /> : (
          <>
            <KpiTile label="Open candidates" value={open.data ? formatNumber(open.data.length) : '—'} tone="primary" hint={`${formatNumber(s.openByStage.interview + s.openByStage.observation)} in interviews`} />
            <KpiTile label="Interviews this week" value={interviews.data ? formatNumber(interviewsThisWeek) : '—'} hint={`${formatNumber(upcoming.length)} upcoming`} />
            <KpiTile label="Overdue actions" value={formatNumber(s.overdueActions)} tone={s.overdueActions > 0 ? 'danger' : 'success'} hint="open candidates past next action" />
            <KpiTile label={`Hires · ${DASHBOARD_RANGE_LABELS[range].toLowerCase()}`} value={formatNumber(s.hired)} tone="success" hint={`${formatNumber(s.applied)} applied in range`} />
            <KpiTile label="Avg time to hire" value={s.hired > 0 ? `${formatDecimal(s.avgTimeToHireDays)} days` : '—'} hint={s.hired > 0 ? 'applied → hired' : 'no hires in this range'} />
          </>
        )}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader title="Upcoming interviews" description="Next two weeks" actions={<Link to="/recruitment" className="flex items-center gap-1 text-xs text-primary hover:underline">Pipeline <ArrowRight className="h-3 w-3" aria-hidden /></Link>} />
          {interviews.isError ? <ErrorState error={interviews.error} className="p-4" /> : upcoming.length === 0 ? (
            <EmptyState icon={<CalendarClock className="h-6 w-6" aria-hidden />} title="Nothing booked" description="Schedule interviews from a candidate's page." size="sm" className="border-0" />
          ) : (
            <ul className="divide-y divide-border">
              {upcoming.map((iv) => (
                <li key={iv.id}>
                  <Link to={`/recruitment/${iv.candidateId}`} className="flex items-center gap-3 rounded-md py-2 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Avatar name={nameFor(iv)} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{nameFor(iv)}</span>
                      <span className="block text-xs text-muted">{INTERVIEW_TYPE_LABELS[iv.type]} · {formatDateTime(iv.scheduledAt)}{iv.interviewerName ? ` · ${iv.interviewerName}` : ''}</span>
                    </span>
                    <span className={`shrink-0 text-xs ${iv.scheduledAt.slice(0, 10) <= soon ? 'text-primary' : 'text-muted'}`}>{formatRelative(iv.scheduledAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Overdue follow-ups" description={s ? `${formatNumber(s.overdueActions)} open candidate${s.overdueActions === 1 ? '' : 's'} past their next action` : undefined} />
          {open.isError ? <ErrorState error={open.error} className="p-4" /> : overdue.length === 0 ? (
            <EmptyState title="All caught up" description="No open candidate is past their next action date." size="sm" className="border-0" />
          ) : (
            <ul className="divide-y divide-border">
              {overdue.map((c) => (
                <li key={c.id}>
                  <Link to={`/recruitment/${c.id}`} className="flex items-center gap-3 rounded-md py-2 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{fullName(c)} <span className="font-normal text-muted">· {STAGE_LABELS[c.stage]}</span></span>
                      <span className="block truncate text-xs text-muted">{c.nextAction ?? 'Next action'}{c.nextActionAt ? ` · due ${formatDateShort(c.nextActionAt)}` : ''}</span>
                    </span>
                    {c.nextActionAt && <span className="shrink-0 text-xs text-danger">{formatRelative(c.nextActionAt)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Weekly activity" description="Applications, interviews and hires · last 12 weeks" />
          {!activity.data ? <ChartSkeleton height={220} /> : activity.data.weekly.length ? (
            <TrendChart data={activity.data.weekly.map((w) => ({ week: w.weekStart, applied: w.applied, interviews: w.interviews, hired: w.hired }))} xKey="week" series={[{ key: 'applied', label: 'Applied' }, { key: 'interviews', label: 'Interviews' }, { key: 'hired', label: 'Hired' }]} kind="bar" xFormatter={formatDateShort} height={220} />
          ) : <EmptyState title="No activity yet" size="sm" className="border-0" />}
        </Card>
      </div>
    </section>
  );
}
