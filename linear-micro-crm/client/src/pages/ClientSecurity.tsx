// Release 1.3 — /client/security (client accounts) — OWNED BY P6 client-portal. The client's own account (name, email,
// access code, campaign) and their sign-in PIN: change it (asks for the current one; other devices are signed out),
// or set one (the demo client, the only account allowed to have none). A PIN is required for client accounts, so it
// can never be removed here. A lock shows when it ends. Endpoints: GET/POST /auth/pin (routes/auth.ts, U1).
import { useEffect, useId, useState, type FormEvent } from 'react';
import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { isPinFormatValid, pinProblem } from '@lm/shared';
import { ApiError } from '@/api/client';
import { useClientPortal } from '@/api/clientPortal';
import { pinKeys, usePinStatus, useSetPin } from '@/api/pin';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Card, Modal, PageHeader, Skeleton, useToast } from '@/components/ui';
import { CLIENT_PIN_COPY, clientPinProblemMessage } from '@/features/client/clientPinCopy';
import { apiMessage, errorMessage } from '@/features/common/QueryStates';
import { PinField, PinInput } from '@/features/settings/PinInput';
import { PIN_COPY, pinUnlockTime } from '@/features/settings/pinCopy';
import { COPY } from '@/content/copy';
import { formatDate, fullName } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { useQueryClient } from '@tanstack/react-query';

export function ClientSecurityPage() {
  usePageTitle(COPY.nav.clientSecurity.title);
  const user = useCurrentUser();
  const portal = useClientPortal();
  return (
    <>
      <PageHeader title={COPY.nav.clientSecurity.title} description={COPY.nav.clientSecurity.description} />
      <div className="space-y-6">
        <Card data-testid="client-account">
          <h2 className="text-base font-semibold text-fg">Your account</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div className="min-w-0"><dt className="text-xs text-muted">Name</dt><dd className="truncate font-medium text-fg">{fullName(user)}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted">Email</dt><dd className="break-all font-medium text-fg">{user.email}</dd></div>
            <div><dt className="text-xs text-muted">Access code</dt><dd className="font-mono font-medium tracking-wider text-fg">{user.employeeId}</dd></div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Campaign</dt>
              <dd className="font-medium text-fg">
                {portal.data ? <Badge tone="neutral" dot color={portal.data.campaign.color}>{portal.data.campaign.name}</Badge> : <Skeleton className="h-5 w-40" />}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted">To change your name or email, ask Linear MCR. They can also switch your account off.</p>
        </Card>
        <ClientPinCard />
      </div>
    </>
  );
}

function ClientPinCard() {
  const t = PIN_COPY.settings;
  const status = usePinStatus();
  const [open, setOpen] = useState(false);
  const s = status.data;
  const { refetch } = status;
  // A lock ends by itself: read the status again at that minute.
  const lockedUntil = s?.locked ? s.lockedUntil : undefined;
  useEffect(() => {
    const wait = lockedUntil ? Date.parse(lockedUntil) - Date.now() + 1000 : Number.NaN;
    if (!Number.isFinite(wait) || wait > 2 ** 31 - 1) return;
    const timer = setTimeout(() => void refetch(), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [lockedUntil, refetch]);

  return (
    <Card data-testid="client-pin-card">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-fg">{t.title}</h2>
            {s && (
              <Badge tone={s.locked ? 'danger' : s.hasPin ? 'success' : 'neutral'} dot={s.hasPin && !s.locked} data-testid="client-pin-badge">
                {s.locked ? t.locked : s.hasPin ? t.on : t.off}
              </Badge>
            )}
            {s?.required && <Badge tone="info" size="sm">{t.required}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {status.isLoading ? (
              <Skeleton className="h-3.5 w-56" />
            ) : status.isError ? (
              <span className="inline-flex flex-wrap items-center gap-2 text-danger">
                {errorMessage(status.error, 'Could not load your PIN status')}
                <Button variant="outline" size="sm" onClick={() => void status.refetch()} leftIcon={<RefreshCw aria-hidden />}>Try again</Button>
              </span>
            ) : s?.locked ? (
              t.lockedHint(pinUnlockTime(s.lockedUntil))
            ) : s?.hasPin ? (
              <>{t.setAt} <span className="font-medium text-fg">{formatDate(s.setAt)}</span></>
            ) : (
              'No PIN yet. Add one so your email and access code alone can never open your account.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant={s?.hasPin ? 'outline' : 'primary'} onClick={() => setOpen(true)} disabled={!s || s.locked} leftIcon={<KeyRound aria-hidden />}>
            {s?.hasPin ? t.change : t.set}
          </Button>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{CLIENT_PIN_COPY.description} {t.lockRule}</p>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {CLIENT_PIN_COPY.forgotten}
      </p>
      {open && <ClientPinModal changing={Boolean(s?.hasPin)} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function errorField(e: unknown): string | null {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return null;
  const first = e.details[0] as { path?: unknown } | undefined;
  return typeof first?.path === 'string' ? first.path : null;
}

function ClientPinModal({ changing, onClose }: { changing: boolean; onClose: () => void }) {
  const t = PIN_COPY.settings;
  const user = useCurrentUser();
  const toast = useToast();
  const qc = useQueryClient();
  const save = useSetPin();
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problem = pinProblem(pin, { employeeId: user.employeeId });
  const currentError = fieldError?.field === 'currentPin' ? fieldError.message : submitted && changing && !isPinFormatValid(current) ? t.currentNeeded : null;
  const pinError = fieldError?.field === 'pin' ? fieldError.message : (submitted || pin.length >= 4) && problem ? clientPinProblemMessage(problem) : null;
  const againError = submitted && !problem && again !== pin ? PIN_COPY.mismatch : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    setFieldError(null);
    if ((changing && !isPinFormatValid(current)) || problem || again !== pin || save.isPending) return;
    try {
      await save.mutateAsync({ pin, ...(changing ? { currentPin: current } : {}) });
      toast.success(t.savedToast, t.savedToastBody);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) void qc.invalidateQueries({ queryKey: pinKeys.status, exact: true });
      const field = errorField(err);
      if (field === 'currentPin' || field === 'pin') {
        setFieldError({ field, message: field === 'pin' && problem ? clientPinProblemMessage(problem) : apiMessage(err, 'Check this field') });
        if (field === 'currentPin') setCurrent('');
      } else {
        setError(apiMessage(err, 'Could not save your PIN. Try again.'));
      }
    }
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title={changing ? t.changeTitle : t.setTitle}
      icon={<KeyRound aria-hidden />}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form={formId} loading={save.isPending} disabled={!pin || !again || (changing && !current)}>{t.save}</Button>
        </>
      }
    >
      {error && <p role="alert" className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-fg">{error}</p>}
      <form id={formId} onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
        <input type="text" name="username" autoComplete="username" value={user.email} readOnly tabIndex={-1} aria-hidden className="sr-only" />
        {changing && (
          <PinField htmlFor={`${uid}-current`} label={t.currentLabel} error={currentError}>
            <PinInput id={`${uid}-current`} autoComplete="current-password" value={current} onChange={(v) => { setCurrent(v); setFieldError(null); }} invalid={!!currentError} disabled={save.isPending} />
          </PinField>
        )}
        <PinField htmlFor={`${uid}-pin`} label={t.newLabel} hint={CLIENT_PIN_COPY.rulesHint} error={pinError}>
          <PinInput id={`${uid}-pin`} autoComplete="new-password" value={pin} onChange={(v) => { setPin(v); setFieldError(null); }} invalid={!!pinError} disabled={save.isPending} />
        </PinField>
        <PinField htmlFor={`${uid}-again`} label={t.confirmLabel} error={againError}>
          <PinInput id={`${uid}-again`} autoComplete="new-password" value={again} onChange={setAgain} invalid={!!againError} disabled={save.isPending} />
        </PinField>
      </form>
    </Modal>
  );
}
