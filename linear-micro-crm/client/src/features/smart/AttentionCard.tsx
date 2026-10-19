// "Needs attention" dashboard card — OWNED BY p5-needs-attention-feed.
// Mounted at the top of the dashboard for every role, inside an ErrorBoundary, and loaded on demand (LazyAttentionCard
// in features/smart/lazy.tsx). Reads useAttention() itself (the same query the bell polls, so both always agree): up to
// `max` rows (severity icon, title, body, link) with 'Show all'; when there is nothing, a single 'All caught up' line.
// Renders nothing while the smart features are switched off. `AttentionRow` and `attentionCheckedAt` come from
// AttentionRow.tsx, which the topbar bell shares.
import { useState } from 'react';
import { BellRing, CircleCheck, RotateCw, TriangleAlert } from 'lucide-react';
import { useAttention } from '@/api/hooks';
import { Card, CardHeader, Skeleton } from '@/components/ui';
import { AttentionRow, attentionCheckedAt } from './AttentionRow';

export interface AttentionCardProps {
  /** Rows shown before 'Show all' (default 5). */
  max?: number;
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
