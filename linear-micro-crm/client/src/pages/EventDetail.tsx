import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, CalendarDays, CheckCircle2, Clock, MapPin, Pencil, PlusCircle, Trash2, Users } from 'lucide-react';
import type { GaugeEntryWithMeta, UserWithTeam } from '@lm/shared';
import { funnelRatios } from '@lm/shared';
import { Avatar, Badge, Button, Card, CardHeader, PageHeader, Skeleton, useToast } from '@/components/ui';
import { FunnelChart } from '@/components/charts';
import { useDeleteEvent, useDeleteGauge, useEvent, useUpdateEvent, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ConfirmDialog, ErrorState, EventStatusBadge, EventTypeBadge, ExportButton, KpiSkeletons, errorMessage } from '@/features/common';
import { DirectionsLink, EventForecastChip, EventFormModal, inRosterWindow } from '@/features/events';
import { GaugeEntriesTable, LogGaugesModal, TotalsKpis, gaugeEntryCsvColumns } from '@/features/gauges';
import { csvFilename } from '@/lib/csv';
import { todayISO } from '@/lib/dates';
import { formatDate, formatNumber, formatTime, fullName } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { NotFoundPage } from './NotFound';
import { ApiError } from '@/api/client';

export function EventDetailPage() {
  const { id } = useParams();
  const eventId = Number(id);
  const me = useCurrentUser();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useEvent(Number.isFinite(eventId) ? eventId : null);
  const ev = q.data;
  usePageTitle(ev ? ev.name : 'Event');

  const [editOpen, setEditOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // Whose day the Log gauges modal opens on (a "Not logged yet" chip picks a team member; otherwise yourself).
  const [logUserId, setLogUserId] = useState<number | null>(null);
  const [editEntry, setEditEntry] = useState<GaugeEntryWithMeta | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<GaugeEntryWithMeta | null>(null);
  const [deleteEventOpen, setDeleteEventOpen] = useState(false);
  const [cancelEventOpen, setCancelEventOpen] = useState(false);
  const delEvent = useDeleteEvent();
  const updEvent = useUpdateEvent();
  const delGauge = useDeleteGauge();

  // Mirror the API's write rules (lib/scope.ts) so the page never offers an action that ends in a 403:
  //  - admins write anywhere;
  //  - leaders only at their own team's events, for themselves or members of their team;
  //  - reps only their own entry, only at their own team's events;
  //  - deleting an entry needs the team's leader or an admin (a leader may also delete their own).
  const isAdmin = me.role === 'admin';
  const sameTeamEvent = !!ev && me.teamId != null && ev.teamId === me.teamId;
  const canEdit = isAdmin || (me.role === 'leader' && sameTeamEvent);
  const canManageGauges = isAdmin || (me.role === 'leader' && sameTeamEvent);
  const canLog = isAdmin || ((me.role === 'leader' || me.role === 'rep') && sameTeamEvent);
  const canEditRow = (row: GaugeEntryWithMeta): boolean => {
    if (isAdmin) return true;
    if (!sameTeamEvent) return false;
    if (me.role === 'leader') return row.userId === me.id || row.teamId === me.teamId;
    return me.role === 'rep' && row.userId === me.id;
  };
  const canDeleteRow = (row: GaugeEntryWithMeta): boolean => isAdmin || (me.role === 'leader' && (row.teamId === me.teamId || row.userId === me.id));

  const today = todayISO();
  // Roster gaps (p6): for the admin or this team's leader only (the same rule as managing gauges), the active members
  // of the event's team who have no entry yet, on a live or completed event from the last two days. Recruiters and
  // other teams never get the list: the query does not even run for them. (Hooks stay above the early return.)
  const showRoster = !!ev && canManageGauges && inRosterWindow(ev, today);
  const teamQ = useUsers({ teamId: ev?.teamId ?? null, status: 'active' }, { enabled: showRoster });
  const { notLogged, rosterSize } = useMemo(() => {
    if (!ev || !teamQ.data) return { notLogged: [] as UserWithTeam[], rosterSize: 0 };
    // people who had not started yet on the event's date are not expected to have logged it
    const roster = teamQ.data.filter((u) => u.teamId === ev.teamId && u.startDate <= ev.date);
    const logged = new Set(ev.entries.map((e) => e.userId));
    const missing = roster.filter((u) => !logged.has(u.id)).sort((a, b) => fullName(a).localeCompare(fullName(b)));
    return { notLogged: missing, rosterSize: roster.length };
  }, [ev, teamQ.data]);

  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage />;

  const ratios = ev ? ev.ratios ?? funnelRatios(ev.totals) : null;
  const myEntry = ev?.entries.find((e) => e.userId === me.id) ?? null;
  // A rep with no entry yet on today's live or just-ended team event gets the plainest possible prompt.
  const logToday = me.role === 'rep' && canLog && !myEntry && !!ev && ev.date === today && (ev.status === 'live' || ev.status === 'completed');
  // An event that already carries gauge entries cannot be deleted (the API answers 409): cancelling keeps the record.
  const hasEntries = (ev?.entries.length ?? 0) > 0;
  const canDelete = isAdmin && !hasEntries;
  const canCancel = canEdit && hasEntries && ev?.status !== 'cancelled';

  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/events" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> Events</Link>}
        title={ev ? ev.name : <Skeleton className="h-7 w-64" />}
        description={
          ev ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden />{formatDate(ev.date)}</span>
              <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{formatTime(ev.startTime)} – {formatTime(ev.endTime)}</span>
              <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden />{ev.venue}, {ev.city}<DirectionsLink variant="text" venue={ev.venue} city={ev.city} className="-my-1.5 ml-0.5" /></span>
              <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" aria-hidden />{formatNumber(ev.repCount)} rep{ev.repCount === 1 ? '' : 's'}</span>
            </span>
          ) : undefined
        }
        actions={
          ev ? (
            <>
              {canLog && (
                <Button onClick={() => { setEditEntry(myEntry); setLogUserId(null); setLogOpen(true); }} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />}>
                  {myEntry ? 'Update my gauges' : logToday ? "Log today's gauges" : 'Log gauges'}
                </Button>
              )}
              {canEdit && <Button variant="outline" onClick={() => setEditOpen(true)} leftIcon={<Pencil className="h-4 w-4" aria-hidden />}>Edit</Button>}
              {canCancel && <Button variant="ghost" className="text-danger" onClick={() => setCancelEventOpen(true)} leftIcon={<Ban className="h-4 w-4" aria-hidden />} aria-label="Cancel event">Cancel event</Button>}
              {canDelete && <Button variant="ghost" className="text-danger" onClick={() => setDeleteEventOpen(true)} leftIcon={<Trash2 className="h-4 w-4" aria-hidden />} aria-label="Delete event">Delete</Button>}
            </>
          ) : undefined
        }
      />

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load this event" />
      ) : (
        <div className="space-y-6">
          {ev && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral" dot color={ev.campaignColor}>{ev.campaignName} · {ev.campaignCode}</Badge>
              <Badge tone="neutral" dot color={ev.teamColor}>{ev.teamName}</Badge>
              <EventTypeBadge type={ev.type} />
              <EventStatusBadge status={ev.status} />
              <span className="text-xs text-muted">Target {formatNumber(ev.targetSales)} sales</span>
            </div>
          )}

          {ev?.forecast && (ev.status === 'scheduled' || ev.status === 'live') && (
            <EventForecastChip variant="detail" forecast={ev.forecast} targetSales={ev.targetSales} campaignCode={ev.campaignCode} type={ev.type} teamName={ev.teamName} className="max-w-2xl" />
          )}

          {ev && showRoster && (
            <NotLoggedYet
              loading={teamQ.isLoading}
              people={notLogged}
              teamSize={rosterSize}
              onLog={(u) => { setEditEntry(null); setLogUserId(u.id); setLogOpen(true); }}
            />
          )}

          {ev && ratios ? <TotalsKpis totals={ev.totals} ratios={ratios} daysHint={`${formatNumber(ev.repCount)} rep${ev.repCount === 1 ? '' : 's'} logged`} /> : <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"><KpiSkeletons count={6} /></div>}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-1">
              <CardHeader title="Event funnel" description="All reps combined vs benchmarks" />
              {ev && ratios ? <FunnelChart totals={ev.totals} ratios={ratios} showBenchmarks /> : <Skeleton className="h-48" />}
              {ev?.notes && (
                <div className="mt-4 rounded-lg bg-surface-2 p-3 text-sm text-muted">
                  <div className="mb-1 text-xs font-semibold text-fg">Notes</div>
                  <p className="whitespace-pre-line">{ev.notes}</p>
                </div>
              )}
            </Card>
            <Card padded={false} className="min-w-0 overflow-hidden lg:col-span-2">
              <div className="p-5 pb-3"><CardHeader title="Gauges by rep" description="Each person's day, with check-in punctuality" className="mb-0" actions={ev ? <ExportButton filename={csvFilename(`event-${ev.name}`, ev.date)} rows={ev.entries} columns={gaugeEntryCsvColumns()} /> : undefined} /></div>
              <GaugeEntriesTable
                rows={ev?.entries ?? []}
                loading={q.isLoading}
                showEvent={false}
                showDate={false}
                onEdit={canManageGauges || (canLog && !!myEntry) ? (row) => { setEditEntry(row); setLogOpen(true); } : undefined}
                onDelete={canManageGauges ? (row) => setDeleteEntry(row) : undefined}
                canEditRow={canEditRow}
                canDeleteRow={canDeleteRow}
                emptyMessage="No gauges logged for this event yet"
                bare className="border-t border-border"
              />
              {ev && !canLog && me.role !== 'recruiter' && (
                <p className="border-t border-border px-5 py-3 text-xs text-muted">You can only log gauges at your own team's events.</p>
              )}
            </Card>
          </div>
        </div>
      )}

      {ev && canLog && <LogGaugesModal open={logOpen} onClose={() => { setLogOpen(false); setEditEntry(null); setLogUserId(null); }} event={ev} entry={editEntry} defaultUserId={logUserId ?? me.id} />}
      {ev && canEdit && <EventFormModal open={editOpen} onClose={() => setEditOpen(false)} event={ev} />}

      <ConfirmDialog
        open={!!deleteEntry}
        onClose={() => setDeleteEntry(null)}
        title="Delete this gauge entry?"
        description={deleteEntry ? `${deleteEntry.userName}'s entry for ${formatDate(deleteEntry.date)} will be removed. This cannot be undone.` : undefined}
        confirmLabel="Delete entry"
        tone="danger"
        loading={delGauge.isPending}
        onConfirm={() => {
          if (!deleteEntry) return;
          delGauge.mutate(deleteEntry.id, {
            onSuccess: () => { toast.success('Entry deleted'); setDeleteEntry(null); },
            onError: (e) => toast.error('Could not delete entry', errorMessage(e)),
          });
        }}
      />
      <ConfirmDialog
        open={cancelEventOpen}
        onClose={() => setCancelEventOpen(false)}
        title="Cancel this event?"
        description="The event is marked cancelled and stays in the calendar; the gauges already logged are kept. Events with gauge entries cannot be deleted."
        confirmLabel="Cancel event"
        tone="danger"
        loading={updEvent.isPending}
        onConfirm={() => {
          updEvent.mutate({ id: eventId, status: 'cancelled' }, {
            onSuccess: () => { toast.success('Event cancelled'); setCancelEventOpen(false); },
            onError: (e) => toast.error('Could not cancel event', errorMessage(e)),
          });
        }}
      />
      <ConfirmDialog
        open={deleteEventOpen}
        onClose={() => setDeleteEventOpen(false)}
        title="Delete this event?"
        description="The event will be removed for everyone. Consider marking it cancelled instead."
        confirmLabel="Delete event"
        tone="danger"
        loading={delEvent.isPending}
        onConfirm={() => {
          delEvent.mutate(eventId, {
            onSuccess: () => { toast.success('Event deleted'); navigate('/events', { replace: true }); },
            onError: (e) => { setDeleteEventOpen(false); toast.error('Could not delete event', errorMessage(e)); },
          });
        }}
      />
    </>
  );
}

interface NotLoggedYetProps {
  loading: boolean;
  people: UserWithTeam[];
  teamSize: number;
  onLog: (person: UserWithTeam) => void;
}

/** "Not logged yet": one tap on a person opens Log gauges for them; their chip goes once the entry is saved. */
function NotLoggedYet({ loading, people, teamSize, onLog }: NotLoggedYetProps) {
  if (loading) return <Skeleton className="h-16 max-w-2xl" />;
  if (!teamSize) return null;
  if (!people.length) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        Everyone on the team has logged this event ({formatNumber(teamSize)} / {formatNumber(teamSize)}).
      </p>
    );
  }
  return (
    <section aria-labelledby="not-logged-yet" className="rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
      <h2 id="not-logged-yet" className="text-sm font-semibold text-fg">
        Not logged yet <span className="font-normal text-muted">· {formatNumber(teamSize - people.length)} / {formatNumber(teamSize)} logged</span>
      </h2>
      <p className="mt-0.5 text-xs text-muted">Tap a name to log their day for them.</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {people.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              onClick={() => onLog(u)}
              aria-label={`Log for ${fullName(u)}`}
              className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 text-sm font-medium text-fg shadow-sm transition hover:border-border-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar name={fullName(u)} color={u.avatarColor} size="sm" />
              <span>Log for {people.some((o) => o.id !== u.id && o.firstName === u.firstName) ? `${u.firstName} ${u.lastName.slice(0, 1)}.` : u.firstName}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
