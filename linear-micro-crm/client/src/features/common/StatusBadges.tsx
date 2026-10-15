// Small badge wrappers so every page renders statuses the same way.
import type { CandidateSource, CandidateStage, EventStatus, EventType, PayrollStatus, UserStatus } from '@lm/shared';
import { EVENT_TYPE_LABELS, SOURCE_LABELS, STAGE_LABELS } from '@lm/shared';
import { CheckCircle2, Clock, MinusCircle } from 'lucide-react';
import { Badge } from '@/components/ui';
import {
  EVENT_STATUS_LABELS,
  EVENT_STATUS_TONES,
  PAYROLL_STATUS_LABELS,
  PAYROLL_STATUS_TONES,
  STAGE_TONES,
  USER_STATUS_LABELS,
  USER_STATUS_TONES,
} from '@/lib/labels';

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge tone={EVENT_STATUS_TONES[status]} dot={status === 'live'}>{EVENT_STATUS_LABELS[status]}</Badge>;
}
export function EventTypeBadge({ type }: { type: EventType }) {
  return <Badge tone="neutral">{EVENT_TYPE_LABELS[type]}</Badge>;
}
export function PayrollStatusBadge({ status }: { status: PayrollStatus }) {
  return <Badge tone={PAYROLL_STATUS_TONES[status]}>{PAYROLL_STATUS_LABELS[status]}</Badge>;
}
export function UserStatusBadge({ status }: { status: UserStatus }) {
  return <Badge tone={USER_STATUS_TONES[status]}>{USER_STATUS_LABELS[status]}</Badge>;
}
export function StageBadge({ stage }: { stage: CandidateStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>;
}
export function SourceBadge({ source }: { source: CandidateSource }) {
  return <Badge tone={source === 'referral' ? 'accent' : 'neutral'}>{SOURCE_LABELS[source]}</Badge>;
}

/** Punctuality indicator: true = on time, false = late, null = not recorded. Colour is never the only signal. */
export function OnTimeBadge({ value, labels = { yes: 'On time', no: 'Late', none: 'Not recorded' } }: { value: boolean | null; labels?: { yes: string; no: string; none: string } }) {
  if (value === null) return <Badge tone="neutral"><MinusCircle className="h-3 w-3" aria-hidden />{labels.none}</Badge>;
  return value ? (
    <Badge tone="success"><CheckCircle2 className="h-3 w-3" aria-hidden />{labels.yes}</Badge>
  ) : (
    <Badge tone="danger"><Clock className="h-3 w-3" aria-hidden />{labels.no}</Badge>
  );
}

/** Colour swatch + label, for campaigns and teams (seeded colours are the one allowed inline style). */
export function ColourChip({ color, label, className }: { color: string | null | undefined; label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-border" style={color ? { backgroundColor: color } : undefined} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
