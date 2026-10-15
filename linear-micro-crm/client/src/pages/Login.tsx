// Owned by the Product Designer. Contract: exports LoginPage(); uses useAuth() and pickDemoAccounts().
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, CircleAlert, IdCard, Mail, MapPin, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { BRAND, ROLE_LABELS } from '@lm/shared';
import { COPY } from '@/content/copy';
import { useAuth } from '@/auth/AuthProvider';
import { pickDemoAccounts } from '@/api/hooks';
import { ApiError } from '@/api/client';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/layout/theme';
import { Avatar, Badge, Button, Divider, Field, Input, Skeleton } from '@/components/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const demo = pickDemoAccounts();

  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; employeeId?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | 'form' | string>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const emailError = touched.email && !EMAIL_RE.test(email.trim()) ? 'Enter a valid work email.' : undefined;
  const idError = touched.employeeId && employeeId.trim().length < 3 ? 'Enter your employee ID, e.g. LM-0042.' : undefined;

  async function signIn(creds: { email: string; employeeId: string }, source: 'form' | string) {
    setError(null);
    setSubmitting(source);
    try {
      await login({ email: creds.email.trim().toLowerCase(), employeeId: creds.employeeId.trim().toUpperCase() });
      navigate('/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 401 ? 'We couldn’t match that email and employee ID. Check both and try again.' : e.message);
      } else {
        setError('We couldn’t reach the server. Check your connection and try again.');
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

  const busy = submitting !== null;
  const year = new Date().getFullYear();

  return (
    <div className="grid min-h-dvh bg-bg text-fg lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ───────── Brand panel ───────── */}
      <section className="relative hidden overflow-hidden bg-ink text-ink-fg lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16" aria-label={`${BRAND.name} introduction`}>
        <BrandBackdrop />
        <div className="relative">
          <Logo size={36} tone="inverse" />
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
          <div className="lg:hidden">
            <Logo size={30} />
          </div>
          <span className="hidden text-xs text-subtle lg:inline">{BRAND.legalName}</span>
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-8 sm:px-8">
          <div className="w-full max-w-[420px] animate-slide-up">
            <div className="mb-8 lg:hidden">
              <h1 className="text-3xl font-bold tracking-tight">{COPY.login.headline}</h1>
              <p className="mt-2 text-sm text-muted">{COPY.login.subheadline}</p>
            </div>
            <div className="mb-8 hidden lg:block">
              <h2 className="text-2xl font-bold tracking-tight">Sign in to {BRAND.product}</h2>
              <p className="mt-1.5 text-sm text-muted">Use your work email and the employee ID on your welcome email.</p>
            </div>

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
                  placeholder="you@linear-mcr.co.uk"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
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
                  placeholder="LM-0042"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value.toUpperCase())}
                  onBlur={() => setTouched((t) => ({ ...t, employeeId: true }))}
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
              <p className="flex items-center justify-center gap-1.5 text-xs text-subtle">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Secure session · no passwords to remember
              </p>
            </form>

            <Divider label={COPY.login.demoTitle} spacing="lg" />

            <DemoAccounts
              accounts={demo.data?.accounts}
              loading={demo.isLoading}
              failed={demo.isError}
              busyId={typeof submitting === 'string' && submitting !== 'form' ? submitting : null}
              disabled={busy}
              onPick={pickDemo}
            />
          </div>
        </div>

        <footer className="flex flex-col items-center justify-between gap-2 px-5 py-5 text-xs text-subtle sm:flex-row sm:px-8">
          <span>© {year} {BRAND.legalName}. All rights reserved.</span>
          <span className="inline-flex items-center gap-1.5">
            <LogoMark size={14} title="" /> {BRAND.product} · {BRAND.city}
          </span>
        </footer>
      </section>
    </div>
  );
}

/* ───────────────────────────── pieces ───────────────────────────── */

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
    return <p className="text-center text-xs text-subtle">Demo accounts aren’t available right now — sign in with your own details above.</p>;
  }
  return (
    <ul className="grid gap-2">
      {accounts.map((acc) => {
        const isBusy = busyId === acc.employeeId;
        return (
          <li key={acc.employeeId}>
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
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-fg">{acc.label}</span>
                  <Badge size="sm" tone={ROLE_TONE[acc.role] ?? 'neutral'}>{ROLE_LABELS[acc.role as keyof typeof ROLE_LABELS] ?? acc.role}</Badge>
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

/** Decorative parallel-line field behind the brand panel: the mark, blown up and fading. */
function BrandBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="brand-wash absolute inset-0 opacity-90" />
      <svg className="absolute -right-24 -top-16 h-[140%] w-auto opacity-[0.16]" viewBox="0 0 400 600" fill="none" preserveAspectRatio="xMaxYMid slice">
        <g stroke="var(--primary)" strokeWidth="14" strokeLinecap="round" transform="translate(200 300) skewX(-14) translate(-200 -300)">
          {Array.from({ length: 11 }).map((_, i) => (
            <path key={i} d={`M${60 + i * 6} ${80 + i * 46}h${80 + i * 22}`} opacity={0.35 + (i % 4) * 0.18} />
          ))}
        </g>
      </svg>
      <div className="brand-lines absolute inset-x-0 bottom-0 h-72 opacity-50 [mask-image:linear-gradient(to_top,black,transparent)]" />
      <div className="absolute inset-0 bg-gradient-to-t from-ink via-transparent to-transparent" />
    </div>
  );
}
