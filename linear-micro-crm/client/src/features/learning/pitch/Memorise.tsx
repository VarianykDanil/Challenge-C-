// Release 1.2 — L2 learning-pitch: Memorise mode. One flashcard per spoken line: the line before it is the cue, the
// line itself is hidden until you tap; then mark it "Known" or "Again". Progress is kept on this device per person and
// campaign (memoriseStore.ts). Keys: Space or Enter reveals, K known, A again, ← → move.
// A card whose line uses a figure the office has not approved yet says so in its header ("Check the figures"), and
// once revealed shows the note with its suggested wording under Again / Known (folded on phones), so the controls stay
// where they are with or without a note. The line stays as written. How many lines need checking is one line in the
// progress card, with "See the notes" (Read mode): on phones a strip at the top of that card, which comes after the
// flashcard there, so the cue, the line and Again / Known fit the first screen; from `sm` up, where the progress card
// sits above the flashcard, a line beside "Saved on this device only." that adds no height above the card.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Eye, PartyPopper, RotateCcw, Undo2 } from 'lucide-react';
import { countPitchWords, pitchCards, pitchFactFlags, type PitchFact, type PitchScript } from '@lm/shared';
import { Badge, Button, Card, ProgressBar, Switch } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { useMemoriseProgress } from './memoriseStore';
import { FoldedFactNote, InlineSegments, STEP_NUMBER } from './parts';
import { useMediaQuery } from '@/lib/useMediaQuery';

const STEP_LABEL = { introduction: 'Introduction', 'short-story': 'Short story', presentation: 'Presentation', close: 'Close', consolidation: 'Consolidation' } as const;

/**
 * Phones: "Check the figures: 5 lines" and a 40 px "See the notes" (Read mode) in a strip at the top of the progress
 * card, one line at 375 px (the rest of the sentence is read out there).
 */
function FiguresStrip({ count, onShowNotes }: { count: number; onShowNotes?: () => void }) {
  return (
    <div className="flex min-h-10 items-center gap-1.5 border-b border-warning/30 bg-warning-soft pl-4 pr-1 text-sm text-fg sm:gap-2 sm:pl-5 sm:pr-1.5" role="note" data-fact-banner>
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 py-1.5 leading-snug">
        <span className="font-semibold">Check the figures:</span>{' '}
        <span className="whitespace-nowrap">
          {count} {count === 1 ? 'line' : 'lines'}
        </span>
        <span className="max-sm:sr-only"> {count === 1 ? 'uses a figure' : 'use figures'} the office has not approved yet.</span>
      </p>
      {onShowNotes && (
        <button
          type="button"
          onClick={onShowNotes}
          className="focus-ring inline-flex h-10 shrink-0 items-center rounded-lg px-2 text-sm font-semibold text-fg underline decoration-fg/40 underline-offset-4 hover:bg-warning/10 hover:decoration-fg sm:px-2.5"
        >
          See the notes
        </button>
      )}
    </div>
  );
}

/**
 * From `sm` up: the whole sentence and "See the notes" as one line of the progress card's footer, beside "Saved on
 * this device only.", so it adds no height above the flashcard on a laptop. 40 px tall on a touch screen.
 */
function FiguresLine({ count, onShowNotes }: { count: number; onShowNotes?: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg" role="note" data-fact-banner>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 leading-snug">
        <span className="font-semibold">Check the figures:</span> {count} {count === 1 ? 'line uses a figure' : 'lines use figures'} the office has not approved
        yet.
      </p>
      {onShowNotes && (
        <button
          type="button"
          onClick={onShowNotes}
          className="focus-ring -my-0.5 inline-flex shrink-0 items-center rounded px-1 py-0.5 font-semibold text-fg underline decoration-fg/40 underline-offset-4 hover:bg-warning/10 hover:decoration-fg pointer-coarse:min-h-10 pointer-coarse:px-2"
        >
          See the notes
        </button>
      )}
    </div>
  );
}

export function Memorise({
  script,
  facts,
  userId,
  campaignCode,
  onShowNotes,
}: {
  script: PitchScript;
  facts?: readonly PitchFact[];
  userId: number;
  campaignCode: string;
  /** Opens Read mode, where the notes are (the strip's "See the notes"). */
  onShowNotes?: () => void;
}) {
  const cards = useMemo(() => pitchCards(script), [script]);
  const flags = useMemo(() => pitchFactFlags(facts ?? []), [facts]);
  // Tailwind's `sm`: from here up the progress card sits above the flashcard; below it the flashcard comes first.
  const wide = useMediaQuery('(min-width: 640px)');
  const { known, mark, reset } = useMemoriseProgress(userId, campaignCode);
  const [onlyToLearn, setOnlyToLearn] = useState(false);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // In "only lines to learn" the deck is fixed when the switch flips, so a card marked Known stays until you move on.
  const [deckKeys, setDeckKeys] = useState<string[] | null>(null);

  const knownCount = cards.filter((c) => known.has(c.key)).length;
  const deck = useMemo(() => (deckKeys ? cards.filter((c) => deckKeys.includes(c.key)) : cards), [cards, deckKeys]);
  const card = deck[Math.min(index, Math.max(0, deck.length - 1))];
  const position = card ? deck.indexOf(card) : 0;

  useEffect(() => {
    setRevealed(false);
  }, [index, onlyToLearn]);

  const go = (to: number) => {
    if (!deck.length) return;
    setIndex(Math.max(0, Math.min(deck.length - 1, to)));
    setRevealed(false);
  };
  const answer = (isKnown: boolean) => {
    if (!card) return;
    mark(card.key, isKnown);
    if (position < deck.length - 1) go(position + 1);
    else setRevealed(true);
  };
  const toggleOnly = (on: boolean) => {
    setOnlyToLearn(on);
    setDeckKeys(on ? cards.filter((c) => !known.has(c.key)).map((c) => c.key) : null);
    setIndex(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest('button,[role="switch"]') && (e.key === ' ' || e.key === 'Enter')) return;
    if ((e.key === ' ' || e.key === 'Enter') && !revealed) {
      e.preventDefault();
      setRevealed(true);
    } else if (e.key === 'ArrowRight') go(position + 1);
    else if (e.key === 'ArrowLeft') go(position - 1);
    else if (revealed && (e.key === 'k' || e.key === 'K')) answer(true);
    else if (revealed && (e.key === 'a' || e.key === 'A')) answer(false);
  };

  if (!cards.length) {
    return <Card><p className="text-sm text-muted">There are no spoken lines to learn yet.</p></Card>;
  }

  const allKnown = knownCount === cards.length;
  const isKnown = card ? known.has(card.key) : false;
  // The 'check' notes on this card's line (one note may cover several lines: show each once).
  const cardFacts = card ? [...new Set((flags.get(card.line) ?? []).map((f) => f.fact))] : [];

  const progressCard = (
    <Card key="progress" padded={false} className="overflow-hidden" data-memorise-progress>
      {flags.size > 0 && !wide && <FiguresStrip count={flags.size} onShowNotes={onShowNotes} />}
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-[12rem] flex-1">
            <ProgressBar
              value={knownCount}
              max={cards.length}
              tone="success"
              label="Lines you know"
              showValue
              formatValue={(v, m) => `${v} of ${m}`}
            />
          </div>
          <Switch size="sm" checked={onlyToLearn} onChange={toggleOnly} label="Only lines still to learn" />
          <Button variant="ghost" size="sm" className="max-sm:h-10" onClick={() => setConfirmReset(true)} leftIcon={<RotateCcw />} disabled={knownCount === 0}>
            Start over
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {flags.size > 0 && wide && <FiguresLine count={flags.size} onShowNotes={onShowNotes} />}
          <p className="text-xs text-muted">
            {allKnown ? `You know all ${cards.length} lines. ` : ''}Saved on this device only.
          </p>
        </div>
      </div>
    </Card>
  );

  const deckCard =
    onlyToLearn && deck.length === 0 ? (
      <Card key="deck" className="text-center">
        <PartyPopper className="mx-auto h-8 w-8 text-primary" aria-hidden />
        <p className="mt-3 text-base font-semibold text-fg">You know every line of this pitch.</p>
        <p className="mt-1 text-sm text-muted">Say it through on the teleprompter at a brisker pace, or time each step with the step timer.</p>
        <Button variant="outline" className="mt-4" onClick={() => toggleOnly(false)}>Show every line</Button>
      </Card>
    ) : card ? (
      <Card key="deck" padded={false} className="overflow-hidden" aria-live="polite" data-memorise-card>
        {/* Phones: the position is read out only (the bottom row shows "1 / 19"); the badges wrap on the left and the
            "Check the figures" badge stays at the end of the first row (items-start). From `sm` up: one wrapping row. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5 text-xs text-muted max-sm:flex-nowrap max-sm:items-start sm:px-5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:contents">
            <span className="font-semibold tabular text-fg max-sm:sr-only">
              Card {position + 1} of {deck.length}
            </span>
            <Badge size="sm" tone="neutral">
              {STEP_NUMBER[card.step]} · {STEP_LABEL[card.step]}
            </Badge>
            {card.branch && (
              <Badge size="sm" tone={card.branch.answer === 'yes' ? 'primary' : 'accent'}>
                If {card.branch.label.toLowerCase()}
              </Badge>
            )}
            {isKnown && (
              <Badge size="sm" tone="success">
                <Check aria-hidden /> Known
              </Badge>
            )}
          </div>
          {cardFacts.length > 0 && (
            <Badge size="sm" tone="warning" className="shrink-0" data-fact-flag>
              <AlertTriangle aria-hidden /> Check the figures
            </Badge>
          )}
        </div>
        <div className="px-4 py-5 sm:px-6">
          <p className="eyebrow text-muted">{card.cue ? (card.branch && card.cue === card.branch.question ? 'After the question' : 'After') : 'Your opening line'}</p>
          <p className="mt-1 line-clamp-3 text-base text-muted">{card.cue ? `“${card.cue}”` : 'The first thing they hear when they stop.'}</p>

          <div className="mt-4">
            {revealed ? (
              <p className="rounded-xl bg-primary-soft/60 px-4 py-4 text-[21px] font-semibold leading-[1.5] text-fg ring-1 ring-inset ring-primary/20 animate-fade-in sm:text-2xl" data-memorise-answer>
                <InlineSegments segments={card.segments} />
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="focus-ring flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-2/40 px-4 py-6 text-center text-muted transition-colors hover:border-primary/50 hover:text-fg"
                data-memorise-reveal
              >
                <Eye className="h-6 w-6" aria-hidden />
                <span className="text-base font-semibold">Say the line, then tap to check</span>
                <span className="text-xs">{countPitchWords(card.text)} words</span>
              </button>
            )}
          </div>

          {revealed && (
            <div className="mt-4 grid grid-cols-2 gap-2 animate-fade-in">
              <Button variant="outline" size="lg" onClick={() => answer(false)} leftIcon={<Undo2 />}>
                Again
              </Button>
              <Button variant="primary" size="lg" onClick={() => answer(true)} leftIcon={<Check />}>
                Known
              </Button>
            </div>
          )}
          {/* Under Again / Known, not between the line and them: the controls stay put with or without a note. */}
          {revealed && cardFacts.length > 0 && (
            <div className="mt-1" data-memorise-notes>
              {cardFacts.map((fact, i) => (
                <FoldedFactNote key={`${card.key}-${i}`} fact={fact} openOnWide />
              ))}
            </div>
          )}
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={() => go(position - 1)} disabled={position === 0} leftIcon={<ChevronLeft />}>
              Previous
            </Button>
            <span className="whitespace-nowrap text-xs tabular text-muted" aria-hidden>
              {position + 1} / {deck.length}
            </span>
            <Button variant="ghost" onClick={() => go(position + 1)} disabled={position >= deck.length - 1} rightIcon={<ChevronRight />}>
              Next
            </Button>
          </div>
        </div>
      </Card>
    ) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4" onKeyDown={onKeyDown} data-memorise>
      {wide ? [progressCard, deckCard] : [deckCard, progressCard]}

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          reset();
          setConfirmReset(false);
          setDeckKeys(onlyToLearn ? cards.map((c) => c.key) : null);
          go(0);
        }}
        title="Start the flashcards over?"
        description="Every line goes back to “still to learn” on this device."
        confirmLabel="Start over"
      />
    </div>
  );
}
