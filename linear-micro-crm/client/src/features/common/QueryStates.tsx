// Loading, error and empty-state helpers shared by every list and card.
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Card, Skeleton } from '@/components/ui';
import { ApiError } from '@/api/client';

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details) && err.details.length) return `${err.message}: ${err.details.join('; ')}`;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export function ErrorState({ error, onRetry, title = 'Could not load this section', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <div role="alert" className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-danger/40 bg-danger/5 p-8 text-center ${className ?? ''}`}>
      <AlertTriangle className="h-6 w-6 text-danger" aria-hidden />
      <div className="text-sm font-semibold text-fg">{title}</div>
      <p className="max-w-md text-sm text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function KpiSkeletons({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-20" />
          <Skeleton className="mt-2 h-3 w-28" />
        </Card>
      ))}
    </>
  );
}

export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className ?? ''}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div style={{ height }} aria-busy="true" aria-label="Loading chart">
      <Skeleton className="h-full w-full" />
    </div>
  );
}
