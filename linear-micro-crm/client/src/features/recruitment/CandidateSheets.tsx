// Release 1.3 — OWNED BY P7 recruitment-plus. The candidate page's "Questions and answers": every saved interview
// sheet, the questions in the words they were asked (copied when the sheet was first saved, so later edits to the
// question bank never change them) with the interviewer's notes of the answers, the 1–5 scores, and who last changed
// each answer (anyone in recruitment can edit a sheet).
import { Link } from 'react-router-dom';
import type { CandidateSheet } from '@lm/shared';
import { answerChangedLabel } from '@lm/shared';
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui';
import { useCandidateSheets } from '@/api/recruitmentPlus';
import { ErrorState } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { formatDateTime } from '@/lib/format';
import { INTERVIEW_OUTCOME_LABELS, INTERVIEW_OUTCOME_TONES, INTERVIEW_TYPE_LABELS } from '@/lib/labels';

export function CandidateSheetsCard({ candidateId, className }: { candidateId: number; className?: string }) {
  const q = useCandidateSheets(candidateId);
  const sheets = [...(q.data ?? [])].sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
  return (
    <Card className={className} data-testid="candidate-sheets">
      <CardHeader title="Questions and answers" description="Each interview's questions as they were asked, with the interviewer's notes." />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the interview sheets" />
      ) : q.isLoading ? (
        <Skeleton className="h-24" />
      ) : sheets.length === 0 ? (
        <EmptyState title="No sheets written yet" description="Open an interview's sheet to write the answers as you go." size="sm" className="border-0" />
      ) : (
        <div className="space-y-3">
          {sheets.map((s, i) => <SheetBlock key={s.interviewId} sheet={s} open={i === 0} />)}
        </div>
      )}
    </Card>
  );
}

function SheetBlock({ sheet: s, open }: { sheet: CandidateSheet; open: boolean }) {
  return (
    <details open={open} className="group rounded-lg border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-fg">{INTERVIEW_TYPE_LABELS[s.type]}</span>
        <span className="text-xs text-muted">{formatDateTime(s.scheduledAt)}{s.interviewerName ? ` · ${s.interviewerName}` : ''}</span>
        <Badge tone={INTERVIEW_OUTCOME_TONES[s.outcome]} size="sm">{INTERVIEW_OUTCOME_LABELS[s.outcome]}</Badge>
        <span className="ml-auto text-xs text-muted">
          {s.summary.answered} of {s.summary.questions} answered{s.summary.averageScore !== null ? ` · average ${s.summary.averageScore} / 5` : ''}
        </span>
      </summary>
      <ol className="space-y-3 border-t border-border px-3 py-3">
        {s.answers.map((a, i) => (
          <li key={a.id ?? i} className="text-sm">
            <p className="font-medium text-fg">{i + 1}. {a.questionText}</p>
            <p className={a.answer ? 'mt-0.5 whitespace-pre-line text-fg' : 'mt-0.5 italic text-muted'}>{a.answer || 'No answer written'}</p>
            {(a.score !== null || a.updatedAt) && (
              <p className="mt-0.5 text-xs text-muted">{[a.score !== null ? `Score ${a.score} / 5` : null, answerChangedLabel(a, todayISO())].filter(Boolean).join(' · ')}</p>
            )}
          </li>
        ))}
      </ol>
      <div className="border-t border-border px-3 py-2">
        <Link to={`/recruitment/interviews/${s.interviewId}`} className="inline-flex min-h-10 items-center text-sm font-medium text-primary hover:underline">Open the sheet</Link>
      </div>
    </details>
  );
}
