// Quick gauges (/quick): the shift tally as six big buttons, for a phone or an iPad in the field. One tap from the
// sidebar (and from the topbar on phones), its own lazy chunk. It is the same tally as the Gauges page's Tally card —
// the same store (features/gauges/tallyStore.ts), the same counting hook (useTallyCounter) and the same "Finish shift"
// path through Log gauges and the outbox — laid out for thumbs: the whole tile is the +1, a small −1 sits in its corner.
// A tap counts one person at the furthest stage they reached (tallyPerson): +1 on Presentations also adds a stop and a
// table, and every tile that went up flashes briefly so the cascade is visible.
// /quick?eventId=<id> preselects an event (the Tally card's "Full screen" link).
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, ChevronDown, Minus, Tally5, X } from 'lucide-react';
import clsx from 'clsx';
import type { GaugeKey, SalesEventWithMeta } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, tallyPerson } from '@lm/shared';
import { Button, Card, Skeleton } from '@/components/ui';
import { useCurrentUser } from '@/auth/AuthProvider';
import { CheckInButton } from '@/features/checkins/CheckInButton';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { PitchLink } from '@/features/learning/PitchLink';
// Release 1.3 slot (P8): the thin "Aim" strip — one line in the help line's place under the header (upright), or in the
// header's side slot (held sideways); the help shortens to its first sentence beside it, so the tiles keep their height.
import { EventPlanStrip } from '@/features/venues/EventPlanStrip';
import { LogGaugesModal } from '@/features/gauges/LogGaugesModal';
import { TallyEventPicker } from '@/features/gauges/TallyEventPicker';
import { TallyHelp } from '@/features/gauges/TallyHelp';
import { useStoredTallies } from '@/features/gauges/tallyStore';
import { addPersonLabel, defaultEvent, takePersonLabel, TALLY_ADDS, useRaiseFlash, useTallyCounter, useTallyEvents } from '@/features/gauges/useTallyCounter';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatTime } from '@/lib/format';
import { idFromParam, useActionParam } from '@/lib/useActionParam';
import { usePageTitle } from '@/lib/usePageTitle';
import { useWakeLock } from '@/lib/useWakeLock';

/**
 * The grid: 2 × 3 on a phone held upright (tiles ≥ 88 px, so the help line still leaves all six on one 360×640
 * screen), 3 × 2 from 640 px wide or held sideways; the rows share the height left under the header. A phone held
 * sideways (`short`: max-height 480 px) packs all six onto one screen with 80 px tiles, so no row hides behind the
 * bottom bar; so does a small phone held upright (`tiny`: 320×568). The smallest phones held sideways (360 px high,
 * e.g. 640×360) get 72 px tiles (TILE_LOW), which is what leaves both rows above the bar there.
 */
const GRID =
  'grid flex-1 grid-cols-2 grid-rows-[repeat(3,minmax(5.5rem,1fr))] gap-2.5 sm:grid-cols-3 sm:grid-rows-[repeat(2,minmax(6rem,1fr))] sm:gap-3 landscape:grid-cols-3 landscape:grid-rows-[repeat(2,minmax(6rem,1fr))] short:grid-rows-[repeat(2,minmax(5rem,1fr))] short:gap-2 tiny:grid-rows-[repeat(3,minmax(5rem,1fr))] tiny:gap-2 [@media(max-height:370px)]:grid-rows-[repeat(2,minmax(4.5rem,1fr))]';
/** A tile's own floor on the smallest phones held sideways (see GRID). */
const TILE_LOW = '[@media(max-height:370px)]:min-h-18';

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
  const canChange = !!selected && options.length > 1;

  return (
    <div
      className="flex min-h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] flex-col gap-3 lg:min-h-[calc(100dvh-8rem-env(safe-area-inset-bottom))] short:-my-3 short:min-h-[calc(100dvh-5.5rem-env(safe-area-inset-bottom))] short:gap-2 tiny:-my-3 tiny:min-h-[calc(100dvh-5.5rem-env(safe-area-inset-bottom))] tiny:gap-2"
      data-quick-gauges
    >
      {/* UI QA 1.2 #6: on a phone (and held sideways) the event's name — campaign and venue — must show in full beside
          the Pitch and Check in icons, without the strip growing much (the six tiles share the height left under it):
          the campaign's colour is a stripe along the strip's left edge, as on the tiles below (so it takes none of the
          name's width), the name wraps (up to three lines on a phone, two held sideways from 640 px) in a 13 px type,
          and with several events the name itself is the "Change" button (a chevron after its last word). From 640 px
          upright the strip is as before, except that a long name wraps to a second line. */}
      <header className="relative flex min-h-12 items-center gap-2 rounded-2xl border border-border bg-surface px-3 py-1 shadow-card sm:min-h-14 sm:gap-3 sm:px-4 sm:py-2 short:min-h-12 short:gap-2 short:py-1 tiny:min-h-12">
        {selected && (
          // Clipped to the strip's rounded inner edge (16 px corners less the 1 px border), like the tiles' stripe.
          <span className="pointer-events-none absolute inset-0 hidden overflow-hidden rounded-[calc(1rem-1px)] max-sm:block short:block" aria-hidden data-quick-colour-bar>
            <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: selected.campaignColor }} />
          </span>
        )}
        <span
          className={clsx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary', selected && 'max-sm:hidden short:hidden')}
          style={selected ? { backgroundColor: `color-mix(in srgb, ${selected.campaignColor} 16%, transparent)`, color: selected.campaignColor } : undefined}
          aria-hidden
        >
          <Tally5 className="h-5 w-5" />
        </span>
        <div className="relative min-w-0 flex-1">
          {/* The topbar already reads "Quick gauges"; the strip spends its lines on the event. */}
          <h1 className={selected ? 'sr-only' : 'text-sm font-semibold text-fg'}>Quick gauges</h1>
          {selected ? (
            <div className="flex min-h-10 flex-col justify-center sm:min-h-0 short:min-h-10" data-quick-event={selected.id}>
              <p className="line-clamp-3 break-words text-[13px] font-semibold leading-4 text-fg sm:line-clamp-2 sm:text-sm sm:leading-5 short:text-[13px] short:leading-4" data-quick-event-name>
                {canChange ? <NameWithChevron name={selected.name} /> : selected.name}
              </p>
              <p className="truncate text-[11px] leading-[14px] text-muted sm:text-xs sm:leading-4 short:text-[11px] short:leading-[14px]">
                {selected.date === today ? 'Today' : formatDateShort(selected.date)} · {formatTime(selected.startTime)}–{formatTime(selected.endTime)}
                {selected.teamId !== me.teamId ? ` · ${selected.teamName}` : ''}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">Tap the furthest stage each person reached. The counts stay on this phone until you finish the shift.</p>
          )}
          {/* Phone, or held sideways: the whole name is the Change button (a stretched, see-through button). It reaches
              6 px past the name on each side and 4 px above and below (into the strip's padding and the gaps, short of
              the icons), with its focus ring drawn inside that margin, so the ring never touches the text. */}
          {canChange && (
            <button
              type="button"
              onClick={() => setChoosing(true)}
              aria-label="Change event"
              title="Change event"
              className="focus-ring-inset absolute -inset-x-1.5 -inset-y-1 hidden rounded-lg transition-colors [-webkit-tap-highlight-color:transparent] active:bg-fg/5 max-sm:block short:block"
              data-quick-change="name"
            />
          )}
        </div>
        {/* Held sideways there is no height to spare under the header, but room across it: the help line sits here,
            and the booked person's Aim (P8) above it, the help then cut to its first sentence (two 14 px lines). */}
        {selected && (
          <div className="group/side hidden w-60 shrink-0 text-[11px] leading-[14px] text-muted short:block" data-quick-help-side>
            <ErrorBoundary name="event-plan" fallback={null}><EventPlanStrip event={selected} variant="quick" /></ErrorBoundary>
            <p className="group-has-[[data-plan-strip]]/side:max-h-[14px] group-has-[[data-plan-strip]]/side:overflow-hidden"><TallyHelp /></p>
          </div>
        )}
        {/* Release 1.2: the campaign's pitch (L2, a 40 px icon on a phone) and one-tap check-in (U4, always labelled). */}
        {selected && (
          <div className="flex shrink-0 items-center gap-1 empty:hidden sm:gap-3 short:gap-1">
            <ErrorBoundary name="pitch-link" fallback={null}>
              <PitchLink campaignCode={selected.campaignCode} campaignId={selected.campaignId} variant="compact" />
            </ErrorBoundary>
            <ErrorBoundary name="check-in" fallback={null}>
              <CheckInButton event={selected} variant="compact" />
            </ErrorBoundary>
          </div>
        )}
        {canChange && (
          <Button variant="ghost" onClick={() => setChoosing(true)} className="-mr-1 max-sm:hidden short:hidden" data-quick-change="button">Change</Button>
        )}
      </header>

      {loading ? (
        <div className={GRID} aria-hidden>
          {GAUGE_KEYS.map((k) => <Skeleton key={k} className={clsx('h-full min-h-22 rounded-2xl sm:min-h-24 short:min-h-20 tiny:min-h-20', TILE_LOW)} />)}
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

/** The event's name with the Change chevron after it (shown on a phone and held sideways). The last word and the
 * chevron never part, so the chevron is never alone on a line; a last word too long to keep whole may still break. */
function NameWithChevron({ name }: { name: string }) {
  const cut = name.lastIndexOf(' ') + 1;
  const last = name.slice(cut);
  return (
    <>
      {name.slice(0, cut)}
      <span className={last.length <= 20 ? 'whitespace-nowrap' : undefined}>
        {last}
        <ChevronDown className="ml-0.5 hidden h-3.5 w-3.5 align-[-2px] text-muted max-sm:inline short:inline" aria-hidden />
      </span>
    </>
  );
}

function QuickCounter({ event }: { event: SalesEventWithMeta }) {
  const me = useCurrentUser();
  // A refused tap's hint stays a little longer than on the card: gloves, glare.
  const t = useTallyCounter(event, { hintMs: 8000 });
  const { counts, total, stopsPerSale, hint, raised } = t;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const showHint = hint != null && dismissed !== hint;
  // Every tile's count is the same size, set by the biggest number (at least two digits), so the six read as one set
  // and only step down together, once, when a count reaches 100.
  const digits = Math.max(2, String(Math.max(...GAUGE_KEYS.map((k) => counts[k]))).length);
  // Reset's confirm takes the bar's place at the bar's height: the safe "Keep counting" where Finish shift was, the
  // red Reset at the far left (where the summary was), and nothing where the small Reset was — so a second tap in
  // either familiar spot never wipes the shift.
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (t.confirmReset) keepRef.current?.focus({ preventScroll: true });
  }, [t.confirmReset]);

  return (
    <>
      {!t.persisted && (
        <p className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">This browser can&apos;t keep the tally if the page reloads — keep this page open until you finish the shift.</p>
      )}

      {/* Tucked under the event header (two short lines on a phone); held sideways it moves into the header. Release 1.3
          (P8): a booked person's Aim takes the first of the two lines (one line, cut short with "…" if it must be), and
          on a phone the help keeps its first sentence on the second — the same 28 px, so all six tiles stay above the
          Finish bar (UI QA 1.2). From 640 px wide there is room for both in full. */}
      <div className="group/help -mt-1.5 px-1 text-[11px] leading-[14px] text-muted sm:-mt-1 sm:text-xs sm:leading-4 short:hidden tiny:-mt-1" data-quick-help>
        <ErrorBoundary name="event-plan" fallback={null}><EventPlanStrip event={event} variant="quick" className="text-xs leading-4 sm:text-sm sm:leading-5" /></ErrorBoundary>
        <p className="group-has-[[data-plan-strip]]/help:max-sm:max-h-[14px] group-has-[[data-plan-strip]]/help:max-sm:overflow-hidden"><TallyHelp /></p>
      </div>

      <div className={GRID} role="group" aria-label={`Counts for ${event.name}`}>
        {GAUGE_KEYS.map((k) => (
          <Tile
            key={k}
            k={k}
            value={counts[k]}
            digits={digits}
            full={!tallyPerson(counts, k, 1).ok}
            pulse={raised?.keys.includes(k) ? raised.n : null}
            color={event.campaignColor}
            onTap={(d) => {
              setDismissed(null);
              t.tap(k, d);
            }}
          />
        ))}
      </div>

      {/* Announced once per refusal; the visible panel below repeats it. */}
      <p role="status" aria-live="polite" className="sr-only">{hint ?? ''}</p>

      <div className="sticky bottom-0 z-10 -mx-1 bg-bg px-1 pb-[env(safe-area-inset-bottom)] pt-1">
        <div className="relative rounded-2xl border border-border bg-surface p-3 shadow-pop sm:px-4 short:py-2">
          <div className={clsx('flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4', showHint && 'invisible')} aria-hidden={showHint || undefined}>
            <div className="flex min-h-10 min-w-0 items-center justify-between gap-3">
              {t.confirmReset ? (
                <div className="flex min-w-0 items-center gap-3" data-quick-reset-confirm>
                  <Button variant="danger" onClick={t.reset} data-quick-reset-yes>Reset to 0</Button>
                  <span className="min-w-0 text-sm text-muted">Clears all six counts.</span>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted" data-quick-summary>
                    <span className="font-semibold tabular-nums text-fg">{counts.sales}</span> sale{counts.sales === 1 ? '' : 's'} from <span className="font-semibold tabular-nums text-fg">{counts.stops}</span> stops
                    {stopsPerSale != null && <> · 1 in {stopsPerSale}</>}
                  </p>
                  <Button variant="ghost" onClick={t.askReset} disabled={total === 0} className="sm:hidden">Reset</Button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {t.confirmReset ? (
                <Button ref={keepRef} variant="outline" size="lg" onClick={t.cancelReset} className="flex-1 sm:min-w-[12rem] sm:flex-none short:h-11 tiny:h-11" data-quick-reset-keep>
                  Keep counting
                </Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={t.askReset} disabled={total === 0} className="max-sm:hidden">Reset</Button>
                  <Button size="lg" onClick={t.startFinish} disabled={total === 0} leftIcon={<Check aria-hidden />} className="flex-1 sm:min-w-[12rem] sm:flex-none short:h-11 tiny:h-11" data-quick-finish>
                    Finish shift
                  </Button>
                </>
              )}
            </div>
          </div>

          {showHint && (
            // Same box as the bar (it grows upwards if the text needs it), so the tiles never move under a thumb.
            <div
              className="absolute inset-x-0 bottom-0 flex min-h-full animate-fade-in items-center gap-2 rounded-2xl border border-warning/40 bg-surface p-3 sm:gap-4 sm:px-4 short:py-2"
              data-quick-hint
            >
              <p className="min-w-0 flex-1 text-sm font-medium text-warning" aria-hidden>{hint}</p>
              <button
                type="button"
                onClick={() => setDismissed(hint)}
                aria-label="Dismiss"
                className="focus-ring -my-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
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
  /** How many digits the count is sized for (the same for all six tiles). */
  digits: number;
  /** A +1 here would take a stage past the daily maximum (the only time a +1 is refused; a tap then says which). */
  full: boolean;
  /** The number of the tap that just raised this stage (it flashes briefly), or null. */
  pulse: number | null;
  color: string;
  onTap: (delta: 1 | -1) => void;
}

/** The count's font size inside its tile: up to half the tile's height, never taller than the room left under the label
 * and its "what a tap adds" line (`--tile-head`: those two lines, the row's top padding and 2 px, set per layout on the
 * count), and narrow enough that every digit and the +1 chip fit across (about 0.66 em a digit; 3.5 rem for the chip
 * and the gap — container units are already measured inside the tile's padding), between 1.5 rem (four digits still
 * fit a 320 px phone) and 9 rem. */
function countSize(digits: number): string {
  return `clamp(1.5rem, min(50cqh, calc((100cqh - var(--tile-head)) / 1.05), calc((100cqw - 3.5rem) / ${(0.66 * digits).toFixed(2)})), 9rem)`;
}

/**
 * One stage: the whole tile is the +1; the −1 in its corner is its own button (a sibling, so it never adds). Inside,
 * three rows: the stage, what one tap on it adds ("+ stop, table", clear of the −1 like the label), then the count
 * with its +1 chip. Held sideways (`short`, 80 px tiles) the note moves to the bottom-right corner, beside the count.
 */
function Tile({ k, value, digits, full, pulse, color, onTap }: TileProps) {
  const label = GAUGE_LABELS[k];
  const flash = useRaiseFlash(pulse);
  return (
    <div className={clsx('relative min-h-22 sm:min-h-24 short:min-h-20 tiny:min-h-20', TILE_LOW)} data-quick-tile={k}>
      <button
        type="button"
        onClick={() => onTap(1)}
        aria-label={addPersonLabel(k, value)}
        data-quick-plus={k}
        className="focus-ring group absolute inset-0 grid touch-manipulation select-none grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-2xl [container-type:size] border border-border bg-surface p-3 pl-3.5 text-left shadow-card transition-[transform,background-color,border-color] duration-100 [-webkit-tap-highlight-color:transparent] hover:border-border-strong active:scale-[0.97] active:bg-surface-2 sm:p-4 sm:pl-5 short:grid-cols-[auto_minmax(0,1fr)] short:grid-rows-[auto_minmax(0,1fr)] short:p-2.5 short:pl-4 tiny:p-2.5 tiny:py-1.5 tiny:pl-3.5"
      >
        <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: color }} aria-hidden />
        {/* The tap's highlight: every tile a tap raised flashes for 300 ms, so the cascade is visible. */}
        <span ref={flash.ring} className="pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/15 opacity-0 ring-2 ring-inset ring-primary" aria-hidden data-quick-flash />
        <span className="col-span-full truncate pr-10 text-[13px] font-semibold leading-5 text-muted sm:pr-12 sm:text-base short:text-sm">{label}</span>
        <span className="truncate pr-10 text-[11px] leading-[14px] text-subtle sm:pr-12 sm:text-xs sm:leading-4 short:col-start-2 short:row-start-2 short:self-end short:pl-3 short:pr-0 short:text-right" data-quick-note>
          {TALLY_ADDS[k]}
        </span>
        {/* The +1 chip sits at the far end of the row, under the −1 — except in a narrow, short tile (a phone held
            upright, up to about 164 px tall), where that would put it right against the −1: there it leads the row,
            on the left, and the row sits at the bottom of the tile, so neither the chip nor the count is a thumb's
            width from the −1. */}
        <span className="flex min-h-0 items-center justify-between gap-2 pt-1 short:col-start-1 short:row-start-2 short:justify-start short:gap-3 short:pt-0 tile-cramped:items-end tile-cramped:justify-start tile-cramped:pt-0">
          {/* Sized to the tile (container units): as big as its height allows, never wider than the tile leaves room
              for, whatever the number of digits. Browsers without container units keep the fixed sizes. */}
          <span
            ref={flash.count}
            className="kpi-number text-5xl text-fg [--tile-head:2.5rem] sm:text-6xl sm:[--tile-head:2.625rem] tile-cramped:[--tile-head:2.25rem] sm:tile-cramped:[--tile-head:2.375rem] short:text-4xl short:[--tile-head:1.5rem] short:tile-cramped:[--tile-head:1.5rem]"
            style={{ fontSize: countSize(digits) }}
            data-quick-count={k}
          >
            {value}
          </span>
          <span
            className={clsx(
              'mb-1 inline-flex h-8 shrink-0 items-center rounded-full px-2.5 text-sm font-bold tabular-nums transition-colors short:mb-0 short:h-7 tile-cramped:order-first tile-cramped:mb-0.5 tile-cramped:h-7',
              full ? 'bg-surface-2 text-subtle' : 'bg-primary text-primary-fg group-active:bg-primary-hover',
            )}
            aria-hidden
            data-quick-chip
          >
            +1
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onTap(-1)}
        aria-label={takePersonLabel(k, value)}
        data-quick-minus={k}
        className="focus-ring absolute right-1 top-1 z-10 inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl border border-border bg-surface text-muted transition-colors [-webkit-tap-highlight-color:transparent] hover:bg-surface-2 hover:text-fg active:bg-surface-3"
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
