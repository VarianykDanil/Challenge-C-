// Release 1.2 — /gauges/bulk (leader: own team; admin: any) — OWNED BY U2 bulk-entry (laid down by r2-foundation as a stub).
import { Link } from 'react-router-dom';
import { ArrowLeft, ClipboardList } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function BulkGaugesPage() {
  usePageTitle(COPY.nav.bulkGauges.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/gauges" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.gauges.title}</Link>}
        title={COPY.nav.bulkGauges.title}
        description={COPY.nav.bulkGauges.description}
      />
      <EmptyState icon={<ClipboardList aria-hidden />} title="Coming soon" description="One row per team member, checked against the funnel, saved in one go." />
    </>
  );
}
