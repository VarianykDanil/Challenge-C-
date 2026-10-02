/**
 * @file Alerts: the slide-out drawer (active alerts + full history log), toasts for newly
 * raised warning / critical alerts, and small helpers other panels reuse (severity pill,
 * jump-to-Sensors).
 *
 * An alert (SPEC §9) is `{id, rule, severity: 'info'|'warn'|'critical', title, detail,
 * channels[], t_start, t_end, active}`. Clicking an alert's channels opens the Sensors tab
 * filtered to exactly those channels, which is how a mechanic gets from "Cell
 * over-temperature" to the reading of temperature sensor 20 in one click.
 *
 * Exports used by main.js: `init(drawerEl, app)`, `onOpen(app)`, `update(app, dtMs)`,
 * `showToast(t)`; by other panels: `sevPill`, `jumpToChannels`, `alertAge`, `SEVERITY_RANK`.
 */

import { formatClock, isNum } from '../lib/format.js';

/** Severity order for sorting / "worst of". */
export const SEVERITY_RANK = Object.freeze({ info: 1, warn: 2, critical: 3 });

const ICONS = {
  critical: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="currentColor" opacity=".25"/><path d="M12 7v6M12 16.5v.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20z" fill="currentColor" opacity=".25"/><path d="M12 9v5M12 17.5v.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".25"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".25"/><path d="m7.5 12.5 3 3 6-6.5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cleared: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.5 12.5 3 3 6-6.5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const SEV_LABEL = { critical: 'Critical', warn: 'Warning', info: 'Info', ok: 'Nominal', cleared: 'Cleared' };

/**
 * Severity pill element: icon + label (never colour alone).
 * @param {'critical'|'warn'|'info'|'ok'|'cleared'} sev
 * @param {string} [label]  overrides the default label
 * @returns {HTMLSpanElement}
 */
export function sevPill(sev, label) {
  const s = document.createElement('span');
  s.className = 'sev';
  s.dataset.sev = sev;
  s.innerHTML = ICONS[sev] || ICONS.info;
  s.append(document.createTextNode(label || SEV_LABEL[sev] || sev));
  return s;
}

/**
 * Open the Sensors tab filtered to `channels`.
 * @param {object} app
 * @param {string[]} channels
 * @param {string} [label]  shown on the filter chip (e.g. the alert title)
 */
export function jumpToChannels(app, channels, label) {
  if (!channels || !channels.length) return;
  app.ui.closeDrawers(false);
  app.ui.navigate('sensors', { ch: channels.join(','), label: label || '' });
}

/**
 * "for 1:05" (active) or "lasted 0:12" (cleared), in session time.
 * @param {object} a  alert
 * @param {number} now  session time
 * @returns {string}
 */
export function alertAge(a, now) {
  if (a.active) return isNum(now) && isNum(a.t_start) ? `for ${formatClock(now - a.t_start)}` : '';
  return isNum(a.t_end) && isNum(a.t_start) ? `lasted ${formatClock(a.t_end - a.t_start)}` : '';
}

/* ================================================================== drawer */

let drawer = null;
let body = null;
let tabActive = null;
let tabHistory = null;
let view = 'active';
let dirty = true;
let ageAcc = 0;

/**
 * Build the drawer and subscribe to alert events (called once by main.js).
 * @param {HTMLElement} el  the drawer element
 * @param {object} app
 */
export function init(el, app) {
  drawer = el;
  el.innerHTML = `
    <div class="drawer-head">
      <h2>Alerts</h2>
      <span class="card-sub" data-role="summary"></span>
      <span class="spacer"></span>
      <button class="icon-btn" type="button" data-role="close" aria-label="Close alerts">×</button>
    </div>
    <div class="drawer-sub">
      <div class="seg" role="group" aria-label="Alert list">
        <button type="button" data-view="active" aria-pressed="true">Active<span class="count" data-role="n-active">0</span></button>
        <button type="button" data-view="history" aria-pressed="false">History<span class="count" data-role="n-history">0</span></button>
      </div>
    </div>
    <div class="drawer-body" data-role="body"></div>`;
  body = el.querySelector('[data-role="body"]');
  tabActive = el.querySelector('[data-view="active"]');
  tabHistory = el.querySelector('[data-view="history"]');
  el.querySelector('[data-role="close"]').addEventListener('click', () => app.ui.closeDrawers());
  for (const b of [tabActive, tabHistory]) {
    b.addEventListener('click', () => {
      view = b.dataset.view;
      tabActive.setAttribute('aria-pressed', String(view === 'active'));
      tabHistory.setAttribute('aria-pressed', String(view === 'history'));
      dirty = true;
      render(app);
    });
  }
  const mark = () => { dirty = true; };
  app.on('alert', (a) => { mark(); onAlertEvent(app, a); });
  app.on('alertlog', mark);
  app.on('hello', () => { mark(); clearToasts(); });
}

/** Drawer opened: render immediately. */
export function onOpen(app) {
  dirty = true;
  render(app);
}

/** Per-frame update while the drawer is open (re-renders on change, ages every second). */
export function update(app, dtMs) {
  ageAcc += dtMs;
  if (dirty) render(app);
  else if (ageAcc > 1000) {
    ageAcc = 0;
    for (const span of body.querySelectorAll('[data-age]')) {
      const a = app.alerts.get(span.dataset.age);
      if (a) span.textContent = alertAge(a, app.t);
    }
  }
}

function sortAlerts(list) {
  return [...list].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
    || (b.t_start || 0) - (a.t_start || 0));
}

function render(app) {
  if (!drawer) return;
  dirty = false;
  const active = sortAlerts(app.alerts.values());
  const history = [...app.alertLog].reverse();
  drawer.querySelector('[data-role="n-active"]').textContent = String(active.length);
  drawer.querySelector('[data-role="n-history"]').textContent = String(history.length);
  const nCrit = active.filter((a) => a.severity === 'critical').length;
  drawer.querySelector('[data-role="summary"]').textContent = active.length
    ? `${active.length} active${nCrit ? ` · ${nCrit} critical` : ''}` : 'All clear';
  const list = view === 'active' ? active : history;
  body.replaceChildren();
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'empty-ok';
    p.innerHTML = ICONS.ok.replace('fill="currentColor" opacity=".25"', 'fill="none"');
    p.append(document.createTextNode(view === 'active' ? 'No active alerts. All monitored systems nominal.' : 'No alerts this session.'));
    body.append(p);
    return;
  }
  for (const a of list) body.append(alertCard(app, a));
}

/**
 * One alert card (used in the drawer).
 * @param {object} app
 * @param {object} a
 * @returns {HTMLElement}
 */
function alertCard(app, a) {
  const card = document.createElement('article');
  card.className = 'alert-card';
  card.dataset.sev = a.severity;
  card.dataset.active = String(!!a.active);
  const top = document.createElement('div');
  top.className = 'alert-top';
  top.append(sevPill(a.active ? a.severity : 'cleared', a.active ? undefined : `${SEV_LABEL[a.severity] || a.severity} · cleared`));
  const title = document.createElement('span');
  title.className = 'alert-title';
  title.textContent = a.title || a.id;
  const time = document.createElement('span');
  time.className = 'alert-time';
  const at = document.createElement('span');
  at.textContent = `t ${formatClock(a.t_start)} · `;
  const age = document.createElement('span');
  age.textContent = alertAge(a, app.t);
  if (a.active) age.dataset.age = a.id;
  time.append(at, age);
  top.append(title, time);
  card.append(top);
  if (a.detail) {
    const d = document.createElement('div');
    d.className = 'alert-detail';
    d.textContent = a.detail;
    card.append(d);
  }
  const chans = (a.channels || []).filter((c) => app.channels.has(c));
  if (chans.length) {
    const row = document.createElement('div');
    row.className = 'alert-chans';
    for (const c of chans) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip mono';
      chip.textContent = c;
      chip.title = `${app.channels.get(c).name}: ${app.fmt(c)}`;
      chip.addEventListener('click', () => jumpToChannels(app, [c], a.title));
      row.append(chip);
    }
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'btn btn-ghost jump';
    jump.textContent = 'Show in Sensors →';
    jump.addEventListener('click', () => jumpToChannels(app, chans, a.title));
    row.append(jump);
    card.append(row);
  }
  return card;
}

/* ================================================================== toasts */

const TOAST_MAX = 4;
/** @type {Map<string, HTMLElement>} alert id -> toast */
const alertToasts = new Map();
/** alert ids that were active at the last event (to toast only fresh raises) */
const known = new Map();

function onAlertEvent(app, a) {
  if (!a) return;
  const key = `${a.id}@${a.t_start}`;
  if (!a.active) {
    known.delete(a.id);
    const t = alertToasts.get(a.id);
    if (t) dismiss(t);
    return;
  }
  if (known.get(a.id) === key) return; // detail update of an alert we already toasted
  known.set(a.id, key);
  if (a.severity !== 'warn' && a.severity !== 'critical') return;
  const old = alertToasts.get(a.id);
  if (old) dismiss(old);
  const el = showToast({
    title: a.title || a.id,
    detail: a.detail,
    sev: a.severity,
    ttl: a.severity === 'critical' ? 12000 : 7000,
    onClick: () => {
      const chans = (a.channels || []).filter((c) => app.channels.has(c));
      if (chans.length) jumpToChannels(app, chans, a.title); else app.ui.openDrawer('alerts');
    },
  });
  alertToasts.set(a.id, el);
  el.addEventListener('toast-gone', () => { if (alertToasts.get(a.id) === el) alertToasts.delete(a.id); });
}

function clearToasts() {
  known.clear();
  for (const t of alertToasts.values()) dismiss(t);
}

function dismiss(el) {
  if (el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(() => { el.remove(); el.dispatchEvent(new Event('toast-gone')); }, 260);
}

/**
 * Show a toast (bottom-right). Critical toasts pulse. Click runs `onClick` (default: dismiss).
 * @param {{title: string, detail?: string, sev?: 'info'|'warn'|'critical'|'error', ttl?: number,
 *          onClick?: () => void}} t
 * @returns {HTMLElement}
 */
export function showToast(t) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  const sev = t.sev || 'info';
  el.dataset.sev = sev;
  el.setAttribute('role', sev === 'critical' || sev === 'error' ? 'alert' : 'status');
  const pill = sevPill(sev === 'error' ? 'critical' : sev, sev === 'error' ? 'Error' : undefined);
  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = t.title;
  const close = document.createElement('button');
  close.className = 'icon-btn';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(el); });
  el.append(pill, title, close);
  if (t.detail) {
    const d = document.createElement('div');
    d.className = 'toast-detail';
    d.textContent = t.detail;
    el.append(d);
  }
  el.addEventListener('click', () => { if (t.onClick) t.onClick(); dismiss(el); });
  host.append(el);
  const all = host.querySelectorAll('.toast:not(.leaving)');
  if (all.length > TOAST_MAX) dismiss(all[0]);
  setTimeout(() => dismiss(el), t.ttl ?? 6000);
  return el;
}
