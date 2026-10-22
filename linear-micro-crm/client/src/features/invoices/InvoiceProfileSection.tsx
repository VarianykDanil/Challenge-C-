// Release 1.3 slot — OWNED BY P2 invoices. Team → person (admin): the person's supplier details for invoices (editable)
// and whether they accepted the self-billing agreement. Mounted in pages/UserDetail.tsx in the left column after the
// Pay plan card, administrators only, in an ErrorBoundary with fallback={null}. A whole Card, or nothing for a person
// who is not invoiced (office roles).
import { FileText } from 'lucide-react';
import type { UserWithTeam } from '@lm/shared';
import { isInvoicedRole } from '@lm/shared';
import { Badge, Card, CardHeader, Skeleton } from '@/components/ui';
import { useInvoiceProfile } from '@/api/invoices';
import { ErrorState } from '@/features/common';
import { formatDate } from '@/lib/format';
import { InvoiceProfileForm } from './InvoiceProfileForm';

export interface InvoiceProfileSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function InvoiceProfileSection({ user, className }: InvoiceProfileSectionProps) {
  const invoiced = isInvoicedRole(user.role);
  const q = useInvoiceProfile(user.id, { enabled: invoiced });
  if (!invoiced) return null;
  const p = q.data;
  const accepted = p?.agreement?.acceptedAt ?? null;
  return (
    <Card className={className} data-testid="invoice-profile">
      <CardHeader
        title="Invoice details"
        description={`Printed as the supplier on ${user.firstName}'s self-billing invoices.`}
        icon={<FileText aria-hidden />}
      />
      {p && (
        <div className="-mt-1 mb-4 space-y-1.5">
          <Badge tone={accepted ? 'success' : 'warning'} dot={!!accepted}>{accepted ? 'Agreement accepted' : 'Agreement not accepted'}</Badge>
          <p className="text-xs text-muted">
            {accepted
              ? `Accepted the self-billing agreement (version ${p.agreement?.version}) on ${formatDate(accepted)}.`
              : `${user.firstName} has not accepted the self-billing agreement yet: their invoices still count as accepted at 12:00 the day before payday unless disputed, but they cannot accept one themselves until they do.`}
          </p>
        </div>
      )}
      {q.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} className="p-4" />
      ) : p ? (
        <InvoiceProfileForm profile={p} userId={user.id} self={false} />
      ) : null}
    </Card>
  );
}
