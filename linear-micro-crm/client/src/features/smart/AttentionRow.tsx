// The pieces of a "Needs attention" item shared by the topbar bell and the dashboard card — OWNED BY
// p5-needs-attention-feed. Split out of AttentionCard.tsx (lead decision on the bundle): the bell is global, so these
// stay in the main chunk, while the dashboard-only AttentionCard is loaded on demand (features/smart/lazy.tsx).
import { Link } from 'react-router-dom';
import { ArrowRight, CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { AttentionItem } from '@lm/shared';

type Look = { icon: typeof Info; chip: string; label: string };

const LOOK: Record<AttentionItem['severity'], Look> = {
  danger: { icon: OctagonAlert, chip: 'bg-danger-soft text-danger', label: 'Urgent' },
  warning: { icon: TriangleAlert, chip: 'bg-warning-soft text-warning', label: 'To do' },
  info: { icon: Info, chip: 'bg-info-soft text-info', label: 'For information' },
};
const GOOD_NEWS: Look = { icon: CircleCheck, chip: 'bg-success-soft text-success', label: 'Good news' };

/** The look of an item: its severity, except your own pay landing, which is good news. */
export function attentionLook(item: Pick<AttentionItem, 'key' | 'severity'>): Look {
  return item.key.startsWith('pay:paid:') ? GOOD_NEWS : LOOK[item.severity];
}

/** The severity chip (icon in a soft tint). The label is for screen readers; colour is never the only signal. */
export function AttentionIcon({ item, className }: { item: Pick<AttentionItem, 'key' | 'severity'>; className?: string }) {
  const look = attentionLook(item);
  const Icon = look.icon;
  return (
    <span className={clsx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', look.chip, className)}>
      <Icon className="h-4 w-4" aria-hidden />
      <span className="sr-only">{look.label}: </span>
    </span>
  );
}

/** One item as a single tappable link: icon, title, body and the action label. */
export function AttentionRow({ item, isNew = false, onNavigate, className }: { item: AttentionItem; isNew?: boolean; onNavigate?: () => void; className?: string }) {
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      data-attention-key={item.key}
      className={clsx('focus-ring group flex min-h-11 min-w-0 items-start gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-surface-2', className)}
    >
      <AttentionIcon item={item} />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium leading-snug text-fg">
          {item.title}
          {isNew && (
            <span className="ml-1.5 inline-flex translate-y-[-1px] items-center rounded-full bg-accent-soft px-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-fg">
              New
            </span>
          )}
        </span>
        <span className="mt-0.5 block break-words text-xs leading-relaxed text-muted">{item.body}</span>
        <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary group-hover:underline">
          {item.actionLabel ?? 'Open'}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </span>
      </span>
    </Link>
  );
}

const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "14:02" (London) from the feed's ISO timestamp, or '' when it cannot be read. */
export function attentionCheckedAt(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? CLOCK.format(ms) : '';
}
