// Release 1.3 — /recruitment/interviews/:id (admin, leader, recruiter) — OWNED BY P7 recruitment-plus. The interviewer
// writes the candidate's answers under each question (and an optional 1–5 score), adds any question they asked that is
// not in the bank, takes off one they did not ask, and records the outcome. Everything saves by itself: 2.5 s after
// typing stops, when an answer box loses focus, straight after a score, and when the page is hidden or left. The
// questions are fixed for this interview as soon as anything is saved (their words are copied), so later edits to the
// question bank never change it.
//
// A sheet can be open on two devices (a laptop tab opened before the interview, a second interviewer on an observation
// day). Each save sends only what this device changed, each question with the answer it started from; the server
// keeps every other question as it is and refuses (409) a question another device changed first. The page then shows
// both versions and the interviewer chooses (Keep mine / Use theirs); every other question keeps saving. After each
// save and each refetch the page takes in what other devices wrote to questions it has not touched. Saves run one at a
// time through features/recruitment/sheetSaveQueue.ts, outside React, so a save queued as the page is left still goes.
// Each save carries this tab's device id and save number, so the server (and the merge here) never takes this tab's
// own earlier save, still on its way, for another device's change. What is not saved as the page is left (words on
// their way, a question in conflict) is kept in this tab (features/recruitment/sheetDrafts.ts) and comes back when the
// sheet is opened again, here or after a reload.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, FileDown, Info, Plus } from 'lucide-react';
import type { InterviewSheet, InterviewSheetConflictDetails, SheetEditRow } from '@lm/shared';
import {
  INTERVIEW_ANSWER_MAX, INTERVIEW_QUESTION_MAX, INTERVIEW_SHEET_MAX_QUESTIONS, POSITION_LABELS, ageOn, answerChangedLabel, businessWhenLabel, interviewChangeText,
  mergeSheetRows, newSheetRow, normaliseQuestionText, sheetConflictMessage, sheetEditRows, sheetLeftConflictMessage, sheetQuestionKey, sheetRowChanged, sheetSavePayload,
  sheetSummary,
} from '@lm/shared';
import { Avatar, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Skeleton, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { putInterviewAnswers, recruitmentPlusKeys, storeSavedSheet, useInterviewSheet } from '@/api/recruitmentPlus';
import { ErrorState, StageBadge, errorMessage } from '@/features/common';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { RecordOpened } from '@/features/audit/RecordOpened';
import { UnderAgeBadge } from '@/features/recruitment/DateOfBirth';
import { QuestionTopicHint } from '@/features/recruitment/QuestionTopicHint';
import { OutcomeSelect } from '@/features/recruitment/RecordOutcome';
import { RescheduleInterviewModal } from '@/features/recruitment/RescheduleInterviewModal';
import { PDF_EXPORTS_READY, downloadSheetPdf } from '@/features/recruitment/pdf';
import { claimSheetDraft, dropSheetDraft, keepSheetDraft, ownsSheetDraft, peekSheetDraft } from '@/features/recruitment/sheetDrafts';
import { SHEET_DEVICE, nextSheetVersion, queueSheetSave } from '@/features/recruitment/sheetSaveQueue';
import { COPY } from '@/content/copy';
import { toISODate, todayISO } from '@/lib/dates';
import { formatDateTime, formatRelative, formatTime } from '@/lib/format';
import { INTERVIEW_TYPE_LABELS } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';
import { NotFoundPage } from './NotFound';

/** Wait this long after the last keystroke before saving. */
const TYPING_SAVE_MS = 2500;
/** Words carried on from a page left unsaved go this soon after the sheet opens again. */
const CARRIED_SAVE_MS = 800;

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

const lastSaved = (sheet: InterviewSheet): string | null => sheet.answers.reduce<string | null>((m, a) => (a.updatedAt && (!m || a.updatedAt > m) ? a.updatedAt : m), null);

function isConflictDetails(v: unknown): v is InterviewSheetConflictDetails {
  return typeof v === 'object' && v !== null && Array.isArray((v as InterviewSheetConflictDetails).conflicts) && typeof (v as InterviewSheetConflictDetails).sheet === 'object';
}

export function InterviewSheetPage() {
  const { id } = useParams();
  const interviewId = Number(id);
  const valid = Number.isInteger(interviewId) && interviewId > 0;
  const q = useInterviewSheet(valid ? interviewId : null);
  usePageTitle(q.data ? `${INTERVIEW_TYPE_LABELS[q.data.interview.type]}: ${q.data.candidate.name}` : COPY.nav.interviewSheet.title);

  if (!valid || (q.isError && q.error instanceof ApiError && q.error.status === 404)) return <NotFoundPage />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load this interview" />;
  if (!q.data) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-7 w-64" />} />
        <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      </>
    );
  }
  return <SheetView key={q.data.interview.id} sheet={q.data} />;
}

/** The questions in conflict, numbered as on the sheet. */
const conflictsOf = (rows: readonly SheetEditRow[]) => rows.flatMap((r, i) => (r.conflict ? [{ key: r.key, number: i + 1, byName: r.conflict.byName }] : []));

function SheetView({ sheet }: { sheet: InterviewSheet }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const iv = sheet.interview;
  /** This page, for the draft it leaves (a page left earlier never writes over a newer page's). */
  const [owner] = useState(() => Symbol(`sheet ${iv.id}`));
  // What this tab left unsaved when the sheet was last open here (a save on its way, a question in conflict). Read
  // once; the page takes it over on mount.
  const [draft] = useState(() => peekSheetDraft(iv.id, userId));
  /** Device ids whose saves are this page's own: this tab's, and those of the page it carries on from. */
  const ownDevices = useRef<ReadonlySet<string>>(new Set([SHEET_DEVICE, ...(draft?.devices ?? [])]));
  // The rows are this page's own: what the server sends is merged in (other devices' words where nothing was typed
  // here), never written over typing.
  const [rows, setRowsState] = useState<SheetEditRow[]>(() =>
    draft ? mergeSheetRows(draft.rows, sheet, { removed: new Set(draft.removed.map((r) => r.key)), own: ownDevices.current }) : sheetEditRows(sheet),
  );
  const rowsRef = useRef(rows);
  /** Questions taken off here and not saved yet. */
  const removedRef = useRef<SheetEditRow[]>(draft?.removed ?? []);
  /** Conflicts already named in a toast after the page was left. */
  const toldConflicts = useRef(new Set<string>());
  /** The questions are fixed on the server (something is saved). */
  const savedRef = useRef(sheet.saved);
  const lastSheet = useRef(sheet);
  /** What the save on its way sent, so a refetch that already holds it is not taken for another device's change. */
  const inFlightSent = useRef<ReadonlyMap<string, { answer: string; score: number | null }> | undefined>(undefined);
  const mounted = useRef(true);
  const [fixed, setFixed] = useState(sheet.saved);
  const [state, setState] = useState<SaveState>(() => (draft && rows.some((r) => !r.conflict && (r.added || sheetRowChanged(r))) ? 'pending' : sheet.saved ? 'saved' : 'idle'));
  const [savedAt, setSavedAt] = useState<string | null>(() => lastSaved(sheet));
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const timer = useRef<number | null>(null);

  const setRows = useCallback((next: SheetEditRow[]) => {
    rowsRef.current = next;
    setRowsState(next);
  }, []);

  /** Something here is not saved yet (a question in conflict waits for the interviewer's choice). */
  const pending = useCallback(() => removedRef.current.length > 0 || rowsRef.current.some((r) => !r.conflict && (r.added || sheetRowChanged(r))), []);

  /** Takes in a sheet from the server: a save's answer (with what it sent), a 409's latest, or a refetch. */
  const absorb = useCallback((server: InterviewSheet, sent?: ReadonlyMap<string, { answer: string; score: number | null }>) => {
    lastSheet.current = server;
    savedRef.current = server.saved;
    setRows(mergeSheetRows(rowsRef.current, server, { sent, removed: new Set(removedRef.current.map((r) => r.key)), own: ownDevices.current }));
    if (mounted.current) setFixed(server.saved);
  }, [setRows]);

  /** Keeps what is not saved in this tab for the next time the sheet opens (or drops the draft when all is saved). */
  const keepDraft = useCallback(() => {
    if (userId === null) return;
    // This tab's id first, then the pages it carried on from (the last few are plenty: older saves are long settled).
    keepSheetDraft(iv.id, owner, { userId, rows: rowsRef.current, removed: removedRef.current, devices: [...ownDevices.current].slice(0, 8) });
  }, [iv.id, owner, userId]);

  /** After the page was left (no newer sheet page open here): keep the draft up to date, and name new conflicts. */
  const afterLeft = useCallback(() => {
    if (!ownsSheetDraft(iv.id, owner)) return;
    keepDraft();
    const fresh = conflictsOf(rowsRef.current).filter((c) => !toldConflicts.current.has(c.key));
    for (const c of fresh) toldConflicts.current.add(c.key);
    if (fresh.length) toast.error(sheetLeftConflictMessage(fresh));
  }, [iv.id, keepDraft, owner, toast]);

  const settle = useCallback(() => {
    if (mounted.current) setState(pending() ? 'pending' : 'saved');
  }, [pending]);

  /** One save: builds its payload now, from the latest rows. Runs through the queue (one at a time), or straight away as the tab closes. */
  const runSave = useCallback(async ({ keepalive = false }: { keepalive?: boolean } = {}) => {
    if (!pending()) return;
    // A save still on its way (only as the tab closes: otherwise saves run one at a time) is what this one follows.
    const payload = sheetSavePayload(rowsRef.current, removedRef.current, savedRef.current, { inFlight: inFlightSent.current, from: { device: SHEET_DEVICE, version: nextSheetVersion() } });
    if (!payload.length) return;
    const sent = new Map(payload.filter((p) => !p.removed).map((p) => [sheetQuestionKey(p.questionId, p.questionText ?? ''), { answer: p.answer, score: p.score ?? null }]));
    const sentRemoved = new Set(payload.filter((p) => p.removed).map((p) => sheetQuestionKey(p.questionId, p.questionText ?? '')));
    if (mounted.current) setState('saving');
    inFlightSent.current = sent;
    try {
      // Merged into the rows before it goes into the cache, so the page never takes its own save for someone else's.
      const fresh = await putInterviewAnswers(null, iv.id, payload, { keepalive });
      // A refetch still on its way may hold the sheet from before this save: drop it (this answer is newer).
      void qc.cancelQueries({ queryKey: recruitmentPlusKeys.sheet(iv.id) });
      removedRef.current = removedRef.current.filter((r) => !sentRemoved.has(r.key));
      absorb(fresh, sent);
      storeSavedSheet(qc, fresh);
      if (mounted.current) {
        setSavedAt(new Date().toISOString());
        setError(null);
      } else {
        afterLeft();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && isConflictDetails(e.details)) {
        // A question taken off here that another device has answered comes back with their answer.
        const clashed = new Set(e.details.conflicts.map((c) => sheetQuestionKey(c.questionId, c.questionText)));
        removedRef.current = removedRef.current.filter((r) => !clashed.has(r.key));
        absorb(e.details.sheet, sent);
        storeSavedSheet(qc, e.details.sheet);
        // Left already: the question in conflict is kept here (with both versions) for when the sheet opens again.
        if (!mounted.current) afterLeft();
        // Nothing was written: the other questions go again straight away (the ones in conflict wait for the choice).
        if (pending()) void queueSheetSave(iv.id, () => runSaveRef.current());
      } else {
        if (mounted.current) {
          setError(errorMessage(e));
          setState('error');
        } else if (ownsSheetDraft(iv.id, owner)) {
          // (A sheet page opened again since saves them itself.)
          keepDraft();
          toast.error('The interview sheet was not saved', `${errorMessage(e).replace(/\.$/, '')}. Your words are kept on this device: open the sheet again to save them.`);
        }
        return;
      }
    } finally {
      inFlightSent.current = undefined;
    }
    settle();
  }, [absorb, afterLeft, iv.id, keepDraft, owner, pending, qc, settle, toast]);
  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!pending()) return;
    void queueSheetSave(iv.id, () => runSaveRef.current());
  }, [iv.id, pending]);

  const later = useCallback((ms: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, ms);
  }, [flush]);

  // A refetch (an outcome saved, a reschedule, the page opened again while an earlier save was finishing) is merged in.
  useEffect(() => {
    if (sheet !== lastSheet.current) absorb(sheet, inFlightSent.current);
  }, [sheet, absorb]);

  // Putting the phone away saves what is there; closing or reloading the tab sends it at once (keepalive), even with a
  // save on its way (the server knows this tab's own earlier save by its device id: no conflict), and keeps it in this
  // tab for a reload; leaving the page queues it after any save on its way, and keeps what is not saved (a question in
  // conflict, named in a toast) for when the sheet opens again.
  useEffect(() => {
    mounted.current = true;
    claimSheetDraft(iv.id, owner);
    if (pending()) later(CARRIED_SAVE_MS); // words carried on from the page left before
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      keepDraft();
      if (pending()) void runSaveRef.current({ keepalive: true });
    };
    // Back from the browser's page cache: this page carries on, so the draft it left for a reload must not linger.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted && ownsSheetDraft(iv.id, owner)) dropSheetDraft(iv.id);
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      keepDraft();
      const open = conflictsOf(rowsRef.current);
      for (const c of open) toldConflicts.current.add(c.key);
      // A tick later, so a development double mount (which mounts straight back) says nothing.
      if (open.length) window.setTimeout(() => mounted.current || toast.error(sheetLeftConflictMessage(open)), 0);
      if (pending()) void queueSheetSave(iv.id, () => runSaveRef.current());
    };
  }, [flush, iv.id, keepDraft, later, owner, pending, toast]);

  const change = (next: SheetEditRow[], ms: number) => {
    setRows(next);
    setState('pending');
    later(ms);
  };
  const edit = (key: string, patch: Partial<SheetEditRow>, ms = TYPING_SAVE_MS) => change(rowsRef.current.map((r) => (r.key === key ? { ...r, ...patch } : r)), ms);

  const addOwn = (text: string) => {
    const row = newSheetRow(text);
    if (rowsRef.current.some((r) => r.key === row.key)) {
      toast.error('That question is already on the sheet');
      return false;
    }
    // Taken off a moment ago and not saved yet: it simply comes back.
    const undone = removedRef.current.find((r) => r.key === row.key);
    removedRef.current = removedRef.current.filter((r) => r.key !== row.key);
    change([...rowsRef.current, undone ?? row], 50);
    return true;
  };
  const remove = (key: string) => {
    const row = rowsRef.current.find((r) => r.key === key);
    if (!row || rowsRef.current.length <= 1) return;
    removedRef.current = [...removedRef.current, row];
    change(rowsRef.current.filter((r) => r.key !== key), 50);
  };
  const keepMine = (key: string) => {
    const c = rowsRef.current.find((r) => r.key === key)?.conflict;
    if (c) edit(key, { base: { answer: c.answer, score: c.score }, conflict: null }, 50);
  };
  const useTheirs = (key: string) => {
    const c = rowsRef.current.find((r) => r.key === key)?.conflict;
    if (!c) return;
    setRows(rowsRef.current.map((r) => (r.key === key ? { ...r, answer: c.answer, score: c.score, base: { answer: c.answer, score: c.score }, updatedAt: c.at, updatedByName: c.byName, conflict: null } : r)));
    settle();
  };

  const summary = sheetSummary(rows);
  const age = sheet.candidate.dateOfBirth ? ageOn(sheet.candidate.dateOfBirth, todayISO()) : null;
  const conflicts = conflictsOf(rows);

  return (
    <>
      <ErrorBoundary name="sheet-opened" fallback={null}><RecordOpened entity="candidate" entityId={sheet.candidate.id} what="interview sheet" /></ErrorBoundary>
      <PageHeader
        breadcrumbs={<Link to={`/recruitment/${sheet.candidate.id}`} className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> {sheet.candidate.name}</Link>}
        title={`${INTERVIEW_TYPE_LABELS[iv.type]}: ${sheet.candidate.name}`}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{businessWhenLabel(iv.scheduledAt, todayISO())} · {formatRelative(iv.scheduledAt)}{iv.interviewerName ? ` · with ${iv.interviewerName}` : ' · no interviewer yet'}</span>
            <UnderAgeBadge dateOfBirth={sheet.candidate.dateOfBirth} />
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setMoving(true)} leftIcon={<CalendarClock className="h-4 w-4" aria-hidden />}>Reschedule</Button>
            {PDF_EXPORTS_READY && (
              <Button
                variant="outline"
                leftIcon={<FileDown className="h-4 w-4" aria-hidden />}
                onClick={() => {
                  flush();
                  const current = { ...sheet, answers: rows.map((r, i) => ({ interviewId: iv.id, questionId: r.questionId, questionText: r.questionText, answer: r.answer, score: r.score, updatedAt: r.updatedAt, updatedByName: r.updatedByName, sort: i })), summary };
                  downloadSheetPdf(current).catch((e) => toast.error('Could not make the PDF', errorMessage(e)));
                }}
              >
                PDF
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {!fixed && (
            <Card tone="info" padded={false} className="flex items-start gap-3 p-4" role="note">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
              <p className="text-sm text-fg">These are today's {INTERVIEW_TYPE_LABELS[iv.type].toLowerCase()} questions. They are fixed for this interview as soon as anything on the sheet is saved, so later changes to the question bank never change it.</p>
            </Card>
          )}

          <ol className="space-y-4" aria-label="Questions" data-testid="sheet-questions">
            {rows.map((r, i) => (
              <QuestionCard
                key={r.key}
                row={r}
                index={i}
                canRemove={rows.length > 1 && !r.conflict && r.answer.trim() === '' && r.score === null}
                onAnswer={(answer) => edit(r.key, { answer })}
                onScore={(score) => edit(r.key, { score }, 300)}
                onBlur={flush}
                onRemove={() => remove(r.key)}
                onKeepMine={() => keepMine(r.key)}
                onUseTheirs={() => useTheirs(r.key)}
              />
            ))}
          </ol>

          {rows.length < INTERVIEW_SHEET_MAX_QUESTIONS && <AddOwnQuestion onAdd={addOwn} />}
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="lg:sticky lg:top-4" data-testid="sheet-info">
            <CardHeader title="This interview" />
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Candidate</dt>
                <dd className="flex flex-wrap items-center justify-end gap-2 text-right">
                  <Link to={`/recruitment/${sheet.candidate.id}`} className="font-medium text-primary hover:underline max-sm:inline-flex max-sm:min-h-10 max-sm:items-center">{sheet.candidate.name}</Link>
                  <StageBadge stage={sheet.candidate.stage} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2"><dt className="text-muted">Applied for</dt><dd>{POSITION_LABELS[sheet.candidate.positionApplied]}</dd></div>
              {age !== null && (
                <div className="flex items-center justify-between gap-2"><dt className="text-muted">Age</dt><dd className="flex items-center gap-2">{age}<UnderAgeBadge dateOfBirth={sheet.candidate.dateOfBirth} /></dd></div>
              )}
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Interviewer</dt>
                <dd className="flex items-center gap-2">{iv.interviewerName ? <><Avatar name={iv.interviewerName} size="xs" />{iv.interviewerName}</> : <Badge tone="warning">No interviewer yet</Badge>}</dd>
              </div>
              <div className="border-t border-border pt-3">
                <dt className="mb-1.5 text-muted">Outcome</dt>
                <dd><OutcomeSelect interview={iv} label={`Outcome of the ${INTERVIEW_TYPE_LABELS[iv.type].toLowerCase()}`} /></dd>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                <dt className="text-muted">Answered</dt>
                <dd>{summary.answered} of {summary.questions}{summary.averageScore !== null ? ` · average ${summary.averageScore} / 5` : ''}</dd>
              </div>
            </dl>
            <SaveStatus state={state} savedAt={savedAt} error={error} conflict={conflicts.length ? sheetConflictMessage(conflicts) : null} onRetry={flush} />
          </Card>

          {sheet.changes.length > 0 && (
            <Card>
              <CardHeader title="History" description="Bookings, moves, interviewers and outcomes" />
              <ol className="space-y-2 text-sm">
                {[...sheet.changes].reverse().map((c) => (
                  <li key={c.id}>
                    <p className="text-fg">{interviewChangeText(c, iv.type)}</p>
                    <p className="text-xs text-muted">{formatDateTime(c.changedAt)}</p>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      </div>

      <RescheduleInterviewModal open={moving} interview={iv} candidateName={sheet.candidate.name} onClose={() => setMoving(false)} />
    </>
  );
}

/** "Saved 10:42" today; "Last saved Tue 20 Oct, 13:44" on another day. */
function savedLabel(iso: string): string {
  return toISODate(new Date(iso)) === todayISO() ? `Saved ${formatTime(iso)}` : `Last saved ${businessWhenLabel(iso, todayISO())}`;
}

function SaveStatus({ state, savedAt, error, conflict, onRetry }: { state: SaveState; savedAt: string | null; error: string | null; conflict: string | null; onRetry: () => void }) {
  return (
    <div className="mt-4 flex min-h-10 flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs" aria-live="polite">
      {state === 'error' ? (
        <>
          <span className="font-medium text-danger">Not saved{error ? `: ${error}` : ''}</span>
          <Button size="sm" variant="outline" className="max-sm:h-10" onClick={onRetry}>Try again</Button>
        </>
      ) : (
        <span className="text-muted">
          {state === 'saving' ? 'Saving…' : state === 'pending' ? 'Saving shortly…' : savedAt ? savedLabel(savedAt) : 'Nothing written yet. Answers save by themselves.'}
        </span>
      )}
      {conflict && <span className="w-full font-medium text-warning" data-testid="sheet-conflict">{conflict}</span>}
    </div>
  );
}

function QuestionCard({ row, index, canRemove, onAnswer, onScore, onBlur, onRemove, onKeepMine, onUseTheirs }: {
  row: SheetEditRow;
  index: number;
  canRemove: boolean;
  onAnswer: (answer: string) => void;
  onScore: (score: number | null) => void;
  onBlur: () => void;
  onRemove: () => void;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}) {
  const uid = useId();
  // In conflict, the box holds this device's words, not saved yet: not "Last changed by" whoever wrote the other version.
  const changed = row.conflict ? 'Not saved yet' : answerChangedLabel(row, todayISO());
  return (
    <li>
      <Card>
        <div className="mb-3">
          <label htmlFor={`${uid}-answer`} className="text-sm font-semibold text-fg">
            <span className="mr-1 tabular-nums text-muted">{index + 1}.</span>
            {row.questionText}
            {row.questionId === null && <Badge tone="neutral" size="sm" className="ml-2 align-middle">Your question</Badge>}
          </label>
        </div>
        <Textarea
          id={`${uid}-answer`}
          rows={3}
          value={row.answer}
          maxLength={INTERVIEW_ANSWER_MAX}
          onChange={(e) => onAnswer(e.target.value)}
          onBlur={onBlur}
          placeholder="Their answer, in a few words"
          aria-describedby={changed ? `${uid}-changed` : undefined}
        />
        {changed && <p id={`${uid}-changed`} className="mt-1 text-xs text-muted" data-testid="answer-changed">{changed}</p>}
        {row.conflict && (
          <div role="alert" className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="answer-conflict">
            <p className="font-medium text-fg">
              {row.conflict.byName ?? 'Someone'} changed this on another device{row.conflict.at ? `, ${businessWhenLabel(row.conflict.at, todayISO())}` : ''}. Their answer:
            </p>
            <p className={row.conflict.answer ? 'mt-1 whitespace-pre-line text-fg' : 'mt-1 italic text-muted'}>
              {row.conflict.answer || 'No answer written'}{row.conflict.score !== null ? ` · score ${row.conflict.score} / 5` : ''}
            </p>
            <p className="mt-1 text-xs text-muted">Yours is in the box above. This question is not saved until you choose.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" className="max-sm:h-10" onClick={onKeepMine}>Keep mine</Button>
              <Button size="sm" variant="outline" className="max-sm:h-10" onClick={onUseTheirs}>Use theirs</Button>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={`Score for question ${index + 1}`}>
          <span className="mr-1 text-xs text-muted">Score <span className="sr-only">(optional)</span></span>
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={row.score === s}
              aria-label={`Score ${s} of 5`}
              onClick={() => onScore(row.score === s ? null : s)}
              className={
                row.score === s
                  ? 'focus-ring h-10 w-10 rounded-lg bg-primary text-sm font-semibold text-primary-fg shadow-card sm:h-9 sm:w-9'
                  : 'focus-ring h-10 w-10 rounded-lg border border-border bg-surface text-sm font-medium text-fg hover:bg-surface-2 sm:h-9 sm:w-9'
              }
            >
              {s}
            </button>
          ))}
          {row.score !== null && <span className="text-xs text-muted">Tap again to clear</span>}
          {canRemove && <Button size="sm" variant="ghost" className="ml-auto max-sm:h-10" onClick={onRemove}>Not asked</Button>}
        </div>
      </Card>
    </li>
  );
}

function AddOwnQuestion({ onAdd }: { onAdd: (text: string) => boolean }) {
  const uid = useId();
  const [text, setText] = useState('');
  const clean = normaliseQuestionText(text);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length >= 5 && onAdd(clean)) setText('');
      }}
      className="space-y-3 rounded-xl border border-dashed border-border p-4"
      data-testid="sheet-add-question"
    >
      <Field label="Add a question you asked" htmlFor={`${uid}-own`} hint="For a question that is not on the sheet. It is saved with this interview only.">
        <Input id={`${uid}-own`} value={text} onChange={(e) => setText(e.target.value)} maxLength={INTERVIEW_QUESTION_MAX} placeholder="e.g. Could you do Saturdays in December?" />
      </Field>
      <QuestionTopicHint text={text} />
      <div className="flex justify-end">
        <Button type="submit" variant="outline" leftIcon={<Plus className="h-4 w-4" aria-hidden />} disabled={clean.length < 5}>Add question</Button>
      </div>
    </form>
  );
}
