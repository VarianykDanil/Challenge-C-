// KPI strip derived from GaugeTotals + ratios (used by event detail, performance panels and team views).
import type { FunnelRatios, GaugeTotals } from '@lm/shared';
import { KpiTile } from '@/components/ui';
import { formatDecimal, formatNumber, formatPct, formatStopsPerSale } from '@/lib/format';
import { ratioTone } from '@/lib/ratios';

export function TotalsKpis({ totals, ratios, days, daysHint, salesPerDay, className }: { totals: GaugeTotals; ratios: FunnelRatios; days?: number; /** Replaces the "N days worked" hint (e.g. "5 reps logged" on an event). */ daysHint?: string; salesPerDay?: number; className?: string }) {
  const convTone = ratioTone('overallConversion', ratios.overallConversion);
  return (
    <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 ${className ?? ''}`}>
      <KpiTile label="Sales" value={formatNumber(totals.sales)} tone="primary" hint={salesPerDay != null ? `${formatDecimal(salesPerDay)} per day` : undefined} />
      <KpiTile label="Stops" value={formatNumber(totals.stops)} hint={daysHint ?? (days != null ? `${formatNumber(days)} day${days === 1 ? '' : 's'} worked` : undefined)} />
      <KpiTile label="Presentations" value={formatNumber(totals.presentations)} hint={`${formatNumber(totals.table)} to table`} />
      <KpiTile label="Closes · Taps" value={`${formatNumber(totals.closes)} · ${formatNumber(totals.taps)}`} hint={`${formatPct(ratios.closeToTap)} close → tap`} />
      <KpiTile label="Conversion" value={formatPct(ratios.overallConversion, 1)} tone={convTone} hint="sales ÷ stops" />
      <KpiTile label="Stops per sale" value={formatStopsPerSale(ratios.stopsPerSale)} hint="lower is better" />
    </div>
  );
}
