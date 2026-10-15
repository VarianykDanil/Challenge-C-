// "Move to…" stage select with a confirmation step for hired / rejected.
// Hiring asks for the team and entry position the new rep account is created with.
import { useEffect, useId, useState } from 'react';
import type { CandidateStage, CandidateWithMeta, Position } from '@lm/shared';
import { PIPELINE_STAGES, POSITION_LABELS, STAGE_LABELS } from '@lm/shared';
import { Field, Select, Textarea, useToast } from '@/components/ui';
import { useMoveCandidateStage, useTeams, useUsers } from '@/api/hooks';
import { ConfirmDialog, StageBadge, errorMessage } from '@/features/common';
import { fullName } from '@/lib/format';
import { ENTRY_POSITIONS, optionsFrom } from '@/lib/labels';

const ALL_STAGES: CandidateStage[] = [...PIPELINE_STAGES, 'rejected', 'withdrawn'];
const CONFIRM_STAGES: CandidateStage[] = ['hired', 'rejected'];
/** Stages a candidate never leaves through this control (the server refuses to move hired candidates). */
export const TERMINAL_STAGES: CandidateStage[] = ['hired', 'rejected', 'withdrawn'];

export function MoveStageControl({ candidate, compact, onMoved }: { candidate: CandidateWithMeta; compact?: boolean; onMoved?: (stage: CandidateStage) => void }) {
  const toast = useToast();
  const id = useId();
  const move = useMoveCandidateStage();
  const [pending, setPending] = useState<CandidateStage | null>(null);
  const [note, setNote] = useState('');
  const hiring = pending === 'hired';
  const teams = useTeams();
  const people = useUsers({}, { enabled: hiring });
  const [hireTeamId, setHireTeamId] = useState('');
  const [hirePosition, setHirePosition] = useState<Position>(ENTRY_POSITIONS.includes(candidate.positionApplied) ? candidate.positionApplied : 'field_rep');

  // Default the new rep's team to the candidate owner's team, else the first team.
  useEffect(() => {
    if (!hiring || hireTeamId) return;
    const ownerTeam = people.data?.find((u) => u.id === candidate.ownerId)?.teamId ?? null;
    const fallback = teams.data?.[0]?.id ?? null;
    const pick = ownerTeam ?? fallback;
    if (pick != null) setHireTeamId(String(pick));
  }, [hiring, hireTeamId, people.data, teams.data, candidate.ownerId]);

  if (TERMINAL_STAGES.includes(candidate.stage)) return <StageBadge stage={candidate.stage} />;

  const doMove = (stage: CandidateStage, n?: string) => {
    move.mutate(
      { id: candidate.id, stage, note: n?.trim() || undefined, ...(stage === 'hired' ? { teamId: hireTeamId ? Number(hireTeamId) : null, position: hirePosition } : {}) },
      {
        onSuccess: () => {
          toast.success(stage === 'hired' ? `${fullName(candidate)} hired` : `Moved to ${STAGE_LABELS[stage]}`, stage === 'hired' ? `Rep account created · ${POSITION_LABELS[hirePosition]}${hireTeamId ? ` · ${teams.data?.find((t) => String(t.id) === hireTeamId)?.name ?? ''}` : ''}` : fullName(candidate));
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
        title={hiring ? `Hire ${fullName(candidate)}?` : `Reject ${fullName(candidate)}?`}
        description={hiring ? 'This creates their rep account (role rep) in the team and position below and closes the pipeline for this candidate.' : 'The candidate leaves the pipeline. You can add a short reason for the record.'}
        confirmLabel={hiring ? 'Confirm hire' : 'Reject candidate'}
        tone={hiring ? 'primary' : 'danger'}
        loading={move.isPending}
        onConfirm={() => pending && doMove(pending, note)}
      >
        {hiring && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Team" required htmlFor={`${id}-team`} className="min-w-0">
              <Select id={`${id}-team`} value={hireTeamId} onChange={(e) => setHireTeamId(e.target.value)} placeholder={teams.isLoading ? 'Loading…' : 'No team yet'} options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} />
            </Field>
            <Field label="Position" required htmlFor={`${id}-pos`} className="min-w-0">
              <Select id={`${id}-pos`} value={hirePosition} onChange={(e) => setHirePosition(e.target.value as Position)} options={optionsFrom(POSITION_LABELS, ENTRY_POSITIONS)} />
            </Field>
          </div>
        )}
        <Field label="Note (optional)" htmlFor={`${id}-note`}>
          <Textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={hiring ? 'Start date agreed, who inducts them…' : 'Reason…'} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
