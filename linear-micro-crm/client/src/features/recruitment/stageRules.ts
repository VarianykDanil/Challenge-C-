// Which stage moves the API accepts (server `assertStageTransition`), mirrored so the "Move to…" menu never offers a
// transition that ends in 409.
import type { CandidateStage, Role } from '@lm/shared';
import { PIPELINE_STAGES, isOpenStage, stageIndex } from '@lm/shared';

/**
 * Allowed targets from `stage`:
 *  - forward along the pipeline, any number of steps (`hired` only from `offer`);
 *  - one step back;
 *  - `rejected` / `withdrawn` from any open stage;
 *  - from `rejected` / `withdrawn`: only an administrator may reopen the candidate, and only to `offer`;
 *  - nothing from `hired`.
 */
export function allowedStageTargets(stage: CandidateStage, role?: Role): CandidateStage[] {
  if (stage === 'rejected' || stage === 'withdrawn') return role === 'admin' ? ['offer'] : [];
  if (!isOpenStage(stage)) return [];
  const i = stageIndex(stage);
  if (i < 0) return [];
  const out: CandidateStage[] = [];
  for (let j = i + 1; j < PIPELINE_STAGES.length; j++) {
    const s = PIPELINE_STAGES[j]!;
    if (s === 'hired' && stage !== 'offer') continue;
    out.push(s);
  }
  const back = PIPELINE_STAGES[i - 1];
  if (i > 0 && back) out.push(back);
  out.push('rejected', 'withdrawn');
  return out;
}

export function canMoveTo(from: CandidateStage, to: CandidateStage, role?: Role): boolean {
  return allowedStageTargets(from, role).includes(to);
}
