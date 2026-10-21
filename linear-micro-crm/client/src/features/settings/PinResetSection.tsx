// Release 1.2 — OWNED BY U1 sign-in-pin. Team > edit person (admin, someone else): the person's PIN state and
// "Reset PIN" (POST /auth/pin/reset/:userId). Mounted in features/team/UserFormModal.tsx under the two-step reset, in an
// ErrorBoundary with fallback={null}. Renders nothing for anyone but an administrator, or for your own row (your PIN
// lives in Settings → Security).
import { useId, useState } from 'react';
import { KeyRound, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import type { UserWithTeam } from '@lm/shared';
import { useResetUserPin, useUserPinStatus } from '@/api/pin';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Skeleton, useToast } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { errorMessage } from '@/features/common/QueryStates';
import { formatDate, fullName } from '@/lib/format';
import { PIN_COPY, pinUnlockTime } from './pinCopy';

export interface PinResetSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function PinResetSection({ user, className }: PinResetSectionProps) {
  const me = useCurrentUser();
  if (me.role !== 'admin' || me.id === user.id) return null;
  return <PinResetCard user={user} className={className} />;
}

function PinResetCard({ user, className }: PinResetSectionProps) {
  const t = PIN_COPY.admin;
  const uid = useId();
  const toast = useToast();
  const status = useUserPinStatus(user.id);
  const reset = useResetUserPin(user.id);
  const [confirm, setConfirm] = useState(false);
  const s = status.data;

  async function onConfirm() {
    try {
      await reset.mutateAsync();
      toast.success(t.toast, fullName(user));
      setConfirm(false);
    } catch (err) {
      toast.error('Could not reset', errorMessage(err));
    }
  }

  return (
    <section aria-labelledby={`${uid}-pin`} data-testid="admin-pin" className={clsx('rounded-xl border border-border bg-surface-2/50 p-4', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted" aria-hidden />
            <h4 id={`${uid}-pin`} className="font-sans text-sm font-semibold tracking-normal text-fg">{t.title}</h4>
            {status.isLoading ? (
              <Skeleton className="h-5 w-14 rounded-full" />
            ) : s ? (
              <Badge tone={s.locked ? 'danger' : s.hasPin ? 'success' : 'neutral'} dot={s.hasPin && !s.locked} size="sm" data-testid="admin-pin-badge">
                {s.locked ? t.locked : s.hasPin ? t.set : t.none}
              </Badge>
            ) : null}
            {s?.locked && s.lockedUntil ? (
              <span className="text-xs text-muted" data-testid="admin-pin-locked-until">{t.lockedUntil(pinUnlockTime(s.lockedUntil))}</span>
            ) : (
              s?.hasPin && s.setAt && <span className="text-xs text-muted">since {formatDate(s.setAt)}</span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t.body}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => setConfirm(true)}
          disabled={!s || (!s.hasPin && !s.locked)}
          leftIcon={<RotateCcw aria-hidden />}
        >
          {t.reset}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void onConfirm()}
        tone="danger"
        title={t.confirmTitle}
        description={`${fullName(user)} ${t.confirmBody}`}
        confirmLabel={t.reset}
        loading={reset.isPending}
      />
    </section>
  );
}
