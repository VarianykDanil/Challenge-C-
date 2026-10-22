// Release 1.3 slot — OWNED BY P7 recruitment-plus. Settings → Recruitment (admin, recruiter): the interview question
// sets per interview type, ordered, in use / turned off, optionally for one position. Each interview sheet starts with
// the questions in use for its type; a sheet keeps its words once anything is saved on it, so edits here never change
// a past interview. Mounted in pages/Settings.tsx (left column, after Settings → Invoices) in an ErrorBoundary with
// fallback={null}; renders the whole Card.
import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus } from 'lucide-react';
import type { InterviewQuestion, InterviewType, Position } from '@lm/shared';
import { INTERVIEW_QUESTION_MAX, INTERVIEW_TYPE_NAMES, INTERVIEW_TYPE_ORDER, POSITION_LABELS, normaliseQuestionText } from '@lm/shared';
import { Badge, Button, Card, CardHeader, Field, Input, SegmentedControl, Select, Skeleton, useToast } from '@/components/ui';
import { useInterviewQuestions, useReorderInterviewQuestions, useSaveInterviewQuestion } from '@/api/recruitmentPlus';
import { ErrorState, errorMessage } from '@/features/common';
import { ENTRY_POSITIONS } from '@/lib/labels';
import { QuestionTopicHint } from './QuestionTopicHint';

export interface QuestionBankSectionProps {
  className?: string;
}

const TYPE_OPTIONS = INTERVIEW_TYPE_ORDER.map((t) => ({ value: t, label: INTERVIEW_TYPE_NAMES[t] }));
const POSITION_OPTIONS = [{ value: '', label: 'Every position' }, ...[...ENTRY_POSITIONS, 'team_leader' as Position].map((p) => ({ value: p, label: POSITION_LABELS[p] }))];

export function QuestionBankSection({ className }: QuestionBankSectionProps) {
  const [type, setType] = useState<InterviewType>('phone');
  const q = useInterviewQuestions(type);
  const list = q.data ?? [];
  const inUse = list.filter((x) => x.active).length;

  return (
    <Card className={className} data-testid="question-bank">
      <CardHeader
        icon={<ListChecks aria-hidden />}
        title="Recruitment: interview questions"
        description="Every interview sheet starts with the questions in use for its type. Ask about the job only: never age, health, family, religion or where someone is from."
      />
      <div className="mb-4">
        <div className="sm:hidden">
          <Select aria-label="Interview type" value={type} onChange={(e) => setType(e.target.value as InterviewType)} options={TYPE_OPTIONS} />
        </div>
        <div className="hidden sm:block">
          <SegmentedControl aria-label="Interview type" size="sm" value={type} onChange={setType} options={TYPE_OPTIONS} />
        </div>
      </div>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the questions" />
      ) : q.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted">
            {INTERVIEW_TYPE_NAMES[type]}: {inUse} {inUse === 1 ? 'question' : 'questions'} in use{list.length > inUse ? `, ${list.length - inUse} turned off` : ''}.
          </p>
          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted">No questions for this interview yet. Add the first one below.</p>
          ) : (
            <ol className="divide-y divide-border rounded-lg border border-border">
              {list.map((item, i) => <QuestionRow key={item.id} question={item} index={i} all={list} />)}
            </ol>
          )}
          <AddQuestionForm type={type} />
        </>
      )}
    </Card>
  );
}

function QuestionRow({ question, index, all }: { question: InterviewQuestion; index: number; all: InterviewQuestion[] }) {
  const toast = useToast();
  const uid = useId();
  const save = useSaveInterviewQuestion();
  const reorder = useReorderInterviewQuestions();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(question.text);
  const [position, setPosition] = useState<string>(question.position ?? '');

  const move = (delta: -1 | 1) => {
    const ids = all.map((x) => x.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate({ interviewType: question.interviewType, ids }, { onError: (e) => toast.error('Could not move the question', errorMessage(e)) });
  };

  const submit = () => {
    const clean = normaliseQuestionText(text);
    save.mutate(
      { id: question.id, text: clean, position: (position || null) as Position | null },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success('Question saved', 'Sheets already started keep the words they were asked with.');
        },
        onError: (e) => toast.error('Could not save the question', errorMessage(e)),
      },
    );
  };

  if (editing) {
    return (
      <li className="space-y-3 p-3">
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
          <Field label={`Question ${index + 1}`} htmlFor={`${uid}-text`}>
            <Input id={`${uid}-text`} value={text} onChange={(e) => setText(e.target.value)} maxLength={INTERVIEW_QUESTION_MAX} autoFocus />
          </Field>
          <QuestionTopicHint text={text} />
          <Field label="Asked of" htmlFor={`${uid}-pos`}><Select id={`${uid}-pos`} value={position} onChange={(e) => setPosition(e.target.value)} options={POSITION_OPTIONS} /></Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => { setEditing(false); setText(question.text); setPosition(question.position ?? ''); }}>Cancel</Button>
            <Button type="submit" loading={save.isPending} disabled={normaliseQuestionText(text).length < 5}>Save question</Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 gap-2">
        <span className="mt-0.5 w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-muted">{index + 1}.</span>
        <div className="min-w-0">
          <p className={question.active ? 'text-sm text-fg' : 'text-sm text-muted line-through decoration-muted/60'}>{question.text}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {question.position && <Badge tone="info" size="sm">{POSITION_LABELS[question.position]} only</Badge>}
            {!question.active && <Badge tone="neutral" size="sm">Turned off</Badge>}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
        <Button size="icon" variant="ghost" label={`Move question ${index + 1} up`} onClick={() => move(-1)} disabled={index === 0 || reorder.isPending}><ArrowUp aria-hidden /></Button>
        <Button size="icon" variant="ghost" label={`Move question ${index + 1} down`} onClick={() => move(1)} disabled={index === all.length - 1 || reorder.isPending}><ArrowDown aria-hidden /></Button>
        <Button size="icon" variant="ghost" label={`Edit question ${index + 1}`} onClick={() => setEditing(true)}><Pencil aria-hidden /></Button>
        <Button
          variant="outline"
          onClick={() => save.mutate({ id: question.id, active: !question.active }, { onError: (e) => toast.error('Could not change the question', errorMessage(e)) })}
          loading={save.isPending}
          className="w-24"
        >
          {question.active ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </li>
  );
}

function AddQuestionForm({ type }: { type: InterviewType }) {
  const toast = useToast();
  const uid = useId();
  const save = useSaveInterviewQuestion();
  const [text, setText] = useState('');
  const [position, setPosition] = useState('');
  const clean = normaliseQuestionText(text);

  const submit = () => {
    if (clean.length < 5) return;
    save.mutate(
      { interviewType: type, text: clean, position: (position || null) as Position | null },
      {
        onSuccess: () => {
          setText('');
          toast.success('Question added', `It is on every new ${INTERVIEW_TYPE_NAMES[type].toLowerCase()} sheet from now on.`);
        },
        onError: (e) => toast.error('Could not add the question', errorMessage(e)),
      },
    );
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-4 space-y-3 rounded-lg bg-surface-2 p-3">
      <Field label={`Add a ${INTERVIEW_TYPE_NAMES[type].toLowerCase()} question`} htmlFor={`${uid}-new`}>
        <Input id={`${uid}-new`} value={text} onChange={(e) => setText(e.target.value)} maxLength={INTERVIEW_QUESTION_MAX} placeholder="e.g. What would you like to know about the role?" />
      </Field>
      <QuestionTopicHint text={text} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Asked of" htmlFor={`${uid}-pos`} className="sm:w-56"><Select id={`${uid}-pos`} value={position} onChange={(e) => setPosition(e.target.value)} options={POSITION_OPTIONS} /></Field>
        <Button type="submit" leftIcon={<Plus aria-hidden />} loading={save.isPending} disabled={clean.length < 5} className="sm:ml-auto">Add question</Button>
      </div>
    </form>
  );
}
