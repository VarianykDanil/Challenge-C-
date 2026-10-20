// Release 1.2 slot — OWNED BY L1 learning-pack.
// The dashboard strip "Your next level: 12 of 14 sales this week; 9 of 21 lessons learned" (GET
// /learning/progression/:me), linking to /learning/progress. Mounted in pages/Dashboard.tsx for reps and leaders, under
// the KPI tiles and the week's pay estimate, in an ErrorBoundary with fallback={null}; `className` carries the
// spacing above it (mt-3) so nothing moves while it renders null. Hidden while loading, on an error, when the smart
// kill switch is on and for anyone outside the field ladder. Kept light: no lesson content, no charts.
import { Link } from 'react-router-dom';
import { ChevronRight, GraduationCap } from 'lucide-react';
import clsx from 'clsx';
import { CAREER_LEVEL_LABELS } from '@lm/shared';
import { useProgression } from '@/api/learning';
import { useCurrentUser } from '@/auth/AuthProvider';

export interface ProgressCardProps {
  className?: string;
}

export function ProgressCard({ className }: ProgressCardProps) {
  const me = useCurrentUser();
  const q = useProgression(me.id);
  const p = q.data;
  if (!p || p.enabled === false || !p.level || !p.headline) return null;
  return (
    <Link
      to="/learning/progress"
      data-progress-card=""
      aria-label={`${p.headline}. Open your checklist and progression.`}
      className={clsx(
        'focus-ring group flex min-h-10 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 shadow-card transition-colors hover:border-border-strong hover:bg-surface-2/60 sm:px-4',
        className,
      )}
    >
      <GraduationCap className="hidden h-4 w-4 shrink-0 text-primary sm:block" aria-hidden />
      <span className="min-w-0 flex-1 leading-5" aria-hidden>
        <span className="block text-[13px] text-fg sm:text-sm">{p.headline}</span>
        {p.nextLevel && (
          <span className="block text-xs text-muted">
            {CAREER_LEVEL_LABELS[p.level]} → {CAREER_LEVEL_LABELS[p.nextLevel]} · from the COD pack
          </span>
        )}
      </span>
      <ChevronRight className="hidden h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 min-[400px]:block" aria-hidden />
    </Link>
  );
}
