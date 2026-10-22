// Release 1.3 — OWNED BY P7 recruitment-plus. The candidate's whole story, newest first (GET
// /recruitment/candidates/:id/timeline): every stage with who moved it, every interview with its interviewer and
// outcome, bookings, reassignments ("Interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah"),
// reschedules and outcomes. The wording comes from the server (shared buildCandidateTimeline).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, CalendarClock, CalendarPlus, CheckCircle2, Flag, MessagesSquare, UserPlus, UserRoundCog } from 'lucide-react';
import type { CandidateTimelineItem, CandidateTimelineKind } from '@lm/shared';
import { Badge, Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { useCandidateTimeline } from '@/api/recruitmentPlus';
import { ErrorState, StageBadge } from '@/features/common';
import { formatDateTime, formatRelative } from '@/lib/format';
import { INTERVIEW_OUTCOME_LABELS, INTERVIEW_OUTCOME_TONES } from '@/lib/labels';

const ICONS: Record<CandidateTimelineKind, typeof Flag> = {
  applied: UserPlus,
  stage: ArrowRightLeft,
  booked: CalendarPlus,
  interviewer: UserRoundCog,
  reschedule: CalendarClock,
  interview: MessagesSquare,
  outcome: CheckCircle2,
};

/** First this many items; "Show all" for the rest. */
const FIRST = 12;

export function CandidateTimelineCard({ candidateId, className }: { candidateId: number; className?: string }) {
  const q = useCandidateTimeline(candidateId);
  const [all, setAll] = useState(false);
  const items = q.data ?? [];
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <Card className={className} data-testid="candidate-timeline">
      <CardHeader title="Timeline" description="Every stage, interview and change, with who made it. Newest first." />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the timeline" />
      ) : q.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : (
        <>
          <ol className="relative ml-2 border-l border-border">
            {shown.map((item, i) => <TimelineRow key={`${item.kind}-${item.at}-${i}`} item={item} />)}
          </ol>
          {items.length > FIRST && (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function TimelineRow({ item }: { item: CandidateTimelineItem }) {
  const Icon = ICONS[item.kind];
  const upcoming = item.kind === 'interview' && new Date(item.at).getTime() > Date.now();
  return (
    <li className="relative mb-4 ml-5 last:mb-0">
      <span className="absolute -left-[31px] top-0 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted [&_svg]:h-3 [&_svg]:w-3" aria-hidden>
        <Icon />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg">
        <span className="min-w-0 break-words">{item.text}</span>
        {item.kind === 'stage' && item.stage && <StageBadge stage={item.stage} />}
        {item.kind === 'interview' && item.outcome && (
          upcoming && item.outcome === 'pending' ? <Badge tone="info">Upcoming</Badge> : <Badge tone={INTERVIEW_OUTCOME_TONES[item.outcome]}>{INTERVIEW_OUTCOME_LABELS[item.outcome]}</Badge>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
        <time dateTime={item.at}>{formatDateTime(item.at)} · {formatRelative(item.at)}</time>
        {item.kind === 'interview' && item.interviewId && (
          <Link to={`/recruitment/interviews/${item.interviewId}`} className="font-medium text-primary hover:underline max-sm:inline-flex max-sm:min-h-10 max-sm:items-center">Open the sheet</Link>
        )}
      </div>
      {item.detail && <p className="mt-1 text-sm text-muted">{item.detail}</p>}
    </li>
  );
}
