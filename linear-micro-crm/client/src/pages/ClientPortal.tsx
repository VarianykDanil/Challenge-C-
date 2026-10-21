// Release 1.3 — /client: the client portal's Updates page — OWNED BY P6 client-portal (laid down by r3-foundation as a
// stub: it shows which campaign the account belongs to; P6 adds the "Post an update" form and the history with statuses).
import { Megaphone } from 'lucide-react';
import { useClientPortal } from '@/api/clientPortal';
import { Badge, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { ErrorState } from '@/features/common';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function ClientPortalPage() {
  usePageTitle(COPY.nav.clientPortal.title);
  const q = useClientPortal();
  const campaign = q.data?.campaign;
  return (
    <>
      <PageHeader title={COPY.nav.clientPortal.title} description={COPY.nav.clientPortal.description} />
      <div className="space-y-6">
        <Card>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load your campaign" />
          ) : !campaign ? (
            <Skeleton className="h-6 w-64" />
          ) : (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              You are signed in for <Badge tone="neutral" dot color={campaign.color}>{campaign.name}</Badge>
            </p>
          )}
        </Card>
        <EmptyState icon={<Megaphone aria-hidden />} title="Coming soon" description="Post an update, an announcement or a commission change for the Linear MCR team here." />
      </div>
    </>
  );
}
