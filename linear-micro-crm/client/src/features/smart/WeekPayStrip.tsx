// "This week (estimate)" pay strip — OWNED BY p3-money-forecast-payroll-checks.
// Stub from p1: renders nothing. Mounted directly under the dashboard KPI tiles for reps and leaders only, inside an
// ErrorBoundary, in the same wrapper as the tile grid (so it sits close to the tiles: add your own top margin, e.g.
// mt-3). Hidden when forecast is null/undefined. At most 2 lines at 360 px.
import type { PayForecast } from '@lm/shared';

export interface WeekPayStripProps {
  /** insights.personal.payForecast — undefined while /me/insights loads. */
  forecast: PayForecast | null | undefined;
  className?: string;
}

export function WeekPayStrip(_props: WeekPayStripProps) {
  return null;
}
