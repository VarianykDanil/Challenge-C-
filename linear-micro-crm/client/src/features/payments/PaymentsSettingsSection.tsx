// Release 1.4 — F payments-foundation: Settings → Payments (admin). The four ways to pay, each with its logo, what it
// can and cannot do as a plain checklist, its fees, what Matt needs to set it up and its limits; and its connections:
// Connect (a form driven by the provider's fields; keys are stored encrypted and never shown again), Test, Switch to
// live (type PAY FOR REAL), Switch back to test mode, Disconnect. Loaded lazily from pages/Settings.tsx
// (LazyPaymentsSettingsSection), so neither the Settings chunk nor the main one carries it or the logos.
// Package A: the Connect form starts with the provider's steps (what happens outside Linear Hub, in order); an API
// connection is tested as soon as it is saved (Revolut's code only works for 2 minutes); Switch to live shows what
// live needs for that provider (its own keys).
// Every connection starts in test mode, a bank file too (its files say TEST and pay nobody; CLM-3). A bank file has a
// "Make a 1p test file" to check the bank takes the layout before the first real run (MON-6); an API connection shows
// its first run: test, a sandbox payment, live (it can go live only after the sandbox answered one, MON-5), a small
// first live run. At the top: "Two people approve each payment" (MONEY-MISSED-2), changed with a fresh code.
import { useId, useState, type FormEvent } from 'react';
import { Check, Circle, FileDown, Plug, PlugZap, RefreshCw, ShieldCheck, TriangleAlert, Unplug, X } from 'lucide-react';
import {
  PAYMENT_LIVE_CONFIRMATION, PAYMENT_MODE_LABELS, abilityChecklist, bankFileFormat, formatPence, isLiveConfirmation, validateBankDetails,
  type PaymentConfigField, type PaymentConnection, type PaymentProviderView,
} from '@lm/shared';
import { ApiError } from '@/api/client';
import {
  useCreateConnection, useDisconnectConnection, useMakeTestFile, usePaymentConnections, usePaymentProviders, usePaymentsSettings, useSavePaymentsSettings,
  useTestConnection, useTestFileResult, useUpdateConnection,
} from '@/api/payments';
import { downloadTextFile } from '@/lib/files';
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Select, Skeleton, Textarea, useToast } from '@/components/ui';
import { ConfirmDialog, ErrorState, errorMessage } from '@/features/common';
import { formatDateTime } from '@/lib/format';
import { useScrollToHash } from '@/lib/useScrollToHash';
import { OptionPicker, bankFileFormatLabel, hasOptionLogos } from './BankFileFormats';
import { ProviderLogo } from './ProviderLogo';

/** Review fix (UI-12): the Name hint's example names this provider, briefly ("Wise (office account)"). */
const NAME_EXAMPLE: Record<string, string> = { bank_file: 'Bank file', revolut: 'Revolut', wise: 'Wise', truelayer: 'TrueLayer' };

const STATUS: Record<PaymentConnection['status'], { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  connected: { label: 'Connected', tone: 'success' },
  not_connected: { label: 'Not tested yet', tone: 'neutral' },
  error: { label: 'Needs a look', tone: 'danger' },
};

export default function PaymentsSettingsSection({ className }: { className?: string }) {
  const providers = usePaymentProviders();
  const connections = usePaymentConnections();
  const [connecting, setConnecting] = useState<{ provider: PaymentProviderView; connection?: PaymentConnection } | null>(null);
  // Settings#payments (Pay people's "Open Settings → Payments") lands here once this lazy section has its data
  useScrollToHash('payments', !providers.isLoading && !connections.isLoading);
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
          <TwoApprovals />
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
      {p.iconKey === 'bank' && <FileFormatLogos p={p} />}
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

/** Release 1.4 (P): the bank file card names its formats with the banks' logos (from its form's "File format"). */
function FileFormatLogos({ p }: { p: PaymentProviderView }) {
  const banks = (p.configFields.find(hasOptionLogos)?.options ?? []).filter((o) => o.iconKey && o.iconKey !== 'bank');
  if (!banks.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted" data-file-formats="">
      {banks.map((o) => <ProviderLogo key={o.value} iconKey={o.iconKey!} size="xs" />)}
      <span>Ready-made files for {banks.map((o) => bankFileFormat(o.value)?.bank ?? o.label).join(' and ')}, and a general Faster Payments file for any other UK bank</span>
    </div>
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
  // MON-5: an API connection goes live once its sandbox answered a test payment
  const sandboxDone = !!c.firstRun?.sandboxPaymentAt;
  const liveBlocked = api ? (c.status !== 'connected' ? 'Test it in test mode first' : !sandboxDone ? 'Pay one person in test mode first and wait for the sandbox to answer' : null) : null;
  const runTest = () => test.mutate(c.id, {
    onSuccess: (r) => (r.ok ? toast.success('The connection works', r.message) : toast.error('The test did not work', r.message)),
    onError: (e) => toast.error('Could not test it', errorMessage(e)),
  });
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3" data-connection={c.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-fg">{c.name}</span>
        <Badge tone={c.mode === 'live' ? 'danger' : 'info'} size="sm">{c.mode === 'live' ? (api ? 'Live: real money' : 'Live: real files') : api ? PAYMENT_MODE_LABELS.test : 'Test mode: TEST files'}</Badge>
        <Badge tone={status.tone} size="sm" dot={c.status === 'connected'}>{status.label}</Badge>
      </div>
      {!api && bankFileFormatLabel(c.settings) && <p className="mt-1 text-xs text-fg" data-connection-format={c.settings.format}>{bankFileFormatLabel(c.settings)}</p>}
      <p className="mt-1 text-xs text-muted">
        {c.lastCheckedAt ? `Last tested ${formatDateTime(c.lastCheckedAt)}` : api ? 'Test it before you pay anyone through it.' : c.mode === 'test' ? 'Its files say TEST in the name and every reference, and pay nobody. Switch it to live for real files.' : 'Makes real bank files.'}
        {/* review fix: only a working test's balance, named for its mode (a sandbox balance is not real money) */}
        {c.balancePence != null && c.status === 'connected' ? ` · ${api && c.mode === 'test' ? 'Sandbox balance' : 'Balance'} ${formatPence(c.balancePence)}` : ''}
      </p>
      {api && c.mode === 'live' && c.status !== 'connected' && p.liveNote && <p className="mt-1 text-xs text-muted" data-live-note="">{p.liveNote}</p>}
      {c.lastError && <p className="mt-1 text-xs text-danger">{c.lastError}</p>}
      {api && !p.testOnly && <FirstRun c={c} />}
      {!api && !p.testOnly && <PennyTest c={c} />}
      <div className="mt-2 flex flex-wrap gap-2">
        {api && <Button size="sm" variant="outline" className="h-10 sm:h-8" loading={test.isPending} leftIcon={<RefreshCw aria-hidden />} onClick={runTest}>Test</Button>}
        {c.mode === 'test' && !p.testOnly && <Button size="sm" variant="outline" className="h-10 sm:h-8" disabled={!!liveBlocked} title={liveBlocked ?? undefined} onClick={() => setLive(true)}>Switch to live</Button>}
        {c.mode === 'live' && (
          <Button size="sm" variant="ghost" className="h-10 sm:h-8" loading={update.isPending} onClick={() => update.mutate({ id: c.id, patch: { mode: 'test' } }, { onError: (e) => toast.error('Could not switch', errorMessage(e)) })}>
            Switch to test mode
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-10 sm:h-8" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" className="h-10 text-danger sm:h-8" leftIcon={<Unplug aria-hidden />} onClick={() => setConfirmOff(true)}>Disconnect</Button>
      </div>
      <LiveModal open={live} connection={c} liveNote={p.liveNote} file={!api} onClose={() => setLive(false)} />
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

function LiveModal({ open, connection: c, liveNote, file, onClose }: { open: boolean; connection: PaymentConnection; liveNote?: string; file?: boolean; onClose: () => void }) {
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
      description={file
        ? 'From now on its files are real: uploading one to your bank pays the people in it. Make the 1p test file first if you have not.'
        : 'From now on, approving a payment through it moves real money from your account to the people in it. Make the first live run small: one person.'}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!ready}
            loading={update.isPending}
            onClick={() => update.mutate({ id: c.id, patch: { mode: 'live', confirm: typed } }, {
              onSuccess: () => { toast.success('Switched to live', file ? 'Its next files are real bank files.' : 'Test it once more: the live service gets its own test.'); setTyped(''); onClose(); },
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
        toast.success(c ? 'Connection saved' : 'Connected', p.kind === 'api' ? 'Test it next: it starts in test mode.' : c ? 'Saved.' : 'It starts in test mode: its files say TEST and pay nobody. Make the 1p test file, then switch it to live.');
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
      // review fix (SD-4): a test provider (LM_PAYMENTS_FAKE=1) has no live mode and no bank to upload to
      description={p.testOnly
        ? 'A test provider: it never pays anyone and has no live mode.'
        : p.kind !== 'api'
        ? 'Linear Hub makes the file; you upload and approve it in your online banking. It starts in test mode: TEST files that pay nobody.'
        // review fix (UI-3): an existing live connection is not "in test mode"
        : c?.mode === 'live'
          ? 'This connection is live: approving a payment through it moves real money. After you change its details, test it again.'
          : 'It starts in test mode: nothing real is paid until you test it and switch it to live.'}
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
        <Field label="Name" htmlFor={`${uid}-name`} hint={`What you call it, e.g. “${NAME_EXAMPLE[p.id] ?? p.name} (office account)”`} error={errs.name}>
          <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        {p.configFields.map((f) => (
          <ConfigInput
            key={f.name}
            id={`${uid}-${f.name}`}
            field={f}
            value={values[f.name] ?? ''}
            saved={!!c?.secretsSet.includes(f.name)}
            neededNow={!!f.requiredUnless && !c?.secretsSet.includes(f.requiredUnless)}
            error={errs[f.name]}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
          />
        ))}
        {error && !Object.keys(errs).length && <p role="alert" className="text-sm text-danger">{errorMessage(error)}</p>}
      </form>
    </Modal>
  );
}

function ConfigInput({ id, field: f, value, saved, neededNow, error, onChange }: { id: string; field: PaymentConfigField; value: string; saved: boolean; neededNow?: boolean; error?: string; onChange: (v: string) => void }) {
  // review fix (UI-12): needed again (Revolut's code once its sign-in has gone): never "leave it empty"
  const savedHint = f.secret && saved ? (neededNow ? 'Paste a new code: the saved one has expired or was already used.' : 'Saved. Leave it empty to keep the one stored.') : null;
  const hint = [f.help, savedHint].filter(Boolean).join(' ');
  // Release 1.4 (P): a choice whose options have logos (the bank file's format) is a list of choices with the logos
  if (hasOptionLogos(f)) return <OptionPicker field={f} value={value} error={error} onChange={onChange} />;
  // package A: `requiredUnless` — e.g. Revolut's code is needed until Linear Hub holds Revolut's sign-in
  const required = (!!f.required && !(f.secret && saved)) || !!neededNow;
  return (
    <Field label={f.label} htmlFor={id} hint={hint || undefined} error={error} required={required} optional={!f.required && !neededNow}>
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

/** MONEY-MISSED-2: "Two people approve each payment" (on by default once two administrators use two-step). */
function TwoApprovals() {
  const uid = useId();
  const q = usePaymentsSettings();
  const save = useSavePaymentsSettings();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);
  if (!q.data) return null;
  const on = q.data.twoApprovals;
  return (
    <section className="mb-4 rounded-xl border border-border p-4" data-two-approvals-setting="">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h4 className="font-sans text-base font-semibold tracking-normal text-fg">Two people approve each payment <Badge tone={on ? 'success' : 'neutral'} size="sm" className="ml-1 align-middle">{on ? 'On' : 'Off'}</Badge></h4>
            <p className="mt-0.5 text-sm text-muted">
              A live payment needs a second approval from a different administrator, each with their own code. Nothing is sent before the second.
              {' '}{q.data.adminsWithTwoStep} {q.data.adminsWithTwoStep === 1 ? 'administrator uses' : 'administrators use'} two-step verification{q.data.explicit ? '.' : ' (on by default from two).'}
              {on && q.data.adminsWithTwoStep < 2 ? ' With only one, nobody can give the second approval: add another administrator or turn this off.' : ''}
            </p>
          </div>
        </div>
        {!open && <Button size="sm" variant="outline" className="h-10 shrink-0 self-start" onClick={() => setOpen(true)}>{on ? 'Turn off' : 'Turn on'}</Button>}
      </div>
      {open && (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ twoApprovals: !on, code: code.replace(/\s+/g, '') }, {
              onSuccess: (v) => { toast.success(v.twoApprovals ? 'Two approvals turned on' : 'Two approvals turned off'); setOpen(false); setCode(''); },
              onError: (err) => toast.error('Could not change it', errorMessage(err)),
            });
          }}
        >
          <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} className="sm:w-56">
            <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="font-mono" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-10" loading={save.isPending} disabled={code.replace(/\s+/g, '').length !== 6}>{on ? 'Turn off' : 'Turn on'}</Button>
            <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** MON-5: the guided first run of an API connection, step by step. */
function FirstRun({ c }: { c: PaymentConnection }) {
  const steps: { label: string; done: boolean }[] = [
    { label: 'Test the connection in test mode', done: c.mode === 'live' || c.status === 'connected' },
    { label: 'Pay one person in test mode (Pay people) and wait for the sandbox to answer', done: !!c.firstRun?.sandboxPaymentAt },
    { label: `Switch to live (type ${PAYMENT_LIVE_CONFIRMATION}) and test the live keys`, done: c.mode === 'live' },
    { label: 'Make the first live run small: one person, then check it reached them', done: !!c.firstRun?.livePaymentAt },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <ol className="mt-2 space-y-1 text-xs" aria-label="First run" data-first-run="">
      {steps.map((s) => (
        <li key={s.label} className="flex items-start gap-1.5">
          {s.done ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label="Done" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-label="To do" />}
          <span className={s.done ? 'text-muted line-through decoration-1' : 'text-fg'}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * MON-6: "Make a 1p test file" — one £0.01 payment to an account you choose (yours), in this connection's layout. Upload
 * it to your bank before the first real run; then say whether the bank took it. The account number is in the file only.
 */
function PennyTest({ c }: { c: PaymentConnection }) {
  const uid = useId();
  const make = useMakeTestFile();
  const result = useTestFileResult();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [holderName, setHolder] = useState('');
  const [sortCode, setSort] = useState('');
  const [accountNumber, setAccount] = useState('');
  const [code, setCode] = useState('');
  const local = validateBankDetails({ holderName, sortCode, accountNumber });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!local.ok) return toast.error('Check the account details', local.errors[0]?.message);
    make.mutate({ id: c.id, input: { ...local.value, code: code.replace(/\s+/g, '') } }, {
      onSuccess: (f) => {
        downloadTextFile(f.fileName, f.body, f.contentType);
        toast.success('1p test file made', 'Upload it to your bank and approve it there; then say below whether the bank took it.');
        setOpen(false);
        setAccount('');
        setCode('');
      },
      onError: (err) => toast.error('Could not make the file', errorMessage(err)),
    });
  };
  const answer = (r: 'accepted' | 'refused') => result.mutate({ id: c.id, result: r }, { onError: (err) => toast.error('Could not save that', errorMessage(err)) });
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-surface-2/60 p-2.5 text-xs" data-penny-test="">
      <p className="text-fg">
        {c.testFileResult === 'accepted'
          ? '1p test: the bank took the file. Its layout works with your bank.'
          : c.testFileResult === 'refused'
            ? '1p test: the bank refused the file. Choose another layout (Edit) or ask your bank which columns it wants, then make a new test file.'
            : c.testFileAt
              ? `1p test file made ${formatDateTime(c.testFileAt)}. Did your bank take it?`
              : 'Before the first real run, make a 1p test file: one payment of £0.01 to your own account, to check your bank takes this layout.'}
      </p>
      {c.testFileAt && !c.testFileResult && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-10 sm:h-8" loading={result.isPending && result.variables?.result === 'accepted'} onClick={() => answer('accepted')}>The bank took it</Button>
          <Button size="sm" variant="ghost" className="h-10 sm:h-8" loading={result.isPending && result.variables?.result === 'refused'} onClick={() => answer('refused')}>The bank refused it</Button>
        </div>
      )}
      {!open ? (
        <Button size="sm" variant="ghost" className="h-10 sm:h-8" leftIcon={<FileDown aria-hidden />} onClick={() => setOpen(true)}>{c.testFileAt ? 'Make another 1p test file' : 'Make a 1p test file'}</Button>
      ) : (
        <form onSubmit={submit} className="space-y-2" noValidate>
          <Field label="Name on the account" htmlFor={`${uid}-name`}><Input id={`${uid}-name`} value={holderName} onChange={(e) => setHolder(e.target.value)} autoComplete="off" maxLength={70} /></Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Sort code" htmlFor={`${uid}-sort`}><Input id={`${uid}-sort`} value={sortCode} onChange={(e) => setSort(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={8} placeholder="12-34-56" className="font-mono" /></Field>
            <Field label="Account number" htmlFor={`${uid}-acc`}><Input id={`${uid}-acc`} value={accountNumber} onChange={(e) => setAccount(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="12345678" className="font-mono" /></Field>
          </div>
          <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} hint="The file pays 1p of real money."><Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="font-mono sm:w-40" /></Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-10" loading={make.isPending} disabled={code.replace(/\s+/g, '').length !== 6}>Make the file</Button>
            <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
