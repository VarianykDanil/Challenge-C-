// Release 1.3 — /recruitment/schedule (admin, leader, recruiter) — OWNED BY P7 recruitment-plus (laid down by r3-foundation as a stub page).
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function InterviewSchedulePage() {
  usePageTitle(COPY.nav.interviewSchedule.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/recruitment" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Recruitment</Link>}
        title={COPY.nav.interviewSchedule.title}
        description={COPY.nav.interviewSchedule.description}
      />
      <EmptyState icon={<CalendarClock aria-hidden />} title="Coming soon" description="Every interview will be listed here by day, with its interviewer." />
    </>
  );
}
