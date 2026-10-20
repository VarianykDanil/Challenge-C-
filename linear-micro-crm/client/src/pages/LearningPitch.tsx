// Release 1.2 — /learning/pitch/:campaignCode, the pitch studio — OWNED BY L2 learning-pitch (laid down by
// r2-foundation as a stub).
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Mic } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function LearningPitchPage() {
  const { campaignCode } = useParams();
  usePageTitle('Pitch');
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/learning" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}</Link>}
        title="Pitch"
        description={campaignCode ? `Campaign ${campaignCode.toUpperCase()}` : undefined}
      />
      <EmptyState icon={<Mic aria-hidden />} title="Coming soon" description="The campaign's pitch, set for reading aloud and practising, will appear here." />
    </>
  );
}
