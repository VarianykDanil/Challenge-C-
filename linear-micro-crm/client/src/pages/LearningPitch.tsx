// Release 1.2 — /learning/pitch/:campaignCode, the pitch studio — OWNED BY L2 learning-pitch.
// The campaign's pitch set for reading aloud, with the fact check beside the lines it concerns, the COD pack theory
// behind each line, a step timer and three practice modes: Read, Teleprompter and Memorise (flashcards); the two
// practice modes flag the lines whose figures the office has not approved yet. Admins and leaders write and edit it
// (?edit=1 opens the editor); only admins (the office) change the fact-check notes. Every signed-in role can read it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, GraduationCap, Layers, MonitorPlay, Mic, Pencil, PenLine } from 'lucide-react';
import { parsePitchFacts, parsePitchScript, type CampaignPitch, type PitchListItem } from '@lm/shared';
import { pitchKeys, usePitch, usePitches } from '@/api/pitches';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Card, EmptyState, PageHeader, SegmentedControl, Skeleton, Switch } from '@/components/ui';
import { COPY } from '@/content/copy';
import { ErrorState } from '@/features/common/QueryStates';
import { Memorise } from '@/features/learning/pitch/Memorise';
import { PitchEditor } from '@/features/learning/pitch/PitchEditor';
import { FactSummary, ScriptView } from '@/features/learning/pitch/ScriptView';
import { StepTimer } from '@/features/learning/pitch/StepTimer';
import { Teleprompter } from '@/features/learning/pitch/Teleprompter';
import { formatSeconds } from '@/features/learning/pitch/parts';
import { formatDateShort } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { NotFoundPage } from './NotFound';

type Mode = 'read' | 'prompter' | 'memorise';
const MODES: Mode[] = ['read', 'prompter', 'memorise'];

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function LearningPitchPage() {
  const { campaignCode = '' } = useParams();
  const code = campaignCode.toUpperCase();
  const me = useCurrentUser();
  const canEdit = me.role === 'admin' || me.role === 'leader';
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const editing = canEdit && params.get('edit') === '1';

  const list = usePitches();
  const campaign: PitchListItem | undefined = list.data?.find((p) => p.campaignCode.toUpperCase() === code);
  // Only ask for the pitch when the list says there is one: no 404 round trip for a campaign without a pitch.
  const pitchQ = usePitch(code, { enabled: !!campaign?.hasPitch });
  const pitch = campaign?.hasPitch ? pitchQ.data : undefined;
  usePageTitle(pitch?.title ?? (campaign ? `${campaign.campaignName} pitch` : 'Pitch'));

  const setEditing = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('edit', '1');
    else next.delete('edit');
    setParams(next, { replace: !on });
  };

  const onSaved = (saved: CampaignPitch | null) => {
    if (saved) qc.setQueryData(pitchKeys.detail(code), saved);
    setEditing(false);
    window.scrollTo({ top: 0 });
  };

  const back = (
    <Link to="/learning" className="inline-flex min-h-8 items-center gap-1 hover:underline max-sm:min-h-10">
      <ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}
    </Link>
  );

  if (list.isLoading || (campaign?.hasPitch && pitchQ.isLoading)) {
    return (
      <>
        <PageHeader breadcrumbs={back} title="Pitch" />
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </>
    );
  }
  if (list.isError || (campaign?.hasPitch && pitchQ.isError)) {
    return (
      <>
        <PageHeader breadcrumbs={back} title="Pitch" />
        <ErrorState error={list.error ?? pitchQ.error} onRetry={() => void (list.isError ? list.refetch() : pitchQ.refetch())} title="Could not load the pitch" />
      </>
    );
  }
  if (!campaign) return <NotFoundPage />;

  const eyebrow = (
    <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
      <Badge size="sm" tone="neutral" dot color={campaign.campaignColor} className="font-mono">{campaign.campaignCode}</Badge>
      <span className="text-xs font-medium text-muted">{campaign.campaignName}</span>
    </span>
  );

  if (editing) {
    return (
      <>
        <PageHeader breadcrumbs={back} eyebrow={eyebrow} title={pitch ? `Edit: ${pitch.title}` : 'Write the pitch'} />
        <PitchEditor
          campaignCode={campaign.campaignCode}
          campaignName={campaign.campaignName}
          pitch={pitch ?? null}
          canEditFacts={me.role === 'admin'}
          onDone={onSaved}
        />
      </>
    );
  }

  if (!pitch) {
    return (
      <>
        <PageHeader breadcrumbs={back} eyebrow={eyebrow} title={`${campaign.campaignName} pitch`} />
        <EmptyState
          icon={<Mic aria-hidden />}
          tone="primary"
          title={`No pitch for ${campaign.campaignName} yet`}
          description={
            canEdit
              ? 'Write the script once and the whole crew can read it aloud, practise it on the teleprompter and learn it with flashcards.'
              : 'Your leader or the office adds it here. Until then, the five steps to a conversation are the place to start.'
          }
          action={
            canEdit ? (
              <Button onClick={() => setEditing(true)} leftIcon={<PenLine />}>Write the pitch</Button>
            ) : (
              <Link to="/learning/pack/five-steps" className="focus-ring inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-2">
                <GraduationCap className="h-4 w-4" aria-hidden /> The five steps
              </Link>
            )
          }
        />
      </>
    );
  }

  return <PitchStudio pitch={pitch} eyebrow={eyebrow} back={back} canEdit={canEdit} onEdit={() => setEditing(true)} userId={me.id} />;
}

function PitchStudio({
  pitch,
  eyebrow,
  back,
  canEdit,
  onEdit,
  userId,
}: {
  pitch: CampaignPitch;
  eyebrow: ReactNode;
  back: ReactNode;
  canEdit: boolean;
  onEdit: () => void;
  userId: number;
}) {
  const script = useMemo(() => parsePitchScript(pitch.body), [pitch.body]);
  const facts = useMemo(() => parsePitchFacts(pitch.facts, pitch.body), [pitch.facts, pitch.body]);
  const [mode, setMode] = useState<Mode>(() => readStored('lm-pitch-mode', MODES, 'read'));
  const [showTheory, setShowTheory] = useState(() => readStored('lm-pitch-theory', ['on', 'off'] as const, 'on') === 'on');
  useEffect(() => writeStored('lm-pitch-mode', mode), [mode]);
  useEffect(() => writeStored('lm-pitch-theory', showTheory ? 'on' : 'off'), [showTheory]);

  // "See the notes" in the teleprompter and the flashcards opens Read mode, which unmounts the button: focus moves to
  // the notes summary (or, without one, to the Read option) instead of falling back to the page.
  const notesRef = useRef<HTMLDivElement>(null);
  const modesRef = useRef<HTMLDivElement>(null);
  const focusNotes = useRef(false);
  const showNotes = () => {
    focusNotes.current = true;
    setMode('read');
  };
  useEffect(() => {
    if (mode !== 'read' || !focusNotes.current) return;
    focusNotes.current = false;
    const notes = notesRef.current;
    (notes?.childElementCount ? notes : modesRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]'))?.focus();
  }, [mode]);

  const updated = `Updated ${formatDateShort(pitch.updatedAt)}${pitch.updatedByName ? ` by ${pitch.updatedByName}` : ''}`;

  return (
    <>
      <PageHeader
        breadcrumbs={back}
        eyebrow={eyebrow}
        title={pitch.title}
        description={`${script.lineCount} lines · reads in about ${formatSeconds(script.estimatedSeconds)} · ${updated}`}
        actions={canEdit ? <Button variant="outline" onClick={onEdit} leftIcon={<Pencil />}>Edit</Button> : undefined}
      />
      <div className="space-y-4" data-pitch-studio data-mode={mode}>
        <div ref={modesRef} className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            aria-label="Practice mode"
            value={mode}
            onChange={setMode}
            className="max-sm:flex max-sm:h-11 max-sm:w-full max-sm:[&_button>span]:hidden"
            options={[
              { value: 'read', label: 'Read', icon: <BookOpen /> },
              { value: 'prompter', label: 'Teleprompter', icon: <MonitorPlay /> },
              { value: 'memorise', label: 'Memorise', icon: <Layers /> },
            ]}
          />
          {mode === 'read' && <Switch size="sm" checked={showTheory} onChange={setShowTheory} label="Show the theory" />}
        </div>

        {mode === 'read' && (
          <>
            <StepTimer steps={script.steps} wordsPerMinute={script.wordsPerMinute} />
            <Card className="p-4 sm:p-6 lg:p-8">
              <div ref={notesRef} tabIndex={-1} role="region" aria-label="Notes on the figures" className="focus-ring mb-6 rounded-xl empty:hidden">
                <FactSummary facts={facts} />
              </div>
              <ScriptView script={script} facts={facts} showTheory={showTheory} />
            </Card>
          </>
        )}
        {/* The practice modes say how many lines still need checking in a one-line strip of their own (the teleprompter
            inside its panel, the flashcards in their progress card), so their controls still fit the first screen. */}
        {mode === 'prompter' && (
          <>
            <Teleprompter script={script} facts={facts} onShowNotes={showNotes} />
            <p className="text-xs text-muted">
              Space plays and pauses, the arrow keys change the speed, F goes full screen. On a phone, turn it sideways for the widest lines.
            </p>
          </>
        )}
        {mode === 'memorise' && (
          <Memorise script={script} facts={facts} userId={userId} campaignCode={pitch.campaignCode} onShowNotes={showNotes} />
        )}
      </div>
    </>
  );
}
