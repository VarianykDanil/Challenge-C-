// Loading, error and empty-state helpers shared by every list and card.
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { Button, Card, Skeleton } from '@/components/ui';
import { ApiError, isNetworkError } from '@/api/client';
import { summariseProblems } from '@/lib/problemList';

/** Every validation detail as a "field: message" line (zod `{ path, message }` objects or plain strings). */
export function errorDetails(err: unknown): string[] {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return [];
  return err.details.map((d: unknown) => {
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const { path, message } = d as { path?: unknown; message?: unknown };
      const p = Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : '';
      return `${p ? `${p}: ` : ''}${typeof message === 'string' ? message : JSON.stringify(d)}`;
    }
    return String(d);
  });
}

/** One-line summary for toasts: the server message plus the first `maxDetails` detail lines. */
export function errorMessage(err: unknown, fallback = 'Something went wrong', maxDetails = 3): string {
  if (err instanceof ApiError) {
    const details = errorDetails(err);
    if (details.length) {
      const { shown, more } = summariseProblems(details, maxDetails);
      return `${err.message}: ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

/** The server's own message when it sent one, otherwise `fallback` (the generic "Request failed (n)" is never shown). */
export function apiMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message && !/^Request failed/.test(err.message) ? err.message : fallback;
  return errorMessage(err, fallback);
}

export function ErrorState({ error, onRetry, title = 'Could not load this section', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  // No signal is not a fault: say so calmly, and that it loads by itself when the connection is back.
  if (isNetworkError(error)) {
    return (
      <div role="status" className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-surface-2/60 p-8 text-center ${className ?? ''}`}>
        <WifiOff className="h-6 w-6 text-muted" aria-hidden />
        <div className="text-sm font-semibold text-fg">You’re offline</div>
        <p className="max-w-md text-sm text-muted">This needs a connection and loads when you’re back. Gauges and check-ins you save meanwhile wait on this phone.</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}>
            Try again
          </Button>
        )}
      </div>
    );
  }
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
