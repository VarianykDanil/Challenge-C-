// Release 1.2 — L2 learning-pitch: the step timer. The five steps with the pack's target times (introduction 7–10 s,
// short story 10–15 s), the script's read-aloud estimate per step, and a practice stopwatch: Start, then "Next step"
// as you move on, to see your own time per step against the targets. While it runs the card sticks under the top bar
// (on phones as one compact line), so it stays in reach while you read down the script. Nothing is saved.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Flag, Play, RotateCcw, SkipForward, Square, Timer } from 'lucide-react';
import { pitchStepVerdict, type PitchStepEstimate } from '@lm/shared';
import { Button, Card } from '@/components/ui';
import { STEP_NUMBER, formatSeconds, targetLabel } from './parts';

interface Run {
  step: number;
  startedAt: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function lapLabel(s: number): string {
  return s < 60 ? `${s.toFixed(1)} s` : formatSeconds(s);
}

export function StepTimer({ steps, wordsPerMinute, className }: { steps: readonly PitchStepEstimate[]; wordsPerMinute: number; className?: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [laps, setLaps] = useState<(number | null)[]>(() => steps.map(() => null));
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!run) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(id);
  }, [run]);

  const elapsed = run ? (now() - run.startedAt) / 1000 : 0;
  const record = (step: number, secs: number) => setLaps((l) => l.map((v, i) => (i === step ? secs : v)));
  const start = () => {
    setLaps(steps.map(() => null));
    setRun({ step: 0, startedAt: now() });
  };
  const next = () => {
    if (!run) return;
    const t = now();
    record(run.step, (t - run.startedAt) / 1000);
    setRun(run.step + 1 < steps.length ? { step: run.step + 1, startedAt: t } : null);
  };
  const stop = () => {
    if (!run) return;
    record(run.step, (now() - run.startedAt) / 1000);
    setRun(null);
  };
  const reset = () => {
    setRun(null);
    setLaps(steps.map(() => null));
  };
  const timed = laps.some((l) => l != null);
  const total = laps.reduce<number>((a, b) => a + (b ?? 0), 0) + (run ? elapsed : 0);
  const current = run ? steps[run.step] : null;
  const last = run ? run.step === steps.length - 1 : false;
  const showTiles = open || (!run && timed);

  return (
    <Card className={clsx(run && 'sticky top-[4.5rem] z-20 shadow-pop', 'p-4 sm:p-5', className)} data-step-timer aria-label="Step timer">
      <div className={clsx('flex items-start justify-between gap-3', run && 'max-sm:hidden')}>
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
            <Timer className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="font-sans text-sm font-semibold tracking-normal text-fg">Step timer</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              Pack targets: introduction 7–10 s, short story 10–15 s. Script times are estimates at {wordsPerMinute} words a minute.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={showTiles}
          className="focus-ring -mr-1 inline-flex h-10 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg sm:hidden"
        >
          Steps
          <ChevronDown className={clsx('h-4 w-4 transition-transform', showTiles && 'rotate-180')} aria-hidden />
        </button>
      </div>

      {/* Phones while running: one compact line instead of the five tiles. */}
      {run && current && (
        <p className="flex items-baseline gap-2 text-sm sm:hidden" aria-live="off">
          <span className="font-semibold text-fg">
            {STEP_NUMBER[current.step]} · {current.label}
          </span>
          <span className="tabular text-fg">{lapLabel(elapsed)}</span>
          <span className="truncate text-xs text-muted">{targetLabel(current) ? `target ${targetLabel(current)}` : 'no set time'}</span>
        </p>
      )}

      <ol
        className={clsx(
          'scrollbar-thin relative -mx-1 mt-3 snap-x gap-2 overflow-x-auto px-1 pb-1 sm:grid sm:grid-cols-5 sm:overflow-visible',
          showTiles && !run ? 'flex' : 'hidden',
        )}
      >
        {steps.map((s, i) => {
          const target = targetLabel(s);
          const est = pitchStepVerdict(s.seconds, s);
          const lap = run?.step === i ? elapsed : laps[i];
          const yours = lap != null ? pitchStepVerdict(lap, s) : 'none';
          const active = run?.step === i;
          return (
            <li
              key={s.step}
              className={clsx(
                'min-w-[8.5rem] snap-start rounded-xl border p-3 transition-colors sm:min-w-0',
                active ? 'border-primary bg-primary-soft ring-1 ring-primary' : 'border-border bg-surface-2/50',
              )}
              aria-current={active ? 'step' : undefined}
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] tabular ring-1 ring-border" aria-hidden>
                  {STEP_NUMBER[s.step]}
                </span>
                <span className="truncate">{s.label}</span>
              </p>
              <p className="mt-1.5 text-xs text-muted">{target ? `Target ${target}` : 'No set time'}</p>
              <p className={clsx('mt-0.5 text-xs', est === 'over' || est === 'under' ? 'text-warning' : 'text-muted')}>
                {s.lines ? `Script about ${formatSeconds(s.seconds)}` : 'Not in the script'}
              </p>
              <p
                className={clsx(
                  'mt-1.5 text-sm font-semibold tabular',
                  lap == null ? 'text-muted' : yours === 'within' ? 'text-success' : yours === 'none' ? 'text-fg' : 'text-warning',
                )}
              >
                {lap == null ? '—' : `You ${lapLabel(lap)}`}
                {lap != null && !active && yours === 'within' && <span className="sr-only"> (on target)</span>}
                {lap != null && !active && yours === 'over' && <span className="sr-only"> (longer than the target)</span>}
                {lap != null && !active && yours === 'under' && <span className="sr-only"> (shorter than the target)</span>}
              </p>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!run ? (
          <Button onClick={start} leftIcon={<Play />}>{timed ? 'Time it again' : 'Start'}</Button>
        ) : (
          <>
            <Button onClick={next} leftIcon={last ? <Flag /> : <SkipForward />}>{last ? 'Finish' : 'Next step'}</Button>
            <Button variant="outline" onClick={stop} leftIcon={<Square />}>Stop</Button>
          </>
        )}
        {(timed || run) && !run && (
          <Button variant="ghost" onClick={reset} leftIcon={<RotateCcw />}>Reset</Button>
        )}
        {(timed || run) && <span className="ml-auto text-sm tabular text-muted">Total {lapLabel(total)}</span>}
      </div>
    </Card>
  );
}
