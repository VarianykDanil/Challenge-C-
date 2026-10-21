// Release 1.2 — L2 learning-pitch: write or edit a campaign's pitch (admins and leaders). The script and the fact-check
// notes as plain text with a live preview set exactly as the crew will read it. Saving records who saved it (and U3's
// audit trail keeps the history). The fact-check notes are the office's: leaders see them read-only and their save
// leaves them out (PUT keeps the stored notes; a leader's change to them is 403).
import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Eye, FileText, PenLine, Save } from 'lucide-react';
import {
  PITCH_BODY_MAX,
  PITCH_FACTS_MAX,
  PITCH_FACTS_OFFICE_ONLY,
  PITCH_TITLE_MAX,
  parsePitchFacts,
  parsePitchScript,
  type CampaignPitch,
} from '@lm/shared';
import { useSavePitch } from '@/api/pitches';
import { Button, Card, CardHeader, Field, Input, SegmentedControl, Textarea, useToast } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { errorMessage } from '@/features/common/QueryStates';
import { FactSummary, ScriptView } from './ScriptView';
import { formatSeconds } from './parts';

/** A skeleton that shows the format, offered when the script is empty. */
export const PITCH_STARTER = `(Introduction)
Your opening line: one fact that makes them stop
(Pause - 1 Second)

(Smile)

(Short story)
What we do is …

Do you know anyone who …?

Yes -
If you don't mind me asking, …

No - …

(Presentation)
Unfortunately … but the amazing people like yourself who have stopped said they'd love to help …

(Name), …

(Close)
I'm sure we can count on your support as well, however I would need to check

You live in the UK
You bank in the UK`;

export interface PitchEditorProps {
  campaignCode: string;
  campaignName: string;
  pitch: CampaignPitch | null;
  /** Admins (the office) only; leaders see the notes read-only and never send them. */
  canEditFacts: boolean;
  onDone: (saved: CampaignPitch | null) => void;
}

export function PitchEditor({ campaignCode, campaignName, pitch, canEditFacts, onDone }: PitchEditorProps) {
  const toast = useToast();
  const save = useSavePitch(campaignCode);
  const ids = { title: useId(), body: useId(), facts: useId() };
  const initial = useMemo(
    () => ({ title: pitch?.title ?? `The ${campaignCode.toUpperCase()} pitch`, body: pitch?.body ?? '', facts: pitch?.facts ?? '' }),
    [pitch, campaignCode],
  );
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [facts, setFacts] = useState(initial.facts);
  const [pane, setPane] = useState<'write' | 'preview'>('write');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [touched, setTouched] = useState(false);
  const dirty = title !== initial.title || body !== initial.body || facts !== initial.facts;

  const deferredBody = useDeferredValue(body);
  const deferredFacts = useDeferredValue(facts);
  const script = useMemo(() => parsePitchScript(deferredBody), [deferredBody]);
  const factNotes = useMemo(() => parsePitchFacts(deferredFacts, deferredBody), [deferredFacts, deferredBody]);
  const unmatched = factNotes.filter((f) => f.quotes.length > 0 && f.lines.length === 0);

  // Unsaved changes survive an accidental refresh or tab close only with a warning.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const titleError = touched && !title.trim() ? 'Give the pitch a title' : undefined;
  const bodyError = touched && !body.trim() ? 'Write the pitch first' : undefined;

  const submit = () => {
    setTouched(true);
    if (!title.trim() || !body.trim()) return;
    save.mutate(
      canEditFacts ? { title, body, facts: facts.trim() ? facts : null } : { title, body },
      {
        onSuccess: (saved) => {
          toast.success('Pitch saved', `${campaignName}: everyone sees the new version now.`);
          onDone(saved);
        },
        onError: (e) => toast.error('Could not save the pitch', errorMessage(e)),
      },
    );
  };

  const cancel = () => (dirty ? setConfirmLeave(true) : onDone(null));

  const form = (
    <Card className="min-w-0">
      <CardHeader icon={<PenLine />} title={pitch ? 'Edit the pitch' : 'Write the pitch'} description={`${campaignName} · plain text, one spoken line per line`} />
      <div className="space-y-4">
        <Field label="Title" required htmlFor={ids.title} error={titleError}>
          <Input id={ids.title} value={title} maxLength={PITCH_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} invalid={!!titleError} />
        </Field>
        <Field
          label="Script"
          required
          htmlFor={ids.body}
          error={bodyError}
          trailing={
            !body.trim() ? (
              <button type="button" className="inline-flex min-h-8 items-center font-medium text-primary hover:underline" onClick={() => setBody(PITCH_STARTER)}>
                Start from a template
              </button>
            ) : undefined
          }
        >
          <Textarea
            id={ids.body}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            maxLength={PITCH_BODY_MAX}
            spellCheck
            className="min-h-[22rem] text-[15px]"
            invalid={!!bodyError}
            placeholder={'Your opening line\n(Pause - 1 Second)\n\nWhat we do is…'}
            data-pitch-editor-body
          />
        </Field>
        <FormatGuide />
        <Field
          label="Fact-check notes"
          optional={canEditFacts}
          htmlFor={ids.facts}
          hint={
            canEditFacts
              ? 'One note per line, starting with "- ". Put the words it is about in double quotes, then a colon: - "every 43 minutes": … Links become sources.'
              : `${PITCH_FACTS_OFFICE_ONLY}.`
          }
        >
          <Textarea
            id={ids.facts}
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
            readOnly={!canEditFacts}
            rows={6}
            maxLength={PITCH_FACTS_MAX}
            className={clsx('text-[13px]', !canEditFacts && 'bg-surface-2 text-muted shadow-none')}
            placeholder={canEditFacts ? undefined : 'No fact-check notes yet.'}
            data-pitch-editor-facts
          />
        </Field>
        {unmatched.length > 0 && (
          <p className="text-xs text-warning" role="status">
            {unmatched.length === 1 ? 'One note quotes words' : `${unmatched.length} notes quote words`} that are not in the script, so{' '}
            {unmatched.length === 1 ? 'it shows' : 'they show'} above the script instead of beside a line.
          </p>
        )}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <Button variant="ghost" onClick={cancel} disabled={save.isPending}>Cancel</Button>
        <Button onClick={submit} loading={save.isPending} leftIcon={<Save />}>Save pitch</Button>
      </div>
    </Card>
  );

  const preview = (
    <Card className="min-w-0 xl:sticky xl:top-20">
      <CardHeader
        icon={<Eye />}
        title="Preview"
        description={
          script.lineCount
            ? `${script.lineCount} lines · ${script.wordCount} words · reads in about ${formatSeconds(script.estimatedSeconds)}`
            : 'The script appears here as you type.'
        }
      />
      <div className="scrollbar-thin relative xl:max-h-[calc(100dvh-13rem)] xl:overflow-y-auto xl:pr-1">
        <FactSummary facts={factNotes} className="mb-4" />
        <ScriptView script={script} facts={factNotes} showTheory narrow />
      </div>
    </Card>
  );

  return (
    <div data-pitch-editor>
      <SegmentedControl
        className="mb-4 max-sm:h-11 xl:hidden"
        fullWidth
        aria-label="Editor view"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'write', label: 'Write', icon: <FileText /> },
          { value: 'preview', label: 'Preview', icon: <Eye /> },
        ]}
      />
      <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
        <div className={clsx('min-w-0', pane !== 'write' && 'hidden xl:block')}>{form}</div>
        <div className={clsx('min-w-0', pane !== 'preview' && 'hidden xl:block')}>{preview}</div>
      </div>
      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          onDone(null);
        }}
        title="Leave without saving?"
        description="Your changes to the pitch will be lost."
        confirmLabel="Leave without saving"
        tone="danger"
      />
    </div>
  );
}

function FormatGuide() {
  return (
    <details className="group rounded-xl border border-border bg-surface-2/50 px-4 py-2 text-sm">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 font-medium text-fg">
        How to write the script
        <span className="text-xs text-muted group-open:hidden">Show</span>
        <span className="hidden text-xs text-muted group-open:inline">Hide</span>
      </summary>
      <ul className="mb-2 mt-1 space-y-1.5 text-muted">
        <li><span className="font-medium text-fg">One spoken line per line.</span> A blank line starts a new paragraph.</li>
        <li><code className="text-fg">(Slow smile)</code> on its own line is a stage direction; inside a line it stays with the words.</li>
        <li><code className="text-fg">(Pause - 1 Second)</code> or <code className="text-fg">(Pause)</code> is a pause beat.</li>
        <li><code className="text-fg">(Name)</code> is where their name goes; <code className="text-fg">(Close)</code> marks the close.</li>
        <li><code className="text-fg">Yes -</code> and <code className="text-fg">No -</code> start the answers to the question above. The last answer ends at the next blank line, or put <code className="text-fg">(Both)</code> on its own line where the pitch carries on.</li>
        <li><code className="text-fg">(Short story)</code>, <code className="text-fg">(Presentation)</code>, <code className="text-fg">(Close)</code>, <code className="text-fg">(Consolidation)</code> on their own line start that step; otherwise the step is worked out from the words.</li>
      </ul>
    </details>
  );
}
