// Date range preset picker (pills) with optional custom from/to inputs.
import { useId, useState } from 'react';
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
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className ?? ''}`}>
      <SegmentedControl<RangePreset | 'custom'>
        aria-label="Date range"
        size="sm"
        options={items}
        value={value.preset}
        onChange={(v) => {
          if (v === 'custom') onChange({ ...value, preset: 'custom' });
          else onChange({ preset: v, ...presetRange(v, new Date(), clampToToday) });
        }}
        className="max-w-full overflow-x-auto"
      />
      {allowCustom && value.preset === 'custom' && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <label htmlFor={`${id}-from`} className="sr-only">From</label>
          <Input id={`${id}-from`} type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} size="sm" className="w-auto" />
          <span aria-hidden>–</span>
          <label htmlFor={`${id}-to`} className="sr-only">To</label>
          <Input id={`${id}-to`} type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} size="sm" className="w-auto" />
        </div>
      )}
    </div>
  );
}
