// Release 1.3 slot — OWNED BY P2 invoices. Settings → Invoices for the field people (reps, leaders): the self-billing
// agreement (read it; accept it once) and the supplier details printed on their invoices (address, postcode, UTR,
// VAT number). Mounted in pages/Settings.tsx in the left column after the Security card, for every staff role, in an
// ErrorBoundary with fallback={null}. A whole Card, or nothing for roles that are not invoiced (office roles).
import { useState } from 'react';
import { CheckCircle2, FileSignature, FileText } from 'lucide-react';
import { BRAND, isInvoicedRole } from '@lm/shared';
import { Badge, Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { useAgreement, useCompanySettings, useInvoiceProfile } from '@/api/invoices';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState } from '@/features/common';
import { formatDate } from '@/lib/format';
import { AgreementDialog } from './AgreementDialog';
import { InvoiceProfileForm } from './InvoiceProfileForm';

export interface InvoiceSettingsSectionProps {
  className?: string;
}

export function InvoiceSettingsSection({ className }: InvoiceSettingsSectionProps) {
  const user = useCurrentUser();
  const invoiced = isInvoicedRole(user.role);
  const agreement = useAgreement({ enabled: invoiced });
  const profile = useInvoiceProfile(null, { enabled: invoiced });
  const company = useCompanySettings({ enabled: invoiced });
  const [open, setOpen] = useState(false);
  if (!invoiced) return null;
  const a = agreement.data;
  const legalName = company.data?.legalName || BRAND.legalName;
  return (
    <Card className={className} data-testid="invoice-settings">
      <CardHeader
        title="Invoices"
        description={`Each pay week, ${legalName} writes a self-billing invoice for you. Your details below are printed on it as the supplier.`}
        icon={<FileText aria-hidden />}
      />
      <section aria-labelledby="agreement-title" className="mb-5 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 id="agreement-title" className="font-sans text-sm font-semibold tracking-normal text-fg">Self-billing agreement</h4>
              {agreement.isLoading ? <Skeleton className="h-5 w-20 rounded-full" /> : a && (
                <Badge tone={a.acceptedAt ? 'success' : 'warning'} dot={!!a.acceptedAt}>{a.acceptedAt ? 'Accepted' : 'Not accepted yet'}</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {a?.acceptedAt
                ? `You accepted version ${a.version} on ${formatDate(a.acceptedAt)}.`
                : `It lets ${legalName} write your invoices for you. Accept it once, before your first invoice.`}
            </p>
          </div>
          <Button size="sm" variant={a && !a.acceptedAt ? 'primary' : 'outline'} onClick={() => setOpen(true)} leftIcon={a?.acceptedAt ? <FileSignature aria-hidden /> : <CheckCircle2 aria-hidden />} className="h-10 shrink-0 sm:h-8">
            {a && !a.acceptedAt ? 'Read and accept' : 'Read the agreement'}
          </Button>
        </div>
      </section>
      {profile.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10 w-1/2" /></div>
      ) : profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} className="p-4" />
      ) : profile.data ? (
        <InvoiceProfileForm profile={profile.data} self />
      ) : null}
      <AgreementDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}
