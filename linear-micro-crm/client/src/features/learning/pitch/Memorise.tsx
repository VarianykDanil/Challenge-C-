// Release 1.2 — L2 learning-pitch: Memorise mode. One flashcard per spoken line: the line before it is the cue, the
// line itself is hidden until you tap; then mark it "Known" or "Again". Progress is kept on this device per person and
// campaign (memoriseStore.ts). Keys: Space or Enter reveals, K known, A again, ← → move.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Eye, PartyPopper, RotateCcw, Undo2 } from 'lucide-react';
import { countPitchWords, pitchCards, type PitchScript } from '@lm/shared';
import { Badge, Button, Card, ProgressBar, Switch } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { useMemoriseProgress } from './memoriseStore';
import { InlineSegments, STEP_NUMBER } from './parts';

const STEP_LABEL = { introduction: 'Introduction', 'short-story': 'Short story', presentation: 'Presentation', close: 'Close', consolidation: 'Consolidation' } as const;

export function Memorise({ script, userId, campaignCode }: { script: PitchScript; userId: number; campaignCode: string }) {
  const cards = useMemo(() => pitchCards(script), [script]);
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

  return (
    <div className="mx-auto max-w-3xl space-y-4" onKeyDown={onKeyDown} data-memorise>
      <Card>
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
          <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)} leftIcon={<RotateCcw />} disabled={knownCount === 0}>
            Start over
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          {allKnown ? `You know all ${cards.length} lines. ` : ''}Saved on this device only.
        </p>
      </Card>

      {onlyToLearn && deck.length === 0 ? (
        <Card className="text-center">
          <PartyPopper className="mx-auto h-8 w-8 text-primary" aria-hidden />
          <p className="mt-3 text-base font-semibold text-fg">You know every line of this pitch.</p>
          <p className="mt-1 text-sm text-muted">Say it through on the teleprompter at a brisker pace, or time each step with the step timer.</p>
          <Button variant="outline" className="mt-4" onClick={() => toggleOnly(false)}>Show every line</Button>
        </Card>
      ) : card ? (
        <Card padded={false} className="overflow-hidden" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5 text-xs text-muted sm:px-5">
            <span className="font-semibold tabular text-fg">
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
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
              <Button variant="ghost" onClick={() => go(position - 1)} disabled={position === 0} leftIcon={<ChevronLeft />}>
                Previous
              </Button>
              <span className="text-xs tabular text-muted" aria-hidden>
                {position + 1} / {deck.length}
              </span>
              <Button variant="ghost" onClick={() => go(position + 1)} disabled={position >= deck.length - 1} rightIcon={<ChevronRight />}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

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
