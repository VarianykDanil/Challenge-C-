/**
 * @file Powertrain tab - accumulator card: 140 series cells (5 segments × 28) drawn as a
 * canvas grid coloured by cell voltage, temperature or deviation from the pack mean, with
 * hover details, min / max / mean / spread statistics, outlier outlines and a colour bar.
 *
 * Physics and practice behind the picture
 * ---------------------------------------
 * * **Series string.** Every "cell" is a parallel group of 4 × 21700 cells; 140 groups in
 *   series give the pack voltage `V_pack = Σ V_cell` (392 V empty … 588 V full). Cell `k` sits
 *   in segment `k // 28` (FS rules: each segment ≤ 120 V and ≤ 6 MJ).
 * * **Temperature sensors.** 60 NTCs, each glued between 2-3 cells; sensor `j` covers cells
 *   `round(j·140/60) … round((j+1)·140/60) − 1`. This is a re-implementation of
 *   `aerovolt/core/physics.py: temp_sensor_cells(j)` (including Python's round-half-to-even),
 *   so the dashboard and the simulator agree on which cells a sensor sees (sensor 20 → cells
 *   47 and 48). In temperature mode one block is drawn per sensor - the data has no finer
 *   resolution, and pretending otherwise would be dishonest.
 * * **Why ΔV from the mean?** Under load every cell drops `I·R0`, so absolute voltages move
 *   together; a weak cell (low capacity → lower OCV as it discharges faster) or a bad weld
 *   (higher R0 → bigger sag under current) shows as a negative deviation from its siblings.
 * * **Outliers (client-side).** The modified z-score of Iglewicz & Hoaglin,
 *   `z = 0.6745 · (x − median) / MAD` with `MAD = median(|x − median|)`. Median and MAD are
 *   robust: one bad cell cannot drag the reference towards itself the way it drags a mean and
 *   standard deviation. `|z| > 3.5` (and a minimum physical deviation, so sensor noise on a
 *   perfectly balanced pack is not flagged) outlines the cell. Cells named by an active BMS
 *   alert (`bms_*`) are outlined in the alert's severity colour.
 */

import { Chart, theme } from '../lib/charts.js';
import { diverging, sequential, rgbCss, MISSING_RGB } from '../lib/colormap.js';
import { formatNumber, isNum } from '../lib/format.js';
import { card, el, enumLabel, levelOf, num, setData, setText, signed, tile, vehicleNum } from './pt_common.js';

/* ================================================================== pure helpers */

/**
 * Round half to even ("banker's rounding"), exactly like Python 3's `round(x)`.
 * @param {number} x
 * @returns {number}
 */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) > 1e-9) return Math.round(x);
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Cells covered by temperature sensor `j` as a half-open range `[start, stop)`.
 * Mirrors `core/physics.py: temp_sensor_cells(j, n_cells, n_sensors)`.
 * @param {number} j          sensor index 0…nSensors−1
 * @param {number} [nCells=140]
 * @param {number} [nSensors=60]
 * @returns {[number, number]}
 */
export function tempSensorCells(j, nCells = 140, nSensors = 60) {
  if (!(j >= 0 && j < nSensors)) throw new RangeError(`temperature sensor index ${j} outside 0..${nSensors - 1}`);
  return [roundHalfEven((j * nCells) / nSensors), roundHalfEven(((j + 1) * nCells) / nSensors)];
}

/**
 * Sensor index for every cell (inverse of {@link tempSensorCells}); mirrors
 * `core/physics.py: cell_temp_sensor(k)`.
 * @param {number} [nCells=140]
 * @param {number} [nSensors=60]
 * @returns {Int16Array}  cell → sensor
 */
export function cellSensorMap(nCells = 140, nSensors = 60) {
  const map = new Int16Array(nCells).fill(-1);
  for (let j = 0; j < nSensors; j++) {
    const [a, b] = tempSensorCells(j, nCells, nSensors);
    for (let k = a; k < b && k < nCells; k++) map[k] = j;
  }
  return map;
}

/**
 * Median of the finite values of `xs` (NaN when there are none).
 * @param {ArrayLike<number>} xs
 * @returns {number}
 */
export function median(xs) {
  const a = [];
  for (let i = 0; i < xs.length; i++) if (isNum(xs[i])) a.push(xs[i]);
  if (!a.length) return NaN;
  a.sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/**
 * Modified (robust) z-scores: `z_i = 0.6745 (x_i − median) / max(MAD, madFloor)`.
 * @param {ArrayLike<number>} xs
 * @param {number} madFloor  smallest MAD used (the sensor noise level), avoids dividing by ~0
 *                           on a perfectly balanced pack
 * @returns {{median: number, mad: number, z: Float64Array}}  z is NaN where x is missing
 */
export function robustZ(xs, madFloor) {
  const med = median(xs);
  const dev = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) dev[i] = isNum(xs[i]) ? Math.abs(xs[i] - med) : NaN;
  const mad = median(dev);
  const scale = Math.max(isNum(mad) ? mad : 0, madFloor);
  const z = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) z[i] = isNum(xs[i]) && isNum(med) ? (0.6745 * (xs[i] - med)) / scale : NaN;
  return { median: med, mad, z };
}

/**
 * Min / max (with indices), mean and count of the finite values.
 * @param {ArrayLike<number>} xs
 * @returns {{min: number, max: number, iMin: number, iMax: number, mean: number, n: number}}
 */
export function extentStats(xs) {
  let min = Infinity, max = -Infinity, iMin = -1, iMax = -1, sum = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (!isNum(x)) continue;
    if (x < min) { min = x; iMin = i; }
    if (x > max) { max = x; iMax = i; }
    sum += x; n++;
  }
  return n ? { min, max, iMin, iMax, mean: sum / n, n } : { min: NaN, max: NaN, iMin: -1, iMax: -1, mean: NaN, n: 0 };
}

/** Outlier thresholds: |z| above this AND a minimum physical deviation. */
export const OUTLIER_Z = 3.5;
export const OUTLIER_MIN_DV = 0.005; // V
export const OUTLIER_MIN_DT = 1.5; // °C
const MAD_FLOOR_V = 0.001; // V   (cell monitor resolution 1 mV)
const MAD_FLOOR_T = 0.3; // °C  (NTC noise ≈ 0.2 °C)

/**
 * Cells named by active alerts. Channels map to cells as: `cell_v_NNN` → cell NNN,
 * `cell_t_JJ` → the cells of sensor JJ, `calc_cell_v_min` → `calc_cell_v_min_idx`,
 * `calc_cell_t_max` → the cells of sensor `calc_cell_t_max_idx`.
 * @param {Iterable<object>} alerts  active alerts
 * @param {(id: string) => number} val  latest value lookup (for the *_idx channels)
 * @param {number} nCells
 * @param {number} nSensors
 * @returns {Map<number, {severity: string, title: string}>}  cell → worst alert
 */
export function alertCells(alerts, val, nCells = 140, nSensors = 60) {
  const out = new Map();
  const rank = { info: 1, warn: 2, critical: 3 };
  const add = (k, a) => {
    if (!(k >= 0 && k < nCells)) return;
    const prev = out.get(k);
    if (!prev || (rank[a.severity] || 0) > (rank[prev.severity] || 0)) out.set(k, { severity: a.severity, title: a.title || a.id });
  };
  const addSensor = (j, a) => {
    if (!(j >= 0 && j < nSensors)) return;
    const [s, e] = tempSensorCells(j, nCells, nSensors);
    for (let k = s; k < e; k++) add(k, a);
  };
  for (const a of alerts) {
    for (const ch of a.channels || []) {
      let m;
      if ((m = /^cell_v_(\d+)$/.exec(ch))) add(Number(m[1]), a);
      else if ((m = /^cell_t_(\d+)$/.exec(ch))) addSensor(Number(m[1]), a);
      else if (ch === 'calc_cell_v_min') { const i = val('calc_cell_v_min_idx'); if (isNum(i)) add(Math.round(i), a); }
      else if (ch === 'calc_cell_t_max') { const j = val('calc_cell_t_max_idx'); if (isNum(j)) addSensor(Math.round(j), a); }
    }
  }
  return out;
}

const pad3 = (k) => String(k).padStart(3, '0');
const pad2 = (k) => String(k).padStart(2, '0');

/* ================================================================== colour scales */

/** Lowest LUT position used by the sequential ramps, so the coldest cell never melts into
 *  the dark card surface (the ramps start almost black). */
const SEQ_FLOOR = 0.14;

/**
 * Colour scale of one display mode.
 * @typedef {object} CellScale
 * @property {'v'|'t'|'dv'} mode
 * @property {number} lo
 * @property {number} hi
 * @property {(v: number) => number[]} rgb
 * @property {string} label
 * @property {string} unit
 * @property {(v: number) => string} fmt
 */

function sequentialScale(mode, lo, hi, ramp, label, unit, dec) {
  return {
    mode, lo, hi, label, unit,
    rgb: (v) => (isNum(v) ? sequential(SEQ_FLOOR + (1 - SEQ_FLOOR) * Math.min(1, Math.max(0, (v - lo) / (hi - lo))), 0, 1, ramp) : [...MISSING_RGB]),
    fmt: (v) => formatNumber(v, dec),
  };
}

/** Round `x` up/down to a multiple of `step`. */
const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;
const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;

/**
 * Build the colour scale for a mode from the current data. Ranges are snapped to round
 * numbers (so the colour bar does not jitter) and have a minimum span (so sensor noise on a
 * balanced pack is not stretched into a rainbow of false contrast).
 * @param {'v'|'t'|'dv'} mode
 * @param {{min: number, max: number}} ext  extent of the plotted quantity
 * @returns {CellScale}
 */
export function cellScale(mode, ext) {
  if (mode === 'dv') {
    // deviation from the mean, mV - symmetric diverging scale, grey = the pack mean
    const m = Math.max(5, ceilTo(Math.max(Math.abs(ext.min || 0), Math.abs(ext.max || 0)), 5));
    return {
      mode, lo: -m, hi: m, label: 'ΔV from pack mean', unit: 'mV',
      rgb: (v) => diverging(v, -m, m, { center: 0, neutral: 'dark' }),
      fmt: (v) => `${v > 0 ? '+' : ''}${formatNumber(v, 0)}`,
    };
  }
  if (mode === 't') {
    let lo = isNum(ext.min) ? floorTo(ext.min, 1) : 20;
    let hi = isNum(ext.max) ? ceilTo(ext.max, 1) : 40;
    if (hi - lo < 6) { const c = (hi + lo) / 2; lo = Math.floor(c - 3); hi = lo + 6; }
    return sequentialScale('t', lo, hi, 'heat', 'Cell temperature', '°C', 0);
  }
  let lo = isNum(ext.min) ? floorTo(ext.min, 0.01) : 3.6;
  let hi = isNum(ext.max) ? ceilTo(ext.max, 0.01) : 4.0;
  if (hi - lo < 0.03) { const c = (hi + lo) / 2; lo = floorTo(c - 0.015, 0.005); hi = lo + 0.03; }
  return sequentialScale('v', lo, hi, 'blue', 'Cell voltage', 'V', 2);
}

/* ================================================================== model */

/**
 * Snapshot of the accumulator, rebuilt at 10 Hz from `app.latest`.
 */
export class AccumulatorModel {
  /**
   * @param {{series?: number, segments?: number, temp_sensors?: number}} acc  vehicle.accumulator
   */
  constructor(acc = {}) {
    this.nCells = acc.series || 140;
    this.nSegments = acc.segments || 5;
    this.nSensors = acc.temp_sensors || 60;
    this.perSeg = Math.round(this.nCells / this.nSegments);
    this.sensorOf = cellSensorMap(this.nCells, this.nSensors);
    this.vIds = Array.from({ length: this.nCells }, (_, k) => `cell_v_${pad3(k)}`);
    this.tIds = Array.from({ length: this.nSensors }, (_, j) => `cell_t_${pad2(j)}`);
    this.v = new Float64Array(this.nCells).fill(NaN);
    this.dv = new Float64Array(this.nCells).fill(NaN); // mV
    this.tSensor = new Float64Array(this.nSensors).fill(NaN);
    this.tCell = new Float64Array(this.nCells).fill(NaN);
    this.zV = new Float64Array(this.nCells).fill(NaN);
    this.zT = new Float64Array(this.nSensors).fill(NaN);
    /** bit 1: voltage outlier, bit 2: temperature outlier (of the cell's sensor) */
    this.outlier = new Uint8Array(this.nCells);
    /** @type {Map<number, {severity: string, title: string}>} */
    this.alerts = new Map();
    this.vStats = extentStats(this.v);
    this.tStats = extentStats(this.tSensor);
    this.dvStats = extentStats(this.dv);
  }

  /** @param {number} j @returns {[number, number]} cells of sensor j */
  sensorCells(j) { return tempSensorCells(j, this.nCells, this.nSensors); }

  /**
   * Refresh every array from the app.
   * @param {{val: (id: string) => number, alerts: Map<string, object>}} app
   */
  refresh(app) {
    const { nCells, nSensors } = this;
    for (let k = 0; k < nCells; k++) this.v[k] = app.val(this.vIds[k]);
    for (let j = 0; j < nSensors; j++) this.tSensor[j] = app.val(this.tIds[j]);
    for (let k = 0; k < nCells; k++) { const j = this.sensorOf[k]; this.tCell[k] = j >= 0 ? this.tSensor[j] : NaN; }
    this.vStats = extentStats(this.v);
    this.tStats = extentStats(this.tSensor);
    const mean = this.vStats.mean;
    for (let k = 0; k < nCells; k++) this.dv[k] = isNum(this.v[k]) ? (this.v[k] - mean) * 1000 : NaN;
    this.dvStats = extentStats(this.dv);
    const rv = robustZ(this.v, MAD_FLOOR_V);
    const rt = robustZ(this.tSensor, MAD_FLOOR_T);
    this.zV = rv.z;
    this.zT = rt.z;
    this.outlier.fill(0);
    for (let k = 0; k < nCells; k++) {
      if (Math.abs(this.zV[k]) > OUTLIER_Z && Math.abs(this.v[k] - rv.median) >= OUTLIER_MIN_DV) this.outlier[k] |= 1;
      const j = this.sensorOf[k];
      if (j >= 0 && Math.abs(this.zT[j]) > OUTLIER_Z && Math.abs(this.tSensor[j] - rt.median) >= OUTLIER_MIN_DT) this.outlier[k] |= 2;
    }
    this.alerts = alertCells(app.alerts.values(), (id) => app.val(id), nCells, nSensors);
  }

  /** Number of cells flagged by the voltage (bit 1) or temperature (bit 2) outlier test. */
  outlierCount(bit) {
    let n = 0;
    for (let k = 0; k < this.nCells; k++) if (this.outlier[k] & bit) n++;
    return n;
  }
}

/* ================================================================== the canvas grid */

/**
 * Canvas grid of the cells (one row per segment). Extends the chart base class, so it is
 * HiDPI-crisp, resizes with its host and is drawn by the shared `renderCharts()` loop only
 * when something changed (new data at 10 Hz, or the pointer moved).
 */
export class CellGrid extends Chart {
  /**
   * @param {HTMLElement} host
   * @param {AccumulatorModel} model
   */
  constructor(host, model) {
    super(host, { title: 'Accumulator cell map: 5 segments of 28 cells' });
    this.model = model;
    /** @type {'v'|'t'|'dv'} */
    this.mode = 'v';
    /** @type {CellScale|null} */
    this.scale = null;
    /** cached CSS colours per cell (or per sensor in temperature mode) */
    this.colors = [];
    this.layout = null;
    /** catalogue defs whose warn/crit limits classify a hovered cell: {v, t} */
    this.limits = null;
  }

  /**
   * New data / mode / scale: recompute the colours and mark for redraw.
   * @param {'v'|'t'|'dv'} mode
   * @param {CellScale} scale
   */
  refresh(mode, scale) {
    this.mode = mode;
    this.scale = scale;
    const m = this.model;
    if (mode === 't') this.colors = Array.from(m.tSensor, (x) => rgbCss(scale.rgb(x)));
    else {
      const src = mode === 'dv' ? m.dv : m.v;
      this.colors = Array.from(src, (x) => rgbCss(scale.rgb(x)));
    }
    this.dirty = true;
  }

  /** Cell under the pointer (or -1). */
  hitCell() {
    const L = this.layout;
    if (!L || !this.hover) return -1;
    const { x, y } = this.hover;
    const col = Math.floor((x - L.left) / L.cw);
    const row = Math.floor((y - L.top) / L.rh);
    if (col < 0 || col >= L.perSeg || row < 0 || row >= L.rows) return -1;
    const k = row * L.perSeg + col;
    return k < this.model.nCells ? k : -1;
  }

  paint(ctx, w, h) {
    const t = theme();
    const m = this.model;
    const fs = this.fontPx;
    const perSeg = m.perSeg, rows = m.nSegments;
    const left = fs * 2.3, top = fs * 1.25, right = w - 2, bottom = h - 2;
    const cw = (right - left) / perSeg;
    const rh = (bottom - top) / rows;
    this.layout = { left, top, cw, rh, perSeg, rows };
    const gap = 2;
    const rad = Math.min(4, cw / 4);

    // position-in-segment ticks (top) and segment labels (left)
    ctx.font = this.font(0.72);
    ctx.fillStyle = t.text3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of [0, 7, 14, 21, perSeg - 1]) ctx.fillText(String(c + 1), left + (c + 0.5) * cw, top / 2);
    ctx.font = this.font(0.8, 600);
    ctx.fillStyle = t.text2;
    ctx.textAlign = 'left';
    for (let r = 0; r < rows; r++) ctx.fillText(`S${r}`, 0, top + (r + 0.5) * rh);

    const cellRect = (k) => {
      const r = Math.floor(k / perSeg), c = k % perSeg;
      return [left + c * cw + gap / 2, top + r * rh + gap / 2, cw - gap, rh - gap];
    };
    const roundRect = (x, y, ww, hh) => {
      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(1, ww), Math.max(1, hh), rad);
    };

    // fills
    if (this.mode === 't') {
      for (let j = 0; j < m.nSensors; j++) {
        const [a, b] = m.sensorCells(j);
        const [x0, y0, , hh] = cellRect(a);
        const [x1, , w1] = cellRect(b - 1);
        ctx.fillStyle = this.colors[j] || rgbCss(MISSING_RGB);
        roundRect(x0, y0, x1 + w1 - x0, hh);
        ctx.fill();
      }
    } else {
      for (let k = 0; k < m.nCells; k++) {
        const [x, y, ww, hh] = cellRect(k);
        ctx.fillStyle = this.colors[k] || rgbCss(MISSING_RGB);
        roundRect(x, y, ww, hh);
        ctx.fill();
      }
    }

    // outlines: statistical outliers (dashed, primary ink) and BMS alerts (status colour)
    const bit = this.mode === 't' ? 2 : 1;
    // Outline inside the rect; solid outlines get a thin surface-coloured inner ring so they
    // stay visible on the lightest fills (e.g. an amber ring on a pale-yellow hot block).
    const strokeRect = (x, y, ww, hh, color, dash, lw) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      roundRect(x + lw / 2, y + lw / 2, ww - lw, hh - lw);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!dash.length && ww > 2 * lw + 4 && hh > 2 * lw + 4) {
        ctx.strokeStyle = t.surface;
        ctx.lineWidth = 1.25;
        roundRect(x + lw + 0.6, y + lw + 0.6, ww - 2 * lw - 1.2, hh - 2 * lw - 1.2);
        ctx.stroke();
      }
    };
    const strokeCell = (k, color, dash, lw) => {
      const [x, y, ww, hh] = cellRect(k);
      strokeRect(x, y, ww, hh, color, dash, lw);
    };
    const zColor = t.text1;
    const alertColor = (a) => (a.severity === 'critical' ? t.status.critical : t.status.warning);
    if (this.mode === 't') {
      // temperature data exists per sensor: outline the whole sensor block when every cell
      // of the block carries the same mark, otherwise the marked cells alone
      for (let j = 0; j < m.nSensors; j++) {
        const [a, b] = m.sensorCells(j);
        const cells = [];
        for (let q = a; q < b; q++) cells.push(q);
        const al = cells.map((q) => m.alerts.get(q));
        const sameAlert = al[0] && al.every((x) => x && x.severity === al[0].severity);
        const allZ = cells.every((q) => m.outlier[q] & bit);
        if (sameAlert || (allZ && !al.some(Boolean))) {
          const [x0, y0, , hh] = cellRect(a);
          const [x1, , w1] = cellRect(b - 1);
          strokeRect(x0, y0, x1 + w1 - x0, hh, sameAlert ? alertColor(al[0]) : zColor,
            sameAlert ? [] : [3, 2], sameAlert ? 2.5 : 1.5);
        } else {
          cells.forEach((q, i) => {
            if (al[i]) strokeCell(q, alertColor(al[i]), [], 2.5);
            else if (m.outlier[q] & bit) strokeCell(q, zColor, [3, 2], 1.5);
          });
        }
      }
    } else {
      for (let k = 0; k < m.nCells; k++) if (m.outlier[k] & bit && !m.alerts.has(k)) strokeCell(k, zColor, [3, 2], 1.5);
      for (const [k, a] of m.alerts) strokeCell(k, alertColor(a), [], 2.5);
    }

    // hover
    const k = this.hitCell();
    if (k >= 0) {
      strokeCell(k, t.text1, [], 2);
      const [x, y, ww, hh] = cellRect(k);
      this.tooltip(ctx, x + ww / 2, y + hh / 2, ...this.tooltipRows(k));
    }
  }

  /** @private header + rows for the hover tooltip of cell k */
  tooltipRows(k) {
    const m = this.model;
    const seg = Math.floor(k / m.perSeg);
    const j = m.sensorOf[k];
    const [a, b] = j >= 0 ? m.sensorCells(j) : [k, k + 1];
    const v = m.v[k], tt = m.tCell[k], dv = m.dv[k];
    const rows = [
      { label: 'voltage', value: isNum(v) ? `${formatNumber(v, 3)} V` : '—' },
      { label: `temperature (sensor ${pad2(j)}: cells ${pad3(a)}–${pad3(b - 1)})`, value: isNum(tt) ? `${formatNumber(tt, 1)} °C` : '—' },
      { label: 'from pack mean', value: isNum(dv) ? `${dv > 0 ? '+' : ''}${formatNumber(dv, 1)} mV` : '—' },
      { label: 'robust z (V / T)', value: `${isNum(m.zV[k]) ? formatNumber(m.zV[k], 1) : '—'} / ${j >= 0 && isNum(m.zT[j]) ? formatNumber(m.zT[j], 1) : '—'}` },
    ];
    const al = m.alerts.get(k);
    const flags = [];
    if (m.outlier[k] & 1) flags.push('voltage outlier');
    if (m.outlier[k] & 2) flags.push('temperature outlier');
    const lim = this.limits;
    if (lim) {
      const lv = levelOf(lim.v, v), lt = levelOf(lim.t, tt);
      if (lv) flags.push(`voltage ${lv === 'critical' ? 'beyond limit' : 'near limit'}`);
      if (lt) flags.push(`temperature ${lt === 'critical' ? 'beyond limit' : 'high'}`);
    }
    rows.push({ label: 'status', value: al ? `${al.severity === 'critical' ? 'CRITICAL' : 'WARNING'}: ${al.title}` : flags.length ? flags.join(', ') : 'normal' });
    return [`Cell ${pad3(k)} · segment ${seg}, position ${(k % m.perSeg) + 1}`, rows];
  }
}

/* ================================================================== the card */

const MODES = [
  ['v', 'Voltage', 'Cell voltage, V'],
  ['t', 'Temperature', 'Cell temperature from the 60 sensors, °C'],
  ['dv', 'ΔV from mean', 'Deviation of each cell from the pack mean voltage, mV'],
];

/**
 * The accumulator card: pack KPIs, the mode toggle, the cell grid, statistics, outline
 * legend and colour bar.
 */
export class AccumulatorCard {
  /**
   * @param {HTMLElement} parent
   * @param {object} app
   */
  constructor(parent, app) {
    const acc = (app.meta && app.meta.vehicle && app.meta.vehicle.accumulator) || {};
    this.model = new AccumulatorModel(acc);
    const m = this.model;
    /** @type {'v'|'t'|'dv'} */
    this.mode = 'v';
    const { card: c, head } = card('pt-acc', 'Accumulator',
      `${m.nCells} cells · ${m.nSegments} × ${m.perSeg}${acc.parallel ? ` · ${acc.parallel}P` : ''}`);

    // display-mode toggle (segmented control)
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Colour the cells by');
    this.modeButtons = MODES.map(([id, label, title]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-pressed', String(id === this.mode));
      b.addEventListener('click', () => this.setMode(id, app));
      seg.append(b);
      return [id, b];
    });
    head.append(seg);

    // pack KPIs
    const kpis = el('div', 'pt-kpis');
    this.kV = tile('Pack voltage');
    this.kI = tile('Pack current');
    this.kP = tile('Pack power');
    this.kSoc = tile('SoC (BMS)');
    this.kState = tile('BMS state');
    kpis.append(this.kV.root, this.kI.root, this.kP.root, this.kSoc.root, this.kState.root);

    // grid
    const host = el('div', 'pt-cells');
    this.grid = new CellGrid(host, m);
    this.grid.limits = { v: app.def('cell_v_000'), t: app.def('cell_t_00') };

    // statistics + legends
    const foot = el('div', 'pt-acc-foot');
    const stats = el('div', 'pt-acc-stats');
    this.sMin = tile('Min');
    this.sMax = tile('Max');
    this.sMean = tile('Mean');
    this.sSpread = tile('Spread');
    stats.append(this.sMin.root, this.sMax.root, this.sMean.root, this.sSpread.root);
    const legend = el('div', 'pt-acc-legend');
    const outl = el('div', 'pt-outline-key');
    outl.title = 'Dashed outline: robust z-score |z| > 3.5 against the other cells (median / MAD). '
      + 'Solid outline: the cell is named by an active BMS alert (amber = warning, red = critical).';
    outl.innerHTML = '<span class="pt-ok-box pt-ok-z"></span><span class="pt-ok-txt">|z| > 3.5</span>'
      + '<span class="pt-ok-box pt-ok-alert"></span><span class="pt-ok-txt">alert</span>';
    this.outlierText = el('span', 'pt-outlier-count', '');
    outl.append(this.outlierText);
    this.cbar = el('div', 'colorbar pt-cbar');
    this.cbHead = el('div', 'colorbar-head');
    this.cbBar = el('div', 'colorbar-bar');
    this.cbTicks = el('div', 'colorbar-ticks');
    this.cbar.append(this.cbHead, this.cbBar, this.cbTicks);
    this.cbKey = '';
    legend.append(outl, this.cbar);
    foot.append(stats, legend);

    c.append(kpis, host, foot);
    parent.append(c);
    this.root = c;
  }

  /**
   * Switch the colour mode and redraw at once.
   * @param {'v'|'t'|'dv'} mode
   * @param {object} app
   */
  setMode(mode, app) {
    this.mode = mode;
    for (const [id, b] of this.modeButtons) b.setAttribute('aria-pressed', String(id === mode));
    this.update(app);
  }

  /** Refresh data, statistics and colours (called at 10 Hz). @param {object} app */
  update(app) {
    const m = this.model;
    m.refresh(app);
    const mode = this.mode;
    const ext = mode === 't' ? m.tStats : mode === 'dv' ? m.dvStats : m.vStats;
    const scale = cellScale(mode, ext);
    this.grid.refresh(mode, scale);
    this.renderColorbar(scale);
    this.renderKpis(app);
    this.renderStats(app, mode);
  }

  /** @private */
  renderKpis(app) {
    const v = app.val('pack_voltage'), i = app.val('pack_current'), p = app.val('calc_pack_power');
    const nCells = this.model.nCells;
    this.kV.set(num(v, 1), 'V', isNum(v) ? `${num(v / nCells, 3)} V/cell avg` : '', levelOf(app.def('pack_voltage'), v));
    this.kI.set(num(i, 1), 'A', isNum(i) ? (i < -0.5 ? 'charging (regen)' : 'discharge +') : '');
    this.kP.set(num(p, 1), 'kW', isNum(p) ? `limit ${num(vehicleNum(app, 'powertrain.power_limit_kw', 80), 0)} kW` : '', levelOf(app.def('calc_pack_power'), p));
    const soc = app.val('bms_soc');
    this.kSoc.set(num(soc, 1), '%', 'BMS Coulomb count', levelOf(app.def('bms_soc'), soc));
    const st = app.val('bms_state'), fault = app.val('bms_fault');
    const faultTxt = isNum(fault) && fault > 0.5 ? `fault: ${enumLabel(app.def('bms_fault'), fault)}` : 'no BMS fault';
    this.kState.set(enumLabel(app.def('bms_state'), st), '', faultTxt,
      (isNum(fault) && fault > 0.5) || st === 3 ? 'critical' : '');
  }

  /** @private */
  renderStats(app, mode) {
    const m = this.model;
    const cellTag = (k) => (k >= 0 ? `cell ${pad3(k)} · S${Math.floor(k / m.perSeg)}` : '');
    const sensTag = (j) => {
      if (j < 0) return '';
      const [a, b] = m.sensorCells(j);
      return `T${pad2(j)} · cells ${pad3(a)}–${pad3(b - 1)}`;
    };
    if (mode === 't') {
      const s = m.tStats;
      const dMax = app.def('cell_t_00');
      this.sMin.set(num(s.min, 1), '°C', sensTag(s.iMin));
      this.sMax.set(num(s.max, 1), '°C', sensTag(s.iMax), levelOf(dMax, s.max));
      this.sMean.label('Mean');
      this.sMean.set(num(s.mean, 1), '°C', `${s.n}/${m.nSensors} sensors`);
      this.sSpread.set(num(s.max - s.min, 1), 'K', 'max − min');
    } else if (mode === 'dv') {
      const s = m.dvStats;
      this.sMin.set(signed(s.min, 1), 'mV', cellTag(s.iMin));
      this.sMax.set(signed(s.max, 1), 'mV', cellTag(s.iMax));
      let ss = 0, n = 0;
      for (const x of m.dv) if (isNum(x)) { ss += x * x; n++; }
      this.sMean.label('σ (RMS)');
      this.sMean.set(num(n ? Math.sqrt(ss / n) : NaN, 1), 'mV', 'spread around the mean');
      this.sSpread.set(num(s.max - s.min, 0), 'mV', 'max − min');
    } else {
      const s = m.vStats;
      const def = app.def('cell_v_000');
      this.sMin.set(num(s.min, 3), 'V', cellTag(s.iMin), levelOf(def, s.min));
      this.sMax.set(num(s.max, 3), 'V', cellTag(s.iMax), levelOf(def, s.max));
      this.sMean.label('Mean');
      this.sMean.set(num(s.mean, 3), 'V', `${s.n}/${m.nCells} cells`);
      const spread = (s.max - s.min) * 1000;
      this.sSpread.set(num(spread, 0), 'mV', 'max − min', levelOf(app.def('calc_cell_v_delta'), spread));
    }
    const bit = mode === 't' ? 2 : 1;
    const n = m.outlierCount(bit);
    const nAl = m.alerts.size;
    setText(this.outlierText, n || nAl ? `${n} outlier${n === 1 ? '' : 's'} · ${nAl} cell${nAl === 1 ? '' : 's'} in alerts` : 'no outliers');
    setData(this.outlierText, 'level', nAl ? 'critical' : n ? 'warning' : '');
  }

  /** @private colour bar (re-rendered only when the scale changes) */
  renderColorbar(scale) {
    const key = `${scale.mode}|${scale.lo}|${scale.hi}`;
    if (key === this.cbKey) return;
    this.cbKey = key;
    setText(this.cbHead, `${scale.label} (${scale.unit})`);
    const stops = [];
    for (let i = 0; i <= 16; i++) {
      const v = scale.lo + ((scale.hi - scale.lo) * i) / 16;
      stops.push(`${rgbCss(scale.rgb(v))} ${(i / 16) * 100}%`);
    }
    this.cbBar.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    const ticks = [scale.lo, (scale.lo + scale.hi) / 2, scale.hi].map((v, i) => {
      const s = document.createElement('span');
      s.style.left = `${i * 50}%`;
      s.textContent = scale.mode === 'dv' && i === 1 ? 'mean' : scale.fmt(v).replace('-', '−');
      return s;
    });
    this.cbTicks.replaceChildren(...ticks);
  }
}
