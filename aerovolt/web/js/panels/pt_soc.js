/**
 * @file Powertrain tab - state-of-charge card: the EKF SoC gauge, a strip chart that compares
 * the three estimators (EKF, Coulomb counting, the BMS's own) with the simulator truth, and
 * the energy used / recovered.
 *
 * The story this card tells (fault `current_offset`, a +3 A offset on the pack current shunt):
 *
 * * **Coulomb counting** integrates the measured current, `SoC(t) = SoC₀ − ∫ I_meas dt / Q`.
 *   A constant offset `ΔI` therefore adds an error that grows *linearly forever*:
 *   `dSoC_err/dt = −ΔI / Q`. With Q = 4 × 4.0 Ah = 16 Ah = 57 600 A·s, +3 A drifts
 *   −0.31 percentage points per minute (≈ −6 pp over a 20-minute endurance).
 * * **The EKF** (analysis/soc.py) predicts with the same current but *corrects* with the cell
 *   voltage through the OCV(SoC) curve every BMS sample, so the error stays bounded - it
 *   "holds" while Coulomb counting walks away.
 * * The card measures the drift itself: a least-squares slope of (CC − EKF) over the last
 *   minute gives the implied offset `ΔI = −slope · Q`, and the direct comparison of the
 *   shunt (`pack_current`) with the inverter's own DC current sensor (`inv_dc_current`) gives
 *   an independent check - the same plausibility test the `bms_soc_divergence` alert uses.
 */

import { Gauge, StripChart, seriesColor } from '../lib/charts.js';
import { isNum } from '../lib/format.js';
import { card, el, num, setData, setText, signed, tile, vehicleNum } from './pt_common.js';
import { sevPill } from './alerts.js';

/**
 * Least-squares slope of `a − b` against time over the last `windowS` seconds.
 * Samples where either value is missing are skipped.
 * @param {ArrayLike<number>} t  session time [s], ascending
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {number} windowS
 * @returns {{slope: number, last: number, n: number, span: number}}  slope in units of a per s
 */
export function differenceTrend(t, a, b, windowS) {
  const n = t.length;
  if (!n) return { slope: NaN, last: NaN, n: 0, span: 0 };
  const tEnd = t[n - 1];
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0, t0 = NaN, last = NaN;
  for (let i = 0; i < n; i++) {
    if (t[i] < tEnd - windowS) continue;
    const d = a[i] - b[i];
    if (!isNum(d)) continue;
    if (!isNum(t0)) t0 = t[i];
    const x = t[i] - t0;
    sx += x; sy += d; sxx += x * x; sxy += x * d; m++;
    last = d;
  }
  const den = m * sxx - sx * sx;
  const span = isNum(t0) ? tEnd - t0 : 0;
  return { slope: m >= 3 && den > 0 ? (m * sxy - sx * sy) / den : NaN, last, n: m, span };
}

/**
 * Current-sensor offset implied by a Coulomb-counting drift.
 * `dSoC/dt [%/s] = −100 · ΔI / (Q_Ah · 3600)`  ⇒  `ΔI = −slope / 100 · Q_Ah · 3600`.
 * @param {number} slopePctPerS  drift of (CC − reference), % per second
 * @param {number} capacityAh    pack capacity (parallel × cell capacity)
 * @returns {number} A (positive = the shunt reads high)
 */
export function impliedOffsetA(slopePctPerS, capacityAh) {
  return isNum(slopePctPerS) ? (-slopePctPerS / 100) * capacityAh * 3600 : NaN;
}

/** Mean of `a − b` over the last `windowS` seconds (NaN when nothing overlaps). */
export function meanDifference(t, a, b, windowS) {
  const n = t.length;
  if (!n) return NaN;
  const tEnd = t[n - 1];
  let s = 0, m = 0;
  for (let i = n - 1; i >= 0 && t[i] >= tEnd - windowS; i--) {
    const d = a[i] - b[i];
    if (isNum(d)) { s += d; m++; }
  }
  return m ? s / m : NaN;
}

const WINDOWS = [[120, '2 min'], [300, '5 min']];
const DRIFT_WINDOW_S = 60;
const MISMATCH_WINDOW_S = 20;

/** SoC card. */
export class SocCard {
  /** @param {HTMLElement} parent @param {object} app */
  constructor(parent, app) {
    const { card: c, head } = card('pt-soc', 'State of charge', 'EKF vs Coulomb counting');
    this.window = 300;
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Time window');
    this.winButtons = WINDOWS.map(([s, label]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(s === this.window));
      b.addEventListener('click', () => {
        this.window = s;
        for (const [w, bb] of this.winButtons) bb.setAttribute('aria-pressed', String(w === s));
        this.chart.setWindow(s);
        this.pull(app);
      });
      seg.append(b);
      return [s, b];
    });
    head.append(seg);

    const body = el('div', 'pt-soc-body');
    const left = el('div', 'pt-soc-left');
    const gHost = el('div', 'pt-gauge pt-soc-gauge');
    this.gauge = new Gauge(gHost, { min: 0, max: 100, unit: '%', decimals: 1, label: 'SoC (EKF)',
      warnLo: 15, critLo: 5, title: 'State of charge, extended Kalman filter' });
    this.readouts = el('div', 'pt-soc-readouts');
    left.append(gHost, this.readouts);
    const sHost = el('div', 'pt-soc-strip');
    body.append(left, sHost);

    this.story = el('div', 'pt-story');
    const energy = el('div', 'pt-energy');
    this.eUsed = tile('Energy used');
    this.eRegen = tile('Regen recovered');
    this.eNet = tile('Net from pack');
    energy.append(this.eUsed.root, this.eRegen.root, this.eNet.root);
    c.append(body, this.story, energy);
    parent.append(c);

    this.capacityAh = vehicleNum(app, 'accumulator.cell.capacity_ah', 4) * vehicleNum(app, 'accumulator.parallel', 4);
    const series = vehicleNum(app, 'accumulator.series', 140);
    const window = vehicleNum(app, 'accumulator.soc_window.max', 1) - vehicleNum(app, 'accumulator.soc_window.min', 0.05);
    this.usableKwh = (series * this.capacityAh * vehicleNum(app, 'accumulator.cell.v_nom', 3.6) * window) / 1000;
    this.buildChart(app, sHost);
    this.storyAcc = 1e9;
  }

  /** @private */
  buildChart(app, host) {
    const src = (id) => (s) => app.hist.series(id, s);
    const diff = (a, b) => (s) => {
      const A = app.hist.series(a, s), B = app.hist.series(b, s);
      const v = new Float64Array(A.v.length);
      for (let i = 0; i < v.length; i++) v[i] = A.v[i] - B.v[i];
      return { t: A.t, v };
    };
    this.hasTruth = app.channels.has('truth_soc') && app.mode !== 'LIVE';
    const EKF = seriesColor(0), CC = seriesColor(6), BMS = seriesColor(2), TRUTH = seriesColor(3);
    const series = [
      { label: 'EKF', lane: 0, color: EKF, source: src('calc_soc_ekf') },
      { label: 'Coulomb count', lane: 0, color: CC, dash: [5, 4], width: 1.8, source: src('calc_soc_cc') },
      { label: 'BMS', lane: 0, color: BMS, width: 1.4, source: src('bms_soc') },
    ];
    if (this.hasTruth) {
      series.push({ label: 'Truth (sim)', lane: 0, color: TRUTH, dash: [2, 3], width: 1.6, source: src('truth_soc') });
      series.push({ label: 'EKF error', lane: 1, color: EKF, source: diff('calc_soc_ekf', 'truth_soc') });
      series.push({ label: 'CC error', lane: 1, color: CC, dash: [5, 4], width: 1.8, source: diff('calc_soc_cc', 'truth_soc') });
    } else {
      series.push({ label: 'CC − EKF', lane: 1, color: CC, dash: [5, 4], width: 1.8, source: diff('calc_soc_cc', 'calc_soc_ekf') });
    }
    // The read-out list beside the gauge is the legend (key line + label + value for every
    // estimator), so the chart's own legend is off and the plot keeps its height.
    this.chart = new StripChart(host, {
      title: 'State of charge estimators and their error',
      window: this.window,
      legend: false,
      lanes: [
        { label: 'SoC', unit: '%', decimals: 1, weight: 1.35 },
        { label: this.hasTruth ? 'Estimator − truth' : 'CC − EKF', unit: 'pp', decimals: 2, softMin: -1, softMax: 1,
          thresholds: [{ value: 0, label: '', level: 'neutral' }] },
      ],
      series,
    });
    // Rows under the gauge: colour key line + value (identity is never colour alone)
    this.rows = [
      ['calc_soc_ekf', 'EKF', EKF, false, 'Extended Kalman filter: Coulomb prediction corrected by the cell voltage (OCV curve)'],
      ['calc_soc_cc', 'CC', CC, true, 'Coulomb counting: SoC₀ − ∫ I dt / Q from the pack current shunt'],
      ['bms_soc', 'BMS', BMS, false, "The BMS's own estimate (Coulomb counting, 0.5 % steps)"],
      ...(this.hasTruth ? [['truth_soc', 'Truth', TRUTH, true, 'Simulator truth (demo mode only - a real car has none)']] : []),
    ].map(([id, label, color, dashed, title]) => {
      const r = el('div', 'pt-soc-row');
      r.title = title;
      const key = el('i', `pt-key${dashed ? ' dashed' : ''}`);
      key.style.setProperty('--key', color);
      const l = el('span', 'lbl', label);
      const v = el('b', 'num', '—');
      r.append(key, l, v);
      this.readouts.append(r);
      return { id, v };
    });
  }

  /** @private */
  pull(app) {
    this.chart.pull(app.t);
  }

  /**
   * Refresh (call at ~10 Hz).
   * @param {object} app
   * @param {number} dtMs  time since the last call
   */
  update(app, dtMs) {
    const ekf = app.val('calc_soc_ekf');
    this.gauge.set(ekf);
    for (const r of this.rows) setText(r.v, `${num(app.val(r.id), 1)} %`);
    this.pull(app);
    const used = app.val('calc_energy_used'), regen = app.val('calc_energy_regen');
    this.eUsed.set(num(used, 2), 'kWh', 'discharge, ∫P dt');
    this.eRegen.set(num(regen, 2), 'kWh', isNum(used) && used > 0 && isNum(regen) ? `${num((100 * regen) / used, 0)} % of used` : 'braking');
    const net = used - regen;
    this.eNet.set(num(net, 2), 'kWh', isNum(net) ? `${num((100 * net) / this.usableKwh, 0)} % of ${num(this.usableKwh, 2)} kWh usable` : '');
    this.storyAcc += dtMs;
    if (this.storyAcc >= 500) {
      this.storyAcc = 0;
      this.renderStory(app);
    }
  }

  /** @private the plain-language explanation of what the estimators are doing */
  renderStory(app) {
    const cc = app.hist.series('calc_soc_cc', DRIFT_WINDOW_S);
    const ekf = app.hist.series('calc_soc_ekf', DRIFT_WINDOW_S);
    const tr = differenceTrend(cc.t, cc.v, ekf.v, DRIFT_WINDOW_S);
    const pi = app.hist.series('pack_current', MISMATCH_WINDOW_S);
    const ii = app.hist.series('inv_dc_current', MISMATCH_WINDOW_S);
    const mismatch = meanDifference(pi.t, pi.v, ii.v, MISMATCH_WINDOW_S);
    const perMin = tr.slope * 60;
    const implied = impliedOffsetA(tr.slope, this.capacityAh);
    const gap = app.val('calc_soc_cc') - app.val('calc_soc_ekf');
    const ekfErr = app.val('calc_soc_ekf') - app.val('truth_soc');
    const diverging = app.alerts.has('bms_soc_divergence')
      || (isNum(mismatch) && Math.abs(mismatch) > 1.5)
      || (tr.span >= 30 && isNum(implied) && Math.abs(implied) > 1.5 && Math.abs(gap) > 0.3);
    const msg = el('span');
    if (!isNum(gap)) {
      setData(this.story, 'level', '');
      msg.textContent = 'Waiting for the SoC estimators…';
      this.story.replaceChildren(msg);
      return;
    }
    if (diverging) {
      const b = el('b', '', 'Coulomb counting is drifting. ');
      let txt = `CC − EKF ${signed(gap, 2)} pp, ${signed(perMin, 2)} pp/min`;
      if (isNum(implied) && tr.span >= 30) txt += ` (≙ ${signed(implied, 1)} A offset)`;
      if (isNum(mismatch)) txt += `; shunt reads ${signed(mismatch, 1)} A vs the inverter`;
      txt += '. An offset integrates forever - the EKF holds';
      txt += this.hasTruth && isNum(ekfErr) ? ` (error ${signed(ekfErr, 2)} pp) by re-anchoring to cell voltage via OCV.` : ' by re-anchoring to cell voltage via OCV.';
      msg.append(b, document.createTextNode(txt));
      setData(this.story, 'level', 'warn');
      this.story.replaceChildren(sevPill('warn', 'Drift'), msg);
    } else {
      const b = el('b', '', 'Estimators agree. ');
      const parts = [`CC − EKF ${signed(gap, 2)} pp`];
      if (isNum(perMin) && tr.span >= 30) parts.push(`drift ${signed(perMin, 2)} pp/min`);
      if (isNum(mismatch)) parts.push(`shunt vs inverter current ${signed(mismatch, 1)} A`);
      if (this.hasTruth && isNum(ekfErr)) parts.push(`EKF error ${signed(ekfErr, 2)} pp`);
      msg.append(b, document.createTextNode(`${parts.join(' · ')}.`));
      setData(this.story, 'level', 'ok');
      this.story.replaceChildren(sevPill('ok', 'OK'), msg);
    }
  }
}
