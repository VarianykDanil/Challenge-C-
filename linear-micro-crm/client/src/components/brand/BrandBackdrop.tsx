// Owned by the Product Designer.
// Decorative parallel-line field for ink panels (login brand panel, public landing hero): the mark,
// blown up and fading, over the brand wash. Purely decorative — always aria-hidden.
import clsx from 'clsx';

export interface BrandBackdropProps {
  className?: string;
  /** `soft` fades the big lines further back for panels with a lot of text on top (default `strong`). */
  intensity?: 'strong' | 'soft';
}

export function BrandBackdrop({ className, intensity = 'strong' }: BrandBackdropProps) {
  return (
    <div className={clsx('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      <div className="brand-wash absolute inset-0 opacity-90" />
      <svg
        className={clsx('absolute -right-24 -top-16 h-[140%] w-auto', intensity === 'strong' ? 'opacity-[0.16]' : 'opacity-[0.1]')}
        viewBox="0 0 400 600"
        fill="none"
        preserveAspectRatio="xMaxYMid slice"
      >
        <g stroke="var(--primary)" strokeWidth="14" strokeLinecap="round" transform="translate(200 300) skewX(-14) translate(-200 -300)">
          {Array.from({ length: 11 }).map((_, i) => (
            <path key={i} d={`M${60 + i * 6} ${80 + i * 46}h${80 + i * 22}`} opacity={0.35 + (i % 4) * 0.18} />
          ))}
        </g>
      </svg>
      <div className="brand-lines absolute inset-x-0 bottom-0 h-72 opacity-50 [mask-image:linear-gradient(to_top,black,transparent)]" />
      <div className="absolute inset-0 bg-gradient-to-t from-ink via-transparent to-transparent" />
    </div>
  );
}
