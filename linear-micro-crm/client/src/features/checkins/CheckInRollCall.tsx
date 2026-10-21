// Release 1.2 — OWNED BY U4 check-ins. The event page's roll call, mounted in pages/EventDetail.tsx under the
// "Not logged yet" card, in an ErrorBoundary with fallback={null}. `canManage` mirrors the page's own rule (admin, or
// the leader of the event's team).
//  - Leader / admin: who of the event's team has checked in and when ("09:24 · on time" / "6 min late", earliest
//    first), who has not yet (today only), and Remove for any of them (the API lets them, any time). A past event
//    shows its check-ins when it has any; a future or cancelled event shows nothing.
//  - Anyone who checks in at the event (a rep or leader of its team): their own check-in — the one-tap button today,
//    or "You checked in 09:24 · on time" afterwards. Nobody ever sees another rep's time unless they manage them.
import { useMemo, useState } from 'react';
import { CheckCircle2, MapPinCheck, Smartphone, X } from 'lucide-react';
import clsx from 'clsx';
import type { SalesEventWithMeta, ShiftCheckIn, UserWithTeam } from '@lm/shared';
import { shiftCheckInClock, shiftCheckInStatusText, shiftCheckInWindow } from '@lm/shared';
import { Avatar, Badge, Button, Skeleton, useToast } from '@/components/ui';
import { useUndoCheckIn } from '@/api/checkins';
import { useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { errorMessage } from '@/features/common/QueryStates';
import { fullName } from '@/lib/format';
import { CheckInButton, checksInAt } from './CheckInButton';
import { useShiftCheckIn, useTicker } from './useShiftCheckIn';

export interface CheckInRollCallProps {
  event: SalesEventWithMeta;
  canManage: boolean;
  className?: string;
}

const two = (n: number) => String(n).padStart(2, '0');
const localToday = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const localHHMM = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

export function CheckInRollCall({ event, canManage, className }: CheckInRollCallProps) {
  const me = useCurrentUser();
  const nowMs = useTicker(30_000);
  const now = new Date(nowMs);
  const today = localToday(now);
  const relevant = event.status !== 'cancelled' && event.date <= today;
  const mine = checksInAt(me, event);
  // Everyone's check-ins the caller may see (the API scopes the list); the hook reads the caller's own from it.
  const own = useShiftCheckIn({ eventId: event.id, date: event.date, startTime: event.startTime, userId: me.id, meId: me.id, enabled: relevant && (canManage || mine) });

  if (!relevant) return null;
  if (canManage) return <TeamRollCall event={event} me={me} today={today} nowHHMM={localHHMM(now)} checkIns={own.query.data?.checkIns} loading={own.query.isPending && own.query.fetchStatus === 'fetching'} ownCheckedIn={!!own.current} className={className} />;
  if (!mine) return null;

  // A rep (or a leader at their team's event without the manage rule, which cannot happen today): their own only.
  const isToday = event.date === today;
  const open = shiftCheckInWindow(event, today, localHHMM(now)) === 'open';
  if (isToday && (own.current || open)) {
    return (
      <section aria-labelledby={`checkin-${event.id}`} className={clsx('rounded-xl border border-border bg-surface p-4 shadow-card', className)} data-roll-call="own">
        <h2 id={`checkin-${event.id}`} className="text-sm font-semibold text-fg">Your check-in</h2>
        <p className="mt-0.5 text-xs text-muted">One tap when you arrive. It records the time — your gauges are logged separately.</p>
        <CheckInButton event={event} variant="row" className="mt-2" />
      </section>
    );
  }
  if (!isToday && own.current) {
    return (
      <p className={clsx('flex items-center gap-1.5 text-sm', own.current.onTime ? 'text-success' : 'text-warning', className)} data-roll-call="own">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        <span>
          You checked in {shiftCheckInClock(own.current.checkedInAt)} · <span className="whitespace-nowrap">{shiftCheckInStatusText(own.current) || 'recorded'}</span>
        </span>
      </p>
    );
  }
  return null;
}

interface TeamRollCallProps {
  event: SalesEventWithMeta;
  me: UserWithTeam;
  today: string;
  nowHHMM: string;
  checkIns: ShiftCheckIn[] | undefined;
  loading: boolean;
  ownCheckedIn: boolean;
  className?: string;
}

function TeamRollCall({ event, me, today, nowHHMM, checkIns, loading, ownCheckedIn, className }: TeamRollCallProps) {
  const toast = useToast();
  const undo = useUndoCheckIn();
  const [removing, setRemoving] = useState<ShiftCheckIn | null>(null);
  const isToday = event.date === today;
  // The same team list the page's "Not logged yet" uses (one shared query).
  const teamQ = useUsers({ teamId: event.teamId, status: 'active' }, { enabled: isToday });

  const { rows, notYet, rosterSize } = useMemo(() => {
    const day = (checkIns ?? []).filter((c) => c.date === event.date);
    const roster = (teamQ.data ?? []).filter((u) => u.teamId === event.teamId && u.startDate <= event.date && (u.role === 'rep' || u.role === 'leader'));
    const byUser = new Map(day.map((c) => [c.userId, c]));
    const colours = new Map((teamQ.data ?? []).map((u) => [u.id, u.avatarColor]));
    return {
      rows: day.map((c) => ({ c, colour: colours.get(c.userId) })),
      notYet: roster.filter((u) => !byUser.has(u.id)).sort((a, b) => fullName(a).localeCompare(fullName(b))),
      rosterSize: roster.length,
    };
  }, [checkIns, teamQ.data, event.date, event.teamId]);

  if (loading) return <Skeleton className={clsx('h-24', className)} />;
  if (!isToday && rows.length === 0) return null;

  const late = rows.filter((r) => !r.c.onTime).length;
  const counted = isToday && rosterSize > 0 ? `${rows.length} / ${rosterSize} checked in` : `${rows.length} checked in`;
  const showOwnButton = isToday && checksInAt(me, event) && !ownCheckedIn;

  const remove = async () => {
    if (!removing) return;
    try {
      await undo.mutateAsync({ id: removing.id, eventId: event.id });
      toast.info('Check-in removed', `${removing.userName ?? 'Their check-in'} · punctuality for that day goes back to the time on the gauges, if any.`);
      setRemoving(null);
    } catch (e) {
      toast.error('Could not remove the check-in', errorMessage(e));
    }
  };

  return (
    <section aria-labelledby={`roll-call-${event.id}`} className={clsx('rounded-xl border border-border bg-surface p-4 shadow-card', className)} data-roll-call="team">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={`roll-call-${event.id}`} className="flex items-center gap-2 text-sm font-semibold text-fg">
            <MapPinCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            Roll call
            <span className="font-normal text-muted">
              · {counted}
              {late > 0 && ` · ${late} late`}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {/* review 1.2 S3: a time a leader or admin records on someone's gauges counts over their check-in */}
            {isToday
              ? 'One-tap check-ins as people arrive. Punctuality uses these times unless you record someone’s arrival time on their gauges. Gauges are logged separately.'
              : 'One-tap check-ins at this event. Punctuality uses these times, except where a leader recorded someone’s arrival time on their gauges.'}
          </p>
        </div>
        {showOwnButton && <CheckInButton event={event} variant="row" />}
      </div>

      {rows.length > 0 ? (
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" data-roll-call-list>
          {rows.map(({ c, colour }) => {
            const status = shiftCheckInStatusText(c);
            return (
              <li key={c.id} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-surface-2/50 py-1 pl-2 pr-1" data-roll-call-row={c.onTime ? 'on-time' : 'late'}>
                <Avatar name={c.userName ?? 'Someone'} color={colour} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    {c.userName ?? 'Someone'}
                    {c.userId === me.id && <span className="font-normal text-muted"> (you)</span>}
                  </p>
                  {/* UI QA 1.2 #5: the line wraps rather than cutting "sent later" short (a long "5 h 48 min late" badge
                      and the tag do not fit beside the time in a 320–375 px row). */}
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted" data-roll-call-status>
                    <span className="font-semibold tabular-nums text-fg">{shiftCheckInClock(c.checkedInAt)}</span>
                    {status && <Badge tone={c.onTime ? 'success' : 'warning'} size="sm">{status}</Badge>}
                    {c.source === 'offline' && (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap" title="Tapped without signal; the phone sent it later with the time it was tapped (never earlier than an hour before the start)" data-roll-call-sent-later>
                        <Smartphone className="h-3 w-3 shrink-0" aria-hidden />
                        sent later
                      </span>
                    )}
                  </p>
                </div>
                <Button variant="ghost" size="icon" label={`Remove ${c.userName ?? 'this'} check-in`} onClick={() => setRemoving(c)}>
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">Nobody has checked in yet{nowHHMM < event.startTime.slice(0, 5) ? ` — the event starts at ${event.startTime.slice(0, 5)}` : ''}.</p>
      )}

      {isToday && notYet.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted">Not checked in yet</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5" data-roll-call-missing>
            {notYet.map((u) => (
              <li key={u.id} className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-fg">
                <Avatar name={fullName(u)} color={u.avatarColor} size="xs" />
                {notYet.some((o) => o.id !== u.id && o.firstName === u.firstName) ? `${u.firstName} ${u.lastName.slice(0, 1)}.` : u.firstName}
              </li>
            ))}
          </ul>
        </div>
      )}
      {isToday && teamQ.isPending && teamQ.fetchStatus === 'fetching' && <Skeleton className="mt-3 h-8 w-2/3" />}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        tone="danger"
        loading={undo.isPending}
        title={removing ? `Remove ${removing.userId === me.id ? 'your' : `${removing.userName ?? 'this'}’s`} check-in?` : 'Remove check-in?'}
        description={removing ? `${shiftCheckInClock(removing.checkedInAt)} at ${event.name}. Punctuality for this day goes back to the time on the gauges, if any. Gauges and pay are not affected.` : undefined}
        confirmLabel="Remove"
      />
    </section>
  );
}
