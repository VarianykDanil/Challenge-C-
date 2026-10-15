// Compact inline statistic (label above value) used inside cards.
import type { ReactNode } from 'react';

export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-fg">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
