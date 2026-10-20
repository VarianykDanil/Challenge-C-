// Release 1.2 — U2 bulk-entry: one row per team member. OWNED BY U2.
// Phone: a small card per person (name and status, then the six counts in two rows of three, then the check-in).
// From 768 px: one spreadsheet line per person under a column header, with the team total underneath. Enter moves to
// the same column on the next person, so a leader can type a whole column from the chat.
import type { KeyboardEvent } from 'react';
import clsx from 'clsx';
import type { GaugeKey, GaugeTotals, UserWithTeam } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS } from '@lm/shared';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Avatar, Badge, Button, controlClass, type BadgeTone } from '@/components/ui';
import { formatNumber, fullName } from '@/lib/format';
import type { BaseEntry, Cells, RowStatus } from './bulkRows';

export interface BulkRowView {
  member: UserWithTeam;
  isMe: boolean;
  base: BaseEntry | null;
  status: RowStatus;
  cells: Cells;
  checkIn: string;
  /** Problems found on this phone (funnel, check-in later than now). */
  problems: string[];
  /** Problems the server answered for this row on the last save. */
  serverErrors: string[];
  invalid: Set<GaugeKey>;
  fromPaste: boolean;
  /** The person has an unsaved edit (so "Undo" has something to undo). */
  edited: boolean;
}

export interface BulkGridProps {
  rows: BulkRowView[];
  totals: GaugeTotals;
  onCell: (userId: number, key: GaugeKey, value: string) => void;
  onCheckIn: (userId: number, value: string) => void;
  onUndo: (userId: number) => void;
  disabled?: boolean;
}

const SHORT: Record<GaugeKey, string> = { stops: 'Stops', table: 'Table', presentations: 'Pres.', closes: 'Closes', taps: 'Taps', sales: 'Sales' };

const STATUS: Record<RowStatus, { label: string; tone: BadgeTone }> = {
  logged: { label: 'Logged', tone: 'success' },
  update: { label: 'Update', tone: 'info' },
  new: { label: 'New', tone: 'primary' },
  empty: { label: 'Not logged', tone: 'neutral' },
};

/** The desktop column template: person, six counts, check-in, undo. */
const COLS = 'md:grid-cols-[minmax(9rem,1.6fr)_repeat(6,minmax(3.25rem,1fr))_7.75rem_2.5rem]';

function focusCell(row: number, col: number) {
  const el = document.querySelector<HTMLInputElement>(`[data-bulk-cell="${row}:${col}"]`);
  if (el) {
    el.focus();
    el.select?.();
  }
}

export function BulkGrid({ rows, totals, onCell, onCheckIn, onUndo, disabled }: BulkGridProps) {
  const onKey = (row: number, col: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    focusCell(e.shiftKey ? row - 1 : row + 1, col);
  };

  return (
    <div className="md:rounded-xl md:border md:border-border md:bg-surface md:shadow-card" data-bulk-grid>
      <div className={clsx('hidden gap-x-2 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted md:grid', COLS)} aria-hidden>
        <span>Person</span>
        {GAUGE_KEYS.map((k) => <span key={k} className="text-center" title={GAUGE_LABELS[k]}>{SHORT[k]}</span>)}
        <span>Check-in</span>
        <span />
      </div>
      <ul className="space-y-3 md:space-y-0 md:divide-y md:divide-border">
        {rows.map((r, i) => {
          const name = fullName(r.member);
          const issues = [...r.serverErrors, ...r.problems.filter((p) => !r.serverErrors.includes(p))];
          const st = STATUS[r.status];
          return (
            <li
              key={r.member.id}
              data-bulk-row={r.member.id}
              data-bulk-status={r.status}
              className={clsx(
                'rounded-xl border bg-surface p-3 shadow-card md:rounded-none md:border-0 md:px-4 md:py-2.5 md:shadow-none',
                issues.length ? 'border-danger/50 md:bg-danger-soft/30' : r.status === 'new' || r.status === 'update' ? 'border-primary/30 md:bg-primary-soft/30' : 'border-border',
              )}
            >
              <div className={clsx('grid grid-cols-3 gap-2 md:items-center md:gap-x-2', COLS)}>
                <div className="col-span-3 flex min-w-0 items-center gap-2.5 md:col-span-1">
                  <Avatar name={name} color={r.member.avatarColor} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-sm font-semibold leading-snug text-fg" title={name}>
                      {name}
                      {r.isMe && <span className="font-normal text-muted"> (you)</span>}
                    </p>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <Badge tone={st.tone} size="sm" dot>{st.label}</Badge>
                      {r.fromPaste && <Badge tone="accent" size="sm">Pasted</Badge>}
                    </div>
                  </div>
                </div>
                {GAUGE_KEYS.map((k, col) => (
                  <label key={k} className="block min-w-0">
                    <span className="mb-1 block text-[11px] font-medium text-muted md:sr-only">{GAUGE_LABELS[k]}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      enterKeyHint="next"
                      autoComplete="off"
                      maxLength={4}
                      aria-label={`${GAUGE_LABELS[k]} for ${name}`}
                      aria-invalid={r.invalid.has(k) || undefined}
                      data-bulk-cell={`${i}:${col}`}
                      value={r.cells[k]}
                      placeholder={r.status === 'empty' ? '–' : '0'}
                      disabled={disabled}
                      onChange={(e) => onCell(r.member.id, k, e.target.value)}
                      onKeyDown={onKey(i, col)}
                      onFocus={(e) => e.currentTarget.select()}
                      className={clsx(controlClass(r.invalid.has(k)), 'h-10 px-1 text-center font-semibold tabular-nums')}
                    />
                  </label>
                ))}
                <label className="col-span-2 block min-w-0 md:col-span-1">
                  <span className="mb-1 block text-[11px] font-medium text-muted md:sr-only">Check-in</span>
                  <input
                    type="time"
                    aria-label={`Check-in time for ${name}`}
                    data-bulk-cell={`${i}:6`}
                    value={r.checkIn}
                    disabled={disabled}
                    onChange={(e) => onCheckIn(r.member.id, e.target.value)}
                    className={clsx(controlClass(r.problems.some((p) => p.startsWith('Check-in'))), 'h-10 px-2 tabular-nums')}
                  />
                </label>
                <div className="flex items-end justify-end md:items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    label={r.base ? `Undo changes for ${name}` : `Clear ${name}`}
                    onClick={() => onUndo(r.member.id)}
                    disabled={disabled || !r.edited}
                  >
                    <RotateCcw aria-hidden />
                  </Button>
                </div>
              </div>
              {issues.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs font-medium text-danger" role="alert">
                  {issues.map((p) => (
                    <li key={p} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className={clsx('mt-3 rounded-xl border border-border bg-surface-2/70 px-3 py-2.5 text-sm md:mt-0 md:grid md:gap-x-2 md:rounded-none md:rounded-b-xl md:border-0 md:border-t md:px-4', COLS)} data-bulk-total>
        <span className="font-semibold text-fg">Team total</span>
        {/* phone: one line; desktop: under each column */}
        <span className="ml-2 text-muted md:hidden">
          {formatNumber(totals.stops)} stops · {formatNumber(totals.presentations)} pres. · <span className="font-semibold text-fg">{formatNumber(totals.sales)} sales</span>
        </span>
        {GAUGE_KEYS.map((k) => (
          <span key={k} className="hidden text-center font-semibold tabular-nums text-fg md:block">{formatNumber(totals[k])}</span>
        ))}
      </div>
    </div>
  );
}
