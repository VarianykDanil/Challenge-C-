// Release 1.4 — OWNED BY package S (security). The "Two-step verification" section: status (on since, recovery codes
// left), Set up / New recovery codes / Turn off, and their modals. Used by Settings → Security (staff) and the client
// portal's Security page (client accounts), so both show the same thing in their own words. Two-step verification is
// required for every account except the demo sign-in accounts (GET /auth/2fa `required`): then there is no Turn off,
// only a line saying who can reset it after a lost phone.
import { useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import clsx from 'clsx';
import { useTwoFactorStatus } from '@/api/hooks';
import { Badge, Button, Skeleton } from '@/components/ui';
import { errorMessage } from '@/features/common/QueryStates';
import { COPY } from '@/content/copy';
import { formatDate, pluralise } from '@/lib/format';
import { RecoveryCodesModal } from './RecoveryCodesModal';
import { TwoFactorDisableModal } from './TwoFactorDisableModal';
import { TwoFactorSetupModal } from './TwoFactorSetupModal';

type SecurityModal = null | 'setup' | 'disable' | 'codes';

export interface TwoFactorSectionProps {
  /** Whose words: staff (employee ID, an administrator resets it) or a client account (access code, Linear MCR). */
  audience?: 'staff' | 'client';
  /** Headed as a card's own title (the client portal) rather than a sub-section (Settings). */
  asCard?: boolean;
  className?: string;
}

export function TwoFactorSection({ audience = 'staff', asCard = false, className }: TwoFactorSectionProps) {
  const t = COPY.security;
  const words = audience === 'client' ? t.twoFactor.client : t.twoFactor.staff;
  const status = useTwoFactorStatus();
  const [modal, setModal] = useState<SecurityModal>(null);
  const s = status.data;
  const close = () => setModal(null);
  const Heading = asCard ? 'h2' : 'h4';

  return (
    <section
      aria-labelledby="two-factor-title"
      data-testid="two-factor-card"
      className={clsx(!asCard && 'rounded-xl border border-border p-4', className)}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Heading id="two-factor-title" className={clsx('font-sans font-semibold tracking-normal text-fg', asCard ? 'text-base' : 'text-sm')}>
              {t.twoFactor.title}
            </Heading>
            {status.isLoading ? (
              <Skeleton className="h-5 w-12 rounded-full" />
            ) : s ? (
              <Badge tone={s.enabled ? 'success' : 'neutral'} dot={s.enabled} data-testid="two-factor-badge">
                {s.enabled ? t.twoFactor.on : t.twoFactor.off}
              </Badge>
            ) : null}
            {s?.required && <Badge tone="info" size="sm" data-testid="two-factor-required">{t.twoFactor.required}</Badge>}
          </div>

          <p className="mt-1 text-sm text-muted" data-testid="two-factor-status">
            {status.isLoading ? (
              <Skeleton className="h-3.5 w-64" />
            ) : status.isError ? (
              <span className="inline-flex flex-wrap items-center gap-2 text-danger">
                {errorMessage(status.error, 'Could not load the status')}
                <Button variant="outline" size="sm" onClick={() => void status.refetch()} leftIcon={<RefreshCw aria-hidden />}>Try again</Button>
              </span>
            ) : s?.enabled ? (
              <>
                On since <span className="font-medium text-fg">{formatDate(s.enabledAt)}</span>
                <span aria-hidden> · </span>
                <span className={clsx(s.recoveryCodesLeft <= 2 && 'font-medium text-warning')}>{pluralise(s.recoveryCodesLeft, 'recovery code')} left</span>
              </>
            ) : (
              words.offHint
            )}
          </p>

          {s?.enabled && s.recoveryCodesLeft <= 2 && <p className="mt-1.5 text-xs text-warning">{t.twoFactor.lowCodesHint}</p>}
          {s && !s.enabled && s.pendingSetup && <p className="mt-1.5 text-xs text-muted">{t.twoFactor.pendingHint}</p>}
          {s?.required && s.enabled && <p className="mt-1.5 text-xs text-muted" data-testid="two-factor-required-hint">{words.requiredHint}</p>}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {s?.enabled ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setModal('codes')} leftIcon={<KeyRound aria-hidden />}>{t.twoFactor.newCodes}</Button>
              {!s.required && (
                <Button variant="outline" size="sm" onClick={() => setModal('disable')} leftIcon={<ShieldOff aria-hidden />}>{t.twoFactor.turnOff}</Button>
              )}
            </>
          ) : (
            <Button size="sm" onClick={() => setModal('setup')} disabled={!s} leftIcon={<ShieldCheck aria-hidden />}>{t.twoFactor.setUp}</Button>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{words.description}</p>

      <TwoFactorSetupModal open={modal === 'setup'} onClose={close} />
      <TwoFactorDisableModal open={modal === 'disable'} onClose={close} />
      <RecoveryCodesModal open={modal === 'codes'} onClose={close} />
    </section>
  );
}
