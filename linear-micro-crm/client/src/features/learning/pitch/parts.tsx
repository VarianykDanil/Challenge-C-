// Release 1.2 — L2 learning-pitch: small pieces shared by the read view, the teleprompter, the flashcards and the
// editor preview (inline segments, theory chips, fact notes, step labels, durations).
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, BadgeCheck, ChevronDown, ExternalLink, GraduationCap, Info, Target } from 'lucide-react';
import type { PitchAnnotation, PitchFact, PitchSegment, PitchStepKey, PitchStepTarget } from '@lm/shared';

/** "22 s", "1 min 5 s", "2 min". */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** "7–10 s" for a pack target, or null when the pack sets none. */
export function targetLabel(t: Pick<PitchStepTarget, 'minSeconds' | 'maxSeconds'>): string | null {
  if (t.minSeconds != null && t.maxSeconds != null) return `${t.minSeconds}–${t.maxSeconds} s`;
  if (t.maxSeconds != null) return `up to ${t.maxSeconds} s`;
  if (t.minSeconds != null) return `at least ${t.minSeconds} s`;
  return null;
}

export const STEP_NUMBER: Record<PitchStepKey, number> = {
  introduction: 1,
  'short-story': 2,
  presentation: 3,
  close: 4,
  consolidation: 5,
};

/** The pack's one-line reminder for each step (shown under a step heading). */
export const STEP_HINT: Record<PitchStepKey, string> = {
  introduction: 'First impression: smile, eye contact, excitement.',
  'short-story': 'Who? What? Why? Answer the three Ws as soon as you can.',
  presentation: 'Create the problem and be the solution.',
  close: 'An assumptive statement that gets a yes or no, at the height of impulse.',
  consolidation: 'Remind them why they signed up; pre-empt the welcome call.',
};

export const lessonHref = (a: Pick<PitchAnnotation, 'lessonKey' | 'anchor'>) => `/learning/pack/${a.lessonKey}${a.anchor ? `#${a.anchor}` : ''}`;
export const stepLessonHref = (step: PitchStepKey) => `/learning/pack/five-steps#${step}`;

/** One spoken line's inline pieces. `tone="prompter"` is for the always-dark teleprompter. */
export function InlineSegments({ segments, tone = 'page', name }: { segments: readonly PitchSegment[]; tone?: 'page' | 'prompter'; name?: string }) {
  const out: ReactNode[] = [];
  segments.forEach((s, i) => {
    if (i > 0 && !(s.kind === 'text' && /^[,.!?;:]/.test(s.text))) out.push(' ');
    if (s.kind === 'text') out.push(<span key={i}>{s.text}</span>);
    else if (s.kind === 'name')
      out.push(
        name ? (
          <span key={i} className={clsx('font-semibold', tone === 'prompter' ? 'text-ink-fg underline decoration-dotted underline-offset-4' : 'text-primary')}>{name}</span>
        ) : (
          <span
            key={i}
            className={clsx(
              'inline-flex items-center rounded-md border border-dashed px-1.5 align-baseline text-[0.8em] font-semibold leading-snug',
              tone === 'prompter' ? 'border-ink-fg/50 text-ink-fg' : 'border-primary/50 bg-primary-soft text-primary',
            )}
          >
            Name<span className="sr-only"> (say their name)</span>
          </span>
        ),
      );
    else if (s.kind === 'close')
      out.push(
        <span
          key={i}
          className={clsx(
            'inline-flex items-center gap-1 rounded-full px-2 align-middle text-[0.6em] font-bold uppercase leading-[1.9] tracking-wider',
            tone === 'prompter' ? 'bg-ink-fg/15 text-ink-fg' : 'bg-accent-soft text-accent',
          )}
        >
          <Target className="h-[1.1em] w-[1.1em]" aria-hidden />
          Close
        </span>,
      );
    else if (s.kind === 'pause')
      out.push(
        <span key={i} className={clsx('text-[0.75em] font-medium italic', tone === 'prompter' ? 'text-ink-muted' : 'text-muted')}>
          (pause{s.seconds != null ? ` ${s.seconds} s` : ''})
        </span>,
      );
    else
      out.push(
        <span key={i} className={clsx('text-[0.75em] italic', tone === 'prompter' ? 'text-ink-muted' : 'text-muted')}>
          ({s.text})
        </span>,
      );
  });
  return <>{out}</>;
}

/**
 * The COD pack theories a line uses: a chip per theory; tapping one shows why it works and a link to its lesson.
 * Chips are 32 px tall with a 40 px tap area.
 */
export function TheoryChips({ annotations, className }: { annotations: readonly PitchAnnotation[]; className?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!annotations.length) return null;
  const active = annotations.find((a) => a.theory === open) ?? null;
  return (
    <div className={clsx('mt-2', className)}>
      <div className="flex flex-wrap gap-x-1.5 gap-y-2">
        {annotations.map((a) => {
          const on = a.theory === open;
          return (
            <button
              key={a.theory}
              type="button"
              aria-expanded={on}
              onClick={() => setOpen(on ? null : a.theory)}
              className={clsx(
                'focus-ring relative inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors',
                "after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
                on ? 'bg-primary-soft text-primary ring-primary/40' : 'bg-surface-2 text-muted ring-border hover:text-fg',
              )}
            >
              <GraduationCap className="h-3.5 w-3.5" aria-hidden />
              {a.label}
            </button>
          );
        })}
      </div>
      {active && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-surface-2/70 px-3 py-2 text-sm text-fg animate-fade-in">
          <span>
            {/* "Introduction (7 to 10 seconds): …", "Use buzzwords: …" already name the theory: no "Label:" before them. */}
            {!active.why.toLowerCase().includes(active.label.toLowerCase()) && <span className="font-semibold">{active.label}: </span>}
            {active.why}.
          </span>
          <Link to={lessonHref(active)} className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-primary hover:underline sm:min-h-0">
            Open the lesson <span aria-hidden>→</span>
          </Link>
        </p>
      )}
    </div>
  );
}

const FACT_TONE = {
  check: { icon: AlertTriangle, label: 'Check the figures', box: 'border-warning/30 bg-warning-soft', text: 'text-warning' },
  verified: { icon: BadgeCheck, label: 'Checked', box: 'border-success/30 bg-success-soft', text: 'text-success' },
  info: { icon: Info, label: 'Note', box: 'border-info/30 bg-info-soft', text: 'text-info' },
} as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** One fact-check note as a small card: the quote, the note, a suggested wording and its sources. */
export function FactNote({ fact, className, showQuote = true }: { fact: PitchFact; className?: string; showQuote?: boolean }) {
  const t = FACT_TONE[fact.tone];
  const Icon = t.icon;
  return (
    <div className={clsx('rounded-xl border p-3 text-sm', t.box, className)}>
      <p className={clsx('flex items-center gap-1.5 text-xs font-semibold', t.text)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t.label}
      </p>
      {showQuote && fact.quotes.length > 0 && (
        <p className="mt-1.5 text-xs italic text-muted">{fact.quotes.map((q) => `“${q}”`).join(' and ')}</p>
      )}
      <p className="mt-1.5 leading-relaxed text-fg">{fact.note}</p>
      {fact.suggestion && (
        <div className="mt-2 rounded-lg bg-surface/80 px-2.5 py-2 ring-1 ring-inset ring-border">
          <p className="eyebrow text-muted">Suggested wording</p>
          <p className="mt-1 font-medium leading-relaxed text-fg">“{fact.suggestion}”</p>
        </div>
      )}
      {fact.sources.length > 0 && (
        <ul className="mt-2 space-y-1">
          {fact.sources.map((src) => (
            <li key={src}>
              <a href={src} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-8 max-w-full items-center gap-1 break-all text-xs font-medium text-primary hover:underline">
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{hostOf(src)}</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * On phones a fact note folds under its line behind a "Check the figures" button. With `openOnWide` (the flashcards)
 * the note is simply shown from the `sm` breakpoint up, and only phones fold it.
 */
export function FoldedFactNote({ fact, openOnWide = false }: { fact: PitchFact; openOnWide?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = FACT_TONE[fact.tone];
  const Icon = t.icon;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold ring-1 ring-inset',
          t.text,
          'ring-current/30 hover:bg-surface-2',
          openOnWide && 'sm:hidden',
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {t.label}
        <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {openOnWide ? (
        // Fades in only when opened on a phone: a media-query flip (rotating a tablet) must not replay it.
        <FactNote fact={fact} showQuote={false} className={clsx('sm:mt-0', open ? 'mt-2 animate-fade-in sm:animate-none' : 'max-sm:hidden')} />
      ) : (
        open && <FactNote fact={fact} showQuote={false} className="mt-2 animate-fade-in" />
      )}
    </div>
  );
}
