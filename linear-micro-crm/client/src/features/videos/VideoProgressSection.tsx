// Release 1.3 slot — OWNED BY P5 learning-videos (laid down by r3-foundation; renders nothing until P5 learning-videos fills it).
// Learning → Progress: the required videos in the person's checklist (view 'me', or 'person' for a leader looking at
// someone), and the team view's "6 of 8 watched" (view 'team'). Mounted in pages/LearningProgress.tsx after the
// checklist (me, person) and after the team checklist (team), in an ErrorBoundary with fallback={null}.
export interface VideoProgressSectionProps {
  view: 'me' | 'person' | 'team';
  /** The person shown (view 'me': the signed-in user; 'person': that person). */
  userId?: number;
  className?: string;
}

export function VideoProgressSection(_props: VideoProgressSectionProps) {
  return null;
}
