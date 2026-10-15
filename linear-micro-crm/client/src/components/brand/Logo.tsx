// Owned by the Product Designer.
// Linear MCR / Linear Hub identity: a forward-leaning wedge of three parallel lines
// (the "linear" motif — momentum, stops stacking into sales) on a rounded tile.
// Colours come from tokens so the mark works in both themes; the wordmark uses currentColor.
import type { CSSProperties } from 'react';
import clsx from 'clsx';

export type LogoVariant = 'full' | 'mark' | 'wordmark';
export type LogoTone = 'brand' | 'mono' | 'inverse';

export interface LogoProps {
  variant?: LogoVariant;
  /** Height of the mark in px; the wordmark scales with it. */
  size?: number;
  className?: string;
  /**
   * brand   — primary tile, primary-fg lines (default)
   * mono    — tile in currentColor, lines punched out in the page background
   * inverse — white tile with primary lines, for use on saturated/dark panels
   */
  tone?: LogoTone;
  /** Wordmark text; the first word is set bold, the remainder in the primary colour. */
  text?: string;
  /** Accessible label; set to "" to hide the logo from screen readers. */
  title?: string;
}

const MARK_STYLES: Record<LogoTone, { tile: string; line: string }> = {
  brand: { tile: 'var(--primary)', line: 'var(--primary-fg)' },
  mono: { tile: 'currentColor', line: 'var(--bg)' },
  inverse: { tile: '#FFFFFF', line: 'var(--primary)' },
};

export interface LogoMarkProps { size?: number; tone?: LogoTone; className?: string; title?: string }

/** The monogram tile alone. */
export function LogoMark({ size = 28, tone = 'brand', className, title = 'Linear Hub' }: LogoMarkProps) {
  const c = MARK_STYLES[tone];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={clsx('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect x="0" y="0" width="32" height="32" rx="8" fill={c.tile} />
      <g
        fill="none"
        stroke={c.line}
        strokeWidth="3.2"
        strokeLinecap="round"
        transform="translate(16 16) skewX(-14) translate(-16 -16)"
      >
        <path d="M10 10h6" />
        <path d="M10 16h10" />
        <path d="M10 22h14" />
      </g>
    </svg>
  );
}

export interface WordmarkProps { size?: number; text?: string; className?: string; tone?: LogoTone }

/** The wordmark alone — "Linear" in currentColor, product name in the primary colour. */
export function Wordmark({ size = 28, text = 'Linear Hub', className, tone = 'brand' }: WordmarkProps) {
  const [first, ...rest] = text.trim().split(/\s+/);
  const tail = rest.join(' ');
  const style: CSSProperties = { fontSize: Math.round(size * 0.72), lineHeight: 1 };
  return (
    <span
      className={clsx('inline-flex items-baseline whitespace-nowrap font-display font-bold tracking-[-0.03em] text-current', className)}
      style={style}
    >
      {first}
      {tail && (
        <span className={clsx('ml-[0.28em] font-semibold', tone === 'inverse' ? 'opacity-80' : 'text-primary')}>
          {tail}
        </span>
      )}
    </span>
  );
}

/** Full lockup by default. Compose `LogoMark` and `Wordmark` directly for custom layouts. */
export function Logo({ variant = 'full', size = 28, className, tone = 'brand', text = 'Linear Hub', title = 'Linear Hub' }: LogoProps) {
  if (variant === 'mark') return <LogoMark size={size} tone={tone} className={className} title={title} />;
  if (variant === 'wordmark') return <Wordmark size={size} text={text} tone={tone} className={className} />;
  return (
    <span className={clsx('inline-flex items-center', className)} style={{ gap: Math.round(size * 0.36) }} role="img" aria-label={title || undefined}>
      <LogoMark size={size} tone={tone} title="" />
      <Wordmark size={size} text={text} tone={tone} />
    </span>
  );
}
