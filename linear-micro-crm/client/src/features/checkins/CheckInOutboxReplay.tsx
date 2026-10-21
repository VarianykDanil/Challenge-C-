// Release 1.2 — OWNED BY U4 check-ins. Mounted once in components/layout/AppShell.tsx (the sticky banner row under the
// topbar, after the gauge OutboxBanner), in an ErrorBoundary with fallback={null}.
//
// Sends the one-tap check-ins kept on this phone (features/checkins/outbox.ts, key 'lm-checkin-outbox:<userId>'),
// from ANY page: on mount, on the window 'online' event and when api/client.ts announces the server is reachable
// again (NETWORK_EVENT going from offline to online — not on every answer, so a server error can never loop),
// single-flight. While something waits it shows one slim line ("1 check-in waiting to send · Send now"); a check-in
// Linear Hub refused (the event was cancelled, it reached Linear Hub more than 24 hours after the event ended…) stays
// listed with Linear Hub's reason, word for word, until dismissed.
// Kept small: it is part of the always-loaded shell (no date library).
import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, MapPinCheck, Send, X } from 'lucide-react';
import type { UserWithTeam } from '@lm/shared';
import { shiftCheckInLabel } from '@lm/shared';
import { Button, useToast } from '@/components/ui';
import { NETWORK_EVENT, type NetworkEventDetail } from '@/api/client';
import { checkinKeys, rememberCheckIn } from '@/api/checkins';
import { checkInsLabel, discardQueuedCheckIn, getCheckInOutbox, queuedLabel, replayCheckIns, useCheckInOutbox, type CheckInReplayReport } from './outbox';

export interface CheckInOutboxReplayProps {
  user: UserWithTeam;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "14 Oct" from "YYYY-MM-DD". */
function dayMonth(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1] ?? ''}` : iso;
}

export function CheckInOutboxReplay({ user }: CheckInOutboxReplayProps) {
  const items = useCheckInOutbox(user.id);
  const qc = useQueryClient();
  const toast = useToast();

  const report = useCallback(
    (r: CheckInReplayReport, manual: boolean) => {
      for (const s of r.sent) rememberCheckIn(qc, s.checkIn);
      if (r.sent.length) {
        void qc.invalidateQueries({ queryKey: checkinKeys.all });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
        if (r.sent.length === 1) {
          const s = r.sent[0]!;
          const label = shiftCheckInLabel(s.checkIn.checkedInAt, s.checkIn);
          toast.success(s.already ? 'You were already checked in' : 'Check-in sent from this phone', `${s.item.eventName} · ${label}`);
        } else {
          toast.success(`${checkInsLabel(r.sent.length)} sent from this phone`, r.sent.map((s) => s.item.eventName).join(' · '));
        }
      }
      if (r.failed.length) {
        toast.toast({
          tone: 'warning',
          title: r.failed.length === 1 ? 'A check-in was not accepted' : `${checkInsLabel(r.failed.length)} were not accepted`,
          description: r.failed[0]!.error ?? 'Linear Hub did not accept it.',
          duration: 8000,
        });
      }
      if (manual && r.stopped === 'network') toast.error("Still can't reach Linear Hub", 'Your check-in stays on this phone and sends when the signal is back.');
      if (manual && r.stopped === 'server') toast.error('Linear Hub had a problem', 'Your check-in stays on this phone; try again in a minute.');
    },
    [qc, toast],
  );

  const replay = useCallback(
    async (manual: boolean) => {
      if (!getCheckInOutbox(user.id).some((i) => i.status === 'waiting')) return;
      if (!manual && typeof navigator !== 'undefined' && navigator.onLine === false) return;
      report(await replayCheckIns(user.id), manual);
    },
    [user.id, report],
  );

  useEffect(() => {
    void replay(false);
    let lastOnline = true;
    const onOnline = () => void replay(false);
    const onNetwork = (e: Event) => {
      const online = !!(e as CustomEvent<NetworkEventDetail>).detail?.online;
      if (online && !lastOnline) void replay(false);
      lastOnline = online;
    };
    window.addEventListener('online', onOnline);
    window.addEventListener(NETWORK_EVENT, onNetwork);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener(NETWORK_EVENT, onNetwork);
    };
  }, [replay]);

  const waiting = items.filter((i) => i.status === 'waiting');
  const failed = items.filter((i) => i.status === 'failed');
  if (!items.length) return null;

  return (
    <div data-checkin-outbox className="border-b border-info/30 bg-info-soft px-4 py-1.5 sm:px-6 sm:py-2 lg:px-8">
      <div className="mx-auto max-w-[1440px] space-y-1">
        {waiting.length > 0 && (
          <div className="flex items-center gap-3" data-checkin-outbox-waiting>
            <MapPinCheck className="h-5 w-5 shrink-0 text-info" aria-hidden />
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg sm:text-sm">
              <span className="font-semibold">{checkInsLabel(waiting.length)} waiting to send</span>
              <span className="text-muted">
                {' '}
                · {waiting.length === 1 ? `${waiting[0]!.eventName}, ${queuedLabel(waiting[0]!).replace('Checked in', 'tapped')}` : waiting.map((i) => i.eventName).join(', ')}
              </span>
            </p>
            <Button variant="outline" className="shrink-0" onClick={() => void replay(true)} leftIcon={<Send className="h-4 w-4" aria-hidden />}>
              Send now
            </Button>
          </div>
        )}
        {failed.slice(0, 3).map((i) => (
          <div key={`${i.eventId}|${i.date}`} className="flex items-center gap-3" data-checkin-outbox-failed>
            <AlertTriangle className="h-5 w-5 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg sm:text-sm">
              <span className="font-semibold">Check-in not accepted</span>
              <span className="text-muted"> · {i.eventName}, {dayMonth(i.date)}: {i.error ?? 'Linear Hub did not accept it.'}</span>
            </p>
            <Button
              variant="ghost"
              size="icon"
              label={`Dismiss the check-in for ${i.eventName}`}
              onClick={() => discardQueuedCheckIn(user.id, i.eventId, i.date)}
            >
              <X aria-hidden />
            </Button>
          </div>
        ))}
        {failed.length > 3 && <p className="pl-8 text-xs text-muted">and {checkInsLabel(failed.length - 3)} more</p>}
      </div>
    </div>
  );
}
