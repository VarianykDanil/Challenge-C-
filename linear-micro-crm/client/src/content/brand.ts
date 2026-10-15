// Owned by the Product Designer. ONE place to rebrand Linear Hub.
//
// The real Linear MCR artwork and colours were not reachable when this was built, so the app ships with
// the placeholder identity: a forward-leaning three-line mark on a rounded tile, "Linear Violet" and the
// "Ember" accent. To swap in the real brand:
//
//   1. LOGO  — replace the three files in `client/public/brand/` (logo.svg, logo-dark.svg, mark.svg) and
//      `client/public/favicon.svg` with the real artwork, keeping the file names (or change the paths in
//      BRAND_ASSETS below). Then set BRAND_LOGO_SOURCE to 'file' so every <Logo /> in the app renders the
//      files instead of the inline placeholder mark.
//   2. COLOURS — put the real values in BRAND_PALETTE below AND in the matching `--brand-*` block at the
//      top of `client/src/index.css` (`:root` for light, `.dark` for dark). Every colour token in the app
//      (--primary, --primary-hover, --accent, --ink, --ring, the soft tints, focus rings, the first chart
//      series) is derived from those four values, so nothing else needs touching. The two lists are kept
//      side by side on purpose: CSS cannot import TypeScript, and JS consumers (e.g. generated images)
//      need the hexes without parsing CSS.
//   3. Check `--primary-fg` / `--accent-fg` in index.css still read on the new colours (they are white on
//      the light palette, navy on the dark one) and re-run the contrast notes in docs/DESIGN.md.
//
// Names (company, product, legal name, address, website) live in `shared/src/constants.ts` → BRAND.

/** Where the logo files live under `client/public/`. Referenced by <Logo source="file" />. */
export const BRAND_ASSETS = {
  /** Full lockup (mark + wordmark) for light backgrounds. */
  logoLight: '/brand/logo.svg',
  /** Full lockup for dark backgrounds and the dark theme. */
  logoDark: '/brand/logo-dark.svg',
  /** The mark alone (square). */
  mark: '/brand/mark.svg',
  /** Browser tab / home-screen icon (referenced from client/index.html). */
  favicon: '/favicon.svg',
} as const;

export type LogoSource = 'inline' | 'file';

/**
 * How <Logo /> renders by default. 'inline' draws the placeholder mark from CSS tokens (recolours with the
 * palette and theme automatically); 'file' renders the SVGs in BRAND_ASSETS. Flip to 'file' once the real
 * logo is in place.
 */
export const BRAND_LOGO_SOURCE: LogoSource = 'inline';

export interface BrandPalette {
  /** Actions, links, active nav, the mark's tile. */
  primary: string;
  /** Button hover. */
  primaryHover: string;
  /** Highlights, notification dot, leader role. */
  accent: string;
  /** Always-dark brand navy for hero blocks and the login panel. */
  ink: string;
}

/**
 * Brand colours per theme. MUST match the `--brand-*` custom properties at the top of `client/src/index.css`;
 * the CSS is what the app actually paints with, this is the readable mirror for JS and documentation.
 */
export const BRAND_PALETTE: Record<'light' | 'dark', BrandPalette> = {
  light: {
    primary: '#4B3FD9', // "Linear Violet"
    primaryHover: '#4034C4',
    accent: '#B83C0B', // "Ember"
    ink: '#0B1020',
  },
  dark: {
    primary: '#9D99FF',
    primaryHover: '#AEABFF',
    accent: '#FFA059',
    ink: '#080C19',
  },
} as const;
