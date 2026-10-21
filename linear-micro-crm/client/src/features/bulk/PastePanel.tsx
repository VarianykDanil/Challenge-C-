// Release 1.2 — U2 bulk-entry: "Paste from WhatsApp". OWNED BY U2.
// Reads the pasted text with the shared parser (parseBulkPaste), shows every line it understood with its problems,
// lets the leader settle ambiguous or unknown names, then fills the grid (pasteFills: the last complete line per
// person wins). Nothing is saved from here: the grid's Save does that.
import { useDeferredValue, useId, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ParsedPasteLine, PasteFill, PasteMember, UserWithTeam } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, parseBulkPaste, pasteFills, resolvePaste } from '@lm/shared';
import { AlertTriangle, CheckCircle2, HelpCircle, MessageSquareText, Wand2, X } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Select, Textarea } from '@/components/ui';
import { fullName, pluralise } from '@/lib/format';

export interface PastePanelProps {
  members: UserWithTeam[];
  onFill: (fills: PasteFill[]) => void;
  onClose: () => void;
  disabled?: boolean;
  className?: string;
}

const PLACEHOLDER = 'Jordan 65 22 11 5 3 3\nAmelia H - 40/12/6/2/1/1\nsam: 33 11 6 3 2 2 in 9:58\n\nOr paste straight from the chat:\n[20/10/2026, 17:42] Priya Shah: 44 15 7 3 2 1';

type LineState = 'ready' | 'check' | 'choose' | 'skip';

function lineState(l: ParsedPasteLine): LineState {
  if (l.replacedBy) return 'skip';
  if (l.userId === null) return 'choose';
  if (!l.values) return 'skip';
  return l.issues.length || l.guess ? 'check' : 'ready';
}

const STATE_ICON: Record<LineState, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  ready: { icon: CheckCircle2, cls: 'text-success', label: 'Ready' },
  check: { icon: AlertTriangle, cls: 'text-warning', label: 'Check this line' },
  choose: { icon: HelpCircle, cls: 'text-info', label: 'Choose who this is' },
  skip: { icon: X, cls: 'text-muted', label: 'Not used' },
};

export function PastePanel({ members, onFill, onClose, disabled, className }: PastePanelProps) {
  const uid = useId();
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<Record<string, number | null>>({});
  const [filled, setFilled] = useState<number | null>(null);
  const deferred = useDeferredValue(text);
  const team: PasteMember[] = useMemo(() => members.map((m) => ({ userId: m.id, firstName: m.firstName, lastName: m.lastName })), [members]);
  const parsed = useMemo(() => parseBulkPaste(deferred, team), [deferred, team]);
  const lines = useMemo(() => resolvePaste(parsed.lines, choices, team), [parsed.lines, choices, team]);
  const fills = useMemo(() => pasteFills(lines), [lines]);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const waiting = lines.filter((l) => l.userId === null).length;

  const fill = () => {
    if (!fills.length) return;
    onFill(fills);
    setFilled(fills.length);
  };

  return (
    <Card className={className} data-bulk-paste>
      <CardHeader
        icon={<MessageSquareText />}
        title="Paste from WhatsApp"
        description="Copy the team's numbers from the group chat. One person per line: a name, then stops, to table, presentations, closes, taps and sales. A time like 9:58 is read as their check-in."
        actions={
          // UI QA 1.2 #9: 44 × 44 on a phone or a touch screen (32 × 32 with a mouse), its X where it always was: the
          // 6 px negative margins grow the hit area around the same centre and keep the 32 px footprint, so neither the
          // header nor its title moves.
          <Button
            variant="ghost"
            size="icon-sm"
            label="Close the paste box"
            onClick={onClose}
            className="max-sm:-m-1.5 max-sm:h-11 max-sm:w-11 pointer-coarse:-m-1.5 pointer-coarse:h-11 pointer-coarse:w-11"
            data-bulk-close-paste
          >
            <X aria-hidden />
          </Button>
        }
      />
      <label htmlFor={`${uid}-text`} className="sr-only">WhatsApp message</label>
      <Textarea
        id={`${uid}-text`}
        rows={5}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFilled(null);
        }}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="font-mono text-[13px]"
        disabled={disabled}
      />

      {text.trim() !== '' && (
        <div className="mt-4" aria-live="polite">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-medium text-fg">{pluralise(lines.length, 'line')} read</span>
            {waiting > 0 && <span className="text-info">{waiting} need{waiting === 1 ? 's' : ''} a name chosen</span>}
            {parsed.ignored > 0 && <span>{pluralise(parsed.ignored, 'chat line')} skipped</span>}
          </div>
          {lines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">
              No numbers found yet. Each person needs a name and six numbers, e.g. <span className="font-mono text-fg">Jordan 65 22 11 5 3 3</span>.
            </p>
          ) : (
            <ul className="space-y-2" aria-label="What the paste says">
              {lines.map((l) => (
                <PasteLineRow key={l.key} line={l} members={members} byId={byId} onChoose={(id) => setChoices((c) => ({ ...c, [l.key]: id }))} />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted" role="status">
          {filled !== null
            ? `Filled ${pluralise(filled, 'row')} below — check them, then save.`
            : fills.length
              ? `${pluralise(fills.length, 'person', 'people')} ready to fill the table. Nothing is saved until you press Save.`
              : 'Nothing is saved until you press Save.'}
        </p>
        <div className="flex gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">
          {text && (
            <Button variant="ghost" onClick={() => { setText(''); setChoices({}); setFilled(null); }}>Clear</Button>
          )}
          <Button onClick={fill} disabled={disabled || fills.length === 0} leftIcon={<Wand2 className="h-4 w-4" aria-hidden />} data-bulk-fill>
            {fills.length ? `Fill ${pluralise(fills.length, 'row')}` : 'Fill the table'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PasteLineRow({ line, members, byId, onChoose }: { line: ParsedPasteLine; members: UserWithTeam[]; byId: Map<number, UserWithTeam>; onChoose: (id: number | null) => void }) {
  const state = lineState(line);
  const S = STATE_ICON[state];
  const options = (line.matches.length > 1 ? line.matches.map((id) => byId.get(id)).filter((m): m is UserWithTeam => !!m) : members).map((m) => ({ value: String(m.id), label: fullName(m) }));
  // The parser's own problems about the name are replaced by the choice once one is made.
  const issues = line.userId !== null ? line.issues.filter((i) => !/choose (who it is|one)$/.test(i)) : line.issues;
  return (
    <li
      className={clsx(
        'rounded-lg border p-3',
        state === 'ready' && 'border-border bg-surface',
        state === 'check' && 'border-warning/40 bg-warning-soft/40',
        state === 'choose' && 'border-info/40 bg-info-soft/40',
        state === 'skip' && 'border-border bg-surface-2/60 opacity-80',
      )}
      data-paste-line={line.key}
      data-paste-state={state}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 md:grid-cols-[auto_minmax(0,1fr)_minmax(11rem,15rem)] md:items-center">
        <S.icon className={clsx('mt-0.5 h-4 w-4 shrink-0 md:mt-0', S.cls)} aria-label={S.label} role="img" />
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-muted" title={line.raw}>
            <span className="mr-1.5 text-subtle">L{line.line}</span>
            {line.raw.trim()}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {line.values ? (
              <span className="inline-flex flex-wrap gap-1" aria-label={GAUGE_KEYS.map((k) => `${GAUGE_LABELS[k]} ${line.values![k]}`).join(', ')}>
                {GAUGE_KEYS.map((k) => (
                  <span key={k} title={GAUGE_LABELS[k]} className="min-w-7 rounded bg-surface-2 px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-fg ring-1 ring-inset ring-border">
                    {line.values![k]}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-xs text-muted">No six numbers</span>
            )}
            {line.checkIn && <Badge tone="info" size="sm">in {line.checkIn}</Badge>}
            {line.nameFrom === 'sender' && <Badge tone="neutral" size="sm">Sender: {line.name}</Badge>}
            {line.guess && line.userId !== null && <Badge tone="warning" size="sm">Best guess for “{line.name}”</Badge>}
            {line.replacedBy && <Badge tone="neutral" size="sm">Replaced by line {line.replacedBy.split('.')[0]}</Badge>}
          </div>
        </div>
        <div className="col-span-2 md:col-span-1">
          <Select
            aria-label={`Who is “${line.name || `line ${line.line}`}”?`}
            value={line.userId !== null ? String(line.userId) : ''}
            onChange={(e) => onChoose(e.target.value ? Number(e.target.value) : null)}
            placeholder={line.matches.length > 1 ? `Which ${line.name}?` : 'Who is this?'}
            options={options}
            invalid={line.userId === null}
          />
        </div>
      </div>
      {issues.length > 0 && (
        <ul className="mt-2 space-y-0.5 pl-7 text-xs">
          {issues.map((i) => (
            <li key={i} className={clsx(line.values ? 'text-warning' : 'text-danger')}>{i}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
