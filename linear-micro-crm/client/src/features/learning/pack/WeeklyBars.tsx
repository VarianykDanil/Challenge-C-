// Release 1.2 — L1: the progression tracker's weekly sales, one column per Mon–Sun week of the window (this week last,
// still filling), with the criterion's threshold as hairline reference lines. A single series (chart-1, no legend box:
// the title names it); every column has a hover / focus tooltip and the numbers are in a table for screen readers.
import { useId, useState } from 'react';
import clsx from 'clsx';
import { dayMonthLabel } from '@lm/shared';

export interface WeeklyBarsProps {
  title: string;
  weeks: { weekStart: string; value: number }[];
  /** Reference lines, e.g. [{ value: 14, label: '14' }, { value: 12, label: '12 × 2' }]. */
  targets: { value: number; label: string }[];
  /** "sales" / "team sales" for tooltips. */
  unit: string;
  className?: string;
}

const HEIGHT = 112; // px of plot

export function WeeklyBars({ title, weeks, targets, unit, className }: WeeklyBarsProps) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...weeks.map((w) => w.value), ...targets.map((t) => t.value)) * 1.08;
  const y = (v: number) => Math.round((v / max) * HEIGHT);
  const last = weeks.length - 1;
  const tip = (i: number) => {
    const w = weeks[i]!;
    return `${i === last ? 'This week so far' : `Week of ${dayMonthLabel(w.weekStart)}`}: ${w.value} ${unit}`;
  };
  return (
    <figure className={clsx('min-w-0', className)} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="mb-2 text-xs font-medium text-muted">
        {title}
      </figcaption>
      <div className="relative" style={{ height: HEIGHT + 18 }}>
        {/* baseline + reference lines (recessive hairlines, labelled in text tokens) */}
        <div className="absolute inset-x-0 border-t border-border" style={{ top: HEIGHT }} aria-hidden />
        {targets.map((t) => {
          // Two lines close together (14 and 12): the higher one's label sits above its line, the lower one's below.
          const top = Math.max(...targets.map((x) => x.value));
          const place = targets.length < 2 ? '-translate-y-1/2' : t.value === top ? '-translate-y-full' : 'translate-y-0';
          return (
            <div key={t.label} className="pointer-events-none absolute inset-x-0" style={{ top: HEIGHT - y(t.value) }} aria-hidden>
              <div className="mr-12 h-px bg-fg/35" />
              <span className={clsx('absolute right-0 top-0 w-11 text-left text-[10px] font-semibold leading-[14px] tabular text-muted', place)}>{t.label}</span>
            </div>
          );
        })}
        <ol className="absolute inset-x-0 top-0 mr-12 grid items-end gap-0.5" style={{ height: HEIGHT, gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
          {weeks.map((w, i) => {
            const h = Math.max(w.value > 0 ? 3 : 0, y(w.value));
            return (
              <li key={w.weekStart} className="relative flex h-full items-end justify-center">
                <button
                  type="button"
                  className="focus-ring-inset group relative flex h-full w-full items-end justify-center rounded-sm outline-none"
                  aria-label={tip(i)}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                >
                  <span
                    className={clsx('block w-full max-w-6 rounded-t-[4px] bg-chart-1 transition-opacity', i === last && 'opacity-55', active !== null && active !== i && 'opacity-40')}
                    style={{ height: h }}
                  />
                </button>
                {i === last && w.value > 0 && (
                  <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[10px] font-semibold tabular text-fg" style={{ bottom: h + 2 }} aria-hidden>
                    {w.value}
                  </span>
                )}
                {active === i && (
                  <span
                    role="tooltip"
                    className={clsx(
                      'pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-[11px] font-medium text-bg shadow-pop',
                      i > weeks.length / 2 ? 'right-0' : 'left-0',
                    )}
                    style={{ bottom: h + 16 }}
                  >
                    {tip(i)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        <div className="absolute inset-x-0 mr-12 flex justify-between text-[10px] tabular text-muted" style={{ top: HEIGHT + 4 }} aria-hidden>
          <span>{weeks[0] ? dayMonthLabel(weeks[0].weekStart) : ''}</span>
          <span>This week</span>
        </div>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">{unit}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={w.weekStart}>
              <td>{i === last ? 'This week so far' : `Week of ${dayMonthLabel(w.weekStart)}`}</td>
              <td>{w.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
