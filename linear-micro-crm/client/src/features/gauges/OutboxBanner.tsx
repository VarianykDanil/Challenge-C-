// Outbox banner — OWNED BY p7-signal-proof-logging. Mounted by AppShell under the topbar (inside an ErrorBoundary
// with fallback={null}), for the signed-in person only.
//
// "2 entries waiting to send · Send now". Items that need a look (review: Linear Hub already has a different entry for
// that day, or no longer has the entry the person changed; failed: Linear Hub refused it) open a sheet with "Send mine anyway", "Open" and "Discard". It also drives
// the replay: on mount (after sign-in), on the browser's 'online' event, when lm:network comes back online, and on
// "Send now".
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CloudUpload, Send } from 'lucide-react';
import { format } from 'date-fns';
import type { UserWithTeam } from '@lm/shared';
import { Badge, Button, Modal, useToast } from '@/components/ui';
import { NETWORK_EVENT, type NetworkEventDetail } from '@/api/client';
import { useEvent } from '@/api/hooks';
import { formatDateShort } from '@/lib/format';
import { discardOutboxItem, entriesLabel, getOutbox, replayAll, sendAnyway, useOutbox, useReplaying, type OutboxItem, type ReplayReport, type SentOutcome } from './outbox';

// The modal is only needed when someone taps "Open": keep it out of the shell's first download.
const LogGaugesModal = lazy(() => import('./LogGaugesModal').then((m) => ({ default: m.LogGaugesModal })));

const OUTCOME_LABEL: Record<SentOutcome, string> = {
  logged: 'logged',
  updated: 'updated your earlier entry',
  already: 'it was already on Linear Hub',
};

/** "14:02" today, "Mon 14:02" otherwise. */
function whenLabel(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString() ? format(d, 'HH:mm') : format(d, 'EEE d MMM, HH:mm');
}

/** The one-line reason under "N entries need a look before sending". */
function reviewSummary(r: ReplayReport): string {
  if (!r.review.length) return 'Linear Hub did not accept it.';
  const gone = r.review.filter((i) => !i.server).length;
  if (gone === 0) return 'Linear Hub already has a different entry for that day.';
  if (gone === r.review.length) return 'Linear Hub no longer has the entry you changed — it may have been deleted.';
  return 'Linear Hub has changed those days since you saved.';
}

export interface OutboxBannerProps {
  user: UserWithTeam;
}

export function OutboxBanner({ user }: OutboxBannerProps) {
  const items = useOutbox(user.id);
  const replaying = useReplaying();
  const toast = useToast();
  const qc = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openItem, setOpenItem] = useState<OutboxItem | null>(null);
  // The "needs a look" toast sits above the sheet on a phone: opening the sheet dismisses it.
  const attentionToast = useRef<number | null>(null);
  const openSheet = useCallback(() => {
    if (attentionToast.current != null) toast.dismiss(attentionToast.current);
    attentionToast.current = null;
    setSheetOpen(true);
  }, [toast]);

  const report = useCallback(
    (r: ReplayReport, manual: boolean) => {
      if (r.sent.length) {
        // Everything that shows gauges is refetched (same set as a save from the form).
        for (const key of [['gauges'], ['events'], ['dashboard'], ['leaderboard'], ['users', 'performance'], ['finance']]) void qc.invalidateQueries({ queryKey: key });
        const describe = (i: OutboxItem) => `${i.eventName} · ${formatDateShort(i.input.date)}${i.input.userId !== user.id ? ` · ${i.userName}` : ''}`;
        if (r.sent.length === 1) {
          const s = r.sent[0]!;
          toast.success(`Sent from this phone — ${OUTCOME_LABEL[s.outcome]}`, describe(s.item));
        } else {
          const counts = (['logged', 'updated', 'already'] as const).map((o) => [o, r.sent.filter((s) => s.outcome === o).length] as const).filter(([, n]) => n > 0);
          toast.success(`${entriesLabel(r.sent.length)} sent from this phone`, counts.map(([o, n]) => `${n} ${OUTCOME_LABEL[o]}`).join(' · '));
        }
      }
      const attention = r.review.length + r.failed.length;
      if (attention) {
        if (attentionToast.current != null) toast.dismiss(attentionToast.current);
        attentionToast.current = toast.toast({
          tone: 'warning',
          title: `${entriesLabel(attention)} need${attention === 1 ? 's' : ''} a look before sending`,
          description: reviewSummary(r),
          action: { label: 'Review', onClick: openSheet },
          duration: 8000,
        });
      }
      if (manual && r.stopped === 'network') toast.error("Still can't reach Linear Hub", 'Your entries stay on this phone and send when the signal is back.');
      if (manual && r.stopped === 'server') toast.error('Linear Hub had a problem', 'Your entries stay on this phone; try again in a minute.');
    },
    [qc, toast, user.id, openSheet],
  );

  const replay = useCallback(
    async (manual: boolean) => {
      if (!manual && !getOutbox(user.id).some((i) => i.status === 'waiting')) return;
      if (!manual && typeof navigator !== 'undefined' && navigator.onLine === false) return;
      report(await replayAll(user.id), manual);
    },
    [user.id, report],
  );

  // Replay triggers: mounting after sign-in, the browser coming back online, and the first answer after a failure.
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

  const waiting = items.filter((i) => i.status === 'waiting').length;
  const attention = items.length - waiting;

  // Open: the modal starts from the kept values, for that event (fetched so the event is fixed; without signal the
  // picker preselects it from what the phone has loaded).
  const openEvent = useEvent(openItem?.input.eventId);
  const openReady = !!openItem && (!!openEvent.data || openEvent.isError || openEvent.fetchStatus === 'paused');

  return (
    <>
      {items.length > 0 && (
        <div data-outbox-banner className="border-b border-info/30 bg-info-soft px-4 py-1.5 sm:px-6 sm:py-2 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3">
            <CloudUpload className="h-5 w-5 shrink-0 text-info" aria-hidden />
            {/* The summary itself opens the list (a 40 px target), so a phone needs only one more button. */}
            <button
              type="button"
              onClick={openSheet}
              aria-haspopup="dialog"
              className="focus-ring -my-1 flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-md text-left text-[13px] leading-snug text-fg hover:underline sm:text-sm"
            >
              <span className="min-w-0">
                {waiting > 0 && <span className="font-semibold">{entriesLabel(waiting)} waiting to send</span>}
                {waiting > 0 && attention > 0 && <span className="text-muted"> · </span>}
                {attention > 0 && <span className={waiting > 0 ? 'text-muted' : 'font-semibold'}>{entriesLabel(attention)} need{attention === 1 ? 's' : ''} a look</span>}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </button>
            <div className="flex shrink-0 items-center gap-2">
              {attention > 0 && <Button variant="outline" onClick={openSheet}>Review</Button>}
              {waiting > 0 && (
                <Button onClick={() => void replay(true)} loading={replaying} leftIcon={<Send className="h-4 w-4" aria-hidden />}>
                  Send now
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Saved on this phone"
        description="Gauges kept here while Linear Hub couldn't be reached. Waiting entries send by themselves when the signal is back."
        size="md"
      >
        {items.length === 0 ? (
          <p className="text-sm text-muted">Nothing left on this phone — everything has been sent.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <OutboxRow
                key={item.id}
                item={item}
                meId={user.id}
                busy={replaying}
                onSend={async () => report(await sendAnyway(user.id, item.id), true)}
                onOpen={() => {
                  setSheetOpen(false);
                  setOpenItem(item);
                }}
                onDiscard={() => {
                  discardOutboxItem(user.id, item.id);
                  toast.info('Discarded', `${item.eventName} · ${formatDateShort(item.input.date)} was removed from this phone.`);
                }}
              />
            ))}
          </ul>
        )}
      </Modal>

      {openItem && openReady && (
        <Suspense fallback={null}>
          <LogGaugesModal
            open
            onClose={() => setOpenItem(null)}
            event={openEvent.data ?? undefined}
            prefill={{
              gauges: openItem.input,
              eventId: openItem.input.eventId,
              userId: openItem.input.userId,
              checkedInAt: openItem.input.checkedInAt ?? undefined,
              notes: openItem.input.notes ?? undefined,
            }}
            // A save from the form replaces the kept copy (a new outbox item for the same day replaces it too).
            onSaved={() => discardOutboxItem(user.id, openItem.id)}
          />
        </Suspense>
      )}
    </>
  );
}

interface OutboxRowProps {
  item: OutboxItem;
  meId: number;
  busy: boolean;
  onSend: () => Promise<void>;
  onOpen: () => void;
  onDiscard: () => void;
}

function OutboxRow({ item, meId, busy, onSend, onOpen, onDiscard }: OutboxRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const { input } = item;
  const checkIn = input.checkedInAt ? input.checkedInAt.slice(11, 16) : null;
  const status = item.status === 'review' ? { tone: 'warning' as const, label: 'Needs a look' } : item.status === 'failed' ? { tone: 'danger' as const, label: 'Not accepted' } : { tone: 'info' as const, label: 'Waiting' };

  return (
    <li className="rounded-xl border border-border bg-surface p-3" data-outbox-item={item.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{item.eventName}</p>
          <p className="text-xs text-muted">
            {formatDateShort(input.date)}
            {input.userId !== meId && <> · for {item.userName}</>} · saved {whenLabel(item.queuedAt)}
          </p>
        </div>
        <Badge tone={status.tone} className="shrink-0">{status.label}</Badge>
      </div>
      <p className="mt-2 text-sm text-fg">
        <span className="font-semibold tabular-nums">{input.stops}</span> stops · <span className="font-semibold tabular-nums">{input.sales}</span> sale{input.sales === 1 ? '' : 's'}
        {checkIn && <span className="text-muted"> · checked in {checkIn}</span>}
      </p>
      {item.status === 'review' && item.server && (
        <p className="mt-2 rounded-lg bg-warning-soft p-2 text-sm text-fg">
          Linear Hub already has a different entry for this day: {item.server.stops} stops · {item.server.sales} sale{item.server.sales === 1 ? '' : 's'}, saved {whenLabel(item.server.submittedAt)}. Sending yours replaces it.
        </p>
      )}
      {item.status === 'review' && !item.server && (
        <p className="mt-2 rounded-lg bg-warning-soft p-2 text-sm text-fg">
          Linear Hub no longer has the entry you changed — it may have been deleted. Sending yours logs this day again.
        </p>
      )}
      {item.status === 'failed' && <p className="mt-2 rounded-lg bg-danger-soft p-2 text-sm text-fg">Linear Hub didn&apos;t accept it: {item.error ?? 'no reason given'}</p>}
      {item.status === 'waiting' && item.error && <p className="mt-2 text-xs text-muted">{item.error}</p>}

      {confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft p-2">
          <span className="min-w-0 flex-1 text-sm text-fg">Discard it? It isn&apos;t on Linear Hub, so these numbers will be gone.</span>
          <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
          <Button variant="danger" onClick={onDiscard}>Discard</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.status !== 'waiting' && (
            <Button
              loading={sending}
              disabled={busy && !sending}
              onClick={async () => {
                setSending(true);
                try {
                  await onSend();
                } finally {
                  setSending(false);
                }
              }}
            >
              Send mine anyway
            </Button>
          )}
          <Button variant="outline" onClick={onOpen}>Open</Button>
          <Button variant="ghost" onClick={() => setConfirming(true)}>Discard</Button>
        </div>
      )}
    </li>
  );
}
