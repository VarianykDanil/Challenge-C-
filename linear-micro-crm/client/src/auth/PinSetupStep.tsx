// Release 1.2 — OWNED BY U1 sign-in-pin. The two full-screen steps the PIN gate (./PinSetupGate.tsx) shows instead of the
// app: "Create your PIN" (the admin requires a PIN and you have none) and "Set up two-step verification" (an
// administrator, when the admin rule requires it). Lazy-loaded, so the main chunk does not carry them.
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { BRAND, PIN_PROBLEM_MESSAGES, pinProblem } from '@lm/shared';
import { useAuth, useCurrentUser } from '@/auth/AuthProvider';
import { useSetPin } from '@/api/pin';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/layout/theme';
import { Button, useToast } from '@/components/ui';
import { apiMessage } from '@/features/common/QueryStates';
import { PinField, PinInput } from '@/features/settings/PinInput';
import { PIN_COPY } from '@/features/settings/pinCopy';
import { TwoFactorSetupModal } from '@/features/settings/TwoFactorSetupModal';
import { COPY } from '@/content/copy';
import { fullName } from '@/lib/format';

/** The page around a step: logo and theme toggle on top, one narrow column, the company line at the foot. */
function StepFrame({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex h-16 items-center justify-between px-4 sm:px-8">
        <Logo size={30} />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8">
        <div className="w-full max-w-[420px] animate-slide-up">{children}</div>
      </main>
      <footer className="px-4 py-5 text-center text-xs text-muted sm:px-8">
        © {new Date().getFullYear()} {BRAND.legalName}
      </footer>
    </div>
  );
}

function StepHeading({ icon, eyebrow, title, body }: { icon: ReactNode; eyebrow: string; title: string; body: string }) {
  const user = useCurrentUser();
  return (
    <>
      <span className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary-soft text-primary [&_svg]:h-6 [&_svg]:w-6" aria-hidden>
        {icon}
      </span>
      <p className="eyebrow mb-1.5 text-muted">{eyebrow}</p>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      <p className="mt-3 text-xs text-muted">
        {PIN_COPY.setup.signedInAs} <span className="font-medium text-fg">{fullName(user)}</span> · <span className="break-all">{user.email}</span>
      </p>
    </>
  );
}

function SignOutLink() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      loading={busy}
      leftIcon={<LogOut aria-hidden />}
      onClick={() => {
        setBusy(true);
        void logout().finally(() => navigate('/login', { replace: true }));
      }}
    >
      {PIN_COPY.setup.signOut}
    </Button>
  );
}

/** "Create your PIN": two fields (PIN, again), the shared rules checked as you go, then the app. */
export function CreatePinStep() {
  const user = useCurrentUser();
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const save = useSetPin();
  const uid = useId();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  /** Errors show for a field once it was left with something in it, and for both after a submit. */
  const [submitted, setSubmitted] = useState(false);
  const [pinLeft, setPinLeft] = useState(false);
  const [againLeft, setAgainLeft] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const t = PIN_COPY.setup;

  const problem = pinProblem(pin, { employeeId: user.employeeId });
  const pinError = (submitted || pinLeft) && problem ? PIN_PROBLEM_MESSAGES[problem] : null;
  const againError = (submitted || againLeft) && !problem && again !== pin ? PIN_COPY.mismatch : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (problem || again !== pin || save.isPending) return;
    try {
      await save.mutateAsync({ pin });
      toast.success(t.savedToast, t.savedToastBody);
      await refresh(); // /auth/me drops pinSetupRequired and the gate hands over to the app
      void qc.invalidateQueries();
    } catch (err) {
      setServerError(apiMessage(err, 'Could not save your PIN. Try again.'));
    }
  }

  return (
    <StepFrame testId="pin-setup-step">
      <StepHeading icon={<KeyRound />} eyebrow={t.eyebrow} title={t.heading} body={t.body} />
      {serverError && (
        <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger animate-scale-in">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="text-fg">{serverError}</span>
        </div>
      )}
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="mt-6 space-y-5">
        <input type="text" name="username" autoComplete="username" value={user.email} readOnly tabIndex={-1} aria-hidden className="sr-only" />
        <PinField htmlFor={`${uid}-pin`} label={t.pinLabel} hint={PIN_COPY.rulesHint} error={pinError}>
          <PinInput
            id={`${uid}-pin`}
            autoFocus
            autoComplete="new-password"
            value={pin}
            onChange={(v) => { setPin(v); setServerError(null); }}
            onBlur={() => { if (pin) setPinLeft(true); }}
            invalid={!!pinError}
            disabled={save.isPending}
          />
        </PinField>
        <PinField htmlFor={`${uid}-again`} label={t.confirmLabel} error={againError}>
          <PinInput
            id={`${uid}-again`}
            autoComplete="new-password"
            value={again}
            onChange={(v) => { setAgain(v); setServerError(null); }}
            onBlur={() => { if (again) setAgainLeft(true); }}
            invalid={!!againError}
            disabled={save.isPending}
          />
        </PinField>
        <Button type="submit" size="lg" fullWidth loading={save.isPending} disabled={!pin || !again}>
          {t.save}
        </Button>
      </form>
      <div className="mt-6 flex justify-center">
        <SignOutLink />
      </div>
    </StepFrame>
  );
}

/**
 * "Set up two-step verification" for an administrator while the admin rule requires it. The setup itself is the
 * Settings modal (scan, verify, save the recovery codes). `onStart` runs as it opens (the gate then keeps this step up
 * while the modal is open), `onDone` when it closes, finished or not, and the gate re-reads /auth/me to decide whether
 * the app opens.
 */
export function TwoFactorRequiredStep({ onStart, onDone }: { onStart: () => void; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const t = PIN_COPY.twoFactor;
  return (
    <StepFrame testId="two-factor-required-step">
      <StepHeading icon={<ShieldCheck />} eyebrow={t.eyebrow} title={t.heading} body={t.body} />
      <p className="mt-3 text-xs text-muted">{COPY.security.twoFactor.apps}</p>
      <Button
        className="mt-6"
        size="lg"
        fullWidth
        onClick={() => {
          onStart();
          setOpen(true);
        }}
        leftIcon={<ShieldCheck aria-hidden />}
      >
        {t.start}
      </Button>
      <div className="mt-6 flex justify-center">
        <SignOutLink />
      </div>
      <TwoFactorSetupModal
        open={open}
        onClose={() => {
          setOpen(false);
          onDone();
        }}
      />
    </StepFrame>
  );
}
