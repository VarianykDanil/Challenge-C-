// Release 1.3 — OWNED BY P7 recruitment-plus. Move an interview to another time or give it to another interviewer.
// PATCH /recruitment/interviews/:id with only what changed; the server writes each change to interview_changes (who and
// when), so the candidate's timeline says "Interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah".
import { useId, useState } from 'react';
import type { Interview } from '@lm/shared';
import { Button, Field, Input, Modal, Select, useToast } from '@/components/ui';
import { useUpdateInterview, useUsers } from '@/api/hooks';
import { errorMessage } from '@/features/common';
import { isoToLocalInput, localInputToISO } from '@/lib/dates';
import { fullName } from '@/lib/format';
import { INTERVIEW_TYPE_LABELS } from '@/lib/labels';

export function RescheduleInterviewModal({ interview, candidateName, open, onClose }: { interview: Interview | null; candidateName?: string; open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open && !!interview}
      onClose={onClose}
      title="Reschedule or reassign"
      description={interview ? `${INTERVIEW_TYPE_LABELS[interview.type]}${candidateName ? ` with ${candidateName}` : ''}` : undefined}
      size="md"
    >
      {interview && <RescheduleForm key={interview.id} interview={interview} onClose={onClose} />}
    </Modal>
  );
}

function RescheduleForm({ interview, onClose }: { interview: Interview; onClose: () => void }) {
  const toast = useToast();
  const uid = useId();
  const update = useUpdateInterview();
  const people = useUsers({});
  const [when, setWhen] = useState(isoToLocalInput(interview.scheduledAt));
  const [interviewerId, setInterviewerId] = useState(interview.interviewerId ? String(interview.interviewerId) : '');
  const [error, setError] = useState<string | null>(null);
  const iso = localInputToISO(when);
  const moved = !!iso && new Date(iso).getTime() !== new Date(interview.scheduledAt).getTime();
  const reassigned = (interviewerId ? Number(interviewerId) : null) !== (interview.interviewerId ?? null);

  const submit = async () => {
    if (!iso) { setError('Pick a date and time'); return; }
    setError(null);
    if (!moved && !reassigned) { onClose(); return; }
    try {
      await update.mutateAsync({
        id: interview.id,
        ...(moved ? { scheduledAt: iso } : {}),
        ...(reassigned ? { interviewerId: interviewerId ? Number(interviewerId) : null } : {}),
      });
      toast.success(moved && reassigned ? 'Interview moved and reassigned' : moved ? 'Interview moved' : 'Interviewer changed', 'Saved on the candidate\'s timeline.');
      onClose();
    } catch (e) {
      toast.error('Could not save the change', errorMessage(e));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <Field label="Date and time" required htmlFor={`${uid}-when`} error={error ?? undefined}><Input id={`${uid}-when`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} invalid={!!error} /></Field>
      <Field label="Interviewer" htmlFor={`${uid}-who`}>
        <Select id={`${uid}-who`} value={interviewerId} onChange={(e) => setInterviewerId(e.target.value)} placeholder="No interviewer yet" options={(people.data ?? []).filter((u) => u.role !== 'rep').map((u) => ({ value: String(u.id), label: fullName(u) }))} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={update.isPending} disabled={!moved && !reassigned}>Save change</Button>
      </div>
    </form>
  );
}
