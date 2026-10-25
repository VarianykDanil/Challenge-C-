// Release 1.4 — F payments-foundation: Settings → Payments (admin). The four ways to pay, each with its logo, what it
// can and cannot do as a plain checklist, its fees, what Matt needs to set it up and its limits; and its connections:
// Connect (a form driven by the provider's fields; keys are stored encrypted and never shown again), Test, Switch to
// live (type PAY FOR REAL), Switch back to test mode, Disconnect. Loaded lazily from pages/Settings.tsx
// (LazyPaymentsSettingsSection), so neither the Settings chunk nor the main one carries it or the logos.
// Package A: the Connect form starts with the provider's steps (what happens outside Linear Hub, in order); an API
// connection is tested as soon as it is saved (Revolut's code only works for 2 minutes); Switch to live shows what
// live needs for that provider (its own keys).
import { useId, useState, type FormEvent } from 'react';
import { Check, Plug, PlugZap, RefreshCw, TriangleAlert, Unplug, X } from 'lucide-react';
import {
  PAYMENT_LIVE_CONFIRMATION, PAYMENT_MODE_LABELS, abilityChecklist, formatPence, isLiveConfirmation,
  type PaymentConfigField, type PaymentConnection, type PaymentProviderView,
} from '@lm/shared';
import { ApiError } from '@/api/client';
import { useCreateConnection, useDisconnectConnection, usePaymentConnections, usePaymentProviders, useTestConnection, useUpdateConnection } from '@/api/payments';
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Select, Skeleton, Textarea, useToast } from '@/components/ui';
import { ConfirmDialog, ErrorState, errorMessage } from '@/features/common';
import { formatDateTime } from '@/lib/format';
import { EXAMPLE_BANKS, ProviderLogo } from './ProviderLogo';

const STATUS: Record<PaymentConnection['status'], { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  connected: { label: 'Connected', tone: 'success' },
  not_connected: { label: 'Not tested yet', tone: 'neutral' },
  error: { label: 'Needs a look', tone: 'danger' },
};

export default function PaymentsSettingsSection({ className }: { className?: string }) {
  const providers = usePaymentProviders();
  const connections = usePaymentConnections();
  const [connecting, setConnecting] = useState<{ provider: PaymentProviderView; connection?: PaymentConnection } | null>(null);
  return (
    <Card id="payments" className={`scroll-mt-20 ${className ?? ''}`} data-testid="payments-settings">
      <CardHeader
        title="Payments"
        icon={<PlugZap aria-hidden />}
        description="Pay people from Linear Hub. A connection starts in test mode where the provider has one, and every payment needs a code from your authenticator app."
      />
      {providers.isLoading || connections.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 rounded-xl" />)}</div>
      ) : providers.isError || connections.isError ? (
        <ErrorState error={providers.error ?? connections.error} onRetry={() => { void providers.refetch(); void connections.refetch(); }} className="p-4" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {(providers.data ?? []).map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                connections={(connections.data ?? []).filter((c) => c.provider === p.id && !c.disconnectedAt)}
                onConnect={(connection) => setConnecting({ provider: p, connection })}
              />
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">Logos belong to their owners and only identify the service.</p>
        </>
      )}
      {connecting && <ConnectModal provider={connecting.provider} connection={connecting.connection} onClose={() => setConnecting(null)} />}
    </Card>
  );
}

function AbilityList({ p }: { p: PaymentProviderView }) {
  return (
    <ul className="grid gap-1.5 text-sm" aria-label={`What ${p.name} can do`}>
      {abilityChecklist(p.abilities).map((a) => (
        <li key={a.key} className="flex items-start gap-2">
          {a.ok
            ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Yes" />
            : <X className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="No" />}
          <span className={a.ok ? 'text-fg' : 'text-muted'}>{a.label}</span>
        </li>
      ))}
    </ul>
  );
}

function ProviderCard({ provider: p, connections, onConnect }: { provider: PaymentProviderView; connections: PaymentConnection[]; onConnect: (c?: PaymentConnection) => void }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border p-4" aria-labelledby={`provider-${p.id}`} data-provider={p.id}>
      <div className="flex items-start gap-3">
        <ProviderLogo iconKey={p.iconKey} size="lg" />
        <div className="min-w-0">
          <h4 id={`provider-${p.id}`} className="font-sans text-base font-semibold tracking-normal text-fg">{p.name}</h4>
          <p className="mt-0.5 text-sm text-muted">{p.summary}</p>
        </div>
      </div>
      {p.iconKey === 'bank' && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {EXAMPLE_BANKS.map((b) => <ProviderLogo key={b} iconKey={b} size="xs" />)}
          <span>and any other UK business bank that takes a payment file</span>
        </div>
      )}
      <AbilityList p={p} />
      <dl className="grid gap-2 text-sm">
        <div><dt className="text-xs font-medium text-muted">Fees</dt><dd className="text-fg">{p.abilities.fees}</dd></div>
        <div>
          <dt className="text-xs font-medium text-muted">What you need to set it up</dt>
          <dd><ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-fg">{p.abilities.setup.map((s) => <li key={s}>{s}</li>)}</ul></dd>
        </div>
        <div><dt className="text-xs font-medium text-muted">Good to know</dt><dd className="text-muted">{p.abilities.limits}</dd></div>
      </dl>
      {!p.available && (
        <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted" data-not-available="">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Paying through it is not switched on in this version of Linear Hub yet. You can save the connection details now.
        </p>
      )}
      <div className="mt-auto space-y-3">
        {connections.map((c) => <ConnectionRow key={c.id} provider={p} connection={c} onEdit={() => onConnect(c)} />)}
        <Button variant={connections.length ? 'outline' : 'primary'} className="h-10 w-full sm:w-auto" leftIcon={<Plug aria-hidden />} onClick={() => onConnect()}>
          {connections.length ? 'Add another connection' : 'Connect'}
        </Button>
      </div>
    </section>
  );
}

function ConnectionRow({ provider: p, connection: c, onEdit }: { provider: PaymentProviderView; connection: PaymentConnection; onEdit: () => void }) {
  const test = useTestConnection();
  const update = useUpdateConnection();
  const disconnect = useDisconnectConnection();
  const toast = useToast();
  const [live, setLive] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const status = STATUS[c.status];
  const api = p.kind === 'api';
  const runTest = () => test.mutate(c.id, {
    onSuccess: (r) => (r.ok ? toast.success('The connection works', r.message) : toast.error('The test did not work', r.message)),
    onError: (e) => toast.error('Could not test it', errorMessage(e)),
  });
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3" data-connection={c.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-fg">{c.name}</span>
        {api && <Badge tone={c.mode === 'live' ? 'danger' : 'info'} size="sm">{c.mode === 'live' ? 'Live: real money' : PAYMENT_MODE_LABELS.test}</Badge>}
        <Badge tone={status.tone} size="sm" dot={c.status === 'connected'}>{status.label}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted">
        {c.lastCheckedAt ? `Last tested ${formatDateTime(c.lastCheckedAt)}` : api ? 'Test it before you pay anyone through it.' : 'Ready to make bank files.'}
        {c.balancePence != null ? ` · Balance ${formatPence(c.balancePence)}` : ''}
      </p>
      {api && c.mode === 'live' && c.status !== 'connected' && p.liveNote && <p className="mt-1 text-xs text-muted" data-live-note="">{p.liveNote}</p>}
      {c.lastError && <p className="mt-1 text-xs text-danger">{c.lastError}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {api && <Button size="sm" variant="outline" className="h-10 sm:h-8" loading={test.isPending} leftIcon={<RefreshCw aria-hidden />} onClick={runTest}>Test</Button>}
        {api && c.mode === 'test' && <Button size="sm" variant="outline" className="h-10 sm:h-8" disabled={c.status !== 'connected'} title={c.status !== 'connected' ? 'Test it in test mode first' : undefined} onClick={() => setLive(true)}>Switch to live</Button>}
        {api && c.mode === 'live' && (
          <Button size="sm" variant="ghost" className="h-10 sm:h-8" loading={update.isPending} onClick={() => update.mutate({ id: c.id, patch: { mode: 'test' } }, { onError: (e) => toast.error('Could not switch', errorMessage(e)) })}>
            Switch to test mode
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-10 sm:h-8" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" className="h-10 text-danger sm:h-8" leftIcon={<Unplug aria-hidden />} onClick={() => setConfirmOff(true)}>Disconnect</Button>
      </div>
      <LiveModal open={live} connection={c} liveNote={p.liveNote} onClose={() => setLive(false)} />
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={`Disconnect ${c.name}?`}
        description="Its keys are deleted from Linear Hub and drafts through it are cancelled. Payments already made through it stay in the history."
        confirmLabel="Disconnect"
        tone="danger"
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate(c.id, {
          onSuccess: () => { toast.success('Disconnected', `${c.name} can no longer pay anyone.`); setConfirmOff(false); },
          onError: (e) => toast.error('Could not disconnect', errorMessage(e)),
        })}
      />
    </div>
  );
}

function LiveModal({ open, connection: c, liveNote, onClose }: { open: boolean; connection: PaymentConnection; liveNote?: string; onClose: () => void }) {
  const uid = useId();
  const [typed, setTyped] = useState('');
  const update = useUpdateConnection();
  const toast = useToast();
  const ready = isLiveConfirmation(typed);
  return (
    <Modal
      open={open}
      onClose={onClose}
      tone="danger"
      icon={<TriangleAlert aria-hidden />}
      title={`Switch ${c.name} to live?`}
      description="From now on, approving a payment through it moves real money from your account to the people in it."
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!ready}
            loading={update.isPending}
            onClick={() => update.mutate({ id: c.id, patch: { mode: 'live', confirm: typed } }, {
              onSuccess: () => { toast.success('Switched to live', 'Test it once more: the live service gets its own test.'); setTyped(''); onClose(); },
              onError: (e) => toast.error('Could not switch to live', errorMessage(e)),
            })}
          >
            Switch to live
          </Button>
        </>
      )}
    >
      {liveNote && <p className="mb-3 text-sm text-muted">{liveNote}</p>}
      <Field label={`Type ${PAYMENT_LIVE_CONFIRMATION} to switch it on`} htmlFor={`${uid}-confirm`}>
        <Input id={`${uid}-confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder={PAYMENT_LIVE_CONFIRMATION} />
      </Field>
    </Modal>
  );
}

function ConnectModal({ provider: p, connection: c, onClose }: { provider: PaymentProviderView; connection?: PaymentConnection; onClose: () => void }) {
  const uid = useId();
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const test = useTestConnection();
  const toast = useToast();
  const [name, setName] = useState(c?.name ?? p.name);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of p.configFields) out[f.name] = f.secret ? '' : (c?.settings[f.name] ?? (f.type === 'select' ? f.options?.[0]?.value ?? '' : ''));
    return out;
  });
  const busy = create.isPending || update.isPending || test.isPending;
  const testOnSave = p.kind === 'api' && p.available;
  const error = create.error ?? update.error;
  const errs: Record<string, string> = {};
  if (error instanceof ApiError && Array.isArray(error.details)) {
    for (const d of error.details as { path?: unknown; message?: unknown }[]) if (typeof d?.path === 'string' && typeof d.message === 'string') errs[d.path] = d.message;
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const settings: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const f of p.configFields) (f.secret ? secrets : settings)[f.name] = values[f.name] ?? '';
    const done = (saved: PaymentConnection) => {
      if (!testOnSave) {
        toast.success(c ? 'Connection saved' : 'Connected', p.kind === 'api' ? 'Test it next: it starts in test mode.' : 'You can pay people through it now.');
        onClose();
        return;
      }
      // tested straight away: a pasted code (Revolut) only works for a short while
      test.mutate(saved.id, {
        onSuccess: (r) => (r.ok ? toast.success('Saved, and the connection works', r.message) : toast.error('Saved, but the test did not work', r.message)),
        onError: (e) => toast.error('Saved, but it could not be tested', errorMessage(e)),
        onSettled: onClose,
      });
    };
    const fail = (err: unknown) => { if (!(err instanceof ApiError && Array.isArray(err.details) && err.details.length)) toast.error('Could not save the connection', errorMessage(err)); };
    if (c) update.mutate({ id: c.id, patch: { name, settings, secrets } }, { onSuccess: done, onError: fail });
    else create.mutate({ provider: p.id, name, settings, secrets }, { onSuccess: done, onError: fail });
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<ProviderLogo iconKey={p.iconKey} size="sm" />}
      title={c ? `Edit ${c.name}` : `Connect ${p.name}`}
      description={p.kind === 'api' ? 'It starts in test mode: nothing real is paid until you test it and switch it to live.' : 'Linear Hub makes the file; you upload and approve it in your online banking.'}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`${uid}-form`} loading={busy}>{testOnSave ? 'Save and test' : c ? 'Save changes' : 'Save connection'}</Button>
        </>
      )}
    >
      <form id={`${uid}-form`} onSubmit={submit} className="space-y-4" noValidate>
        {!!p.connectSteps?.length && (
          <section className="rounded-lg border border-border bg-surface-2/40 p-3" aria-labelledby={`${uid}-steps`} data-connect-steps="">
            <h5 id={`${uid}-steps`} className="font-sans text-sm font-semibold tracking-normal text-fg">How to connect</h5>
            <p className="mt-0.5 text-xs text-muted">Some of these steps happen outside Linear Hub: in the provider’s own app or console, or on a computer.</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-fg">{p.connectSteps.map((step) => <li key={step}>{step}</li>)}</ol>
          </section>
        )}
        <Field label="Name" htmlFor={`${uid}-name`} hint="What you call it, e.g. “Revolut (office account)”" error={errs.name}>
          <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        {p.configFields.map((f) => (
          <ConfigInput
            key={f.name}
            id={`${uid}-${f.name}`}
            field={f}
            value={values[f.name] ?? ''}
            saved={!!c?.secretsSet.includes(f.name)}
            error={errs[f.name]}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
          />
        ))}
        {error && !Object.keys(errs).length && <p role="alert" className="text-sm text-danger">{errorMessage(error)}</p>}
      </form>
    </Modal>
  );
}

function ConfigInput({ id, field: f, value, saved, error, onChange }: { id: string; field: PaymentConfigField; value: string; saved: boolean; error?: string; onChange: (v: string) => void }) {
  const hint = [f.help, f.secret && saved ? 'Saved. Leave it empty to keep the one stored.' : null].filter(Boolean).join(' ');
  return (
    <Field label={f.label} htmlFor={id} hint={hint || undefined} error={error} required={f.required && !(f.secret && saved)} optional={!f.required}>
      {f.type === 'select' ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))} invalid={!!error} />
      ) : f.type === 'textarea' ? (
        <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={4} placeholder={f.secret && saved ? 'Saved (hidden)' : f.placeholder} spellCheck={false} autoComplete="off" className="font-mono text-xs" invalid={!!error} />
      ) : (
        <Input id={id} type={f.secret ? 'password' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.secret && saved ? 'Saved (hidden)' : f.placeholder} autoComplete={f.secret ? 'new-password' : 'off'} spellCheck={false} invalid={!!error} />
      )}
    </Field>
  );
}
