import type { CSSProperties } from 'react';
import clsx from 'clsx';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type AvatarStatus = 'online' | 'offline' | 'away' | 'busy';

export interface AvatarProps {
  name: string;
  /** Entity colour (hex) for the background; defaults to the primary token. */
  color?: string;
  size?: AvatarSize;
  className?: string;
  /** Draw a 2px ring in the page background — for stacks and raised placements. */
  ring?: boolean;
  /** Presence dot in the bottom-right corner. */
  status?: AvatarStatus;
  shape?: 'circle' | 'square';
  /** Optional image; falls back to initials on error or when absent. */
  src?: string | null;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

/** Pick a readable text colour for an arbitrary hex background. */
export function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length !== 6 && h.length !== 3) return '#FFFFFF';
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const l = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  return l > 0.45 ? '#0F1526' : '#FFFFFF';
}

const DIM: Record<AvatarSize, string> = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-base',
  xl: 'h-20 w-20 text-2xl',
};

const DOT: Record<AvatarSize, string> = {
  xs: 'h-1.5 w-1.5 ring-1',
  sm: 'h-2 w-2 ring-2',
  md: 'h-2.5 w-2.5 ring-2',
  lg: 'h-3 w-3 ring-2',
  xl: 'h-4 w-4 ring-[3px]',
};

const STATUS: Record<AvatarStatus, string> = {
  online: 'bg-success',
  offline: 'bg-subtle',
  away: 'bg-warning',
  busy: 'bg-danger',
};

export function Avatar({ name, color, size = 'md', className, ring, status, shape = 'circle', src }: AvatarProps) {
  const style: CSSProperties | undefined = color ? { backgroundColor: color, color: readableOn(color) } : undefined;
  return (
    <span className={clsx('relative inline-flex shrink-0', className)}>
      <span
        className={clsx(
          'inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-display font-semibold tracking-tight',
          shape === 'circle' ? 'rounded-full' : 'rounded-lg',
          DIM[size],
          !color && 'bg-primary text-primary-fg',
          ring && 'ring-2 ring-bg',
        )}
        style={style}
        role="img"
        aria-label={name}
      >
        {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : initials(name)}
      </span>
      {status && (
        <span
          className={clsx('absolute bottom-0 right-0 rounded-full ring-bg', DOT[size], STATUS[status])}
          aria-label={status}
          role="img"
        />
      )}
    </span>
  );
}

export interface AvatarStackProps {
  people: { name: string; color?: string }[];
  /** Max avatars before the "+N" counter. */
  max?: number;
  size?: Extract<AvatarSize, 'xs' | 'sm' | 'md'>;
  className?: string;
}

/** Overlapping avatars for "who's on this event" style summaries. */
export function AvatarStack({ people, max = 4, size = 'sm', className }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className={clsx('inline-flex items-center', size === 'xs' ? '-space-x-1.5' : '-space-x-2', className)}>
      {shown.map((p, i) => <Avatar key={`${p.name}-${i}`} name={p.name} color={p.color} size={size} ring />)}
      {extra > 0 && (
        <span className={clsx('inline-flex items-center justify-center rounded-full bg-surface-2 font-medium text-muted ring-2 ring-bg', DIM[size])}>
          +{extra}
        </span>
      )}
    </span>
  );
}
