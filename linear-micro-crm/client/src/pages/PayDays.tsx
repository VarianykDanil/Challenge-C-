// /pay/days (leaders and administrators) — Days to confirm (MON-1). A day someone logged with gauges counts as a paid
// base day only when they were booked on the event or checked in, or a leader (or the office) says they worked it. The
// days without that wait here: "Worked" pays the base day, "Not worked" leaves it out. Leaders see their own team (their
// own days are for the office); administrators see everyone. Weeks already paid are not listed. Lazy (App.tsx).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarCheck2, CheckCircle2, XCircle } from 'lucide-react';
import { payDayLabel, payWeekLabel, type PayDayToCheck } from '@lm/shared';
import { useDaysToCheck, useDecideDay } from '@/api/pay';
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, Skeleton, useToast } from '@/components/ui';
import { ErrorState, errorMessage } from '@/features/common';
import { formatNumber } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

const REASON: Record<PayDayToCheck['reason'], string> = {
  not_booked: 'Not booked on the event and no check-in',
  nothing_logged: 'Nothing logged that day (all gauges 0)',
};

export function PayDaysPage() {
  usePageTitle('Days to confirm');
  const q = useDaysToCheck();
  // by week (newest first), then the day
  const weeks = useMemo(() => {
    const byWeek = new Map<string, PayDayToCheck[]>();
    for (const d of q.data ?? []) byWeek.set(d.weekStart, [...(byWeek.get(d.weekStart) ?? []), d]);
    return [...byWeek.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [q.data]);
  return (
    <div>
      <PageHeader
        breadcrumbs={<Link to="/finance" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Finance</Link>}
        title="Days to confirm"
        icon={<CalendarCheck2 aria-hidden />}
        description="A logged day pays a base day when the person was booked on the event or checked in. These days had neither (or nothing was logged), so they wait for you: say whether the person worked them."
      />
      {q.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : weeks.length === 0 ? (
        <EmptyState icon={<CheckCircle2 aria-hidden />} title="Nothing to confirm" description="Every logged day in the unpaid weeks has a booking, a check-in or a decision." />
      ) : (
        <div className="space-y-6">
          {weeks.map(([week, days]) => (
            <Card key={week} data-pay-days-week={week}>
              <CardHeader title={payWeekLabel(week)} description={`${formatNumber(days.length)} ${days.length === 1 ? 'day' : 'days'} waiting. Not in the pay until confirmed.`} />
              <ul className="divide-y divide-border">
                {days.map((d) => <DayRow key={`${d.userId}-${d.date}`} day={d} />)}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function DayRow({ day }: { day: PayDayToCheck }) {
  const decide = useDecideDay();
  const toast = useToast();
  const [note, setNote] = useState('');
  const send = (decision: 'confirmed' | 'not_worked') =>
    decide.mutate({ userId: day.userId, date: day.date, decision, ...(note.trim() ? { note: note.trim() } : {}) }, {
      onSuccess: () => toast.success(decision === 'confirmed' ? 'Day confirmed' : 'Marked as not worked', `${day.userName}, ${payDayLabel(day.date)}: ${decision === 'confirmed' ? 'paid as a base day' : 'not paid as a base day'}.`),
      onError: (e) => toast.error('Could not save that', errorMessage(e)),
    });
  return (
    <li className="flex flex-col gap-3 py-3 lg:flex-row lg:items-start lg:justify-between" data-pay-day="">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-fg">
          <Link to={`/team/${day.userId}`} className="hover:underline">{day.userName}</Link>
          <span className="text-muted"> · {payDayLabel(day.date)}{day.teamName ? ` · ${day.teamName}` : ''}</span>
        </p>
        <p className="text-sm text-muted">{REASON[day.reason]}</p>
        {day.events.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted">
            {day.events.map((e) => (
              <li key={e.eventId}>
                <Link to={`/events/${e.eventId}`} className="hover:underline">{e.eventName}</Link>: {formatNumber(e.stops)} stops, {formatNumber(e.sales)} sales
                {e.booked ? ' · booked' : ' · not booked'}{e.checkedIn ? ' · checked in' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      {day.officeOnly ? (
        <Badge tone="neutral" className="self-start">Your own day: the office decides</Badge>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:shrink-0">
          <Input aria-label={`Note for ${day.userName}, ${payDayLabel(day.date)} (optional)`} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="sm:w-48" />
          <div className="flex gap-2">
            <Button size="sm" className="h-10" leftIcon={<CheckCircle2 aria-hidden />} loading={decide.isPending && decide.variables?.decision === 'confirmed'} disabled={decide.isPending} onClick={() => send('confirmed')}>Worked</Button>
            <Button size="sm" variant="outline" className="h-10" leftIcon={<XCircle aria-hidden />} loading={decide.isPending && decide.variables?.decision === 'not_worked'} disabled={decide.isPending} onClick={() => send('not_worked')}>Not worked</Button>
          </div>
        </div>
      )}
    </li>
  );
}
