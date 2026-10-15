import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Clock, MapPin, Pencil, PlusCircle, Trash2, Users } from 'lucide-react';
import type { GaugeEntryWithMeta } from '@lm/shared';
import { funnelRatios } from '@lm/shared';
import { Badge, Button, Card, CardHeader, PageHeader, Skeleton, useToast } from '@/components/ui';
import { FunnelChart } from '@/components/charts';
import { useDeleteEvent, useDeleteGauge, useEvent } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ConfirmDialog, ErrorState, EventStatusBadge, EventTypeBadge, KpiSkeletons, errorMessage } from '@/features/common';
import { EventFormModal } from '@/features/events';
import { GaugeEntriesTable, LogGaugesModal, TotalsKpis } from '@/features/gauges';
import { formatDate, formatNumber, formatTime } from '@/lib/format';
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
  const [editEntry, setEditEntry] = useState<GaugeEntryWithMeta | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<GaugeEntryWithMeta | null>(null);
  const [deleteEventOpen, setDeleteEventOpen] = useState(false);
  const delEvent = useDeleteEvent();
  const delGauge = useDeleteGauge();

  const canEdit = me.role === 'admin' || (me.role === 'leader' && ev?.teamId === me.teamId);
  const canManageGauges = me.role === 'admin' || me.role === 'leader';
  const canLog = me.role !== 'recruiter';

  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage />;

  const ratios = ev ? ev.ratios ?? funnelRatios(ev.totals) : null;
  const myEntry = ev?.entries.find((e) => e.userId === me.id) ?? null;

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
              <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden />{ev.venue}, {ev.city}</span>
              <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" aria-hidden />{formatNumber(ev.repCount)} rep{ev.repCount === 1 ? '' : 's'}</span>
            </span>
          ) : undefined
        }
        actions={
          ev ? (
            <>
              {canLog && (
                <Button onClick={() => { setEditEntry(myEntry); setLogOpen(true); }} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />}>
                  {myEntry ? 'Update my gauges' : 'Log gauges'}
                </Button>
              )}
              {canEdit && <Button variant="outline" onClick={() => setEditOpen(true)} leftIcon={<Pencil className="h-4 w-4" aria-hidden />}>Edit</Button>}
              {me.role === 'admin' && <Button variant="ghost" className="text-danger" onClick={() => setDeleteEventOpen(true)} leftIcon={<Trash2 className="h-4 w-4" aria-hidden />} aria-label="Delete event">Delete</Button>}
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

          {ev && ratios ? <TotalsKpis totals={ev.totals} ratios={ratios} days={ev.repCount} /> : <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"><KpiSkeletons count={6} /></div>}

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
              <div className="p-5 pb-3"><CardHeader title="Gauges by rep" description="Each person's day, with check-in punctuality" className="mb-0" /></div>
              <GaugeEntriesTable
                rows={ev?.entries ?? []}
                loading={q.isLoading}
                showEvent={false}
                showDate={false}
                onEdit={canManageGauges || !!myEntry ? (row) => { setEditEntry(row); setLogOpen(true); } : undefined}
                onDelete={canManageGauges ? (row) => setDeleteEntry(row) : undefined}
                canEditRow={(row) => canManageGauges || row.userId === me.id}
                emptyMessage="No gauges logged for this event yet"
                bare className="border-t border-border"
              />
            </Card>
          </div>
        </div>
      )}

      {ev && canLog && <LogGaugesModal open={logOpen} onClose={() => { setLogOpen(false); setEditEntry(null); }} event={ev} entry={editEntry} defaultUserId={me.id} />}
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
        open={deleteEventOpen}
        onClose={() => setDeleteEventOpen(false)}
        title="Delete this event?"
        description="The event and its gauge entries will be removed for everyone. Consider marking it cancelled instead."
        confirmLabel="Delete event"
        tone="danger"
        loading={delEvent.isPending}
        onConfirm={() => {
          delEvent.mutate(eventId, {
            onSuccess: () => { toast.success('Event deleted'); navigate('/events', { replace: true }); },
            onError: (e) => toast.error('Could not delete event', errorMessage(e)),
          });
        }}
      />
    </>
  );
}
