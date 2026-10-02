/**
 * @file Powertrain tab - cooling-loop schematic (inline SVG).
 *
 * The water-glycol loop runs pump → inverter cold plate → motor jacket → radiator → pump
 * (`config/sensors.yaml`: `cool_temp_in` is measured after the radiator, i.e. into the
 * inverter; `cool_temp_out` after the motor). The heat the coolant carries to the radiator is
 *
 *     Q̇ = ṁ · c_p · ΔT = (ρ · V̇) · c_p · (T_out − T_in)
 *
 * e.g. 8 L/min of 50 % glycol (ρ = 1040 kg/m³, c_p = 3600 J/(kg·K)) with ΔT = 3 K carries
 * 8/60000 m³/s · 1040 · 3600 · 3 ≈ 1.5 kW (`calc_cool_heat`). The radiator rejects
 * `(T_coolant − T_amb) · (UA₀ + UA₁ · airspeed)` - which is why the motor runs hotter on a
 * slow, twisty track: less ram air through the side pod.
 *
 * Flow is animated: the dashes along the pipes move at a speed proportional to `cool_flow`,
 * so a stopped pump (fault `pump_fail`) is visible at a glance - the dashes freeze and the
 * pipes turn red.
 */

import { isNum } from '../lib/format.js';
import { card, levelOf, num, setData, setText, vehicleNum } from './pt_common.js';

const NS = 'http://www.w3.org/2000/svg';

/** Below this flow [L/min] the loop counts as stopped (the `cooling_no_flow` alert uses 1.0). */
export const NO_FLOW_LPM = 1.0;
/** Dash speed per unit of flow [viewBox px/s per L/min]. */
const DASH_SPEED = 7;

/**
 * Coolant heat flow ṁ·c_p·ΔT in kW (the formula behind `calc_cool_heat`).
 * @param {number} flowLpm   volume flow, L/min
 * @param {number} tIn       °C
 * @param {number} tOut      °C
 * @param {number} [rho=1040]  kg/m³
 * @param {number} [cp=3600]   J/(kg·K)
 * @returns {number} kW
 */
export function coolantHeatKw(flowLpm, tIn, tOut, rho = 1040, cp = 3600) {
  return ((flowLpm / 60000) * rho * cp * (tOut - tIn)) / 1000;
}

function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/* Geometry (viewBox units). The loop runs clockwise on screen. */
const VB = { w: 340, h: 232 };
const PIPES = {
  // radiator outlet → pump → inverter inlet (measured: cool_temp_in)
  cold: 'M210 186 L22 186 L22 46 L58 46',
  // inverter outlet → motor inlet (not measured: between T_in and T_out)
  warm: 'M146 46 L194 46',
  // motor outlet → radiator inlet (measured: cool_temp_out)
  hot: 'M282 46 L318 46 L318 186 L290 186',
};

/** Cooling-loop card. */
export class CoolingCard {
  /** @param {HTMLElement} parent @param {object} app */
  constructor(parent, app) {
    const { card: c } = card('pt-cool', 'Cooling loop', 'pump → inverter → motor → radiator');
    this.rho = vehicleNum(app, 'cooling.coolant_density', 1040);
    this.cp = vehicleNum(app, 'cooling.coolant_cp', 3600);
    this.nominal = vehicleNum(app, 'cooling.pump_flow_lpm', 8);
    const host = document.createElement('div');
    host.className = 'pt-cool-host';
    const root = svg('svg', { viewBox: `0 0 ${VB.w} ${VB.h}`, class: 'pt-cool-svg', role: 'img',
      'aria-label': 'Cooling loop schematic with live temperatures and flow' });

    // arrowhead for the direction chevrons
    const defs = svg('defs');
    const marker = svg('marker', { id: 'pt-arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto' });
    marker.append(svg('path', { d: 'M1 1 L9 5 L1 9', class: 'pt-chev' }));
    defs.append(marker);
    root.append(defs);

    // pipes: a wide translucent base plus an animated dashed overlay per leg
    this.flowPaths = [];
    for (const [leg, d] of Object.entries(PIPES)) {
      root.append(svg('path', { d, class: `pt-pipe pt-pipe-${leg}` }));
      const p = svg('path', { d, class: `pt-flow pt-flow-${leg}` });
      root.append(p);
      this.flowPaths.push(p);
    }
    // static direction arrows (still meaningful when the flow is stopped)
    for (const d of ['M22 126 L22 112', 'M318 106 L318 120', 'M180 186 L166 186', 'M164 46 L176 46']) {
      root.append(svg('path', { d, class: 'pt-dir', 'marker-end': 'url(#pt-arrow)' }));
    }

    // components
    const box = (x, y, w, h, title) => {
      const g = svg('g', { class: 'pt-comp' });
      g.append(svg('rect', { x, y, width: w, height: h, rx: 7 }));
      g.append(svg('text', { x: x + w / 2, y: y + 14, class: 'pt-comp-title' }, title));
      const v = svg('text', { x: x + w / 2, y: y + 32, class: 'pt-comp-value' }, '—');
      g.append(v);
      root.append(g);
      return { g, v };
    };
    this.inv = box(58, 24, 88, 44, 'Inverter IGBT');
    this.mot = box(194, 24, 88, 44, 'Motor winding');
    // radiator: box with fins
    const rad = svg('g', { class: 'pt-comp pt-rad' });
    rad.append(svg('rect', { x: 210, y: 168, width: 80, height: 36, rx: 6 }));
    for (let x = 220; x <= 280; x += 8) rad.append(svg('line', { x1: x, y1: 172, x2: x, y2: 200, class: 'pt-fin' }));
    root.append(rad);
    this.radG = rad;
    // pump: circle with impeller
    const pump = svg('g', { class: 'pt-comp pt-pump' });
    pump.append(svg('circle', { cx: 110, cy: 186, r: 17 }));
    this.impeller = svg('path', { d: 'M110 172 L110 200 M96 186 L124 186 M100 176 L120 196 M120 176 L100 196', class: 'pt-impeller' });
    pump.append(this.impeller);
    root.append(pump);
    this.pumpG = pump;
    this.impAngle = 0;

    // labels
    root.append(svg('text', { x: 34, y: 104, class: 'pt-lbl' }, 'Coolant in'));
    this.tIn = svg('text', { x: 34, y: 122, class: 'pt-val' }, '—');
    root.append(this.tIn);
    root.append(svg('text', { x: 306, y: 104, class: 'pt-lbl end' }, 'Coolant out'));
    this.tOut = svg('text', { x: 306, y: 122, class: 'pt-val end' }, '—');
    root.append(this.tOut);
    this.cLbl = svg('text', { x: 170, y: 96, class: 'pt-lbl mid pt-cool-head' }, 'Heat to radiator');
    this.cVal = svg('text', { x: 170, y: 121, class: 'pt-big mid' }, '—');
    this.cSub = svg('text', { x: 170, y: 139, class: 'pt-lbl mid' }, 'ṁ·cp·ΔT');
    this.cFlow = svg('text', { x: 170, y: 156, class: 'pt-lbl mid' }, '');
    root.append(this.cLbl, this.cVal, this.cSub, this.cFlow);
    this.pumpTxt = svg('text', { x: 110, y: 223, class: 'pt-lbl mid' }, 'Pump —');
    this.fanTxt = svg('text', { x: 250, y: 223, class: 'pt-lbl mid' }, 'Radiator · fan —');
    root.append(this.pumpTxt, this.fanTxt);

    host.append(root);
    c.append(host);
    parent.append(c);
    this.root = c;
    this.svg = root;
    this.offset = 0;
    this.flow = NaN;
  }

  /**
   * Move the flow dashes (every animation frame; three attribute writes).
   * @param {number} dtMs
   */
  animate(dtMs) {
    const f = this.flow;
    if (!isNum(f) || f < NO_FLOW_LPM) return;
    this.offset = (this.offset - (f * DASH_SPEED * dtMs) / 1000) % 1000;
    const o = this.offset.toFixed(2);
    for (const p of this.flowPaths) p.setAttribute('stroke-dashoffset', o);
    this.impAngle = (this.impAngle + (f / this.nominal) * 540 * (dtMs / 1000)) % 360;
    this.impeller.setAttribute('transform', `rotate(${this.impAngle.toFixed(1)} 110 186)`);
  }

  /** Refresh the read-outs (call at ~10 Hz). @param {object} app */
  update(app) {
    const flow = app.val('cool_flow');
    this.flow = flow;
    const tIn = app.val('cool_temp_in'), tOut = app.val('cool_temp_out');
    const wind = app.val('mot_winding_temp'), igbt = app.val('inv_igbt_temp');
    const stopped = isNum(flow) && flow < NO_FLOW_LPM;
    setData(this.root, 'flow', stopped ? 'none' : isNum(flow) ? 'ok' : 'unknown');

    setText(this.tIn, `${num(tIn, 1)} °C`);
    setText(this.tOut, `${num(tOut, 1)} °C`);
    setData(this.tIn, 'level', levelOf(app.def('cool_temp_in'), tIn));
    setData(this.tOut, 'level', levelOf(app.def('cool_temp_out'), tOut));
    setText(this.inv.v, `${num(igbt, 1)} °C`);
    setText(this.mot.v, `${num(wind, 1)} °C`);
    setData(this.inv.g, 'level', levelOf(app.def('inv_igbt_temp'), igbt));
    setData(this.mot.g, 'level', levelOf(app.def('mot_winding_temp'), wind));

    let q = app.val('calc_cool_heat');
    if (!isNum(q)) q = coolantHeatKw(flow, tIn, tOut, this.rho, this.cp);
    if (stopped) {
      setText(this.cLbl, 'NO COOLANT FLOW');
      setText(this.cVal, `${num(flow, 2)} L/min`);
      setText(this.cSub, 'pump failed or air-locked');
      setText(this.cFlow, 'heat stays in motor + inverter');
    } else {
      setText(this.cLbl, 'Heat to radiator');
      setText(this.cVal, `${num(q, 2)} kW`);
      setText(this.cSub, `ṁ·cp·ΔT · ΔT ${num(tOut - tIn, 1)} K`);
      setText(this.cFlow, `flow ${num(flow, 1)} L/min (nominal ${num(this.nominal, 0)})`);
    }
    setData(this.cFlow, 'level', levelOf(app.def('cool_flow'), flow));
    setText(this.pumpTxt, `Pump ${num(app.val('pump_duty'), 0)} %`);
    setText(this.fanTxt, `Fan ${num(app.val('fan_duty'), 0)} %`);
  }
}
