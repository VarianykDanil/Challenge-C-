import { Monitor, Moon, Sun } from 'lucide-react';
import { BRAND, POSITION_LABELS, ROLE_LABELS } from '@lm/shared';
import clsx from 'clsx';
import { Avatar, Badge, Card, CardHeader, PageHeader } from '@/components/ui';
import { useHealth } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { UserStatusBadge } from '@/features/common';
import { formatDate, formatDateTime, fullName } from '@/lib/format';
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
        <Card className="lg:col-span-2">
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

        <div className="space-y-6">
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
