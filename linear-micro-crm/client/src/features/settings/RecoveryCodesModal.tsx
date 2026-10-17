// Settings → Security → "New recovery codes": prove a code, then reveal (once) the fresh set.
import { useId, useRef, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Field, Modal, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useRegenerateRecoveryCodes } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { apiMessage } from '@/features/common';
import { COPY } from '@/content/copy';
import { OneTimeCodeInput, isCompleteCode } from './OneTimeCodeInput';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

export interface RecoveryCodesModalProps {
  open: boolean;
  onClose: () => void;
}

export function RecoveryCodesModal({ open, onClose }: RecoveryCodesModalProps) {
  if (!open) return null;
  return <RegenerateFlow onClose={onClose} />;
}

function RegenerateFlow({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const uid = useId();
  const user = useCurrentUser();
  const regenerate = useRegenerateRecoveryCodes();
  const t = COPY.security.recovery;
  const l = COPY.security.login;

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isCompleteCode(code) || regenerate.isPending || locked) return;
    setError(null);
    try {
      const res = await regenerate.mutateAsync({ code });
      setCodes(res.recoveryCodes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setLocked(true);
        setError(apiMessage(err, l.tooMany));
        return;
      }
      setError(apiMessage(err, l.invalid));
      setCode('');
      requestAnimationFrame(() => codeRef.current?.focus());
    }
  }

  function finish() {
    toast.success(t.regeneratedToast, t.warning);
    onClose();
  }

  const revealed = codes !== null;
  const formId = `${uid}-regen`;
  return (
    <Modal
      open
      onClose={revealed ? () => undefined : onClose}
      persistent={revealed}
      hideClose={revealed}
      title={t.regenerateTitle}
      description={revealed ? COPY.security.setup.codesBody : t.regenerateBody}
      icon={<KeyRound aria-hidden />}
      tone={revealed ? 'success' : 'default'}
      size="md"
      footer={
        revealed ? (
          <Button onClick={finish} disabled={!saved}>{t.done}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={regenerate.isPending}>Cancel</Button>
            <Button type="submit" form={formId} loading={regenerate.isPending} disabled={locked || !isCompleteCode(code)}>{t.regenerate}</Button>
          </>
        )
      }
    >
      {revealed ? (
        <RecoveryCodesPanel codes={codes} email={user.email} saved={saved} onSavedChange={setSaved} />
      ) : (
        <form id={formId} onSubmit={(e) => void submit(e)} noValidate>
          <Field label={l.codeLabel} htmlFor={`${uid}-code`} error={error ?? undefined} hint={error ? undefined : l.codeHint} className="mx-auto max-w-xs">
            <OneTimeCodeInput
              ref={codeRef}
              id={`${uid}-code`}
              autoFocus
              value={code}
              onChange={(v) => { setCode(v); if (error && !locked) setError(null); }}
              disabled={locked || regenerate.isPending}
              invalid={!!error}
            />
          </Field>
        </form>
      )}
    </Modal>
  );
}
