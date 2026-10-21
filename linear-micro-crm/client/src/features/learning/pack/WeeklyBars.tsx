// Release 1.2 — L1: the progression tracker's weekly sales, one column per Mon–Sun week of the window (this week last,
// still filling), with the criterion's threshold as hairline reference lines. A single series (chart-1, no legend box:
// the title names it); the numbers are in a table for screen readers.
// Reading a week: the whole plot is one control (a slider over the weeks), so on a phone the tap target is the full
// plot, not a 20 px column: touch or slide along it and the tooltip follows the finger; hover with a mouse; on a
// keyboard Tab to it and use ← → (Home / End). The bars themselves stay as drawn.
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
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
  const plotRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...weeks.map((w) => w.value), ...targets.map((t) => t.value)) * 1.08;
  const y = (v: number) => Math.round((v / max) * HEIGHT);
  const last = weeks.length - 1;
  const tip = (i: number) => {
    const w = weeks[i]!;
    return `${i === last ? 'This week so far' : `Week of ${dayMonthLabel(w.weekStart)}`}: ${w.value} ${unit}`;
  };
  const current = active ?? last;

  /** The week under the pointer: the plot's width split evenly between the columns. */
  const weekAt = (clientX: number): number | null => {
    const el = plotRef.current;
    if (!el || weeks.length === 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.max(0, Math.min(last, Math.floor(((clientX - r.left) / r.width) * weeks.length)));
  };
  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const i = weekAt(e.clientX);
    if (i != null) setActive(i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? current - 1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? current + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (to == null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(last, to)));
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
        {/* One control over the whole plot. Vertical swipes still scroll the page (touch-action: pan-y). */}
        <div
          ref={plotRef}
          role="slider"
          tabIndex={0}
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, last)}
          aria-valuenow={current}
          aria-valuetext={weeks.length ? tip(current) : undefined}
          className="focus-ring absolute inset-x-0 top-0 mr-12 touch-pan-y rounded-sm"
          style={{ height: HEIGHT }}
          onPointerDown={onPointer}
          onPointerMove={onPointer}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setActive(null);
          }}
          onFocus={() => setActive((a) => a ?? last)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          data-weekly-bars
        >
          <ol className="grid h-full items-end gap-0.5" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }} aria-hidden>
            {weeks.map((w, i) => {
              const h = Math.max(w.value > 0 ? 3 : 0, y(w.value));
              return (
                <li key={w.weekStart} className="relative flex h-full items-end justify-center">
                  <span
                    className={clsx('block w-full max-w-6 rounded-t-[4px] bg-chart-1 transition-opacity', i === last && 'opacity-55', active !== null && active !== i && 'opacity-40')}
                    style={{ height: h }}
                  />
                  {i === last && w.value > 0 && (
                    <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[10px] font-semibold tabular text-fg" style={{ bottom: h + 2 }}>
                      {w.value}
                    </span>
                  )}
                  {active === i && (
                    <span
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
        </div>
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
