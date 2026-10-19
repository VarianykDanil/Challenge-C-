// Personal pace note under the coaching insights — OWNED BY p2-personal-pace-streaks.
// Mounted by p1 in the "Your funnel" card directly under CoachingInsights (dashboard), inside an ErrorBoundary, for
// every role that has personal charts. Same visual language as CoachingInsights: one tinted row per message.
//  - baseline.alerts: this week against the person's OWN usual 8 weeks (copy written by the server, at most 2);
//  - direction: one extra line when the 16-week conversion trend is not 'steady'.
// Renders nothing when both props are null/undefined, or when there is no alert and the trend is steady — so new
// starters, recruiters and quiet weeks see the card exactly as before. Only ever the caller's own figures.
import { CheckCircle2, Lightbulb, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { PersonalBaseline, TrendDirection } from '@lm/shared';
import { formatPct } from '@/lib/format';

export interface BaselineNoteProps {
  /** insights.personal.baseline — undefined while /me/insights loads. */
  baseline: PersonalBaseline | null | undefined;
  /** insights.personal.direction — undefined while /me/insights loads. */
  direction: TrendDirection | null | undefined;
  className?: string;
}

/** The direction compares the oldest 8 with the newest 8 of this many completed weeks (server PACE_HISTORY_WEEKS). */
const DIRECTION_WEEKS = 16;

type Tone = 'positive' | 'warning';

interface NoteLine {
  key: string;
  tone: Tone;
  Icon: LucideIcon;
  lead: string;
  rest: string;
}

/** The one-line conversion trend, or null when it is steady or unknown. */
function directionLine(direction: TrendDirection | null | undefined): Omit<NoteLine, 'key' | 'Icon'> | null {
  if (!direction || direction.label === 'steady') return null;
  const from = formatPct(direction.earlierConversion, 1);
  const to = formatPct(direction.recentConversion, 1);
  if (direction.label === 'improving') return { tone: 'positive', lead: 'Steadily improving:', rest: ` ${from} → ${to} over the last ${DIRECTION_WEEKS} weeks` };
  return { tone: 'warning', lead: 'Conversion has drifted', rest: ` from ${from} to ${to} over ${DIRECTION_WEEKS} weeks — your coaching card shows where to start` };
}

export function BaselineNote({ baseline, direction, className }: BaselineNoteProps) {
  const lines: NoteLine[] = (baseline?.alerts ?? []).slice(0, 2).map((a, i) => ({
    key: `${a.metric}-${a.tone}-${i}`,
    tone: a.tone,
    Icon: a.tone === 'positive' ? CheckCircle2 : Lightbulb,
    lead: `${a.title} · `,
    rest: a.body,
  }));
  const trend = directionLine(direction);
  if (trend) lines.push({ key: 'direction', Icon: trend.tone === 'positive' ? TrendingUp : TrendingDown, ...trend });
  if (!lines.length) return null;
  return (
    <ul className={clsx('space-y-2', className)} aria-label="Your usual pace">
      {lines.map(({ key, tone, Icon, lead, rest }) => (
        <li key={key} className={clsx('flex items-start gap-2 rounded-lg p-3 text-xs', tone === 'warning' ? 'bg-warning/10' : 'bg-success/10')}>
          <Icon className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', tone === 'warning' ? 'text-warning' : 'text-success')} aria-hidden />
          <span className="min-w-0 text-muted"><span className="font-semibold text-fg">{lead}</span>{rest}</span>
        </li>
      ))}
    </ul>
  );
}
