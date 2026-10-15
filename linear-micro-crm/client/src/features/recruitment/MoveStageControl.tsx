// "Move to…" stage select with a confirmation step for hired / rejected.
import { useId, useState } from 'react';
import type { CandidateStage, CandidateWithMeta } from '@lm/shared';
import { PIPELINE_STAGES, STAGE_LABELS } from '@lm/shared';
import { Field, Select, Textarea, useToast } from '@/components/ui';
import { useMoveCandidateStage } from '@/api/hooks';
import { ConfirmDialog, errorMessage } from '@/features/common';
import { fullName } from '@/lib/format';

const ALL_STAGES: CandidateStage[] = [...PIPELINE_STAGES, 'rejected', 'withdrawn'];
const CONFIRM_STAGES: CandidateStage[] = ['hired', 'rejected'];

export function MoveStageControl({ candidate, compact, onMoved }: { candidate: CandidateWithMeta; compact?: boolean; onMoved?: (stage: CandidateStage) => void }) {
  const toast = useToast();
  const id = useId();
  const move = useMoveCandidateStage();
  const [pending, setPending] = useState<CandidateStage | null>(null);
  const [note, setNote] = useState('');

  const doMove = (stage: CandidateStage, n?: string) => {
    move.mutate(
      { id: candidate.id, stage, note: n?.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(stage === 'hired' ? `${fullName(candidate)} hired` : `Moved to ${STAGE_LABELS[stage]}`, stage === 'hired' ? 'A rep account has been created for them.' : fullName(candidate));
          setPending(null);
          setNote('');
          onMoved?.(stage);
        },
        onError: (e) => toast.error('Could not move candidate', errorMessage(e)),
      },
    );
  };

  return (
    <>
      <label htmlFor={`${id}-stage`} className="sr-only">Move {fullName(candidate)} to stage</label>
      <Select
        id={`${id}-stage`}
        value=""
        placeholder="Move to…"
        disabled={move.isPending}
        onChange={(e) => {
          const stage = e.target.value as CandidateStage | '';
          if (!stage) return;
          if (CONFIRM_STAGES.includes(stage)) setPending(stage);
          else doMove(stage);
        }}
        options={ALL_STAGES.filter((s) => s !== candidate.stage).map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
        size={compact ? 'sm' : 'md'}
        onClick={(e) => e.stopPropagation()}
      />
      <ConfirmDialog
        open={pending != null}
        onClose={() => setPending(null)}
        title={pending === 'hired' ? `Hire ${fullName(candidate)}?` : `Reject ${fullName(candidate)}?`}
        description={pending === 'hired' ? 'This creates a rep account (role rep, position as applied, team of the owner) and closes the pipeline for this candidate.' : 'The candidate leaves the pipeline. You can add a short reason for the record.'}
        confirmLabel={pending === 'hired' ? 'Confirm hire' : 'Reject candidate'}
        tone={pending === 'hired' ? 'primary' : 'danger'}
        loading={move.isPending}
        onConfirm={() => pending && doMove(pending, note)}
      >
        <Field label="Note (optional)" htmlFor={`${id}-note`}>
          <Textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={pending === 'hired' ? 'Start date agreed, team…' : 'Reason…'} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
