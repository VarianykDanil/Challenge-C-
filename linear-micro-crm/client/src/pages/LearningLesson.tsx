// Release 1.2 — /learning/pack/:lessonKey, one COD pack lesson — OWNED BY L1 learning-pack.
// Summary, key points, the lesson rebuilt from the pack (with its illustrations), the 3-question self-check and
// "Teach it back". Section anchors (#greed, #short-story, …) match shared LESSON_ANCHORS: L2's annotation chips and the
// field cards link straight to them.
import { useEffect } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, ListChecks, Sparkles } from 'lucide-react';
import { LESSON_KEYS, isLessonKey } from '@lm/shared';
import { useLearningProgress } from '@/api/learning';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { LessonJourney } from '@/features/learning/pack/LessonJourney';
import { LessonSections } from '@/features/learning/pack/LessonBlocks';
import { LessonQuiz } from '@/features/learning/pack/LessonQuiz';
import { RichText } from '@/features/learning/pack/RichText';
import { StateBadge } from '@/features/learning/pack/StateBadge';
import { TeachBack } from '@/features/learning/pack/TeachBack';
import { LESSONS } from '@/content/learning';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

const back = (
  <Link to="/learning" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10">
    <ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}
  </Link>
);

export function LearningLessonPage() {
  const { lessonKey } = useParams();
  const { hash } = useLocation();
  const lesson = isLessonKey(lessonKey) ? LESSONS[lessonKey] : null;
  usePageTitle(lesson ? lesson.title : COPY.nav.learning.title);
  const progress = useLearningProgress();
  const mine = lesson ? progress.data?.lessons.find((l) => l.lessonKey === lesson.key) : undefined;

  // A link to /learning/pack/:key#anchor lands on that section; a new lesson without one starts at the top.
  useEffect(() => {
    if (!lesson) return;
    const id = hash ? decodeURIComponent(hash.slice(1)) : '';
    const frame = requestAnimationFrame(() => {
      const el = id ? document.getElementById(id) : null;
      if (el) el.scrollIntoView({ block: 'start' });
      else if (!id) window.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [lesson, hash]);

  if (!lesson) {
    return (
      <>
        <PageHeader breadcrumbs={back} title="Lesson not found" />
        <EmptyState
          icon={<BookOpen aria-hidden />}
          title="That lesson isn’t in the COD pack"
          description="It may have been renamed. Every lesson is listed on the Learning page."
          action={
            <Link to="/learning" className="focus-ring inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg">
              Back to Learning
            </Link>
          }
        />
      </>
    );
  }

  const index = LESSON_KEYS.indexOf(lesson.key);
  const prev = index > 0 ? LESSONS[LESSON_KEYS[index - 1]!] : null;
  const next = index < LESSON_KEYS.length - 1 ? LESSONS[LESSON_KEYS[index + 1]!] : null;
  const toc = lesson.sections.filter((s) => s.id && s.title);

  return (
    <>
      <PageHeader
        breadcrumbs={back}
        eyebrow={lesson.page ? `COD pack · page ${lesson.page} · lesson ${index + 1} of ${LESSON_KEYS.length}` : `Checklist task · ${index + 1} of ${LESSON_KEYS.length}`}
        title={lesson.title}
        actions={<StateBadge state={mine?.state ?? 'new'} task={lesson.task} size="md" />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        {/* Summary and key points */}
        <Card className="lg:col-start-1">
          <p className="text-[15px] font-medium leading-relaxed text-fg">{lesson.summary}</p>
          <h2 className="mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden /> Key points
          </h2>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {lesson.keyPoints.map((k) => (
              <li key={k} className="flex gap-2 text-sm leading-relaxed text-fg">
                <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span className="min-w-0">
                  <RichText text={k} />
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Your progress on this lesson (beside the lesson on wide screens, under the summary on phones) */}
        <aside className="space-y-4 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-4 lg:row-start-1" aria-label="This lesson">
          <Card>
            <CardHeader title="Your progress" description={lesson.task ? 'Do it, say how it went, get it signed off.' : 'Learn it, teach it back, get it signed off.'} />
            <LessonJourney lesson={lesson} progress={mine} />
          </Card>
          {toc.length > 1 && (
            <Card className="hidden lg:block">
              <CardHeader title="On this page" />
              <nav aria-label="On this page">
                <ul className="space-y-1 text-sm">
                  {toc.map((s) => (
                    <li key={s.id}>
                      <a href={`#${s.id}`} className="focus-ring block rounded px-1 py-0.5 text-muted hover:bg-surface-2 hover:text-fg">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </Card>
          )}
          <Link to="/learning/progress" className="focus-ring hidden items-center gap-2 rounded-lg px-1 text-sm font-medium text-primary hover:underline lg:flex">
            <ListChecks className="h-4 w-4" aria-hidden /> Your checklist and progression
          </Link>
        </aside>

        {/* The lesson */}
        <Card className="lg:col-start-1">
          <LessonSections sections={lesson.sections} />
        </Card>

        <div id="self-check" className="scroll-mt-24 lg:col-start-1">
          <LessonQuiz key={lesson.key} lesson={lesson} progress={mine} />
        </div>
        <div id="teach-back" className="scroll-mt-24 lg:col-start-1">
          <TeachBack key={lesson.key} lesson={lesson} progress={mine} />
        </div>

        <nav aria-label="More lessons" className="grid gap-3 sm:grid-cols-2 lg:col-start-1">
          {prev ? (
            <Link to={`/learning/pack/${prev.key}`} className="focus-ring card-hover flex min-h-14 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
              <ArrowLeft className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="min-w-0">
                <span className="block text-xs text-muted">Previous</span>
                <span className="block truncate text-sm font-semibold text-fg">{prev.short}</span>
              </span>
            </Link>
          ) : (
            <span className="hidden sm:block" />
          )}
          {next && (
            <Link to={`/learning/pack/${next.key}`} className="focus-ring card-hover flex min-h-14 items-center justify-end gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-right shadow-card">
              <span className="min-w-0">
                <span className="block text-xs text-muted">Next</span>
                <span className="block truncate text-sm font-semibold text-fg">{next.short}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
            </Link>
          )}
        </nav>
      </div>
    </>
  );
}
