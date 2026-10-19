// "Move to…" stage select with a confirmation step for hired / rejected.
// Hiring asks for the team and entry position the new rep account is created with.
// 1.1 (p8): each open target shows the deadline the move sets (today + the stage target), and the toast confirms it.
import { useEffect, useId, useState } from 'react';
import { format } from 'date-fns';
import type { CandidateStage, CandidateWithMeta, Position } from '@lm/shared';
import { POSITION_LABELS, STAGE_LABELS, defaultNextActionAt, stageSlaDays } from '@lm/shared';
import { Field, Select, Textarea, useToast } from '@/components/ui';
import { useMoveCandidateStage, useTeams, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ConfirmDialog, StageBadge, errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { fullName, parseDate } from '@/lib/format';
import { ENTRY_POSITIONS, optionsFrom } from '@/lib/labels';
import { allowedStageTargets } from './stageRules';

/** "Tue 21 Oct" for a date-only deadline, "Tue 21 Oct, 17:00" for a timestamp. */
function formatDue(value: string): string {
  const d = parseDate(value);
  if (!d) return value;
  return format(d, /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'EEE d MMM' : 'EEE d MMM, HH:mm');
}

/**
 * "Next action due Tue 21 Oct (5-day target)" for the deadline a move to `stage` set; the target is named only when the
 * date is the stage default. Null when the stage has no deadline (closed stages, or one cleared on purpose).
 */
export function nextActionDueText(stage: CandidateStage, nextActionAt: string | null | undefined, today = todayISO()): string | null {
  if (!nextActionAt) return null;
  const sla = stageSlaDays(stage);
  const isDefault = sla !== null && nextActionAt === defaultNextActionAt(stage, today);
  return `Next action due ${formatDue(nextActionAt)}${isDefault ? ` (${sla}-day target)` : ''}`;
}

/** The option label for a target stage: "Phone screen · due Sat 24 Oct" for open stages, the bare label for closed ones. */
function targetLabel(stage: CandidateStage, today: string): string {
  const due = defaultNextActionAt(stage, today);
  return due ? `${STAGE_LABELS[stage]} · due ${formatDue(due)}` : STAGE_LABELS[stage];
}

const CONFIRM_STAGES: CandidateStage[] = ['hired', 'rejected'];
/** Stages a candidate never leaves through this control (the server refuses to move hired candidates). */
export const TERMINAL_STAGES: CandidateStage[] = ['hired', 'rejected', 'withdrawn'];

export function MoveStageControl({ candidate, compact, onMoved }: { candidate: CandidateWithMeta; compact?: boolean; onMoved?: (stage: CandidateStage) => void }) {
  const me = useCurrentUser();
  const toast = useToast();
  const id = useId();
  // Only the moves the API accepts: forward (hire only from offer), one step back, reject or withdraw; an admin may
  // reopen a rejected / withdrawn candidate to offer. Nothing else is offered, so no move can end in a 409.
  const targets = allowedStageTargets(candidate.stage, me.role);
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

  if (targets.length === 0) return <StageBadge stage={candidate.stage} />;
  const today = todayISO();

  const doMove = (stage: CandidateStage, n?: string) => {
    move.mutate(
      { id: candidate.id, stage, note: n?.trim() || undefined, ...(stage === 'hired' ? { teamId: hireTeamId ? Number(hireTeamId) : null, position: hirePosition } : {}) },
      {
        onSuccess: (updated) => {
          const due = nextActionDueText(stage, updated?.nextActionAt);
          toast.success(stage === 'hired' ? `${fullName(candidate)} hired` : `Moved to ${STAGE_LABELS[stage]}`, stage === 'hired' ? `Rep account created · ${POSITION_LABELS[hirePosition]}${hireTeamId ? ` · ${teams.data?.find((t) => String(t.id) === hireTeamId)?.name ?? ''}` : ''}` : due ? `${fullName(candidate)} · ${due}` : fullName(candidate));
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
        placeholder={TERMINAL_STAGES.includes(candidate.stage) ? 'Reopen to…' : 'Move to…'}
        disabled={move.isPending}
        onChange={(e) => {
          const stage = e.target.value as CandidateStage | '';
          if (!stage) return;
          if (CONFIRM_STAGES.includes(stage)) setPending(stage);
          else doMove(stage);
        }}
        options={targets.map((s) => ({ value: s, label: targetLabel(s, today) }))}
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
