// Admin-only create / edit user form.
import { useId, useState } from 'react';
import type { Position, Role, UserStatus, UserWithTeam } from '@lm/shared';
import { POSITIONS, POSITION_LABELS, ROLE_LABELS } from '@lm/shared';
import { Button, Field, Input, Modal, Select, useToast } from '@/components/ui';
import { useCreateUser, usePayPlans, useTeams, useUpdateUser } from '@/api/hooks';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { USER_STATUS_LABELS, optionsFrom } from '@/lib/labels';

export function UserFormModal({ open, onClose, user, onSaved }: { open: boolean; onClose: () => void; user?: UserWithTeam | null; onSaved?: (u: UserWithTeam) => void }) {
  return (
    <Modal open={open} onClose={onClose} title={user ? `Edit ${user.firstName} ${user.lastName}` : 'Add team member'} size="lg">
      <UserForm onClose={onClose} user={user} onSaved={onSaved} />
    </Modal>
  );
}

function UserForm({ onClose, user, onSaved }: { onClose: () => void; user?: UserWithTeam | null; onSaved?: (u: UserWithTeam) => void }) {
  const toast = useToast();
  const uid = useId();
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
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.firstName.trim()) e.firstName = 'Required';
    if (!f.lastName.trim()) e.lastName = 'Required';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Enter a valid email';
    if (!/^LM-\d{4}$/i.test(f.employeeId.trim())) e.employeeId = 'Format LM-0000';
    if (!f.payPlanId) e.payPlanId = 'Choose a pay plan';
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = {
      firstName: f.firstName.trim(),
      lastName: f.lastName.trim(),
      email: f.email.trim().toLowerCase(),
      employeeId: f.employeeId.trim().toUpperCase(),
      role: f.role,
      position: f.position,
      teamId: f.teamId ? Number(f.teamId) : null,
      payPlanId: Number(f.payPlanId),
      startDate: f.startDate,
      status: f.status,
      phone: f.phone.trim() || null,
      city: f.city.trim() || null,
      avatarColor: f.avatarColor,
    };
    try {
      const saved = user ? await update.mutateAsync({ id: user.id, ...body }) : await create.mutateAsync(body);
      toast.success(user ? 'Profile updated' : 'Team member added', `${saved.firstName} ${saved.lastName}`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First name" required htmlFor={`${uid}-fn`} error={errors.firstName}><Input id={`${uid}-fn`} value={f.firstName} onChange={(e) => set('firstName')(e.target.value)} invalid={!!errors.firstName} autoFocus /></Field>
        <Field label="Last name" required htmlFor={`${uid}-ln`} error={errors.lastName}><Input id={`${uid}-ln`} value={f.lastName} onChange={(e) => set('lastName')(e.target.value)} invalid={!!errors.lastName} /></Field>
        <Field label="Work email" required htmlFor={`${uid}-email`} error={errors.email}><Input id={`${uid}-email`} type="email" value={f.email} onChange={(e) => set('email')(e.target.value)} invalid={!!errors.email} /></Field>
        <Field label="Employee ID" required htmlFor={`${uid}-emp`} error={errors.employeeId} hint="Used with the email to sign in"><Input id={`${uid}-emp`} value={f.employeeId} onChange={(e) => set('employeeId')(e.target.value.toUpperCase())} placeholder="LM-0042" invalid={!!errors.employeeId} /></Field>
        <Field label="Role" htmlFor={`${uid}-role`}><Select id={`${uid}-role`} value={f.role} onChange={(e) => set('role')(e.target.value)} options={optionsFrom(ROLE_LABELS)} /></Field>
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
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending || update.isPending}>{user ? 'Save changes' : 'Add member'}</Button>
      </div>
    </form>
  );
}
