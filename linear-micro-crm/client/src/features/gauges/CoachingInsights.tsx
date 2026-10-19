// 1–3 coaching messages from the shared insight engine, with a tone icon each.
// `subject` (smart release 1.1, p4): 'you' (default) for a person's own funnel, 'team' for a leader's team card,
// 'company' for the owner's company section. Only the wording changes; the rules are shared.
import { CheckCircle2, Info, Lightbulb } from 'lucide-react';
import clsx from 'clsx';
import type { FunnelRatios, GaugeTotals, InsightSubject } from '@lm/shared';
import { BENCHMARK_RATIOS, coachingInsights } from '@lm/shared';

const LABELS: Record<InsightSubject, string> = { you: 'Coaching insights', team: 'Team coaching insights', company: 'Company coaching insights' };

export function CoachingInsights({ totals, ratios, className, subject = 'you' }: { totals: GaugeTotals; ratios: FunnelRatios; className?: string; subject?: InsightSubject }) {
  const insights = coachingInsights(totals, ratios, BENCHMARK_RATIOS, subject);
  return (
    <ul className={clsx('space-y-2', className)} aria-label={LABELS[subject]}>
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
