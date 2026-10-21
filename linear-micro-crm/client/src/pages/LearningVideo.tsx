// Release 1.3 — /learning/videos/:id (every staff role) — OWNED BY P5 learning-videos (laid down by r3-foundation as a stub page).
import { Link } from 'react-router-dom';
import { ArrowLeft, Video } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function LearningVideoPage() {
  usePageTitle(COPY.nav.learningVideo.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/learning" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Learning</Link>}
        title={COPY.nav.learningVideo.title}
        description={COPY.nav.learningVideo.description}
      />
      <EmptyState icon={<Video aria-hidden />} title="Coming soon" description="Learning videos will play here." />
    </>
  );
}
