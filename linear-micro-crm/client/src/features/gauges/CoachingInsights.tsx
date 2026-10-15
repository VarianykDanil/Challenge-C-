// 1–3 coaching messages from the shared insight engine, with a tone icon each.
import { CheckCircle2, Info, Lightbulb } from 'lucide-react';
import clsx from 'clsx';
import type { FunnelRatios, GaugeTotals } from '@lm/shared';
import { coachingInsights } from '@lm/shared';

export function CoachingInsights({ totals, ratios, className }: { totals: GaugeTotals; ratios: FunnelRatios; className?: string }) {
  const insights = coachingInsights(totals, ratios);
  return (
    <ul className={clsx('space-y-2', className)} aria-label="Coaching insights">
      {insights.map((i, idx) => {
        const Icon = i.tone === 'positive' ? CheckCircle2 : i.tone === 'warning' ? Lightbulb : Info;
        return (
          <li key={`${i.title}-${idx}`} className={clsx('flex items-start gap-2 rounded-lg p-3 text-xs', i.tone === 'warning' ? 'bg-warning/10' : i.tone === 'positive' ? 'bg-success/10' : 'bg-surface-2')}>
            <Icon className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', i.tone === 'warning' ? 'text-warning' : i.tone === 'positive' ? 'text-success' : 'text-muted')} aria-hidden />
            <span className="text-muted"><span className="font-semibold text-fg">{i.title} · </span>{i.body}</span>
          </li>
        );
      })}
    </ul>
  );
}
