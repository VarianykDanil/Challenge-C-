// Release 1.3 — /recruitment/schedule (admin, leader, recruiter) — OWNED BY P7 recruitment-plus. Every interview by
// day (Europe/London), with the candidate, the interviewer and how far the sheet has got: today, this week or next
// week; filters for the interviewer (or "No interviewer yet") and the type; Schedule interview, Reschedule (time or
// interviewer, logged on the candidate's timeline) and Open sheet. The filters live in the address (?range=&who=&type=).
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CalendarPlus, ClipboardList } from 'lucide-react';
import type { InterviewScheduleItem, InterviewType } from '@lm/shared';
import { INTERVIEW_TYPE_ORDER, groupScheduleByDay, needsOutcome, scheduleRange, type ScheduleRangePreset } from '@lm/shared';
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, SegmentedControl, Select, Skeleton } from '@/components/ui';
import { useUsers } from '@/api/hooks';
import { useInterviewSchedule } from '@/api/recruitmentPlus';
import { useCurrentUser } from '@/auth/AuthProvider';
import { COPY } from '@/content/copy';
import { ErrorState, StageBadge } from '@/features/common';
import { RescheduleInterviewModal } from '@/features/recruitment/RescheduleInterviewModal';
import { ScheduleInterviewModal } from '@/features/recruitment/ScheduleInterviewModal';
import { buttonLinkClass } from '@/features/recruitment/linkStyles';
import { todayISO } from '@/lib/dates';
import { formatDayHeading, formatRangeLabel, formatTime, fullName, pluralise } from '@/lib/format';
import { INTERVIEW_OUTCOME_LABELS, INTERVIEW_OUTCOME_TONES, INTERVIEW_TYPE_LABELS } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';

const RANGES: { value: ScheduleRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'next_week', label: 'Next week' },
];
const EMPTY_TITLE: Record<ScheduleRangePreset, string> = { today: 'No interviews today', this_week: 'No interviews this week', next_week: 'No interviews next week' };
const isRange = (v: string | null): v is ScheduleRangePreset => v === 'today' || v === 'this_week' || v === 'next_week';
const isType = (v: string | null): v is InterviewType => !!v && (INTERVIEW_TYPE_ORDER as readonly string[]).includes(v);

export function InterviewSchedulePage() {
  usePageTitle(COPY.nav.interviewSchedule.title);
  const me = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const range: ScheduleRangePreset = isRange(params.get('range')) ? (params.get('range') as ScheduleRangePreset) : 'this_week';
  const who = params.get('who') ?? '';
  const type = isType(params.get('type')) ? (params.get('type') as InterviewType) : null;
  const set = (key: string, value: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });

  const { from, to } = scheduleRange(range, todayISO());
  const interviewerId = who === 'none' ? 'none' : who ? Number(who) : null;
  const q = useInterviewSchedule({ from, to, interviewerId, type });
  const people = useUsers({});
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [moving, setMoving] = useState<InterviewScheduleItem | null>(null);

  const items = q.data ?? [];
  const days = useMemo(() => groupScheduleByDay(items), [items]);
  const unassigned = items.filter((i) => i.interviewerId === null).length;
  const interviewerOptions = [
    { value: String(me.id), label: 'Me' },
    { value: 'none', label: 'No interviewer yet' },
    ...(people.data ?? []).filter((u) => u.role !== 'rep' && u.id !== me.id).map((u) => ({ value: String(u.id), label: fullName(u) })),
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/recruitment" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Recruitment</Link>}
        title={COPY.nav.interviewSchedule.title}
        description={COPY.nav.interviewSchedule.description}
        actions={<Button onClick={() => setScheduleOpen(true)} leftIcon={<CalendarPlus className="h-4 w-4" aria-hidden />}>Schedule interview</Button>}
      />

      <div data-testid="schedule-filters" className="mb-4 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <SegmentedControl aria-label="When" value={range} onChange={(v) => set('range', v === 'this_week' ? null : v)} options={RANGES} fullWidth className="max-sm:h-11 lg:w-80" />
        <div className="grid gap-2 sm:grid-cols-2 lg:w-[28rem]">
          <Select aria-label="Interviewer" value={who} onChange={(e) => set('who', e.target.value || null)} placeholder="Every interviewer" options={interviewerOptions} />
          <Select aria-label="Interview type" value={type ?? ''} onChange={(e) => set('type', e.target.value || null)} placeholder="Every type" options={INTERVIEW_TYPE_ORDER.map((t) => ({ value: t, label: INTERVIEW_TYPE_LABELS[t] }))} />
        </div>
      </div>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the schedule" />
      ) : q.isLoading ? (
        <div className="space-y-4"><Skeleton className="h-6 w-48" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CalendarClock aria-hidden />}
          title={EMPTY_TITLE[range]}
          description={`Nothing booked for ${range === 'today' ? 'today' : formatRangeLabel(from, to)}${who || type ? ' with these filters' : ''}.`}
          action={<Button variant="outline" onClick={() => setScheduleOpen(true)} leftIcon={<CalendarPlus className="h-4 w-4" aria-hidden />}>Schedule interview</Button>}
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted" aria-live="polite">
            {pluralise(items.length, 'interview')} · {range === 'today' ? 'today' : formatRangeLabel(from, to)}
            {unassigned > 0 && who !== 'none' ? ` · ${unassigned} still ${unassigned === 1 ? 'needs' : 'need'} an interviewer` : ''}
          </p>
          <div className="space-y-6" data-testid="interview-schedule">
            {days.map((d) => (
              <section key={d.day} aria-labelledby={`day-${d.day}`}>
                <h2 id={`day-${d.day}`} className="mb-2 text-sm font-semibold text-fg">{formatDayHeading(d.day)}</h2>
                <Card padded={false}>
                  <ul className="divide-y divide-border">
                    {d.items.map((iv) => <ScheduleRow key={iv.id} item={iv} onMove={() => setMoving(iv)} />)}
                  </ul>
                </Card>
              </section>
            ))}
          </div>
        </>
      )}

      <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      <RescheduleInterviewModal open={!!moving} interview={moving} candidateName={moving?.candidateName} onClose={() => setMoving(null)} />
    </>
  );
}

function ScheduleRow({ item: iv, onMove }: { item: InterviewScheduleItem; onMove: () => void }) {
  const upcoming = new Date(iv.scheduledAt).getTime() > Date.now();
  const due = needsOutcome(iv);
  return (
    <li className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 gap-4">
        <div className="w-14 shrink-0 pt-0.5 text-right">
          <div className="text-base font-semibold tabular-nums text-fg">{formatTime(iv.scheduledAt)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-sm font-semibold text-fg">{INTERVIEW_TYPE_LABELS[iv.type]}</span>
            <span className="text-muted" aria-hidden>·</span>
            <Link to={`/recruitment/${iv.candidateId}`} className="truncate text-sm font-medium text-primary hover:underline max-sm:inline-flex max-sm:min-h-10 max-sm:items-center">{iv.candidateName}</Link>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {iv.interviewerName ? (
              <span className="inline-flex items-center gap-1.5"><Avatar name={iv.interviewerName} size="xs" />{iv.interviewerName}</span>
            ) : (
              <Badge tone="warning" size="sm">No interviewer yet</Badge>
            )}
            <span className="inline-flex items-center gap-1.5">Now at <StageBadge stage={iv.candidateStage} /></span>
            <span>Sheet: {iv.sheetAnswered} of {iv.sheetQuestions} answered</span>
            {iv.outcome !== 'pending' ? (
              <Badge tone={INTERVIEW_OUTCOME_TONES[iv.outcome]} size="sm">{INTERVIEW_OUTCOME_LABELS[iv.outcome]}</Badge>
            ) : due ? (
              <Badge tone="warning" size="sm">Outcome due</Badge>
            ) : upcoming ? null : (
              <Badge tone="neutral" size="sm">Pending</Badge>
            )}
          </div>
          {iv.notes && <p className="mt-1 line-clamp-2 text-xs text-muted">{iv.notes}</p>}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 md:ml-auto">
        <Button variant="outline" onClick={onMove} className="flex-1 md:flex-none">Reschedule</Button>
        <Link to={`/recruitment/interviews/${iv.id}`} className={buttonLinkClass('soft', 'flex-1 md:flex-none')}>
          <ClipboardList aria-hidden /> Open sheet
        </Link>
      </div>
    </li>
  );
}
