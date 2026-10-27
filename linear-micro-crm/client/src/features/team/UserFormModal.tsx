// Admin-only create / edit user form. Release 1.3.1: recruiters and leaders add people with AddPersonModal instead.
// Making an administrator (new or promoted) and changing someone's sign-in email need the admin's fresh two-step code;
// a new person's Sign-in details (with their one-time setup code) show once after saving.
import { useId, useState } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import type { AddPersonResult, Position, Role, SetupCodeIssued, UserStatus, UserWithTeam } from '@lm/shared';
// Release 1.3: the staff roles only — client portal accounts are invited from the campaign page (P6), never here.
import { POSITIONS, POSITION_LABELS, ROLE_LABELS, STAFF_ROLES } from '@lm/shared';
import { Badge, Button, Field, Input, Modal, Select, useToast } from '@/components/ui';
import { useCreateUser, usePayPlans, useResetUserTwoFactor, useTeams, useUpdateUser } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorBoundary, errorMessage } from '@/features/common';
import { apiMessage } from '@/features/common/QueryStates';
import { SetupCodeDialog } from '@/features/access/SetupCodeDialog';
import { SetupCodeSection } from '@/features/access/SetupCodeSection';
import { StepUpCodeField, StepUpDialog } from '@/features/access/StepUpDialog';
import { SignInDetails } from '@/features/team/AddPersonModal';
import { PinResetSection } from '@/features/settings/PinResetSection';
import { COPY } from '@/content/copy';
import { todayISO } from '@/lib/dates';
import { fullName } from '@/lib/format';
import { USER_STATUS_LABELS, optionsFrom } from '@/lib/labels';

export function UserFormModal({ open, onClose, user, onSaved }: { open: boolean; onClose: () => void; user?: UserWithTeam | null; onSaved?: (u: UserWithTeam) => void }) {
  // a new person: their Sign-in details (employee ID and one-time setup code), once, instead of the form
  const [created, setCreated] = useState<AddPersonResult | null>(null);
  if (created) return <SignInDetails person={created} onClose={() => { setCreated(null); onClose(); onSaved?.(created); }} />;
  return (
    <Modal open={open} onClose={onClose} title={user ? `Edit ${fullName(user)}` : 'Add person'} size="lg">
      <UserForm onClose={onClose} user={user} onSaved={onSaved} onCreated={setCreated} />
    </Modal>
  );
}

function UserForm({ onClose, user, onSaved, onCreated }: { onClose: () => void; user?: UserWithTeam | null; onSaved?: (u: UserWithTeam) => void; onCreated: (r: AddPersonResult) => void }) {
  const toast = useToast();
  const uid = useId();
  const me = useCurrentUser();
  const teams = useTeams();
  const plans = usePayPlans();
  const create = useCreateUser();
  const update = useUpdateUser();
  const [f, setF] = useState({
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    employeeId: user?.employeeId ?? '',
    role: user?.role ?? ('rep' as Role),
    position: user?.position ?? ('trainee' as Position),
    teamId: user?.teamId ? String(user.teamId) : '',
    payPlanId: user?.payPlanId ? String(user.payPlanId) : '',
    startDate: user?.startDate ?? todayISO(),
    status: user?.status ?? ('active' as UserStatus),
    phone: user?.phone ?? '',
    city: user?.city ?? 'Manchester',
    avatarColor: user?.avatarColor ?? '#4F46E5',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stepUp, setStepUp] = useState('');
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  // the admin's fresh two-step code: a new administrator, a promotion to administrator, or a new sign-in email
  const makingAdmin = f.role === 'admin' && user?.role !== 'admin';
  const newEmail = !!user && f.email.trim().toLowerCase() !== user.email.toLowerCase();
  const needsStepUp = makingAdmin || newEmail;
  const stepUpWhy = makingAdmin ? 'Making someone an administrator needs your code.' : 'Changing someone’s sign-in email needs your code.';

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.firstName.trim()) e.firstName = 'Required';
    // Release 1.3.1: someone added without a surname (the Sapiens demo accounts) can be saved until one is added; a
    // surname, once given, cannot be cleared. A new person's employee ID may be left blank: the next free one is given.
    if (!f.lastName.trim() && (!user || user.lastName.trim())) e.lastName = 'Required';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Enter a valid email';
    if ((user || f.employeeId.trim()) && !/^LM-\d{4}$/i.test(f.employeeId.trim())) e.employeeId = 'Format LM-0000';
    if (!f.payPlanId) e.payPlanId = 'Choose a pay plan';
    if (needsStepUp && !/^\d{6}$/.test(stepUp)) e.stepUp = 'Type the 6-digit code from your authenticator app';
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = {
      firstName: f.firstName.trim(),
      lastName: f.lastName.trim(),
      email: f.email.trim().toLowerCase(),
      ...(user || f.employeeId.trim() ? { employeeId: f.employeeId.trim().toUpperCase() } : {}),
      role: f.role,
      position: f.position,
      teamId: f.teamId ? Number(f.teamId) : null,
      payPlanId: Number(f.payPlanId),
      startDate: f.startDate,
      status: f.status,
      phone: f.phone.trim() || null,
      city: f.city.trim() || null,
      avatarColor: f.avatarColor,
      ...(needsStepUp ? { code: stepUp } : {}),
    };
    try {
      if (user) {
        const saved = await update.mutateAsync({ id: user.id, ...body, employeeId: f.employeeId.trim().toUpperCase() });
        toast.success('Profile updated', fullName(saved));
        onSaved?.(saved);
        onClose();
      } else {
        const created = await create.mutateAsync({ ...body, signInUrl: `${window.location.origin}/login` });
        onCreated(created);
      }
    } catch (err) {
      setStepUp('');
      toast.error('Could not save', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First name" required htmlFor={`${uid}-fn`} error={errors.firstName}><Input id={`${uid}-fn`} value={f.firstName} onChange={(e) => set('firstName')(e.target.value)} invalid={!!errors.firstName} autoFocus /></Field>
        <Field label="Last name" required={!user || !!user.lastName.trim()} htmlFor={`${uid}-ln`} error={errors.lastName} hint={user && !user.lastName.trim() ? 'Not added yet' : undefined}><Input id={`${uid}-ln`} value={f.lastName} onChange={(e) => set('lastName')(e.target.value)} invalid={!!errors.lastName} /></Field>
        <Field label="Work email" required htmlFor={`${uid}-email`} error={errors.email}><Input id={`${uid}-email`} type="email" value={f.email} onChange={(e) => set('email')(e.target.value)} invalid={!!errors.email} /></Field>
        <Field label="Employee ID" required={!!user} htmlFor={`${uid}-emp`} error={errors.employeeId} hint={user ? 'Used with the email to sign in' : 'Used with the email to sign in. Leave blank for the next free ID.'}><Input id={`${uid}-emp`} value={f.employeeId} onChange={(e) => set('employeeId')(e.target.value.toUpperCase())} placeholder="LM-0042" invalid={!!errors.employeeId} /></Field>
        <Field label="Role" htmlFor={`${uid}-role`}><Select id={`${uid}-role`} value={f.role} onChange={(e) => set('role')(e.target.value)} options={optionsFrom(ROLE_LABELS, STAFF_ROLES)} /></Field>
        <Field label="Position" htmlFor={`${uid}-pos`}><Select id={`${uid}-pos`} value={f.position} onChange={(e) => set('position')(e.target.value)} options={optionsFrom(POSITION_LABELS, POSITIONS)} /></Field>
        <Field label="Team" htmlFor={`${uid}-team`}><Select id={`${uid}-team`} value={f.teamId} onChange={(e) => set('teamId')(e.target.value)} placeholder="No team" options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} /></Field>
        <Field label="Pay plan" required htmlFor={`${uid}-plan`} error={errors.payPlanId}><Select id={`${uid}-plan`} value={f.payPlanId} onChange={(e) => set('payPlanId')(e.target.value)} placeholder={plans.isLoading ? 'Loading…' : 'Choose a plan'} options={(plans.data ?? []).map((p) => ({ value: String(p.id), label: `${p.name} · ${POSITION_LABELS[p.position]}` }))} invalid={!!errors.payPlanId} /></Field>
        <Field label="Start date" htmlFor={`${uid}-start`}><Input id={`${uid}-start`} type="date" value={f.startDate} onChange={(e) => set('startDate')(e.target.value)} /></Field>
        <Field label="Status" htmlFor={`${uid}-status`}><Select id={`${uid}-status`} value={f.status} onChange={(e) => set('status')(e.target.value)} options={optionsFrom(USER_STATUS_LABELS)} /></Field>
        <Field label="Phone" htmlFor={`${uid}-phone`}><Input id={`${uid}-phone`} type="tel" value={f.phone} onChange={(e) => set('phone')(e.target.value)} /></Field>
        <Field label="City" htmlFor={`${uid}-city`}><Input id={`${uid}-city`} value={f.city} onChange={(e) => set('city')(e.target.value)} /></Field>
        <Field as="div" label="Avatar colour">
          <span className="flex items-center gap-2">
            <input id={`${uid}-color`} aria-label="Avatar colour picker" type="color" value={f.avatarColor} onChange={(e) => set('avatarColor')(e.target.value)} className="h-10 w-14 cursor-pointer rounded-lg border border-border bg-surface p-1" />
            <Input aria-label="Avatar colour hex" value={f.avatarColor} onChange={(e) => set('avatarColor')(e.target.value)} className="font-mono uppercase" />
          </span>
        </Field>
      </div>

      {needsStepUp && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft/40 p-4">
          <StepUpCodeField id={`${uid}-stepup`} value={stepUp} onChange={setStepUp} why={stepUpWhy} error={errors.stepUp} />
        </div>
      )}

      {/* Lost-device recovery for someone else; your own second factor is managed from Settings → Security. */}
      {user && user.id !== me.id && <SetupCodeSection user={user} />}
      {user && user.id !== me.id && <TwoFactorResetSection user={user} />}
      {/* Release 1.2 slot (U1): reset someone's sign-in PIN (admin); nothing until the package lands. */}
      {user && user.id !== me.id && (
        <ErrorBoundary name="pin-reset" fallback={null}>
          <PinResetSection user={user} />
        </ErrorBoundary>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending || update.isPending}>{user ? 'Save changes' : 'Add person'}</Button>
      </div>
    </form>
  );
}

/**
 * Edit mode only: "Reset two-step verification", with the admin's fresh two-step code; the one-time setup code their next
 * sign-in needs is shown once afterwards. The state badge shows only when the API sends `twoFactorEnabled`.
 */
function TwoFactorResetSection({ user }: { user: UserWithTeam }) {
  const uid = useId();
  const reset = useResetUserTwoFactor(user.id);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<SetupCodeIssued | null>(null);
  const t = COPY.security.admin;
  const known = user.twoFactorEnabled !== undefined;

  function onConfirm(code: string) {
    setError(null);
    reset.mutate(
      { code },
      {
        onSuccess: (r) => {
          setConfirm(false);
          setIssued(r);
        },
        onError: (err) => setError(apiMessage(err, 'Could not reset two-step verification.')),
      },
    );
  }

  return (
    <section aria-labelledby={`${uid}-2fa`} data-testid="admin-two-factor" className="rounded-xl border border-border bg-surface-2/50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted" aria-hidden />
            <h4 id={`${uid}-2fa`} className="font-sans text-sm font-semibold tracking-normal text-fg">{t.title}</h4>
            {known && (
              <Badge tone={user.twoFactorEnabled ? 'success' : 'neutral'} dot={user.twoFactorEnabled} size="sm">
                {user.twoFactorEnabled ? COPY.security.twoFactor.on : t.notSetUp}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t.body}</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => { setError(null); setConfirm(true); }} disabled={user.twoFactorEnabled === false} leftIcon={<ShieldOff aria-hidden />}>
          {t.reset}
        </Button>
      </div>
      <StepUpDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={onConfirm}
        title={t.confirmTitle}
        description={`${fullName(user)} ${t.confirmBody}`}
        confirmLabel={t.reset}
        busy={reset.isPending}
        error={error}
      />
      {issued && (
        <SetupCodeDialog
          name={fullName(user)}
          firstName={user.firstName}
          email={user.email}
          idLabel="Employee ID"
          idValue={user.employeeId}
          setupCode={issued.setupCode}
          expiresAt={issued.expiresAt}
          withheld={issued.withheld}
          intro={`${t.toast}: ${fullName(user)} is signed out everywhere.`}
          next="set up two-step verification again"
          onClose={() => setIssued(null)}
        />
      )}
    </section>
  );
}
