import clsx from 'clsx';

export interface SkeletonProps {
  className?: string;
  /** Round placeholder (avatars, icon chips). */
  circle?: boolean;
  /** Render n stacked lines; the last one is shorter so the block reads as text. */
  lines?: number;
}

export function Skeleton({ className, circle, lines }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <div className={clsx('flex flex-col gap-2', className)} aria-hidden>
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={clsx('skeleton h-3.5 rounded-md', i === lines - 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    );
  }
  return <div className={clsx('skeleton', circle ? 'rounded-full' : 'rounded-md', className ?? (circle ? 'h-10 w-10' : 'h-4 w-full'))} aria-hidden />;
}

/** Skeleton shaped like a KpiTile. */
export function SkeletonKpi({ className }: { className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-border bg-surface p-5 shadow-card', className)} aria-hidden>
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <Skeleton className="mt-4 h-8 w-28" />
      <Skeleton className="mt-3 h-3 w-36" />
    </div>
  );
}

/** Skeleton shaped like a Card with a header and a few lines. */
export function SkeletonCard({ className, lines = 4 }: { className?: string; lines?: number }) {
  return (
    <div className={clsx('rounded-xl border border-border bg-surface p-5 shadow-card', className)} aria-hidden>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-2 h-3 w-56" />
      <Skeleton className="mt-5" lines={lines} />
    </div>
  );
}
