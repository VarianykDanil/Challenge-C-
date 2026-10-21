// Release 1.2 — /learning/progress, the leadership checklist and progression tracker — OWNED BY L1 learning-pack.
// Everyone: their own checklist (Learn / Teach ticks) and where they are on the ladder. Leaders: their team (teach-backs
// waiting for a sign-off, everyone's ticks); admins: everyone, and they tick the criteria the office confirms by hand.
// `?view=team` opens the team view, `?userId=` one person (leaders: own team only; the server enforces it).
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, User, Users } from 'lucide-react';
import { careerLevelFor, nextCareerLevel } from '@lm/shared';
import { useLearningProgress } from '@/api/learning';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Card, CardHeader, PageHeader, SkeletonCard, Tabs } from '@/components/ui';
import { ErrorState } from '@/features/common';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
// Release 1.3 slots: required videos in the checklist (P5); "Download PDF" of the progress (P4, once PDFs are ready).
import { ProgressPdfButton } from '@/features/pdf/ProgressPdfButton';
import { VideoProgressSection } from '@/features/videos/VideoProgressSection';
import { PDF_EXPORTS_READY } from '@/lib/pdf';
import { CareerLadder } from '@/features/learning/pack/CareerLadder';
import { PersonChecklist } from '@/features/learning/pack/PersonChecklist';
import { ProgressionPanel } from '@/features/learning/pack/ProgressionPanel';
import { TeamChecklist } from '@/features/learning/pack/TeamChecklist';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function LearningProgressPage() {
  const me = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const manages = me.role === 'admin' || me.role === 'leader';
  const rawUser = Number(params.get('userId'));
  const personId = manages && Number.isInteger(rawUser) && rawUser > 0 && rawUser !== me.id ? rawUser : null;
  const view = manages && params.get('view') === 'team' ? 'team' : 'me';
  usePageTitle(personId ? 'Learning progress' : 'Progress');

  const toLearning = (
    <Link to="/learning" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10">
      <ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}
    </Link>
  );

  if (personId) return <PersonView userId={personId} isAdmin={me.role === 'admin'} />;

  return (
    <>
      <PageHeader
        breadcrumbs={toLearning}
        title="Progress"
        description="The pack’s leadership checklist: learn each lesson, then teach it back. And what your next level needs, from your own numbers."
        actions={PDF_EXPORTS_READY && view === 'me' ? <ErrorBoundary name="progress-pdf" fallback={null}><ProgressPdfButton /></ErrorBoundary> : undefined}
        tabs={
          manages ? (
            <Tabs
              aria-label="Whose progress"
              value={view}
              onChange={(v) => setParams(v === 'team' ? { view: 'team' } : {}, { replace: true })}
              items={[
                { value: 'me', label: 'Me', icon: <User /> },
                { value: 'team', label: me.role === 'admin' ? 'Everyone' : 'My team', icon: <Users /> },
              ]}
            />
          ) : undefined
        }
      />
      {view === 'team' ? (
        <>
          <TeamChecklist isAdmin={me.role === 'admin'} personHref={(id) => (id === me.id ? '/learning/progress' : `/learning/progress?userId=${id}`)} />
          {/* Release 1.3 slot (P5): the team's required videos; nothing until the package lands. */}
          <ErrorBoundary name="video-progress-team" fallback={null}><VideoProgressSection view="team" /></ErrorBoundary>
        </>
      ) : (
        <OwnView userId={me.id} isAdmin={me.role === 'admin'} showLadder={careerLevelFor(me.position) !== null} />
      )}
    </>
  );
}

function OwnView({ userId, isAdmin, showLadder }: { userId: number; isAdmin: boolean; showLadder: boolean }) {
  const me = useCurrentUser();
  const progress = useLearningProgress();
  const level = careerLevelFor(me.position);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2 lg:items-start">
        <ProgressionPanel userId={userId} canEditMilestones={isAdmin} />
        {progress.isLoading ? (
          <SkeletonCard lines={8} />
        ) : progress.data ? (
          <PersonChecklist progress={progress.data} canSignOff={false} self />
        ) : (
          <ErrorState error={progress.error} onRetry={() => void progress.refetch()} title="Could not load your checklist" />
        )}
      </div>
      {/* Release 1.3 slot (P5): the required videos; nothing until the package lands. */}
      <ErrorBoundary name="video-progress" fallback={null}><VideoProgressSection view="me" userId={userId} /></ErrorBoundary>
      {showLadder && (
        <Card>
          <CardHeader title="The ladder" description="Pre- and post-management progression structure (COD pack pages 18–19)." />
          <CareerLadder current={level} next={nextCareerLevel(level)} headingLevel="h4" />
        </Card>
      )}
    </div>
  );
}

function PersonView({ userId, isAdmin }: { userId: number; isAdmin: boolean }) {
  const progress = useLearningProgress(userId);
  const name = progress.data?.userName;
  const back = (
    <Link to="/learning/progress?view=team" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10">
      <ArrowLeft className="h-3 w-3" aria-hidden /> {isAdmin ? 'Everyone' : 'My team'}
    </Link>
  );
  return (
    <>
      <PageHeader
        breadcrumbs={back}
        title={name ?? 'Progress'}
        description={name ? `${name.split(' ')[0]}’s leadership checklist and progression.` : undefined}
        actions={PDF_EXPORTS_READY ? <ErrorBoundary name="progress-pdf" fallback={null}><ProgressPdfButton userId={userId} /></ErrorBoundary> : undefined}
      />
      {progress.isLoading ? (
        <SkeletonCard lines={8} />
      ) : progress.isError || !progress.data ? (
        <ErrorState error={progress.error} onRetry={() => void progress.refetch()} title="Could not load this person’s progress" />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2 lg:items-start">
            <PersonChecklist progress={progress.data} canSignOff self={false} />
            <ProgressionPanel userId={userId} canEditMilestones={isAdmin} self={false} />
          </div>
          {/* Release 1.3 slot (P5): nothing until the package lands. */}
          <ErrorBoundary name="video-progress-person" fallback={null}><VideoProgressSection view="person" userId={userId} /></ErrorBoundary>
        </>
      )}
    </>
  );
}
