// A conversion ratio tinted against the company benchmark.
import clsx from 'clsx';
import { formatPct } from '@/lib/format';
import { benchmarkFor, ratioTone, TONE_BG, type RatioKey } from '@/lib/ratios';

export function RatioCell({ keyName, value, digits = 0, className }: { keyName: RatioKey; value: number; digits?: number; className?: string }) {
  const tone = ratioTone(keyName, value);
  const bench = benchmarkFor(keyName);
  return (
    <span
      className={clsx('inline-flex min-w-[3.25rem] justify-center rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums', TONE_BG[tone], className)}
      title={`Benchmark ${formatPct(bench, keyName === 'overallConversion' ? 1 : 0)}`}
      aria-label={`${formatPct(value, digits)} (${tone === 'success' ? 'on target' : tone === 'warning' ? 'slightly below benchmark' : 'below benchmark'})`}
    >
      {formatPct(value, digits)}
    </span>
  );
}
