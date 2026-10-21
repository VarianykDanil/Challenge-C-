// Release 1.2 — L2 learning-pitch: the teleprompter. The script in big type on the always-dark ink panel, scrolling
// on its own at a chosen speed (words a minute) past a reading line. Full screen on demand (the browser's full-screen
// mode where it allows, else a fixed overlay), and laid out for a phone held sideways. Keys: Space play / pause,
// ↑ ↓ speed, Home back to the start, F full screen, Esc leave full screen. The screen stays awake while it plays.
// A line that uses a figure the office has not approved yet carries an amber marker and, under it, the suggested
// wording (or the note when there is none): shown on wide screens, behind a "Check the figures" tap on phones. The
// script's own words are never changed. A strip at the top of the panel says how many lines those are (inside the
// panel, so the controls stay on the first screen), and the flags add no speed: the lines pass at the chosen pace.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, Maximize2, Minimize2, Minus, Pause, Play, Plus, RotateCcw } from 'lucide-react';
import { PITCH_DEFAULT_PAUSE_SECONDS, pitchFactFlags, type PitchBlock, type PitchFact, type PitchFactFlag, type PitchScript } from '@lm/shared';
import { useWakeLock } from '@/lib/useWakeLock';
import { InlineSegments } from './parts';

/**
 * The amber of the flags on the always-dark ink panel, in both themes: the dark theme's --warning (the light theme's
 * --warning is a dark amber made for light surfaces and is too dim on ink).
 */
const PROMPTER_AMBER = 'text-[#FBBF24]';

type Flags = ReadonlyMap<number, readonly PitchFactFlag[]>;
const NO_FLAGS: Flags = new Map();

export const PROMPTER_MIN_WPM = 90;
export const PROMPTER_MAX_WPM = 240;
const STEP_WPM = 10;
/** Where the reading line sits, as a share of the panel's height from the top. */
const READING_LINE = 0.32;

function readStoredWpm(): number {
  try {
    const n = Number(localStorage.getItem('lm-pitch-prompter-wpm'));
    if (Number.isFinite(n) && n >= PROMPTER_MIN_WPM && n <= PROMPTER_MAX_WPM) return n;
  } catch {
    /* storage unavailable */
  }
  return 150;
}

/** Seconds the spoken lines take at `wpm`: every spoken word (both branches are on screen) plus pauses. */
function prompterSeconds(script: PitchScript, wpm: number): number {
  let pauses = 0;
  const visit = (blocks: readonly PitchBlock[]) => {
    for (const b of blocks) {
      if (b.kind === 'pause') {
        pauses += b.seconds ?? PITCH_DEFAULT_PAUSE_SECONDS;
      } else if (b.kind === 'line') {
        for (const s of b.segments) if (s.kind === 'pause') pauses += s.seconds ?? PITCH_DEFAULT_PAUSE_SECONDS;
      } else if (b.kind === 'branch') {
        for (const br of b.branches) visit(br.blocks);
      }
    }
  };
  visit(script.blocks);
  return Math.max(5, (script.wordCount * 60) / wpm + pauses);
}

/**
 * Pixels of the scroll that are fact flags, not script: each flag's margin box (its height plus its margins, which is
 * what it adds between a line and the next block). The pace leaves them out, so a flag does not speed the lines up.
 */
function flagPixels(scroller: HTMLElement): number {
  let px = 0;
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-fact-flag]')) {
    const cs = getComputedStyle(el);
    px += el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  return px;
}

export function Teleprompter({
  script,
  facts,
  name,
  onShowNotes,
}: {
  script: PitchScript;
  facts?: readonly PitchFact[];
  name?: string;
  /** Opens Read mode, where the notes are (the strip's "See the notes"). */
  onShowNotes?: () => void;
}) {
  const flags = useMemo<Flags>(() => (facts?.length ? pitchFactFlags(facts) : NO_FLAGS), [facts]);
  const toCheck = flags.size;
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [wpm, setWpm] = useState(readStoredWpm);
  const [full, setFull] = useState(false);
  const [progress, setProgress] = useState(0);
  useWakeLock(playing);

  useEffect(() => {
    try {
      localStorage.setItem('lm-pitch-prompter-wpm', String(wpm));
    } catch {
      /* storage unavailable */
    }
  }, [wpm]);

  // Auto-scroll: a steady rate that covers the script's height (the scrollable height less the fact flags) in the time
  // the words take at `wpm`. A flag then passes at that same rate, adding its own time instead of speeding the lines.
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let carry = el.scrollTop;
    const seconds = prompterSeconds(script, wpm);
    // Measured again only when the layout changes (a flag opened or closed, the panel resized), not every frame.
    let measuredFor = '';
    let flagPx = 0;
    const frame = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const max = el.scrollHeight - el.clientHeight;
      const layout = `${el.scrollHeight}x${el.clientWidth}`;
      if (layout !== measuredFor) {
        measuredFor = layout;
        flagPx = flagPixels(el);
      }
      // The reader may drag the text: carry on from wherever it is now.
      if (Math.abs(el.scrollTop - carry) > 2) carry = el.scrollTop;
      carry = Math.min(max, carry + (Math.max(1, max - flagPx) / seconds) * dt);
      el.scrollTop = carry;
      if (carry >= max - 0.5) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, wpm, script]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? el.scrollTop / max : 0);
  };

  const restart = useCallback(() => {
    setPlaying(false);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const toggleFull = useCallback(() => {
    const next = !full;
    try {
      if (next && wrapRef.current?.requestFullscreen && !document.fullscreenElement) void wrapRef.current.requestFullscreen().catch(() => undefined);
      if (!next && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } catch {
      /* no Fullscreen API (iPhone Safari): the fixed overlay alone covers the screen */
    }
    setFull(next);
  }, [full]);

  // The first line starts on the reading line and the last one can scroll up to it, whatever the panel's height.
  const [pad, setPad] = useState({ top: 160, bottom: 320 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      setPad({ top: Math.max(24, Math.round(h * READING_LINE - 28)), bottom: Math.round(h * (1 - READING_LINE)) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Leaving the browser's full screen (Esc, a swipe) also leaves ours.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // While full screen the page behind must not scroll.
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [full]);

  // Leaving the page (or this mode) leaves the browser's full screen too.
  useEffect(
    () => () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    },
    [],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ') {
      e.preventDefault();
      setPlaying((p) => !p);
    } else if (e.key === 'ArrowUp' || e.key === '+') {
      e.preventDefault();
      setWpm((w) => Math.min(PROMPTER_MAX_WPM, w + STEP_WPM));
    } else if (e.key === 'ArrowDown' || e.key === '-') {
      e.preventDefault();
      setWpm((w) => Math.max(PROMPTER_MIN_WPM, w - STEP_WPM));
    } else if (e.key === 'Home') {
      e.preventDefault();
      restart();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFull();
    } else if (e.key === 'Escape' && full) {
      e.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setFull(false);
    }
  };

  const ctrl =
    'focus-ring inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-ink-fg ring-1 ring-inset ring-ink-fg/15 transition-colors hover:bg-ink-fg/10 disabled:opacity-40 short:h-10 short:min-w-10';

  return (
    <div
      ref={wrapRef}
      role="region"
      aria-label="Teleprompter"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={clsx(
        'relative flex flex-col overflow-hidden bg-ink text-ink-fg',
        full ? 'fixed inset-0 z-[70] h-[100dvh] w-screen' : 'h-[max(20rem,calc(100dvh-21rem))] max-h-[44rem] rounded-2xl shadow-card short:h-[calc(100dvh-5rem)]',
      )}
      data-teleprompter
      data-full={full || undefined}
    >
      {toCheck > 0 && (
        // Inside the panel, not above it: the panel keeps its height, so Play and the speed stay on the first screen.
        // On a phone (or held sideways) it is one line: the count and "See the notes"; the full sentence is read out.
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-ink-fg/10 bg-ink-2 pl-4 pr-1 text-sm sm:pl-6 sm:pr-2" role="note" data-fact-banner>
          <AlertTriangle className={clsx('h-4 w-4 shrink-0', PROMPTER_AMBER)} aria-hidden />
          <p className="min-w-0 flex-1 py-1.5 leading-snug text-ink-fg">
            <span className={clsx('font-semibold', PROMPTER_AMBER)}>Check the figures:</span>{' '}
            <span className="whitespace-nowrap">
              {toCheck} {toCheck === 1 ? 'line' : 'lines'}
            </span>
            <span className="max-sm:sr-only short:sr-only">
              {' '}
              {toCheck === 1 ? 'uses' : 'use'} figures the office has not approved yet. Read mode shows the notes.
            </span>
          </p>
          {onShowNotes && (
            <button
              type="button"
              onClick={onShowNotes}
              className="focus-ring inline-flex h-10 shrink-0 items-center rounded-lg px-2.5 text-sm font-semibold text-ink-fg underline decoration-ink-fg/40 underline-offset-4 hover:bg-ink-fg/10 hover:decoration-ink-fg"
            >
              See the notes
            </button>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* the reading line, at READING_LINE of the text area's height */}
        <div className="pointer-events-none absolute inset-x-0 top-[32%] z-10 h-[3.2em] -translate-y-1/2 border-y border-ink-fg/10 bg-ink-fg/[0.04] text-2xl short:text-xl" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-ink to-transparent" aria-hidden />
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scrollbar-none absolute inset-0 overflow-y-auto overscroll-contain px-5 sm:px-10"
          data-prompter-scroll
        >
          <div className="mx-auto max-w-3xl" style={{ paddingTop: pad.top, paddingBottom: pad.bottom }}>
            <PrompterBlocks blocks={script.blocks} name={name} flags={flags} />
            <p className="mt-10 text-center text-sm font-medium uppercase tracking-[0.2em] text-ink-muted">End of the script</p>
          </div>
        </div>
      </div>
      <div className="h-1 bg-ink-fg/10" aria-hidden>
        <div className="h-full bg-ink-fg/50 transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-ink-fg/10 bg-ink-2 px-3 py-2.5 short:py-1.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="focus-ring inline-flex h-11 min-w-24 items-center justify-center gap-1.5 rounded-xl bg-ink-fg px-4 text-sm font-semibold text-ink transition-colors hover:bg-ink-fg/90 short:h-10"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
        >
          {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {playing ? 'Pause' : progress > 0.995 ? 'Play again' : 'Play'}
        </button>
        <div className="flex items-center gap-1" role="group" aria-label="Speed">
          <button type="button" className={ctrl} onClick={() => setWpm((w) => Math.max(PROMPTER_MIN_WPM, w - STEP_WPM))} disabled={wpm <= PROMPTER_MIN_WPM} aria-label="Slower">
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-[5rem] text-center text-sm tabular text-ink-fg" aria-live="polite">
            {wpm} <span className="text-ink-muted" aria-hidden>wpm</span>
            <span className="sr-only">words a minute</span>
          </span>
          <button type="button" className={ctrl} onClick={() => setWpm((w) => Math.min(PROMPTER_MAX_WPM, w + STEP_WPM))} disabled={wpm >= PROMPTER_MAX_WPM} aria-label="Faster">
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className={ctrl}
          onClick={() => {
            restart();
            if (progress > 0.995 && scrollRef.current) setProgress(0);
          }}
          aria-label="Back to the start"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className={ctrl} onClick={toggleFull} aria-pressed={full} aria-label={full ? 'Leave full screen' : 'Full screen'}>
          {full ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

/** Under a flagged line: "Check the figures" and the suggested wording (or the note), folded on phones. */
function PrompterFactFlag({ flags }: { flags: readonly PitchFactFlag[] }) {
  const [open, setOpen] = useState(false);
  // A note opens on the first line it quotes; on its later lines the marker points back to it.
  const notes = flags.filter((f) => f.first).map((f) => f.fact);
  const label = (
    <>
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      Check the figures
    </>
  );
  return (
    <div className={clsx('-mt-2 mb-5 short:-mt-1 short:mb-3', PROMPTER_AMBER)} data-fact-flag>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring -ml-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold hover:bg-ink-fg/10 sm:hidden"
      >
        {label}
        <ChevronDown className={clsx('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <p className="hidden items-center gap-1.5 text-sm font-semibold uppercase tracking-[0.12em] sm:flex">{label}</p>
      <div className={clsx('mt-1 space-y-2 border-l-2 border-current/60 pl-3 sm:pl-4', open ? 'block animate-fade-in' : 'hidden sm:block')}>
        {notes.length === 0 && <p className="text-base text-ink-muted">The note on an earlier line covers this one too.</p>}
        {notes.map((fact, i) =>
          fact.suggestion ? (
            <p key={i} className="text-lg leading-snug text-ink-fg sm:text-xl short:text-base">
              <span className={clsx('mr-1.5 text-xs font-bold uppercase tracking-[0.15em]', PROMPTER_AMBER)}>Suggested wording</span>
              <span className="block">“{fact.suggestion}”</span>
            </p>
          ) : (
            <p key={i} className="text-base leading-snug text-ink-fg/90 sm:text-lg short:text-sm">
              {fact.note}
            </p>
          ),
        )}
      </div>
    </div>
  );
}

function PrompterBlocks({ blocks, name, flags }: { blocks: readonly PitchBlock[]; name?: string; flags: Flags }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'break':
            return <div key={i} className="h-6 short:h-4" aria-hidden />;
          case 'pause':
            return (
              <p key={i} className="my-3 flex items-center gap-3 text-lg font-semibold uppercase tracking-[0.25em] text-ink-muted short:my-2 short:text-base" aria-label="Pause">
                <span aria-hidden>• • •</span>
                <span className="text-sm tracking-[0.15em]">pause{b.seconds != null ? ` ${b.seconds} s` : ''}</span>
              </p>
            );
          case 'direction':
            return b.stepMarker ? null : (
              <p key={i} className="my-3 text-xl italic text-ink-muted short:my-2 short:text-lg">
                ({b.text})
              </p>
            );
          case 'line': {
            const lineFlags = flags.get(b.line);
            const text = (
              <p key={i} className="mb-4 text-[28px] font-semibold leading-[1.4] sm:text-4xl sm:leading-[1.35] short:mb-3 short:text-2xl" data-prompter-line={b.line}>
                <InlineSegments segments={b.segments} tone="prompter" name={name} />
                {lineFlags && (
                  <span className={clsx('ml-2 inline-flex translate-y-[-0.1em] align-middle', PROMPTER_AMBER)}>
                    <AlertTriangle className="h-[0.75em] w-[0.75em]" aria-hidden />
                    <span className="sr-only">(uses a figure the office has not approved yet)</span>
                  </span>
                )}
              </p>
            );
            if (!lineFlags) return text;
            return (
              <div key={i}>
                {text}
                <PrompterFactFlag flags={lineFlags} />
              </div>
            );
          }
          case 'branch':
            return (
              <div key={i} className="my-5 space-y-5 short:my-3 short:space-y-3">
                {b.branches.map((br) => (
                  <div key={br.answer} className="border-l-4 border-ink-fg/30 pl-4 sm:pl-6">
                    <p className="mb-2 text-sm font-bold uppercase tracking-[0.2em] text-ink-muted">If {br.label.toLowerCase()}</p>
                    <PrompterBlocks blocks={br.blocks} name={name} flags={flags} />
                  </div>
                ))}
              </div>
            );
        }
      })}
    </>
  );
}
