// Live tally counter for a shift — OWNED BY p7-signal-proof-logging (lead's addition).
// Loaded on demand: pages mount it through LazyTallyMode (TallyLinks.tsx, with TallyButton and TodayTallyLink), never
// import it directly. The counts live in localStorage per (userId, eventId, date) (tallyStore.ts), so they survive
// reloads and dropped signal; "Finish shift" opens LogGaugesModal prefilled — rendered by TallyMode itself — so saving
// goes through the same validation and the outbox. The tally is cleared once the save succeeds (or is kept on the phone
// by the outbox).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Maximize2, Minus, Tally5, X } from 'lucide-react';
import type { SalesEventWithMeta } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, tallyStep } from '@lm/shared';
import { Button, Card, Skeleton } from '@/components/ui';
import { useCurrentUser } from '@/auth/AuthProvider';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatTime } from '@/lib/format';
import { actionHref } from '@/lib/useActionParam';
import { LogGaugesModal } from './LogGaugesModal';
import { TallyEventPicker } from './TallyEventPicker';
import { useStoredTallies } from './tallyStore';
import type { TallyRequest } from './TallyLinks';
import { defaultEvent, useTallyCounter, useTallyEvents } from './useTallyCounter';

export interface TallyModeProps {
  /** Non-null while the tally should be open. */
  request: TallyRequest | null;
  onClose: () => void;
}

export function TallyMode({ request, onClose }: TallyModeProps) {
  if (!request) return null;
  return <TallyPanel request={request} onClose={onClose} />;
}

function TallyPanel({ request, onClose }: { request: TallyRequest; onClose: () => void }) {
  const me = useCurrentUser();
  const today = todayISO();
  const stored = useStoredTallies(me.id);
  const { options, loading, offline } = useTallyEvents(stored);
  const [chosenId, setChosenId] = useState<number | null>(request.eventId);
  const [choosing, setChoosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // A deep link lands here from the dashboard: bring the panel into view.
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const linked = chosenId != null ? options.find((e) => e.id === chosenId) ?? null : null;
  const selected = choosing ? null : linked ?? (chosenId == null ? defaultEvent(options, stored, today) : null);
  const linkMissed = chosenId != null && !linked && !loading;

  return (
    <div ref={panelRef} className="mb-5 scroll-mt-20">
      <Card padded={false} aria-label="Tally">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
              <Tally5 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-fg">Tally</h2>
              <p className="text-xs leading-relaxed text-muted">
                {selected ? (
                  <>
                    <span className="font-medium text-fg">{selected.name}</span> · {selected.date === today ? 'today' : formatDateShort(selected.date)} · {formatTime(selected.startTime)}–{formatTime(selected.endTime)}
                  </>
                ) : (
                  'Tap +1 as it happens. The counts stay on this phone until you finish the shift.'
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selected && options.length > 1 && (
              <Button variant="ghost" onClick={() => setChoosing(true)}>Change</Button>
            )}
            {/* The same tally, buttons only, for the field (pages/QuickGauges.tsx): one store, so the counts carry over. */}
            <Link
              to={actionHref.quick({ eventId: selected?.id })}
              aria-label="Full screen"
              title="Full screen"
              data-tally-fullscreen
              className="focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 sm:px-3"
            >
              <Maximize2 className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Full screen</span>
            </Link>
            <Button variant="ghost" size="icon" label="Close the tally (the counts are kept)" onClick={onClose}>
              <X aria-hidden />
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2 p-4 sm:p-5">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : selected ? (
          <TallyCounter key={`${selected.id}:${selected.date}`} event={selected} onFinished={onClose} />
        ) : (
          <div className="p-4 sm:p-5">
            <TallyEventPicker
              options={options}
              stored={stored}
              today={today}
              linkMissed={linkMissed}
              offline={offline}
              onPick={(id) => {
                setChosenId(id);
                setChoosing(false);
              }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function TallyCounter({ event, onFinished }: { event: SalesEventWithMeta; onFinished: () => void }) {
  const me = useCurrentUser();
  const t = useTallyCounter(event, { onFinished });
  const { counts, total, stopsPerSale, persisted, hint, tap, confirmReset } = t;

  return (
    <div>
      <ul className="divide-y divide-border">
        {GAUGE_KEYS.map((k) => {
          const blockedUp = !tallyStep(counts, k, 1).ok;
          return (
            <li key={k} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-muted">{GAUGE_LABELS[k]}</div>
                <div className="text-3xl font-bold leading-tight tabular-nums text-fg" data-tally-count={k}>{counts[k]}</div>
              </div>
              <button
                type="button"
                aria-label={`Take one off ${GAUGE_LABELS[k]} (now ${counts[k]})`}
                onClick={() => tap(k, -1)}
                className="focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3"
              >
                <Minus className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Add one to ${GAUGE_LABELS[k]} (now ${counts[k]})`}
                data-tally-plus={k}
                onClick={() => tap(k, 1)}
                className={`focus-ring inline-flex h-14 min-w-[6.5rem] shrink-0 items-center justify-center rounded-xl px-4 text-lg font-semibold shadow-card transition-[transform,background-color,opacity] active:scale-[0.97] ${blockedUp ? 'bg-surface-2 text-muted' : 'bg-primary text-primary-fg hover:bg-primary-hover'}`}
              >
                +1
              </button>
            </li>
          );
        })}
      </ul>

      <p role="status" aria-live="polite" className="min-h-6 px-4 text-sm text-warning sm:px-5">{hint ?? ''}</p>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="text-sm text-muted">
          <span className="font-semibold text-fg">{counts.sales}</span> sale{counts.sales === 1 ? '' : 's'} from <span className="font-semibold text-fg">{counts.stops}</span> stops
          {stopsPerSale != null && <> · 1 in {stopsPerSale}</>}
        </p>
        <div className="flex items-center gap-2">
          {confirmReset ? (
            <>
              <span className="text-sm text-muted">Reset to 0?</span>
              <Button variant="ghost" onClick={t.cancelReset}>Keep</Button>
              <Button variant="danger" onClick={t.reset}>Reset</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={t.askReset} disabled={total === 0}>Reset</Button>
              <Button size="lg" onClick={t.startFinish} disabled={total === 0} leftIcon={<Check aria-hidden />} className="flex-1 sm:flex-none">
                Finish shift
              </Button>
            </>
          )}
        </div>
      </div>
      {!persisted && (
        <p className="border-t border-border px-4 py-2 text-xs text-warning sm:px-5">This browser can&apos;t keep the tally if the page reloads — keep this page open until you finish the shift.</p>
      )}

      <LogGaugesModal
        open={t.finishing}
        onClose={t.cancelFinish}
        event={event}
        defaultUserId={me.id}
        prefill={{ gauges: counts, userId: me.id }}
        onSaved={t.finished}
        onQueued={t.finished}
      />
    </div>
  );
}
