// Settings → Security → "Turn off": confirm with a current code or an unused recovery code.
import { useId, useState, type FormEvent } from 'react';
import { ShieldOff } from 'lucide-react';
import { Button, Field, Modal, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useDisableTwoFactor } from '@/api/hooks';
import { apiMessage } from '@/features/common';
import { COPY } from '@/content/copy';
import { OneTimeCodeInput, RECOVERY_CODE_RE, RecoveryCodeInput, isCompleteCode } from './OneTimeCodeInput';

export interface TwoFactorDisableModalProps {
  open: boolean;
  onClose: () => void;
}

export function TwoFactorDisableModal({ open, onClose }: TwoFactorDisableModalProps) {
  if (!open) return null;
  return <DisableFlow onClose={onClose} />;
}

function DisableFlow({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const uid = useId();
  const disable = useDisableTwoFactor();
  const t = COPY.security.disable;
  const l = COPY.security.login;

  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const canSubmit = mode === 'code' ? isCompleteCode(code) : RECOVERY_CODE_RE.test(recoveryCode);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || disable.isPending || locked) return;
    setError(null);
    try {
      await disable.mutateAsync(mode === 'code' ? { code } : { recoveryCode });
      toast.success(t.toast, t.toastBody);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setLocked(true);
        setError(apiMessage(err, l.tooMany));
        return;
      }
      setError(apiMessage(err, l.invalid));
      setCode('');
      setRecoveryCode('');
    }
  }

  function switchMode() {
    setMode((m) => (m === 'code' ? 'recovery' : 'code'));
    setError(null);
    setCode('');
    setRecoveryCode('');
  }

  const formId = `${uid}-disable`;
  return (
    <Modal
      open
      onClose={onClose}
      title={t.title}
      description={mode === 'code' ? t.body : t.bodyRecovery}
      icon={<ShieldOff aria-hidden />}
      tone="danger"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={disable.isPending}>Cancel</Button>
          <Button type="submit" form={formId} variant="danger" loading={disable.isPending} disabled={!canSubmit || locked}>{t.confirm}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        {mode === 'code' ? (
          <Field label={l.codeLabel} htmlFor={`${uid}-code`} error={error ?? undefined} hint={error ? undefined : l.codeHint}>
            <OneTimeCodeInput
              id={`${uid}-code`}
              autoFocus
              value={code}
              onChange={(v) => { setCode(v); if (error && !locked) setError(null); }}
              disabled={locked || disable.isPending}
              invalid={!!error}
            />
          </Field>
        ) : (
          <Field label={l.recoveryLabel} htmlFor={`${uid}-recovery`} error={error ?? undefined} hint={error ? undefined : l.recoveryHint}>
            <RecoveryCodeInput
              id={`${uid}-recovery`}
              autoFocus
              value={recoveryCode}
              onChange={(v) => { setRecoveryCode(v); if (error && !locked) setError(null); }}
              disabled={locked || disable.isPending}
              invalid={!!error}
            />
          </Field>
        )}
        <Button type="button" variant="link" size="sm" onClick={switchMode} disabled={disable.isPending}>
          {mode === 'code' ? l.useRecovery : l.useApp}
        </Button>
      </form>
    </Modal>
  );
}
