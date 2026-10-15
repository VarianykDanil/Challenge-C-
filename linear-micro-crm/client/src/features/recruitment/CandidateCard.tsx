import { Link } from 'react-router-dom';
import { AlertCircle, Clock } from 'lucide-react';
import type { CandidateWithMeta } from '@lm/shared';
import { isOpenStage, isOverdue as sharedIsOverdue } from '@lm/shared';
import { Avatar } from '@/components/ui';
import { SourceBadge, StarRating } from '@/features/common';
import { fullName } from '@/lib/format';
import { MoveStageControl } from './MoveStageControl';

/** Open candidate whose next action date has passed (shared rule). */
export function isOverdue(c: CandidateWithMeta): boolean {
  return isOpenStage(c.stage) && sharedIsOverdue(c.nextActionAt);
}

export function CandidateCard({ candidate: c, canMove }: { candidate: CandidateWithMeta; canMove: boolean }) {
  const overdue = isOverdue(c);
  return (
    <li className="rounded-lg border border-border bg-surface p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/recruitment/${c.id}`} className="min-w-0 text-sm font-semibold text-fg hover:underline">
          {overdue && <AlertCircle className="mr-1 inline h-3.5 w-3.5 text-danger" aria-label="Next action overdue" />}
          {fullName(c)}
        </Link>
        {c.ownerName ? <Avatar name={c.ownerName} size="xs" className="shrink-0" /> : <span className="h-6 w-6 shrink-0 rounded-full border border-dashed border-border" title="Unassigned" aria-label="Unassigned" />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <SourceBadge source={c.source} />
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden />{c.daysInPipeline}d</span>
        {c.rating != null && <StarRating value={c.rating} size="sm" />}
      </div>
      {c.nextAction && <p className={`mt-2 truncate text-xs ${overdue ? 'text-danger' : 'text-muted'}`} title={c.nextAction}>Next: {c.nextAction}</p>}
      {canMove && <div className="mt-2"><MoveStageControl candidate={c} compact /></div>}
    </li>
  );
}
