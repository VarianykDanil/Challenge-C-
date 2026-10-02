/**
 * @file Fault injection panel (demo feature): a slide-out drawer listing the simulator's
 * injectable faults (SPEC §5.5) grouped Aero / Powertrain, each with a toggle switch that
 * calls `POST /api/faults/{id}` `{"active": true|false}`.
 *
 * For each fault the panel also shows which alerts the analysis is *expected* to raise and
 * ticks them off live as they appear - so judges can watch the detection chain work:
 * inject "Hot cell" → `bms_cell_temp_outlier` lights up → later `bms_cell_overtemp`.
 *
 * Only available when the server reports faults (a simulator is running: SIM or HYBRID).
 * Exports used by main.js: `init(drawerEl, app)`, `available(app)`, `onOpen(app)`,
 * `update(app, dtMs)`.
 */

import { formatClock, isNum } from '../lib/format.js';
import { sevPill } from './alerts.js';

/**
 * Alerts each fault is expected to raise (SPEC §5.5, "expected alert id(s)"). The server
 * sends them with each fault (`fault.alerts`); this table is the fallback for older feeds.
 */
export const EXPECTED_ALERTS = Object.freeze({
  fw_damage_left: ['aero_fw_asymmetry', 'aero_balance_shift'],
  rw_stall: ['aero_rw_suction_loss', 'aero_balance_shift'],
  ut_bottoming: ['aero_ut_stall'],
  pitot_blocked: ['sensor_pitot_implausible'],
  tap_leak: ['sensor_tap_anomaly'],
  crosswind_gust: ['aero_high_yaw'],
  cell_hot: ['bms_cell_voltage_outlier', 'bms_cell_temp_outlier'],
  cell_weak: ['bms_cell_voltage_outlier'],
  pump_fail: ['cooling_no_flow', 'motor_temp_high'],
  imd_fault: ['safety_imd_trip', 'safety_sdc_open'],
  current_offset: ['bms_soc_divergence'],
  apps_implausible: ['safety_apps_implausible'],
});

const GROUPS = [
  { system: 'aero', title: 'System 1 · Aero' },
  { system: 'powertrain', title: 'System 2 · Powertrain' },
];

let drawer = null;
let bodyEl = null;
let summaryEl = null;
let clearBtn = null;
let dirty = true;
let acc = 0;
/** @type {Set<string>} faults with a request in flight */
const pending = new Set();
/** @type {Map<string, number>} fault id -> session time it was seen becoming active */
const since = new Map();

/**
 * True when fault injection can be used (the server lists at least one fault).
 * @param {object} app
 */
export function available(app) {
  return !!(app.meta && Array.isArray(app.faults) && app.faults.length);
}

/**
 * Build the drawer (called once by main.js).
 * @param {HTMLElement} el
 * @param {object} app
 */
export function init(el, app) {
  drawer = el;
  el.innerHTML = `
    <div class="drawer-head">
      <h2>Fault injection</h2>
      <span class="chip">demo</span>
      <span class="spacer"></span>
      <button class="icon-btn" type="button" data-role="close" aria-label="Close fault injection">×</button>
    </div>
    <div class="drawer-sub">
      <span class="card-sub" data-role="summary"></span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn" type="button" data-role="clear">Clear all faults</button>
    </div>
    <div class="drawer-body">
      <p class="faults-intro">Break the virtual car on purpose and watch AeroVolt detect it. Faults act on the
      simulator only: real sensors are never touched. Expected alerts tick off as the analysis raises them.</p>
      <div data-role="list"></div>
    </div>`;
  bodyEl = el.querySelector('[data-role="list"]');
  summaryEl = el.querySelector('[data-role="summary"]');
  clearBtn = el.querySelector('[data-role="clear"]');
  el.querySelector('[data-role="close"]').addEventListener('click', () => app.ui.closeDrawers());
  clearBtn.addEventListener('click', () => {
    for (const f of app.faults) if (f.active) setFault(app, f.id, false);
  });
  const mark = () => { dirty = true; };
  app.on('faults', (list) => { trackSince(app, list); mark(); });
  app.on('alert', mark);
  app.on('alertlog', mark);
  app.on('hello', () => { since.clear(); trackSince(app, app.faults); mark(); });
}

/** Drawer opened. */
export function onOpen(app) {
  dirty = true;
  render(app);
}

/** Per-frame while open: re-render on change; refresh "active for" timers each second. */
export function update(app, dtMs) {
  acc += dtMs;
  if (dirty) { render(app); return; }
  if (acc > 1000) {
    acc = 0;
    for (const s of bodyEl.querySelectorAll('[data-since]')) {
      const t0 = since.get(s.dataset.since);
      s.textContent = isNum(t0) && isNum(app.t) ? `active ${formatClock(app.t - t0)}` : 'active';
    }
  }
}

function trackSince(app, list) {
  for (const f of list || []) {
    if (f.active && !since.has(f.id)) since.set(f.id, app.t);
    if (!f.active) since.delete(f.id);
  }
}

/**
 * Toggle a fault on the server; optimistic UI with rollback on error.
 * @param {object} app
 * @param {string} id
 * @param {boolean} active
 */
async function setFault(app, id, active) {
  pending.add(id);
  dirty = true;
  try {
    const list = await app.api.post(`/api/faults/${encodeURIComponent(id)}`, { active });
    if (Array.isArray(list)) {
      app.faults = list;
      trackSince(app, list);
    }
  } catch (err) {
    app.ui.toast({ title: `Could not ${active ? 'inject' : 'clear'} fault "${id}"`, detail: err.message, sev: 'error' });
  } finally {
    pending.delete(id);
    dirty = true;
  }
}

function alertTitle(app, id) {
  for (let i = app.alertLog.length - 1; i >= 0; i--) if (app.alertLog[i].id === id) return app.alertLog[i].title;
  const rule = ((app.meta && app.meta.alert_rules) || []).find((r) => r.id === id);
  if (rule && rule.title) return rule.title;
  const words = id.replace(/_/g, ' ');
  return words[0].toUpperCase() + words.slice(1);
}

function render(app) {
  if (!drawer) return;
  dirty = false;
  const faults = app.faults || [];
  const nActive = faults.filter((f) => f.active).length;
  summaryEl.textContent = !faults.length ? 'No simulator running'
    : nActive ? `${nActive} of ${faults.length} faults active` : `${faults.length} faults available · none active`;
  clearBtn.disabled = nActive === 0;
  bodyEl.replaceChildren();
  const known = new Set(GROUPS.map((g) => g.system));
  const groups = [...GROUPS];
  if (faults.some((f) => !known.has(f.system))) groups.push({ system: null, title: 'Other' });
  for (const g of groups) {
    const items = faults.filter((f) => (g.system ? f.system === g.system : !known.has(f.system)));
    if (!items.length) continue;
    const sec = document.createElement('section');
    sec.className = 'fault-group';
    const h = document.createElement('h3');
    const ht = document.createElement('span');
    ht.textContent = g.title;
    const line = document.createElement('span');
    line.className = 'line';
    const cnt = document.createElement('span');
    const na = items.filter((f) => f.active).length;
    cnt.textContent = na ? `${na} active` : '';
    h.append(ht, line, cnt);
    sec.append(h);
    for (const f of items) sec.append(faultCard(app, f));
    bodyEl.append(sec);
  }
}

function faultCard(app, f) {
  const card = document.createElement('div');
  card.className = 'fault';
  card.dataset.fault = f.id;
  card.dataset.active = String(!!f.active);
  if (pending.has(f.id)) card.classList.add('pending');
  const head = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'fault-title';
  title.append(document.createTextNode(f.title || f.id));
  if (f.active) {
    const tag = document.createElement('span');
    tag.className = 'live-tag';
    tag.textContent = 'INJECTED';
    title.append(tag);
  }
  const idl = document.createElement('div');
  idl.className = 'fault-id';
  idl.textContent = f.id;
  if (f.active) {
    const s = document.createElement('span');
    s.dataset.since = f.id;
    const t0 = since.get(f.id);
    s.textContent = isNum(t0) && isNum(app.t) ? `active ${formatClock(app.t - t0)}` : 'active';
    idl.append(document.createTextNode(' · '), s);
  }
  head.append(title, idl);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = !!f.active;
  input.disabled = pending.has(f.id);
  input.setAttribute('aria-label', `${f.title || f.id}: ${f.active ? 'active' : 'inactive'}`);
  input.addEventListener('change', () => setFault(app, f.id, input.checked));
  const track = document.createElement('span');
  track.className = 'track';
  const knob = document.createElement('span');
  knob.className = 'knob';
  sw.append(input, track, knob);

  card.append(head, sw);
  if (f.description) {
    const d = document.createElement('div');
    d.className = 'fault-desc';
    d.textContent = f.description;
    card.append(d);
  }
  const expected = Array.isArray(f.alerts) && f.alerts.length ? f.alerts : EXPECTED_ALERTS[f.id];
  if (expected && expected.length) {
    const row = document.createElement('div');
    row.className = 'fault-alerts';
    row.append(document.createTextNode('Expect:'));
    for (const aid of expected) {
      const raised = app.alerts.get(aid);
      if (raised) row.append(sevPill(raised.severity, alertTitle(app, aid)));
      else {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = alertTitle(app, aid);
        chip.title = `Alert ${aid} - not active`;
        row.append(chip);
      }
    }
    card.append(row);
  }
  return card;
}
