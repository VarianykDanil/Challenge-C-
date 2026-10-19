// "Needs attention" dashboard card — OWNED BY p5-needs-attention-feed.
// Mounted at the top of the dashboard for every role, inside an ErrorBoundary. Reads useAttention() itself (the same
// query the bell polls, so both always agree): up to `max` rows (severity icon, title, body, link) with 'Show all';
// when there is nothing, a single 'All caught up' line. Renders nothing while the smart features are switched off.
// `AttentionRow` and `AttentionIcon` are shared with the topbar bell.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BellRing, CircleCheck, Info, OctagonAlert, RotateCw, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { AttentionItem } from '@lm/shared';
import { useAttention } from '@/api/hooks';
import { Card, CardHeader, Skeleton } from '@/components/ui';

export interface AttentionCardProps {
  /** Rows shown before 'Show all' (default 5). */
  max?: number;
}

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

export function AttentionCard({ max = 5 }: AttentionCardProps) {
  const q = useAttention();
  const [showAll, setShowAll] = useState(false);
  const feed = q.data;

  if (feed?.disabled) return null;

  if (!feed) {
    if (q.isError) {
      return (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface px-4 py-2 text-sm text-muted shadow-card">
          <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">Could not check what needs your attention.</span>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 font-semibold text-primary hover:bg-surface-2"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
        </div>
      );
    }
    return <Skeleton className="h-14 w-full" />;
  }

  const checked = attentionCheckedAt(feed.generatedAt);
  if (!feed.items.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-card" data-attention-empty>
        <CircleCheck className="h-5 w-5 shrink-0 text-success" aria-hidden />
        <span className="min-w-0 flex-1 text-fg">
          <span className="font-semibold">All caught up.</span> <span className="text-muted">Nothing needs your attention right now.</span>
        </span>
        {checked && <span className="hidden shrink-0 text-xs text-muted sm:inline">Checked {checked}</span>}
      </div>
    );
  }

  const items = feed.items;
  const shown = showAll ? items : items.slice(0, max);
  const urgent = items.filter((i) => i.severity === 'danger').length;
  const summary = `${items.length} ${items.length === 1 ? 'thing' : 'things'} to look at${urgent ? ` · ${urgent} urgent` : ''}${checked ? ` · checked ${checked}` : ''}`;

  return (
    <Card data-attention-card>
      <CardHeader title="Needs attention" description={summary} icon={<BellRing />} className="mb-2" />
      <ul className="-mx-2.5 grid grid-cols-1 gap-x-4 gap-y-0.5 lg:grid-cols-2" aria-label="Needs attention">
        {shown.map((item) => (
          <li key={item.key} className="min-w-0">
            <AttentionRow item={item} />
          </li>
        ))}
      </ul>
      {items.length > max && (
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="focus-ring inline-flex min-h-10 items-center rounded-lg px-2 text-sm font-semibold text-primary hover:bg-surface-2"
          >
            {showAll ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        </div>
      )}
    </Card>
  );
}
