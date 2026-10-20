// Release 1.2 — /learning, the Learning hub — OWNED BY L1 learning-pack.
// Your COD pack progress, the field cards (5 steps and the six objections, one phone screen each), L2's campaign
// pitches (PitchesSection, kept mounted above the lessons in its ErrorBoundary), and the 21 lessons grouped by the
// pack's leadership checklist, with search. `?card=steps|objections` opens a field card directly.
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, Footprints, ListChecks, Search, ShieldQuestion, X } from 'lucide-react';
import clsx from 'clsx';
import type { LessonProgress } from '@lm/shared';
import { useLearningProgress } from '@/api/learning';
import { Button, Card, EmptyState, Input, PageHeader, ProgressBar, Skeleton } from '@/components/ui';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { PitchesSection } from '@/features/learning/PitchesSection';
import { FieldCards, type FieldCardKind } from '@/features/learning/pack/FieldCards';
import { LessonPlate } from '@/features/learning/pack/LessonFigure';
import { StateBadge } from '@/features/learning/pack/StateBadge';
import { GROUP_COPY, IMAGES, LESSON_LIST, lessonsByGroup, searchLessons, type Lesson } from '@/content/learning';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

const isCard = (v: string | null): v is FieldCardKind => v === 'steps' || v === 'objections';

export function LearningPage() {
  usePageTitle(COPY.nav.learning.title);
  const [params, setParams] = useSearchParams();
  const card = params.get('card');
  const setCard = (kind: FieldCardKind | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (kind) next.set('card', kind);
        else next.delete('card');
        return next;
      },
      { replace: true },
    );
  const [query, setQuery] = useState('');
  const progress = useLearningProgress();
  const byKey = useMemo(() => new Map((progress.data?.lessons ?? []).map((l) => [l.lessonKey, l])), [progress.data]);
  const results = useMemo(() => searchLessons(query), [query]);
  const groups = lessonsByGroup(results);
  // Until it loads nothing is suggested; then the first lesson not learned yet, else the first not taught back.
  const loaded = Boolean(progress.data);
  const nextLearn = loaded ? LESSON_LIST.find((l) => !byKey.get(l.key)?.learnedAt) : undefined;
  const nextTeach = loaded && !nextLearn ? LESSON_LIST.find((l) => !byKey.get(l.key)?.teachbackAt && !byKey.get(l.key)?.taughtSignedOffAt) : undefined;
  const nextLesson = nextLearn ?? nextTeach ?? null;
  const nextLabel = nextLearn ? ((progress.data?.learned ?? 0) > 0 ? 'Continue' : 'Start') : 'Teach back';

  return (
    <>
      <PageHeader
        title={COPY.nav.learning.title}
        description={COPY.nav.learning.description}
        actions={
          <Link to="/learning/progress" className="focus-ring inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-2">
            <ListChecks className="h-4 w-4" aria-hidden />
            Checklist and progress
          </Link>
        }
      />
      <div className="space-y-6">
        {/* Your COD pack */}
        <Card className="overflow-hidden" padded={false}>
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
            <LessonPlate image={IMAGES.medal} size="sm" eager decorative className="h-28 w-28 shrink-0 self-center sm:h-32 sm:w-32" />
            <div className="min-w-0 flex-1">
              <div className="eyebrow">No. 1 Org COD pack</div>
              <h2 className="mt-1 text-xl font-bold tracking-tight text-fg">Learn it, then teach it back</h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
                Each lesson ends with a three-question self-check. Pass it and the lesson is learned; write it back in your own words and your leader signs it off.
              </p>
              {progress.isLoading ? (
                <Skeleton className="mt-4 h-8 w-full max-w-md" />
              ) : progress.data ? (
                <div className="mt-4 grid max-w-lg gap-3 sm:grid-cols-2">
                  <ProgressBar size="sm" showValue label="Learned" value={progress.data.learned} max={progress.data.total} formatValue={(v, m) => `${v} of ${m}`} />
                  <ProgressBar size="sm" showValue label="Taught back" value={progress.data.taught} max={progress.data.total} formatValue={(v, m) => `${v} of ${m}`} tone="success" />
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                {nextLesson && (
                  <Link
                    to={`/learning/pack/${nextLesson.key}`}
                    className="focus-ring inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg shadow-card hover:bg-primary-hover"
                  >
                    {nextLabel}: {nextLesson.short}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* Field cards: one phone screen each, for between stops */}
        <section aria-labelledby="field-cards-title">
          <h2 id="field-cards-title" className="mb-2 text-sm font-semibold text-fg">
            Field cards
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldCardTile icon={<Footprints />} title="5 steps to a conversation" text="Intro 7–10 s, short story 10–15 s, presentation, close, consolidation." onClick={() => setCard('steps')} />
            <FieldCardTile icon={<ShieldQuestion />} title="The six objections" text="No money, no time, other charities, bank details, C.O.W.S, direct debit." onClick={() => setCard('objections')} />
          </div>
        </section>

        <ErrorBoundary name="pitches-section" fallback={null}>
          <PitchesSection />
        </ErrorBoundary>

        {/* The COD pack lessons */}
        <section aria-labelledby="lessons-title" className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="lessons-title" className="text-lg font-bold tracking-tight text-fg">
                The COD pack
              </h2>
              <p className="text-sm text-muted">21 lessons in the order of the leadership checklist.</p>
            </div>
            <div className="w-full sm:max-w-xs">
              <label htmlFor="lesson-search" className="sr-only">
                Search the lessons
              </label>
              <Input
                id="lesson-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search: GIFGUP, no time, pause…"
                leftIcon={<Search />}
                autoComplete="off"
                enterKeyHint="search"
              />
            </div>
          </div>
          {query && (
            <p className="text-xs text-muted" aria-live="polite">
              {results.length === 0 ? 'No lesson matches.' : `${results.length} ${results.length === 1 ? 'lesson matches' : 'lessons match'} “${query.trim()}”.`}
            </p>
          )}
          {results.length === 0 ? (
            <EmptyState
              icon={<BookOpen aria-hidden />}
              title="Nothing in the pack matches"
              description="Try one word, like “objection”, “attitude” or “close”."
              action={
                <Button variant="outline" leftIcon={<X />} onClick={() => setQuery('')}>
                  Clear the search
                </Button>
              }
            />
          ) : (
            groups.map(({ group, lessons }) => (
              <div key={group}>
                <div className="mb-2">
                  <h3 className="text-sm font-semibold text-fg">{GROUP_COPY[group].title}</h3>
                  <p className="text-xs text-muted">{GROUP_COPY[group].description}</p>
                </div>
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {lessons.map((l) => (
                    <li key={l.key} className="min-w-0">
                      <LessonCard lesson={l} number={LESSON_LIST.indexOf(l) + 1} progress={byKey.get(l.key)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </div>
      <FieldCards open={isCard(card) ? card : null} onChange={setCard} />
    </>
  );
}

function FieldCardTile({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring card-hover group flex min-h-[4.5rem] w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-card"
    >
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger [&_svg]:h-5 [&_svg]:w-5" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-fg">{title}</span>
        <span className="block text-xs leading-snug text-muted">{text}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
  );
}

function LessonCard({ lesson, number, progress }: { lesson: Lesson; number: number; progress: LessonProgress | undefined }) {
  return (
    <Link
      to={`/learning/pack/${lesson.key}`}
      className="focus-ring card-hover group flex h-full min-w-0 gap-3 rounded-xl border border-border bg-surface p-3 shadow-card"
      aria-label={`${number}. ${lesson.title}`}
    >
      {lesson.image ? (
        <LessonPlate image={lesson.image} size="xs" decorative className="h-20 w-20 shrink-0 !p-1.5" />
      ) : (
        <span
          className={clsx(
            'flex h-20 w-20 shrink-0 items-center justify-center rounded-xl font-display text-2xl font-extrabold tabular',
            lesson.task ? 'bg-accent-soft text-accent' : 'bg-primary-soft text-primary',
          )}
          aria-hidden
        >
          {number}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold leading-snug text-fg group-hover:text-primary">{lesson.title}</span>
        <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{lesson.summary}</span>
        <span className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          <StateBadge state={progress?.state ?? 'new'} task={lesson.task} />
          <span className="text-[11px] text-muted">{lesson.page ? `Pack p. ${lesson.page}` : 'Checklist task'}</span>
        </span>
      </span>
    </Link>
  );
}
