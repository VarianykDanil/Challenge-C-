// Charts — keep exported names and prop names stable.
// TrendChart, BarsChart and DonutChart are the lazy wrappers (./lazy.tsx): Recharts loads only when a chart is near the
// screen. Their prop types come from the real components.
export type { TrendChartProps, TrendSeries } from './TrendChart';
export type { BarDatum, BarsChartProps } from './BarsChart';
export type { DonutChartProps, DonutDatum } from './DonutChart';
export { BarsChart, DonutChart, TrendChart } from './lazy';
export * from './FunnelChart';
export * from './Sparkline';
export * from './ChartTooltip';
export * from './ChartLegend';
export * from './EmptyChart';
export * from './theme';
