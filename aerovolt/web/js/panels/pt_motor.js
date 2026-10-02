/**
 * @file Powertrain tab - motor & inverter card: gauges for speed, torque, mechanical power,
 * winding and IGBT temperature (warning band = derating start, critical band = limit, both
 * read from `vehicle.yaml` via the hello payload), DC-link and phase quantities, efficiency,
 * the inverter state machine and the decoded fault code.
 *
 * Formulas shown:
 * * mechanical power `P_mech = T · ω = T · 2π·n / 60` (calc_mot_power, kW);
 * * drive efficiency `η = P_mech / P_DC` with `P_DC = V_DC · I_DC` (calc_inv_eff, only while
 *   motoring above 5 kW - at low power the ratio of two noisy numbers is meaningless);
 * * phase current `I_ph,rms = T / k_t` (k_t = torque constant, Nm/A).
 * Derating: above `derate_start_c` the inverter scales the torque limit down linearly to zero
 * at the maximum temperature, protecting the winding insulation and the IGBT junctions.
 */

import { Gauge } from '../lib/charts.js';
import { isNum } from '../lib/format.js';
import { card, el, enumLabel, kv, levelOf, num, setData, setText, vehicleNum } from './pt_common.js';

/** inv_state code → status level of its chip (state colours are status colours). */
const STATE_LEVEL = { 0: 'off', 1: 'info', 2: 'ok', 3: 'ok', 4: 'warn', 5: 'critical' };

/**
 * Thermal derating factor of one component: 1 below the derate start, falling linearly to 0
 * at the maximum temperature (`sim/powertrain_model.py: derate_factor`).
 * @param {number} temp      °C
 * @param {number} start     derate start, °C
 * @param {number} max       zero-torque temperature, °C
 * @returns {number} 0…1 (NaN when the temperature is missing)
 */
export function derateFactor(temp, start, max) {
  if (!isNum(temp)) return NaN;
  return Math.min(1, Math.max(0, (max - temp) / (max - start)));
}

/** Motor & inverter card. */
export class MotorCard {
  /** @param {HTMLElement} parent @param {object} app */
  constructor(parent, app) {
    const { card: c, head } = card('pt-motor', 'Motor & inverter');
    this.stateChip = el('span', 'pt-state', '—');
    this.faultChip = el('span', 'pt-fault', '');
    head.append(this.stateChip, this.faultChip);

    const v = (p, d) => vehicleNum(app, p, d);
    const maxRpm = v('powertrain.motor.max_speed_rpm', 6500);
    const peakT = v('powertrain.motor.peak_torque_nm', 220);
    const peakP = v('powertrain.motor.peak_power_kw', 100);
    const regenKw = v('powertrain.regen_max_kw', 30);
    const mDerate = v('powertrain.motor.derate_start_c', 110);
    const mMax = v('powertrain.motor.max_winding_c', 140);
    const iDerate = v('powertrain.inverter.derate_start_c', 75);
    const iMax = v('powertrain.inverter.max_c', 90);

    this.lim = { mDerate, mMax, iDerate, iMax };

    const gauges = el('div', 'pt-gauges');
    const mk = (opts) => {
      const h = el('div', 'pt-gauge');
      gauges.append(h);
      return new Gauge(h, opts);
    };
    this.gRpm = mk({ min: 0, max: Math.ceil(maxRpm / 500) * 500, label: 'Speed', unit: 'rpm', decimals: 0,
      title: `Motor speed (max ${num(maxRpm, 0)} rpm)` });
    this.gTorque = mk({ min: -Math.round(peakT * 0.6), max: peakT, label: 'Torque', unit: 'Nm', decimals: 0,
      title: `Motor torque (peak ${num(peakT, 0)} Nm; negative = regen)` });
    this.gPower = mk({ min: -regenKw, max: peakP, label: 'Power T·ω', unit: 'kW', decimals: 1,
      title: 'Motor mechanical power P = T·ω' });
    this.gWind = mk({ min: 20, max: mMax + 20, warn: mDerate, crit: mMax, label: 'Winding', unit: '°C', decimals: 0,
      title: `Motor winding temperature: derating from ${num(mDerate, 0)} °C, zero torque at ${num(mMax, 0)} °C` });
    this.gIgbt = mk({ min: 20, max: iMax + 20, warn: iDerate, crit: iMax, label: 'IGBT', unit: '°C', decimals: 0,
      title: `Inverter IGBT temperature: derating from ${num(iDerate, 0)} °C, shutdown at ${num(iMax, 0)} °C` });

    const tiles = el('div', 'pt-kvlist');
    this.tDcV = kv('V dc', 'Inverter DC-link voltage (= pack voltage minus cable drop)');
    this.tDcI = kv('I dc', 'Inverter DC current, + = drawn from the pack, − = regen');
    this.tPdc = kv('P dc', 'P_DC = V_DC · I_DC');
    this.tPh = kv('I phase', 'Motor phase current (RMS); T = k_t · I_ph');
    this.tEff = kv('η', 'Drive efficiency η = P_mech / P_DC (motor + inverter), only while motoring above 5 kW');
    tiles.append(this.tDcV.root, this.tDcI.root, this.tPdc.root, this.tPh.root, this.tEff.root);
    gauges.append(tiles);

    // thermal derating: the torque the inverter still allows
    const der = el('div', 'pt-derate');
    der.title = 'Torque available = min over motor and inverter of (T_max − T) / (T_max − T_derate), clipped to 0…100 % '
      + '(the same linear ramps as sim/powertrain_model.py derate_factor)';
    const top = el('div', 'pt-derate-top');
    this.derVal = el('b', 'num', '—');
    this.derSub = el('span', 'pt-derate-sub', '');
    top.append(el('span', 'tile-label', 'Torque available'), this.derVal, this.derSub);
    this.derMeter = el('div', 'meter');
    this.derFill = el('i');
    this.derMeter.append(this.derFill);
    const bands = el('div', 'pt-derate-bands');
    this.bandM = el('span', '', '');
    this.bandI = el('span', '', '');
    bands.append(this.bandM, this.bandI);
    der.append(top, this.derMeter, bands);
    c.append(gauges, der);
    parent.append(c);
  }

  /** Refresh (call at ~10 Hz). @param {object} app */
  update(app) {
    this.gRpm.set(app.val('mot_speed'));
    this.gTorque.set(app.val('mot_torque'));
    this.gPower.set(app.val('calc_mot_power'));
    this.gWind.set(app.val('mot_winding_temp'));
    this.gIgbt.set(app.val('inv_igbt_temp'));

    const vdc = app.val('inv_dc_voltage'), idc = app.val('inv_dc_current');
    this.tDcV.set(num(vdc, 1), 'V', levelOf(app.def('inv_dc_voltage'), vdc));
    this.tDcI.set(num(idc, 1), 'A');
    this.tPdc.set(num((vdc * idc) / 1000, 1), 'kW');
    this.tPh.set(num(app.val('inv_phase_current'), 0), 'A rms');
    const eff = app.val('calc_inv_eff');
    this.tEff.set(num(eff, 1), isNum(eff) ? '%' : '', '', isNum(eff) ? '' : '< 5 kW');

    const tw = app.val('mot_winding_temp'), ti = app.val('inv_igbt_temp');
    const L = this.lim;
    const fm = derateFactor(tw, L.mDerate, L.mMax), fi = derateFactor(ti, L.iDerate, L.iMax);
    const avail = isNum(fm) || isNum(fi) ? Math.min(isNum(fm) ? fm : 1, isNum(fi) ? fi : 1) : NaN;
    const lvl = !isNum(avail) ? '' : avail <= 0.001 ? 'critical' : avail < 0.999 ? 'warning' : '';
    setText(this.derVal, isNum(avail) ? `${num(avail * 100, 0)} %` : '—');
    setData(this.derVal, 'level', lvl);
    setText(this.derSub, !isNum(avail) ? '' : avail < 0.999 ? `derating: ${fm <= fi ? 'motor winding' : 'inverter IGBT'}` : 'no thermal derating');
    const w = `${num(isNum(avail) ? avail * 100 : 0, 1)}%`;
    if (this.derFill.style.width !== w) this.derFill.style.width = w;
    setData(this.derMeter, 'level', lvl);
    setText(this.bandM, `motor ${num(tw, 0)} °C · ramp ${num(L.mDerate, 0)}→${num(L.mMax, 0)}`);
    setText(this.bandI, `IGBT ${num(ti, 0)} °C · ramp ${num(L.iDerate, 0)}→${num(L.iMax, 0)}`);

    const st = app.val('inv_state');
    const label = enumLabel(app.def('inv_state'), st);
    setText(this.stateChip, isNum(st) ? label : 'state —');
    setData(this.stateChip, 'level', isNum(st) ? STATE_LEVEL[Math.round(st)] || 'off' : 'off');
    this.stateChip.title = 'Inverter state machine: off → precharge → ready → driving (derating / fault)';
    const f = app.val('inv_fault');
    const faulted = isNum(f) && f > 0.5;
    setText(this.faultChip, faulted ? `fault: ${enumLabel(app.def('inv_fault'), f)}` : isNum(f) ? 'no fault' : '');
    setData(this.faultChip, 'level', faulted ? 'critical' : '');
  }
}
