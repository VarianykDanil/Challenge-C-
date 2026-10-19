import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, Mail, MapPin, Phone, UserRound } from 'lucide-react';
import type { Interview } from '@lm/shared';
import { POSITION_LABELS, STAGE_LABELS, needsOutcome } from '@lm/shared';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Skeleton, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useCandidate, useUpdateCandidate, useUpdateInterview, useUsers, type CandidateDetail } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, SourceBadge, StageBadge, StarRating, errorMessage } from '@/features/common';
import { IdleBadge, MoveStageControl, ScheduleInterviewModal, StageStepper } from '@/features/recruitment';
import { OutcomeToRecordRow } from '@/features/recruitment/RecordOutcome';
import { isoToLocalInput, localInputToISO } from '@/lib/dates';
import { formatDate, formatDateTime, formatRelative, fullName } from '@/lib/format';
import { INTERVIEW_OUTCOME_LABELS, INTERVIEW_OUTCOME_TONES, INTERVIEW_TYPE_LABELS, optionsFrom } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';
import { NotFoundPage } from './NotFound';

export function CandidateDetailPage() {
  const { id } = useParams();
  const candidateId = Number(id);
  const me = useCurrentUser();
  const q = useCandidate(Number.isFinite(candidateId) ? candidateId : null);
  const c = q.data;
  usePageTitle(c ? fullName(c) : 'Candidate');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const canWrite = me.role === 'admin' || me.role === 'recruiter' || me.role === 'leader';
  // Interviews that happened (2 h+ ago) and still say "pending": asked for first, with the outcome select inline.
  const toRecord = c ? [...c.interviews].filter((iv) => needsOutcome(iv)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)) : [];

  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage />;

  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/recruitment" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> Recruitment</Link>}
        title={c ? <span className="flex items-center gap-3"><Avatar name={fullName(c)} size="lg" />{fullName(c)}</span> : <Skeleton className="h-7 w-56" />}
        description={c ? `Applied ${formatRelative(c.appliedAt)} for ${POSITION_LABELS[c.positionApplied]} · ${c.daysInPipeline} days in pipeline` : undefined}
        actions={c && canWrite ? (
          <>
            <Button variant="outline" onClick={() => setScheduleOpen(true)} leftIcon={<CalendarPlus className="h-4 w-4" aria-hidden />}>Schedule interview</Button>
            <div className="w-44"><MoveStageControl candidate={c} /></div>
          </>
        ) : undefined}
      />

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load this candidate" />
      ) : !c ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3"><Skeleton className="h-64" /><Skeleton className="h-64 lg:col-span-2" /></div>
      ) : (
        <div className="space-y-6">
          <Card><CardHeader title="Pipeline" description={`Currently at ${STAGE_LABELS[c.stage]} since ${formatDate(c.stageUpdatedAt)}`} actions={<IdleBadge candidate={c} />} /><StageStepper stage={c.stage} /></Card>

          {/* First thing on a phone, above the profile: a past interview that still says pending. */}
          {canWrite && toRecord.length > 0 && (
            <Card>
              <CardHeader
                title="Record the outcome"
                description={toRecord.length === 1 ? 'This interview has happened but still says pending' : `These ${toRecord.length} interviews have happened but still say pending`}
              />
              <ul className="divide-y divide-border">
                {toRecord.map((iv) => <OutcomeToRecordRow key={iv.id} interview={iv} />)}
              </ul>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="min-w-0 space-y-6">
              <Card>
                <CardHeader title="Profile" actions={<StageBadge stage={c.stage} />} />
                <dl className="space-y-3 text-sm">
                  <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted" aria-hidden /><dt className="sr-only">Email</dt><dd><a className="text-primary hover:underline" href={`mailto:${c.email}`}>{c.email}</a></dd></div>
                  <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted" aria-hidden /><dt className="sr-only">Phone</dt><dd>{c.phone ? <a className="text-primary hover:underline" href={`tel:${c.phone}`}>{c.phone}</a> : <span className="text-muted">No phone</span>}</dd></div>
                  <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-muted" aria-hidden /><dt className="sr-only">City</dt><dd>{c.city ?? <span className="text-muted">—</span>}</dd></div>
                  <div className="flex items-center justify-between gap-2 border-t border-border pt-3"><dt className="text-muted">Source</dt><dd className="flex items-center gap-2"><SourceBadge source={c.source} />{c.referredByName && <span className="text-xs text-muted">by {c.referredByName}</span>}</dd></div>
                  <div className="flex items-center justify-between gap-2"><dt className="text-muted">Rating</dt><dd><RatingEditor candidate={c} canWrite={canWrite} /></dd></div>
                  <div className="flex items-center justify-between gap-2"><dt className="text-muted">Owner</dt><dd className="flex items-center gap-2">{c.ownerName ? <><Avatar name={c.ownerName} size="xs" />{c.ownerName}</> : <span className="text-muted">Unassigned</span>}</dd></div>
                  <div className="flex items-center justify-between gap-2"><dt className="text-muted">Position</dt><dd>{POSITION_LABELS[c.positionApplied]}</dd></div>
                  {c.hiredUserId && <div className="flex items-center justify-between gap-2 border-t border-border pt-3"><dt className="text-muted">Hired as</dt><dd><Link to={`/team/${c.hiredUserId}`} className="inline-flex items-center gap-1 text-primary hover:underline"><UserRound className="h-4 w-4" aria-hidden />View profile</Link></dd></div>}
                </dl>
              </Card>
              <NotesForm key={c.id + c.stageUpdatedAt} candidate={c} canWrite={canWrite} />
            </div>

            <div className="min-w-0 space-y-6 lg:col-span-2">
              <Card>
                <CardHeader title="Interviews" description={`${c.interviews.length} scheduled`} actions={canWrite ? <Button size="sm" variant="outline" onClick={() => setScheduleOpen(true)}>Schedule</Button> : undefined} />
                {c.interviews.length === 0 ? (
                  <EmptyState title="No interviews yet" description="Schedule a phone screen or first interview to move things along." size="sm" className="border-0" />
                ) : (
                  <ul className="divide-y divide-border">
                    {[...c.interviews].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map((iv) => <InterviewRow key={iv.id} interview={iv} canWrite={canWrite} />)}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="Timeline" description="Every stage change, newest first" />
                <ol className="relative ml-2 border-l border-border">
                  {[...c.history].sort((a, b) => b.changedAt.localeCompare(a.changedAt)).map((h) => (
                    <li key={h.id} className="relative mb-4 ml-4 last:mb-0">
                      <span className="absolute -left-[22px] top-1 h-3 w-3 rounded-full border-2 border-surface bg-primary" aria-hidden />
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        {h.fromStage && <><Badge tone="neutral">{STAGE_LABELS[h.fromStage]}</Badge><span className="text-muted">→</span></>}
                        <StageBadge stage={h.toStage} />
                        <span className="text-xs text-muted">{formatDateTime(h.changedAt)}{h.changedByName ? ` · ${h.changedByName}` : ''}</span>
                      </div>
                      {h.note && <p className="mt-1 text-sm text-muted">{h.note}</p>}
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        </div>
      )}

      {c && canWrite && <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} candidateId={c.id} defaultType={c.stage === 'applied' || c.stage === 'screening' ? 'phone' : c.stage === 'interview' ? 'observation' : 'first'} />}
    </>
  );
}

function RatingEditor({ candidate, canWrite }: { candidate: CandidateDetail; canWrite: boolean }) {
  const toast = useToast();
  const update = useUpdateCandidate();
  return <StarRating value={candidate.rating} onChange={canWrite ? (v) => update.mutate({ id: candidate.id, rating: v }, { onError: (e) => toast.error('Could not save rating', errorMessage(e)) }) : undefined} />;
}

function InterviewRow({ interview: iv, canWrite }: { interview: Interview; canWrite: boolean }) {
  const toast = useToast();
  const update = useUpdateInterview();
  const upcoming = new Date(iv.scheduledAt).getTime() > Date.now();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-fg">{INTERVIEW_TYPE_LABELS[iv.type]}{upcoming && iv.outcome === 'pending' && <Badge tone="info">Upcoming</Badge>}{needsOutcome(iv) && <Badge tone="warning">Outcome due</Badge>}</div>
        <div className="text-xs text-muted">{formatDateTime(iv.scheduledAt)} · {formatRelative(iv.scheduledAt)}{iv.interviewerName ? ` · with ${iv.interviewerName}` : ''}</div>
        {iv.notes && <p className="mt-1 text-xs text-muted">{iv.notes}</p>}
      </div>
      {canWrite ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="sr-only">Outcome</span>
          <Select value={iv.outcome} onChange={(e) => update.mutate({ id: iv.id, outcome: e.target.value as Interview['outcome'] }, { onSuccess: () => toast.success('Outcome saved'), onError: (err) => toast.error('Could not save outcome', errorMessage(err)) })} options={optionsFrom(INTERVIEW_OUTCOME_LABELS)} size="sm" className="w-32" disabled={update.isPending} />
        </label>
      ) : (
        <Badge tone={INTERVIEW_OUTCOME_TONES[iv.outcome]}>{INTERVIEW_OUTCOME_LABELS[iv.outcome]}</Badge>
      )}
    </li>
  );
}

/**
 * The `datetime-local` value for a deadline. A date-only deadline (the 1.1 stage default) is due by the end of that day,
 * so it shows as 23:59 on it rather than shifting to 01:00 in summer time.
 */
function dueInput(value: string | null | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59` : isoToLocalInput(value);
}

function NotesForm({ candidate, canWrite }: { candidate: CandidateDetail; canWrite: boolean }) {
  const toast = useToast();
  const uid = useId();
  const update = useUpdateCandidate();
  const owners = useUsers({}, { enabled: canWrite });
  const [notes, setNotes] = useState(candidate.notes ?? '');
  const [nextAction, setNextAction] = useState(candidate.nextAction ?? '');
  const [nextAt, setNextAt] = useState(dueInput(candidate.nextActionAt));
  const [ownerId, setOwnerId] = useState(candidate.ownerId ? String(candidate.ownerId) : '');
  const dirty = notes !== (candidate.notes ?? '') || nextAction !== (candidate.nextAction ?? '') || nextAt !== dueInput(candidate.nextActionAt) || ownerId !== (candidate.ownerId ? String(candidate.ownerId) : '');

  useEffect(() => {
    setNotes(candidate.notes ?? '');
    setNextAction(candidate.nextAction ?? '');
    setNextAt(dueInput(candidate.nextActionAt));
    setOwnerId(candidate.ownerId ? String(candidate.ownerId) : '');
  }, [candidate.id, candidate.notes, candidate.nextAction, candidate.nextActionAt, candidate.ownerId]);

  const save = () => {
    update.mutate(
      {
        id: candidate.id, notes: notes.trim() || null, nextAction: nextAction.trim() || null, ownerId: ownerId ? Number(ownerId) : null,
        // only a changed due date is sent, so saving notes never turns a date-only deadline into a timestamp
        ...(nextAt !== dueInput(candidate.nextActionAt) ? { nextActionAt: localInputToISO(nextAt) } : {}),
      },
      { onSuccess: () => toast.success('Candidate updated'), onError: (e) => toast.error('Could not save', errorMessage(e)) },
    );
  };

  return (
    <Card>
      <CardHeader title="Notes & next action" />
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
        <Field label="Notes" htmlFor={`${uid}-notes`}><Textarea id={`${uid}-notes`} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} readOnly={!canWrite} placeholder="Impressions, availability, questions asked…" /></Field>
        <Field label="Next action" htmlFor={`${uid}-next`}><Input id={`${uid}-next`} value={nextAction} onChange={(e) => setNextAction(e.target.value)} readOnly={!canWrite} placeholder="e.g. Call to confirm observation day" /></Field>
        <Field label="Due" htmlFor={`${uid}-due`}><Input id={`${uid}-due`} type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} readOnly={!canWrite} /></Field>
        {canWrite && (
          <Field label="Owner" htmlFor={`${uid}-owner`}><Select id={`${uid}-owner`} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="Unassigned" options={(owners.data ?? []).filter((u) => u.role !== 'rep').map((u) => ({ value: String(u.id), label: fullName(u) }))} /></Field>
        )}
        {canWrite && <div className="flex justify-end"><Button type="submit" size="sm" disabled={!dirty} loading={update.isPending}>Save</Button></div>}
      </form>
    </Card>
  );
}
