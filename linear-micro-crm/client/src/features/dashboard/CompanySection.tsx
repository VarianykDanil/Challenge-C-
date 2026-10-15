// Admin / leader company overview on the dashboard.
import type { Dashboard } from '@lm/shared';
import { Card, CardHeader, EmptyState, KpiTile } from '@/components/ui';
import { DonutChart, TrendChart } from '@/components/charts';
import { formatDateShort, formatGBP, formatNumber, formatPct } from '@/lib/format';
import { ratioTone } from '@/lib/ratios';

export function CompanySection({ company, rangeLabel }: { company: NonNullable<Dashboard['company']>; rangeLabel: string }) {
  return (
    <section aria-labelledby="company-heading" className="space-y-4">
      <div>
        <h2 id="company-heading" className="text-lg font-semibold text-fg">Company</h2>
        <p className="text-sm text-muted">Linear MCR across every team · {rangeLabel}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Sales" value={formatNumber(company.totals.sales)} tone="primary" hint={`${formatNumber(company.totals.stops)} stops`} />
        <KpiTile label="Revenue" value={formatGBP(company.revenue)} hint="client payouts" />
        <KpiTile label="Active reps" value={formatNumber(company.activeReps)} />
        <KpiTile label="Payroll on time" value={formatPct(company.payrollOnTimeRate)} tone={company.payrollOnTimeRate >= 0.95 ? 'success' : company.payrollOnTimeRate >= 0.8 ? 'warning' : 'danger'} hint={company.payrollOnTimeWindow === 'last12Weeks' ? 'last 12 weeks · none due yet' : company.payrollOnTimeWindow === 'range' ? 'runs due this period' : 'of settled runs'} />
        <KpiTile label="Open candidates" value={formatNumber(company.openCandidates)} hint="in the pipeline" />
        <KpiTile label="Hires" value={formatNumber(company.hiresThisPeriod)} hint="this period" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Company trend" description={`Sales and stops per day · conversion ${formatPct(company.ratios.overallConversion, 1)}`} />
          {company.trend.length ? (
            <TrendChart data={company.trend.map((t) => ({ date: t.date, sales: t.sales, stops: t.stops }))} xKey="date" series={[{ key: 'sales', label: 'Sales' }, { key: 'stops', label: 'Stops' }]} kind="area" xFormatter={formatDateShort} height={240} />
          ) : (
            <EmptyState title="No activity in this range" size="sm" className="border-0" />
          )}
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Sales by campaign" />
          {company.byCampaign.some((c) => c.sales > 0) ? (
            <DonutChart data={company.byCampaign.map((c) => ({ label: c.name, value: c.sales, color: c.color }))} centerLabel="Sales" centerValue={formatNumber(company.totals.sales)} height={220} />
          ) : (
            <EmptyState title="No sales yet" size="sm" className="border-0" />
          )}
          <p className="mt-3 text-xs text-muted">Overall conversion is <span className={`font-semibold ${ratioTone('overallConversion', company.ratios.overallConversion) === 'success' ? 'text-success' : 'text-warning'}`}>{formatPct(company.ratios.overallConversion, 1)}</span>.</p>
        </Card>
      </div>
    </section>
  );
}
