// Horizontal pipeline stepper; terminal non-hired stages are shown as a badge after the steps.
import { Check } from 'lucide-react';
import clsx from 'clsx';
import type { CandidateStage } from '@lm/shared';
import { PIPELINE_STAGES, STAGE_LABELS, stageIndex } from '@lm/shared';
import { StageBadge } from '@/features/common';

export function StageStepper({ stage }: { stage: CandidateStage }) {
  const idx = stageIndex(stage);
  const closed = idx === -1; // rejected / withdrawn
  return (
    <div>
      <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Pipeline stage">
        {PIPELINE_STAGES.map((s, i) => {
          const done = !closed && i < idx;
          const current = s === stage;
          return (
            <li key={s} className="flex min-w-0 flex-1 items-center gap-1" aria-current={current ? 'step' : undefined}>
              <span className="flex min-w-0 flex-col items-center gap-1 text-center">
                <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold', done && 'border-success bg-success text-status-fg', current && 'border-primary bg-primary text-primary-fg', !done && !current && 'border-border bg-surface text-muted')}>
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                </span>
                <span className={clsx('w-full truncate text-[11px]', current ? 'font-semibold text-fg' : 'text-muted')}>{STAGE_LABELS[s]}</span>
              </span>
              {i < PIPELINE_STAGES.length - 1 && <span className={clsx('mb-5 h-0.5 min-w-2 flex-1', done ? 'bg-success' : 'bg-border')} aria-hidden />}
            </li>
          );
        })}
      </ol>
      {closed && <div className="mt-2 flex items-center gap-2 text-xs text-muted">Pipeline closed: <StageBadge stage={stage} /></div>}
    </div>
  );
}
