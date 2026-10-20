// Release 1.2 slot — OWNED BY L2 learning-pitch (laid down by r2-foundation; renders nothing until L2 fills it).
// "Pitch": opens /learning/pitch/:campaignCode for the event's campaign when that campaign has a pitch (nothing
// otherwise). Mounted, each in an ErrorBoundary with fallback={null}:
//  - pages/QuickGauges.tsx header (variant 'compact'), for the selected event;
//  - pages/EventDetail.tsx header actions (variant 'button').
export interface PitchLinkProps {
  campaignCode: string;
  campaignId?: number;
  variant?: 'compact' | 'button';
  className?: string;
}

export function PitchLink(_props: PitchLinkProps) {
  return null;
}
