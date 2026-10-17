// Personal performance view (KPIs, funnel, trend, by-campaign, recent entries, punctuality).
// Shared by Gauges → "My performance" and Team → person detail.
import type { UserPerformance } from '@/api/hooks';
import { Card, CardHeader, EmptyState, KpiTile } from '@/components/ui';
import { FunnelChart, TrendChart } from '@/components/charts';
import { ChartSkeleton, ErrorState, ExportButton, KpiSkeletons } from '@/features/common';
import { csvFilename, sortRows } from '@/lib/csv';
import type { DateRange } from '@/lib/dates';
import { formatDateShort, formatDecimal, formatNumber, formatPct, formatStopsPerSale, fullName } from '@/lib/format';
import { ratioTone } from '@/lib/ratios';
import { COPY } from '@/content/copy';
import { CoachingInsights } from './CoachingInsights';
import { GaugeSummaryTable } from './GaugeSummaryTable';
import { RecentEntriesCard } from './RecentEntriesCard';
import { gaugeSummaryCsvColumns } from './csv';

export function PerformancePanel({ data, loading, error, onRetry, showEntries = true, range, userId }: {
  data: UserPerformance | undefined;
  loading: boolean;
  error: unknown;
  onRetry?: () => void;
  showEntries?: boolean;
  /** The range on screen — names the CSV exports and scopes the paged "Recent entries" list. */
  range?: DateRange;
  /** Whose performance this is; with `range` the entries list pages through GET /gauges. */
  userId?: number;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"><KpiSkeletons count={6} /></div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2"><Card className="min-w-0"><ChartSkeleton /></Card><Card className="min-w-0"><ChartSkeleton /></Card></div>
      </div>
    );
  }
  const { totals, ratios, days, salesPerDay, trend, byCampaign, recentEntries, punctualityRate } = data;
  const who = data.user ? fullName(data.user) : 'me';
  const empty = totals.stops === 0 && days === 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Sales" value={formatNumber(totals.sales)} tone="primary" hint={`${formatDecimal(salesPerDay)} per day`} />
        <KpiTile label="Stops" value={formatNumber(totals.stops)} hint={`${formatNumber(days)} day${days === 1 ? '' : 's'} worked`} />
        <KpiTile label="Presentations" value={formatNumber(totals.presentations)} hint={`${formatPct(ratios.tableToPresentation)} from table`} />
        <KpiTile label="Conversion" value={formatPct(ratios.overallConversion, 1)} tone={ratioTone('overallConversion', ratios.overallConversion)} hint="sales ÷ stops" />
        <KpiTile label="Stops per sale" value={formatStopsPerSale(ratios.stopsPerSale)} hint="lower is better" />
        <KpiTile label="Punctuality" value={punctualityRate == null ? '—' : formatPct(punctualityRate)} tone={punctualityRate == null ? 'default' : punctualityRate >= 0.9 ? 'success' : punctualityRate >= 0.75 ? 'warning' : 'danger'} hint="check-ins on time" />
      </div>

      {empty ? (
        <EmptyState title={COPY.empty.gauges.title} description={COPY.empty.gauges.description} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader title="Funnel vs benchmarks" description="Each stage compared with the law of averages" />
              <FunnelChart totals={totals} ratios={ratios} showBenchmarks />
              <CoachingInsights totals={totals} ratios={ratios} className="mt-3" />
            </Card>
            <Card className="min-w-0">
              <CardHeader title="Trend" description="Sales and stops per day" />
              {trend.length ? (
                <TrendChart data={trend.map((t) => ({ date: t.date, sales: t.sales, stops: t.stops, presentations: t.presentations }))} xKey="date" series={[{ key: 'sales', label: 'Sales' }, { key: 'stops', label: 'Stops' }]} kind="area" xFormatter={formatDateShort} height={240} />
              ) : (
                <EmptyState title="No trend data" size="sm" className="border-0" />
              )}
            </Card>
          </div>
          <Card padded={false} className="min-w-0 overflow-hidden">
            <div className="p-5 pb-3"><CardHeader title="By campaign" description="Where the sales came from" className="mb-0" actions={<ExportButton filename={csvFilename(`gauges-${who}-by-campaign`, range)} rows={sortRows(byCampaign, (r) => r.sales, 'desc')} columns={gaugeSummaryCsvColumns('campaign', false)} />} /></div>
            <GaugeSummaryTable rows={byCampaign} groupBy="campaign" perRep={false} bare className="border-t border-border" />
          </Card>
          {showEntries && <RecentEntriesCard userId={userId ?? data.user?.id} range={range} fallback={recentEntries} who={who} />}
        </>
      )}
    </div>
  );
}
