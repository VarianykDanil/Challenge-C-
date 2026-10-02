/**
 * @file Small DOM helpers shared by the Powertrain tab modules (`pt_*.js`). They keep the
 * update path cheap: text and attributes are written only when they change, so a 10 Hz
 * refresh never triggers style recalculation or layout for values that stayed the same.
 */

import { formatNumber, isNum, MISSING } from '../lib/format.js';

/**
 * Create an element.
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * A dashboard card with a header (title, optional subtitle, spacer for right-aligned
 * controls).
 * @param {string} cls    extra classes
 * @param {string} title
 * @param {string} [sub]
 * @returns {{card: HTMLElement, head: HTMLElement, sub: HTMLElement}}
 */
export function card(cls, title, sub) {
  const c = el('section', `card ${cls}`);
  const head = el('div', 'card-head');
  const s = el('span', 'card-sub', sub || '');
  head.append(el('h2', 'card-title', title), s, el('span', 'spacer'));
  c.append(head);
  return { card: c, head, sub: s };
}

/** Set `textContent` only when it changed. @param {Element} e @param {string} s */
export function setText(e, s) {
  if (e.textContent !== s) e.textContent = s;
}

/** Set (or remove, for null/'') a data attribute only when it changed. */
export function setData(e, key, value) {
  const v = value === null || value === undefined ? '' : String(value);
  if ((e.dataset[key] || '') !== v) {
    if (v) e.dataset[key] = v; else delete e.dataset[key];
  }
}

/**
 * Format a number or return the missing-value dash.
 * @param {number} v
 * @param {number} decimals
 * @returns {string}
 */
export function num(v, decimals) {
  return isNum(v) ? formatNumber(v, decimals) : MISSING;
}

/** Signed number: "+1.2" / "−0.4" (typographic minus). */
export function signed(v, decimals) {
  if (!isNum(v)) return MISSING;
  const s = formatNumber(Math.abs(v), decimals);
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${s}`;
}

/**
 * A stat tile (label, big value with unit, sub line) built from the shared `.tile` styles.
 * @param {string} label
 * @param {string} [cls]
 * @returns {{root: HTMLElement, label: (text: string) => void,
 *   set: (value: string, unit?: string, sub?: string, level?: string) => void}}
 */
export function tile(label, cls = '') {
  const root = el('div', `tile ${cls}`.trim());
  const value = el('span', 'tile-value', MISSING);
  const v = document.createTextNode(MISSING);
  const unit = el('span', 'unit', '');
  value.replaceChildren(v, unit);
  const sub = el('span', 'tile-sub', ' ');
  const lbl = el('span', 'tile-label', label);
  root.append(lbl, value, sub);
  return {
    root,
    /** Change the label (e.g. when a card switches mode). @param {string} text */
    label(text) { setText(lbl, text); },
    set(text, u = '', s = ' ', level = '') {
      if (v.data !== text) v.data = text;
      setText(unit, u);
      setText(sub, s || ' ');
      setData(root, 'level', level);
    },
  };
}

/** Severity of a value against its channel's warn/crit thresholds - shared with the Overview. */
export { levelOf } from './overview.js';

/**
 * Enum label from the channel catalogue (`meta.enum`), e.g. inv_state 3 → "driving".
 * @param {object|undefined} def
 * @param {number} v
 * @returns {string}
 */
export function enumLabel(def, v) {
  if (!isNum(v)) return MISSING;
  const e = def && def.meta && def.meta.enum;
  const key = String(Math.round(v));
  return (e && (e[key] ?? e[Number(key)])) || `code ${key}`;
}

/**
 * Read a dotted path from the vehicle dict with a default, e.g.
 * `vehicleNum(app, 'powertrain.motor.derate_start_c', 110)`.
 * @param {object} app
 * @param {string} path
 * @param {number} fallback
 * @returns {number}
 */
export function vehicleNum(app, path, fallback) {
  let o = app.meta && app.meta.vehicle;
  for (const k of path.split('.')) {
    if (!o || typeof o !== 'object') return fallback;
    o = o[k];
  }
  return isNum(o) ? o : fallback;
}

/**
 * A compact key-value row (label left, value + unit right) for dense read-out lists.
 * @param {string} label
 * @param {string} [title]  tooltip explaining the quantity
 * @returns {{root: HTMLElement, set: (value: string, unit?: string, level?: string, hint?: string) => void}}
 */
export function kv(label, title) {
  const root = el('div', 'pt-kv');
  if (title) root.title = title;
  const v = el('b', 'num', MISSING);
  const u = el('span', 'unit', '');
  const hint = el('span', 'hint', '');
  root.append(el('span', 'lbl', label), hint, v, u);
  return {
    root,
    set(value, unit = '', level = '', h = '') {
      setText(v, value);
      setText(u, unit);
      setText(hint, h);
      setData(root, 'level', level);
    },
  };
}
