// Settings → Security → "Set up": scan the QR, prove a code, save the recovery codes.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { Button, Field, Modal, Skeleton, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useEnableTwoFactor, useStartTwoFactorSetup } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { apiMessage, errorMessage } from '@/features/common';
import { COPY } from '@/content/copy';
import { ACCESS_MESSAGES } from '@lm/shared';
import { copyToClipboard } from '@/lib/files';
import { OneTimeCodeInput, isCompleteCode } from './OneTimeCodeInput';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

type Step = 'scan' | 'verify' | 'codes';
const STEP_INDEX: Record<Step, number> = { scan: 0, verify: 1, codes: 2 };

export interface TwoFactorSetupModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The flow lives in an inner component that mounts fresh on every open, so closing half-way and reopening
 * starts again from a clean state and a new pending secret (the server replaces the previous one).
 */
export function TwoFactorSetupModal({ open, onClose }: TwoFactorSetupModalProps) {
  if (!open) return null;
  return <SetupFlow onClose={onClose} />;
}

function SetupFlow({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const user = useCurrentUser();
  const uid = useId();
  const setup = useStartTwoFactorSetup();
  const enable = useEnableTwoFactor();
  const t = COPY.security.setup;

  const [step, setStep] = useState<Step>('scan');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  // over an insecure connection from another device the server does not send the recovery codes (they make new ones
  // later on a secure connection)
  const [withheld, setWithheld] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // Ask for a fresh pending secret as soon as the modal opens. `mutate` is referentially stable.
  const start = setup.mutate;
  useEffect(() => {
    start();
  }, [start]);

  async function copyKey(secret: string) {
    const ok = await copyToClipboard(secret);
    if (ok) {
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2_000);
    } else {
      toast.error('Could not copy', 'Select the key and copy it yourself.');
    }
  }

  async function verify(candidate = code) {
    if (!isCompleteCode(candidate) || enable.isPending || locked) return;
    setCodeError(null);
    try {
      const res = await enable.mutateAsync({ code: candidate });
      setCodes(res.recoveryCodes);
      setWithheld(res.recoveryCodesWithheld ? (res.message ?? ACCESS_MESSAGES.recoveryCodesWithheld) : null);
      setStep('codes');
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setLocked(true);
        setCodeError(apiMessage(e, COPY.security.login.tooMany));
        return;
      }
      if (e instanceof ApiError && e.status === 409) {
        // Nothing pending any more (another tab finished or the secret was replaced): start over with a new code.
        setStep('scan');
        setCode('');
        setCodeError(null);
        toast.warning('Let’s start again', 'That setup code is no longer valid — scan the new one.');
        start();
        return;
      }
      setCodeError(apiMessage(e, COPY.security.login.invalid));
      setCode('');
      requestAnimationFrame(() => codeRef.current?.focus());
    }
  }

  function onVerifySubmit(e: FormEvent) {
    e.preventDefault();
    void verify();
  }

  function finish() {
    toast.success(t.enabledToast, t.enabledToastBody);
    onClose();
  }

  const formId = `${uid}-verify`;
  const footer =
    step === 'scan' ? (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => setStep('verify')} disabled={!setup.data}>Next</Button>
      </>
    ) : step === 'verify' ? (
      <>
        <Button variant="ghost" onClick={() => { setStep('scan'); setCodeError(null); }} disabled={enable.isPending}>Back</Button>
        <Button type="submit" form={formId} loading={enable.isPending} disabled={locked || !isCompleteCode(code)}>{t.turnOn}</Button>
      </>
    ) : (
      <Button onClick={finish} disabled={!saved && !withheld}>{COPY.security.recovery.done}</Button>
    );

  return (
    <Modal
      open
      // Once the codes are on screen there is no way out but "Done": they are shown exactly once.
      onClose={step === 'codes' ? () => undefined : onClose}
      persistent={step === 'codes'}
      hideClose={step === 'codes'}
      title={t.title}
      icon={<ShieldCheck aria-hidden />}
      tone={step === 'codes' ? 'success' : 'default'}
      size="lg"
      footer={footer}
    >
      <StepIndicator current={STEP_INDEX[step]} />

      {step === 'scan' && (
        <div className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="mx-auto sm:mx-0">
            {setup.isPending && <Skeleton className="h-[196px] w-[196px] rounded-xl" />}
            {setup.isError && (
              <div className="flex h-[196px] w-[196px] flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger-soft p-4 text-center text-xs text-fg">
                <span>{errorMessage(setup.error, 'Could not start setup')}</span>
                <Button size="sm" variant="outline" onClick={() => start()}>Try again</Button>
              </div>
            )}
            {setup.data && (
              <div
                data-testid="totp-qr"
                role="img"
                aria-label="QR code to scan with your authenticator app"
                // White on purpose (not a theme token): scanners need dark modules on a light background in both themes.
                // The markup is our own API's SVG of the otpauth URL; nothing user-supplied is rendered here.
                className="rounded-xl border border-border bg-white p-3 shadow-card [&_svg]:block [&_svg]:h-[172px] [&_svg]:w-[172px]"
                dangerouslySetInnerHTML={{ __html: setup.data.qrSvg }}
              />
            )}
          </div>

          <div className="min-w-0 space-y-5 text-sm">
            <div>
              <h4 className="font-sans text-sm font-semibold tracking-normal text-fg">{t.scanTitle}</h4>
              <p className="mt-1 leading-relaxed text-muted">{t.scanBody}</p>
            </div>
            <div>
              <h4 className="font-sans text-sm font-semibold tracking-normal text-fg">{t.manualTitle}</h4>
              <p className="mt-1 leading-relaxed text-muted">{t.manualBody}</p>
              <div className="mt-2 flex items-stretch gap-2">
                <code
                  data-testid="totp-secret"
                  aria-label="Setup key"
                  className="min-w-0 flex-1 select-all break-words rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm tracking-[0.08em] text-fg"
                >
                  {setup.data ? groupKey(setup.data.secret) : <Skeleton className="h-4 w-full" />}
                </code>
                <Button
                  variant="outline"
                  onClick={() => setup.data && void copyKey(setup.data.secret)}
                  disabled={!setup.data}
                  leftIcon={keyCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  className="shrink-0"
                >
                  {keyCopied ? 'Copied' : t.copyKey}
                </Button>
              </div>
              {setup.data && (
                <a
                  href={setup.data.otpauthUrl}
                  className="focus-ring mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {t.openInApp}
                </a>
              )}
            </div>
            <p className="text-xs text-muted">{COPY.security.twoFactor.apps}</p>
          </div>
        </div>
      )}

      {step === 'verify' && (
        <form id={formId} onSubmit={onVerifySubmit} noValidate className="space-y-5">
          <div>
            <h4 className="font-sans text-sm font-semibold tracking-normal text-fg">{t.verifyTitle}</h4>
            <p className="mt-1 text-sm leading-relaxed text-muted">{t.verifyBody}</p>
          </div>
          <Field label={COPY.security.login.codeLabel} htmlFor={`${uid}-code`} error={codeError ?? undefined} hint={codeError ? undefined : COPY.security.login.codeHint} className="mx-auto max-w-xs">
            <OneTimeCodeInput
              ref={codeRef}
              id={`${uid}-code`}
              autoFocus
              value={code}
              onChange={(v) => { setCode(v); if (codeError && !locked) setCodeError(null); }}
              onComplete={(c) => void verify(c)}
              disabled={locked || enable.isPending}
              invalid={!!codeError}
            />
          </Field>
        </form>
      )}

      {step === 'codes' && (
        <div className="space-y-4">
          <div>
            <h4 className="font-sans text-sm font-semibold tracking-normal text-fg">{t.codesTitle}</h4>
            <p className="mt-1 text-sm leading-relaxed text-muted">{t.codesBody}</p>
          </div>
          {withheld ? (
            <p role="status" className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-fg" data-testid="recovery-codes-withheld">{withheld}</p>
          ) : (
            <RecoveryCodesPanel codes={codes} email={user.email} saved={saved} onSavedChange={setSaved} />
          )}
        </div>
      )}
    </Modal>
  );
}

/** "1 Scan — 2 Verify — 3 Save codes" progress strip. */
export function StepIndicator({ current, labels = COPY.security.setup.steps }: { current: number; labels?: readonly string[] }) {
  return (
    <ol className="mb-5 flex items-center gap-2 text-xs" aria-label="Setup progress">
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className={clsx('flex items-center gap-2', i < labels.length - 1 && 'flex-1')} aria-current={active ? 'step' : undefined}>
            <span
              className={clsx(
                'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular',
                done && 'bg-success text-status-fg',
                active && 'bg-primary text-primary-fg',
                !done && !active && 'bg-surface-2 text-muted ring-1 ring-inset ring-border',
              )}
              aria-hidden
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={clsx('whitespace-nowrap font-medium', active ? 'text-fg' : 'text-muted')}>
              <span className="sr-only">Step {i + 1}{done ? ', done' : active ? ', current' : ''}: </span>
              {label}
            </span>
            {i < labels.length - 1 && <span className="h-px min-w-3 flex-1 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/** "JBSW Y3DP EHPK 3PXP" — a base32 key is far easier to type in groups of four. */
function groupKey(secret: string): string {
  return secret.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? secret;
}
