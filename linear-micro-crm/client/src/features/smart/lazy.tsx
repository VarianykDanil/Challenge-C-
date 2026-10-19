// Dashboard-only smart slots, loaded on demand (lead decision on the bundle). React.lazy + Suspense keep them out of the
// main chunk and out of the dashboard page's own chunk; all six arrive together in one chunk (./dashboardSlots). While
// it loads, each slot shows a quiet placeholder shaped like what it will render, or nothing when the slot would render
// nothing anyway (no data yet, or the smart features switched off), so nothing jumps in for no reason.
// Every slot already sits in its own ErrorBoundary on the page, so a chunk that fails to load (no signal) only blanks
// that slot, with "Try again".
import { Suspense, lazy, type ComponentProps } from 'react';
import { Skeleton } from '@/components/ui';
import type { AttentionCard } from './AttentionCard';
import type { BaselineNote } from './BaselineNote';
import type { CheckInList } from './CheckInList';
import type { TeamCoaching } from './TeamCoaching';
import type { WeekInReview } from './WeekInReview';
import type { WeekPayStrip } from './WeekPayStrip';

const slots = () => import('./dashboardSlots');
const AttentionCardChunk = lazy(() => slots().then((m) => ({ default: m.AttentionCard })));
const BaselineNoteChunk = lazy(() => slots().then((m) => ({ default: m.BaselineNote })));
const CheckInListChunk = lazy(() => slots().then((m) => ({ default: m.CheckInList })));
const TeamCoachingChunk = lazy(() => slots().then((m) => ({ default: m.TeamCoaching })));
const WeekInReviewChunk = lazy(() => slots().then((m) => ({ default: m.WeekInReview })));
const WeekPayStripChunk = lazy(() => slots().then((m) => ({ default: m.WeekPayStrip })));

/** "Needs attention" card. Placeholder: the card's own loading line (h-14), so the swap is seamless. */
export function LazyAttentionCard(props: ComponentProps<typeof AttentionCard>) {
  return (
    <Suspense fallback={<Skeleton className="h-14 w-full" />}>
      <AttentionCardChunk {...props} />
    </Suspense>
  );
}

/** The week's pay estimate under the KPI tiles; nothing until there is a forecast. */
export function LazyWeekPayStrip(props: ComponentProps<typeof WeekPayStrip>) {
  if (!props.forecast) return null;
  return (
    <Suspense fallback={<Skeleton className="h-12 w-full rounded-xl" />}>
      <WeekPayStripChunk {...props} />
    </Suspense>
  );
}

/** Pace note under the coaching insights; renders nothing more often than not, so its placeholder is nothing. */
export function LazyBaselineNote(props: ComponentProps<typeof BaselineNote>) {
  if (!props.baseline && !props.direction) return null;
  return (
    <Suspense fallback={null}>
      <BaselineNoteChunk {...props} />
    </Suspense>
  );
}

/** "Check in with…" list (leaders' team card, the owner's company section); nothing until the list is known. */
export function LazyCheckInList(props: ComponentProps<typeof CheckInList>) {
  if (!props.people) return null;
  return (
    <Suspense fallback={<Skeleton lines={2} className={props.className} />}>
      <CheckInListChunk {...props} />
    </Suspense>
  );
}

/** Team coaching tips in the leader's team card. */
export function LazyTeamCoaching(props: ComponentProps<typeof TeamCoaching>) {
  return (
    <Suspense fallback={<Skeleton lines={2} className={props.className} />}>
      <TeamCoachingChunk {...props} />
    </Suspense>
  );
}

/** "Your week in review" (p9's slot); quiet while it loads. */
export function LazyWeekInReview(props: ComponentProps<typeof WeekInReview>) {
  return (
    <Suspense fallback={null}>
      <WeekInReviewChunk {...props} />
    </Suspense>
  );
}
