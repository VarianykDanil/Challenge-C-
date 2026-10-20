// Date range preset picker (pills) with optional custom from/to inputs.
import { useEffect, useId, useState } from 'react';
import { Input, SegmentedControl } from '@/components/ui';
import { PERFORMANCE_PRESETS, RANGE_PRESET_LABELS, presetRange, type DateRange, type RangePreset } from '@/lib/dates';

export interface RangeValue extends DateRange { preset: RangePreset | 'custom' }

export function useRangeState(initial: RangePreset = 'this_week', clampToToday = true): [RangeValue, (v: RangeValue) => void] {
  const [value, setValue] = useState<RangeValue>(() => ({ preset: initial, ...presetRange(initial, new Date(), clampToToday) }));
  return [value, setValue];
}

export function RangePicker({ value, onChange, presets = PERFORMANCE_PRESETS, allowCustom = true, clampToToday = true, className }: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  presets?: RangePreset[];
  allowCustom?: boolean;
  /** End current periods today (performance pages) instead of at the period end (planning pages such as Events). */
  clampToToday?: boolean;
  className?: string;
}) {
  const id = useId();
  const items: { value: RangePreset | 'custom'; label: string }[] = presets.map((p) => ({ value: p, label: RANGE_PRESET_LABELS[p] }));
  if (allowCustom) items.push({ value: 'custom', label: 'Custom' });
  // Custom dates are edited in a draft and only applied once from ≤ to, so a half-typed range never hits the API.
  const [draft, setDraft] = useState<DateRange>({ from: value.from, to: value.to });
  useEffect(() => {
    setDraft({ from: value.from, to: value.to });
  }, [value.from, value.to]);
  const invalid = !!draft.from && !!draft.to && draft.from > draft.to;
  const edit = (next: DateRange) => {
    setDraft(next);
    if (next.from && next.to && next.from <= next.to) onChange({ ...value, preset: 'custom', ...next });
  };
  // Release 1.2 (U5 layout fix): min-w-0 + max-w-full on the root and the pill wrapper let a flex or wrapping parent
  // shrink the picker to the room it has (the pills then scroll inside the control) instead of the pills' full width
  // pushing the page sideways. Parents that share a row with it wrap it onto its own line when it does not fit.
  return (
    <div className={`flex min-w-0 max-w-full flex-wrap items-center gap-3 ${className ?? ''}`}>
      {/* On phones the pills scroll inside the control; the fading right edge says there is more. */}
      <div className="relative inline-flex min-w-0 max-w-full after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-8 after:rounded-r-lg after:bg-linear-to-l after:from-bg after:to-transparent sm:after:hidden">
        <SegmentedControl<RangePreset | 'custom'>
          aria-label="Date range"
          size="sm"
          options={items}
          value={value.preset}
          onChange={(v) => {
            if (v === 'custom') onChange({ ...value, preset: 'custom' });
            else onChange({ preset: v, ...presetRange(v, new Date(), clampToToday) });
          }}
          className="max-w-full overflow-x-auto pr-6 sm:pr-0.5"
        />
      </div>
      {allowCustom && value.preset === 'custom' && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm text-muted">
            <label htmlFor={`${id}-from`} className="sr-only">From</label>
            <Input id={`${id}-from`} type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => edit({ ...draft, from: e.target.value })} size="sm" className="w-auto" invalid={invalid} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-err` : undefined} />
            <span aria-hidden>–</span>
            <label htmlFor={`${id}-to`} className="sr-only">To</label>
            <Input id={`${id}-to`} type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => edit({ ...draft, to: e.target.value })} size="sm" className="w-auto" invalid={invalid} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-err` : undefined} />
          </div>
          {invalid && <p id={`${id}-err`} role="alert" className="text-xs text-danger">The start date must be on or before the end date.</p>}
        </div>
      )}
    </div>
  );
}
