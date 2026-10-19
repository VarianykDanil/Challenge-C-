// Live tally counter for a shift — OWNED BY p7-signal-proof-logging (lead's addition).
// Mount points (p1's files, each inside its own ErrorBoundary):
// - TallyButton: Gauges page header actions, before "Log gauges" (compact fallback if it throws).
// - TallyMode: Gauges page, right under the page header (card fallback if it throws).
// - TodayTallyLink: the dashboard's "Upcoming events" card, above the list, for GAUGE_ROLES only. This is the
//   "reachable from the dashboard's today event" entry point, so p7 never needs to edit UpcomingEvents.tsx (p6's file).
// The deep link /gauges?tally=1[&eventId=<id>] (lib/useActionParam actionHref.tally) sets `request`. The counts live in
// localStorage per (userId, eventId, date) (tallyStore.ts), so they survive reloads and dropped signal; "Finish shift"
// opens LogGaugesModal prefilled — rendered by TallyMode itself — so saving goes through the same validation and the
// outbox. The tally is cleared once the save succeeds (or is kept on the phone by the outbox).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Minus, Tally5, X } from 'lucide-react';
import type { GaugeKey, GaugeTotals, SalesEventWithMeta } from '@lm/shared';
import { EMPTY_TOTALS, GAUGE_KEYS, GAUGE_LABELS, tallyStep } from '@lm/shared';
import { Button, Card, Skeleton } from '@/components/ui';
import { useCurrentUser } from '@/auth/AuthProvider';
import { EventStatusBadge } from '@/features/common/StatusBadges';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatTime } from '@/lib/format';
import { actionHref } from '@/lib/useActionParam';
import { LogGaugesModal } from './LogGaugesModal';
import { useLoggableEvents } from './loggableEvents';
import { clearTally, readTally, tallyStorageAvailable, tallyTotal, useStoredTallies, writeTally, type StoredTally } from './tallyStore';

/** What opened the tally: the header button (eventId null) or a deep link. */
export interface TallyRequest {
  eventId: number | null;
}

export interface TallyButtonProps {
  onOpen: () => void;
}

/** "Tally" in the Gauges header; shows today's running stop count when a tally is under way. */
export function TallyButton({ onOpen }: TallyButtonProps) {
  const me = useCurrentUser();
  const today = todayISO();
  const running = useStoredTallies(me.id).filter((t) => t.date === today);
  const stops = running.reduce((n, t) => n + t.counts.stops, 0);
  return (
    <Button variant="outline" onClick={onOpen} leftIcon={<Tally5 className="h-4 w-4" aria-hidden />} aria-label={running.length ? `Tally: ${stops} stops counted today` : 'Tally: count your shift as you go'}>
      Tally
      {running.length > 0 && <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">{stops}</span>}
    </Button>
  );
}

export interface TallyModeProps {
  /** Non-null while the tally should be open. */
  request: TallyRequest | null;
  onClose: () => void;
}

export function TallyMode({ request, onClose }: TallyModeProps) {
  if (!request) return null;
  return <TallyPanel request={request} onClose={onClose} />;
}

/** Events the person can count: today's (own team for reps and leaders; admins any team), plus any unfinished tally. */
function useTallyEvents(stored: StoredTally[]) {
  const me = useCurrentUser();
  const today = todayISO();
  const loggable = useLoggableEvents();
  const options = useMemo(() => {
    const list = loggable.events ?? [];
    const unfinished = new Set(stored.map((t) => t.eventId));
    return list
      .filter((e) => e.date === today || unfinished.has(e.id))
      .sort((a, b) => (a.date === b.date ? Number(b.teamId === me.teamId) - Number(a.teamId === me.teamId) || a.startTime.localeCompare(b.startTime) : b.date.localeCompare(a.date)));
  }, [loggable.events, stored, today, me.teamId]);
  return { options, loading: loggable.isLoading && !loggable.events, offline: loggable.offline && !loggable.events };
}

function defaultEvent(options: SalesEventWithMeta[], stored: StoredTally[], today: string): SalesEventWithMeta | null {
  const counting = options.find((e) => e.date === today && stored.some((t) => t.eventId === e.id && t.date === e.date));
  if (counting) return counting;
  const todays = options.filter((e) => e.date === today);
  const live = todays.filter((e) => e.status === 'live');
  if (live.length === 1) return live[0]!;
  return todays.length === 1 ? todays[0]! : null;
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
            {linkMissed && <p className="mb-3 text-sm text-muted">That event isn&apos;t one you can count today.</p>}
            {options.length ? (
              <>
                <p className="mb-3 text-sm font-medium text-fg">Which event are you counting?</p>
                <ul className="space-y-2">
                  {options.map((e) => {
                    const t = stored.find((s) => s.eventId === e.id && s.date === e.date);
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setChosenId(e.id);
                            setChoosing(false);
                          }}
                          className="focus-ring flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
                        >
                          <span className="h-9 w-1 shrink-0 rounded-full" style={{ backgroundColor: e.campaignColor }} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-fg">{e.name}</span>
                            <span className="block truncate text-xs text-muted">
                              {e.date === today ? 'Today' : formatDateShort(e.date)} · {formatTime(e.startTime)} · {e.teamName}
                              {t ? ` · ${t.counts.stops} stops counted${e.date !== today ? ' (not finished)' : ''}` : ''}
                            </span>
                          </span>
                          <EventStatusBadge status={e.status} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted">
                {offline ? "No signal, and no events loaded on this phone yet — open the tally again once you're back online." : 'Nothing on today for your team, so there is no shift to count.'}
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

const vibrate = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
};

function TallyCounter({ event, onFinished }: { event: SalesEventWithMeta; onFinished: () => void }) {
  const me = useCurrentUser();
  const [counts, setCounts] = useState<GaugeTotals>(() => readTally(me.id, event.id, event.date));
  const countsRef = useRef(counts);
  const [persisted, setPersisted] = useState(tallyStorageAvailable);
  const [hint, setHint] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 5000);
    return () => window.clearTimeout(id);
  }, [hint]);

  const commit = (next: GaugeTotals) => {
    countsRef.current = next;
    setCounts(next);
    setPersisted(writeTally(me.id, event.id, event.date, next));
  };

  const tap = (k: GaugeKey, delta: 1 | -1) => {
    const r = tallyStep(countsRef.current, k, delta);
    if (!r.ok) {
      setHint(r.hint);
      vibrate([30, 40, 30]);
      return;
    }
    setHint(null);
    setConfirmReset(false);
    commit(r.counts);
    vibrate(8);
  };

  const finished = () => {
    clearTally(me.id, event.id, event.date);
    countsRef.current = { ...EMPTY_TOTALS };
    setCounts({ ...EMPTY_TOTALS });
    onFinished();
  };

  const total = tallyTotal(counts);
  const stopsPerSale = counts.sales > 0 ? Math.round(counts.stops / counts.sales) : null;

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
              <Button variant="ghost" onClick={() => setConfirmReset(false)}>Keep</Button>
              <Button variant="danger" onClick={() => { setConfirmReset(false); commit({ ...EMPTY_TOTALS }); }}>Reset</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setConfirmReset(true)} disabled={total === 0}>Reset</Button>
              <Button size="lg" onClick={() => setFinishing(true)} disabled={total === 0} leftIcon={<Check aria-hidden />} className="flex-1 sm:flex-none">
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
        open={finishing}
        onClose={() => setFinishing(false)}
        event={event}
        defaultUserId={me.id}
        prefill={{ gauges: counts, userId: me.id }}
        onSaved={finished}
        onQueued={finished}
      />
    </div>
  );
}

export interface TodayTallyLinkProps {
  /**
   * The dashboard's upcomingEvents (already role-scoped by /me/dashboard; an admin's list spans every team). p7 picks
   * today's own-team scheduled or live event (date === todayISO()) and renders a ≥ 40 px link to
   * actionHref.tally({ eventId }); null when there is none (e.g. Sundays, when the seed has no events).
   */
  events: SalesEventWithMeta[];
}

export function TodayTallyLink({ events }: TodayTallyLinkProps) {
  const me = useCurrentUser();
  const today = todayISO();
  const stored = useStoredTallies(me.id);
  const todays = events.filter((e) => e.date === today && e.teamId === me.teamId && (e.status === 'scheduled' || e.status === 'live'));
  if (!todays.length) return null;
  const live = todays.filter((e) => e.status === 'live');
  const target = todays.length === 1 ? todays[0]! : live.length === 1 ? live[0]! : null;
  const counting = target ? stored.find((t) => t.eventId === target.id && t.date === today) : undefined;
  return (
    <Link
      to={actionHref.tally({ eventId: target?.id })}
      data-today-tally
      className="focus-ring flex min-h-14 items-center gap-3 rounded-xl border border-primary/20 bg-primary-soft px-3 py-2 transition-colors hover:bg-primary/15"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-primary" aria-hidden>
        <Tally5 className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-primary">{counting ? 'Carry on counting' : 'Count your shift'}</span>
        <span className="block truncate text-xs text-muted">
          {target ? `${target.name} · ${formatTime(target.startTime)}` : `${todays.length} events today`}
          {counting ? ` · ${counting.counts.stops} stops, ${counting.counts.sales} sales so far` : ' · tap +1 as it happens'}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden />
    </Link>
  );
}
