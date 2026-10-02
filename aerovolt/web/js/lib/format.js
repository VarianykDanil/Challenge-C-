/**
 * @file Number, unit and time formatting helpers shared by every panel.
 *
 * Precision follows the channel catalogue: a channel's `resolution` (its quantisation step,
 * e.g. 0.1 Pa or 0.001 V) decides how many decimals are meaningful. Showing more digits than
 * the sensor resolves would be false precision; showing fewer would hide real changes.
 *
 * All functions are pure (no DOM, no app state) so they can be unit-tested in isolation.
 */

/** The string shown for a missing / invalid value (null, undefined, NaN, ±Infinity). */
export const MISSING = '—';

/** Units that are not printed after the number (they are not physical units). */
const SILENT_UNITS = new Set(['', '-', 'enum', 'bool']);

/**
 * True when `v` is a finite number (null / undefined / NaN / ±Infinity are "missing").
 * @param {unknown} v
 * @returns {v is number}
 */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Number of decimals needed to show a quantity quantised to `resolution`.
 *
 * decimals = ceil(−log10(resolution)), clamped to 0…8. Examples: 1 → 0, 0.5 → 1, 0.1 → 1,
 * 0.01 → 2, 0.002 → 3, 1e-7 → 7. A resolution of 0 (unknown, e.g. simulator truth) returns
 * `null`, meaning "use significant figures instead".
 * @param {number} resolution  quantisation step (> 0), or 0 when unknown
 * @returns {number|null}
 */
export function decimalsFor(resolution) {
  if (!isNum(resolution) || resolution <= 0) return null;
  const d = Math.ceil(-Math.log10(resolution) - 1e-9);
  return Math.min(8, Math.max(0, d));
}

/**
 * Format a number with a fixed number of decimals, or with `sig` significant figures when
 * `decimals` is null. Uses a real minus sign (U+2212) like engineering print.
 * @param {number|null|undefined} v
 * @param {number|null} [decimals=null]
 * @param {number} [sig=4]  significant figures when `decimals` is null
 * @returns {string}
 */
export function formatNumber(v, decimals = null, sig = 4) {
  if (!isNum(v)) return MISSING;
  let s;
  if (decimals === null || decimals === undefined) {
    if (v === 0) return '0';
    const mag = Math.floor(Math.log10(Math.abs(v)));
    const d = Math.min(8, Math.max(0, sig - 1 - mag));
    s = v.toFixed(d);
  } else {
    s = v.toFixed(decimals);
  }
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1); // "-0.0" → "0.0"
  return s.replace('-', '−');
}

/**
 * Format a value with its unit: "412.5 Pa", "3.912 V", "64.2 %". Units in
 * {@link SILENT_UNITS} are omitted. A thin no-break space separates number and unit (SI style).
 * @param {number|null|undefined} v
 * @param {string} unit
 * @param {number|null} [decimals=null]
 * @returns {string}
 */
export function withUnit(v, unit, decimals = null) {
  const s = formatNumber(v, decimals);
  if (s === MISSING || SILENT_UNITS.has(unit || '')) return s;
  return `${s} ${unit}`;
}

/**
 * Human label for a boolean channel value, chosen from the channel id so that safety flags
 * read naturally: `*_ok` → OK/FAULT, `*_closed` → closed/open, `*_done` → done/pending.
 * @param {string} id
 * @param {number} v  0 or 1
 * @returns {string}
 */
export function boolLabel(id, v) {
  const on = v >= 0.5;
  if (id.endsWith('_ok')) return on ? 'OK' : 'FAULT';
  if (id.endsWith('_closed')) return on ? 'closed' : 'open';
  if (id.endsWith('_done')) return on ? 'done' : 'pending';
  return on ? 'on' : 'off';
}

/**
 * Format a channel value using its catalogue definition: enum labels (`meta.enum`),
 * boolean labels, otherwise number + unit with decimals from `resolution`.
 * @param {{id: string, unit: string, resolution: number, meta?: object}} def  ChannelDef
 * @param {number|null|undefined} v
 * @param {{unit?: boolean}} [opts]  `unit: false` omits the unit
 * @returns {string}
 */
export function formatChannel(def, v, opts = {}) {
  if (!isNum(v)) return MISSING;
  if (!def) return formatNumber(v);
  if (def.unit === 'enum') {
    const labels = def.meta && def.meta.enum;
    const key = String(Math.round(v));
    return labels && key in labels ? labels[key] : key;
  }
  if (def.unit === 'bool') return boolLabel(def.id, v);
  const dec = decimalsFor(def.resolution);
  return opts.unit === false ? formatNumber(v, dec) : withUnit(v, def.unit, dec);
}

/**
 * Lap-time style duration: 63.456 → "1:03.456", 9.5 → "9.500", with `decimals` digits.
 * @param {number|null|undefined} seconds
 * @param {number} [decimals=3]
 * @returns {string}
 */
export function formatLapTime(seconds, decimals = 3) {
  if (!isNum(seconds)) return MISSING;
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const scale = 10 ** decimals;
  s = Math.round(s * scale) / scale;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const body = m > 0
    ? `${m}:${rest.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}`
    : rest.toFixed(decimals);
  return (neg ? '−' : '') + body;
}

/**
 * Session clock: 3725.4 → "1:02:05", 65 → "1:05".
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  if (!isNum(seconds)) return MISSING;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Signed delta with explicit sign: +0.42, −1.30 (U+2212). Zero prints as ±0.00.
 * @param {number|null|undefined} v
 * @param {number} [decimals=2]
 * @param {string} [unit='']
 * @returns {string}
 */
export function formatDelta(v, decimals = 2, unit = '') {
  if (!isNum(v)) return MISSING;
  const r = Number(v.toFixed(decimals));
  const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
  const body = Math.abs(r).toFixed(decimals);
  return unit ? `${sign}${body} ${unit}` : `${sign}${body}`;
}

/**
 * Compact magnitude for large counts: 1284 → "1,284", 12900 → "12.9K", 4.2e6 → "4.2M".
 * @param {number|null|undefined} v
 * @returns {string}
 */
export function formatCompact(v) {
  if (!isNum(v)) return MISSING;
  const a = Math.abs(v);
  if (a >= 1e9) return formatNumber(v / 1e9, a >= 1e10 ? 0 : 1) + 'G';
  if (a >= 1e6) return formatNumber(v / 1e6, a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return formatNumber(v / 1e3, a >= 1e5 ? 0 : 1) + 'K';
  if (Number.isInteger(v)) return v.toLocaleString('en-GB').replace('-', '−');
  return formatNumber(v, null, 3);
}

/** m/s → km/h (× 3.6). NaN-safe. @param {number} ms @returns {number} */
export const kmh = (ms) => (isNum(ms) ? ms * 3.6 : NaN);

/**
 * "Nice" axis ticks (1, 2, 2.5, 5 × 10^n steps) covering [min, max].
 * @param {number} min
 * @param {number} max
 * @param {number} [target=5]  approximate number of ticks wanted
 * @returns {{ticks: number[], step: number, decimals: number}}
 */
export function niceTicks(min, max, target = 5) {
  if (!isNum(min) || !isNum(max) || max <= min) {
    const v = isNum(min) ? min : 0;
    return { ticks: [v], step: 1, decimals: 0 };
  }
  const raw = (max - min) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm < 1.5 ? 1 : norm < 2.25 ? 2 : norm < 3.5 ? 2.5 : norm < 7.5 ? 5 : 10;
  const step = mult * mag;
  const first = Math.ceil(min / step - 1e-9) * step;
  const ticks = [];
  for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (mult === 2.5 ? 1 : 0));
  return { ticks, step, decimals: Math.min(decimals, 8) };
}

/**
 * Escape text for safe insertion into HTML (prefer `textContent`; use this only for
 * templated markup that contains data).
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Clamp `v` into [lo, hi]. @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
