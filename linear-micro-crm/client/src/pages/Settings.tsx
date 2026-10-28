import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, DatabaseBackup, Monitor, Moon, RefreshCw, ShieldCheck, Sun, TriangleAlert } from 'lucide-react';
import { BRAND, POSITION_LABELS, ROLE_LABELS } from '@lm/shared';
import clsx from 'clsx';
import { Avatar, Badge, Button, Card, CardHeader, PageHeader, Skeleton } from '@/components/ui';
import { api } from '@/api/client';
import { useHealth, type HealthInfo } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorBoundary, UserStatusBadge, errorMessage } from '@/features/common';
import { PinSettings } from '@/features/settings/PinSettings';
import { KeySafetySection } from '@/features/system/KeySafetySection';
// Release 1.3 slots: Settings → Invoices and Company (P2), Pay (P1), Integrations (P3), Learning videos (P5),
// Recruitment's question bank (P7). Each renders a whole card, or nothing.
import { CompanySettingsSection } from '@/features/invoices/CompanySettingsSection';
import { InvoiceSettingsSection } from '@/features/invoices/InvoiceSettingsSection';
import { PaySettingsSection } from '@/features/pay/PaySettingsSection';
import { QuestionBankSection } from '@/features/recruitment/QuestionBankSection';
import { IntegrationsSection } from '@/features/statements/IntegrationsSection';
import { VideoSettingsSection } from '@/features/videos/VideoSettingsSection';
import { TwoFactorSection } from '@/features/settings/TwoFactorSection';
// Release 1.4 (F): Bank details (every staff role, their own) and Settings → Payments (admin, loaded lazily).
import { BankDetailsCard } from '@/features/payments/BankDetailsCard';
import { LazyPaymentsSettingsSection } from '@/features/payments';
import { formatDate, formatDateTime, formatRelative, fullName, pluralise } from '@/lib/format';
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

          {/* Release 1.3 slots (nothing until the packages land) */}
          <ErrorBoundary name="settings-invoices" fallback={null}><InvoiceSettingsSection /></ErrorBoundary>
          {user.role !== 'client' && <ErrorBoundary name="settings-bank-details" fallback={null}><BankDetailsCard /></ErrorBoundary>}
          {(user.role === 'admin' || user.role === 'recruiter') && <ErrorBoundary name="settings-questions" fallback={null}><QuestionBankSection /></ErrorBoundary>}

          {user.role === 'admin' && <BackupsCard />}

          {user.role === 'admin' && (
            <>
              <ErrorBoundary name="settings-pay" fallback={null}><PaySettingsSection /></ErrorBoundary>
              <ErrorBoundary name="settings-company" fallback={null}><CompanySettingsSection /></ErrorBoundary>
              <ErrorBoundary name="settings-payments" fallback={null}><LazyPaymentsSettingsSection /></ErrorBoundary>
              <ErrorBoundary name="settings-integrations" fallback={null}><IntegrationsSection /></ErrorBoundary>
              <ErrorBoundary name="settings-videos" fallback={null}><VideoSettingsSection /></ErrorBoundary>
            </>
          )}
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

/**
 * Security section: the "Two-step verification" card (release 1.4: features/settings/TwoFactorSection, shared with the
 * client portal; required for every account but the demo sign-in ones) and the PIN and sign-in rules.
 */
function SecurityCard() {
  const t = COPY.security;
  return (
    <Card>
      <CardHeader title={t.title} description={t.description} icon={<ShieldCheck aria-hidden />} />

      <TwoFactorSection />

      {/* Release 1.2 slot (U1): your PIN and (admin) the sign-in settings; nothing until the package lands. */}
      <ErrorBoundary name="pin-settings" fallback={null}>
        <PinSettings className="mt-4" />
      </ErrorBoundary>
    </Card>
  );
}

/* ───────────────────────────── Backups (admin) ───────────────────────────── */

/** Settings and `npm run doctor` warn past this many hours without a backup (server: BACKUP_RULES.staleHours). */
const BACKUP_STALE_HOURS = 36;
const ICLOUD_LINE = 'Copy this folder to iCloud or Drive — a backup on the same laptop does not survive losing it.';

/** `backup` from GET /health; `enabled` is false when the server runs with LM_BACKUP=0 (no nightly schedule). */
type BackupInfo = NonNullable<HealthInfo['backup']> & { enabled?: boolean };


function hoursSince(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : Number.POSITIVE_INFINITY;
}

/**
 * Smart release 1.1 (p10): the backup status from GET /health, which carries `backup` for administrators only. Its own
 * query (not useHealth, which is cached forever) so the card is fresh whenever Settings is opened.
 */
function BackupsCard() {
  const q = useQuery({ queryKey: ['settings', 'backups'], queryFn: () => api<HealthInfo>('/health'), staleTime: 60_000 });
  const cardRef = useRef<HTMLDivElement>(null);
  // /settings#backups (the Needs-attention bell's system-health items) scrolls here once the card is on the page
  useEffect(() => {
    if (window.location.hash === '#backups') cardRef.current?.scrollIntoView({ block: 'start' });
  }, []);
  const [copied, setCopied] = useState(false);
  const b = q.data?.backup as BackupInfo | undefined;
  const age = hoursSince(b?.lastAt);
  // a fresh install has no backup for its first minutes: only warn once it has been running for 36 h without one
  const stale = !!b && (b.lastAt ? age > BACKUP_STALE_HOURS : hoursSince(q.data?.seededAt) > BACKUP_STALE_HOURS);
  // started with LM_BACKUP=0: nothing runs by itself, so promise nothing (the docs say how to switch it back on)
  const off = b?.enabled === false;
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext;

  const copyPath = async () => {
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dir);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div id="backups" ref={cardRef} className="scroll-mt-20">
    <Card data-testid="backups-card">
      <CardHeader
        title="Backups"
        description={off ? 'Automatic backups are off on this server.' : 'A copy of the database and the uploaded files every night while Linear Hub runs.'}
        icon={<DatabaseBackup aria-hidden />}
        actions={
          off ? <Badge tone="warning" dot>Off</Badge> : b && !stale && b.lastAt ? <Badge tone="success" dot>Up to date</Badge> : undefined
        }
      />

      {q.isLoading ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : q.isError ? (
        <p className="inline-flex flex-wrap items-center gap-2 text-sm text-danger">
          {errorMessage(q.error, 'Could not load the backup status')}
          <Button variant="outline" size="md" onClick={() => void q.refetch()} leftIcon={<RefreshCw aria-hidden />}>Try again</Button>
        </p>
      ) : !b ? (
        <p className="text-sm text-muted">This server does not report backups. Update Linear Hub to 1.1 or later.</p>
      ) : (
        <>
          {(stale || off) && (
            <div
              role={stale ? 'alert' : 'status'}
              className="mb-4 flex gap-3 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-fg"
              data-testid={off ? 'backups-off' : 'backups-warning'}
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium text-warning">
                  {off
                    ? 'Automatic backups are off'
                    : b.lastAt
                      ? `No backup for ${age >= 48 ? `${Math.floor(age / 24)} days` : `${Math.round(age)} hours`}`
                      : 'No backup yet'}
                </p>
                {off ? (
                  <p className="mt-1 text-muted">
                    This server makes no nightly copies{b.lastAt ? `; the last one was made ${formatRelative(b.lastAt)}` : ''}. Ask Noryn to
                    switch them back on, or to make one now.
                  </p>
                ) : (
                  <p className="mt-1 text-muted">
                    Backups only run while Linear Hub is running. Leave the server computer on overnight, or ask Noryn to make one now.
                  </p>
                )}
                {stale && <p className="mt-1 text-muted">{ICLOUD_LINE}</p>}
              </div>
            </div>
          )}

          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="flex flex-col border-b border-border pb-2">
              <dt className="text-xs font-medium text-muted">Last backup</dt>
              <dd className="text-sm text-fg" data-testid="backups-last">
                {b.lastAt ? (
                  <>
                    <span className="font-medium">{formatRelative(b.lastAt)}</span>
                    <span className="text-muted"> · {formatDateTime(b.lastAt)}</span>
                  </>
                ) : off ? (
                  'None yet — ask Noryn to make one'
                ) : (
                  'None yet — the first runs 10 minutes after the server starts'
                )}
              </dd>
            </div>
            <div className="flex flex-col border-b border-border pb-2">
              <dt className="text-xs font-medium text-muted">Kept</dt>
              <dd className="text-sm text-fg">{pluralise(b.count, 'backup')}</dd>
              <dd className="text-xs text-muted">One a day for 30 days, then one a week for 8 weeks</dd>
            </div>
            {b.file && (
              <div className="flex min-w-0 flex-col border-b border-border pb-2 sm:col-span-2">
                <dt className="text-xs font-medium text-muted">Latest file</dt>
                <dd className="break-all font-mono text-xs text-fg">{b.file}</dd>
              </div>
            )}
            <div className="flex min-w-0 flex-col border-b border-border pb-2 sm:col-span-2">
              <dt className="text-xs font-medium text-muted">Folder on the server laptop</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg" data-testid="backups-dir">{b.dir}</span>
                {canCopy && (
                  <Button variant="outline" size="md" onClick={() => void copyPath()} leftIcon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}>
                    {copied ? 'Copied' : 'Copy path'}
                  </Button>
                )}
              </dd>
            </div>
          </dl>

          {!stale && <p className="mt-3 text-xs text-muted">{ICLOUD_LINE}</p>}
          <p className="mt-2 text-xs text-muted">
            To go back to a backup, ask Noryn. Linear Hub keeps today's data aside first, and checks for payments the backup does not have.
          </p>
        </>
      )}
      <ErrorBoundary name="key-safety" fallback={null}>
        <KeySafetySection />
      </ErrorBoundary>
    </Card>
    </div>
  );
}
