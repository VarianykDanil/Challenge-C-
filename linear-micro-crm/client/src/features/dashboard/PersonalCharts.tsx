// "Your trend" and "Your funnel" cards of the dashboard (split out of pages/Dashboard.tsx by p1 with identical
// output). The p2 BaselineNote slot sits under the coaching insights (p4's file); each has its own ErrorBoundary.
import type { Dashboard, PersonalBaseline, TrendDirection } from '@lm/shared';
import { Button, Card, CardHeader, EmptyState } from '@/components/ui';
import { FunnelChart, TrendChart } from '@/components/charts';
import { ChartSkeleton, ErrorBoundary } from '@/features/common';
import { CoachingInsights } from '@/features/gauges';
import { LazyBaselineNote } from '@/features/smart';
import { formatDateShort } from '@/lib/format';

export interface PersonalChartsProps {
  dashboard: Dashboard | undefined;
  /** Show the "Log gauges" action in the empty trend. */
  canLog: boolean;
  onLog: () => void;
  /** insights.personal.baseline / direction (p2). */
  baseline?: PersonalBaseline | null;
  direction?: TrendDirection | null;
}

export function PersonalCharts({ dashboard: d, canLog, onLog, baseline, direction }: PersonalChartsProps) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <Card className="min-w-0 lg:col-span-3">
        <CardHeader title="Your trend" description="Sales and stops per day" />
        {!d ? <ChartSkeleton /> : d.personal.trend.length ? (
          <TrendChart data={d.personal.trend.map((t) => ({ date: t.date, sales: t.sales, stops: t.stops }))} xKey="date" series={[{ key: 'sales', label: 'Sales' }, { key: 'stops', label: 'Stops' }]} kind="area" xFormatter={formatDateShort} height={240} />
        ) : (
          <EmptyState title="No days logged yet" description="Log your gauges after a shift and your trend will build up here." size="sm" className="border-0" action={canLog ? <Button size="sm" onClick={onLog}>Log gauges</Button> : undefined} />
        )}
      </Card>
      <Card className="min-w-0 lg:col-span-2">
        <CardHeader title="Your funnel" description="Against the law of averages" />
        {!d ? <ChartSkeleton /> : (
          <>
            <FunnelChart totals={d.personal.totals} ratios={d.personal.ratios} showBenchmarks compact />
            <ErrorBoundary name="coaching" className="mt-3"><CoachingInsights totals={d.personal.totals} ratios={d.personal.ratios} className="mt-3" /></ErrorBoundary>
            <ErrorBoundary name="baseline" className="mt-3"><LazyBaselineNote baseline={baseline} direction={direction} className="mt-3" /></ErrorBoundary>
          </>
        )}
      </Card>
    </div>
  );
}
