// Quick gauges (/quick): the shift tally as six big buttons, for a phone or an iPad in the field. One tap from the
// sidebar (and from the topbar on phones), its own lazy chunk. It is the same tally as the Gauges page's Tally card —
// the same store (features/gauges/tallyStore.ts), the same counting hook (useTallyCounter) and the same "Finish shift"
// path through Log gauges and the outbox — laid out for thumbs: the whole tile is the +1, a small −1 sits in its corner.
// /quick?eventId=<id> preselects an event (the Tally card's "Full screen" link).
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, Minus, Plus, Tally5, X } from 'lucide-react';
import clsx from 'clsx';
import type { GaugeKey, SalesEventWithMeta } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, tallyStep } from '@lm/shared';
import { Button, Card, Skeleton } from '@/components/ui';
import { useCurrentUser } from '@/auth/AuthProvider';
import { LogGaugesModal } from '@/features/gauges/LogGaugesModal';
import { TallyEventPicker } from '@/features/gauges/TallyEventPicker';
import { useStoredTallies } from '@/features/gauges/tallyStore';
import { defaultEvent, useTallyCounter, useTallyEvents } from '@/features/gauges/useTallyCounter';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatTime } from '@/lib/format';
import { idFromParam, useActionParam } from '@/lib/useActionParam';
import { usePageTitle } from '@/lib/usePageTitle';
import { useWakeLock } from '@/lib/useWakeLock';

/**
 * The grid: 2 × 3 on a phone held upright (tiles ≥ 96 px), 3 × 2 from 640 px wide or held sideways; the rows share the
 * height left under the header. A phone held sideways (`short`: max-height 480 px) packs all six onto one screen with
 * 80 px tiles, so no row hides behind the bottom bar.
 */
const GRID =
  'grid flex-1 grid-cols-2 grid-rows-[repeat(3,minmax(6rem,1fr))] gap-2.5 sm:grid-cols-3 sm:grid-rows-[repeat(2,minmax(6rem,1fr))] sm:gap-3 landscape:grid-cols-3 landscape:grid-rows-[repeat(2,minmax(6rem,1fr))] short:grid-rows-[repeat(2,minmax(5rem,1fr))] short:gap-2';

export function QuickGaugesPage() {
  usePageTitle('Quick gauges');
  const me = useCurrentUser();
  const today = todayISO();
  const location = useLocation();
  const stored = useStoredTallies(me.id);
  const { options, loading, offline } = useTallyEvents(stored);
  // Read ?eventId on the first render (no flash of another event); useActionParam then strips it from the URL and
  // picks up a later link to this page while it is open.
  const [chosenId, setChosenId] = useState<number | null>(() => idFromParam(new URLSearchParams(location.search).get('eventId')));
  const [choosing, setChoosing] = useState(false);
  useActionParam(['eventId'], (p) => {
    setChosenId(idFromParam(p.eventId));
    setChoosing(false);
  });
  useWakeLock(true);

  const linked = chosenId != null ? options.find((e) => e.id === chosenId) ?? null : null;
  const selected = choosing ? null : linked ?? (chosenId == null ? defaultEvent(options, stored, today) : null);
  const linkMissed = chosenId != null && !linked && !loading;

  return (
    <div
      className="flex min-h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] flex-col gap-3 lg:min-h-[calc(100dvh-8rem-env(safe-area-inset-bottom))] short:-my-3 short:min-h-[calc(100dvh-5.5rem-env(safe-area-inset-bottom))] short:gap-2"
      data-quick-gauges
    >
      <header className="flex min-h-14 items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2 shadow-card sm:px-4 short:min-h-12 short:py-1.5">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
          style={selected ? { backgroundColor: `color-mix(in srgb, ${selected.campaignColor} 16%, transparent)`, color: selected.campaignColor } : undefined}
          aria-hidden
        >
          <Tally5 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          {/* The topbar already reads "Quick gauges"; the strip spends its two lines on the event. */}
          <h1 className={selected ? 'sr-only' : 'text-sm font-semibold text-fg'}>Quick gauges</h1>
          {selected ? (
            <div data-quick-event={selected.id}>
              <p className="truncate text-sm font-semibold text-fg">{selected.name}</p>
              <p className="truncate text-xs text-muted">
                {selected.date === today ? 'Today' : formatDateShort(selected.date)} · {formatTime(selected.startTime)}–{formatTime(selected.endTime)}
                {selected.teamId !== me.teamId ? ` · ${selected.teamName}` : ''}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">Tap a tile as it happens. The counts stay on this phone until you finish the shift.</p>
          )}
        </div>
        {selected && options.length > 1 && (
          <Button variant="ghost" onClick={() => setChoosing(true)} className="-mr-1">Change</Button>
        )}
      </header>

      {loading ? (
        <div className={GRID} aria-hidden>
          {GAUGE_KEYS.map((k) => <Skeleton key={k} className="h-full min-h-24 rounded-2xl short:min-h-20" />)}
        </div>
      ) : selected ? (
        <QuickCounter key={`${selected.id}:${selected.date}`} event={selected} />
      ) : (
        <Card>
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
        </Card>
      )}
    </div>
  );
}

function QuickCounter({ event }: { event: SalesEventWithMeta }) {
  const me = useCurrentUser();
  // A refused tap's hint (and its "Count it through" button) stays a little longer than on the card: gloves, glare.
  const t = useTallyCounter(event, { hintMs: 8000 });
  const { counts, total, stopsPerSale, hint, offer } = t;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const showHint = hint != null && dismissed !== hint;

  return (
    <>
      {!t.persisted && (
        <p className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">This browser can&apos;t keep the tally if the page reloads — keep this page open until you finish the shift.</p>
      )}

      <div className={GRID} role="group" aria-label={`Counts for ${event.name}`}>
        {GAUGE_KEYS.map((k) => (
          <Tile key={k} k={k} value={counts[k]} blocked={!tallyStep(counts, k, 1).ok} color={event.campaignColor} onTap={(d) => {
            setDismissed(null);
            t.tap(k, d);
          }} />
        ))}
      </div>

      {/* Announced once per refusal; the visible panel below repeats it next to its buttons. */}
      <p role="status" aria-live="polite" className="sr-only">{hint ? `${offer ? offer.hint : hint}${offer ? ` ${offer.label} is available.` : ''}` : ''}</p>

      <div className="sticky bottom-0 z-10 -mx-1 bg-bg px-1 pb-[env(safe-area-inset-bottom)] pt-1">
        <div className="relative rounded-2xl border border-border bg-surface p-3 shadow-pop sm:px-4 short:py-2">
          <div className={clsx('flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4', showHint && 'invisible')} aria-hidden={showHint || undefined}>
            <div className="flex min-h-10 items-center justify-between gap-3">
              <p className="text-sm text-muted" data-quick-summary>
                <span className="font-semibold tabular-nums text-fg">{counts.sales}</span> sale{counts.sales === 1 ? '' : 's'} from <span className="font-semibold tabular-nums text-fg">{counts.stops}</span> stops
                {stopsPerSale != null && <> · 1 in {stopsPerSale}</>}
              </p>
              {!t.confirmReset && (
                <Button variant="ghost" onClick={t.askReset} disabled={total === 0} className="sm:hidden">Reset</Button>
              )}
            </div>
            {t.confirmReset ? (
              <div className="flex items-center justify-end gap-2">
                <span className="mr-auto text-sm text-muted sm:mr-0">Reset to 0?</span>
                <Button variant="ghost" onClick={t.cancelReset}>Keep</Button>
                <Button variant="danger" onClick={t.reset}>Reset</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={t.askReset} disabled={total === 0} className="max-sm:hidden">Reset</Button>
                <Button size="lg" onClick={t.startFinish} disabled={total === 0} leftIcon={<Check aria-hidden />} className="flex-1 sm:min-w-[12rem] sm:flex-none short:h-11" data-quick-finish>
                  Finish shift
                </Button>
              </div>
            )}
          </div>

          {showHint && (
            // Same box as the bar (it grows upwards if the text needs it), so the tiles never move under a thumb.
            <div
              className="absolute inset-x-0 bottom-0 grid min-h-full animate-fade-in grid-cols-[1fr_auto] content-center items-center gap-x-2 gap-y-2 rounded-2xl border border-warning/40 bg-surface p-3 sm:grid-cols-[1fr_auto_auto] sm:gap-x-4 sm:px-4"
              data-quick-hint
            >
              <p className="col-start-1 row-start-1 min-w-0 text-sm font-medium text-warning" aria-hidden>{offer ? offer.hint : hint}</p>
              <button
                type="button"
                onClick={() => setDismissed(hint)}
                aria-label="Dismiss"
                className="focus-ring col-start-2 row-start-1 -my-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg sm:col-start-3"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              {offer && (
                <Button
                  variant="soft"
                  size="lg"
                  onClick={() => t.tapThrough(offer.key)}
                  leftIcon={<Plus aria-hidden />}
                  className="col-span-2 row-start-2 h-auto min-h-12 justify-start whitespace-normal py-2 text-left text-sm sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:max-w-md"
                  data-quick-through={offer.key}
                >
                  {offer.label}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <LogGaugesModal
        open={t.finishing}
        onClose={t.cancelFinish}
        event={event}
        defaultUserId={me.id}
        prefill={{ gauges: counts, userId: me.id }}
        onSaved={t.finished}
        onQueued={t.finished}
      />
    </>
  );
}

interface TileProps {
  k: GaugeKey;
  value: number;
  /** The funnel would refuse a +1 right now (a tap then explains why and offers to count it through). */
  blocked: boolean;
  color: string;
  onTap: (delta: 1 | -1) => void;
}

/** The count's font size inside its tile: up to 42 % of the tile's height, and narrow enough that every digit and the +1
 * chip fit across (about 0.66 em a digit, 6 rem for the padding and the chip), between 1.75 rem and 9 rem. Sized for
 * at least two digits, so 0 to 99 keep one size while counting (it only steps down at 100). */
function countSize(value: number): string {
  const digits = Math.max(2, String(value).length);
  return `clamp(1.75rem, min(42cqh, calc((100cqw - 6rem) / ${(0.66 * digits).toFixed(2)})), 9rem)`;
}

/** One stage: the whole tile is the +1; the −1 in its corner is its own button (a sibling, so it never adds). */
function Tile({ k, value, blocked, color, onTap }: TileProps) {
  const label = GAUGE_LABELS[k];
  return (
    <div className="relative min-h-24 short:min-h-20" data-quick-tile={k}>
      <button
        type="button"
        onClick={() => onTap(1)}
        aria-label={`Add one to ${label} (now ${value})`}
        data-quick-plus={k}
        className="focus-ring group absolute inset-0 flex touch-manipulation select-none flex-col justify-between overflow-hidden rounded-2xl [container-type:size] border border-border bg-surface p-3 pl-3.5 text-left shadow-card transition-[transform,background-color,border-color] duration-100 [-webkit-tap-highlight-color:transparent] hover:border-border-strong active:scale-[0.97] active:bg-surface-2 sm:p-4 sm:pl-5 short:p-2.5 short:pl-4"
      >
        <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: color }} aria-hidden />
        <span className="truncate pr-10 text-[13px] font-semibold leading-5 text-muted sm:pr-12 sm:text-base short:text-sm">{label}</span>
        <span className="flex flex-1 items-center justify-between gap-2 pt-1 short:justify-start short:gap-3 short:pt-0">
          {/* Sized to the tile (container units): as big as its height allows, never wider than the tile leaves room
              for, whatever the number of digits. Browsers without container units keep the fixed sizes. */}
          <span className="kpi-number text-5xl text-fg sm:text-6xl short:text-4xl" style={{ fontSize: countSize(value) }} data-quick-count={k}>
            {value}
          </span>
          <span
            className={clsx(
              'mb-1 inline-flex h-8 shrink-0 items-center rounded-full px-2.5 text-sm font-bold tabular-nums transition-colors short:mb-0 short:h-7',
              blocked ? 'bg-surface-2 text-subtle' : 'bg-primary text-primary-fg group-active:bg-primary-hover',
            )}
            aria-hidden
          >
            +1
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onTap(-1)}
        aria-label={`Take one off ${label} (now ${value})`}
        data-quick-minus={k}
        className="focus-ring absolute right-1 top-1 z-10 inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl border border-border bg-surface text-muted transition-colors [-webkit-tap-highlight-color:transparent] hover:bg-surface-2 hover:text-fg active:bg-surface-3"
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
