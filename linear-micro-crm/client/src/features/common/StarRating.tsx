import { Star } from 'lucide-react';
import clsx from 'clsx';

export function StarRating({ value, onChange, size = 'md' }: { value: number | null; onChange?: (v: number) => void; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';
  return (
    <span className="inline-flex items-center gap-0.5" role={onChange ? 'radiogroup' : undefined} aria-label={value ? `${value} out of 5 stars` : 'Not yet rated'}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = (value ?? 0) >= n;
        const icon = <Star className={clsx(dim, filled ? 'fill-accent text-accent' : 'text-border')} aria-hidden />;
        if (!onChange) return <span key={n}>{icon}</span>;
        return (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onChange(n)} className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {icon}
          </button>
        );
      })}
    </span>
  );
}
