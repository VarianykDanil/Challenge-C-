// Release 1.2 — /learning/pack/:lessonKey, one COD pack lesson — OWNED BY L1 learning-pack (laid down by
// r2-foundation as a stub). Section anchors (#greed, #short-story, …) must match shared LESSON_ANCHORS.
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function LearningLessonPage() {
  const { lessonKey } = useParams();
  usePageTitle(COPY.nav.learning.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/learning" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}</Link>}
        title="Lesson"
        description={lessonKey ? `COD pack · ${lessonKey}` : undefined}
      />
      <EmptyState icon={<BookOpen aria-hidden />} title="Coming soon" description="This lesson from the COD pack will appear here." />
    </>
  );
}
