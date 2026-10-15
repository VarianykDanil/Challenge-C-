import { useId, useState } from 'react';
import type { Interview } from '@lm/shared';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { useCreateInterview, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common';
import { localInputToISO } from '@/lib/dates';
import { fullName } from '@/lib/format';
import { INTERVIEW_TYPE_LABELS, optionsFrom } from '@/lib/labels';

export function ScheduleInterviewModal({ open, onClose, candidateId, defaultType = 'first' }: { open: boolean; onClose: () => void; candidateId: number; defaultType?: Interview['type'] }) {
  return (
    <Modal open={open} onClose={onClose} title="Schedule interview" size="md">
      <ScheduleForm onClose={onClose} candidateId={candidateId} defaultType={defaultType} />
    </Modal>
  );
}

function ScheduleForm({ onClose, candidateId, defaultType }: { onClose: () => void; candidateId: number; defaultType: Interview['type'] }) {
  const me = useCurrentUser();
  const toast = useToast();
  const uid = useId();
  const create = useCreateInterview();
  const people = useUsers({});
  const [type, setType] = useState<Interview['type']>(defaultType);
  const [when, setWhen] = useState('');
  const [interviewerId, setInterviewerId] = useState(String(me.id));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const iso = localInputToISO(when);
    if (!iso) { setError('Pick a date and time'); return; }
    setError(null);
    try {
      await create.mutateAsync({ candidateId, type, scheduledAt: iso, interviewerId: interviewerId ? Number(interviewerId) : null, outcome: 'pending', notes: notes.trim() || null });
      toast.success('Interview scheduled', INTERVIEW_TYPE_LABELS[type]);
      onClose();
    } catch (e) {
      toast.error('Could not schedule interview', errorMessage(e));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <Field label="Type" htmlFor={`${uid}-type`}><Select id={`${uid}-type`} value={type} onChange={(e) => setType(e.target.value as Interview['type'])} options={optionsFrom(INTERVIEW_TYPE_LABELS)} /></Field>
      <Field label="Date and time" required htmlFor={`${uid}-when`} error={error ?? undefined}><Input id={`${uid}-when`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} invalid={!!error} /></Field>
      <Field label="Interviewer" htmlFor={`${uid}-who`}><Select id={`${uid}-who`} value={interviewerId} onChange={(e) => setInterviewerId(e.target.value)} placeholder="Unassigned" options={(people.data ?? []).filter((u) => u.role !== 'rep').map((u) => ({ value: String(u.id), label: fullName(u) }))} /></Field>
      <Field label="Notes" htmlFor={`${uid}-notes`}><Textarea id={`${uid}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where to meet, what to bring…" /></Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending}>Schedule</Button>
      </div>
    </form>
  );
}
