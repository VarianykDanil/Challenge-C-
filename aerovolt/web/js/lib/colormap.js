/**
 * @file Perceptual colour maps for engineering data: a diverging map for pressure
 * coefficients and single-hue sequential maps for magnitudes (temperature, voltage, speed).
 *
 * Why OKLab? Interpolating colours in sRGB makes the middle of a gradient muddy and its
 * perceived lightness uneven, so equal steps in data do not look like equal steps in colour.
 * OKLab (Björn Ottosson, 2020) is a perceptual colour space: Euclidean distance ≈ perceived
 * difference and L ≈ perceived lightness. Every map here is built by linear interpolation in
 * OKLab between a few anchor colours, sampled once into a 256-entry lookup table (LUT), so a
 * lookup at run time is a multiply and an array read (fast enough for per-vertex colouring
 * of a 3D model every frame).
 *
 * Diverging (Cp): blue = suction (Cp < 0) … neutral grey (Cp = 0) … red = pressure (Cp > 0).
 * Both arms have the same lightness profile, so neither sign looks "stronger" at equal |Cp|.
 *
 * Sequential: one hue, dark → light (on the dark pit-wall theme small magnitudes recede into
 * the background and large ones stand out). `heat` is the one multi-hue exception (semantic
 * heat: deep red → orange → pale yellow, still monotonic in lightness) for temperatures.
 *
 * Colours are returned as `[r, g, b]` with components in 0…1 (what three.js expects) or as
 * CSS strings.
 */

/** @typedef {[number, number, number]} RGB  linear 0…1 *sRGB-encoded* components */

const LUT_SIZE = 256;

/* ------------------------------------------------------------------ colour-space maths */

/** sRGB transfer function: encoded 0…1 → linear-light 0…1. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Inverse sRGB transfer function: linear-light 0…1 → encoded 0…1. */
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

/**
 * Encoded sRGB (0…1) → OKLab [L, a, b] (Ottosson's published matrices).
 * @param {RGB} rgb
 * @returns {[number, number, number]}
 */
export function rgbToOklab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * OKLab [L, a, b] → encoded sRGB (0…1, clipped to the gamut).
 * @param {[number, number, number]} lab
 * @returns {RGB}
 */
export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/**
 * Parse "#rrggbb" into encoded sRGB 0…1.
 * @param {string} hex
 * @returns {RGB}
 */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/**
 * CSS colour string for an `[r, g, b]` triple (0…1), optionally with alpha.
 * @param {RGB} rgb
 * @param {number} [alpha=1]
 * @returns {string}
 */
export function rgbCss([r, g, b], alpha = 1) {
  const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
  return alpha >= 1 ? `rgb(${R} ${G} ${B})` : `rgb(${R} ${G} ${B} / ${alpha})`;
}

/**
 * Build a LUT (Float32Array of LUT_SIZE × 3) by piecewise-linear OKLab interpolation through
 * evenly spaced anchor colours.
 * @param {string[]} anchors  hex colours, first = t 0, last = t 1
 * @returns {Float32Array}
 */
function buildLut(anchors) {
  const labs = anchors.map((h) => rgbToOklab(hexToRgb(h)));
  const lut = new Float32Array(LUT_SIZE * 3);
  const segs = labs.length - 1;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / (LUT_SIZE - 1)) * segs;
    const k = Math.min(segs - 1, Math.floor(t));
    const f = t - k;
    const A = labs[k], B = labs[k + 1];
    const rgb = oklabToRgb([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f]);
    lut.set(rgb, i * 3);
  }
  return lut;
}

/* ------------------------------------------------------------------ the maps */

/**
 * Diverging anchors, suction → neutral → pressure. The poles share lightness (OKLab L ≈ 0.47)
 * and the neutral is a light warm grey so that it reads as "nothing" on a 3D surface and on a
 * dark page alike. A dark-neutral variant is offered for flat heat maps on the dark surface.
 */
const DIVERGING_ANCHORS = {
  light: ['#24539f', '#3b77d6', '#94b6ea', '#d8d6cf', '#eda08e', '#d34a3f', '#a32626'],
  dark: ['#5d9cf0', '#3a76c9', '#284a78', '#383835', '#7a3530', '#c9473f', '#f07d6c'],
};

/** Single-hue sequential ramps, dark (low) → light (high), for the dark theme. */
const SEQUENTIAL_ANCHORS = {
  blue: ['#122a4d', '#1c5cab', '#3987e5', '#86b6ef', '#dbe9fc'],
  orange: ['#3d1a0b', '#8f3714', '#d95926', '#f3a37f', '#fde3d6'],
  green: ['#0b2a17', '#11663a', '#199e70', '#6fd0a9', '#d6f5e8'],
  violet: ['#1f1a45', '#4a3aa7', '#9085e9', '#c3bcf5', '#ece9fd'],
  /** Semantic heat (the documented multi-hue exception), monotonic lightness. */
  heat: ['#2a0b12', '#7a1622', '#c8391f', '#ee8a1c', '#fbd56b', '#fff6d8'],
};

const LUTS = {
  diverging: { light: buildLut(DIVERGING_ANCHORS.light), dark: buildLut(DIVERGING_ANCHORS.dark) },
  sequential: Object.fromEntries(Object.entries(SEQUENTIAL_ANCHORS).map(([k, a]) => [k, buildLut(a)])),
};

/** Names of the available sequential ramps. */
export const SEQUENTIAL_RAMPS = Object.freeze(Object.keys(SEQUENTIAL_ANCHORS));

/** Colour used for missing data (NaN / null): mid grey, never a data colour. */
export const MISSING_RGB = Object.freeze([0.36, 0.38, 0.41]);

/**
 * Position 0…1 on the diverging map for value `v`.
 *
 * With a centre `c` inside (vmin, vmax), the two arms are scaled independently
 * (a "two-slope" normalisation): vmin → 0, c → 0.5, vmax → 1. This is what a Cp plot needs:
 * suction may reach −3.5 while pressure only reaches +1, yet Cp = 0 must stay neutral.
 * @param {number} v
 * @param {number} vmin
 * @param {number} vmax
 * @param {number} c
 * @returns {number}
 */
export function divergingPosition(v, vmin, vmax, c) {
  if (v <= c) return c > vmin ? 0.5 * Math.max(0, (v - vmin) / (c - vmin)) : 0.5;
  return vmax > c ? 0.5 + 0.5 * Math.min(1, (v - c) / (vmax - c)) : 0.5;
}

function lookup(lut, t) {
  const i = Math.round(Math.min(1, Math.max(0, t)) * (LUT_SIZE - 1)) * 3;
  return [lut[i], lut[i + 1], lut[i + 2]];
}

/**
 * @typedef {object} DivergingOptions
 * @property {number} [center]  value mapped to the neutral colour. Default: 0 when the range
 *   straddles zero (the Cp case), otherwise the middle of the range.
 * @property {'light'|'dark'} [neutral='light']  light-grey (3D surfaces) or dark-grey
 *   (flat maps on the dark page) midpoint.
 */

function centerOf(vmin, vmax, opts) {
  if (opts && Number.isFinite(opts.center)) return opts.center;
  return vmin < 0 && vmax > 0 ? 0 : (vmin + vmax) / 2;
}

/**
 * Diverging colour for `v` in [vmin, vmax]: blue (low / suction) … grey … red (high / pressure).
 * Missing values (null / NaN) return {@link MISSING_RGB}.
 * @param {number|null} v
 * @param {number} vmin
 * @param {number} vmax
 * @param {DivergingOptions} [opts]
 * @returns {RGB} components 0…1
 */
export function diverging(v, vmin, vmax, opts) {
  if (v === null || !Number.isFinite(v)) return [...MISSING_RGB];
  const lut = LUTS.diverging[(opts && opts.neutral) || 'light'];
  return lookup(lut, divergingPosition(v, vmin, vmax, centerOf(vmin, vmax, opts)));
}

/**
 * Allocation-free variant of {@link diverging}: writes r, g, b into `out[offset…offset+2]`
 * (e.g. a three.js vertex-colour Float32Array).
 * @param {Float32Array|number[]} out
 * @param {number} offset
 * @param {number|null} v
 * @param {number} vmin
 * @param {number} vmax
 * @param {DivergingOptions} [opts]
 */
export function divergingInto(out, offset, v, vmin, vmax, opts) {
  if (v === null || !Number.isFinite(v)) {
    out[offset] = MISSING_RGB[0]; out[offset + 1] = MISSING_RGB[1]; out[offset + 2] = MISSING_RGB[2];
    return;
  }
  const lut = LUTS.diverging[(opts && opts.neutral) || 'light'];
  const t = divergingPosition(v, vmin, vmax, centerOf(vmin, vmax, opts));
  const i = Math.round(Math.min(1, Math.max(0, t)) * (LUT_SIZE - 1)) * 3;
  out[offset] = lut[i]; out[offset + 1] = lut[i + 1]; out[offset + 2] = lut[i + 2];
}

/**
 * Sequential colour for `v` in [vmin, vmax] (clamped), dark (low) → light (high).
 * @param {number|null} v
 * @param {number} vmin
 * @param {number} vmax
 * @param {'blue'|'orange'|'green'|'violet'|'heat'} [ramp='blue']
 * @returns {RGB} components 0…1
 */
export function sequential(v, vmin, vmax, ramp = 'blue') {
  if (v === null || !Number.isFinite(v)) return [...MISSING_RGB];
  const lut = LUTS.sequential[ramp] || LUTS.sequential.blue;
  return lookup(lut, vmax > vmin ? (v - vmin) / (vmax - vmin) : 0.5);
}

/**
 * Allocation-free variant of {@link sequential} (see {@link divergingInto}).
 * @param {Float32Array|number[]} out
 * @param {number} offset
 * @param {number|null} v
 * @param {number} vmin
 * @param {number} vmax
 * @param {string} [ramp='blue']
 */
export function sequentialInto(out, offset, v, vmin, vmax, ramp = 'blue') {
  const c = sequential(v, vmin, vmax, ramp);
  out[offset] = c[0]; out[offset + 1] = c[1]; out[offset + 2] = c[2];
}

/** CSS string of {@link diverging}. @returns {string} */
export function divergingCss(v, vmin, vmax, opts) {
  return rgbCss(diverging(v, vmin, vmax, opts));
}

/** CSS string of {@link sequential}. @returns {string} */
export function sequentialCss(v, vmin, vmax, ramp = 'blue') {
  return rgbCss(sequential(v, vmin, vmax, ramp));
}

/**
 * A ready-made CSS `linear-gradient(...)` of a map (left = low), e.g. for a legend bar.
 * @param {'diverging'|'sequential'} kind
 * @param {{ramp?: string, neutral?: 'light'|'dark', vmin?: number, vmax?: number, center?: number}} [opts]
 * @returns {string}
 */
export function gradientCss(kind, opts = {}) {
  const stops = [];
  const n = 16;
  const vmin = opts.vmin ?? 0, vmax = opts.vmax ?? 1;
  for (let i = 0; i <= n; i++) {
    const v = vmin + ((vmax - vmin) * i) / n;
    const c = kind === 'diverging' ? diverging(v, vmin, vmax, opts) : sequential(v, vmin, vmax, opts.ramp);
    stops.push(`${rgbCss(c)} ${((i / n) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * @typedef {object} ColorbarOptions
 * @property {'diverging'|'sequential'} kind
 * @property {number} vmin
 * @property {number} vmax
 * @property {string} [ramp]        sequential ramp name
 * @property {number} [center]      diverging centre (default 0 when straddling zero)
 * @property {'light'|'dark'} [neutral]
 * @property {string} [label]       e.g. "Cp" or "Speed"
 * @property {string} [unit]        e.g. "km/h"
 * @property {number[]} [ticks]     tick values (default: min, centre/mid, max)
 * @property {(v: number) => string} [format]  tick formatter
 * @property {string} [lowLabel]    caption under the low end, e.g. "suction"
 * @property {string} [highLabel]   caption under the high end, e.g. "pressure"
 */

/**
 * Render a horizontal colour-bar legend into `el` (an empty block element). Uses the
 * `.colorbar` styles from styles.css. Returns a handle whose `update(partialOpts)` re-renders.
 * @param {HTMLElement} el
 * @param {ColorbarOptions} opts
 * @returns {{element: HTMLElement, update: (o: Partial<ColorbarOptions>) => void}}
 */
export function colorbar(el, opts) {
  let state = { ...opts };
  el.classList.add('colorbar');
  const head = document.createElement('div');
  head.className = 'colorbar-head';
  const bar = document.createElement('div');
  bar.className = 'colorbar-bar';
  const ticks = document.createElement('div');
  ticks.className = 'colorbar-ticks';
  const ends = document.createElement('div');
  ends.className = 'colorbar-ends';
  el.replaceChildren(head, bar, ticks, ends);

  function render() {
    const { kind, vmin, vmax } = state;
    const fmt = state.format || ((v) => String(+v.toPrecision(3)).replace('-', '−'));
    head.textContent = state.label ? `${state.label}${state.unit ? ` (${state.unit})` : ''}` : '';
    head.hidden = !state.label;
    bar.style.background = gradientCss(kind, state);
    const mid = kind === 'diverging' ? centerOf(vmin, vmax, state) : (vmin + vmax) / 2;
    const values = state.ticks || [vmin, mid, vmax];
    ticks.replaceChildren(...values.map((v) => {
      const s = document.createElement('span');
      let pos = vmax > vmin ? (v - vmin) / (vmax - vmin) : 0.5;
      if (kind === 'diverging') pos = divergingPosition(v, vmin, vmax, mid);
      s.style.left = `${(Math.min(1, Math.max(0, pos)) * 100).toFixed(2)}%`;
      s.textContent = fmt(v);
      return s;
    }));
    const lo = document.createElement('span');
    lo.textContent = state.lowLabel || '';
    const hi = document.createElement('span');
    hi.textContent = state.highLabel || '';
    ends.replaceChildren(lo, hi);
    ends.hidden = !state.lowLabel && !state.highLabel;
  }
  render();
  return {
    element: el,
    update(o) {
      state = { ...state, ...o };
      render();
    },
  };
}
