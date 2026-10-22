// Release 1.3 slot — OWNED BY P8 venue-insights. EventDetail → "Who's working": who is booked, the leader's (and the
// admin's) **Edit bookings**, and **I'm working this** / **I can't make it** for the people who can work the event
// (the admin anywhere; a leader or rep of the event's team). Mounted in pages/EventDetail.tsx after the check-in roll
// call, in an ErrorBoundary with fallback={null}. A whole Card or nothing: a finished event nobody was booked on shows
// nothing. The server holds the rules (routes/eventPlans.ts); the page only offers what it will accept.
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { CalendarCheck, CalendarX, Pencil, Users } from 'lucide-react';
import type { EventBooking, SalesEventWithMeta, UserWithTeam } from '@lm/shared';
import { Avatar, Button, Card, CardHeader, Modal, Skeleton, useToast } from '@/components/ui';
import { useUsers } from '@/api/hooks';
import { useBookMyself, useEventRoster, useSaveEventRoster } from '@/api/venues';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common';
import { formatNumber, fullName, pluralise } from '@/lib/format';
import { bookingsOpen } from './venueCopy';

export interface EventRosterCardProps {
  event: SalesEventWithMeta;
  /** The page's own rule: the admin, or the leader of the event's team. */
  canManage: boolean;
  className?: string;
}

/**
 * Who booked a person, in a few words: "booked themselves", "booked by Amelia Hart" — and for the reader's own chip
 * ("You"): "booked yourself", "booked by you" (a leader booking themself from Edit bookings).
 */
function bookedByText(b: EventBooking, meId: number): string {
  const own = b.userId === meId;
  if (b.source === 'self' || b.bookedBy === b.userId) return own ? 'booked yourself' : 'booked themselves';
  if (b.bookedBy === meId) return 'booked by you';
  return b.bookedByName ? `booked by ${b.bookedByName}` : 'booked by the office';
}

/** Why bookings are closed, as its own sentence after the count. */
function closedText(e: Pick<SalesEventWithMeta, 'status'>): string {
  return e.status === 'cancelled' ? 'Bookings are closed: the event was cancelled.' : 'Bookings are closed: the event is over.';
}

export function EventRosterCard({ event, canManage, className }: EventRosterCardProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const q = useEventRoster(event.id);
  const book = useBookMyself(event.id);
  const [editing, setEditing] = useState(false);
  const open = bookingsOpen(event);
  const roster = q.data ?? [];
  const mine = roster.find((b) => b.userId === me.id) ?? null;
  // "I'm working this": the admin on any event; a leader or rep on their own team's events (lib/eventRoster.ts)
  const canBookSelf = me.role === 'admin' || ((me.role === 'leader' || me.role === 'rep') && me.teamId != null && me.teamId === event.teamId);

  if (q.isLoading) return <Skeleton className={clsx('h-24 max-w-3xl', className)} />;
  if (q.isError) return null;
  if (!open && !roster.length) return null;

  const toggleSelf = (booked: boolean) =>
    book.mutate(booked, {
      onSuccess: () => toast.success(booked ? "You're booked on this event" : "You're off this event", booked ? 'Your plan for the day is on this page.' : undefined),
      onError: (e) => toast.error(booked ? 'Could not book you on' : 'Could not take you off', errorMessage(e)),
    });

  const description = roster.length
    ? `${pluralise(roster.length, 'person', 'people')} booked${mine ? ', you included' : ''}.`
    : 'Nobody is booked yet.';

  return (
    <Card className={clsx('max-w-3xl', className)} data-event-roster>
      <CardHeader
        icon={<Users />}
        title="Who's working"
        description={open ? description : `${description} ${closedText(event)}`}
        actions={
          open ? (
            <div className="flex flex-wrap justify-end gap-2">
              {canManage && (
                <Button variant="outline" size="sm" className="max-sm:h-10" onClick={() => setEditing(true)} leftIcon={<Pencil className="h-4 w-4" aria-hidden />}>
                  Edit bookings
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {roster.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Booked">
          {roster.map((b) => (
            <li key={b.userId} className={clsx('inline-flex min-h-10 items-center gap-2 rounded-full border py-1 pl-1 pr-3', b.userId === me.id ? 'border-primary/40 bg-primary-soft' : 'border-border bg-surface')}>
              <Avatar name={b.userName} color={b.avatarColor} size="sm" />
              <span className="flex flex-col leading-tight">
                <span className="text-sm font-medium text-fg">{b.userId === me.id ? 'You' : b.userName}</span>
                <span className="text-[11px] text-muted">
                  {bookedByText(b, me.id)}
                  {b.onLeave && <span className="font-medium text-warning"> · on leave</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && canBookSelf && (
        <div className={clsx('flex flex-wrap items-center gap-3', roster.length > 0 && 'mt-4')}>
          {mine ? (
            <Button variant="ghost" onClick={() => toggleSelf(false)} loading={book.isPending} leftIcon={<CalendarX className="h-4 w-4" aria-hidden />}>
              I can't make it
            </Button>
          ) : (
            <Button onClick={() => toggleSelf(true)} loading={book.isPending} leftIcon={<CalendarCheck className="h-4 w-4" aria-hidden />}>
              I'm working this
            </Button>
          )}
          {!mine && <p className="text-xs text-muted">Book yourself to see your plan: the stops, tables and closes a good day here takes.</p>}
        </div>
      )}
      {canManage && editing && <EditBookingsModal event={event} roster={roster} onClose={() => setEditing(false)} />}
    </Card>
  );
}

interface EditBookingsModalProps {
  event: SalesEventWithMeta;
  roster: EventBooking[];
  onClose: () => void;
}

const FIELD_ROLES = new Set(['admin', 'leader', 'rep']);

/**
 * The leader ticks who is working (their team's active members who had started by the day, and themself); the admin
 * also sees people without a team and other teams. People already booked stay listed, ticked, whoever they are.
 */
function EditBookingsModal({ event, roster, onClose }: EditBookingsModalProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const save = useSaveEventRoster(event.id);
  const isAdmin = me.role === 'admin';
  const users = useUsers(isAdmin ? { status: 'active' } : { teamId: event.teamId, status: 'active' });
  // who was booked when the list opened: the save sends what changed from it, never the whole list (someone who taps
  // "I'm working this" meanwhile stays booked)
  const [opened] = useState<Set<number>>(() => new Set(roster.map((b) => b.userId)));
  const [picked, setPicked] = useState<Set<number>>(() => new Set(opened));

  const groups = useMemo(() => {
    const list = (users.data ?? []).filter((u) => FIELD_ROLES.has(u.role) && u.startDate <= event.date && (isAdmin || u.teamId === event.teamId || u.id === me.id));
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-GB');
    const person = (u: UserWithTeam) => ({ id: u.id, name: fullName(u), color: u.avatarColor, hint: u.teamName ?? 'No team' });
    const team = list.filter((u) => u.teamId === event.teamId).map(person).sort(byName);
    const noTeam = list.filter((u) => u.teamId == null).map(person).sort(byName);
    const other = list.filter((u) => u.teamId != null && u.teamId !== event.teamId).map(person).sort(byName);
    const listed = new Set(list.map((u) => u.id));
    const already = roster.filter((b) => !listed.has(b.userId)).map((b) => ({ id: b.userId, name: b.userName, color: b.avatarColor, hint: 'Booked already' })).sort(byName);
    return [
      { title: event.teamName, people: team },
      { title: 'No team', people: noTeam },
      { title: 'Other teams', people: other },
      { title: 'Booked already', people: already },
    ].filter((g) => g.people.length);
  }, [users.data, roster, event.date, event.teamId, event.teamName, isAdmin, me.id]);

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const teamIds = groups[0]?.title === event.teamName ? groups[0].people.map((p) => p.id) : [];
  const allTeam = teamIds.length > 0 && teamIds.every((id) => picked.has(id));

  const onSave = () =>
    save.mutate({ add: [...picked].filter((id) => !opened.has(id)), remove: [...opened].filter((id) => !picked.has(id)) }, {
      onSuccess: (r) => {
        toast.success('Bookings saved', `${pluralise(r.length, 'person', 'people')} booked`);
        onClose();
      },
      onError: (e) => toast.error('Could not save the bookings', errorMessage(e)),
    });

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit bookings"
      description={`Who is working ${event.name}. Everyone booked sees their plan for the day.`}
      icon={<Users className="h-5 w-5" />}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} loading={save.isPending}>Save bookings ({formatNumber(picked.size)})</Button>
        </>
      }
    >
      {users.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-4">
          {teamIds.length > 1 && (
            <Button
              variant="soft"
              size="sm"
              className="max-sm:h-10"
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  for (const id of teamIds) {
                    if (allTeam) next.delete(id);
                    else next.add(id);
                  }
                  return next;
                })
              }
            >
              {allTeam ? `Untick the ${event.teamName} team` : `Tick the whole ${event.teamName} team`}
            </Button>
          )}
          {groups.map((g) => (
            <fieldset key={g.title}>
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g.title}</legend>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {g.people.map((p) => (
                  <li key={p.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-surface-2">
                      <input
                        type="checkbox"
                        className="focus-ring h-4 w-4 cursor-pointer rounded border-control-border accent-[var(--color-primary)]"
                        checked={picked.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                      <Avatar name={p.name} color={p.color} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{p.id === me.id ? `${p.name} (you)` : p.name}</span>
                      {g.title !== event.teamName && <span className="shrink-0 text-xs text-muted">{p.hint}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}
          {!groups.length && <p className="text-sm text-muted">Nobody on the team can be booked on this day.</p>}
        </div>
      )}
    </Modal>
  );
}
