// Release 1.2 — L1: the three steps of one lesson (learn → teach it back → signed off) as a small vertical stepper.
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { learnedBySignOff, type LessonProgress } from '@lm/shared';
import type { Lesson } from '@/content/learning';
import { useCurrentUser } from '@/auth/AuthProvider';
import { formatDateShort } from '@/lib/format';
import { reviewerWord } from './reviewer';

export function LessonJourney({ lesson, progress, className }: { lesson: Lesson; progress: LessonProgress | undefined; className?: string }) {
  const who = reviewerWord(useCurrentUser());
  // Learned because a leader signed it off in person (the self-check is still there to take).
  const inPerson = learnedBySignOff(progress);
  const steps = [
    {
      label: lesson.task ? (inPerson ? 'Done at the sign-off' : 'Do it') : inPerson ? 'Learned at the sign-off' : 'Pass the self-check',
      done: Boolean(progress?.learnedAt),
      at: progress?.learnedAt,
      sub: undefined as string | undefined,
      href: '#self-check',
    },
    { label: lesson.task ? `Tell ${who} how it went` : 'Teach it back', done: Boolean(progress?.teachbackAt), at: progress?.teachbackAt, href: '#teach-back' },
    {
      label: `Signed off by ${who}`,
      done: Boolean(progress?.taughtSignedOffAt),
      at: progress?.taughtSignedOffAt,
      sub: progress?.taughtSignedOffByName ?? undefined,
      href: '#teach-back',
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className={clsx('space-y-0', className)} aria-label="Your progress on this lesson">
      {steps.map((s, i) => (
        <li key={s.label} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span className={clsx('absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-0.5', s.done ? 'bg-success/50' : 'bg-border')} aria-hidden />}
          <span
            className={clsx(
              'relative z-10 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
              s.done ? 'bg-success text-status-fg' : i === current ? 'bg-primary-soft text-primary ring-2 ring-primary/40' : 'bg-surface-2 text-muted ring-1 ring-border',
            )}
            aria-hidden
          >
            {s.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <a href={s.href} className="focus-ring -my-0.5 min-w-0 rounded-md py-0.5 text-sm hover:underline">
            <span className={clsx('block font-medium', s.done ? 'text-fg' : i === current ? 'text-fg' : 'text-muted')}>{s.label}</span>
            <span className="block text-xs text-muted">
              {s.done ? `Done ${formatDateShort(s.at)}${s.sub ? ` · ${s.sub}` : ''}` : i === current ? 'Next step' : 'Still to do'}
              <span className="sr-only">{s.done ? ' (done)' : ''}</span>
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
