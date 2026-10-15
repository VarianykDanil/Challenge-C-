import { useMemo, useState } from 'react';
import { CalendarDays, Plus } from 'lucide-react';
import type { EventStatus, SalesEventWithMeta } from '@lm/shared';
import { Badge, Button, EmptyState, PageHeader, Select } from '@/components/ui';
import { useCampaigns, useEvents, useTeams } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, ListSkeleton, RangePicker, useRangeState } from '@/features/common';
import { EventFormModal, EventRow } from '@/features/events';
import { isTodayISO, todayISO } from '@/lib/dates';
import { formatDayHeading, pluralise } from '@/lib/format';
import { EVENT_STATUS_LABELS, optionsFrom } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';
import { COPY } from '@/content/copy';

export function EventsPage() {
  usePageTitle(COPY.nav.events.title);
  const me = useCurrentUser();
  const canCreate = me.role === 'admin' || (me.role === 'leader' && me.teamId != null);
  const [range, setRange] = useRangeState('next_3_weeks', false);
  const [teamId, setTeamId] = useState<string>(me.role === 'rep' || me.role === 'leader' ? String(me.teamId ?? '') : '');
  const [campaignId, setCampaignId] = useState('');
  const [status, setStatus] = useState<EventStatus | ''>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [showAllDays, setShowAllDays] = useState(false);

  const teams = useTeams();
  const campaigns = useCampaigns();
  const q = useEvents({ from: range.from, to: range.to, teamId: teamId ? Number(teamId) : undefined, campaignId: campaignId ? Number(campaignId) : undefined, status });

  const today = todayISO();
  // When the range spans today (e.g. the default "Upcoming" preset), list today and what is coming first,
  // then last week's completed days under an "Earlier" divider, so nobody scrolls past history to find today.
  const spansToday = range.from <= today && range.to >= today;
  const { upcoming, earlier } = useMemo(() => {
    const map = new Map<string, typeof q.data>();
    for (const e of q.data ?? []) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (!spansToday) return { upcoming: sorted, earlier: [] as typeof sorted };
    return { upcoming: sorted.filter(([d]) => d >= today), earlier: sorted.filter(([d]) => d < today).reverse() };
  }, [q.data, spansToday, today]);
  const groups = useMemo(() => [...upcoming, ...earlier], [upcoming, earlier]);
  // Long lists (admin, all teams) show the first two weeks of days and a "Show more days" button.
  const totalEvents = q.data?.length ?? 0;
  const dayLimit = showAllDays || totalEvents <= 60 ? Infinity : 14;
  const visibleUpcoming = upcoming.slice(0, dayLimit);
  const visibleEarlier = earlier.slice(0, Math.max(0, dayLimit - upcoming.length));
  const hiddenDays = groups.length - visibleUpcoming.length - visibleEarlier.length;

  return (
    <>
      <PageHeader
        title={COPY.nav.events.title}
        description={COPY.nav.events.description}
        actions={canCreate ? <Button onClick={() => setCreateOpen(true)} leftIcon={<Plus className="h-4 w-4" aria-hidden />}>New event</Button> : undefined}
      />

      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <RangePicker value={range} onChange={setRange} presets={['next_3_weeks', 'this_week', 'last_week', 'this_month', 'last_month']} clampToToday={false} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {me.role === 'rep' ? (
            // The server scopes reps to their own team, so a picker would silently show the wrong label.
            <span className="inline-flex h-8 items-center gap-2 text-sm text-muted">Team <Badge tone="neutral" dot color={teams.data?.find((t) => t.id === me.teamId)?.color}>{me.teamName ?? 'No team'}</Badge></span>
          ) : (
            <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="All teams" options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} size="sm" />
          )}
          <Select aria-label="Campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="All campaigns" options={(campaigns.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} size="sm" />
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as EventStatus | '')} placeholder="Any status" options={optionsFrom(EVENT_STATUS_LABELS)} size="sm" />
        </div>
      </div>

      {q.isLoading ? (
        <ListSkeleton rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-8 w-8" aria-hidden />}
          title={COPY.empty.events.title}
          description={COPY.empty.events.description}
          action={canCreate ? <Button onClick={() => setCreateOpen(true)}>Schedule an event</Button> : undefined}
        />
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-muted">{pluralise(q.data?.length ?? 0, 'event')} across {pluralise(groups.length, 'day')}{spansToday && earlier.length ? ` · ${pluralise(upcoming.reduce((n, [, ev]) => n + (ev?.length ?? 0), 0), 'event')} from today` : ''}</p>
          {spansToday && upcoming.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">Nothing scheduled from today in this range.</p>}
          {visibleUpcoming.map(([date, events]) => <DayGroup key={date} date={date} events={events ?? []} />)}
          {visibleEarlier.length > 0 && (
            <>
              <h2 className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-muted"><span>Earlier</span><span className="h-px flex-1 bg-border" aria-hidden /></h2>
              {visibleEarlier.map(([date, events]) => <DayGroup key={date} date={date} events={events ?? []} />)}
            </>
          )}
          {hiddenDays > 0 && (
            <div className="flex justify-center"><Button variant="outline" onClick={() => setShowAllDays(true)}>Show {pluralise(hiddenDays, 'more day')}</Button></div>
          )}
        </div>
      )}

      {canCreate && <EventFormModal open={createOpen} onClose={() => setCreateOpen(false)} />}
    </>
  );
}

function DayGroup({ date, events }: { date: string; events: SalesEventWithMeta[] }) {
  const today = isTodayISO(date);
  return (
    <section aria-labelledby={`day-${date}`}>
      <h2 id={`day-${date}`} className={`mb-2 flex items-center gap-2 text-sm font-semibold ${today ? 'text-primary' : 'text-fg'}`}>
        {today && <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />}
        {formatDayHeading(date)}
        <span className="text-xs font-normal text-muted">· {pluralise(events.length, 'event')}</span>
      </h2>
      <ul className={`space-y-2 ${today ? 'rounded-xl bg-primary/5 p-2 ring-1 ring-primary/20' : ''}`}>
        {events.map((e) => <EventRow key={e.id} event={e} />)}
      </ul>
    </section>
  );
}
