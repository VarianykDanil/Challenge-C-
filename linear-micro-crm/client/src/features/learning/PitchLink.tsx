// Release 1.2 slot — OWNED BY L2 learning-pitch.
// "Pitch": opens /learning/pitch/:campaignCode for the event's campaign when that campaign has a pitch (nothing
// otherwise, and nothing while the list loads or if it fails). Mounted, each in an ErrorBoundary with fallback={null}:
//  - pages/QuickGauges.tsx header (variant 'compact': a 40 px icon link, the header is tight on phones);
//  - pages/EventDetail.tsx header actions (variant 'button': an outline button with the label).
// The pitch list (GET /pitches) is one small cached query shared with the Learning hub.
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Mic } from 'lucide-react';
import { usePitches } from '@/api/pitches';

export interface PitchLinkProps {
  campaignCode: string;
  campaignId?: number;
  variant?: 'compact' | 'button';
  className?: string;
}

export function PitchLink({ campaignCode, campaignId, variant = 'button', className }: PitchLinkProps) {
  const { data } = usePitches();
  const code = campaignCode?.toUpperCase();
  const item = data?.find((p) => (campaignId != null ? p.campaignId === campaignId : p.campaignCode.toUpperCase() === code));
  if (!item?.hasPitch) return null;
  const to = `/learning/pitch/${encodeURIComponent(item.campaignCode)}`;
  const label = `Open the ${item.campaignName} pitch`;
  if (variant === 'compact') {
    return (
      <Link
        to={to}
        aria-label={label}
        title={label}
        className={clsx(
          'focus-ring inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3',
          className,
        )}
        data-pitch-link="compact"
      >
        <Mic className="h-[18px] w-[18px]" aria-hidden />
      </Link>
    );
  }
  return (
    <Link
      to={to}
      title={label}
      className={clsx(
        'focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-card transition-colors hover:border-border-strong hover:bg-surface-2 active:bg-surface-3',
        className,
      )}
      data-pitch-link="button"
    >
      <Mic className="h-4 w-4" aria-hidden />
      Pitch
    </Link>
  );
}
