// Release 1.3 — OWNED BY P9 audit-everything. The kinds of action the trail records, as the Audit page and Team →
// person → Activity show them: an icon and tone per kind, who "did" a row without a person, and the filter chips.
import type { ReactNode } from 'react';
import { Bot, Building2, Download, Eye, Layers, LogIn, PencilLine } from 'lucide-react';
import clsx from 'clsx';
import { AUDIT_EVENT_KIND_LABELS, isAuditAttemptOnAccount, isAuditFailedAttempt, type AuditEntryDetail, type AuditEventKind } from '@lm/shared';
import type { BadgeTone } from '@/components/ui';

export const KIND_ICONS: Record<AuditEventKind, ReactNode> = {
  change: <PencilLine aria-hidden />,
  sign_in: <LogIn aria-hidden />,
  export: <Download aria-hidden />,
  opened: <Eye aria-hidden />,
  automatic: <Bot aria-hidden />,
  client: <Building2 aria-hidden />,
};

export const KIND_TONES: Record<AuditEventKind, BadgeTone> = {
  change: 'neutral',
  sign_in: 'info',
  export: 'primary',
  opened: 'accent',
  automatic: 'neutral',
  client: 'warning',
};

/** A failed sign-in, wrong PIN or wrong two-step code (the server stores a `reason`; shared isAuditFailedAttempt). */
export function isFailedAttempt(entry: Pick<AuditEntryDetail, 'kind' | 'after'>): boolean {
  return isAuditFailedAttempt(entry);
}

/**
 * A failed try on the sign-in page, filed under the account it was tried on — whoever typed it may not be that person
 * (shared isAuditAttemptOnAccount). A wrong current PIN or code in Settings is the signed-in person's own.
 */
export function isAttemptOnAccount(entry: Pick<AuditEntryDetail, 'kind' | 'action' | 'after'>): boolean {
  return isAuditAttemptOnAccount(entry);
}

/**
 * Who a row names: the person who acted; "Attempt on Jordan Lee's account" for a failed sign-in-page try on a real
 * account (never "Jordan Lee" as if he typed it); "Unknown person" for a try with an email nobody has; otherwise
 * "Linear Hub" (an automatic step, or the trail's own note that it paused recording failed sign-ins).
 */
export function auditActorName(entry: Pick<AuditEntryDetail, 'userName' | 'kind' | 'action' | 'after'>): string {
  if (entry.userName) return isAttemptOnAccount(entry) ? `Attempt on ${entry.userName}'s account` : entry.userName;
  return isFailedAttempt(entry) ? 'Unknown person' : 'Linear Hub';
}

/** The filter: everything, or one kind. '' = everything. */
export type KindFilter = AuditEventKind | '';

export const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'change', label: AUDIT_EVENT_KIND_LABELS.change },
  { value: 'sign_in', label: AUDIT_EVENT_KIND_LABELS.sign_in },
  { value: 'export', label: AUDIT_EVENT_KIND_LABELS.export },
  // "Opened" (not "Opened records") so the chips fit three rows on a 375 px phone
  { value: 'opened', label: 'Opened' },
  { value: 'automatic', label: AUDIT_EVENT_KIND_LABELS.automatic },
  { value: 'client', label: AUDIT_EVENT_KIND_LABELS.client },
];

export interface KindChipsProps {
  value: KindFilter;
  onChange: (value: KindFilter) => void;
  /** Leave some kinds out (a staff member's timeline has no client-portal or automatic rows). */
  omit?: readonly KindFilter[];
  className?: string;
  'aria-label'?: string;
}

/** One row of wrapping chips, one choice at a time (pressed / not pressed): 40 px tall on phones, 32 px from `sm`. */
export function KindChips({ value, onChange, omit = [], className, 'aria-label': ariaLabel = 'Show' }: KindChipsProps) {
  const options = KIND_FILTERS.filter((o) => !omit.includes(o.value));
  return (
    <div role="group" aria-label={ariaLabel} className={clsx('flex flex-wrap gap-2', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value || 'all'}
            type="button"
            aria-pressed={on}
            title={o.value ? AUDIT_EVENT_KIND_LABELS[o.value] : 'Every kind of action'}
            onClick={() => onChange(o.value)}
            className={clsx(
              'focus-ring inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors sm:h-8 [&_svg]:h-3.5 [&_svg]:w-3.5',
              on ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-fg hover:bg-surface-2',
            )}
          >
            {o.value ? KIND_ICONS[o.value] : <Layers aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
