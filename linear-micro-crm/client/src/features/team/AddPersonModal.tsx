// Release 1.3.1: Team → Add person for recruiters and leaders (administrators keep the full UserFormModal). Field people
// only: first and last name, email, phone (optional), position (Trainee / Field Representative), team (a leader's own,
// shown read-only; a recruiter picks one) and start date. The server gives the employee ID and refuses anything else
// (shared addPersonRefusal). After saving, the "Sign-in details" step shows the name, email and employee ID — the only
// time a recruiter or leader sees that ID — and the instructions to copy and send, with the sign-in address as this
// device opened it.
import { useId, useRef, useState } from 'react';
import { Copy, UserPlus } from 'lucide-react';
import { FIELD_ADD_POSITIONS, POSITION_LABELS, type AddPersonResult, type FieldAddPosition } from '@lm/shared';
import { useCreateUser, useTeams } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Button, Field, Input, Modal, Select, useToast } from '@/components/ui';
import { errorMessage } from '@/features/common/QueryStates';
import { copyText } from '@/lib/clipboard';
import { todayISO } from '@/lib/dates';
import { fullName } from '@/lib/format';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AddPersonModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <AddPersonDialog onClose={onClose} />;
}

function AddPersonDialog({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<AddPersonResult | null>(null);
  return result ? <SignInDetails person={result} onClose={onClose} /> : <AddPersonForm onClose={onClose} onSaved={setResult} />;
}

function AddPersonForm({ onClose, onSaved }: { onClose: () => void; onSaved: (r: AddPersonResult) => void }) {
  const uid = useId();
  const toast = useToast();
  const me = useCurrentUser();
  const teams = useTeams();
  const create = useCreateUser();
  const leader = me.role === 'leader';
  const [f, setF] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    position: 'trainee' as FieldAddPosition,
    teamId: leader && me.teamId ? String(me.teamId) : '',
    startDate: todayISO(),
  });
  const [submitted, setSubmitted] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const errors = {
    firstName: submitted && !f.firstName.trim() ? 'Enter their first name' : undefined,
    lastName: submitted && !f.lastName.trim() ? 'Enter their last name' : undefined,
    email: submitted && !EMAIL_RE.test(f.email.trim()) ? 'Enter a valid email' : undefined,
    teamId: submitted && !leader && !f.teamId ? 'Choose a team' : undefined,
    startDate: submitted && !/^\d{4}-\d{2}-\d{2}$/.test(f.startDate) ? 'Choose a start date' : undefined,
  };
  const teamName = leader ? (me.teamName ?? (teams.data ?? []).find((t) => t.id === me.teamId)?.name ?? '') : '';
  const teamColor = leader ? (teams.data ?? []).find((t) => t.id === me.teamId)?.color : undefined;

  async function submit() {
    setSubmitted(true);
    if (!f.firstName.trim() || !f.lastName.trim() || !EMAIL_RE.test(f.email.trim()) || (!leader && !f.teamId) || !/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) return;
    try {
      const saved = await create.mutateAsync({
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        email: f.email.trim().toLowerCase(),
        phone: f.phone.trim() || null,
        position: f.position,
        ...(leader ? {} : { teamId: Number(f.teamId) }),
        startDate: f.startDate,
        signInUrl: `${window.location.origin}/login`,
      });
      onSaved(saved);
    } catch (err) {
      toast.error('Could not add them', errorMessage(err));
    }
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title="Add person"
      description={leader
        ? `Add a trainee or field representative to ${teamName || 'your team'}. Linear Hub gives them an employee ID to sign in with.`
        : 'Add a trainee or field representative to a team. Linear Hub gives them an employee ID to sign in with.'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button type="submit" form={formId} loading={create.isPending} leftIcon={<UserPlus aria-hidden />}>Add person</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="grid gap-4 sm:grid-cols-2" data-testid="add-person-form">
        <Field label="First name" required htmlFor={`${uid}-first`} error={errors.firstName}>
          <Input id={`${uid}-first`} autoComplete="off" maxLength={60} value={f.firstName} onChange={(e) => set('firstName')(e.target.value)} invalid={!!errors.firstName} />
        </Field>
        <Field label="Last name" required htmlFor={`${uid}-last`} error={errors.lastName}>
          <Input id={`${uid}-last`} autoComplete="off" maxLength={60} value={f.lastName} onChange={(e) => set('lastName')(e.target.value)} invalid={!!errors.lastName} />
        </Field>
        <Field label="Email" required htmlFor={`${uid}-email`} error={errors.email} className="sm:col-span-2" hint="They sign in with this email and their employee ID.">
          <Input id={`${uid}-email`} type="email" inputMode="email" autoComplete="off" maxLength={200} value={f.email} onChange={(e) => set('email')(e.target.value)} invalid={!!errors.email} />
        </Field>
        <Field label="Phone" optional htmlFor={`${uid}-phone`}>
          <Input id={`${uid}-phone`} type="tel" inputMode="tel" autoComplete="off" maxLength={30} value={f.phone} onChange={(e) => set('phone')(e.target.value)} />
        </Field>
        <Field label="Position" htmlFor={`${uid}-pos`}>
          <Select id={`${uid}-pos`} value={f.position} onChange={(e) => set('position')(e.target.value)} options={FIELD_ADD_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }))} />
        </Field>
        {leader ? (
          <Field as="div" label="Team">
            <p className="flex h-10 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg" data-testid="add-person-team">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={teamColor ? { backgroundColor: teamColor } : undefined} aria-hidden />
              <span className="min-w-0 truncate">{teamName || 'Your team'}</span>
            </p>
          </Field>
        ) : (
          <Field label="Team" required htmlFor={`${uid}-team`} error={errors.teamId}>
            <Select
              id={`${uid}-team`}
              value={f.teamId}
              onChange={(e) => set('teamId')(e.target.value)}
              placeholder={teams.isLoading ? 'Loading…' : 'Choose a team'}
              options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))}
              invalid={!!errors.teamId}
            />
          </Field>
        )}
        <Field label="Start date" htmlFor={`${uid}-start`} error={errors.startDate}>
          <Input id={`${uid}-start`} type="date" value={f.startDate} onChange={(e) => set('startDate')(e.target.value)} invalid={!!errors.startDate} />
        </Field>
      </form>
    </Modal>
  );
}

/** "Sign-in details": shown once, straight after adding someone (the employee ID is hidden from non-admins afterwards). */
function SignInDetails({ person, onClose }: { person: AddPersonResult; onClose: () => void }) {
  const toast = useToast();
  const textRef = useRef<HTMLPreElement>(null);
  const name = fullName(person);
  const instructions = person.signInInstructions ?? '';

  async function copy() {
    if (await copyText(instructions)) {
      toast.success('Copied', `Paste it into a message to ${person.firstName.trim() || 'them'}.`);
      return;
    }
    const el = textRef.current;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    toast.error('Could not copy', 'The instructions are selected below — copy them from there.');
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Sign-in details"
      description={`${name} can sign in now. Send them these details: this is the only time their employee ID is shown here.`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Done</Button>
          <Button onClick={() => void copy()} leftIcon={<Copy aria-hidden />} disabled={!instructions}>Copy instructions</Button>
        </>
      }
    >
      <dl className="grid gap-3 rounded-lg border border-border bg-surface-2 p-3 text-sm sm:grid-cols-2" data-testid="sign-in-details">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Name</dt>
          <dd className="mt-0.5 truncate font-medium text-fg">{name}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Team</dt>
          <dd className="mt-0.5 truncate font-medium text-fg">{person.teamName ?? '—'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-muted">Email</dt>
          <dd className="mt-0.5 break-all font-medium text-fg">{person.email}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted">Employee ID</dt>
          <dd className="mt-0.5 font-mono text-2xl font-bold tracking-widest text-fg" data-testid="sign-in-employee-id">{person.employeeId}</dd>
        </div>
      </dl>
      {instructions && (
        <pre
          ref={textRef}
          className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-sans text-sm text-fg"
          data-testid="sign-in-instructions"
        >
          {instructions}
        </pre>
      )}
    </Modal>
  );
}
