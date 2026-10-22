// Release 1.3 — OWNED BY P2 invoices. The self-billing agreement: read it, and (field people who have not yet) accept
// it. Used by AgreementPrompt (loaded on demand from the app shell), Settings → Invoices, the invoice's Accept step and
// the admin's Settings → Company preview. Accepting records the version, the time and the IP (server).
import { CheckCircle2, FileSignature } from 'lucide-react';
import type { SelfBillingAgreement } from '@lm/shared';
import { Button, Modal, Skeleton, useToast } from '@/components/ui';
import { useAcceptAgreement, useAgreement } from '@/api/invoices';
import { ErrorState, errorMessage } from '@/features/common';
import { formatDate } from '@/lib/format';

export interface AgreementDialogProps {
  open: boolean;
  onClose: () => void;
  /** Show Accept when not accepted yet (false: read only, e.g. the admin's preview). */
  canAccept?: boolean;
  /** "Later" instead of "Close" (the first-time prompt). */
  laterLabel?: string;
  /** Called once accepted. */
  onAccepted?: (agreement: SelfBillingAgreement) => void;
  /** Extra line above the text, e.g. "Accept it before you accept your first invoice." */
  intro?: string;
}

export function AgreementDialog({ open, onClose, canAccept = true, laterLabel, onAccepted, intro }: AgreementDialogProps) {
  const q = useAgreement({ enabled: open });
  const accept = useAcceptAgreement();
  const toast = useToast();
  const a = q.data;
  const accepted = !!a?.acceptedAt;
  const doAccept = () =>
    accept.mutate(undefined, {
      onSuccess: (res) => {
        toast.success('Agreement accepted', `Version ${res.version}, ${formatDate(res.acceptedAt)}`);
        onAccepted?.(res);
        onClose();
      },
      onError: (e) => toast.error('Could not accept the agreement', errorMessage(e)),
    });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={a?.title ?? 'Self-billing agreement'}
      description={a ? `Version ${a.version}${accepted ? ` · you accepted it on ${formatDate(a.acceptedAt)}` : ''}` : undefined}
      icon={<FileSignature aria-hidden />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={accept.isPending}>{laterLabel ?? 'Close'}</Button>
          {canAccept && !accepted && (
            <Button onClick={doAccept} loading={accept.isPending} disabled={!a} leftIcon={<CheckCircle2 aria-hidden />}>Accept agreement</Button>
          )}
        </>
      }
    >
      {q.isLoading ? (
        <div className="space-y-2"><Skeleton /><Skeleton /><Skeleton className="w-2/3" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} className="p-4" />
      ) : a ? (
        <div className="space-y-3 text-sm leading-relaxed text-fg" data-agreement-text="">
          {intro && <p className="rounded-lg bg-info-soft p-3 text-info">{intro}</p>}
          {a.body.split('\n\n').map((para, i) => <p key={i}>{para}</p>)}
          {accepted && (
            <p className="flex items-center gap-2 text-success"><CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> You accepted this version on {formatDate(a.acceptedAt)}.</p>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

export default AgreementDialog;
