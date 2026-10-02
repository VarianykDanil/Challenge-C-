/**
 * @file Powertrain tab - energy & endurance strategy card.
 *
 * The question the pit wall must answer every lap: *at this power limit, does the car reach
 * the end of the 22 km endurance before the accumulator does?*
 *
 * * Energy budget per lap = energy still available (above the SoC-window minimum, minus the
 *   reserve) / laps still to drive.
 * * The server's lap simulator predicts the energy per lap for each power limit (scaled by the
 *   measured / predicted ratio of the laps so far) → `strategy.curve`; the recommended limit
 *   is the highest one whose energy per lap fits the budget.
 * * Finish SoC at another limit P follows from the energy difference per lap:
 *   `SoC_finish(P) = SoC_finish(P_rec) + (E_lap(P_rec) − E_lap(P)) · laps_left / E_pack · 100`.
 *
 * The verdict line turns that into one plain sentence, e.g. "Finishes with 7 % SoC reserve at
 * 65 kW" or "Will NOT finish at 80 kW — reduce to 65 kW".
 */

import { BarChart, XYChart, seriesColor, theme } from '../lib/charts.js';
import { isNum } from '../lib/format.js';
import { sevPill } from './alerts.js';
import { card, el, num, setData, tile, vehicleNum } from './pt_common.js';

/**
 * Energy per lap at power limit `kw`, linearly interpolated on the strategy curve.
 * @param {{kw: number, energy_kwh: number}[]} curve  ascending in kw
 * @param {number} kw
 * @returns {number} kWh (NaN outside the curve or when missing)
 */
export function energyAt(curve, kw) {
  if (!Array.isArray(curve) || !curve.length || !isNum(kw)) return NaN;
  const pts = curve.filter((c) => isNum(c.kw) && isNum(c.energy_kwh)).sort((a, b) => a.kw - b.kw);
  if (!pts.length || kw < pts[0].kw - 1e-6 || kw > pts[pts.length - 1].kw + 1e-6) return NaN;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (kw <= b.kw + 1e-9) return a.energy_kwh + ((kw - a.kw) / (b.kw - a.kw || 1)) * (b.energy_kwh - a.energy_kwh);
  }
  return pts[pts.length - 1].energy_kwh;
}

/** Laps still to drive from a strategy payload. */
export function lapsLeft(s) {
  if (!s) return NaN;
  if (isNum(s.laps_left)) return s.laps_left;
  if (isNum(s.laps_needed) && isNum(s.laps_done)) return Math.max(0, s.laps_needed - s.laps_done);
  return NaN;
}

/**
 * Plain-language verdict of a strategy payload.
 * @param {object|null} s  `app.strategy`
 * @param {{packEnergyKwh: number, limitKw: number, socMinPct?: number}} car
 *   pack energy (capacity × nominal voltage), configured power limit (used when the server
 *   does not report the limit the car is running at), bottom of the usable SoC window
 * @returns {{level: ''|'ok'|'warn'|'critical', text: string, currentKw: number, finishAtCurrent: number, short: boolean}}
 */
export function strategyVerdict(s, car) {
  const none = { level: '', text: 'The strategy is computed after the first completed lap.', currentKw: NaN, finishAtCurrent: NaN, short: false };
  if (!s) return none;
  const left = lapsLeft(s);
  const rec = s.recommended_kw;
  const cur = isNum(s.current_kw) ? s.current_kw : car.limitKw;
  if (isNum(left) && left <= 0) {
    return { level: 'ok', text: 'Endurance distance complete.', currentKw: cur, finishAtCurrent: s.predicted_finish_soc, short: false };
  }
  const eRec = energyAt(s.curve, rec), eCur = energyAt(s.curve, cur);
  const finishRec = s.predicted_finish_soc;
  const finishCur = isNum(finishRec) && isNum(eRec) && isNum(eCur) && isNum(left) && car.packEnergyKwh > 0
    ? finishRec + ((eRec - eCur) * left * 100) / car.packEnergyKwh
    : NaN;
  const short = s.energy_short === true || (s.energy_short === undefined && isNum(cur) && isNum(rec) && cur > rec + 0.5);
  const socMin = isNum(car.socMinPct) ? car.socMinPct : 0;
  const pct = (v) => `${num(v, 0)} %`;
  if (isNum(finishRec) && finishRec < socMin) {
    return { level: 'critical', short: true, currentKw: cur, finishAtCurrent: finishCur,
      text: `Will NOT finish even at ${num(rec, 0)} kW — predicted ${pct(finishRec)} SoC at the flag (usable minimum ${pct(socMin)}).` };
  }
  if (short) {
    return { level: 'warn', short: true, currentKw: cur, finishAtCurrent: finishCur,
      text: `Will NOT finish at ${num(cur, 0)} kW — reduce to ${num(rec, 0)} kW (finishes with ${pct(finishRec)} SoC).` };
  }
  const at = isNum(finishCur) ? finishCur : finishRec;
  const atKw = isNum(finishCur) ? cur : rec;
  let text = `Finishes with ${pct(at)} SoC reserve at ${num(atKw, 0)} kW.`;
  if (isNum(rec) && isNum(cur) && rec > cur + 0.5) text += ` Up to ${num(rec, 0)} kW still finishes.`;
  return { level: 'ok', short: false, currentKw: cur, finishAtCurrent: finishCur, text };
}

const MAX_BARS = 10;

/** Energy & strategy card. */
export class StrategyCard {
  /** @param {HTMLElement} parent @param {object} app */
  constructor(parent, app) {
    const km = vehicleNum(app, 'endurance.distance_km', 22);
    const { card: c } = card('pt-strat', 'Energy & strategy', `endurance ${num(km, 0)} km · updated every lap`);
    this.verdict = el('div', 'pt-verdict');
    const tiles = el('div', 'pt-strat-tiles');
    this.tLaps = tile('Laps possible');
    this.tLimit = tile('Power limit');
    this.tFinish = tile('Finish SoC');
    this.tLap = tile('Energy per lap');
    tiles.append(this.tLaps.root, this.tLimit.root, this.tFinish.root, this.tLap.root);
    const charts = el('div', 'pt-strat-charts');
    const h1 = el('div', 'pt-chart');
    const h2 = el('div', 'pt-chart');
    charts.append(h1, h2);
    c.append(this.verdict, tiles, charts);
    parent.append(c);

    const cap = vehicleNum(app, 'accumulator.cell.capacity_ah', 4) * vehicleNum(app, 'accumulator.parallel', 4);
    this.car = {
      packEnergyKwh: (vehicleNum(app, 'accumulator.series', 140) * cap * vehicleNum(app, 'accumulator.cell.v_nom', 3.6)) / 1000,
      limitKw: vehicleNum(app, 'powertrain.power_limit_kw', 80),
      socMinPct: vehicleNum(app, 'accumulator.soc_window.min', 0.05) * 100,
    };
    this.bars = new BarChart(h1, {
      title: 'Energy per lap', mode: 'grouped', y: { label: 'Energy per lap', unit: 'kWh', decimals: 3 },
      series: [{ label: 'Net used', color: seriesColor(1) }, { label: 'Regen', color: seriesColor(2) }],
      empty: 'No completed laps yet',
    });
    this.curve = new XYChart(h2, {
      title: 'Predicted energy per lap vs power limit',
      x: { label: 'Power limit', unit: 'kW', decimals: 0 },
      y: { label: 'Energy / lap', unit: 'kWh', decimals: 3 },
      // the budget is a dashed limit line drawn as a second series, so the legend names it
      series: [{ label: 'Energy per lap', color: seriesColor(1) },
        { label: 'Budget per lap', color: theme().status.warning, mode: 'line', dash: [5, 4], width: 1.5 }],
      empty: 'Runs after the first lap',
    });
    this.dirty = true;
    const mark = () => { this.dirty = true; };
    app.on('lap', mark);
    app.on('strategy', mark);
    app.on('hello', mark);
  }

  /** Refresh (call at ~2-10 Hz; charts only change on lap / strategy events). @param {object} app */
  update(app) {
    const s = app.strategy;
    const v = strategyVerdict(s, this.car);
    // live tiles (calc_* update every tick)
    const possible = isNum(app.val('calc_laps_remaining')) ? app.val('calc_laps_remaining') : s && s.laps_possible;
    const needed = isNum(app.val('calc_laps_needed')) ? app.val('calc_laps_needed') : lapsLeft(s);
    this.tLaps.set(`${num(possible, 1)}`, `/ ${num(needed, 0)} needed`,
      isNum(possible) && isNum(needed) ? (possible >= needed ? `+${num(possible - needed, 1)} laps margin` : `short ${num(needed - possible, 1)} laps`) : 'after the first lap',
      isNum(possible) && isNum(needed) && possible < needed ? 'warning' : '');
    const rec = isNum(app.val('calc_power_limit_rec')) ? app.val('calc_power_limit_rec') : s && s.recommended_kw;
    this.tLimit.set(num(rec, 0), 'kW rec.', isNum(v.currentKw) ? `now ${num(v.currentKw, 0)} kW${s && isNum(s.current_kw) ? '' : ' (config)'}` : '',
      v.short ? 'warning' : '');
    const fin = isNum(v.finishAtCurrent) && !v.short ? v.finishAtCurrent : s && s.predicted_finish_soc;
    this.tFinish.set(num(fin, 1), '%', s ? (v.short ? `at ${num(rec, 0)} kW (rec.)` : `at ${num(isNum(v.finishAtCurrent) ? v.currentKw : rec, 0)} kW`) : '',
      isNum(fin) && fin < this.car.socMinPct ? 'critical' : '');
    const left = lapsLeft(s);
    const avail = s ? (isNum(s.energy_available_kwh) ? s.energy_available_kwh : s.energy_remaining_kwh) : NaN;
    const budget = isNum(avail) && isNum(left) && left > 0 ? avail / left : NaN;
    this.tLap.set(num(s && s.energy_per_lap_kwh, 3), 'kWh', isNum(budget) ? `budget ${num(budget, 3)} kWh/lap` : 'measured');

    if (!this.dirty) return;
    this.dirty = false;
    setData(this.verdict, 'level', v.level);
    const msg = el('span', '', v.text);
    this.verdict.replaceChildren(...(v.level ? [sevPill(v.level === 'ok' ? 'ok' : v.level, v.level === 'ok' ? 'Finish' : 'Short'), msg] : [msg]));

    const laps = (app.laps || []).slice(-MAX_BARS);
    this.bars.setData(laps.map((l) => `L${l.lap}`), [laps.map((l) => l.energy_kwh), laps.map((l) => l.regen_kwh)]);
    const curve = (s && Array.isArray(s.curve) ? s.curve : []).filter((p) => isNum(p.kw) && isNum(p.energy_kwh));
    this.curve.setSeries(0, curve.map((p) => p.kw), curve.map((p) => p.energy_kwh));
    const iRec = curve.findIndex((p) => isNum(rec) && Math.abs(p.kw - rec) < 0.5);
    this.curve.setHighlights(iRec >= 0 ? [{ series: 0, index: iRec, label: `rec. ${num(rec, 0)} kW` }] : []);
    const kws = curve.map((p) => p.kw);
    this.curve.setSeries(1, isNum(budget) && kws.length ? [Math.min(...kws), Math.max(...kws)] : [],
      isNum(budget) && kws.length ? [budget, budget] : []);
    this.curve.setVLines(curve.length && isNum(v.currentKw) && Math.abs(v.currentKw - rec) > 0.5 ? [{ value: v.currentKw, label: 'now', level: 'neutral' }] : []);
  }
}
