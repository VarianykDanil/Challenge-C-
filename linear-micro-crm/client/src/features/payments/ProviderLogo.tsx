// Release 1.4 — F payments-foundation: the logos of the ways to pay. Brand marks come from the simple-icons package
// (CC0; pinned at 16.34.0 in client/package.json), imported one by one so the bundle carries only these few paths.
// simple-icons 16.34.0 has Revolut, Wise, Starling Bank, Monzo, Barclays, HSBC and Tide; it has no TrueLayer (nor
// NatWest, Lloyds or Santander), so TrueLayer is a neutral "TL" monogram — we could not verify a brand colour for it.
// Logos belong to their owners and only identify the service. Only lazy payment screens import this file.
import { FlaskConical, Landmark } from 'lucide-react';
import clsx from 'clsx';
import { siBarclays, siHsbc, siMonzo, siRevolut, siStarlingbank, siTide, siWise } from 'simple-icons';

interface Mark {
  title: string;
  path: string;
  /** Tile background (the brand colour) and the glyph on it. */
  bg: string;
  fg: string;
}

const MARKS: Record<string, Mark> = {
  revolut: { title: 'Revolut', path: siRevolut.path, bg: `#${siRevolut.hex}`, fg: '#FFFFFF' },
  // Wise's bright green with its dark forest-green glyph
  wise: { title: 'Wise', path: siWise.path, bg: `#${siWise.hex}`, fg: '#163300' },
  starling: { title: 'Starling Bank', path: siStarlingbank.path, bg: `#${siStarlingbank.hex}`, fg: '#FFFFFF' },
  monzo: { title: 'Monzo', path: siMonzo.path, bg: `#${siMonzo.hex}`, fg: '#FFFFFF' },
  barclays: { title: 'Barclays', path: siBarclays.path, bg: `#${siBarclays.hex}`, fg: '#FFFFFF' },
  hsbc: { title: 'HSBC', path: siHsbc.path, bg: `#${siHsbc.hex}`, fg: '#FFFFFF' },
  tide: { title: 'Tide', path: siTide.path, bg: `#${siTide.hex}`, fg: '#FFFFFF' },
};

/** Banks shown on the bank file card as examples (any UK business bank that takes a payment file works). */
export const EXAMPLE_BANKS = ['starling', 'monzo', 'barclays', 'hsbc', 'tide'] as const;

const SIZES = { xs: 'h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5 text-[9px]', sm: 'h-8 w-8 rounded-lg [&_svg]:h-4 [&_svg]:w-4 text-[10px]', md: 'h-10 w-10 rounded-xl [&_svg]:h-5 [&_svg]:w-5 text-xs', lg: 'h-12 w-12 rounded-xl [&_svg]:h-6 [&_svg]:w-6 text-sm' } as const;

export function logoTitle(iconKey: string): string {
  if (iconKey === 'truelayer') return 'TrueLayer';
  if (iconKey === 'bank') return 'Bank payment file';
  if (iconKey === 'test') return 'Test provider';
  return MARKS[iconKey]?.title ?? iconKey;
}

export function ProviderLogo({ iconKey, size = 'md', className }: { iconKey: string; size?: keyof typeof SIZES; className?: string }) {
  const box = clsx('inline-flex shrink-0 items-center justify-center ring-1 ring-inset ring-black/5 dark:ring-white/15', SIZES[size], className);
  const mark = MARKS[iconKey];
  if (mark) {
    return (
      <span className={box} style={{ backgroundColor: mark.bg, color: mark.fg }} role="img" aria-label={`${mark.title} logo`} title={mark.title}>
        <svg viewBox="0 0 24 24" aria-hidden focusable="false"><path d={mark.path} fill="currentColor" /></svg>
      </span>
    );
  }
  if (iconKey === 'truelayer') {
    // a neutral monogram: simple-icons has no TrueLayer mark
    return (
      <span className={clsx(box, 'bg-surface-2 font-semibold tracking-tight text-fg')} role="img" aria-label="TrueLayer" title="TrueLayer">
        TL
      </span>
    );
  }
  if (iconKey === 'test') {
    return <span className={clsx(box, 'bg-surface-2 text-muted')} role="img" aria-label="Test provider" title="Test provider"><FlaskConical aria-hidden /></span>;
  }
  return <span className={clsx(box, 'bg-primary-soft text-primary')} role="img" aria-label="Bank payment file" title="Bank payment file"><Landmark aria-hidden /></span>;
}
