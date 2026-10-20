// Release 1.2 — /learning, the Learning hub — OWNED BY L1 learning-pack (laid down by r2-foundation as a stub).
// L1 builds the hub (search, lesson cards by checklist group, progress per lesson, Field cards) and keeps L2's
// PitchesSection mounted above the COD pack lessons, in its ErrorBoundary.
import { GraduationCap } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { PitchesSection } from '@/features/learning/PitchesSection';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function LearningPage() {
  usePageTitle(COPY.nav.learning.title);
  return (
    <>
      <PageHeader title={COPY.nav.learning.title} description={COPY.nav.learning.description} />
      <div className="space-y-6">
        <ErrorBoundary name="pitches-section" fallback={null}>
          <PitchesSection />
        </ErrorBoundary>
        <EmptyState icon={<GraduationCap aria-hidden />} title="Coming soon" description="The COD pack lessons, your progress and the leadership checklist will live here." />
      </div>
    </>
  );
}
