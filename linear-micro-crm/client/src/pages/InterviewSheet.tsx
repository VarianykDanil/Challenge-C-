// Release 1.3 — /recruitment/interviews/:id (admin, leader, recruiter) — OWNED BY P7 recruitment-plus (laid down by r3-foundation as a stub page).
import { Link } from 'react-router-dom';
import { ArrowLeft, ClipboardList } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function InterviewSheetPage() {
  usePageTitle(COPY.nav.interviewSheet.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/recruitment" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Recruitment</Link>}
        title={COPY.nav.interviewSheet.title}
        description={COPY.nav.interviewSheet.description}
      />
      <EmptyState icon={<ClipboardList aria-hidden />} title="Coming soon" description="The interview questions and the candidate's answers will be written here." />
    </>
  );
}
