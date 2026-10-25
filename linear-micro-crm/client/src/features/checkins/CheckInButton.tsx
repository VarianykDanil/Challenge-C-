// Release 1.2 — OWNED BY U4 check-ins. One-tap "Check in" for the signed-in person at `event`.
//
// The server stamps the business time; the button then reads "Checked in 09:24 · on time" or "· 6 min late" (the
// existing 5-minute grace rule) with Undo for 2 minutes. Without signal (the browser is offline, or POST /checkins
// throws a NetworkError) the tap is kept on this phone with the time it was tapped (features/checkins/outbox.ts) and
// reads "saved on this phone"; CheckInOutboxReplay sends it from any page. A check-in never logs gauges.
// Mounted, each in an ErrorBoundary with fallback={null}:
//  - pages/QuickGauges.tsx header (variant 'compact'): a 40 px button — the header is tight on a phone, so below
//    640 px and held sideways it is an icon (the event's name keeps the width); tapping a check-in that is done
//    shows its time (and Undo) in a toast;
//  - features/dashboard/UpcomingEvents.tsx under every row dated today, and the event page's roll call card
//    (variant 'row'): the button with the start time, then the status line with Undo.
// It renders nothing unless it applies: a rep / leader (or admin) of the event's team, today, not cancelled, and —
// until checked in — before the event's end time.
import { CheckCircle2, MapPinCheck, Smartphone, Undo2 } from 'lucide-react';
import clsx from 'clsx';
import type { SalesEventWithMeta } from '@lm/shared';
import { LATE_GRACE_MINUTES, shiftCheckInClock, shiftCheckInLabel, shiftCheckInStatusText, shiftCheckInWindow } from '@lm/shared';
import { Button, useToast } from '@/components/ui';
import { ApiError, isNetworkError } from '@/api/client';
import { useCheckIn, useUndoCheckIn } from '@/api/checkins';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common/QueryStates';
import { discardQueuedCheckIn, enqueueCheckIn, phoneNow, queuedLabel } from './outbox';
import { useBefore, useShiftCheckIn, useTicker } from './useShiftCheckIn';

export interface CheckInButtonProps {
  event: SalesEventWithMeta;
  variant?: 'compact' | 'row';
  className?: string;
}

const two = (n: number) => String(n).padStart(2, '0');
const localToday = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const localHHMM = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** Who checks in at this event: reps and leaders of its team (and an admin who belongs to it), as the API allows. */
export function checksInAt(me: { role: string; teamId: number | null }, event: { teamId: number }): boolean {
  return (me.role === 'rep' || me.role === 'leader' || me.role === 'admin') && me.teamId != null && me.teamId === event.teamId;
}

export function CheckInButton({ event, variant = 'row', className }: CheckInButtonProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const nowMs = useTicker();
  const now = new Date(nowMs);
  const today = localToday(now);
  const nowHHMM = localHHMM(now);
  const applies = checksInAt(me, event) && event.date === today && event.status !== 'cancelled';
  const win = shiftCheckInWindow(event, today, nowHHMM);
  const { current, loading, undoDeadline } = useShiftCheckIn({ eventId: event.id, date: event.date, startTime: event.startTime, userId: me.id, meId: me.id, enabled: applies });
  const canUndoServer = useBefore(current?.where === 'server' ? undoDeadline : null);
  const checkIn = useCheckIn();
  const undo = useUndoCheckIn();

  if (!applies || loading) return null;
  if (!current && win !== 'open') return null;

  const canUndo = current?.where === 'phone' || (current?.where === 'server' && canUndoServer);
  const compact = variant === 'compact';

  /** `signedOut`: release 1.4 — the session ended as this was sent (14 hours after sign-in); it sends after the next sign-in. */
  const keepOnPhone = (tappedAt: string, signedOut = false) => {
    const item = enqueueCheckIn(me.id, { eventId: event.id, date: event.date, checkedInAt: tappedAt, eventName: event.name, startTime: event.startTime });
    if (!item) {
      toast.error('Could not check in', signedOut ? 'You were signed out, and this phone couldn’t keep it. Sign in again and tap again.' : "No signal, and this phone couldn't keep it. Try again when you're back online.");
      return;
    }
    if (signedOut) toast.info('Check-in saved on this phone', `${queuedLabel(item)}. It sends after you sign in again.`);
    else toast.info('No signal — check-in saved on this phone', `${queuedLabel(item)}. It sends when you're back online.`);
  };

  const tap = async () => {
    const tappedAt = phoneNow();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      keepOnPhone(tappedAt);
      return;
    }
    try {
      const r = await checkIn.mutateAsync({ eventId: event.id, source: compact ? 'quick' : 'button' });
      const label = shiftCheckInLabel(r.checkIn.checkedInAt, r.checkIn);
      if (!r.created) toast.info('You were already checked in', `${event.name} · ${label}`);
      else if (compact) toast.success(label, event.name);
    } catch (e) {
      if (isNetworkError(e)) keepOnPhone(tappedAt);
      else if (e instanceof ApiError && e.status === 401) keepOnPhone(tappedAt, true); // release 1.4: signed out as it was sent
      else toast.error('Could not check in', errorMessage(e));
    }
  };

  const undoIt = async () => {
    if (!current) return;
    if (current.where === 'phone') {
      discardQueuedCheckIn(me.id, event.id, event.date);
      toast.info('Check-in undone', 'It was removed from this phone before it was sent.');
      return;
    }
    try {
      await undo.mutateAsync({ id: current.server!.id, eventId: event.id });
      toast.info('Check-in undone', event.name);
    } catch (e) {
      toast.error('Could not undo the check-in', errorMessage(e));
    }
  };

  const late = !!current && !current.onTime;
  const onPhone = current?.where === 'phone';

  // ── Quick gauges header ──────────────────────────────────────────────────────────────────────────────────────
  if (compact) {
    if (!current) {
      return (
        <Button
          variant="soft"
          onClick={() => void tap()}
          loading={checkIn.isPending}
          leftIcon={<MapPinCheck className="h-4 w-4" aria-hidden />}
          className={clsx('max-sm:w-10 max-sm:px-0 short:w-10 short:px-0', className)}
          data-checkin-button="compact"
          title={`Check in at ${event.name}`}
        >
          <span className="sr-only sm:not-sr-only short:sr-only">Check in</span>
        </Button>
      );
    }
    const Icon = onPhone ? Smartphone : CheckCircle2;
    return (
      <button
        type="button"
        onClick={() =>
          toast.toast({
            tone: onPhone ? 'info' : late ? 'warning' : 'success',
            title: current.label,
            description: onPhone ? "Saved on this phone — it sends when you're back online." : event.name,
            action: canUndo ? { label: 'Undo', onClick: () => void undoIt() } : undefined,
            duration: canUndo ? 8000 : 4000,
          })
        }
        className={clsx(
          'focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold tabular-nums transition-colors max-sm:w-10 max-sm:px-0 short:w-10 short:px-0',
          onPhone ? 'bg-info-soft text-info' : late ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success',
          className,
        )}
        aria-label={`${current.label}${onPhone ? ', saved on this phone' : ''}`}
        title={current.label}
        data-checkin-button="compact"
        data-checkin-state={onPhone ? 'phone' : late ? 'late' : 'on-time'}
      >
        <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
        <span className="hidden sm:inline short:hidden">{current.checkedInAt.slice(11, 16)}</span>
      </button>
    );
  }

  // ── Dashboard row / roll call ────────────────────────────────────────────────────────────────────────────────
  if (!current) {
    const started = nowHHMM >= event.startTime.slice(0, 5);
    return (
      <div className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1', className)} data-checkin-button="row">
        <Button variant="soft" onClick={() => void tap()} loading={checkIn.isPending} leftIcon={<MapPinCheck className="h-4 w-4" aria-hidden />} className="h-10 sm:h-8 sm:px-3">
          Check in
        </Button>
        <span className="text-xs text-muted">
          {started ? `Started ${event.startTime.slice(0, 5)}` : `Starts ${event.startTime.slice(0, 5)} · ${LATE_GRACE_MINUTES} min grace`}
        </span>
      </div>
    );
  }
  const Icon = onPhone ? Smartphone : CheckCircle2;
  const status = shiftCheckInStatusText(current);
  return (
    <div className={clsx('flex flex-wrap items-center gap-x-2 gap-y-1', className)} data-checkin-button="row" data-checkin-state={onPhone ? 'phone' : late ? 'late' : 'on-time'}>
      <span className={clsx('inline-flex min-h-8 items-center gap-1.5 text-sm font-medium', onPhone ? 'text-info' : late ? 'text-warning' : 'text-success')}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {/* current.label, with "on time" / "5 h 48 min late" kept on one line when a narrow phone wraps it */}
        <span>
          Checked in {shiftCheckInClock(current.checkedInAt)}
          {status && <> · <span className="whitespace-nowrap">{status}</span></>}
        </span>
      </span>
      {onPhone && <span className="text-xs text-muted">saved on this phone, sends when the signal is back</span>}
      {canUndo && (
        <Button variant="ghost" onClick={() => void undoIt()} loading={undo.isPending} leftIcon={<Undo2 className="h-4 w-4" aria-hidden />} className="h-10 sm:h-8 sm:px-2.5">
          Undo
        </Button>
      )}
    </div>
  );
}
