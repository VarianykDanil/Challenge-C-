import { useId, useState } from 'react';
import type { CandidateSource, Position } from '@lm/shared';
import { POSITION_LABELS, SOURCE_LABELS, dateOfBirthProblem } from '@lm/shared';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useCreateCandidate, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { fullName } from '@/lib/format';
import { ENTRY_POSITIONS, optionsFrom } from '@/lib/labels';

export function AddCandidateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (id: number) => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Add candidate" description="They start at the Applied stage." size="lg">
      <AddCandidateForm onClose={onClose} onCreated={onCreated} />
    </Modal>
  );
}

function AddCandidateForm({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: number) => void }) {
  const me = useCurrentUser();
  const toast = useToast();
  const uid = useId();
  const create = useCreateCandidate();
  const owners = useUsers({});
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', city: 'Manchester', source: 'indeed' as CandidateSource, positionApplied: 'field_rep' as Position, ownerId: String(me.id), referredById: '', notes: '', dateOfBirth: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.firstName.trim()) e.firstName = 'Required';
    if (!f.lastName.trim()) e.lastName = 'Required';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Enter a valid email';
    // Release 1.3 (P7): optional; the same rule as the server.
    const dobProblem = f.dateOfBirth ? dateOfBirthProblem(f.dateOfBirth, todayISO()) : null;
    if (dobProblem) e.dateOfBirth = dobProblem;
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      const c = await create.mutateAsync({
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        email: f.email.trim().toLowerCase(),
        phone: f.phone.trim() || null,
        city: f.city.trim() || null,
        source: f.source,
        positionApplied: f.positionApplied,
        ownerId: f.ownerId ? Number(f.ownerId) : null,
        referredById: f.source === 'referral' && f.referredById ? Number(f.referredById) : null,
        notes: f.notes.trim() || null,
        ...(f.dateOfBirth ? { dateOfBirth: f.dateOfBirth } : {}),
      });
      toast.success('Candidate added', fullName(c));
      onCreated?.(c.id);
      onClose();
    } catch (err) {
      // A duplicate (same email already in the pipeline) is a 409: show it on the field so the recruiter can fix or look them up.
      if (err instanceof ApiError && err.status === 409) {
        setErrors({ email: err.message || 'A candidate with this email already exists' });
        return;
      }
      toast.error('Could not add candidate', errorMessage(err));
    }
  };

  const people = owners.data ?? [];
  const ownerOptions = people.filter((u) => u.role !== 'rep').map((u) => ({ value: String(u.id), label: fullName(u) }));

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First name" required htmlFor={`${uid}-fn`} error={errors.firstName}><Input id={`${uid}-fn`} value={f.firstName} onChange={(e) => set('firstName')(e.target.value)} invalid={!!errors.firstName} autoFocus /></Field>
        <Field label="Last name" required htmlFor={`${uid}-ln`} error={errors.lastName}><Input id={`${uid}-ln`} value={f.lastName} onChange={(e) => set('lastName')(e.target.value)} invalid={!!errors.lastName} /></Field>
        <Field label="Email" required htmlFor={`${uid}-email`} error={errors.email}><Input id={`${uid}-email`} type="email" value={f.email} onChange={(e) => set('email')(e.target.value)} invalid={!!errors.email} /></Field>
        <Field label="Phone" htmlFor={`${uid}-phone`}><Input id={`${uid}-phone`} type="tel" value={f.phone} onChange={(e) => set('phone')(e.target.value)} /></Field>
        <Field label="City" htmlFor={`${uid}-city`}><Input id={`${uid}-city`} value={f.city} onChange={(e) => set('city')(e.target.value)} /></Field>
        <Field label="Date of birth" optional htmlFor={`${uid}-dob`} error={errors.dateOfBirth} hint="Only the recruitment team sees it. Under 18s are flagged on the profile.">
          <Input id={`${uid}-dob`} type="date" value={f.dateOfBirth} max={todayISO()} onChange={(e) => set('dateOfBirth')(e.target.value)} invalid={!!errors.dateOfBirth} />
        </Field>
        <Field label="Position applied for" htmlFor={`${uid}-pos`}><Select id={`${uid}-pos`} value={f.positionApplied} onChange={(e) => set('positionApplied')(e.target.value)} options={optionsFrom(POSITION_LABELS, ENTRY_POSITIONS)} /></Field>
        <Field label="Source" htmlFor={`${uid}-source`}><Select id={`${uid}-source`} value={f.source} onChange={(e) => set('source')(e.target.value)} options={optionsFrom(SOURCE_LABELS)} /></Field>
        {f.source === 'referral' && (
          <Field label="Referred by" htmlFor={`${uid}-ref`}><Select id={`${uid}-ref`} value={f.referredById} onChange={(e) => set('referredById')(e.target.value)} placeholder="Choose a team member" options={people.map((u) => ({ value: String(u.id), label: fullName(u) }))} /></Field>
        )}
        <Field label="Owner" htmlFor={`${uid}-owner`} hint="Who follows up"><Select id={`${uid}-owner`} value={f.ownerId} onChange={(e) => set('ownerId')(e.target.value)} placeholder="Unassigned" options={ownerOptions} /></Field>
        <Field label="Notes" htmlFor={`${uid}-notes`} className="md:col-span-2"><Textarea id={`${uid}-notes`} rows={2} value={f.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending}>Add candidate</Button>
      </div>
    </form>
  );
}
