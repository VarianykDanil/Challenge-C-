import { useState } from 'react';
import { KeyRound, Monitor, Moon, RefreshCw, ShieldCheck, ShieldOff, Sun } from 'lucide-react';
import { BRAND, POSITION_LABELS, ROLE_LABELS } from '@lm/shared';
import clsx from 'clsx';
import { Avatar, Badge, Button, Card, CardHeader, PageHeader, Skeleton } from '@/components/ui';
import { useHealth, useTwoFactorStatus } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { UserStatusBadge, errorMessage } from '@/features/common';
import { RecoveryCodesModal, TwoFactorDisableModal, TwoFactorSetupModal } from '@/features/settings';
import { formatDate, formatDateTime, fullName, pluralise } from '@/lib/format';
import { useTheme, type Theme } from '@/components/layout';
import { usePageTitle } from '@/lib/usePageTitle';
import { COPY } from '@/content/copy';

const THEMES: { value: Theme; label: string; description: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', description: 'Bright surfaces, best outdoors', icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Easier on the eyes at night', icon: Moon },
  { value: 'system', label: 'System', description: 'Follow your device setting', icon: Monitor },
];

export function SettingsPage() {
  usePageTitle(COPY.nav.settings.title);
  const user = useCurrentUser();
  const { theme, setTheme } = useTheme();
  const health = useHealth();

  const rows: { label: string; value: string }[] = [
    { label: 'Employee ID', value: user.employeeId },
    { label: 'Email', value: user.email },
    { label: 'Phone', value: user.phone ?? '—' },
    { label: 'Position', value: POSITION_LABELS[user.position] },
    { label: 'Role', value: ROLE_LABELS[user.role] },
    { label: 'Team', value: user.teamName ?? 'No team' },
    { label: 'Pay plan', value: user.payPlanName },
    { label: 'Start date', value: formatDate(user.startDate) },
    { label: 'City', value: user.city ?? '—' },
  ];

  return (
    <>
      <PageHeader title={COPY.nav.settings.title} description={COPY.nav.settings.description} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Profile" description="Details are managed by the office — ask an administrator to change them." />
            <div className="mb-5 flex items-center gap-4">
              <Avatar name={fullName(user)} color={user.avatarColor} size="xl" />
              <div>
                <div className="text-lg font-semibold text-fg">{fullName(user)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <Badge tone="primary">{POSITION_LABELS[user.position]}</Badge>
                  <UserStatusBadge status={user.status} />
                </div>
              </div>
            </div>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {rows.map((r) => (
                <div key={r.label} className="flex flex-col border-b border-border pb-2">
                  <dt className="text-xs font-medium text-muted">{r.label}</dt>
                  <dd className="text-sm text-fg">{r.value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <SecurityCard />
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Appearance" description="Theme is saved on this device." />
            <div role="radiogroup" aria-label="Theme" className="grid gap-2">
              {THEMES.map((t) => {
                const Icon = t.icon;
                const active = theme === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTheme(t.value)}
                    className={clsx('flex items-center gap-3 rounded-lg border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-2')}
                  >
                    <Icon className={clsx('h-5 w-5', active ? 'text-primary' : 'text-muted')} aria-hidden />
                    <span>
                      <span className="block text-sm font-medium text-fg">{t.label}</span>
                      <span className="block text-xs text-muted">{t.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader title="About this app" />
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4"><dt className="text-muted">Product</dt><dd className="text-fg">{BRAND.product}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Company</dt><dd className="text-right text-fg">{BRAND.legalName}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Version</dt><dd className="text-fg">{health.data?.version ?? (health.isLoading ? '…' : '—')}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Demo data seeded</dt><dd className="text-right text-fg">{health.data ? formatDateTime(health.data.seededAt) : '—'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Website</dt><dd><a className="text-primary hover:underline" href={BRAND.website} target="_blank" rel="noreferrer">{BRAND.website.replace('https://', '')}</a></dd></div>
            </dl>
            <p className="mt-3 text-xs text-muted">{BRAND.tagline}</p>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────────── Security ───────────────────────────── */

type SecurityModal = null | 'setup' | 'disable' | 'codes';

/** Security section: the "Two-step verification" card with its status and the three actions. */
function SecurityCard() {
  const t = COPY.security;
  const status = useTwoFactorStatus();
  const [modal, setModal] = useState<SecurityModal>(null);
  const s = status.data;
  const close = () => setModal(null);

  return (
    <Card>
      <CardHeader title={t.title} description={t.description} icon={<ShieldCheck aria-hidden />} />

      <section aria-labelledby="two-factor-title" data-testid="two-factor-card" className="rounded-xl border border-border p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 id="two-factor-title" className="font-sans text-sm font-semibold tracking-normal text-fg">{t.twoFactor.title}</h4>
              {status.isLoading ? (
                <Skeleton className="h-5 w-12 rounded-full" />
              ) : s ? (
                <Badge tone={s.enabled ? 'success' : 'neutral'} dot={s.enabled} data-testid="two-factor-badge">
                  {s.enabled ? t.twoFactor.on : t.twoFactor.off}
                </Badge>
              ) : null}
            </div>

            <p className="mt-1 text-sm text-muted" data-testid="two-factor-status">
              {status.isLoading ? (
                <Skeleton className="h-3.5 w-64" />
              ) : status.isError ? (
                <span className="inline-flex flex-wrap items-center gap-2 text-danger">
                  {errorMessage(status.error, 'Could not load the status')}
                  <Button variant="outline" size="xs" onClick={() => void status.refetch()} leftIcon={<RefreshCw aria-hidden />}>Try again</Button>
                </span>
              ) : s?.enabled ? (
                <>
                  On since <span className="font-medium text-fg">{formatDate(s.enabledAt)}</span>
                  <span aria-hidden> · </span>
                  <span className={clsx(s.recoveryCodesLeft <= 2 && 'font-medium text-warning')}>{pluralise(s.recoveryCodesLeft, 'recovery code')} left</span>
                </>
              ) : (
                t.twoFactor.offHint
              )}
            </p>

            {s?.enabled && s.recoveryCodesLeft <= 2 && <p className="mt-1.5 text-xs text-warning">{t.twoFactor.lowCodesHint}</p>}
            {s && !s.enabled && s.pendingSetup && <p className="mt-1.5 text-xs text-muted">{t.twoFactor.pendingHint}</p>}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {s?.enabled ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setModal('codes')} leftIcon={<KeyRound aria-hidden />}>{t.twoFactor.newCodes}</Button>
                <Button variant="outline" size="sm" onClick={() => setModal('disable')} leftIcon={<ShieldOff aria-hidden />}>{t.twoFactor.turnOff}</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setModal('setup')} disabled={!s} leftIcon={<ShieldCheck aria-hidden />}>{t.twoFactor.setUp}</Button>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">{t.twoFactor.description}</p>
      </section>

      <TwoFactorSetupModal open={modal === 'setup'} onClose={close} />
      <TwoFactorDisableModal open={modal === 'disable'} onClose={close} />
      <RecoveryCodesModal open={modal === 'codes'} onClose={close} />
    </Card>
  );
}
