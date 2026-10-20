// Release 1.2 — /learning/progress, the leadership checklist and progression tracker — OWNED BY L1 learning-pack
// (laid down by r2-foundation as a stub).
import { Link } from 'react-router-dom';
import { ArrowLeft, ListChecks } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function LearningProgressPage() {
  usePageTitle('Learning progress');
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/learning" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}</Link>}
        title="Progress"
        description="The leadership checklist: learn it, then teach it back."
      />
      <EmptyState icon={<ListChecks aria-hidden />} title="Coming soon" description="Your checklist and the distance to your next level will appear here." />
    </>
  );
}
