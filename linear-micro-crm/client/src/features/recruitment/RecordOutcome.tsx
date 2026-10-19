// "Record the outcome" (1.1, p8): interviews the shared rule says still need an outcome (`needsOutcome`: pending, at
// least two hours after the start, within the last 56 days), each with the outcome select inline so it can be saved
// without opening anything. Used on the candidate page; the dashboard asks through the Needs attention card instead.
import { Link } from 'react-router-dom';
import { ClipboardPen } from 'lucide-react';
import type { Interview } from '@lm/shared';
import { Select, useToast } from '@/components/ui';
import { useUpdateInterview } from '@/api/hooks';
import { errorMessage } from '@/features/common';
import { formatDateTime, formatRelative } from '@/lib/format';
import { INTERVIEW_OUTCOME_LABELS, INTERVIEW_TYPE_LABELS, optionsFrom } from '@/lib/labels';

/** The existing outcome select, saving on change through useUpdateInterview. */
export function OutcomeSelect({ interview: iv, label, size = 'md', className }: { interview: Interview; label: string; size?: 'sm' | 'md'; className?: string }) {
  const toast = useToast();
  const update = useUpdateInterview();
  return (
    <Select
      aria-label={label}
      value={iv.outcome}
      onChange={(e) => {
        const outcome = e.target.value as Interview['outcome'];
        update.mutate(
          { id: iv.id, outcome },
          {
            onSuccess: () => toast.success('Outcome saved', `${INTERVIEW_TYPE_LABELS[iv.type]} · ${INTERVIEW_OUTCOME_LABELS[outcome]}`),
            onError: (err) => toast.error('Could not save outcome', errorMessage(err)),
          },
        );
      }}
      options={optionsFrom(INTERVIEW_OUTCOME_LABELS)}
      size={size}
      className={className}
      disabled={update.isPending}
    />
  );
}

/** One interview waiting for its outcome; with `candidateName` the row also links to the candidate (dashboard use). */
export function OutcomeToRecordRow({ interview: iv, candidateName }: { interview: Interview; candidateName?: string }) {
  const what = INTERVIEW_TYPE_LABELS[iv.type];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <ClipboardPen className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        {candidateName && (
          <Link to={`/recruitment/${iv.candidateId}`} className="block truncate text-sm font-medium text-fg hover:underline">{candidateName}</Link>
        )}
        <p className={candidateName ? 'text-xs text-muted' : 'text-sm font-medium text-fg'}>{what} · {formatDateTime(iv.scheduledAt)}</p>
        <p className="text-xs text-muted">{formatRelative(iv.scheduledAt)}{iv.interviewerName ? ` · with ${iv.interviewerName}` : ''}</p>
      </div>
      <div className="w-full sm:w-40">
        <OutcomeSelect interview={iv} label={`Outcome of ${candidateName ? `${candidateName}'s ` : 'the '}${what.toLowerCase()} on ${formatDateTime(iv.scheduledAt)}`} />
      </div>
    </li>
  );
}
