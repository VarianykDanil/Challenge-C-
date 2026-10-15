import clsx from 'clsx';
import { chartTokens, formatNumber, seriesColor } from './theme';

export interface SparklineProps {
  data: number[];
  /** Line colour; defaults to the first chart colour. */
  color?: string;
  height?: number;
  width?: number;
  className?: string;
  /** Line thickness in px (default 2). */
  strokeWidth?: number;
  /** Mark the latest value with a dot (default true). */
  showEndDot?: boolean;
  /** Add a faint area wash under the line. */
  fill?: boolean;
  /** Override the generated accessible summary. */
  ariaLabel?: string;
}

/**
 * Tiny inline line for stat tiles and table cells: no axes, no labels, 2px line, end dot with a
 * surface ring. Stretches to any CSS size without the stroke scaling.
 */
export function Sparkline({
  data,
  color,
  height = 32,
  width = 96,
  className,
  strokeWidth = 2,
  showEndDot = true,
  fill = false,
  ariaLabel,
}: SparklineProps) {
  const values = data.filter((v) => Number.isFinite(v));
  const stroke = color ?? seriesColor(0);
  const pad = 4;

  if (values.length === 0) {
    return (
      <svg
        role="img"
        aria-label={ariaLabel ?? 'No data'}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={clsx('overflow-visible', className)}
      >
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} stroke={chartTokens.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const points = values.map((v, i) => {
    const x = values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * innerW;
    const y = span === 0 ? height / 2 : pad + innerH - ((v - min) / span) * innerH;
    return [x, y] as const;
  });
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${path} L${points[points.length - 1][0].toFixed(2)} ${height - pad} L${points[0][0].toFixed(2)} ${height - pad} Z`;
  const [endX, endY] = points[points.length - 1];
  const first = values[0];
  const last = values[values.length - 1];
  const label =
    ariaLabel ??
    (values.length === 1
      ? `Single value ${formatNumber(first)}`
      : `Trend of ${values.length} values from ${formatNumber(first)} to ${formatNumber(last)}, low ${formatNumber(min)}, high ${formatNumber(max)}`);

  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={clsx('overflow-visible', className)}
    >
      {fill && values.length > 1 && <path d={area} fill={stroke} fillOpacity={0.1} stroke="none" />}
      {values.length > 1 && (
        <path d={path} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      )}
      {showEndDot && (
        <>
          <circle cx={endX} cy={endY} r={5} fill={chartTokens.surface} />
          <circle cx={endX} cy={endY} r={3} fill={stroke} />
        </>
      )}
    </svg>
  );
}
