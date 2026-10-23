// Owned by the Product Designer (layout); the two-step verification step by the Frontend Developer; the PIN step by
// U1 sign-in-pin (release 1.2); the client sign-in (an access code instead of an employee ID) and the demo client button
// by P6 client-portal (release 1.3). Release 1.4 (package S): the sentence after the automatic sign-out 14 hours after
// sign-in, on step one (api/sessionEnd.ts); two-step verification is asked of every account but the demo ones.
// Contract: exports LoginPage(); uses useAuth() and pickDemoAccounts().
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, IdCard, Info, KeyRound, Mail, MapPin, ShieldCheck, Smartphone } from 'lucide-react';
import clsx from 'clsx';
import { BRAND, PIN_MIN_LENGTH, POSITION_LABELS, ROLE_LABELS, isPinFormatValid, type DemoTeamAccounts, type LoginPinDetails } from '@lm/shared';
import { COPY } from '@/content/copy';
import { useAuth } from '@/auth/AuthProvider';
import { pickDemoAccounts } from '@/api/hooks';
import { ApiError } from '@/api/client';
import { onSessionEnded, peekSessionEndNotice, takeSessionEndNotice } from '@/api/sessionEnd';
import { apiMessage } from '@/features/common/QueryStates';
import { OneTimeCodeInput, RECOVERY_CODE_RE, RecoveryCodeInput, isCompleteCode } from '@/features/settings/OneTimeCodeInput';
import { PinField, PinInput } from '@/features/settings/PinInput';
import { PIN_COPY } from '@/features/settings/pinCopy';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { BrandBackdrop } from '@/components/brand/BrandBackdrop';
import { ThemeToggle } from '@/components/layout/theme';
import { Avatar, Badge, Button, Divider, Field, Input, Skeleton } from '@/components/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NETWORK_ERROR = 'We couldn’t reach the server. Check your connection and try again.';
/** Release 1.3 (P6): a client portal account signs in with an access code ("CL-0002") where staff use an employee ID. */
const isAccessCode = (code: string) => /^CL-/i.test(code.trim());
/** Show "N tries left" once this few wrong PINs remain before the lock. */
const WARN_TRIES_LEFT = 3;

/**
 * Release 1.2 (U1): why the PIN step opens. 'missing' comes from a 200 `requiresPin` answer (`login()` resolves with
 * it); 'wrong' and 'locked' from a 401 / 423 error. `message`: the server's sentence for a lock, which says when it
 * ends ("Too many wrong PINs. Try again after 14:35, or ask an administrator to reset your PIN.").
 */
type PinStepReason = { reason: 'missing' | LoginPinDetails['reason']; attemptsLeft?: number; message?: string };

/**
 * The sign-in failed at the PIN — 401 (wrong) or 423 (locked) with `details: { requiresPin: true, reason,
 * attemptsLeft?, lockedUntil? }` (shared LoginPinDetails), plus the server's sentence. Null for any other answer.
 */
function pinStop(e: unknown): (LoginPinDetails & { message: string }) | null {
  if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 423)) return null;
  const d = e.details as Partial<LoginPinDetails> | null | undefined;
  return d && typeof d === 'object' && d.requiresPin === true && typeof d.reason === 'string'
    ? { ...(d as LoginPinDetails), message: apiMessage(e, PIN_COPY.login.locked) }
    : null;
}

/** The error line for a wrong PIN, with the tries left once few remain. */
function wrongPinMessage(attemptsLeft: number | undefined): string {
  const t = PIN_COPY.login;
  return attemptsLeft !== undefined && attemptsLeft <= WARN_TRIES_LEFT ? `${t.wrong} ${t.triesLeft(attemptsLeft)}` : t.wrong;
}

export function LoginPage() {
  const { login, completeTwoFactor } = useAuth();
  const navigate = useNavigate();
  const demo = pickDemoAccounts();

  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; employeeId?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  /**
   * Informational banner on step one, e.g. after a verification challenge expired. Release 1.4: or why the last
   * session ended — "For security you are signed out 14 hours after signing in. Sign in again to carry on."
   */
  const [notice, setNotice] = useState<string | null>(() => peekSessionEndNotice());
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

  // Step 1b (release 1.2, only for accounts with a PIN): the PIN, after the email and employee ID matched.
  const [pinStep, setPinStep] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  /** Locked PIN (423) or the login limiter (429): the field stays disabled with the message until the user goes back. */
  const [pinLocked, setPinLocked] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinHint, setPinHint] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const stage: 'credentials' | 'pin' | 'code' = challenge ? 'code' : pinStep ? 'pin' : 'credentials';

  useEffect(() => { if (stage === 'credentials') emailRef.current?.focus(); }, [stage]);

  // Release 1.4: the sentence is shown once (forgotten now), and a reason that arrives a moment later (another request
  // was still in flight when the page opened) still shows.
  useEffect(() => {
    takeSessionEndNotice();
    return onSessionEnded(() => {
      const late = takeSessionEndNotice();
      if (late) setNotice(late);
    });
  }, []);

  const emailError = touched.email && !EMAIL_RE.test(email.trim()) ? 'Enter a valid work email.' : undefined;
  const client = isAccessCode(employeeId);
  const idError = touched.employeeId && employeeId.trim().length < 3 ? (client ? 'Enter your access code, e.g. CL-0002.' : 'Enter your employee ID, e.g. LM-0042.') : undefined;
  const noMatch = (code: string) =>
    isAccessCode(code) ? 'We couldn’t match that email and access code. Check both and try again.' : 'We couldn’t match that email and employee ID. Check both and try again.';

  /** Swap the form for the code step (no session yet) and keep the credentials for "Back". */
  function openCodeStep(challengeToken: string) {
    setPinStep(false);
    setUseRecovery(false);
    setCode('');
    setRecoveryCode('');
    setCodeError(null);
    setLocked(false);
    setChallenge(challengeToken);
  }

  /** Swap the form for the PIN step, as the server's answer says (missing, wrong or locked). */
  function openPinStep(stop: PinStepReason) {
    setPin('');
    setPinBusy(false);
    setPinLocked(stop.reason === 'locked');
    setPinError(stop.reason === 'locked' ? stop.message ?? PIN_COPY.login.locked : stop.reason === 'wrong' ? wrongPinMessage(stop.attemptsLeft) : null);
    setPinHint(stop.reason === 'missing' && stop.attemptsLeft !== undefined && stop.attemptsLeft <= WARN_TRIES_LEFT ? PIN_COPY.login.triesLeft(stop.attemptsLeft) : null);
    setPinStep(true);
  }

  async function signIn(creds: { email: string; employeeId: string }, source: 'form' | string) {
    setError(null);
    setNotice(null);
    setSubmitting(source);
    const normalised = { email: creds.email.trim().toLowerCase(), employeeId: creds.employeeId.trim().toUpperCase() };
    try {
      const result = await login(normalised);
      if (result.requiresPin) {
        setEmail(normalised.email);
        setEmployeeId(normalised.employeeId);
        openPinStep({ reason: 'missing', attemptsLeft: result.attemptsLeft });
        setSubmitting(null);
        return;
      }
      if (result.requiresTwoFactor) {
        setEmail(normalised.email);
        setEmployeeId(normalised.employeeId);
        openCodeStep(result.challengeToken);
        setSubmitting(null);
        return;
      }
      navigate('/', { replace: true });
    } catch (e) {
      const stop = pinStop(e);
      if (stop) {
        setEmail(normalised.email);
        setEmployeeId(normalised.employeeId);
        openPinStep(stop);
        setSubmitting(null);
        return;
      }
      if (e instanceof ApiError) {
        setError(e.status === 401 ? noMatch(normalised.employeeId) : e.message);
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
    setPinStep(false);
    setPin('');
    setPinError(null);
    setPinHint(null);
    setPinLocked(false);
    setPinBusy(false);
    setError(null);
    setNotice(message);
  }

  async function submitPin(e?: FormEvent) {
    e?.preventDefault();
    if (pinBusy || pinLocked || !isPinFormatValid(pin)) return;
    setPinError(null);
    setPinBusy(true);
    try {
      const result = await login({ email, employeeId, pin });
      if (result.requiresPin) {
        openPinStep({ reason: 'missing', attemptsLeft: result.attemptsLeft }); // the PIN did not arrive: ask again
        return;
      }
      if (result.requiresTwoFactor) {
        openCodeStep(result.challengeToken);
        setPinBusy(false);
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      const stop = pinStop(err);
      if (stop?.reason === 'locked') {
        setPinLocked(true);
        setPinHint(null);
        setPinError(stop.message);
      } else if (stop) {
        setPinHint(null);
        setPinError(wrongPinMessage(stop.attemptsLeft));
        setPin('');
        requestAnimationFrame(() => pinRef.current?.focus());
      } else if (err instanceof ApiError && err.status === 429) {
        setPinLocked(true);
        setPinError(apiMessage(err, PIN_COPY.login.tooMany));
      } else if (err instanceof ApiError && err.status === 401) {
        // The email and employee ID stopped matching meanwhile (e.g. the account was deactivated): start again.
        backToCredentials();
        setError(noMatch(employeeId));
      } else {
        setPinError(err instanceof ApiError ? err.message : NETWORK_ERROR);
      }
      setPinBusy(false);
    }
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
  // Release 1.3 (P6): the seeded demo client portal account(s), listed apart from the four staff accounts.
  const demoClients = demo.data?.clientAccounts ?? [];
  // Release 1.3.1: the blank demo teams (Sapiens), under the four.
  const demoTeams = demo.data?.demoTeams ?? [];
  const showDemo = demo.isLoading || demo.isError || demoAccounts.length > 0;

  return (
    <div className="grid min-h-dvh bg-bg text-fg lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ───────── Brand panel ───────── */}
      <section className="relative hidden overflow-hidden bg-ink text-ink-fg lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16" aria-label={`${BRAND.name} introduction`}>
        <BrandBackdrop intensity="strong" variant="ink" vignette="left" />
        <div className="relative flex items-center gap-4">
          <Link
            to="/welcome"
            aria-label={`${BRAND.name} public page`}
            className="focus-ring -m-1.5 inline-flex rounded-xl p-1.5 transition-colors hover:bg-ink-fg/10 focus-visible:bg-ink-fg/10"
          >
            <Logo size={36} tone="inverse" />
          </Link>
          {/* Step one only: the PIN and two-step steps have their own way back, to step one. */}
          {stage === 'credentials' && (
            <Link to="/welcome" className="focus-ring inline-flex items-center gap-1 rounded-md text-sm font-medium text-ink-muted transition-colors hover:text-ink-fg">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Link>
          )}
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
          {/* Below lg (phones and tablets) the header links are at least 40 px tall to tap. */}
          <div className="flex items-center gap-3 lg:hidden">
            <Link
              to="/welcome"
              aria-label={`${BRAND.name} public page`}
              className="focus-ring -m-1 inline-flex min-h-10 items-center rounded-lg p-1 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              <Logo size={30} />
            </Link>
            {stage === 'credentials' && (
              <Link to="/welcome" className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-md text-sm font-medium text-muted transition-colors hover:text-fg">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Back
              </Link>
            )}
          </div>
          <span className="hidden text-xs text-muted lg:inline">{BRAND.legalName}</span>
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-8 sm:px-8">
          <div className="w-full max-w-[420px] animate-slide-up">
            {stage === 'code' ? (
              <TwoFactorStep
                email={email}
                client={client}
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
            ) : stage === 'pin' ? (
              <PinStep
                email={email}
                client={client}
                pin={pin}
                error={pinError}
                hint={pinHint}
                locked={pinLocked}
                busy={pinBusy}
                inputRef={pinRef}
                onPinChange={(v) => { setPin(v); if (pinError && !pinLocked) setPinError(null); }}
                onSubmit={(e) => void submitPin(e)}
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
                  <Field
                    label={COPY.login.employeeIdLabel}
                    htmlFor="login-employee-id"
                    error={idError}
                    hint={idError ? undefined : client ? 'Your client access code, from your invite email.' : 'Format LM-0000. Ask your team leader if you don’t have one yet. Clients: use your access code, CL-0000.'}
                    required
                  >
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
                      clientAccounts={demoClients}
                      teams={demoTeams}
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
            <Link to="/welcome" className="focus-ring rounded-md font-medium text-primary underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-10 max-sm:items-center">
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
  /** Release 1.4: a client account (an access code, not an employee ID). */
  client: boolean;
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
function TwoFactorStep({ email, client, useRecovery, code, recoveryCode, error, locked, verifying, inputRef, onCodeChange, onRecoveryChange, onComplete, onSubmit, onToggleRecovery, onBack }: TwoFactorStepProps) {
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
        {/* One link per line: the way back says where it goes, so the two no longer fit side by side. */}
        <div className="flex flex-col items-start gap-2 text-sm max-sm:gap-0">
          <Button type="button" variant="link" size="sm" onClick={onToggleRecovery} disabled={verifying}>
            {useRecovery ? t.useApp : t.useRecovery}
          </Button>
          <Button type="button" variant="link" size="sm" onClick={onBack} disabled={verifying} leftIcon={<ArrowLeft />}>
            {client ? t.backClient : t.back}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface PinStepProps {
  email: string;
  /** Release 1.4: a client account (an access code, not an employee ID). */
  client: boolean;
  pin: string;
  error: string | null;
  /** A quiet line under the field (e.g. tries left), shown when there is no error. */
  hint: string | null;
  locked: boolean;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPinChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onBack: () => void;
}

/** Release 1.2 (U1): sign-in step for accounts with a PIN, between the credentials and the two-step code. */
function PinStep({ email, client, pin, error, hint, locked, busy, inputRef, onPinChange, onSubmit, onBack }: PinStepProps) {
  const t = PIN_COPY.login;
  return (
    <div data-testid="login-pin" className="animate-slide-up">
      <span className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary-soft text-primary" aria-hidden>
        <KeyRound className="h-6 w-6" />
      </span>
      <h2 className="text-2xl font-bold tracking-tight">{t.heading}</h2>
      <p className="mt-1.5 text-sm text-muted">{t.body}</p>
      <p className="mt-2 text-xs text-muted">
        {t.signingInAs} <span className="font-medium text-fg">{email}</span>
      </p>

      {error && (
        <div role="alert" data-testid="login-pin-error" className="mt-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger animate-scale-in">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="text-fg">{error}</span>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        {/* The account the PIN belongs to, for password managers (they pair a password field with a username). */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden className="sr-only" />
        <PinField htmlFor="login-pin" label={t.label} hint={hint ?? undefined}>
          <PinInput
            ref={inputRef}
            id="login-pin"
            name="pin"
            autoFocus
            autoComplete="current-password"
            value={pin}
            onChange={onPinChange}
            disabled={locked || busy}
            invalid={!!error && !locked}
            minLength={PIN_MIN_LENGTH}
          />
        </PinField>
        <Button type="submit" size="lg" fullWidth loading={busy} disabled={locked || !isPinFormatValid(pin)} rightIcon={<ArrowRight />}>
          {t.submit}
        </Button>
        <p className="text-xs leading-relaxed text-muted">{t.forgot}</p>
        <div className="flex justify-end">
          <Button type="button" variant="link" size="sm" onClick={onBack} disabled={busy} leftIcon={<ArrowLeft />}>
            {client ? t.backClient : t.back}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface DemoAccountsProps {
  accounts?: { label: string; role: string; email: string; employeeId: string; name?: string; organisation?: string; sector?: string }[];
  /** Release 1.3 (P6): the demo client portal account(s), under their own heading ("Charity accounts" since 1.3.1). */
  clientAccounts?: NonNullable<DemoAccountsProps['accounts']>;
  /** Release 1.3.1: the blank demo teams (team Sapiens), each a disclosure under the four. */
  teams?: DemoTeamAccounts[];
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
  client: 'neutral',
};

function DemoAccounts({ accounts, clientAccounts, teams, loading, failed, busyId, disabled, onPick }: DemoAccountsProps) {
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
  const list = (items: NonNullable<DemoAccountsProps['accounts']>, testId?: string) => (
    <ul className="grid grid-cols-1 gap-2" data-testid={testId}>
      {items.map((acc) => {
        const isBusy = busyId === acc.employeeId;
        // Release 1.3.1: a demo client account reads "Hannah Price — Breast Cancer Now" with a "Charity" tag.
        const title = acc.organisation ? `${acc.name ?? acc.label} — ${acc.organisation}` : acc.label;
        const tag = acc.organisation && acc.sector === 'charity' ? 'Charity' : (ROLE_LABELS[acc.role as keyof typeof ROLE_LABELS] ?? acc.role);
        return (
          <li key={acc.employeeId} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(acc)}
              disabled={disabled}
              aria-label={`Sign in as ${acc.organisation ? `${acc.name ?? acc.label}, ${acc.organisation}` : acc.label}, ${tag}`}
              className={clsx(
                'focus-ring card-hover group flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left shadow-card transition-colors',
                'hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0',
                isBusy && 'border-primary/50 bg-primary-soft/40',
              )}
            >
              <Avatar name={acc.name ?? acc.label} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  {/* the name and position (or a charity's organisation) wrap to a second line on a phone rather than being
                      cut ("Jordan Lee (Field …", 1.3.1 UI review) */}
                  <span className="min-w-0 break-words text-sm font-semibold text-fg">{title}</span>
                  <Badge size="sm" className="shrink-0" tone={ROLE_TONE[acc.role] ?? 'neutral'}>{tag}</Badge>
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
  if (!clientAccounts?.length && !teams?.length) return list(accounts);
  return (
    <div className="space-y-4">
      {list(accounts)}
      {teams?.map((team) => <DemoTeam key={team.name} team={team} busyId={busyId} disabled={disabled} onPick={onPick} />)}
      {clientAccounts?.length ? (
        <div>
          <p className="eyebrow mb-2 text-muted">{clientAccounts.every((a) => a.sector === 'charity') ? 'Charity accounts' : 'Client accounts'}</p>
          {list(clientAccounts, 'demo-client-accounts')}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Release 1.3.1: a blank demo team's one-click sign-ins (team Sapiens), folded into "Sapiens team (7)" so the page stays
 * short on a phone. Opened, each row is the name and position; one tap signs in, like the four above.
 */
function DemoTeam({ team, busyId, disabled, onPick }: { team: DemoTeamAccounts } & Pick<DemoAccountsProps, 'busyId' | 'disabled' | 'onPick'>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="rounded-xl border border-border bg-surface shadow-card" data-testid="demo-team">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="focus-ring flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: team.color }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-fg">{team.name} team <span className="font-normal text-muted">({team.accounts.length})</span></span>
          <span className="block text-xs text-muted">New accounts: everything works, nothing logged yet</span>
        </span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-subtle transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul id={panelId} className="grid grid-cols-1 gap-0.5 border-t border-border p-1.5" data-testid="demo-team-accounts">
          {team.accounts.map((acc) => {
            const name = acc.name ?? acc.label;
            const what = acc.position ? POSITION_LABELS[acc.position] : (ROLE_LABELS[acc.role] ?? acc.role);
            const isBusy = busyId === acc.employeeId;
            return (
              <li key={acc.employeeId} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onPick(acc)}
                  disabled={disabled}
                  aria-label={`Sign in as ${name}, ${what}, ${team.name} team`}
                  className={clsx(
                    'focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    isBusy && 'bg-primary-soft/40',
                  )}
                >
                  <Avatar name={name} color={team.color} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{name}</span>
                  <Badge size="sm" className="shrink-0" tone={ROLE_TONE[acc.role] ?? 'neutral'}>{what}</Badge>
                  {isBusy && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
