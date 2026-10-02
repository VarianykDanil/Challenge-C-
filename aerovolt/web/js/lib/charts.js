/**
 * @file Small, fast canvas chart library for the pit-wall dashboard (no dependencies).
 *
 * Charts: {@link StripChart} (rolling time window, stacked lanes), {@link XYChart} (scatter /
 * lines, inverted axes for Cp plots, fit line), {@link Gauge} (arc meter), {@link BarChart}
 * (grouped / stacked), {@link Sparkline}.
 *
 * Rendering model
 * ---------------
 * * Each chart owns one `<canvas>` that fills its host element (the host is sized by CSS).
 *   A `ResizeObserver` tracks the host size and the canvas backing store is scaled by
 *   `devicePixelRatio`, so lines stay 1-device-pixel crisp on HiDPI / 4K screens.
 * * Setters only update state and mark the chart *dirty*. Nothing is drawn until
 *   {@link renderCharts} is called - main.js calls it once per animation frame, so every chart
 *   on screen is redrawn at most once per frame, and charts that did not change (or whose tab
 *   is hidden, i.e. zero size) cost nothing. This keeps 20-60 fps with dozens of charts.
 * * Colours, fonts and sizes come from CSS custom properties (styles.css), so the charts
 *   follow the theme; text size follows the host's computed font size (4K scaling).
 *
 * Visual rules (dataviz guide): one y-scale per plot (two measures → two lanes, never a dual
 * axis), 2 px lines, hairline solid grid, ≥ 8 px markers with a 2 px surface ring, bars
 * ≤ 24 px with a 4 px rounded data end, text in text colours (never the series colour), a
 * legend for ≥ 2 series, hover crosshair / tooltip on every plot.
 */

import { niceTicks, formatNumber, isNum } from './format.js';

/* ================================================================== theme */

/**
 * @typedef {object} ChartTheme
 * @property {string} surface   chart background (used for gaps and marker rings)
 * @property {string} surface2  tooltip background
 * @property {string} text1     primary ink
 * @property {string} text2     secondary ink
 * @property {string} text3     muted ink (axes, ticks)
 * @property {string} grid      gridline hairline
 * @property {string} axis      baseline / axis
 * @property {string} border    tooltip border
 * @property {string[]} series  categorical colours, fixed order (slot 1…8)
 * @property {{good: string, warning: string, serious: string, critical: string}} status
 * @property {string} sans
 * @property {string} mono
 */

let themeCache = null;

/**
 * Current chart theme read from CSS custom properties on `:root` (cached; call
 * {@link refreshTheme} after changing the theme at run time).
 * @returns {ChartTheme}
 */
export function theme() {
  if (themeCache) return themeCache;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  themeCache = {
    surface: v('--surface-1', '#14181e'),
    surface2: v('--surface-3', '#232a34'),
    text1: v('--text-1', '#f2f4f7'),
    text2: v('--text-2', '#b8bec8'),
    text3: v('--text-3', '#7d8590'),
    grid: v('--chart-grid', '#222831'),
    axis: v('--chart-axis', '#3a424e'),
    border: v('--border-strong', 'rgba(255,255,255,0.16)'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`, '#3987e5')),
    status: {
      good: v('--good', '#0ca30c'),
      warning: v('--warning', '#fab219'),
      serious: v('--serious', '#ec835a'),
      critical: v('--critical', '#d03b3b'),
    },
    sans: v('--font-sans', 'system-ui, sans-serif'),
    mono: v('--font-mono', 'ui-monospace, monospace'),
  };
  return themeCache;
}

/** Forget the cached theme and redraw every chart (after a theme change). */
export function refreshTheme() {
  themeCache = null;
  for (const c of registry) c.invalidate();
}

/**
 * Categorical series colour by fixed slot (0-based). Colour follows the entity: give each
 * entity a permanent slot instead of using its rank in the current view.
 * @param {number} slot  0…7
 * @returns {string}
 */
export function seriesColor(slot) {
  const s = theme().series;
  return s[((slot % s.length) + s.length) % s.length];
}

/* ================================================================== registry */

/** @type {Set<Chart>} every live chart */
const registry = new Set();

/**
 * Draw every dirty, visible chart. Call once per animation frame (main.js does).
 * @returns {number} number of charts drawn
 */
export function renderCharts() {
  let n = 0;
  for (const c of registry) {
    if (c.dirty && c.w > 0 && c.h > 0 && c.canvas.isConnected) {
      c.draw();
      n++;
    }
  }
  return n;
}

/* ================================================================== helpers */

/** Rounded rectangle path (r clamped to half the size). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Bar path with a rounded *data end* and a square *baseline end*.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  left
 * @param {number} y0 baseline y
 * @param {number} y1 data-end y (above or below the baseline)
 * @param {number} w  width
 * @param {number} r  radius
 */
function barPath(ctx, x, y0, y1, w, r) {
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const rr = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1 + rr);
    ctx.arcTo(x, y1, x + rr, y1, rr);
    ctx.lineTo(x + w - rr, y1);
    ctx.arcTo(x + w, y1, x + w, y1 + rr, rr);
    ctx.lineTo(x + w, y0);
  } else {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1 - rr);
    ctx.arcTo(x, y1, x + rr, y1, rr);
    ctx.lineTo(x + w - rr, y1);
    ctx.arcTo(x + w, y1, x + w, y1 - rr, rr);
    ctx.lineTo(x + w, y0);
  }
  ctx.closePath();
}

/** Min/max of finite values of an array-like (optionally only indices [i0, i1)). */
function extent(arr, i0 = 0, i1 = arr ? arr.length : 0, scale = 1) {
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i < i1; i++) {
    const v = arr[i] * scale;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** First index with t[i] >= x in a sorted array (binary search). */
function lowerBound(t, x, n = t.length) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Compute a padded, "nice" axis range from data and options.
 * @param {number} lo data min
 * @param {number} hi data max
 * @param {{min?: number, max?: number, includeZero?: boolean, pad?: number}} o
 * @returns {[number, number]}
 */
function axisRange(lo, hi, o = {}) {
  const fixedMin = isNum(o.min), fixedMax = isNum(o.max);
  if (!isNum(lo) || !isNum(hi)) {
    lo = fixedMin ? o.min : 0;
    hi = fixedMax ? o.max : 1;
  }
  if (o.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (isNum(o.softMin)) lo = Math.min(lo, o.softMin);
  if (isNum(o.softMax)) hi = Math.max(hi, o.softMax);
  if (hi - lo < 1e-9) {
    const d = Math.abs(hi) > 1e-9 ? Math.abs(hi) * 0.1 : 1;
    lo -= d; hi += d;
  }
  const pad = (hi - lo) * (o.pad ?? 0.08);
  let a = fixedMin ? o.min : lo - pad;
  let b = fixedMax ? o.max : hi + pad;
  if (!fixedMin && lo >= 0 && a < 0 && !o.allowNegative) a = 0;
  if (!fixedMin || !fixedMax) {
    const { step } = niceTicks(a, b, 4);
    if (!fixedMin) a = Math.floor(a / step + 1e-9) * step;
    if (!fixedMax) b = Math.ceil(b / step - 1e-9) * step;
  }
  return [a, b];
}

/* ================================================================== base class */

/**
 * @typedef {object} ChartOptions
 * @property {string} [title]   accessible name of the canvas (aria-label)
 */

/**
 * Base class: canvas creation, HiDPI scaling, resize tracking, pointer hover and the
 * dirty-flag render cycle. Subclasses implement `paint(ctx, w, h)`.
 */
export class Chart {
  /**
   * @param {HTMLElement} host  element the canvas fills (give it a CSS height)
   * @param {ChartOptions} [opts]
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    host.classList.add('chart-host');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.setAttribute('role', 'img');
    if (opts.title) this.canvas.setAttribute('aria-label', opts.title);
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    /** CSS-pixel size */
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.dirty = true;
    /** @type {{x: number, y: number} | null} pointer position in CSS px */
    this.hover = null;
    this.fontPx = 12;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this._onMove = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.dirty = true;
    };
    this._onLeave = () => { this.hover = null; this.dirty = true; };
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    registry.add(this);
    this.resize();
  }

  /** Re-read the host size and device-pixel ratio; resize the backing store. */
  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.fontPx = parseFloat(getComputedStyle(this.host).fontSize) || 12;
    this.dirty = true;
  }

  /** Mark the chart for redraw on the next {@link renderCharts}. */
  invalidate() { this.dirty = true; }

  /** Draw now (normally called by {@link renderCharts}). */
  draw() {
    this.dirty = false;
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.paint(ctx, this.w, this.h);
  }

  /** Subclass hook. @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h */
  paint(ctx, w, h) { void ctx; void w; void h; }

  /** Stop observing and remove the canvas. */
  destroy() {
    this._ro.disconnect();
    registry.delete(this);
    this.canvas.remove();
  }

  /** Font string at `scale` × host font size. */
  font(scale = 0.85, weight = 400, mono = false) {
    const t = theme();
    return `${weight} ${(this.fontPx * scale).toFixed(1)}px ${mono ? t.mono : t.sans}`;
  }

  /**
   * Draw a tooltip box near (x, y) with a header and rows `{color, label, value}`. Values lead
   * (bold, primary ink), labels follow (secondary ink), series keyed with a short line.
   */
  tooltip(ctx, x, y, header, rows) {
    const t = theme();
    const pad = 8, lh = this.fontPx * 1.35, key = 12;
    ctx.font = this.font(0.85, 600);
    let wMax = header ? ctx.measureText(header).width : 0;
    const widths = rows.map((r) => {
      ctx.font = this.font(0.9, 600);
      const vw = ctx.measureText(r.value).width;
      ctx.font = this.font(0.85);
      const lw = ctx.measureText(r.label).width;
      return { vw, lw };
    });
    for (const { vw, lw } of widths) wMax = Math.max(wMax, (rows.length && rows[0].color ? key + 6 : 0) + vw + 8 + lw);
    const bw = wMax + pad * 2;
    const bh = (rows.length + (header ? 1 : 0)) * lh + pad * 2 - 4;
    let bx = x + 14, by = y - bh / 2;
    if (bx + bw > this.w - 2) bx = x - 14 - bw;
    if (bx < 2) bx = 2;
    by = Math.max(2, Math.min(this.h - bh - 2, by));
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = t.surface2;
    roundRectPath(ctx, bx, by, bw, bh, 6);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1;
    roundRectPath(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 6);
    ctx.stroke();
    let cy = by + pad + lh / 2 - 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (header) {
      ctx.font = this.font(0.8, 500);
      ctx.fillStyle = t.text3;
      ctx.fillText(header, bx + pad, cy);
      cy += lh;
    }
    rows.forEach((r, i) => {
      let cx = bx + pad;
      if (r.color) {
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.setLineDash(r.dash || []);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + key, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        cx += key + 6;
      }
      ctx.font = this.font(0.9, 600);
      ctx.fillStyle = t.text1;
      ctx.fillText(r.value, cx, cy);
      ctx.font = this.font(0.85);
      ctx.fillStyle = t.text2;
      ctx.fillText(r.label, cx + widths[i].vw + 8, cy);
      cy += lh;
    });
  }

  /**
   * Draw a horizontal legend (line keys or swatches) starting at (x, y). Items:
   * `{label, color, value?, dash?, swatch?: 'line'|'rect'|'dot'}`. Returns its height.
   */
  legend(ctx, x, y, items, maxW) {
    const t = theme();
    const lh = this.fontPx * 1.3;
    let cx = x, cy = y + lh / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const it of items) {
      ctx.font = this.font(0.82);
      const lw = ctx.measureText(it.label).width;
      ctx.font = this.font(0.82, 600);
      const vw = it.value ? ctx.measureText(it.value).width + 5 : 0;
      const need = 16 + lw + vw + 14;
      if (cx > x && cx + need > x + maxW) { cx = x; cy += lh; }
      if (it.swatch === 'rect') {
        ctx.fillStyle = it.color;
        roundRectPath(ctx, cx, cy - 4.5, 10, 9, 2);
        ctx.fill();
      } else if (it.swatch === 'dot') {
        ctx.fillStyle = it.color;
        ctx.beginPath();
        ctx.arc(cx + 5, cy, 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.setLineDash(it.dash || []);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + 11, cy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      cx += 16;
      ctx.font = this.font(0.82);
      ctx.fillStyle = t.text2;
      ctx.fillText(it.label, cx, cy);
      cx += lw + 5;
      if (it.value) {
        ctx.font = this.font(0.82, 600);
        ctx.fillStyle = t.text1;
        ctx.fillText(it.value, cx, cy);
        cx += vw;
      }
      cx += 14;
    }
    return cy + lh / 2 - y;
  }

  /** Marker: filled dot (r ≥ 4 px) with a 2 px surface-coloured ring. */
  static dot(ctx, x, y, color, r = 4) {
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = theme().surface;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/* ================================================================== StripChart */

/**
 * @typedef {object} StripLane  one y-scale band of a strip chart
 * @property {string} [label]        lane title, e.g. "Speed"
 * @property {string} [unit]         e.g. "km/h"
 * @property {number} [min]          fixed minimum (else auto)
 * @property {number} [max]          fixed maximum (else auto)
 * @property {number} [softMin]      auto range always includes this value
 * @property {number} [softMax]
 * @property {boolean} [includeZero] auto range always includes 0
 * @property {number} [decimals]     value decimals (default from tick step)
 * @property {{value: number, label?: string, level?: 'warning'|'critical'|'neutral'}[]} [thresholds]
 * @property {number} [weight=1]     relative lane height
 */

/**
 * @typedef {object} StripSeries
 * @property {string} label
 * @property {string} [color]   default: categorical slot = series index
 * @property {number} [lane=0]
 * @property {number} [width=2]
 * @property {number[]} [dash]  e.g. [4, 3] for an estimate / reference series
 * @property {boolean} [fill]   10 % area wash under the line (to the lane minimum)
 * @property {number} [scale=1] multiply values (e.g. 3.6 for m/s → km/h)
 * @property {(seconds: number) => {t: ArrayLike<number>, v: ArrayLike<number>}} [source]
 *   data provider, called by {@link StripChart#pull} (e.g. `(s) => app.hist.series(id, s)`)
 */

/**
 * Rolling time-window chart: several series over the last `window` seconds, optionally in
 * stacked *lanes* that share the time axis but have their own y-scale (the honest
 * alternative to a dual-axis chart).
 *
 * @example
 * const c = new StripChart(el, {
 *   window: 60,
 *   lanes: [{label: 'Speed', unit: 'km/h', min: 0}, {label: 'Downforce', unit: 'N', includeZero: true}],
 *   series: [
 *     {label: 'Speed', lane: 0, scale: 3.6, source: (s) => app.hist.series('gps_speed', s)},
 *     {label: 'Downforce', lane: 1, source: (s) => app.hist.series('calc_downforce', s)},
 *   ],
 * });
 * // each frame (or at 20 Hz): c.pull(app.t);
 */
export class StripChart extends Chart {
  /**
   * @param {HTMLElement} host
   * @param {{window?: number, lanes?: StripLane[], y?: StripLane, series: StripSeries[],
   *          legend?: boolean, title?: string, timeAxis?: boolean}} opts
   */
  constructor(host, opts) {
    super(host, opts);
    this.window = opts.window ?? 60;
    this.lanes = opts.lanes || [opts.y || {}];
    this.series = opts.series.map((s, i) => ({ lane: 0, width: 2, scale: 1, color: null, slot: i, ...s }));
    /** @type {{t: ArrayLike<number>, v: ArrayLike<number>}[]} */
    this.data = this.series.map(() => ({ t: new Float64Array(0), v: new Float64Array(0) }));
    this.now = NaN;
    this.showLegend = opts.legend ?? true;
    this.timeAxis = opts.timeAxis ?? true;
  }

  /** Change the visible window length [s]. */
  setWindow(seconds) { this.window = seconds; this.dirty = true; }

  /**
   * Set the data of series `i` (time stamps ascending, seconds; values; same length).
   * @param {number} i
   * @param {ArrayLike<number>} t
   * @param {ArrayLike<number>} v
   */
  setSeries(i, t, v) {
    this.data[i] = { t, v };
    this.dirty = true;
  }

  /** Set "now" (the right edge of the window, session seconds). */
  setNow(t) {
    if (t !== this.now) { this.now = t; this.dirty = true; }
  }

  /**
   * Fetch every series that has a `source` for the current window and set `now`.
   * @param {number} now  session time [s] (right edge)
   */
  pull(now) {
    this.series.forEach((s, i) => {
      if (s.source) {
        const d = s.source(this.window + 1);
        if (d) this.data[i] = d;
      }
    });
    this.now = now;
    this.dirty = true;
  }

  /** Update lane options (e.g. thresholds) at run time. */
  setLane(i, patch) {
    this.lanes[i] = { ...this.lanes[i], ...patch };
    this.dirty = true;
  }

  colorOf(s) { return s.color || seriesColor(s.slot); }

  /** Latest finite value of series i (scaled) or NaN. */
  lastValue(i) {
    const { v } = this.data[i];
    const s = this.series[i];
    for (let k = v.length - 1; k >= Math.max(0, v.length - 40); k--) if (isNum(v[k])) return v[k] * s.scale;
    return NaN;
  }

  paint(ctx, w, h) {
    const t = theme();
    const fs = this.fontPx;
    let now = this.now;
    if (!isNum(now)) {
      for (const d of this.data) if (d.t.length) now = Math.max(isNum(now) ? now : -Infinity, d.t[d.t.length - 1]);
    }
    if (!isNum(now)) now = 0;
    const t0 = now - this.window;

    // ---- legend (with current values)
    let top = 4;
    if (this.showLegend && this.series.length > 1) {
      const items = this.series.map((s, i) => {
        const lane = this.lanes[s.lane] || {};
        const val = this.lastValue(i);
        const dec = lane.decimals ?? 1;
        return { label: s.label, color: this.colorOf(s), dash: s.dash,
          value: isNum(val) ? `${formatNumber(val, dec)}${lane.unit ? ` ${lane.unit}` : ''}` : '—' };
      });
      top += this.legend(ctx, 2, top, items, w - 4) + 6;
    }

    // ---- per-lane ranges (from data in the window)
    const ranges = this.lanes.map((lane, li) => {
      let lo = Infinity, hi = -Infinity;
      this.series.forEach((s, i) => {
        if (s.lane !== li) return;
        const d = this.data[i];
        const i0 = lowerBound(d.t, t0);
        const [a, b] = extent(d.v, i0, d.v.length, s.scale);
        lo = Math.min(lo, a); hi = Math.max(hi, b);
      });
      for (const th of lane.thresholds || []) {
        if (isNum(th.value) && isNum(lo)) { lo = Math.min(lo, th.value); hi = Math.max(hi, th.value); }
      }
      return axisRange(isFinite(lo) ? lo : NaN, isFinite(hi) ? hi : NaN, lane);
    });

    // ---- lane geometry (heights do not depend on the gutter), then ticks, then the gutter
    const xAxisH = this.timeAxis ? fs * 1.5 : 4;
    const laneGap = fs * 1.55;
    const weights = this.lanes.map((l) => l.weight ?? 1);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const avail = h - top - xAxisH - laneGap * (this.lanes.length - 1) - fs * 1.05;
    let y = top + fs * 1.05;
    const laneRects = this.lanes.map((lane, li) => {
      const lh = Math.max(16, (avail * weights[li]) / totalW);
      const [a, b] = ranges[li];
      const ticks = niceTicks(a, b, Math.max(1, Math.min(5, Math.floor(lh / (fs * 2.2)))));
      const r = { y, h: lh, range: ranges[li], ticks };
      y += lh + laneGap;
      return r;
    });
    ctx.font = this.font(0.78, 400, false);
    let gutter = 24;
    for (const r of laneRects) {
      for (const v of r.ticks.ticks) gutter = Math.max(gutter, ctx.measureText(formatNumber(v, r.ticks.decimals)).width + 10);
    }
    const left = gutter, right = w - 6;
    const plotW = Math.max(10, right - left);
    const xOf = (tt) => left + ((tt - t0) / this.window) * plotW;

    // ---- draw lanes
    laneRects.forEach((r, li) => {
      const lane = this.lanes[li];
      const [a, b] = r.range;
      const yOf = (v) => r.y + r.h - ((v - a) / (b - a)) * r.h;
      // lane title
      ctx.font = this.font(0.8, 600);
      ctx.fillStyle = t.text2;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      if (lane.label) ctx.fillText(`${lane.label}${lane.unit ? ` (${lane.unit})` : ''}`, left, r.y - fs * 0.35);
      // grid + ticks
      ctx.font = this.font(0.78);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (const v of r.ticks.ticks) {
        if (v < a - 1e-9 || v > b + 1e-9) continue;
        const yy = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < 1e-12 && a < 0 ? t.axis : t.grid;
        ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
        ctx.fillStyle = t.text3;
        ctx.fillText(formatNumber(v, r.ticks.decimals), left - 6, yy);
      }
      // thresholds (dashed = "limit", deliberately different from the solid grid)
      for (const th of lane.thresholds || []) {
        if (!isNum(th.value) || th.value < a || th.value > b) continue;
        const yy = Math.round(yOf(th.value)) + 0.5;
        const col = th.level === 'critical' ? t.status.critical : th.level === 'warning' ? t.status.warning : t.text3;
        ctx.strokeStyle = col;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
        ctx.setLineDash([]);
        if (th.label) {
          ctx.font = this.font(0.75, 500);
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = t.text2;
          ctx.fillText(th.label, right - 2, yy - 2);
        }
      }
      // series
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, r.y - 3, plotW, r.h + 6);
      ctx.clip();
      this.series.forEach((s, i) => {
        if (s.lane !== li) return;
        const d = this.data[i];
        const n = d.t.length;
        if (!n) return;
        const i0 = Math.max(0, lowerBound(d.t, t0) - 1);
        const col = this.colorOf(s);
        const path = new Path2D();
        let pen = false, firstX = NaN, lastX = NaN;
        // Min/max decimation per pixel column keeps peaks when there are more samples than pixels.
        const decimate = n - i0 > plotW * 2;
        let colX = -1, cMin = 0, cMax = 0, cLast = 0;
        const flush = () => {
          if (colX < 0) return;
          const ya = yOf(cMin), yb = yOf(cMax);
          if (!pen) { path.moveTo(colX, ya); pen = true; if (!isNum(firstX)) firstX = colX; } else path.lineTo(colX, ya);
          path.lineTo(colX, yb);
          path.lineTo(colX, yOf(cLast));
          lastX = colX;
        };
        for (let k = i0; k < n; k++) {
          const raw = d.v[k];
          const x = xOf(d.t[k]);
          if (!isNum(raw)) { if (decimate) { flush(); colX = -1; } pen = false; continue; }
          const v = raw * s.scale;
          if (decimate) {
            const px = Math.round(x);
            if (px !== colX) { flush(); colX = px; cMin = cMax = cLast = v; } else {
              if (v < cMin) cMin = v; if (v > cMax) cMax = v; cLast = v;
            }
          } else {
            if (!pen) { path.moveTo(x, yOf(v)); pen = true; if (!isNum(firstX)) firstX = x; } else path.lineTo(x, yOf(v));
            lastX = x;
          }
        }
        if (decimate) flush();
        if (s.fill && isNum(firstX)) {
          const area = new Path2D(path);
          area.lineTo(lastX, r.y + r.h);
          area.lineTo(firstX, r.y + r.h);
          area.closePath();
          ctx.globalAlpha = 0.1;
          ctx.fillStyle = col;
          ctx.fill(area);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = s.width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash(s.dash || []);
        ctx.stroke(path);
        ctx.setLineDash([]);
      });
      ctx.restore();
      // end dots
      this.series.forEach((s, i) => {
        if (s.lane !== li || s.dash) return;
        const d = this.data[i];
        for (let k = d.t.length - 1; k >= Math.max(0, d.t.length - 5); k--) {
          if (isNum(d.v[k])) {
            const v = d.v[k] * s.scale;
            if (v >= a && v <= b && d.t[k] >= t0) Chart.dot(ctx, xOf(d.t[k]), yOf(v), this.colorOf(s), 3.5);
            break;
          }
        }
      });
    });

    // ---- time axis
    const last = laneRects[laneRects.length - 1];
    const axisY = last.y + last.h;
    ctx.strokeStyle = t.axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, Math.round(axisY) + 0.5); ctx.lineTo(right, Math.round(axisY) + 0.5); ctx.stroke();
    if (this.timeAxis) {
      const step = this.window <= 20 ? 5 : this.window <= 60 ? 10 : this.window <= 180 ? 30 : 60;
      ctx.font = this.font(0.78);
      ctx.fillStyle = t.text3;
      ctx.textBaseline = 'top';
      for (let k = 0; k <= this.window; k += step) {
        const x = xOf(now - k);
        ctx.textAlign = k === 0 ? 'right' : 'center';
        ctx.fillText(k === 0 ? 'now' : `−${k} s`, x, axisY + 5);
      }
    }

    // ---- hover crosshair + tooltip (one tooltip, every series)
    if (this.hover && this.hover.x >= left && this.hover.x <= right && this.hover.y < axisY + 4) {
      const tt = t0 + ((this.hover.x - left) / plotW) * this.window;
      const rows = [];
      let snapX = this.hover.x;
      this.series.forEach((s, i) => {
        const d = this.data[i];
        if (!d.t.length) return;
        let k = lowerBound(d.t, tt);
        if (k >= d.t.length) k = d.t.length - 1;
        if (k > 0 && Math.abs(d.t[k - 1] - tt) < Math.abs(d.t[k] - tt)) k -= 1;
        if (i === 0) snapX = xOf(d.t[k]);
        const lane = this.lanes[s.lane] || {};
        const v = d.v[k] * s.scale;
        rows.push({ color: this.colorOf(s), dash: s.dash, label: s.label,
          value: isNum(v) ? `${formatNumber(v, lane.decimals ?? 1)}${lane.unit ? ` ${lane.unit}` : ''}` : '—' });
      });
      ctx.strokeStyle = t.text3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(snapX) + 0.5, top);
      ctx.lineTo(Math.round(snapX) + 0.5, axisY);
      ctx.stroke();
      const ago = now - tt;
      this.tooltip(ctx, snapX, this.hover.y, ago < 0.05 ? 'now' : `−${ago.toFixed(1)} s`, rows);
    }
  }
}

/* ================================================================== XYChart */

/**
 * @typedef {object} XYAxis
 * @property {string} [label]
 * @property {string} [unit]
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [invert]       draw increasing values downwards (y) / leftwards (x);
 *                                    Cp plots use `y: {invert: true}` so suction is up
 * @property {boolean} [includeZero]
 * @property {number} [decimals]      tooltip decimals
 * @property {(v: number) => string} [format]  tick label formatter
 */

/**
 * @typedef {object} XYSeries
 * @property {string} label
 * @property {string} [color]
 * @property {'points'|'line'|'both'} [mode='both']
 * @property {number} [radius=4]
 * @property {number} [width=2]
 * @property {number[]} [dash]
 */

/**
 * Scatter / line chart with real axes, optional inverted axes, reference lines, a fit-line
 * overlay and highlighted points.
 *
 * @example
 * const cp = new XYChart(el, {x: {label: 'x/c', min: 0, max: 1},
 *   y: {label: 'Cp', invert: true}, series: [{label: 'Suction'}, {label: 'Pressure'}]});
 * cp.setSeries(0, [0.05, 0.2, 0.45, 0.75], [-3.1, -2.4, -1.5, -0.6]);
 */
export class XYChart extends Chart {
  /**
   * @param {HTMLElement} host
   * @param {{x?: XYAxis, y?: XYAxis, series: XYSeries[], legend?: boolean, title?: string,
   *          empty?: string}} opts  `empty`: text shown when there is no data
   */
  constructor(host, opts) {
    super(host, opts);
    this.xAxis = opts.x || {};
    this.yAxis = opts.y || {};
    this.series = opts.series.map((s, i) => ({ mode: 'both', radius: 4, width: 2, slot: i, ...s }));
    this.xs = this.series.map(() => []);
    this.ys = this.series.map(() => []);
    this.fit = null;
    this.hLines = [];
    this.vLines = [];
    this.highlights = [];
    this.showLegend = opts.legend ?? true;
    this.emptyText = opts.empty || 'No data yet';
  }

  /**
   * Replace the points of series `i`.
   * @param {number} i
   * @param {ArrayLike<number>} xs
   * @param {ArrayLike<number>} ys
   */
  setSeries(i, xs, ys) {
    this.xs[i] = xs; this.ys[i] = ys;
    this.dirty = true;
  }

  /** Replace the points of series `i` from `[[x, y], ...]`. */
  setPoints(i, pts) {
    this.setSeries(i, pts.map((p) => p[0]), pts.map((p) => p[1]));
  }

  /**
   * Fit-line overlay y = slope·x + intercept over [x0, x1] (default: the x range), or null.
   * @param {{slope: number, intercept?: number, label?: string, x0?: number, x1?: number, color?: string}|null} fit
   */
  setFit(fit) { this.fit = fit; this.dirty = true; }

  /** Horizontal reference lines `[{value, label, level?: 'warning'|'critical'|'neutral'}]`. */
  setHLines(lines) { this.hLines = lines || []; this.dirty = true; }

  /** Vertical reference lines `[{value, label, level?}]`. */
  setVLines(lines) { this.vLines = lines || []; this.dirty = true; }

  /** Ring-highlight points `[{series, index, label?}]` (e.g. best lap, recommended limit). */
  setHighlights(h) { this.highlights = h || []; this.dirty = true; }

  /** Change axis options (e.g. a fixed range). */
  setAxes({ x, y } = {}) {
    if (x) this.xAxis = { ...this.xAxis, ...x };
    if (y) this.yAxis = { ...this.yAxis, ...y };
    this.dirty = true;
  }

  colorOf(s) { return s.color || seriesColor(s.slot); }

  paint(ctx, w, h) {
    const t = theme();
    const fs = this.fontPx;
    let top = 4;
    if (this.showLegend && this.series.length > 1) {
      const items = this.series.map((s) => ({ label: s.label, color: this.colorOf(s), dash: s.dash,
        swatch: s.mode === 'points' ? 'dot' : 'line' }));
      if (this.fit && this.fit.label) items.push({ label: this.fit.label, color: this.fit.color || t.text2, dash: [6, 4] });
      top += this.legend(ctx, 2, top, items, w - 4) + 4;
    }
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity, count = 0;
    this.series.forEach((s, i) => {
      const xs = this.xs[i], ys = this.ys[i];
      for (let k = 0; k < xs.length; k++) {
        if (!isNum(xs[k]) || !isNum(ys[k])) continue;
        count++;
        if (xs[k] < xlo) xlo = xs[k]; if (xs[k] > xhi) xhi = xs[k];
        if (ys[k] < ylo) ylo = ys[k]; if (ys[k] > yhi) yhi = ys[k];
      }
    });
    for (const l of this.hLines) if (isNum(l.value) && count) { ylo = Math.min(ylo, l.value); yhi = Math.max(yhi, l.value); }
    for (const l of this.vLines) if (isNum(l.value) && count) { xlo = Math.min(xlo, l.value); xhi = Math.max(xhi, l.value); }
    const [xa, xb] = axisRange(isFinite(xlo) ? xlo : NaN, isFinite(xhi) ? xhi : NaN, { pad: 0.05, ...this.xAxis });
    const [ya, yb] = axisRange(isFinite(ylo) ? ylo : NaN, isFinite(yhi) ? yhi : NaN, { allowNegative: true, ...this.yAxis });
    const xt = niceTicks(xa, xb, Math.max(3, Math.floor(w / 90)));
    const yt = niceTicks(ya, yb, Math.max(3, Math.floor(h / 55)));
    const fmtX = this.xAxis.format || ((v) => formatNumber(v, xt.decimals));
    const fmtY = this.yAxis.format || ((v) => formatNumber(v, yt.decimals));
    ctx.font = this.font(0.78);
    let gutter = 20;
    for (const v of yt.ticks) gutter = Math.max(gutter, ctx.measureText(fmtY(v)).width + 10);
    const yLabelW = this.yAxis.label ? fs * 1.3 : 0;
    const left = gutter + yLabelW, right = w - 10;
    const xLabelH = this.xAxis.label ? fs * 1.3 : 0;
    const bottom = h - fs * 1.5 - xLabelH, ptop = top + fs * 0.6;
    const pw = Math.max(10, right - left), ph = Math.max(10, bottom - ptop);
    const xOf = (v) => (this.xAxis.invert ? right - ((v - xa) / (xb - xa)) * pw : left + ((v - xa) / (xb - xa)) * pw);
    const yOf = (v) => (this.yAxis.invert ? ptop + ((v - ya) / (yb - ya)) * ph : bottom - ((v - ya) / (yb - ya)) * ph);

    // grid + ticks
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const v of yt.ticks) {
      if (v < ya - 1e-9 || v > yb + 1e-9) continue;
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < 1e-12 ? t.axis : t.grid;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillStyle = t.text3;
      ctx.fillText(fmtY(v), left - 6, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.ticks) {
      if (v < xa - 1e-9 || v > xb + 1e-9) continue;
      const xx = Math.round(xOf(v)) + 0.5;
      ctx.strokeStyle = t.grid;
      ctx.beginPath(); ctx.moveTo(xx, ptop); ctx.lineTo(xx, bottom); ctx.stroke();
      ctx.fillStyle = t.text3;
      ctx.fillText(fmtX(v), xx, bottom + 5);
    }
    ctx.strokeStyle = t.axis;
    ctx.beginPath(); ctx.moveTo(left, Math.round(bottom) + 0.5); ctx.lineTo(right, Math.round(bottom) + 0.5); ctx.stroke();
    // axis labels
    ctx.fillStyle = t.text2;
    ctx.font = this.font(0.8, 500);
    if (this.xAxis.label) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${this.xAxis.label}${this.xAxis.unit ? ` (${this.xAxis.unit})` : ''}`, left + pw / 2, h - 2);
    }
    if (this.yAxis.label) {
      ctx.save();
      ctx.translate(fs * 0.75, ptop + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${this.yAxis.label}${this.yAxis.unit ? ` (${this.yAxis.unit})` : ''}`, 0, 0);
      ctx.restore();
    }

    // reference lines
    const refLine = (l, horizontal) => {
      if (!isNum(l.value)) return;
      const col = l.level === 'critical' ? t.status.critical : l.level === 'warning' ? t.status.warning : t.text3;
      ctx.strokeStyle = col;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      if (horizontal) {
        const yy = Math.round(yOf(l.value)) + 0.5;
        ctx.moveTo(left, yy); ctx.lineTo(right, yy);
      } else {
        const xx = Math.round(xOf(l.value)) + 0.5;
        ctx.moveTo(xx, ptop); ctx.lineTo(xx, bottom);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (l.label) {
        ctx.font = this.font(0.75, 500);
        ctx.fillStyle = t.text2;
        if (horizontal) {
          ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          ctx.fillText(l.label, right - 2, yOf(l.value) - 3);
        } else {
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          ctx.fillText(l.label, xOf(l.value) + 4, ptop + 2);
        }
      }
    };
    this.hLines.forEach((l) => refLine(l, true));
    this.vLines.forEach((l) => refLine(l, false));

    if (!count) {
      ctx.font = this.font(0.9);
      ctx.fillStyle = t.text3;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyText, left + pw / 2, ptop + ph / 2);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 6, ptop - 6, pw + 12, ph + 12);
    ctx.clip();
    // fit line
    if (this.fit && isNum(this.fit.slope)) {
      const x0 = this.fit.x0 ?? xa, x1 = this.fit.x1 ?? xb;
      const b0 = this.fit.intercept || 0;
      ctx.strokeStyle = this.fit.color || t.text2;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(xOf(x0), yOf(this.fit.slope * x0 + b0));
      ctx.lineTo(xOf(x1), yOf(this.fit.slope * x1 + b0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // series
    this.series.forEach((s, i) => {
      const xs = this.xs[i], ys = this.ys[i];
      const col = this.colorOf(s);
      if (s.mode !== 'points') {
        ctx.strokeStyle = col;
        ctx.lineWidth = s.width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash(s.dash || []);
        ctx.beginPath();
        let pen = false;
        for (let k = 0; k < xs.length; k++) {
          if (!isNum(xs[k]) || !isNum(ys[k])) { pen = false; continue; }
          if (!pen) { ctx.moveTo(xOf(xs[k]), yOf(ys[k])); pen = true; } else ctx.lineTo(xOf(xs[k]), yOf(ys[k]));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (s.mode !== 'line') {
        for (let k = 0; k < xs.length; k++) {
          if (isNum(xs[k]) && isNum(ys[k])) Chart.dot(ctx, xOf(xs[k]), yOf(ys[k]), col, s.radius);
        }
      }
    });
    ctx.restore();
    // highlights: ring + label
    for (const hl of this.highlights) {
      const xs = this.xs[hl.series], ys = this.ys[hl.series];
      if (!xs || !isNum(xs[hl.index]) || !isNum(ys[hl.index])) continue;
      const x = xOf(xs[hl.index]), y = yOf(ys[hl.index]);
      ctx.strokeStyle = t.text1;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
      if (hl.label) {
        ctx.font = this.font(0.8, 600);
        ctx.textAlign = x > left + pw * 0.7 ? 'right' : 'left';
        ctx.textBaseline = 'bottom';
        const lx = x + (ctx.textAlign === 'right' ? -10 : 10), ly = y - 8 < ptop + fs ? y + 8 + fs : y - 8;
        // surface-coloured halo keeps the label legible over lines and gridlines
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = t.surface;
        ctx.strokeText(hl.label, lx, ly);
        ctx.fillStyle = t.text1;
        ctx.fillText(hl.label, lx, ly);
      }
    }
    // hover: nearest point within 32 px
    if (this.hover) {
      let best = null, bd = 32 * 32;
      this.series.forEach((s, i) => {
        const xs = this.xs[i], ys = this.ys[i];
        for (let k = 0; k < xs.length; k++) {
          if (!isNum(xs[k]) || !isNum(ys[k])) continue;
          const dx = xOf(xs[k]) - this.hover.x, dy = yOf(ys[k]) - this.hover.y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = { i, k }; }
        }
      });
      if (best) {
        const s = this.series[best.i];
        const x = xOf(this.xs[best.i][best.k]), y = yOf(this.ys[best.i][best.k]);
        ctx.strokeStyle = t.text1;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        const xd = this.xAxis.decimals ?? Math.max(xt.decimals, 1);
        const yd = this.yAxis.decimals ?? Math.max(yt.decimals, 2);
        const xv = this.xs[best.i][best.k], yv = this.ys[best.i][best.k];
        this.tooltip(ctx, x, y, s.label, [
          { label: this.yAxis.label || 'y', value: `${formatNumber(yv, yd)}${this.yAxis.unit ? ` ${this.yAxis.unit}` : ''}`, color: this.colorOf(s) },
          { label: this.xAxis.label || 'x', value: `${this.xAxis.format ? this.xAxis.format(xv) : formatNumber(xv, xd)}${this.xAxis.unit ? ` ${this.xAxis.unit}` : ''}` },
        ]);
      }
    }
  }
}

/* ================================================================== Gauge */

/**
 * @typedef {object} GaugeOptions
 * @property {number} min
 * @property {number} max
 * @property {string} [label]
 * @property {string} [unit]
 * @property {number} [decimals=0]
 * @property {number} [warn]      value from which the band is "warning" (high side)
 * @property {number} [crit]      value from which the band is "critical" (high side)
 * @property {number} [warnLo]    low-side warning threshold (value below it is a warning)
 * @property {number} [critLo]
 * @property {string} [color]     normal fill colour (default series slot 1)
 * @property {(v: number) => string} [format]
 * @property {string} [sub]       small text under the number (e.g. "limit 80 kW")
 */

/**
 * Arc gauge (240° sweep): a track, thin warning / critical bands on the outer edge, a value
 * arc whose colour carries the severity, and a big centred number.
 */
export class Gauge extends Chart {
  /** @param {HTMLElement} host @param {GaugeOptions} opts */
  constructor(host, opts) {
    super(host, opts);
    this.o = { decimals: 0, ...opts };
    this.value = NaN;
  }

  /** Set the displayed value (NaN / null = missing). */
  set(v) {
    const n = isNum(v) ? v : NaN;
    if (n !== this.value && !(Number.isNaN(n) && Number.isNaN(this.value))) { this.value = n; this.dirty = true; }
  }

  /** Update options (range, thresholds, label...). */
  configure(patch) { this.o = { ...this.o, ...patch }; this.dirty = true; }

  /** Severity of value v: 'critical' | 'warning' | 'normal'. */
  level(v) {
    const o = this.o;
    if (!isNum(v)) return 'normal';
    if ((isNum(o.crit) && v >= o.crit) || (isNum(o.critLo) && v <= o.critLo)) return 'critical';
    if ((isNum(o.warn) && v >= o.warn) || (isNum(o.warnLo) && v <= o.warnLo)) return 'warning';
    return 'normal';
  }

  paint(ctx, w, h) {
    const t = theme();
    const o = this.o;
    const fs = this.fontPx;
    const labelH = o.label ? fs * 1.4 : 0;
    const cx = w / 2;
    const r = Math.max(10, Math.min(w / 2 - 8, (h - labelH - 6) / 1.62));
    const cy = 6 + r + 2;
    const a0 = Math.PI * (150 / 180), sweep = Math.PI * (240 / 180);
    const frac = (v) => Math.min(1, Math.max(0, (v - o.min) / (o.max - o.min)));
    const ang = (v) => a0 + frac(v) * sweep;
    const thick = Math.max(6, r * 0.16);
    // track
    ctx.lineCap = 'round';
    ctx.lineWidth = thick;
    ctx.strokeStyle = t.grid;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep); ctx.stroke();
    // bands (thin, outside the track)
    ctx.lineCap = 'butt';
    ctx.lineWidth = 3;
    const band = (from, to, col) => {
      if (!isNum(from) || !isNum(to) || to <= from) return;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, r + thick / 2 + 4, ang(from), ang(to)); ctx.stroke();
    };
    band(o.warn, isNum(o.crit) ? o.crit : o.max, t.status.warning);
    band(o.crit, o.max, t.status.critical);
    band(isNum(o.critLo) ? o.critLo : o.min, o.warnLo, t.status.warning);
    band(o.min, o.critLo, t.status.critical);
    // value arc
    const lvl = this.level(this.value);
    if (isNum(this.value)) {
      const base = o.min < 0 && o.max > 0 ? 0 : o.min;
      ctx.lineCap = 'round';
      ctx.lineWidth = thick;
      ctx.strokeStyle = lvl === 'critical' ? t.status.critical : lvl === 'warning' ? t.status.warning : (o.color || seriesColor(0));
      const s = ang(Math.min(base, this.value)), e = ang(Math.max(base, this.value));
      ctx.beginPath(); ctx.arc(cx, cy, r, s, Math.max(e, s + 0.001)); ctx.stroke();
    }
    // number
    const txt = isNum(this.value) ? (o.format ? o.format(this.value) : formatNumber(this.value, o.decimals)) : '—';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = t.text1;
    const big = Math.min(r * 0.62, fs * 2.6);
    ctx.font = `600 ${big.toFixed(1)}px ${t.sans}`;
    ctx.fillText(txt, cx, cy + big * 0.3);
    ctx.font = this.font(0.8);
    ctx.fillStyle = t.text3;
    const unitY = cy + big * 0.3 + fs * 1.3;
    if (o.unit) ctx.fillText(o.unit, cx, unitY);
    if (o.sub && unitY + fs * 1.2 < h - (o.label ? fs * 1.5 : 0)) {
      ctx.font = this.font(0.75);
      ctx.fillText(o.sub, cx, unitY + fs * 1.15);
    }
    // min / max
    ctx.font = this.font(0.72);
    ctx.fillStyle = t.text3;
    ctx.textBaseline = 'top';
    ctx.fillText(formatNumber(o.min, 0), cx + Math.cos(a0) * r, cy + Math.sin(a0) * r + thick / 2 + 2);
    ctx.fillText(formatNumber(o.max, 0), cx + Math.cos(a0 + sweep) * r, cy + Math.sin(a0 + sweep) * r + thick / 2 + 2);
    if (o.label) {
      ctx.font = this.font(0.85, 500);
      ctx.fillStyle = t.text2;
      ctx.textBaseline = 'bottom';
      ctx.fillText(o.label, cx, h - 2);
    }
  }
}

/* ================================================================== BarChart */

/**
 * @typedef {object} BarSeries
 * @property {string} label
 * @property {string} [color]
 */

/**
 * Vertical bar chart, grouped or stacked, with a shared zero baseline (negative values grow
 * downwards). Bars are ≤ 24 px wide with a 4 px rounded data end; touching bars / stacked
 * segments are separated by a 2 px surface gap. Hover a bar for its value.
 *
 * @example
 * const e = new BarChart(el, {mode: 'grouped', y: {label: 'Energy', unit: 'kWh'},
 *   series: [{label: 'Net used'}, {label: 'Regen'}]});
 * e.setData(['L1', 'L2'], [[0.31, 0.30], [0.04, 0.05]]);  // values[series][category]
 */
export class BarChart extends Chart {
  /**
   * @param {HTMLElement} host
   * @param {{mode?: 'grouped'|'stacked', series: BarSeries[], y?: XYAxis, legend?: boolean,
   *          valueLabels?: boolean, title?: string, empty?: string, maxBar?: number}} opts
   */
  constructor(host, opts) {
    super(host, opts);
    this.mode = opts.mode || 'grouped';
    this.series = opts.series.map((s, i) => ({ slot: i, ...s }));
    this.yAxis = opts.y || {};
    this.categories = [];
    this.values = this.series.map(() => []);
    this.highlight = -1;
    this.showLegend = opts.legend ?? true;
    this.valueLabels = opts.valueLabels ?? false;
    this.emptyText = opts.empty || 'No data yet';
    this.maxBar = opts.maxBar ?? 24;
  }

  /**
   * @param {string[]} categories  x labels
   * @param {number[][]} values    values[series][category]
   */
  setData(categories, values) {
    this.categories = categories;
    this.values = values;
    this.dirty = true;
  }

  /** Emphasise one category (e.g. the best lap) with a background band; -1 for none. */
  setHighlight(index) { this.highlight = index; this.dirty = true; }

  colorOf(s) { return s.color || seriesColor(s.slot); }

  paint(ctx, w, h) {
    const t = theme();
    const fs = this.fontPx;
    let top = 4;
    if (this.showLegend && this.series.length > 1) {
      top += this.legend(ctx, 2, top, this.series.map((s) => ({ label: s.label, color: this.colorOf(s), swatch: 'rect' })), w - 4) + 4;
    }
    const n = this.categories.length;
    let lo = 0, hi = 0;
    for (let c = 0; c < n; c++) {
      if (this.mode === 'stacked') {
        let pos = 0, neg = 0;
        this.series.forEach((_, i) => { const v = this.values[i][c]; if (isNum(v)) { if (v >= 0) pos += v; else neg += v; } });
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      } else {
        this.series.forEach((_, i) => { const v = this.values[i][c]; if (isNum(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
      }
    }
    const [ya, yb] = axisRange(lo, hi, { pad: 0.1, allowNegative: lo < 0, ...this.yAxis, includeZero: true });
    const yt = niceTicks(ya, yb, Math.max(3, Math.floor(h / 55)));
    const fmtY = this.yAxis.format || ((v) => formatNumber(v, yt.decimals));
    ctx.font = this.font(0.78);
    let gutter = 20;
    for (const v of yt.ticks) gutter = Math.max(gutter, ctx.measureText(fmtY(v)).width + 10);
    const yLabelW = this.yAxis.label ? fs * 1.3 : 0;
    const left = gutter + yLabelW, right = w - 6;
    const bottom = h - fs * 1.5, ptop = top + fs * 0.6;
    const pw = Math.max(10, right - left), ph = Math.max(10, bottom - ptop);
    const yOf = (v) => bottom - ((v - ya) / (yb - ya)) * ph;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.ticks) {
      if (v < ya - 1e-9 || v > yb + 1e-9) continue;
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = t.grid;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillStyle = t.text3;
      ctx.fillText(fmtY(v), left - 6, yy);
    }
    if (this.yAxis.label) {
      ctx.save();
      ctx.translate(fs * 0.75, ptop + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.font = this.font(0.8, 500);
      ctx.fillStyle = t.text2;
      ctx.fillText(`${this.yAxis.label}${this.yAxis.unit ? ` (${this.yAxis.unit})` : ''}`, 0, 0);
      ctx.restore();
    }
    if (!n) {
      ctx.font = this.font(0.9);
      ctx.fillStyle = t.text3;
      ctx.textAlign = 'center';
      ctx.fillText(this.emptyText, left + pw / 2, ptop + ph / 2);
      return;
    }
    const slot = pw / n;
    const groups = this.mode === 'stacked' ? 1 : this.series.length;
    const gap = 2;
    const bw = Math.max(2, Math.min(this.maxBar, (slot * 0.7 - gap * (groups - 1)) / groups));
    const groupW = bw * groups + gap * (groups - 1);
    const y0 = yOf(0);
    /** @type {{x: number, y: number, w: number, h: number, c: number, i: number, v: number}[]} */
    const hits = [];
    // highlight band
    if (this.highlight >= 0 && this.highlight < n) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      roundRectPath(ctx, left + slot * this.highlight + 2, ptop, slot - 4, ph, 4);
      ctx.fill();
    }
    // category labels (thinned when crowded)
    ctx.font = this.font(0.78);
    const labelW = Math.max(...this.categories.map((c) => ctx.measureText(String(c)).width)) + 8;
    const labelEvery = Math.max(1, Math.ceil(labelW / slot));
    const hl = this.highlight;
    for (let c = 0; c < n; c++) {
      const gx = left + slot * c + (slot - groupW) / 2;
      // stride labels, plus the highlighted one; drop stride labels that would collide with it
      const clash = hl >= 0 && c !== hl && Math.abs(c - hl) * slot < labelW;
      if ((c % labelEvery === 0 && !clash) || c === hl) {
        ctx.fillStyle = c === this.highlight ? t.text1 : t.text3;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(this.categories[c], left + slot * c + slot / 2, bottom + 5);
      }
      let posAcc = 0, negAcc = 0;
      this.series.forEach((s, i) => {
        const v = this.values[i][c];
        if (!isNum(v) || v === 0) return;
        ctx.fillStyle = this.colorOf(s);
        let x, ya2, yb2;
        if (this.mode === 'stacked') {
          x = gx;
          const base = v >= 0 ? posAcc : negAcc;
          const end = base + v;
          if (v >= 0) posAcc = end; else negAcc = end;
          ya2 = yOf(base); yb2 = yOf(end);
          // 2 px surface gap between stacked segments
          const sgn = v >= 0 ? -1 : 1;
          if (base !== 0) ya2 += sgn * 1;
          if (Math.abs(yb2 - ya2) > 1) yb2 -= sgn * 1;
          const isEnd = (v >= 0 ? this.series.slice(i + 1).every((_, j) => !(this.values[i + 1 + j][c] > 0))
            : this.series.slice(i + 1).every((_, j) => !(this.values[i + 1 + j][c] < 0)));
          barPath(ctx, x, ya2, yb2, bw, isEnd ? 4 : 0);
        } else {
          x = gx + i * (bw + gap);
          ya2 = y0; yb2 = yOf(v);
          barPath(ctx, x, ya2, yb2, bw, 4);
        }
        const hovered = this.hover && this.hover.x >= x - 2 && this.hover.x <= x + bw + 2
          && this.hover.y >= Math.min(ya2, yb2) - 6 && this.hover.y <= Math.max(ya2, yb2) + 6;
        ctx.globalAlpha = hovered ? 1 : 0.92;
        ctx.fill();
        ctx.globalAlpha = 1;
        hits.push({ x, y: Math.min(ya2, yb2), w: bw, h: Math.abs(yb2 - ya2), c, i, v });
      });
      if (this.valueLabels && this.mode === 'stacked' && posAcc > 0) {
        ctx.font = this.font(0.74, 500);
        ctx.fillStyle = t.text2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(formatNumber(posAcc, this.yAxis.decimals ?? 2), gx + groupW / 2, yOf(posAcc) - 3);
      }
    }
    // baseline
    ctx.strokeStyle = t.axis;
    ctx.beginPath(); ctx.moveTo(left, Math.round(y0) + 0.5); ctx.lineTo(right, Math.round(y0) + 0.5); ctx.stroke();
    // hover (hit target: whole category slot, nearest bar)
    if (this.hover && this.hover.x >= left && this.hover.x <= right && this.hover.y <= bottom + 4) {
      const c = Math.floor((this.hover.x - left) / slot);
      if (c >= 0 && c < n) {
        const rows = this.series.map((s, i) => ({ label: s.label, color: this.colorOf(s),
          value: isNum(this.values[i][c]) ? `${formatNumber(this.values[i][c], this.yAxis.decimals ?? 3)}${this.yAxis.unit ? ` ${this.yAxis.unit}` : ''}` : '—' }));
        this.tooltip(ctx, left + slot * c + slot / 2, this.hover.y, this.categories[c], rows);
      }
    }
    this.hits = hits;
  }
}

/* ================================================================== Sparkline */

/**
 * Tiny trend line (no axes) with an end dot, for tables and stat tiles.
 *
 * @example
 * const sp = new Sparkline(el, {color: seriesColor(0)});
 * sp.set(app.hist.series('cell_t_20', 30).v);
 */
export class Sparkline extends Chart {
  /**
   * @param {HTMLElement} host
   * @param {{color?: string, min?: number, max?: number, fill?: boolean, title?: string}} [opts]
   */
  constructor(host, opts = {}) {
    super(host, opts);
    this.o = { fill: true, ...opts };
    this.values = new Float64Array(0);
    this.canvas.style.pointerEvents = 'none';
  }

  /** Set the values to draw (oldest first). @param {ArrayLike<number>} values */
  set(values) { this.values = values; this.dirty = true; }

  /** Change the colour (e.g. when the channel status changes). */
  setColor(color) {
    if (color !== this.o.color) { this.o.color = color; this.dirty = true; }
  }

  paint(ctx, w, h) {
    Sparkline.drawInto(ctx, 0, 0, w, h, this.values, this.o);
  }

  /**
   * Draw a sparkline into any 2D context rectangle (for pooled / virtualised rows).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {ArrayLike<number>} values
   * @param {{color?: string, min?: number, max?: number, fill?: boolean}} [o]
   */
  static drawInto(ctx, x, y, w, h, values, o = {}) {
    const n = values.length;
    let lo = isNum(o.min) ? o.min : Infinity, hi = isNum(o.max) ? o.max : -Infinity;
    if (!isNum(o.min) || !isNum(o.max)) {
      for (let k = 0; k < n; k++) {
        const v = values[k];
        if (!isNum(o.min) && v < lo) lo = v;
        if (!isNum(o.max) && v > hi) hi = v;
      }
    }
    const t = theme();
    if (!isFinite(lo) || !isFinite(hi)) {
      ctx.strokeStyle = t.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 2, y + h / 2 + 0.5); ctx.lineTo(x + w - 2, y + h / 2 + 0.5); ctx.stroke();
      return;
    }
    if (hi - lo < 1e-12) { lo -= 1; hi += 1; }
    const pad = 3.5;
    const xOf = (k) => x + 1 + (k / Math.max(1, n - 1)) * (w - pad - 2);
    const yOf = (v) => y + pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
    const col = o.color || seriesColor(0);
    const path = new Path2D();
    let pen = false, first = -1, lastK = -1;
    const step = Math.max(1, Math.floor(n / (w * 1.5)));
    for (let k = 0; k < n; k += step) {
      const v = values[k];
      if (!isNum(v)) { pen = false; continue; }
      if (!pen) { path.moveTo(xOf(k), yOf(v)); pen = true; if (first < 0) first = k; } else path.lineTo(xOf(k), yOf(v));
      lastK = k;
    }
    if (n - 1 > lastK && isNum(values[n - 1])) { path.lineTo(xOf(n - 1), yOf(values[n - 1])); lastK = n - 1; }
    if (lastK < 0) return;
    if (o.fill !== false && first >= 0) {
      const area = new Path2D(path);
      area.lineTo(xOf(lastK), y + h);
      area.lineTo(xOf(first), y + h);
      area.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = col;
      ctx.fill(area);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.beginPath();
    ctx.arc(xOf(lastK), yOf(values[lastK]), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }
}
