// Release 1.3 — /campaigns/:id (every staff role; money for admins and leaders only) — OWNED BY P6 client-portal (laid down by r3-foundation as a stub page).
import { Link } from 'react-router-dom';
import { ArrowLeft, Megaphone } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function CampaignPagePage() {
  usePageTitle(COPY.nav.campaignPage.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/campaigns" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Campaigns</Link>}
        title={COPY.nav.campaignPage.title}
        description={COPY.nav.campaignPage.description}
      />
      <EmptyState icon={<Megaphone aria-hidden />} title="Coming soon" description="The client's brief, updates and announcements will be shown here." />
    </>
  );
}
