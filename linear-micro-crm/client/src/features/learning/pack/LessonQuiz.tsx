// Release 1.2 — L1: a lesson's 3-question self-check. "Learned" when every answer is right (the server records the
// score; a later retake never takes "learned" away). A practical task has no questions: it is ticked as done instead.
import { useId, useState } from 'react';
import { CheckCircle2, ClipboardCheck, RotateCcw, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { LessonProgress } from '@lm/shared';
import { useSubmitQuiz } from '@/api/learning';
import { Button, Card, CardHeader, useToast } from '@/components/ui';
import { apiMessage } from '@/features/common';
import type { Lesson } from '@/content/learning';

export interface LessonQuizProps {
  lesson: Lesson;
  progress: LessonProgress | undefined;
}

export function LessonQuiz({ lesson, progress }: LessonQuizProps) {
  if (lesson.task) return <TaskDone lesson={lesson} progress={progress} />;
  return <Quiz lesson={lesson} progress={progress} />;
}

function Quiz({ lesson, progress }: LessonQuizProps) {
  const id = useId();
  const toast = useToast();
  const submit = useSubmitQuiz();
  const [answers, setAnswers] = useState<(number | null)[]>(() => lesson.quiz.map(() => null));
  const [checked, setChecked] = useState(false);
  // Whether the lesson was already learned when this attempt was checked (the refetch after saving flips `learned`).
  const [wasLearned, setWasLearned] = useState(false);
  const learned = Boolean(progress?.learnedAt);
  const total = lesson.quiz.length;
  const score = answers.filter((a, i) => a === lesson.quiz[i]!.answer).length;
  const allAnswered = answers.every((a) => a !== null);

  const check = () => {
    setChecked(true);
    setWasLearned(learned);
    submit.mutate(
      { lessonKey: lesson.key, score, total },
      {
        onSuccess: (r) => {
          if (r.passed) toast.success(learned ? 'All right again' : `Learned: ${lesson.short}`, learned ? undefined : 'Next: teach it back in your own words.');
        },
        onError: (e) => toast.error('Could not save your answers', apiMessage(e, 'Try again in a moment.')),
      },
    );
  };
  const reset = () => {
    setAnswers(lesson.quiz.map(() => null));
    setChecked(false);
  };

  return (
    <Card>
      <CardHeader
        icon={<ClipboardCheck />}
        title="Self-check"
        description={learned ? `You passed this one${progress?.quizScore != null && progress.quizTotal ? `; last try ${progress.quizScore} of ${progress.quizTotal}` : ''}. Take it again any time.` : `${total} questions from the lesson. Get them all right to mark it learned.`}
      />
      <div className="space-y-5">
        {lesson.quiz.map((q, qi) => {
          const chosen = answers[qi];
          return (
            <fieldset key={qi} className="min-w-0" aria-describedby={checked ? `${id}-why-${qi}` : undefined}>
              <legend className="mb-2 text-sm font-semibold text-fg">
                <span className="tabular text-muted">{qi + 1}. </span>
                {q.q}
              </legend>
              <div className="grid gap-1.5">
                {q.options.map((opt, oi) => {
                  const selected = chosen === oi;
                  const right = checked && oi === q.answer;
                  const wrong = checked && selected && oi !== q.answer;
                  return (
                    <label
                      key={oi}
                      className={clsx(
                        'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                        right ? 'border-success/50 bg-success-soft' : wrong ? 'border-danger/50 bg-danger-soft' : selected ? 'border-primary/60 bg-primary-soft' : 'border-border bg-surface hover:bg-surface-2',
                        checked && 'cursor-default',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${id}-q${qi}`}
                        value={oi}
                        checked={selected}
                        disabled={checked}
                        onChange={() => setAnswers((a) => a.map((x, i) => (i === qi ? oi : x)))}
                        className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                      />
                      <span className="min-w-0 flex-1 text-fg">{opt}</span>
                      {right && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="Right answer" />}
                      {wrong && <XCircle className="h-4 w-4 shrink-0 text-danger" aria-label="Not this one" />}
                    </label>
                  );
                })}
              </div>
              {checked && (
                <p id={`${id}-why-${qi}`} className={clsx('mt-2 text-xs leading-relaxed', chosen === q.answer ? 'text-success' : 'text-muted')}>
                  {chosen === q.answer ? 'Right. ' : 'Not quite. '}
                  <span className="text-muted">{q.why}</span>
                </p>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3" aria-live="polite">
        {!checked ? (
          <Button onClick={check} disabled={!allAnswered} loading={submit.isPending}>
            Check my answers
          </Button>
        ) : (
          <>
            <p className={clsx('text-sm font-semibold', score === total ? 'text-success' : 'text-fg')}>
              {score} of {total} right{score === total ? (wasLearned ? '' : ': learned!') : '. Have another look at the lesson and try again.'}
            </p>
            <Button variant="outline" size="sm" leftIcon={<RotateCcw />} onClick={reset}>
              Try again
            </Button>
          </>
        )}
        {!checked && !allAnswered && <span className="text-xs text-muted">Answer all {total} to check.</span>}
      </div>
    </Card>
  );
}

function TaskDone({ lesson, progress }: LessonQuizProps) {
  const toast = useToast();
  const submit = useSubmitQuiz();
  const done = Boolean(progress?.learnedAt);
  return (
    <Card>
      <CardHeader icon={<ClipboardCheck />} title="Done it?" description="Tick it once you have done it, then say how it went." />
      {done ? (
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> Ticked as done
        </p>
      ) : (
        <Button
          loading={submit.isPending}
          leftIcon={<CheckCircle2 />}
          onClick={() =>
            submit.mutate(
              { lessonKey: lesson.key, score: 1, total: 1 },
              {
                onSuccess: () => toast.success(`Done: ${lesson.short}`, 'Now say how it went, below.'),
                onError: (e) => toast.error('Could not save that', apiMessage(e, 'Try again in a moment.')),
              },
            )
          }
        >
          I’ve done this
        </Button>
      )}
    </Card>
  );
}
