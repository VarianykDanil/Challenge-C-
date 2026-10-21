// Release 1.2 — L1: the pack's leadership checklist for one person, with a Learn and a Teach tick per lesson. The
// leader of their team (or an admin) signs the Teach tick off here, with or without a written teach-back. A sign-off
// also ticks Learn when it was still empty (the server marks it learned), so Teach ✓ never sits next to Learn ☐.
// Withdrawing takes that Learn back only when nothing else holds it (no passed self-check, no teach-back since).
// On phones the sign-off, withdraw and read buttons are at least 40 px tall (tap targets); desktop is unchanged.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, ListChecks, Square } from 'lucide-react';
import clsx from 'clsx';
import { isTaskLesson, learnedBySignOff, withdrawTakesBackLearned, type LearningProgress, type LessonProgress } from '@lm/shared';
import { useSignOffTeachback } from '@/api/learning';
import { Button, Card, CardHeader, ProgressBar, useToast } from '@/components/ui';
import { ConfirmDialog, apiMessage } from '@/features/common';
import { GROUP_COPY, IMAGES, LESSONS, lessonsByGroup } from '@/content/learning';
import { useCurrentUser } from '@/auth/AuthProvider';
import { formatDateShort } from '@/lib/format';
import { reviewerWord } from './reviewer';
import { LessonPlate } from './LessonFigure';

export interface PersonChecklistProps {
  progress: LearningProgress;
  /** The viewer leads this person's team (or is an admin) and is not the person. */
  canSignOff: boolean;
  self: boolean;
  className?: string;
}

function Tick({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-success text-status-fg" title={label}>
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  ) : (
    <span className="inline-flex h-7 w-7 items-center justify-center text-subtle" title={label}>
      <Square className="h-5 w-5" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PersonChecklist({ progress, canSignOff, self, className }: PersonChecklistProps) {
  const toast = useToast();
  const signOff = useSignOffTeachback();
  const who = reviewerWord(useCurrentUser());
  const [withdraw, setWithdraw] = useState<LessonProgress | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const byKey = new Map(progress.lessons.map((l) => [l.lessonKey, l]));
  const first = progress.userName.split(' ')[0] ?? progress.userName;

  /** What withdrawing a sign-off does to this lesson, in words (the server applies the same rule). */
  const withdrawEffect = (l: LessonProgress): string => {
    const short = LESSONS[l.lessonKey].short;
    const word = isTaskLesson(l.lessonKey) ? 'done' : 'learned';
    if (withdrawTakesBackLearned(l)) return `${short} goes back to not ${word}: it only counted because of this sign-off.`;
    if (l.teachbackAt) {
      return learnedBySignOff(l)
        ? `${short} stays ${word}, because ${first} has written a teach-back since the sign-off. The teach-back goes back to waiting for a sign-off.`
        : `${short} goes back to waiting for a sign-off. ${first}'s teach-back stays.`;
    }
    return `${short} goes back to waiting for ${first}'s teach-back.`;
  };

  const sign = (l: LessonProgress, signedOff: boolean) =>
    signOff.mutate(
      { userId: progress.userId, lessonKey: l.lessonKey, signedOff },
      {
        onSuccess: (r) => {
          setWithdraw(null);
          if (!signedOff) return;
          const what = isTaskLesson(l.lessonKey) ? 'done' : 'learned';
          toast.success(`Signed off: ${LESSONS[l.lessonKey].short}`, r.markedLearned ? `${first} has taught it back, so it counts as ${what} too.` : `${first} has taught it back.`);
        },
        onError: (e) => toast.error('Could not save the sign-off', apiMessage(e, 'Try again in a moment.')),
      },
    );

  return (
    <Card className={className} padded={false}>
      <div className="flex items-start gap-4 p-5 pb-3">
        <div className="min-w-0 flex-1">
          <CardHeader
            className="mb-3"
            icon={<ListChecks />}
            title="Leadership checklist"
            description={self ? `Learn each one with the self-check, then teach it back to ${who}.` : `${first}'s ticks. Sign off Teach once ${first} has taught it back, written or in person; that ticks Learn too.`}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <ProgressBar size="sm" showValue label="Learned" value={progress.learned} max={progress.total} formatValue={(v, m) => `${v} of ${m}`} tone="primary" />
            <ProgressBar size="sm" showValue label="Taught back" value={progress.taught} max={progress.total} formatValue={(v, m) => `${v} of ${m}`} tone="success" />
          </div>
        </div>
        <LessonPlate image={IMAGES.clipboard} size="xs" decorative className="hidden h-24 w-24 shrink-0 sm:flex" />
      </div>
      <div className="border-t border-border">
        <div className="sticky top-16 z-10 grid grid-cols-[minmax(0,1fr)_3rem_minmax(3rem,auto)] items-center gap-2 border-b border-border bg-surface-2/95 px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted backdrop-blur sm:grid-cols-[minmax(0,1fr)_4rem_minmax(5rem,auto)]">
          <span>Lesson</span>
          <span className="text-center">Learn</span>
          <span className="text-center">Teach</span>
        </div>
        {lessonsByGroup().map(({ group, lessons }) => (
          <section key={group} aria-label={GROUP_COPY[group].title}>
            <h4 className="bg-surface-2/40 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{GROUP_COPY[group].title}</h4>
            <ul className="divide-y divide-border/60">
              {lessons.map((lesson) => {
                const l = byKey.get(lesson.key);
                if (!l) return null;
                const task = isTaskLesson(lesson.key);
                const learned = Boolean(l.learnedAt);
                const taught = Boolean(l.taughtSignedOffAt);
                const expanded = open === lesson.key;
                return (
                  <li key={lesson.key} className="px-5 py-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_3rem_minmax(3rem,auto)] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_4rem_minmax(5rem,auto)]">
                      <div className="min-w-0">
                        <Link to={`/learning/pack/${lesson.key}`} className="focus-ring rounded text-sm font-medium text-fg hover:text-primary hover:underline">
                          {lesson.short}
                        </Link>
                        {lesson.checklist.length > 1 && <span className="block text-[11px] text-muted">{lesson.checklist.join(' · ')}</span>}
                        {l.state === 'teachback_sent' && (
                          <span className="block text-[11px] font-medium text-warning">Teach-back sent {formatDateShort(l.teachbackAt)}</span>
                        )}
                        {l.teachbackText && !self && (
                          <button
                            type="button"
                            className="focus-ring mt-0.5 inline-flex min-h-7 items-center gap-1 rounded text-xs font-medium text-primary hover:underline max-sm:min-h-10"
                            aria-expanded={expanded}
                            onClick={() => setOpen(expanded ? null : lesson.key)}
                          >
                            <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
                            {expanded ? 'Hide' : 'Read'} the teach-back
                          </button>
                        )}
                      </div>
                      <div className="flex justify-center">
                        <Tick
                          on={learned}
                          label={
                            learned
                              ? `${task ? 'Done' : 'Learned'} ${formatDateShort(l.learnedAt)}${learnedBySignOff(l) ? ', at the sign-off' : ''}`
                              : task
                                ? 'Not done yet'
                                : 'Not learned yet'
                          }
                        />
                      </div>
                      <div className="flex justify-center">
                        {canSignOff ? (
                          taught ? (
                            <button
                              type="button"
                              className="focus-ring inline-flex min-h-9 items-center justify-center gap-1 rounded-md bg-success px-2 text-xs font-semibold text-status-fg max-sm:min-h-10 max-sm:min-w-10"
                              aria-pressed="true"
                              aria-label={`${lesson.short}: signed off. Withdraw the sign-off`}
                              title={`Signed off ${formatDateShort(l.taughtSignedOffAt)}${l.taughtSignedOffByName ? ` by ${l.taughtSignedOffByName}` : ''}`}
                              onClick={() => setWithdraw(l)}
                            >
                              <Check className="h-4 w-4" aria-hidden />
                              <span className="hidden sm:inline">Taught</span>
                            </button>
                          ) : (
                            <Button
                              size="sm"
                              variant={l.state === 'teachback_sent' ? 'primary' : 'soft'}
                              className="min-h-9 px-2.5 max-sm:min-h-10"
                              aria-label={`Sign off ${lesson.short} for ${first}`}
                              loading={signOff.isPending && signOff.variables?.lessonKey === lesson.key}
                              onClick={() => sign(l, true)}
                            >
                              Sign off
                            </Button>
                          )
                        ) : (
                          <Tick
                            on={taught}
                            label={taught ? `Taught, signed off ${formatDateShort(l.taughtSignedOffAt)}${l.taughtSignedOffByName ? ` by ${l.taughtSignedOffByName}` : ''}` : 'Not taught back yet'}
                          />
                        )}
                      </div>
                    </div>
                    {expanded && l.teachbackText && (
                      <blockquote className="mt-2 whitespace-pre-line rounded-lg border-l-[3px] border-primary/60 bg-surface-2/60 px-3 py-2 text-sm leading-relaxed text-fg">
                        {l.teachbackText}
                      </blockquote>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <ConfirmDialog
        open={withdraw !== null}
        onClose={() => setWithdraw(null)}
        onConfirm={() => withdraw && sign(withdraw, false)}
        loading={signOff.isPending}
        title="Withdraw the sign-off?"
        description={withdraw ? withdrawEffect(withdraw) : undefined}
        confirmLabel="Withdraw"
      />
    </Card>
  );
}
