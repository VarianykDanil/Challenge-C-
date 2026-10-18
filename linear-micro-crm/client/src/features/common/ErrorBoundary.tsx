// Smart release 1.1 (p1): one failing card never blanks a page. Wraps every slot (dashboard cards, the topbar bell,
// the Gauges tally) and the AppShell outlet.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';

/** What a custom fallback gets: the error and a reset that re-renders the children (a "Try again"). */
export interface ErrorBoundaryFallbackProps {
  error: Error;
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown in the console with the error, e.g. "attention" or "page". */
  name?: string;
  /** Fallback heading (default "This card hit a problem"). */
  title?: string;
  /** Extra classes for the fallback box (e.g. spacing inside a card). */
  className?: string;
  /** When any of these change the boundary clears itself (e.g. the route path). */
  resetKeys?: readonly unknown[];
  /** Called when the person presses Try again, before the children re-render. */
  onReset?: () => void;
  /**
   * Replaces the default card-sized box where it would not fit (a 40 px topbar or header slot). A node, or a render
   * function given { error, reset }. `null` hides the slot quietly (the error is still logged).
   */
  fallback?: ReactNode | ((props: ErrorBoundaryFallbackProps) => ReactNode);
}

interface State {
  error: Error | null;
}

const changed = (a: readonly unknown[] = [], b: readonly unknown[] = []) => a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

/**
 * Renders its children untouched (no wrapper element) until one of them throws while rendering; then a small
 * "This card hit a problem · Try again" box replaces only that subtree. Query errors are not render errors: cards
 * keep showing their own ErrorState for those.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && changed(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null });
  }

  reset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (fallback !== undefined) return typeof fallback === 'function' ? fallback({ error, reset: this.reset }) : fallback;
    return (
      <div role="alert" data-error-boundary={this.props.name ?? ''} className={`flex flex-col items-start gap-2 rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between ${this.props.className ?? ''}`}>
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
          <span className="font-medium text-fg">{this.props.title ?? 'This card hit a problem'}</span>
        </div>
        <Button variant="outline" size="sm" onClick={this.reset} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}>
          Try again
        </Button>
      </div>
    );
  }
}
