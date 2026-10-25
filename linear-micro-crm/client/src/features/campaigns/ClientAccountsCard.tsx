// Release 1.3 — OWNED BY P6 client-portal. The campaign page's "Client accounts" (admin): who at the client can sign in
// to the client portal, with their access code, whether they have created their PIN yet, and **Invite** (name, email →
// the access code and sign-in instructions, shown once to copy into an email), **Edit** (correct the name or email),
// **Reset PIN** and **Turn off** / **Turn on**. A PIN is required for client accounts: an invited client creates it at
// their first sign-in ("No PIN yet" until then, and again after Reset PIN). Release 1.4 (package S): so is two-step
// verification, set up at sign-in after the PIN ("No two-step yet" until then); **Reset two-step** after a lost phone.
import { useId, useState } from 'react';
import { Copy, KeyRound, Pencil, Power, ShieldOff, UserPlus, UsersRound } from 'lucide-react';
import type { ClientAccount, ClientInviteResult } from '@lm/shared';
import { useInviteClient, useResetClientPin, useResetClientTwoFactor, useUpdateClientAccount } from '@/api/clientPortal';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, useToast } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { errorMessage } from '@/features/common/QueryStates';
import { fullName } from '@/lib/format';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Confirm = { account: ClientAccount; action: 'reset' | 'reset2fa' | 'off' | 'on' };

export function ClientAccountsCard({ campaignId, campaignName, accounts, className }: { campaignId: number; campaignName: string; accounts: ClientAccount[]; className?: string }) {
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [editing, setEditing] = useState<ClientAccount | null>(null);
  return (
    <Card className={className} data-testid="client-accounts-card">
      <CardHeader
        icon={<UsersRound />}
        title="Client accounts"
        description="Who at the client can post from the client portal. They see nothing else of Linear Hub."
        actions={<Button size="md" variant="outline" onClick={() => setInviting(true)} leftIcon={<UserPlus aria-hidden />}>Invite</Button>}
      />
      {!accounts.length ? (
        <EmptyState icon={<UsersRound aria-hidden />} title="No client accounts yet" description={`Invite someone at ${campaignName} to post updates and commission changes.`} size="sm" className="border-0" />
      ) : (
        <ul className="divide-y divide-border">
          {accounts.map((a) => (
            <li key={a.id} className="py-3 first:pt-0 last:pb-0" data-testid="client-account-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-fg">{fullName(a)}</span>
                <Badge size="sm" tone={a.status === 'active' ? 'success' : 'neutral'} dot>{a.status === 'active' ? 'Active' : 'Turned off'}</Badge>
                <Badge size="sm" tone={a.hasPin ? 'info' : 'warning'}>{a.hasPin ? 'PIN set' : 'No PIN yet'}</Badge>
                {a.twoFactorEnabled !== undefined && (
                  <Badge size="sm" tone={a.twoFactorEnabled ? 'info' : 'warning'} data-testid="client-two-factor-badge">
                    {a.twoFactorEnabled ? 'Two-step on' : 'No two-step yet'}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted"><span className="break-all">{a.email}</span> · <span className="whitespace-nowrap font-mono">{a.accessCode}</span></p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="md" variant="ghost" onClick={() => setEditing(a)} leftIcon={<Pencil aria-hidden />}>Edit</Button>
                {a.hasPin && a.status === 'active' && (
                  <Button size="md" variant="ghost" onClick={() => setConfirm({ account: a, action: 'reset' })} leftIcon={<KeyRound aria-hidden />}>Reset PIN</Button>
                )}
                {a.twoFactorEnabled && a.status === 'active' && (
                  <Button size="md" variant="ghost" onClick={() => setConfirm({ account: a, action: 'reset2fa' })} leftIcon={<ShieldOff aria-hidden />}>Reset two-step</Button>
                )}
                <Button size="md" variant="ghost" onClick={() => setConfirm({ account: a, action: a.status === 'active' ? 'off' : 'on' })} leftIcon={<Power aria-hidden />}>
                  {a.status === 'active' ? 'Turn off' : 'Turn on'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {inviting && <InviteModal campaignId={campaignId} campaignName={campaignName} onClose={() => setInviting(false)} />}
      {confirm && <AccountConfirm confirm={confirm} onClose={() => setConfirm(null)} />}
      {editing && <EditAccountModal account={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function AccountConfirm({ confirm: { account, action }, onClose }: { confirm: Confirm; onClose: () => void }) {
  const toast = useToast();
  const reset = useResetClientPin();
  const reset2fa = useResetClientTwoFactor();
  const update = useUpdateClientAccount();
  const name = fullName(account);
  const text = {
    reset: { title: `Reset ${name}’s PIN?`, body: 'They are signed out everywhere and create a new PIN when they next sign in with their email and access code.', label: 'Reset PIN', done: 'PIN reset' },
    reset2fa: {
      title: `Reset ${name}’s two-step verification?`,
      body: 'For a lost or new phone. They are signed out everywhere and set it up again, with a new authenticator code, when they next sign in.',
      label: 'Reset two-step',
      done: 'Two-step verification reset',
    },
    off: { title: `Turn off ${name}’s account?`, body: 'They are signed out at once and cannot sign in until you turn it back on. Their posts stay.', label: 'Turn off', done: 'Account turned off' },
    on: { title: `Turn on ${name}’s account?`, body: 'They can sign in again with their email, access code, PIN and the code from their authenticator app.', label: 'Turn on', done: 'Account turned on' },
  }[action];
  const busy = reset.isPending || reset2fa.isPending || update.isPending;
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      tone={action === 'on' ? 'primary' : 'danger'}
      title={text.title}
      description={text.body}
      confirmLabel={text.label}
      loading={busy}
      onConfirm={() => {
        const done = { onSuccess: () => { toast.success(text.done, name); onClose(); }, onError: (e: unknown) => toast.error('Could not do that', errorMessage(e)) };
        if (action === 'reset') reset.mutate(account.id, done);
        else if (action === 'reset2fa') reset2fa.mutate(account.id, done);
        else update.mutate({ id: account.id, status: action === 'off' ? 'left' : 'active' }, done);
      }}
    />
  );
}

/** **Edit**: correct a client account's name or email (PATCH /client-accounts/:id; the access code never changes). */
function EditAccountModal({ account, onClose }: { account: ClientAccount; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const update = useUpdateClientAccount();
  const [f, setF] = useState({ firstName: account.firstName, lastName: account.lastName, email: account.email });
  const [submitted, setSubmitted] = useState(false);
  const errors = {
    firstName: submitted && !f.firstName.trim() ? 'Enter their first name' : undefined,
    lastName: submitted && !f.lastName.trim() ? 'Enter their last name' : undefined,
    email: submitted && !EMAIL_RE.test(f.email.trim()) ? 'Enter a valid email' : undefined,
  };

  async function submit() {
    setSubmitted(true);
    if (!f.firstName.trim() || !f.lastName.trim() || !EMAIL_RE.test(f.email.trim())) return;
    const patch = {
      ...(f.firstName.trim() !== account.firstName ? { firstName: f.firstName.trim() } : {}),
      ...(f.lastName.trim() !== account.lastName ? { lastName: f.lastName.trim() } : {}),
      ...(f.email.trim().toLowerCase() !== account.email.toLowerCase() ? { email: f.email.trim() } : {}),
    };
    if (!Object.keys(patch).length) return onClose();
    try {
      const saved = await update.mutateAsync({ id: account.id, ...patch });
      toast.success('Saved', patch.email ? `${fullName(saved)} now signs in with ${saved.email}.` : fullName(saved));
      onClose();
    } catch (err) {
      toast.error('Could not save that', errorMessage(err));
    }
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${fullName(account)}`}
      description={`Their access code stays ${account.accessCode}. A new email is the one they sign in with from now on.`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button type="submit" form={formId} loading={update.isPending}>Save</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required htmlFor={`${uid}-first`} error={errors.firstName}>
          <Input id={`${uid}-first`} maxLength={60} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} invalid={!!errors.firstName} />
        </Field>
        <Field label="Last name" required htmlFor={`${uid}-last`} error={errors.lastName}>
          <Input id={`${uid}-last`} maxLength={60} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} invalid={!!errors.lastName} />
        </Field>
        <Field label="Email" required htmlFor={`${uid}-email`} error={errors.email} className="sm:col-span-2">
          <Input id={`${uid}-email`} type="email" inputMode="email" maxLength={200} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} invalid={!!errors.email} />
        </Field>
      </form>
    </Modal>
  );
}

function InviteModal({ campaignId, campaignName, onClose }: { campaignId: number; campaignName: string; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const invite = useInviteClient(campaignId);
  const [f, setF] = useState({ firstName: '', lastName: '', email: '' });
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<ClientInviteResult | null>(null);
  const errors = {
    firstName: submitted && !f.firstName.trim() ? 'Enter their first name' : undefined,
    lastName: submitted && !f.lastName.trim() ? 'Enter their last name' : undefined,
    email: submitted && !EMAIL_RE.test(f.email.trim()) ? 'Enter a valid email' : undefined,
  };

  async function submit() {
    setSubmitted(true);
    if (!f.firstName.trim() || !f.lastName.trim() || !EMAIL_RE.test(f.email.trim())) return;
    try {
      const r = await invite.mutateAsync({
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        email: f.email.trim(),
        signInUrl: `${window.location.origin}/login`,
      });
      setResult(r);
    } catch (err) {
      toast.error('Could not invite them', errorMessage(err));
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied', 'Paste it into an email to them.');
    } catch {
      toast.error('Could not copy', 'Select the text and copy it yourself.');
    }
  }

  if (result) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`${fullName(result.account)} can sign in now`}
        description="Send them these instructions. This is the only time the sign-in instructions are shown here."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>Done</Button>
            <Button onClick={() => void copy(result.instructions)} leftIcon={<Copy aria-hidden />}>Copy instructions</Button>
          </>
        }
      >
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-center">
          <p className="text-xs text-muted">Access code</p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-fg" data-testid="invite-access-code">{result.accessCode}</p>
        </div>
        <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-sans text-sm text-fg" data-testid="invite-instructions">{result.instructions}</pre>
      </Modal>
    );
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title="Invite a client"
      description={`They get an access code for the ${campaignName} client portal, and create their own PIN and set up two-step verification when they first sign in.`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={invite.isPending}>Cancel</Button>
          <Button type="submit" form={formId} loading={invite.isPending} leftIcon={<UserPlus aria-hidden />}>Invite</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required htmlFor={`${uid}-first`} error={errors.firstName}>
          <Input id={`${uid}-first`} autoFocus maxLength={60} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} invalid={!!errors.firstName} />
        </Field>
        <Field label="Last name" required htmlFor={`${uid}-last`} error={errors.lastName}>
          <Input id={`${uid}-last`} maxLength={60} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} invalid={!!errors.lastName} />
        </Field>
        <Field label="Email" required htmlFor={`${uid}-email`} error={errors.email} className="sm:col-span-2" hint="They sign in with this email and their access code.">
          <Input id={`${uid}-email`} type="email" inputMode="email" maxLength={200} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} invalid={!!errors.email} />
        </Field>
      </form>
    </Modal>
  );
}
