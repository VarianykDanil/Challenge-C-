// Release 1.3 — /venues (every staff role) — OWNED BY P8 venue-insights (laid down by r3-foundation as a stub page).
import { MapPinned } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function VenuesPage() {
  usePageTitle(COPY.nav.venues.title);
  return (
    <>
      <PageHeader
        title={COPY.nav.venues.title}
        description={COPY.nav.venues.description}
      />
      <EmptyState icon={<MapPinned aria-hidden />} title="Coming soon" description="Every venue the team has worked will be listed here, with sales per shift." />
    </>
  );
}
