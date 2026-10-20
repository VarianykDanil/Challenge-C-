// Release 1.2 — L1: the pack's career ladder (pages 18–19) as HTML cards: what each level learns and the criteria to
// progress. The progression tracker marks "You are here" and "Next".
import { ArrowRight, MapPin } from 'lucide-react';
import clsx from 'clsx';
import { CAREER_LEVEL_LABELS, type CareerLevel } from '@lm/shared';
import { Badge } from '@/components/ui';
import { CAREER_LADDER } from '@/content/learning';

export interface CareerLadderProps {
  current?: CareerLevel | null;
  next?: CareerLevel | null;
  className?: string;
  /** Heading level for the level names (the lesson page uses h3 under its h2 sections). */
  headingLevel?: 'h3' | 'h4';
  /** Badge on the current level ("You are here"; "Current level" when a leader looks at someone else). */
  hereLabel?: string;
}

const PHASE_COPY = {
  pre: { title: 'Pre-management progression structure', description: 'From entry level to running your own office.' },
  post: { title: 'Post-management progression structure', description: 'From your own office to overseeing seven.' },
} as const;

export function CareerLadder({ current, next, className, headingLevel = 'h3', hereLabel = 'You are here' }: CareerLadderProps) {
  const H = headingLevel;
  return (
    <div className={clsx('space-y-6', className)}>
      {(['pre', 'post'] as const).map((phase) => (
        <section key={phase} aria-label={PHASE_COPY[phase].title}>
          <div className="mb-3">
            <div className="eyebrow">{phase === 'pre' ? 'Pre-management' : 'Post-management'}</div>
            <p className="mt-0.5 text-xs text-muted">{PHASE_COPY[phase].description}</p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {CAREER_LADDER.filter((l) => l.phase === phase).map((l) => {
              const here = l.level === current;
              const isNext = l.level === next;
              const step = CAREER_LADDER.indexOf(l) + 1;
              return (
                <li
                  key={l.level}
                  className={clsx(
                    'relative flex min-w-0 flex-col rounded-xl border p-4',
                    here ? 'border-primary/50 bg-primary-soft' : isNext ? 'border-accent/40 bg-accent-soft/60' : 'border-border bg-surface-2/40',
                  )}
                  aria-current={here ? 'step' : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-surface px-1.5 text-[11px] font-semibold tabular text-muted ring-1 ring-border">{step}</span>
                    {here && (
                      <Badge tone="primary" size="sm">
                        <MapPin aria-hidden />
                        {hereLabel}
                      </Badge>
                    )}
                    {isNext && (
                      <Badge tone="accent" size="sm">
                        <ArrowRight aria-hidden />
                        Next
                      </Badge>
                    )}
                  </div>
                  <H className="mt-2 font-display text-base font-bold leading-tight text-fg">{CAREER_LEVEL_LABELS[l.level]}</H>
                  <p className="mt-0.5 text-xs font-medium text-primary">{l.focus}</p>
                  <ul className="mt-2 flex flex-wrap gap-1" aria-label="What you learn">
                    {l.learn.map((x) => (
                      <li key={x} className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] leading-snug text-muted ring-1 ring-inset ring-border">
                        {x}
                      </li>
                    ))}
                  </ul>
                  {l.criteria.length > 0 && (
                    <div className="mt-3 border-t border-border/70 pt-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-accent">Criteria to progress</div>
                      <ul className="mt-1 space-y-1 text-xs leading-snug text-fg">
                        {l.criteria.map((c) => (
                          <li key={c} className="flex gap-1.5">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
