// Personal pace note under the coaching insights — OWNED BY p2-personal-pace-streaks.
// Stub from p1: renders nothing. Mounted in the "Your funnel" card directly under CoachingInsights (dashboard), inside
// an ErrorBoundary, for every role that has personal charts. Must render nothing when both props are null/undefined.
import type { PersonalBaseline, TrendDirection } from '@lm/shared';

export interface BaselineNoteProps {
  /** insights.personal.baseline — undefined while /me/insights loads. */
  baseline: PersonalBaseline | null | undefined;
  /** insights.personal.direction — undefined while /me/insights loads. */
  direction: TrendDirection | null | undefined;
  className?: string;
}

export function BaselineNote(_props: BaselineNoteProps) {
  return null;
}
