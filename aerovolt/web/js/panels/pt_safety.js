/**
 * @file Powertrain tab - shutdown circuit and tractive-system safety.
 *
 * Formula Student safety chain, drawn as the series loop it is: current from the LV supply
 * flows through every element in turn, so the *first* open element de-energises everything
 * after it (drawn as a dead, dashed wire).
 *
 * * **Shutdown circuit (SDC):** AMS (accumulator management - every cell inside its V / T
 *   limits), IMD (insulation monitoring device) and BSPD (brake-system plausibility device:
 *   hard braking while > 5 kW is drawn) are latching switches in series. If any opens, the
 *   AIRs drop out.
 * * **APPS plausibility:** the two accelerator-pedal sensors must agree within 10 points; on
 *   a disagreement > 100 ms the inverter cuts the torque (FS T 11.8.9 - the SDC itself stays
 *   closed), so it is shown as the torque-enable gate after the SDC.
 * * **AIR+ / AIR− and precharge:** the accumulator isolation relays connect the pack to the
 *   tractive system only through the precharge resistor first, until the DC link is ≥ 90 % of
 *   the pack voltage - otherwise the inrush current into the inverter capacitors would weld
 *   the relay contacts.
 * * **TSAL** (tractive-system active light): green = TS de-energised (LV only); red flashing
 *   at 2-5 Hz = TS active, high voltage outside the accumulator.
 * * **IMD threshold:** FS rules require the IMD to trip below 500 Ω per volt of the maximum
 *   tractive-system voltage: 500 Ω/V × (140 × 4.2 V = 588 V) = 294 kΩ. A healthy car reads
 *   about 2 MΩ.
 */

import { formatClock, isNum } from '../lib/format.js';
import { alertAge, sevPill } from './alerts.js';
import { card, el, levelOf, num, setData, setText, vehicleNum } from './pt_common.js';

/** How many recent safety events the card lists. */
const MAX_EVENTS = 3;

/** Elements of the chain in series order. */
export const CHAIN = [
  { id: 'ams_ok', label: 'AMS', title: 'Accumulator management system: every cell within its voltage and temperature limits' },
  { id: 'imd_ok', label: 'IMD', title: 'Insulation monitoring device: HV isolated from the chassis' },
  { id: 'bspd_ok', label: 'BSPD', title: 'Brake system plausibility device: no hard braking while power is drawn' },
  { id: 'apps_plaus_ok', label: 'APPS', title: 'Accelerator pedal sensors agree within 10 points (torque enable)' },
  { id: 'air_pos_closed', label: 'AIR+', title: 'Positive accumulator isolation relay closed' },
  { id: 'air_neg_closed', label: 'AIR−', title: 'Negative accumulator isolation relay closed' },
  { id: 'precharge_done', label: 'Precharge', title: 'DC link precharged to the pack voltage' },
];
const GROUPS = [
  { label: 'Shutdown circuit', span: 3 },
  { label: 'Torque', span: 1 },
  { label: 'Tractive system', span: 3 },
];

/**
 * State of each chain element and whether current reaches it.
 * @param {(id: string) => number} val
 * @returns {{id: string, state: 'closed'|'open'|'missing', powered: boolean}[]}
 */
export function chainState(val) {
  let powered = true;
  return CHAIN.map(({ id }) => {
    const v = val(id);
    const state = !isNum(v) ? 'missing' : v >= 0.5 ? 'closed' : 'open';
    const out = { id, state, powered };
    if (state !== 'closed') powered = false;
    return out;
  });
}

/**
 * One sentence explaining the chain state: what the first open element does to the car.
 * @param {{id: string, state: string}[]} states  from {@link chainState}
 * @returns {{level: 'ok'|'warn'|'critical'|'', text: string}}
 */
export function chainMessage(states) {
  const i = states.findIndex((s) => s.state !== 'closed');
  if (i < 0) return { level: 'ok', text: 'All closed: AIRs on, DC link precharged - tractive system energised.' };
  const { label } = CHAIN[i];
  if (states[i].state === 'missing') return { level: '', text: `No data from ${label} - chain state unknown from here on.` };
  if (i <= 2) return { level: 'critical', text: `${label} tripped → shutdown circuit open: AIRs drop out, tractive system de-energised.` };
  if (i === 3) return { level: 'warn', text: 'APPS implausible → inverter torque cut. The SDC stays closed (FS T 11.8.9).' };
  return { level: 'warn', text: `${label} open → tractive system off: high voltage stays inside the accumulator.` };
}

/**
 * IMD trip threshold: 500 Ω/V × maximum pack voltage, in kΩ.
 * @param {number} seriesCells
 * @param {number} cellVmax
 * @param {number} [ohmPerVolt=500]
 * @returns {number}
 */
export function imdThresholdKohm(seriesCells, cellVmax, ohmPerVolt = 500) {
  return (ohmPerVolt * seriesCells * cellVmax) / 1000;
}

/** Position 0…1 of a resistance on the log scale 10 kΩ … 10 MΩ. */
export function isoPosition(kohm) {
  if (!isNum(kohm) || kohm <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.log10(kohm) - 1) / 3));
}

const ICON = {
  closed: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  open: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  missing: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 6a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.7M8 11.6v.2"/></svg>',
};

/** Safety card. */
export class SafetyCard {
  /** @param {HTMLElement} parent @param {object} app */
  constructor(parent, app) {
    const { card: c, head } = card('pt-safety', 'Shutdown circuit', 'series loop');
    this.sdcChip = el('span', 'pt-state', 'SDC —');
    head.append(this.sdcChip);

    const chain = el('div', 'pt-chain');
    chain.style.setProperty('--n', String(CHAIN.length));
    for (const g of GROUPS) {
      const b = el('div', 'pt-chain-group', g.label);
      b.style.gridColumn = `span ${g.span}`;
      chain.append(b);
    }
    this.nodes = CHAIN.map((def, i) => {
      const n = el('div', i === 0 ? 'pt-node first' : 'pt-node');
      n.title = def.title;
      const sw = el('span', 'pt-sw');
      sw.innerHTML = ICON.missing;
      const lbl = el('span', 'pt-node-lbl', def.label);
      const st = el('span', 'pt-node-st', '—');
      n.append(sw, lbl, st);
      chain.append(n);
      return { n, sw, st, state: '' };
    });

    this.status = el('div', 'pt-sdc-status');
    const evWrap = el('div', 'pt-sdc-events');
    evWrap.append(el('div', 'tile-label', 'Recent safety events'));
    this.events = el('ul', 'pt-ev-list');
    evWrap.append(this.events);
    this.evDirty = true;
    this.evAcc = 0;
    const markEv = () => { this.evDirty = true; };
    app.on('alert', markEv);
    app.on('alertlog', markEv);
    app.on('hello', markEv);
    const bottom = el('div', 'pt-safety-bottom');
    // TSAL
    const tsal = el('div', 'pt-tsal');
    this.lamp = el('span', 'pt-lamp');
    const tsTxt = el('div', 'pt-tsal-txt');
    this.tsalState = el('b', '', '—');
    this.tsalSub = el('span', '', 'Tractive-system active light');
    tsTxt.append(el('span', 'tile-label', 'TSAL'), this.tsalState, this.tsalSub);
    tsal.append(this.lamp, tsTxt);
    // IMD insulation meter
    const series = vehicleNum(app, 'accumulator.series', 140);
    const vmax = vehicleNum(app, 'accumulator.cell.v_max', 4.2);
    this.vMaxPack = series * vmax;
    this.trip = imdThresholdKohm(series, vmax);
    const imd = el('div', 'pt-imd');
    imd.title = `FS rules: IMD trips below 500 Ω/V × ${num(this.vMaxPack, 0)} V = ${num(this.trip, 0)} kΩ`;
    const top = el('div', 'pt-imd-top');
    this.isoVal = el('b', 'num', '—');
    this.isoSub = el('span', 'pt-imd-sub', '');
    top.append(el('span', 'tile-label', 'Insulation'), this.isoVal, this.isoSub);
    const bar = el('div', 'pt-imd-bar');
    this.isoFill = el('i');
    const tripPos = `${(isoPosition(this.trip) * 100).toFixed(1)}%`;
    const tripMark = el('span', 'pt-imd-trip');
    tripMark.style.left = tripPos;
    bar.append(this.isoFill, tripMark);
    const ticks = el('div', 'pt-imd-ticks');
    for (const [v, t] of [[10, '10 k'], [100, '100 k'], [1000, '1 M'], [10000, '10 MΩ']]) {
      const s = el('span', '', t);
      s.style.left = `${(isoPosition(v) * 100).toFixed(1)}%`;
      ticks.append(s);
    }
    const tripLbl = el('span', 'trip', `trip ${num(this.trip, 0)} k`);
    tripLbl.style.left = tripPos;
    ticks.append(tripLbl);
    imd.append(top, bar, ticks);
    bottom.append(tsal, imd);
    c.append(chain, this.status, evWrap, bottom);
    parent.append(c);
  }

  /** Refresh (call at ~10 Hz). @param {object} app */
  update(app) {
    const states = chainState((id) => app.val(id));
    states.forEach((s, i) => {
      const node = this.nodes[i];
      const key = `${s.state}|${s.powered}`;
      if (node.state === key) return;
      node.state = key;
      node.sw.innerHTML = ICON[s.state];
      setData(node.n, 's', s.state);
      setData(node.n, 'powered', s.powered ? 'yes' : 'no');
      setText(node.st, s.state === 'closed' ? (i >= 4 ? 'closed' : 'OK') : s.state === 'open' ? (i >= 4 ? 'open' : 'TRIPPED') : 'no data');
    });

    const msg = chainMessage(states);
    setText(this.status, msg.text);
    setData(this.status, 'level', msg.level);

    this.evAcc += 1;
    if (this.evDirty || this.evAcc >= 10) this.renderEvents(app);

    const sdc = app.val('sdc_closed');
    setText(this.sdcChip, !isNum(sdc) ? 'SDC —' : sdc >= 0.5 ? 'SDC closed' : 'SDC OPEN');
    setData(this.sdcChip, 'level', !isNum(sdc) ? 'off' : sdc >= 0.5 ? 'ok' : 'critical');

    const ts = app.val('tsal_state');
    const hv = isNum(ts) && ts >= 0.5;
    setData(this.lamp, 'state', !isNum(ts) ? '' : hv ? 'hv' : 'lv');
    setText(this.tsalState, !isNum(ts) ? '—' : hv ? 'HV active' : 'LV only');
    setText(this.tsalSub, !isNum(ts) ? 'no data' : hv ? 'red, flashing 3 Hz: TS energised' : 'green: TS de-energised');

    const iso = app.val('imd_iso_kohm');
    const v = app.val('pack_voltage');
    const level = !isNum(iso) ? '' : iso <= this.trip ? 'critical' : levelOf(app.def('imd_iso_kohm'), iso);
    setText(this.isoVal, isNum(iso) ? `${num(iso, 0)} kΩ` : '—');
    const perV = isNum(iso) && isNum(v) && v > 50 ? (iso * 1000) / v : NaN;
    setText(this.isoSub, isNum(perV) ? `${num(perV, 0)} Ω/V (min 500)` : `trip < ${num(this.trip, 0)} kΩ`);
    setData(this.isoVal, 'level', level);
    const w = `${(isoPosition(iso) * 100).toFixed(1)}%`;
    if (this.isoFill.style.width !== w) this.isoFill.style.width = w;
    setData(this.isoFill, 'level', level);
  }

  /** @private newest safety alerts (raised by analysis/alerts.py: safety_*), active first */
  renderEvents(app) {
    this.evDirty = false;
    this.evAcc = 0;
    const evs = (app.alertLog || []).filter((a) => (a.id || '').startsWith('safety_')).slice(-MAX_EVENTS).reverse();
    if (!evs.length) {
      const li = el('li', 'pt-ev-empty', 'No safety trips this session.');
      this.events.replaceChildren(li);
      return;
    }
    this.events.replaceChildren(...evs.map((a) => {
      const li = el('li');
      li.append(sevPill(a.active ? a.severity : 'cleared', a.active ? undefined : 'Cleared'),
        el('span', 'pt-ev-title', a.title || a.id),
        el('span', 'pt-ev-t', `${isNum(a.t_start) ? formatClock(a.t_start) : ''} · ${alertAge(a, app.t)}`));
      li.title = a.detail || '';
      return li;
    }));
  }
}
