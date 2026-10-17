// Owned by the Product Designer (layout); the two-step verification step by the Frontend Developer.
// Contract: exports LoginPage(); uses useAuth() and pickDemoAccounts().
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, CircleAlert, IdCard, Info, Mail, MapPin, ShieldCheck, Smartphone } from 'lucide-react';
import clsx from 'clsx';
import { BRAND, ROLE_LABELS } from '@lm/shared';
import { COPY } from '@/content/copy';
import { useAuth } from '@/auth/AuthProvider';
import { pickDemoAccounts } from '@/api/hooks';
import { ApiError } from '@/api/client';
import { apiMessage } from '@/features/common/QueryStates';
import { OneTimeCodeInput, RECOVERY_CODE_RE, RecoveryCodeInput, isCompleteCode } from '@/features/settings/OneTimeCodeInput';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { BrandBackdrop } from '@/components/brand/BrandBackdrop';
import { ThemeToggle } from '@/components/layout/theme';
import { Avatar, Badge, Button, Divider, Field, Input, Skeleton } from '@/components/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NETWORK_ERROR = 'We couldn’t reach the server. Check your connection and try again.';

export function LoginPage() {
  const { login, completeTwoFactor } = useAuth();
  const navigate = useNavigate();
  const demo = pickDemoAccounts();

  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; employeeId?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  /** Informational banner on step one, e.g. after a verification challenge expired. */
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | 'form' | string>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Step two (only for accounts with two-step verification on).
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const stage: 'credentials' | 'code' = challenge ? 'code' : 'credentials';

  useEffect(() => { if (stage === 'credentials') emailRef.current?.focus(); }, [stage]);

  const emailError = touched.email && !EMAIL_RE.test(email.trim()) ? 'Enter a valid work email.' : undefined;
  const idError = touched.employeeId && employeeId.trim().length < 3 ? 'Enter your employee ID, e.g. LM-0042.' : undefined;

  async function signIn(creds: { email: string; employeeId: string }, source: 'form' | string) {
    setError(null);
    setNotice(null);
    setSubmitting(source);
    try {
      const result = await login({ email: creds.email.trim().toLowerCase(), employeeId: creds.employeeId.trim().toUpperCase() });
      if (result.requiresTwoFactor) {
        // No session yet: swap the form for the code step and keep the credentials for "Back".
        setEmail(creds.email.trim().toLowerCase());
        setEmployeeId(creds.employeeId.trim().toUpperCase());
        setUseRecovery(false);
        setCode('');
        setRecoveryCode('');
        setCodeError(null);
        setLocked(false);
        setChallenge(result.challengeToken);
        setSubmitting(null);
        return;
      }
      navigate('/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 401 ? 'We couldn’t match that email and employee ID. Check both and try again.' : e.message);
      } else {
        setError(NETWORK_ERROR);
      }
      setSubmitting(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ email: true, employeeId: true });
    if (!EMAIL_RE.test(email.trim()) || employeeId.trim().length < 3) return;
    void signIn({ email, employeeId }, 'form');
  }

  function pickDemo(acc: { email: string; employeeId: string }) {
    setEmail(acc.email);
    setEmployeeId(acc.employeeId);
    setTouched({});
    void signIn(acc, acc.employeeId);
  }

  /** Back to step one. `message` becomes the info banner (used when the challenge expired). */
  function backToCredentials(message: string | null = null) {
    setChallenge(null);
    setCode('');
    setRecoveryCode('');
    setCodeError(null);
    setLocked(false);
    setVerifying(false);
    setError(null);
    setNotice(message);
  }

  async function verify(input: { code?: string; recoveryCode?: string }) {
    if (!challenge || verifying || locked) return;
    setCodeError(null);
    setVerifying(true);
    try {
      await completeTwoFactor({ challengeToken: challenge, ...input });
      navigate('/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        backToCredentials(COPY.security.login.expired);
        return;
      }
      if (e instanceof ApiError && e.status === 429) {
        setLocked(true);
        setCodeError(apiMessage(e, COPY.security.login.tooMany));
      } else if (e instanceof ApiError) {
        setCodeError(apiMessage(e, COPY.security.login.invalid));
        setCode('');
        setRecoveryCode('');
        requestAnimationFrame(() => codeRef.current?.focus());
      } else {
        setCodeError(NETWORK_ERROR);
      }
      setVerifying(false);
    }
  }

  function onVerifySubmit(e: FormEvent) {
    e.preventDefault();
    if (useRecovery) {
      if (RECOVERY_CODE_RE.test(recoveryCode)) void verify({ recoveryCode });
    } else if (isCompleteCode(code)) {
      void verify({ code });
    }
  }

  function toggleRecovery() {
    setUseRecovery((v) => !v);
    setCode('');
    setRecoveryCode('');
    if (!locked) setCodeError(null);
  }

  const busy = submitting !== null;
  const year = new Date().getFullYear();
  // The API may legitimately return no demo accounts; then the whole section disappears (no skeleton, no note).
  const demoAccounts = demo.data?.accounts ?? [];
  const showDemo = demo.isLoading || demo.isError || demoAccounts.length > 0;

  return (
    <div className="grid min-h-dvh bg-bg text-fg lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ───────── Brand panel ───────── */}
      <section className="relative hidden overflow-hidden bg-ink text-ink-fg lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16" aria-label={`${BRAND.name} introduction`}>
        <BrandBackdrop intensity="strong" variant="ink" vignette="left" />
        <div className="relative flex items-center gap-4">
          <Link
            to="/welcome"
            aria-label={`Back to the ${BRAND.name} public page`}
            className="focus-ring -m-1.5 inline-flex rounded-xl p-1.5 transition-colors hover:bg-ink-fg/10 focus-visible:bg-ink-fg/10"
          >
            <Logo size={36} tone="inverse" />
          </Link>
          <Link to="/welcome" className="focus-ring inline-flex items-center gap-1 rounded-md text-sm font-medium text-ink-muted transition-colors hover:text-ink-fg">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </Link>
        </div>

        <div className="relative max-w-xl">
          <p className="eyebrow mb-4 text-ink-muted">{BRAND.product} · {BRAND.tagline}</p>
          <h1 className="font-display text-[44px] font-bold leading-[1.05] tracking-tight text-ink-fg xl:text-[52px]">
            {COPY.login.headline}
          </h1>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-ink-muted">{COPY.login.subheadline}</p>

          <ul className="mt-10 space-y-5">
            {COPY.login.valueProps.map((vp, i) => (
              <li key={vp.title} className="flex items-start gap-4 animate-slide-up" style={{ animationDelay: `${120 + i * 80}ms` }}>
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/25 text-ink-fg ring-1 ring-inset ring-primary/40" aria-hidden>
                  <Check className="h-4 w-4" strokeWidth={2.5} />
                </span>
                <div>
                  <div className="font-semibold text-ink-fg">{vp.title}</div>
                  <div className="mt-0.5 text-sm leading-relaxed text-ink-muted">{vp.body}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-3 text-sm text-ink-muted">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-ink-2 ring-1 ring-inset ring-ink-fg/10" aria-hidden>
            <MapPin className="h-4 w-4" />
          </span>
          <span>
            Made in {BRAND.city} · <span className="text-ink-fg/80">{BRAND.address}</span>
          </span>
        </div>
      </section>

      {/* ───────── Form panel ───────── */}
      <section className="relative flex min-h-dvh flex-col lg:min-h-0" aria-label="Sign in">
        <div className="flex h-16 items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3 lg:hidden">
            <Link
              to="/welcome"
              aria-label={`Back to the ${BRAND.name} public page`}
              className="focus-ring -m-1 inline-flex rounded-lg p-1 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              <Logo size={30} />
            </Link>
            <Link to="/welcome" className="focus-ring inline-flex items-center gap-1 rounded-md text-sm font-medium text-muted transition-colors hover:text-fg">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Link>
          </div>
          <span className="hidden text-xs text-muted lg:inline">{BRAND.legalName}</span>
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-8 sm:px-8">
          <div className="w-full max-w-[420px] animate-slide-up">
            {stage === 'code' ? (
              <TwoFactorStep
                email={email}
                useRecovery={useRecovery}
                code={code}
                recoveryCode={recoveryCode}
                error={codeError}
                locked={locked}
                verifying={verifying}
                inputRef={codeRef}
                onCodeChange={(v) => { setCode(v); if (codeError && !locked) setCodeError(null); }}
                onRecoveryChange={(v) => { setRecoveryCode(v); if (codeError && !locked) setCodeError(null); }}
                onComplete={(c) => void verify({ code: c })}
                onSubmit={onVerifySubmit}
                onToggleRecovery={toggleRecovery}
                onBack={() => backToCredentials()}
              />
            ) : (
              <>
                <div className="mb-8 lg:hidden">
                  <h1 className="text-3xl font-bold tracking-tight">{COPY.login.headline}</h1>
                  <p className="mt-2 text-sm text-muted">{COPY.login.subheadline}</p>
                </div>
                <div className="mb-8 hidden lg:block">
                  <h2 className="text-2xl font-bold tracking-tight">Sign in to {BRAND.product}</h2>
                  <p className="mt-1.5 text-sm text-muted">Use your work email and the employee ID on your welcome email.</p>
                </div>

                {notice && !error && (
                  <div role="status" data-testid="login-notice" className="mb-5 flex items-start gap-3 rounded-xl border border-info/30 bg-info-soft px-4 py-3 text-sm text-info animate-scale-in">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span className="text-fg">{notice}</span>
                  </div>
                )}

                {error && (
                  <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger animate-scale-in">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span className="text-fg">{error}</span>
                  </div>
                )}

                <form onSubmit={onSubmit} noValidate className="space-y-5">
                  <Field label={COPY.login.emailLabel} htmlFor="login-email" error={emailError} required>
                    <Input
                      ref={emailRef}
                      id="login-email"
                      type="email"
                      name="email"
                      autoComplete="email username"
                      inputMode="email"
                      required
                      aria-required
                      placeholder="you@linear-mcr.co.uk"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      // Validate on blur only once something was typed: an empty field left by clicking elsewhere
                      // (e.g. a footer link) must not grow an error line under the cursor mid-click.
                      onBlur={() => { if (email.trim()) setTouched((t) => ({ ...t, email: true })); }}
                      invalid={!!emailError}
                      leftIcon={<Mail />}
                      size="lg"
                      disabled={busy}
                    />
                  </Field>
                  <Field label={COPY.login.employeeIdLabel} htmlFor="login-employee-id" error={idError} hint={idError ? undefined : 'Format LM-0000. Ask your team leader if you don’t have one yet.'} required>
                    <Input
                      id="login-employee-id"
                      name="employeeId"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      required
                      aria-required
                      placeholder="LM-0042"
                      value={employeeId}
                      onChange={(e) => setEmployeeId(e.target.value.toUpperCase())}
                      onBlur={() => { if (employeeId.trim()) setTouched((t) => ({ ...t, employeeId: true })); }}
                      invalid={!!idError}
                      leftIcon={<IdCard />}
                      size="lg"
                      className="font-mono tracking-wider"
                      disabled={busy}
                    />
                  </Field>
                  <Button type="submit" size="lg" fullWidth loading={submitting === 'form'} disabled={busy} rightIcon={<ArrowRight />}>
                    {COPY.login.submit}
                  </Button>
                  <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    Secure session · no passwords to remember
                  </p>
                </form>

                {showDemo && (
                  <>
                    <Divider label={COPY.login.demoTitle} spacing="lg" />
                    <DemoAccounts
                      accounts={demoAccounts}
                      loading={demo.isLoading}
                      failed={demo.isError}
                      busyId={typeof submitting === 'string' && submitting !== 'form' ? submitting : null}
                      disabled={busy}
                      onPick={pickDemo}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <footer className="flex flex-col items-center justify-between gap-2 px-5 py-5 text-xs text-muted sm:flex-row sm:px-8">
          <span>© {year} {BRAND.legalName}. All rights reserved.</span>
          <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <Link to="/welcome" className="focus-ring rounded-md font-medium text-primary underline-offset-4 hover:underline">
              About {BRAND.name}
            </Link>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              <LogoMark size={14} title="" /> {BRAND.product} · {BRAND.city}
            </span>
          </span>
        </footer>
      </section>
    </div>
  );
}

/* ───────────────────────────── pieces ───────────────────────────── */

interface TwoFactorStepProps {
  email: string;
  useRecovery: boolean;
  code: string;
  recoveryCode: string;
  error: string | null;
  /** 429 from the server: inputs stay disabled with the message until the user goes back. */
  locked: boolean;
  verifying: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onCodeChange: (value: string) => void;
  onRecoveryChange: (value: string) => void;
  onComplete: (code: string) => void;
  onSubmit: (e: FormEvent) => void;
  onToggleRecovery: () => void;
  onBack: () => void;
}

/** Step two of sign-in: the authenticator code (auto-submits on the sixth digit) or a recovery code. */
function TwoFactorStep({ email, useRecovery, code, recoveryCode, error, locked, verifying, inputRef, onCodeChange, onRecoveryChange, onComplete, onSubmit, onToggleRecovery, onBack }: TwoFactorStepProps) {
  const t = COPY.security.login;
  const canSubmit = useRecovery ? RECOVERY_CODE_RE.test(recoveryCode) : isCompleteCode(code);
  const disabled = locked || verifying;

  return (
    <div data-testid="login-2fa" className="animate-slide-up">
      <span className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary-soft text-primary" aria-hidden>
        <Smartphone className="h-6 w-6" />
      </span>
      <h2 className="text-2xl font-bold tracking-tight">{t.heading}</h2>
      <p className="mt-1.5 text-sm text-muted">{useRecovery ? t.bodyRecovery : t.body}</p>
      <p className="mt-2 text-xs text-muted">
        {t.signingInAs} <span className="font-medium text-fg">{email}</span>
      </p>

      {error && (
        <div role="alert" data-testid="login-2fa-error" className="mt-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger animate-scale-in">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="text-fg">{error}</span>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        {useRecovery ? (
          <Field label={t.recoveryLabel} htmlFor="login-recovery-code" hint={t.recoveryHint}>
            <RecoveryCodeInput
              ref={inputRef}
              id="login-recovery-code"
              name="recoveryCode"
              autoFocus
              value={recoveryCode}
              onChange={onRecoveryChange}
              disabled={disabled}
              invalid={!!error}
            />
          </Field>
        ) : (
          <Field label={t.codeLabel} htmlFor="login-code" hint={t.codeHint}>
            <OneTimeCodeInput
              ref={inputRef}
              id="login-code"
              name="code"
              autoFocus
              value={code}
              onChange={onCodeChange}
              onComplete={onComplete}
              disabled={disabled}
              invalid={!!error}
            />
          </Field>
        )}
        <Button type="submit" size="lg" fullWidth loading={verifying} disabled={locked || !canSubmit} rightIcon={<ArrowRight />}>
          {t.verify}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <Button type="button" variant="link" size="sm" onClick={onToggleRecovery} disabled={verifying}>
            {useRecovery ? t.useApp : t.useRecovery}
          </Button>
          <Button type="button" variant="link" size="sm" onClick={onBack} disabled={verifying} leftIcon={<ArrowLeft />}>
            {t.back}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface DemoAccountsProps {
  accounts?: { label: string; role: string; email: string; employeeId: string }[];
  loading: boolean;
  failed: boolean;
  busyId: string | null;
  disabled: boolean;
  onPick: (acc: { email: string; employeeId: string }) => void;
}

const ROLE_TONE: Record<string, 'primary' | 'accent' | 'info' | 'success' | 'neutral'> = {
  admin: 'primary',
  leader: 'accent',
  recruiter: 'info',
  rep: 'success',
};

function DemoAccounts({ accounts, loading, failed, busyId, disabled, onPick }: DemoAccountsProps) {
  if (loading) {
    return (
      <div className="grid gap-2" aria-busy>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
            <Skeleton circle className="h-9 w-9" />
            <div className="flex-1"><Skeleton className="h-3.5 w-32" /><Skeleton className="mt-2 h-3 w-44" /></div>
          </div>
        ))}
      </div>
    );
  }
  if (failed || !accounts?.length) {
    return <p className="text-center text-xs text-muted">Demo accounts aren’t available right now — sign in with your own details above.</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-2">
      {accounts.map((acc) => {
        const isBusy = busyId === acc.employeeId;
        return (
          <li key={acc.employeeId} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(acc)}
              disabled={disabled}
              aria-label={`Sign in as ${acc.label}, ${ROLE_LABELS[acc.role as keyof typeof ROLE_LABELS] ?? acc.role}`}
              className={clsx(
                'focus-ring card-hover group flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left shadow-card transition-colors',
                'hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0',
                isBusy && 'border-primary/50 bg-primary-soft/40',
              )}
            >
              <Avatar name={acc.label} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-fg">{acc.label}</span>
                  <Badge size="sm" className="shrink-0" tone={ROLE_TONE[acc.role] ?? 'neutral'}>{ROLE_LABELS[acc.role as keyof typeof ROLE_LABELS] ?? acc.role}</Badge>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {acc.email} · <span className="font-mono">{acc.employeeId}</span>
                </span>
              </span>
              {isBusy ? (
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden />
              ) : (
                <ArrowRight className="h-4 w-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
