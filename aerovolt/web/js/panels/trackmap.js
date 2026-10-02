/**
 * @file Live track map: the circuit outline (from `hello.track.xy`), the car's GPS position
 * and heading, the start/finish line, and a trail of the last laps coloured by a selectable
 * channel (speed, downforce, pack power or hottest cell temperature).
 *
 * Coordinates
 * -----------
 * The track outline arrives in the *track frame* (x = metres east, y = metres north of
 * `track.origin`). GPS fixes are projected into the same frame with exactly the local
 * tangent-plane (equirectangular, WGS-84) projection of `aerovolt/core/geo.py`:
 *
 *     M(φ0) = a(1 − e²) / (1 − e² sin²φ0)^(3/2)      meridional radius
 *     N(φ0) = a / (1 − e² sin²φ0)^(1/2)              prime-vertical radius
 *     x = (λ − λ0) · N · cos φ0,   y = (φ − φ0) · M  (angles in radians)
 *
 * so the car sits on the drawn outline to well under GPS noise. North is up on screen.
 *
 * Usage: `const map = new TrackMap(hostEl, {channel: 'speed'}); map.update(app)` every frame
 * (it throttles itself); `map.setChannel('power')`; the colour legend is rendered by the
 * caller with {@link TrackMap#legendOptions}.
 */

import { Chart, theme } from '../lib/charts.js';
import { diverging, sequential, rgbCss } from '../lib/colormap.js';
import { isNum, niceTicks } from '../lib/format.js';

/** WGS-84 semi-major axis [m] and first eccentricity squared (as core/geo.py). */
const WGS84_A_M = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

/**
 * Metres per degree of latitude and longitude at latitude `latDeg` (WGS-84 radii).
 * @param {number} latDeg
 * @returns {[number, number]} [m per deg lat, m per deg lon]
 */
export function metresPerDegree(latDeg) {
  const phi = (latDeg * Math.PI) / 180;
  const w = 1 - WGS84_E2 * Math.sin(phi) ** 2;
  const meridional = (WGS84_A_M * (1 - WGS84_E2)) / w ** 1.5;
  const primeVertical = WGS84_A_M / Math.sqrt(w);
  const deg = Math.PI / 180;
  return [meridional * deg, primeVertical * Math.cos(phi) * deg];
}

/**
 * GPS (lat, lon) [deg] → track frame (x east, y north) [m] around `origin` (core/geo.py).
 * @param {number} lat
 * @param {number} lon
 * @param {{lat: number, lon: number}} origin
 * @returns {[number, number]}
 */
export function latLonToXY(lat, lon, origin) {
  const [mLat, mLon] = metresPerDegree(origin.lat);
  return [(lon - origin.lon) * mLon, (lat - origin.lat) * mLat];
}

/**
 * Trail colouring choices. `kind: 'diverging'` is used for pack power so that regen
 * (negative) and discharge (positive) read as opposites around a neutral 0 kW.
 */
export const TRAIL_CHANNELS = Object.freeze({
  speed: { id: 'gps_speed', label: 'Speed', unit: 'km/h', scale: 3.6, kind: 'sequential', ramp: 'blue', floor: 0 },
  downforce: { id: 'calc_downforce', label: 'Downforce', unit: 'N', scale: 1, kind: 'sequential', ramp: 'green', floor: 0 },
  power: { id: 'calc_pack_power', label: 'Pack power', unit: 'kW', scale: 1, kind: 'diverging' },
  cellt: { id: 'calc_cell_t_max', label: 'Cell T max', unit: '°C', scale: 1, kind: 'sequential', ramp: 'heat' },
});

/** Canvas track map (a {@link Chart}, so it gets HiDPI, resize and the shared render loop). */
export class TrackMap extends Chart {
  /**
   * @param {HTMLElement} host
   * @param {{channel?: keyof TRAIL_CHANNELS, trailSeconds?: number}} [opts]
   */
  constructor(host, opts = {}) {
    super(host, { title: 'Track map with live car position' });
    this.channel = opts.channel || 'speed';
    this.trailSeconds = opts.trailSeconds ?? 120;
    this.track = null;
    this.origin = null;
    /** trail in track frame */
    this.trail = { x: new Float64Array(0), y: new Float64Array(0), v: new Float64Array(0) };
    this.car = null;
    this.range = [0, 1];
    this._pullAcc = Infinity;
    this._lastT = NaN;
    this._view = null;
  }

  /** Select the trail colouring channel (key of {@link TRAIL_CHANNELS}). */
  setChannel(key) {
    if (!TRAIL_CHANNELS[key]) return;
    this.channel = key;
    this._pullAcc = Infinity;
    this.dirty = true;
  }

  /** Current trail value range (after nice rounding) and colouring info for a legend. */
  legendOptions() {
    const c = TRAIL_CHANNELS[this.channel];
    const [a, b] = this.range;
    return {
      kind: c.kind, ramp: c.ramp, vmin: a, vmax: b, label: c.label, unit: c.unit,
      lowLabel: c.kind === 'diverging' ? 'regen' : '', highLabel: c.kind === 'diverging' ? 'discharge' : '',
      format: (v) => String(Math.round(v)).replace('-', '−'),
    };
  }

  /** Set the circuit from `hello.track` (null for an unknown track: the trail alone is drawn). */
  setTrack(track, fallbackOrigin) {
    this.track = track && Array.isArray(track.xy) && track.xy.length > 1 ? track : null;
    this.origin = (track && track.origin) || fallbackOrigin || null;
    this._view = null;
    this.dirty = true;
  }

  /**
   * Pull the latest position (every call) and the trail (5 Hz) from the app.
   * @param {object} app
   * @param {number} dtMs
   */
  update(app, dtMs = 16) {
    if (!this.origin) {
      const lat = app.val('gps_lat'), lon = app.val('gps_lon');
      if (isNum(lat) && isNum(lon)) this.origin = { lat, lon };
      else return;
    }
    if (app.t !== this._lastT) {
      this._lastT = app.t;
      const lat = app.val('gps_lat'), lon = app.val('gps_lon');
      if (isNum(lat) && isNum(lon)) {
        const [x, y] = latLonToXY(lat, lon, this.origin);
        this.car = { x, y, heading: app.val('gps_heading'), stale: app.status('gps_lat') !== 'live' };
      } else {
        this.car = null;
      }
      this.dirty = true;
    }
    this._pullAcc += dtMs;
    if (this._pullAcc >= 200) {
      this._pullAcc = 0;
      this.pullTrail(app);
    }
  }

  /** @private */
  pullTrail(app) {
    const c = TRAIL_CHANNELS[this.channel];
    const lat = app.hist.series('gps_lat', this.trailSeconds);
    const lon = app.hist.series('gps_lon', this.trailSeconds);
    const val = app.hist.series(c.id, this.trailSeconds);
    const n = Math.min(lat.v.length, lon.v.length, val.v.length);
    const x = new Float64Array(n), y = new Float64Array(n), v = new Float64Array(n);
    const [mLat, mLon] = metresPerDegree(this.origin.lat);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) {
      x[k] = (lon.v[k] - this.origin.lon) * mLon;
      y[k] = (lat.v[k] - this.origin.lat) * mLat;
      v[k] = val.v[k] * c.scale;
      if (isNum(v[k])) { if (v[k] < lo) lo = v[k]; if (v[k] > hi) hi = v[k]; }
    }
    this.trail = { x, y, v };
    if (isFinite(lo) && isFinite(hi)) {
      if (isNum(c.floor)) lo = Math.min(lo, c.floor);
      if (hi - lo < 1e-6) hi = lo + 1;
      const { step } = niceTicks(lo, hi, 4);
      let a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
      if (c.kind === 'diverging') { a = Math.min(a, -step); b = Math.max(b, step); }
      this.range = [a, b];
    }
    this.dirty = true;
  }

  colorFor(v) {
    const c = TRAIL_CHANNELS[this.channel];
    const [a, b] = this.range;
    return c.kind === 'diverging' ? diverging(v, a, b) : sequential(v, a, b, c.ramp);
  }

  /** @private screen transform fitted to the outline (or the trail) */
  view(w, h) {
    const key = `${w}x${h}`;
    if (this._view && this._view.key === key && this.track) return this._view;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    const add = (x, y) => {
      if (!isNum(x) || !isNum(y)) return;
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    };
    if (this.track) for (const [x, y] of this.track.xy) add(x, y);
    else {
      const { x, y } = this.trail;
      for (let k = 0; k < x.length; k++) add(x[k], y[k]);
      if (this.car) add(this.car.x, this.car.y);
    }
    if (!isFinite(xmin)) { xmin = -50; xmax = 50; ymin = -50; ymax = 50; }
    const pad = 18;
    const sx = (w - pad * 2) / Math.max(10, xmax - xmin);
    const sy = (h - pad * 2) / Math.max(10, ymax - ymin);
    const s = Math.min(sx, sy);
    const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    this._view = { key, s, tx: (x) => w / 2 + (x - cx) * s, ty: (y) => h / 2 - (y - cy) * s };
    return this._view;
  }

  paint(ctx, w, h) {
    const t = theme();
    const { s, tx, ty } = this.view(w, h);
    // asphalt band + edge
    if (this.track) {
      const path = new Path2D();
      this.track.xy.forEach(([x, y], k) => (k ? path.lineTo(tx(x), ty(y)) : path.moveTo(tx(x), ty(y))));
      if (this.track.closed) path.closePath();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#2b333e';
      ctx.lineWidth = Math.max(9, 7 * s);
      ctx.stroke(path);
      ctx.strokeStyle = '#1a2028';
      ctx.lineWidth = Math.max(6, 7 * s) - 3;
      ctx.stroke(path);
      // start / finish line: a chequered bar across the track
      const st = this.track.start;
      if (st && isNum(st.x)) {
        const hd = ((st.heading_deg || 0) * Math.PI) / 180;
        const dx = Math.sin(hd), dy = Math.cos(hd); // direction of travel (east, north)
        const px = -dy, py = dx; // perpendicular
        const half = Math.max(7, 5 * s) / s;
        const x0 = tx(st.x + px * half), y0 = ty(st.y + py * half);
        const x1 = tx(st.x - px * half), y1 = ty(st.y - py * half);
        const n = 6;
        for (let k = 0; k < n; k++) {
          ctx.strokeStyle = k % 2 ? '#0b0e12' : '#f2f4f7';
          ctx.lineWidth = 4;
          ctx.lineCap = 'butt';
          ctx.beginPath();
          ctx.moveTo(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
          ctx.lineTo(x0 + ((x1 - x0) * (k + 1)) / n, y0 + ((y1 - y0) * (k + 1)) / n);
          ctx.stroke();
        }
        ctx.font = this.font(0.72, 700);
        ctx.fillStyle = t.text2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lx = tx(st.x + px * half * 2.6), ly = ty(st.y + py * half * 2.6);
        ctx.fillText('S/F', lx, ly);
      }
    }
    // trail: coloured segments (gaps > 15 m are not joined)
    const { x, y, v } = this.trail;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(3, Math.min(5, 3.5 * s));
    for (let k = 1; k < x.length; k++) {
      if (!isNum(x[k]) || !isNum(x[k - 1]) || !isNum(v[k])) continue;
      const ddx = x[k] - x[k - 1], ddy = y[k] - y[k - 1];
      if (ddx * ddx + ddy * ddy > 225) continue;
      ctx.strokeStyle = rgbCss(this.colorFor(v[k]));
      ctx.beginPath();
      ctx.moveTo(tx(x[k - 1]), ty(y[k - 1]));
      ctx.lineTo(tx(x[k]), ty(y[k]));
      ctx.stroke();
    }
    // car
    if (this.car) {
      const cx = tx(this.car.x), cy = ty(this.car.y);
      if (isNum(this.car.heading)) {
        const hd = (this.car.heading * Math.PI) / 180;
        const ux = Math.sin(hd), uy = -Math.cos(hd);
        ctx.fillStyle = t.text1;
        ctx.beginPath();
        ctx.moveTo(cx + ux * 15, cy + uy * 15);
        ctx.lineTo(cx + ux * 6 - uy * 5.5, cy + uy * 6 + ux * 5.5);
        ctx.lineTo(cx + ux * 6 + uy * 5.5, cy + uy * 6 - ux * 5.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(57,135,229,0.22)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fillStyle = this.car.stale ? t.text3 : t.text1;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = this.car.stale ? t.status.warning : t.series[0];
      ctx.stroke();
    } else {
      ctx.font = this.font(0.9);
      ctx.fillStyle = t.text3;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No GPS fix', w / 2, h / 2);
    }
    // north arrow + scale bar
    ctx.font = this.font(0.72, 600);
    ctx.fillStyle = t.text3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', w - 14, 4);
    ctx.strokeStyle = t.text3;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(w - 14, 30); ctx.lineTo(w - 14, 17); ctx.lineTo(w - 18, 22); ctx.moveTo(w - 14, 17); ctx.lineTo(w - 10, 22); ctx.stroke();
    const target = 70 / s;
    const mag = 10 ** Math.floor(Math.log10(target));
    const len = [1, 2, 5, 10].map((m) => m * mag).reduce((p, c) => (c <= target ? c : p), mag);
    const bx = 8, by = h - 10;
    ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + len * s, by); ctx.lineTo(bx + len * s, by - 4); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${len} m`, bx + len * s + 5, by + 2);
  }
}
