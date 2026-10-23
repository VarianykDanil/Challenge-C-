/**
 * Chart theme — every colour is a CSS variable from `client/src/index.css`, so charts follow the
 * light/dark theme automatically. Never hard-code hex here.
 */

/** Categorical series colours in fixed order. Assign by series index; never cycle past the end. */
export const CHART_SERIES_COLORS: readonly string[] = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
];

/** Semantic tokens used for chart furniture (axes, grid, tooltip, text). */
export const chartTokens = {
  fg: 'var(--color-fg)',
  muted: 'var(--color-muted)',
  border: 'var(--color-border)',
  surface: 'var(--color-surface)',
  surface2: 'var(--color-surface-2)',
  primary: 'var(--color-primary)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  info: 'var(--color-info)',
} as const;

/** Colour for the series at `index`; an explicit override (e.g. a team's colour) wins; beyond six → muted "Other". */
export function seriesColor(index: number, override?: string | null): string {
  if (override) return override;
  return CHART_SERIES_COLORS[index] ?? chartTokens.muted;
}

/** Consistent plot margins so axes line up across cards. */
export const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 } as const;

/** Axis tick text: small, muted, never the data colour. */
export const AXIS_TICK = { fill: chartTokens.muted, fontSize: 11 } as const;

/** Maximum bar thickness (px) — bars never fill their slot. */
export const MAX_BAR_SIZE = 24;

const LOCALE = 'en-GB';
const numberFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

/** 1234.5 → "1,234.5" */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return numberFmt.format(n);
}

/** 1234 → "1.2K"; small numbers stay plain. Used for axis ticks. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Math.abs(n) >= 1000 ? compactFmt.format(n) : numberFmt.format(n);
}

/** 36000 → "£36K", 950 → "£950" (axis ticks in pounds: the full "£36,000" does not fit the 44 px axis). */
export function formatGBPCompact(n: number): string {
  if (!Number.isFinite(n)) return '';
  return `${n < 0 ? '−' : ''}£${formatCompact(Math.abs(n))}`;
}

/** 0.384 → "38%" */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Build a sentence list: ["a", "b", "c"] → "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A translucent wash of a token colour, for chips and highlights (works in both themes). */
export function wash(color: string, percent = 14): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}
