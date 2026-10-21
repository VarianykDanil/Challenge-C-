// Release 1.2 — OWNED BY U3 audit-trail. One audit row: who, when, the summary, and (expanded) the field-level diff.
// Used by the /audit page and the EntityHistory slot.
import { useId, useState } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { AUDIT_ENTITY_LABELS, auditFieldLabel, auditValueText, type AuditEntity, type AuditEntryDetail, type AuditFieldChange } from '@lm/shared';
import { Avatar, Badge } from '@/components/ui';
import { formatDateTime, formatNumber, formatTime } from '@/lib/format';
import { isAuditLongText, longTextHeadline } from './longText';

const LONG_TEXT = 60;

function isLong(v: unknown): v is string {
  return typeof v === 'string' && (v.length > LONG_TEXT || v.includes('\n'));
}

/** A field's label in the diff; a pitch's text is its script. */
function fieldLabel(field: string, entity?: AuditEntity | null): string {
  return entity === 'pitch' && field === 'body' ? 'Script' : auditFieldLabel(field);
}

const boxTone = (tone: 'before' | 'after') => (tone === 'before' ? 'bg-danger-soft/60 text-fg' : 'bg-success-soft/60 text-fg');

/** One value of a diff: long text in full (scrolls inside its box), everything else through the shared wording. */
function DiffValue({ field, value, tone }: { field: string; value: unknown; tone: 'before' | 'after' }) {
  const empty = value === null || value === undefined || value === '';
  if (isAuditLongText(value)) {
    // over 2,000 characters: the trail keeps the length and the first 200 characters only
    return (
      <span className="block min-w-0">
        <span className={clsx('block whitespace-pre-wrap break-words rounded-md px-2 py-1.5 text-xs leading-relaxed', boxTone(tone))}>
          {value.head.trimEnd()}…
        </span>
        <span className="mt-1 block text-[11px] text-muted">First {formatNumber(Math.min(value.head.length, value.length))} of {formatNumber(value.length)} characters</span>
      </span>
    );
  }
  if (isLong(value)) {
    return (
      <span className={clsx('block max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md px-2 py-1.5 text-xs leading-relaxed scrollbar-thin', boxTone(tone))}>
        {value}
      </span>
    );
  }
  return (
    <span className={clsx('break-words', empty ? 'text-muted' : tone === 'before' ? 'text-muted line-through decoration-danger/50' : 'font-medium text-fg')}>
      {auditValueText(field, value)}
    </span>
  );
}

/**
 * The field-level differences: a table on wide screens, stacked "before → after" rows on a phone. Text the trail
 * stored as its length and start (over 2,000 characters) gets a headline beside its label: "Script" · "Changed ·
 * 19,204 characters (was 18,950)".
 */
export function AuditDiffTable({ diff, entity, className }: { diff: AuditFieldChange[]; entity?: AuditEntity | null; className?: string }) {
  if (!diff.length) return <p className={clsx('text-xs text-muted', className)}>No field changes were recorded for this action.</p>;
  return (
    <dl className={clsx('divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface', className)}>
      {diff.map((d) => (
        <div key={d.field} className="grid grid-cols-1 gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(8rem,12rem)_1fr] sm:gap-3">
          <dt className="text-xs font-medium text-muted sm:pt-0.5">{fieldLabel(d.field, entity)}</dt>
          <dd className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
            {isAuditLongText(d.before) || isAuditLongText(d.after) ? (
              <span className="w-full min-w-0">
                <span className="mb-1.5 block font-medium text-fg">{longTextHeadline(d.before, d.after)}</span>
                <span className="grid w-full min-w-0 gap-1.5 md:grid-cols-2">
                  <span className="min-w-0"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">Before</span><DiffValue field={d.field} value={d.before} tone="before" /></span>
                  <span className="min-w-0"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">After</span><DiffValue field={d.field} value={d.after} tone="after" /></span>
                </span>
              </span>
            ) : isLong(d.before) || isLong(d.after) ? (
              <span className="grid w-full min-w-0 gap-1.5 md:grid-cols-2">
                <span className="min-w-0"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">Before</span><DiffValue field={d.field} value={d.before} tone="before" /></span>
                <span className="min-w-0"><span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">After</span><DiffValue field={d.field} value={d.after} tone="after" /></span>
              </span>
            ) : (
              <>
                <DiffValue field={d.field} value={d.before} tone="before" />
                <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" aria-label="changed to" />
                <DiffValue field={d.field} value={d.after} tone="after" />
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface AuditEntryItemProps {
  entry: AuditEntryDetail;
  /** Show the entity badge (the /audit page; the entity history knows its entity already). */
  showEntity?: boolean;
  /** Time only (rows grouped under a day heading) instead of date and time. */
  timeOnly?: boolean;
  compact?: boolean;
}

export function AuditEntryItem({ entry, showEntity = true, timeOnly, compact }: AuditEntryItemProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const who = entry.userName ?? 'Linear Hub';
  const when = timeOnly ? formatTime(entry.at) : formatDateTime(entry.at);
  const changes = entry.diff.length;
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={clsx('focus-ring-inset flex w-full min-w-0 items-start gap-3 text-left transition-colors hover:bg-surface-2', compact ? 'min-h-11 px-3 py-2.5' : 'min-h-14 px-4 py-3')}
      >
        <Avatar name={who} size={compact ? 'xs' : 'sm'} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm text-fg">{entry.summary}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="font-medium text-fg/80">{who}</span>
            <span aria-hidden>·</span>
            <time dateTime={entry.at} title={formatDateTime(entry.at)} className="tabular">{when}</time>
            {showEntity && entry.entity && <Badge size="sm" tone="neutral">{AUDIT_ENTITY_LABELS[entry.entity]}</Badge>}
            {changes > 0 && <span>{changes === 1 ? '1 field' : `${changes} fields`}</span>}
          </span>
        </span>
        <ChevronDown className={clsx('mt-1 h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div id={panelId} className={clsx('border-t border-border bg-surface-2/50', compact ? 'px-3 py-3' : 'px-4 py-3 sm:pl-[3.75rem]')}>
          <AuditDiffTable diff={entry.diff} entity={entry.entity} />
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="font-mono">{entry.action}</span>
            {entry.entity && entry.entityId != null && <span>{AUDIT_ENTITY_LABELS[entry.entity]} #{entry.entityId}</span>}
            {entry.ip && <span>IP {entry.ip}</span>}
          </p>
        </div>
      )}
    </li>
  );
}
