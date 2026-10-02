/**
 * @file Dashboard shell: hash router, the single requestAnimationFrame loop, the header
 * read-outs, keyboard shortcuts and the drawers (alerts, fault injection).
 *
 * Routing: `#overview`, `#aero`, `#powertrain`, `#sensors`, `#laps`; a tab may take query
 * parameters after `?` (e.g. `#sensors?ch=cell_t_20,cool_flow&label=Cell%20over-temperature`),
 * which are passed to the panel's optional `route(params)` export.
 *
 * Panels are ES modules loaded on first visit with `mount(rootEl, app)` and then
 * `update(app, dtMs)` every animation frame while visible (SPEC §10). After the panels,
 * {@link renderCharts} redraws every chart that changed - one loop for the whole page.
 *
 * UI helpers for panels are published as `app.ui`:
 * `app.ui.navigate(tab, params?)`, `app.ui.openDrawer('alerts'|'faults')`,
 * `app.ui.closeDrawers()`, `app.ui.toast({title, detail?, sev?: 'info'|'warn'|'critical'|'error'})`.
 */

import { app } from './app.js';
import { renderCharts } from './lib/charts.js';
import { formatLapTime, formatNumber, isNum } from './lib/format.js';
import * as alerts from './panels/alerts.js';
import * as faults from './panels/faults.js';

/** Tab ids in keyboard order (keys 1…5). */
export const TABS = ['overview', 'aero', 'powertrain', 'sensors', 'laps'];

const $ = (sel) => document.querySelector(sel);

/** @type {Map<string, {mod: any, root: HTMLElement, errors: number}>} */
const mounted = new Map();
/** @type {Map<string, Promise<void>>} */
const loading = new Map();
let current = '';
let currentParams = new URLSearchParams();
let started = false;

/* ================================================================== routing */

/**
 * Parse `location.hash` into a tab id and query parameters.
 * @returns {{tab: string, params: URLSearchParams}}
 */
function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [name, query = ''] = raw.split('?');
  return { tab: TABS.includes(name) ? name : 'overview', params: new URLSearchParams(query) };
}

/**
 * Go to a tab (updates the URL hash, which triggers the router).
 * @param {string} tab
 * @param {Record<string, string>|URLSearchParams} [params]
 */
function navigate(tab, params) {
  const q = params ? new URLSearchParams(params).toString() : '';
  const hash = `#${tab}${q ? `?${q}` : ''}`;
  if (location.hash === hash) route(); else location.hash = hash;
}

/** Show the tab from the hash; mount its panel on first visit. */
function route() {
  const { tab, params } = parseHash();
  current = tab;
  currentParams = params;
  for (const a of document.querySelectorAll('#tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
  document.title = `AeroVolt · ${tab[0].toUpperCase()}${tab.slice(1)}`;
  if (started) ensureMounted(tab).then(() => applyRoute(tab, params));
}

function applyRoute(tab, params) {
  const m = mounted.get(tab);
  if (m && m.mod.route && tab === current) {
    try { m.mod.route(params, app); } catch (err) { console.error(`[${tab}] route failed`, err); }
  }
}

/**
 * Import and mount a panel once.
 * @param {string} tab
 * @returns {Promise<void>}
 */
function ensureMounted(tab) {
  if (mounted.has(tab)) return Promise.resolve();
  if (loading.has(tab)) return loading.get(tab);
  const root = /** @type {HTMLElement} */ (document.querySelector(`.view[data-view="${tab}"]`));
  root.innerHTML = '<div class="card loading-card"><div class="spinner"></div><h2>Loading…</h2></div>';
  const p = import(`./panels/${tab}.js`).then((mod) => {
    root.replaceChildren();
    mod.mount(root, app);
    root.dataset.mounted = 'true';
    mounted.set(tab, { mod, root, errors: 0 });
  }).catch((err) => {
    console.error(`[${tab}] failed to load`, err);
    root.dataset.mounted = 'error';
    root.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card loading-card';
    const h = document.createElement('h2');
    h.textContent = `The ${tab} view failed to load`;
    const p2 = document.createElement('p');
    p2.textContent = String(err && err.message ? err.message : err);
    card.append(h, p2);
    root.append(card);
  }).finally(() => loading.delete(tab));
  loading.set(tab, p);
  return p;
}

/* ================================================================== drawers */

/** @type {'alerts'|'faults'|null} */
let openName = null;

/**
 * Open a slide-out drawer (closing the other one).
 * @param {'alerts'|'faults'} name
 */
function openDrawer(name) {
  if (name === 'faults' && !faults.available(app)) {
    toast({ title: 'Fault injection unavailable', detail: 'It needs the simulator (SIM or HYBRID mode).', sev: 'info' });
    return;
  }
  closeDrawers(false);
  const el = $(`#drawer-${name}`);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  openName = name;
  (name === 'alerts' ? alerts : faults).onOpen(app);
  const focusable = el.querySelector('button, input');
  if (focusable) focusable.focus({ preventScroll: true });
}

/** Close any open drawer. */
function closeDrawers(restoreFocus = true) {
  for (const el of document.querySelectorAll('.drawer.open')) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
  }
  $('#scrim').hidden = true;
  if (restoreFocus && openName) $(`#btn-${openName}`).focus({ preventScroll: true });
  openName = null;
}

function toggleDrawer(name) {
  if (openName === name) closeDrawers(); else openDrawer(name);
}

/* ================================================================== toasts */

/**
 * Show a toast in the bottom-right corner.
 * @param {{title: string, detail?: string, sev?: 'info'|'warn'|'critical'|'error', ttl?: number,
 *          onClick?: () => void}} t
 * @returns {HTMLElement}
 */
function toast(t) {
  return alerts.showToast(t);
}

/* ================================================================== header */

let headerAcc = 0;

function updateHeader() {
  const badge = $('#mode-badge');
  if (badge.dataset.mode !== app.mode) {
    badge.dataset.mode = app.mode;
    badge.textContent = app.mode;
    badge.title = {
      SIM: 'Simulator only (demo mode)',
      LIVE: 'Real sensors only',
      HYBRID: 'Real sensors override the simulator',
      REPLAY: 'Replaying a log file',
    }[app.mode] || 'Data source mode';
  }
  const conn = $('#conn');
  const text = conn.querySelector('.conn-text');
  const c = app.connection;
  let state = c.state, label;
  if (state === 'open') {
    const age = app.dataAge();
    if (age > 2) { state = 'stalled'; label = isFinite(age) ? `No data ${Math.round(age)} s` : 'Waiting for data'; } else {
      label = `Live · ${formatNumber(app.frameHz, 0)} Hz`;
    }
  } else if (state === 'connecting') {
    label = 'Connecting…';
  } else {
    const s = Math.max(0, Math.ceil((c.retryAt - performance.now()) / 1000));
    label = `Offline · retry ${s} s`;
  }
  conn.dataset.state = state;
  if (text.textContent !== label) text.textContent = label;
  conn.title = state === 'closed' ? `Server connection lost (${c.error}). Reconnecting automatically.` : label;

  const lap = app.val('calc_lap');
  setText('#h-lap', isNum(lap) ? (lap < 1 ? 'Out' : formatNumber(lap, 0)) : '—');
  setText('#h-laptime', formatLapTime(app.val('calc_lap_time'), 1));
  const v = app.val('gps_speed');
  setText('#h-speed', isNum(v) ? `${formatNumber(v * 3.6, 0)} km/h` : '—');
  let soc = app.val('calc_soc_ekf');
  if (!isNum(soc)) soc = app.val('bms_soc');
  setText('#h-soc', isNum(soc) ? `${formatNumber(soc, 1)} %` : '—');

  // alerts button: count + worst severity
  let level = 'none';
  const rank = { none: 0, info: 1, warn: 2, critical: 3 };
  for (const a of app.alerts.values()) if ((rank[a.severity] || 0) > rank[level]) level = a.severity;
  const btn = $('#btn-alerts');
  if (btn.dataset.level !== level) btn.dataset.level = level;
  setText('#alerts-count', String(app.alerts.size));
  btn.title = `${app.alerts.size} active alert${app.alerts.size === 1 ? '' : 's'} (A)`;

  const fbtn = $('#btn-faults');
  const avail = faults.available(app);
  fbtn.hidden = !avail;
  const nActive = (app.faults || []).filter((f) => f.active).length;
  const fc = $('#faults-count');
  fc.hidden = nActive === 0;
  setText('#faults-count', String(nActive));
}

function setText(sel, s) {
  const el = $(sel);
  if (el && el.textContent !== s) el.textContent = s;
}

/* ================================================================== main loop */

let last = performance.now();

function frame(now) {
  const dt = Math.min(250, now - last);
  last = now;
  headerAcc += dt;
  if (headerAcc >= 100) {
    headerAcc = 0;
    updateHeader();
  }
  const m = mounted.get(current);
  if (m && app.meta) {
    try {
      m.mod.update(app, dt);
    } catch (err) {
      m.errors++;
      if (m.errors <= 3) console.error(`[${current}] update failed`, err);
    }
  }
  if (openName === 'alerts') alerts.update(app, dt);
  else if (openName === 'faults') faults.update(app, dt);
  renderCharts();
  requestAnimationFrame(frame);
}

/* ================================================================== keyboard */

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key >= '1' && e.key <= '5') {
    navigate(TABS[Number(e.key) - 1]);
    e.preventDefault();
  } else if (e.key === 'f' || e.key === 'F') {
    toggleDrawer('faults');
    e.preventDefault();
  } else if (e.key === 'a' || e.key === 'A') {
    toggleDrawer('alerts');
    e.preventDefault();
  } else if (e.key === 'Escape') {
    closeDrawers();
  }
}

/* ================================================================== start */

function onFirstHello() {
  if (started) return;
  started = true;
  const splash = $('#splash');
  splash.classList.add('hide');
  setTimeout(() => splash.remove(), 400);
  ensureMounted(current).then(() => applyRoute(current, currentParams));
}

function init() {
  app.ui = { navigate, openDrawer, closeDrawers, toast };
  alerts.init($('#drawer-alerts'), app);
  faults.init($('#drawer-faults'), app);
  $('#btn-alerts').addEventListener('click', () => toggleDrawer('alerts'));
  $('#btn-faults').addEventListener('click', () => toggleDrawer('faults'));
  $('#scrim').addEventListener('click', () => closeDrawers());
  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', onKey);
  app.on('connection', (c) => {
    const st = $('#splash-text');
    if (st && c.state === 'closed') st.textContent = 'Cannot reach the telemetry server - retrying…';
  });
  app.on('hello', onFirstHello);
  app.on('faults', () => {
    if (openName === 'faults' && !faults.available(app)) closeDrawers();
  });
  route();
  app.start();
  requestAnimationFrame(frame);
}

init();
