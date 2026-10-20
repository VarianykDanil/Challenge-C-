// Release 1.2 — L2 learning-pitch: the script set for reading aloud (Read mode and the editor's live preview).
// Large type, stage directions muted italic, pauses as visual beats, Yes / No branches side by side (tabs on phones),
// step headings with the pack's targets, theory chips under each line and the fact-check notes beside the lines they
// concern (in the margin on wide screens, folded under the line on phones).
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, CornerDownRight, Drama } from 'lucide-react';
import { pitchStepVerdict, type PitchBlock, type PitchFact, type PitchScript, type PitchStepEstimate, type PitchStepKey } from '@lm/shared';
import { Badge, SegmentedControl } from '@/components/ui';
import { FactNote, FoldedFactNote, InlineSegments, STEP_HINT, STEP_NUMBER, TheoryChips, formatSeconds, stepLessonHref, targetLabel } from './parts';

export interface ScriptViewProps {
  script: PitchScript;
  facts: readonly PitchFact[];
  showTheory: boolean;
  /** Narrow container (editor preview): fact notes always fold under their lines. */
  narrow?: boolean;
  className?: string;
}

/** Which fact notes open on which line: a note sits on the first line it quotes; later lines get a small marker. */
function factPlacement(facts: readonly PitchFact[]) {
  const first = new Map<number, PitchFact[]>();
  const later = new Set<number>();
  for (const f of facts) {
    const [head, ...rest] = f.lines;
    if (head == null) continue;
    first.set(head, [...(first.get(head) ?? []), f]);
    for (const l of rest) later.add(l);
  }
  return { first, later };
}

type Placement = ReturnType<typeof factPlacement>;

export function ScriptView({ script, facts, showTheory, narrow, className }: ScriptViewProps) {
  const placement = factPlacement(facts);
  const steps = new Map(script.steps.map((s) => [s.step, s]));
  const rows: ReactNode[] = [];
  let current: PitchStepKey | null = null;
  script.blocks.forEach((b, i) => {
    const step = b.kind === 'line' || b.kind === 'branch' ? (b.step ?? 'introduction') : null;
    if (step && step !== current) {
      current = step;
      const est = steps.get(step);
      if (est) rows.push(<StepHeading key={`step-${i}`} estimate={est} first={rows.length === 0} />);
    }
    rows.push(<BlockRow key={i} block={b} placement={placement} showTheory={showTheory} narrow={narrow} />);
  });
  const consolidation = steps.get('consolidation');
  const missingConsolidation = consolidation && consolidation.lines === 0 && script.blocks.length > 0;

  return (
    <div className={clsx('min-w-0', className)} data-pitch-script>
      {rows}
      {missingConsolidation && (
        <div className="mt-8 rounded-xl border border-dashed border-border-strong/70 px-4 py-3 text-sm text-muted">
          <p className="font-semibold text-fg">
            <span className="tabular">5</span> · Consolidation
          </p>
          <p className="mt-1">
            Not in this script: it comes after the sign-up. {STEP_HINT.consolidation}{' '}
            <Link to={stepLessonHref('consolidation')} className="font-medium text-primary hover:underline">See the five steps</Link>
          </p>
        </div>
      )}
    </div>
  );
}

function StepHeading({ estimate, first }: { estimate: PitchStepEstimate; first: boolean }) {
  const target = targetLabel(estimate);
  const verdict = pitchStepVerdict(estimate.seconds, estimate);
  return (
    <div id={`step-${estimate.step}`} className={clsx('scroll-mt-24', first ? 'mb-4' : 'mb-4 mt-9 border-t border-border pt-6')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary tabular" aria-hidden>
          {STEP_NUMBER[estimate.step]}
        </span>
        <h3 className="text-base font-semibold text-fg">
          <span className="sr-only">Step {STEP_NUMBER[estimate.step]}: </span>
          {estimate.label}
        </h3>
        <span className="text-xs text-muted">
          {target ? `Target ${target}` : 'No set time'} · reads in about {formatSeconds(estimate.seconds)}
        </span>
        {verdict === 'within' && <Badge tone="success" size="sm">On target</Badge>}
        {verdict === 'over' && <Badge tone="warning" size="sm">Longer than {target}</Badge>}
        {verdict === 'under' && <Badge tone="warning" size="sm">Shorter than {target}</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted sm:pl-10">
        {STEP_HINT[estimate.step]}{' '}
        <Link to={stepLessonHref(estimate.step)} className="font-medium text-primary hover:underline">Lesson</Link>
      </p>
    </div>
  );
}

function BlockRow({ block, placement, showTheory, narrow }: { block: PitchBlock; placement: Placement; showTheory: boolean; narrow?: boolean }) {
  const notes = block.kind === 'line' ? (placement.first.get(block.line) ?? []) : [];
  const body = <BlockBody block={block} placement={placement} showTheory={showTheory} narrow={narrow} />;
  if (narrow || block.kind === 'branch' || block.kind === 'break') return body;
  // Wide screens (xl, beside the sidebar): the line on the left, its fact notes in the margin beside it.
  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_17rem] xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">{body}</div>
      {/* h-0: a tall note hangs beside the lines below it instead of pushing them apart. */}
      {notes.length > 0 && (
        <aside className="hidden xl:block xl:h-0" aria-label="Fact check for this line">
          {notes.map((f, i) => (
            <FactNote key={i} fact={f} className="mb-3" />
          ))}
        </aside>
      )}
    </div>
  );
}

function BlockBody({ block, placement, showTheory, narrow }: { block: PitchBlock; placement: Placement; showTheory: boolean; narrow?: boolean }) {
  switch (block.kind) {
    case 'break':
      return <div className="h-3" aria-hidden />;
    case 'pause':
      return (
        <div className="my-2" data-pitch-pause>
          <div className="flex items-center gap-3 text-muted" role="note" aria-label={`Pause${block.seconds != null ? ` ${block.seconds} seconds` : ''}`}>
            <span className="h-px w-6 bg-border-strong" aria-hidden />
            <span className="flex items-center gap-1" aria-hidden>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />
            </span>
            <span className="text-xs font-medium uppercase tracking-wider">Pause{block.seconds != null ? ` · ${block.seconds} s` : ''}</span>
            <span className="h-px flex-1 bg-border" aria-hidden />
          </div>
          {showTheory && <TheoryChips annotations={block.annotations ?? []} className="mt-1.5" />}
        </div>
      );
    case 'direction':
      if (block.stepMarker) return null;
      return (
        <div className="my-2">
          <p className="flex items-start gap-2 text-base italic text-muted">
            <Drama className="mt-1 h-4 w-4 shrink-0 not-italic" aria-hidden />
            <span>
              <span className="sr-only">Stage direction: </span>
              {block.text}
            </span>
          </p>
          {showTheory && <TheoryChips annotations={block.annotations ?? []} />}
        </div>
      );
    case 'line': {
      const notes = placement.first.get(block.line) ?? [];
      const marked = placement.later.has(block.line);
      return (
        <div className="mb-3" data-pitch-line={block.line}>
          <p className="text-[19px] font-medium leading-[1.55] text-fg sm:text-[22px]">
            <InlineSegments segments={block.segments} />
            {marked && (
              <span className="ml-1.5 inline-flex translate-y-[-2px] items-center align-middle text-warning" title="The fact-check note above covers this line too">
                <AlertTriangle className="h-4 w-4" aria-hidden />
                <span className="sr-only">(covered by the fact-check note above)</span>
              </span>
            )}
          </p>
          {showTheory && <TheoryChips annotations={block.annotations} />}
          {notes.length > 0 && (
            <div className={narrow ? undefined : 'xl:hidden'}>
              {notes.map((f, i) => (
                <FoldedFactNote key={i} fact={f} />
              ))}
            </div>
          )}
        </div>
      );
    }
    case 'branch':
      return <Branches block={block} placement={placement} showTheory={showTheory} narrow={narrow} />;
  }
}

function Branches({ block, placement, showTheory, narrow }: { block: Extract<PitchBlock, { kind: 'branch' }>; placement: Placement; showTheory: boolean; narrow?: boolean }) {
  const [active, setActive] = useState(block.branches[0]?.answer ?? 'yes');
  const many = block.branches.length > 1;
  return (
    <div className="my-3" data-pitch-branch>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
        <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
        Their answer
      </p>
      {many && (
        <SegmentedControl
          className={narrow ? 'mb-3' : 'mb-3 md:hidden'}
          size="md"
          fullWidth
          aria-label="Their answer"
          value={active}
          onChange={setActive}
          options={block.branches.map((b) => ({ value: b.answer, label: `If ${b.label.toLowerCase()}` }))}
        />
      )}
      <div className={clsx('grid gap-3', many && !narrow && 'md:grid-cols-2')}>
        {block.branches.map((br) => (
          <section
            key={br.answer}
            aria-label={`If they say ${br.label.toLowerCase()}`}
            className={clsx(
              'min-w-0 rounded-xl border border-border bg-surface-2/50 p-4',
              many && br.answer !== active && (narrow ? 'hidden' : 'hidden md:block'),
            )}
          >
            <p className="mb-2">
              <Badge tone={br.answer === 'yes' ? 'primary' : 'accent'} size="sm">If {br.label.toLowerCase()}</Badge>
            </p>
            {br.blocks.map((b, i) => (
              <BlockBody key={i} block={b} placement={placement} showTheory={showTheory} narrow />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Notes about the whole script (no quoted line), and a count of the line notes: shown above the script. */
export function FactSummary({ facts, className }: { facts: readonly PitchFact[]; className?: string }) {
  if (!facts.length) return null;
  const general = facts.filter((f) => f.lines.length === 0);
  const onLines = facts.filter((f) => f.lines.length > 0);
  const toCheck = onLines.filter((f) => f.tone === 'check').length;
  return (
    <div className={clsx('space-y-3', className)}>
      {onLines.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p>
            <span className="font-semibold">Check the figures.</span>{' '}
            {toCheck > 0
              ? `${toCheck} of the script's figures ${toCheck === 1 ? 'needs' : 'need'} checking with the office before you use ${toCheck === 1 ? 'it' : 'them'}.`
              : 'Every quoted figure has been checked.'}{' '}
            The notes sit beside the lines they concern; the script itself stays as written.
          </p>
        </div>
      )}
      {general.map((f, i) => (
        <FactNote key={i} fact={f} />
      ))}
    </div>
  );
}
