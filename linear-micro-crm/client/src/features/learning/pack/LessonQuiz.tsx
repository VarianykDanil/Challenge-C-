// Release 1.2 — L1: a lesson's 3-question self-check. "Learned" when every answer is right. The server grades the
// options picked (POST …/quiz { answers }) and says which questions were wrong; a failed attempt never shows the right
// option or the explanation (they show once everything is right). A later retake never takes "learned" (or the pass)
// away. A practical task has no questions: it is ticked as done instead.
import { useId, useState } from 'react';
import { CheckCircle2, ClipboardCheck, RotateCcw, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { learnedBySignOff, selfCheckPassed, type LessonProgress } from '@lm/shared';
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

/** The server's grade of the attempt on screen: which questions were right, never which option is. */
interface Attempt {
  correct: boolean[];
  score: number;
  total: number;
  passed: boolean;
  /** Whether the lesson was already learned before this attempt (the refetch after saving flips `learned`). */
  wasLearned: boolean;
}

/** [2] → "question 2"; [1, 3] → "questions 1 and 3". */
function questionList(numbers: number[]): string {
  const n = numbers.map(String);
  const list = n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  return `${n.length === 1 ? 'question' : 'questions'} ${list}`;
}

function Quiz({ lesson, progress }: LessonQuizProps) {
  const id = useId();
  const toast = useToast();
  const submit = useSubmitQuiz();
  const [answers, setAnswers] = useState<(number | null)[]>(() => lesson.quiz.map(() => null));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const learned = Boolean(progress?.learnedAt);
  const passedBefore = selfCheckPassed(progress);
  // Learned, but the self-check never passed: a leader's in-person sign-off counted it.
  const inPerson = learnedBySignOff(progress);
  const total = lesson.quiz.length;
  const allAnswered = answers.every((a) => a !== null);
  const checked = attempt !== null;
  const wrong = attempt ? attempt.correct.flatMap((ok, i) => (ok ? [] : [i + 1])) : [];

  const check = () => {
    if (!allAnswered) return;
    const wasLearned = learned;
    const wasPassed = passedBefore;
    submit.mutate(
      { lessonKey: lesson.key, answers: answers.map((a) => a ?? 0) },
      {
        onSuccess: (r) => {
          const correct = r.correct ?? [];
          setAttempt({ correct, score: r.score ?? correct.filter(Boolean).length, total: r.total ?? total, passed: r.passed, wasLearned });
          if (r.passed) {
            const title = wasPassed ? 'All right again' : wasLearned ? `Self-check passed: ${lesson.short}` : `Learned: ${lesson.short}`;
            toast.success(title, wasLearned ? undefined : 'Next: teach it back in your own words.');
          }
        },
        onError: (e) => toast.error('Could not check your answers', apiMessage(e, 'Try again in a moment.')),
      },
    );
  };
  /** After a pass: start again. After a miss: keep the right answers, clear the ones to look at again. */
  const again = () => {
    setAnswers((a) => (attempt?.passed ? a.map(() => null) : a.map((x, i) => (attempt?.correct[i] ? x : null))));
    setAttempt(null);
  };

  const description = inPerson
    ? `Counted as learned when ${progress?.taughtSignedOffByName ?? 'your leader'} signed it off in person. Take the self-check any time.`
    : learned
      ? `You passed this one${progress?.quizScore != null && progress.quizTotal ? `; last try ${progress.quizScore} of ${progress.quizTotal}` : ''}. Take it again any time.`
      : `${total} questions from the lesson. Get them all right to mark it learned.`;

  return (
    <Card>
      <CardHeader icon={<ClipboardCheck />} title="Self-check" description={description} />
      <div className="space-y-5">
        {lesson.quiz.map((q, qi) => {
          const chosen = answers[qi];
          const ok = attempt?.correct[qi];
          return (
            <fieldset key={qi} className="min-w-0" aria-describedby={checked ? `${id}-why-${qi}` : undefined}>
              <legend className="mb-2 text-sm font-semibold text-fg">
                <span className="tabular text-muted">{qi + 1}. </span>
                {q.q}
              </legend>
              <div className="grid gap-1.5">
                {q.options.map((opt, oi) => {
                  const selected = chosen === oi;
                  // Only the option picked is marked, right or wrong; an unpicked option is never shown as the answer.
                  const right = checked && selected && ok === true;
                  const miss = checked && selected && ok === false;
                  return (
                    <label
                      key={oi}
                      className={clsx(
                        'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                        right ? 'border-success/50 bg-success-soft' : miss ? 'border-danger/50 bg-danger-soft' : selected ? 'border-primary/60 bg-primary-soft' : 'border-border bg-surface hover:bg-surface-2',
                        (checked || submit.isPending) && 'cursor-default',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${id}-q${qi}`}
                        value={oi}
                        checked={selected}
                        disabled={checked || submit.isPending}
                        onChange={() => setAnswers((a) => a.map((x, i) => (i === qi ? oi : x)))}
                        className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                      />
                      <span className="min-w-0 flex-1 text-fg">{opt}</span>
                      {right && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="Right" />}
                      {miss && <XCircle className="h-4 w-4 shrink-0 text-danger" aria-label="Not this one" />}
                    </label>
                  );
                })}
              </div>
              {checked && (
                <p id={`${id}-why-${qi}`} className={clsx('mt-2 text-xs leading-relaxed', ok ? 'text-success' : 'text-danger')}>
                  {attempt.passed ? (
                    <>
                      Right. <span className="text-muted">{q.why}</span>
                    </>
                  ) : ok ? (
                    'Right.'
                  ) : (
                    <>
                      Not this one. <span className="text-muted">Have another look at the lesson.</span>
                    </>
                  )}
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
            <p className={clsx('min-w-0 text-sm font-semibold', attempt.passed ? 'text-success' : 'text-fg')}>
              {attempt.score} of {attempt.total} right
              {attempt.passed ? (attempt.wasLearned ? '' : ': learned!') : `. Have another look at ${questionList(wrong)} in the lesson, then try again.`}
            </p>
            <Button variant="outline" size="sm" leftIcon={<RotateCcw />} onClick={again}>
              {attempt.passed ? 'Take it again' : 'Try again'}
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
          <CheckCircle2 className="h-4 w-4" aria-hidden /> {learnedBySignOff(progress) ? 'Ticked as done when it was signed off' : 'Ticked as done'}
        </p>
      ) : (
        <Button
          loading={submit.isPending}
          leftIcon={<CheckCircle2 />}
          onClick={() =>
            submit.mutate(
              // A task has no questions: no answers ticks it as done (the server records 1 of 1).
              { lessonKey: lesson.key, answers: [] },
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
