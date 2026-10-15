// A conversion ratio tinted against the company benchmark. Colour is never the only signal:
// a glyph (▲ above · ● on track · ▼ below) and screen-reader text carry the status too.
import clsx from 'clsx';
import { formatPct } from '@/lib/format';
import { benchmarkFor, ratioStatus, ratioTone, TONE_BG, type RatioKey } from '@/lib/ratios';

const GLYPH = { above: '▲', on_track: '●', below: '▼' } as const;
const STATUS_TEXT = { above: 'above benchmark', on_track: 'on track', below: 'below benchmark' } as const;

export function RatioCell({ keyName, value, digits = 0, className }: { keyName: RatioKey; value: number; digits?: number; className?: string }) {
  const tone = ratioTone(keyName, value);
  const status = ratioStatus(keyName, value);
  const bench = benchmarkFor(keyName);
  const severity = tone === 'danger' ? ' (well below)' : '';
  return (
    <span
      className={clsx('inline-flex min-w-[3.25rem] items-center justify-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums', TONE_BG[tone], className)}
      title={`Benchmark ${formatPct(bench, keyName === 'overallConversion' ? 1 : 0)} · ${STATUS_TEXT[status]}${severity}`}
    >
      <span aria-hidden className="text-[9px] leading-none">{GLYPH[status]}</span>
      {formatPct(value, digits)}
      <span className="sr-only"> {STATUS_TEXT[status]}{severity}</span>
    </span>
  );
}
