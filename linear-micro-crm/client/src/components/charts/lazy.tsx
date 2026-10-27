// The drawn charts (TrendChart, BarsChart, DonutChart) use Recharts, the biggest library in the app (about 390 kB).
// Pages import these wrappers instead, so Recharts downloads only when a chart is about to come into view: the first
// screen of a page (on a phone, the tiles and the check-in) shows without waiting for it. Same names and props.
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BarsChartProps } from './BarsChart';
import type { DonutChartProps } from './DonutChart';
import type { TrendChartProps } from './TrendChart';

const TrendImpl = lazy(() => import('./TrendChart').then((m) => ({ default: m.TrendChart })));
const BarsImpl = lazy(() => import('./BarsChart').then((m) => ({ default: m.BarsChart })));
const DonutImpl = lazy(() => import('./DonutChart').then((m) => ({ default: m.DonutChart })));

/** Starts loading this far before the chart scrolls into view, so it is usually drawn by the time it is seen. */
const AHEAD = '400px 0px';

/** True once the box is near the viewport (at once where IntersectionObserver is missing). */
function useNearView(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: AHEAD });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

function Placeholder({ height }: { height: number }) {
  return <div className="skeleton w-full rounded-lg" style={{ height }} aria-busy="true" aria-label="Loading chart" />;
}

/** Holds the chart's space with a placeholder until it is near the screen, then loads and draws it. */
function Deferred({ height, children }: { height: number; children: ReactNode }) {
  const [ref, near] = useNearView();
  return (
    <div ref={ref} className="min-w-0">
      {near ? <Suspense fallback={<Placeholder height={height} />}>{children}</Suspense> : <Placeholder height={height} />}
    </div>
  );
}

export function TrendChart(props: TrendChartProps) {
  return <Deferred height={props.height ?? 220}><TrendImpl {...props} /></Deferred>;
}

export function BarsChart(props: BarsChartProps) {
  const rows = props.data.length;
  const height = props.height ?? (props.horizontal ? Math.max(120, rows * 32 + 24) : 220);
  return <Deferred height={height}><BarsImpl {...props} /></Deferred>;
}

export function DonutChart(props: DonutChartProps) {
  return <Deferred height={props.height ?? 160}><DonutImpl {...props} /></Deferred>;
}
