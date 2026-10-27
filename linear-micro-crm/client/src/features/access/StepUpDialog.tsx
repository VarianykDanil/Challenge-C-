// A sensitive administrator action (make an administrator, change a sign-in email, reset someone's two-step or PIN,
// give a setup code) asks for the admin's own fresh code from their authenticator app. The server's refusal is shown
// as it comes: a wrong code, two-step not set up yet, a demo account during the trial, an insecure connection.
import { useState, type ReactNode } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { Button, Field, Modal } from '@/components/ui';
import { OneTimeCodeInput, isCompleteCode } from '@/features/settings/OneTimeCodeInput';

export const STEP_UP_COPY = {
  label: 'Your two-step code',
  hint: 'The 6-digit code from your authenticator app. Each code works once.',
} as const;

/** The code field on its own, for forms that send it with their own Save (Add person, Edit profile). */
export function StepUpCodeField({ id, value, onChange, why, error }: { id: string; value: string; onChange: (v: string) => void; why: string; error?: string }) {
  return (
    <Field label={STEP_UP_COPY.label} htmlFor={id} hint={error ? undefined : `${why} ${STEP_UP_COPY.hint}`} error={error}>
      <OneTimeCodeInput id={id} name="stepUpCode" value={value} onChange={onChange} size="md" invalid={!!error} />
    </Field>
  );
}

export interface StepUpDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  /** The server's answer to the last try (shown in the dialog, beside its buttons). */
  error?: string | null;
  onConfirm: (code: string) => void;
}

export function StepUpDialog({ open, onClose, title, description, confirmLabel, tone = 'danger', busy, error, onConfirm }: StepUpDialogProps) {
  const [code, setCode] = useState('');
  if (!open) return null;
  const submit = (c = code) => {
    if (!isCompleteCode(c) || busy) return;
    onConfirm(c);
    setCode('');
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      tone={tone === 'danger' ? 'danger' : 'default'}
      icon={tone === 'danger' ? <AlertTriangle aria-hidden /> : <ShieldCheck aria-hidden />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={tone} onClick={() => submit()} loading={busy} disabled={!isCompleteCode(code)} data-testid="step-up-confirm">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <Field label={STEP_UP_COPY.label} htmlFor="step-up-code" hint={STEP_UP_COPY.hint}>
          <OneTimeCodeInput id="step-up-code" name="stepUpCode" autoFocus value={code} onChange={setCode} onComplete={(c) => submit(c)} disabled={busy} invalid={!!error} />
        </Field>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger" data-testid="step-up-error">{error}</p>
        )}
      </form>
    </Modal>
  );
}
