// Release 1.2 — L1: a lesson's state as a pill (icon + label, never colour alone).
import { CheckCheck, Circle, GraduationCap, Send } from 'lucide-react';
import type { LessonState } from '@lm/shared';
import { Badge } from '@/components/ui';
import { STATE_COPY, stateLabel } from '@/content/learning';

const ICON = { new: Circle, learned: GraduationCap, teachback_sent: Send, taught: CheckCheck } as const;

export function StateBadge({ state, task, size = 'sm', className }: { state: LessonState; task?: boolean; size?: 'sm' | 'md'; className?: string }) {
  const Icon = ICON[state];
  return (
    <Badge tone={STATE_COPY[state].tone} size={size} className={className}>
      <Icon aria-hidden />
      {stateLabel(state, task)}
    </Badge>
  );
}
