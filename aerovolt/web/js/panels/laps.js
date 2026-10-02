/**
 * @file Laps tab: the endurance strategy summary, the lap table (best lap highlighted) and
 * per-lap charts - lap-time trend, energy per lap (net used vs regen), CL·A / CD·A per lap -
 * plus the strategy curves from `strategy.curve` (energy per lap and lap time vs the power
 * limit, with the per-lap energy budget and the recommended limit marked).
 *
 * Strategy logic (computed by the server, analysis/strategy.py): with E_avail the usable
 * energy left above the SoC-window minimum minus the reserve, and N laps still to drive, the
 * car can afford E_avail / N kWh per lap. The lap simulator predicts the energy per lap for
 * each power limit; the recommended limit is the highest one whose predicted energy per lap
 * (scaled by measured / predicted of the laps so far) fits the budget.
 */

import { BarChart, XYChart, seriesColor } from '../lib/charts.js';
import { formatLapTime, formatNumber, formatDelta, isNum, kmh } from '../lib/format.js';
import { sevPill } from './alerts.js';

let ui = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function card(cls, title, sub) {
  const c = el('div', `card ${cls}`);
  const h = el('div', 'card-head');
  h.append(el('h2', 'card-title', title));
  if (sub) h.append(el('span', 'card-sub', sub));
  c.append(h);
  return c;
}

/**
 * Build the Laps tab.
 * @param {HTMLElement} root
 * @param {object} app
 */
export function mount(root, app) {
  root.innerHTML = '';
  const grid = el('div', 'laps-grid');

  // strategy
  const strat = card('laps-strategy', 'Endurance energy strategy', 'updated after every lap');
  const tiles = el('div', 'strat-tiles');
  const tileDefs = [
    ['laps', 'Laps done / total'], ['remaining', 'Energy left'], ['perlap', 'Energy per lap'],
    ['possible', 'Laps possible'], ['rec', 'Recommended limit'], ['finish', 'Predicted finish SoC'],
  ];
  const t = {};
  for (const [k, label] of tileDefs) {
    const d = el('div', 'tile');
    const v = el('span', 'tile-value', '—');
    const s = el('span', 'tile-sub', ' ');
    d.append(el('span', 'tile-label', label), v, s);
    t[k] = { v, s };
    tiles.append(d);
  }
  const verdict = el('div', 'strat-verdict');
  tiles.append(verdict);
  strat.append(tiles);

  // table
  const tableCard = card('laps-table-card', 'Lap summary');
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data');
  wrap.append(table);
  tableCard.append(wrap);

  // per-lap charts
  const c1 = card('laps-chart', 'Lap time', 'per lap');
  const c2 = card('laps-chart', 'Energy per lap', 'battery side');
  const c3 = card('laps-chart', 'CL·A and CD·A', 'lap average');
  const c4 = card('laps-chart wide', 'Energy per lap vs power limit', 'lap simulator, scaled to measured');
  const c5 = card('laps-chart wide', 'Lap time vs power limit', 'lap simulator');
  const hosts = [c1, c2, c3, c4, c5].map((c) => {
    const h = el('div', 'chart-host');
    c.append(h);
    return h;
  });
  grid.append(strat, tableCard, c1, c2, c3, c4, c5);
  root.append(grid);

  const lapFmt = (v) => (Number.isInteger(Math.round(v * 1000) / 1000) ? `${Math.round(v)}` : '');
  ui = {
    t, verdict, table, dirty: true,
    lapTime: new XYChart(hosts[0], {
      title: 'Lap time per lap', x: { label: 'Lap', format: lapFmt, decimals: 0 },
      y: { label: 'Lap time', unit: 's', decimals: 2 },
      series: [{ label: 'Lap time', color: seriesColor(0) }], empty: 'No completed laps yet',
    }),
    energy: new BarChart(hosts[1], {
      title: 'Energy per lap', mode: 'grouped', y: { label: 'Energy', unit: 'kWh', decimals: 3 },
      series: [{ label: 'Net used', color: seriesColor(1) }, { label: 'Regen recovered', color: seriesColor(2) }],
      empty: 'No completed laps yet',
    }),
    aero: new XYChart(hosts[2], {
      title: 'CL·A and CD·A per lap', x: { label: 'Lap', format: lapFmt, decimals: 0 },
      y: { label: 'Area', unit: 'm²', decimals: 3, includeZero: true },
      series: [{ label: 'CL·A', color: seriesColor(2) }, { label: 'CD·A', color: seriesColor(6) }],
      empty: 'No completed laps yet',
    }),
    curveE: new XYChart(hosts[3], {
      title: 'Predicted energy per lap vs power limit', x: { label: 'Power limit', unit: 'kW', decimals: 0 },
      y: { label: 'Energy / lap', unit: 'kWh', decimals: 3 },
      series: [{ label: 'Energy per lap', color: seriesColor(1) }], empty: 'Strategy runs after the first lap',
    }),
    curveT: new XYChart(hosts[4], {
      title: 'Predicted lap time vs power limit', x: { label: 'Power limit', unit: 'kW', decimals: 0 },
      y: { label: 'Lap time', unit: 's', decimals: 2 },
      series: [{ label: 'Lap time', color: seriesColor(0) }], empty: 'Strategy runs after the first lap',
    }),
  };
  const mark = () => { ui.dirty = true; };
  app.on('lap', mark);
  app.on('strategy', mark);
  app.on('hello', mark);
}

/** Per-frame: re-render only when laps or strategy changed. */
export function update(app) {
  if (!ui || !ui.dirty) return;
  ui.dirty = false;
  renderStrategy(app);
  renderTable(app);
  renderCharts(app);
}

const n = (v, d) => (isNum(v) ? formatNumber(v, d) : '—');

function lapsLeft(s) {
  if (isNum(s.laps_left)) return s.laps_left;
  if (isNum(s.laps_needed) && isNum(s.laps_done)) return Math.max(0, s.laps_needed - s.laps_done);
  return NaN;
}

function renderStrategy(app) {
  const s = app.strategy;
  const { t, verdict } = ui;
  const set = (k, v, sub) => { t[k].v.textContent = v; t[k].s.textContent = sub || ' '; };
  if (!s) {
    for (const k of Object.keys(t)) set(k, '—');
    t.laps.s.textContent = 'waiting for the first lap';
    verdict.dataset.level = '';
    verdict.replaceChildren(document.createTextNode('The strategy is computed after the first completed lap.'));
    return;
  }
  const left = lapsLeft(s);
  const total = isNum(s.laps_done) && isNum(left) ? s.laps_done + left : s.laps_needed;
  set('laps', `${n(s.laps_done, 0)} / ${n(total, 0)}`, isNum(left) ? `${n(left, 0)} to go` : '');
  const avail = isNum(s.energy_available_kwh) ? s.energy_available_kwh : s.energy_remaining_kwh;
  set('remaining', `${n(s.energy_remaining_kwh, 2)} kWh`, isNum(avail) && isNum(left) && left > 0 ? `budget ${n(avail / left, 3)} kWh/lap` : '');
  set('perlap', `${n(s.energy_per_lap_kwh, 3)} kWh`, isNum(s.current_kw) ? `measured at ~${n(s.current_kw, 0)} kW` : 'measured');
  const possible = isNum(s.laps_possible) ? s.laps_possible : app.val('calc_laps_remaining');
  set('possible', n(possible, 1), isNum(left) ? `need ${n(left, 0)}` : '');
  set('rec', `${n(s.recommended_kw, 0)} kW`, isNum(s.current_kw) ? `now ~${n(s.current_kw, 0)} kW` : '');
  set('finish', `${n(s.predicted_finish_soc, 1)} %`, 'at the recommended limit');
  const short = s.energy_short === true || (isNum(possible) && isNum(left) && possible < left);
  verdict.dataset.level = short ? 'warn' : 'ok';
  const msg = el('div');
  const b = el('b', '', short ? 'Energy short at the current pace. ' : 'On target. ');
  msg.append(b, document.createTextNode(short
    ? `Lower the power limit to ${n(s.recommended_kw, 0)} kW to finish the remaining ${n(left, 0)} laps with ${n(s.predicted_finish_soc, 1)} % SoC.`
    : `The car finishes the remaining ${n(left, 0)} laps; the highest safe power limit is ${n(s.recommended_kw, 0)} kW.`));
  verdict.replaceChildren(sevPill(short ? 'warn' : 'ok', short ? 'Short' : 'OK'), msg);
}

function renderTable(app) {
  const laps = app.laps;
  const best = app.bestLap;
  const cols = [
    ['Lap', (l) => String(l.lap)],
    ['Time', (l) => formatLapTime(l.lap_time, 3)],
    ['Δ best', (l) => (best && l !== best ? formatDelta(l.lap_time - best.lap_time, 3) : '—')],
    ['v avg km/h', (l) => n(kmh(l.v_avg), 1)],
    ['v max km/h', (l) => n(kmh(l.v_max), 1)],
    ['Energy kWh', (l) => n(l.energy_kwh, 3)],
    ['Regen kWh', (l) => n(l.regen_kwh, 3)],
    ['CL·A m²', (l) => n(l.cla_avg, 3)],
    ['CD·A m²', (l) => n(l.cda_avg, 3)],
    ['Balance % F', (l) => n(l.balance_avg, 1)],
    ['Cell T max °C', (l) => n(l.cell_t_max, 1)],
    ['Cell V min V', (l) => n(l.cell_v_min, 3)],
    ['Motor T max °C', (l) => n(l.mot_temp_max, 1)],
  ];
  const thead = el('thead');
  const hr = el('tr');
  for (const [h] of cols) hr.append(el('th', '', h));
  thead.append(hr);
  const tbody = el('tbody');
  if (!laps.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'No completed laps yet. Laps are timed at the start/finish line.');
    td.colSpan = cols.length;
    td.style.textAlign = 'left';
    tr.append(td);
    tbody.append(tr);
  }
  for (const l of [...laps].reverse()) {
    const tr = el('tr');
    if (l === best) tr.className = 'best';
    cols.forEach(([, f], i) => {
      const td = el('td', '', f(l));
      if (i === 0 && l === best) td.append(el('span', 'best-tag', 'BEST'));
      tr.append(td);
    });
    tbody.append(tr);
  }
  ui.table.replaceChildren(thead, tbody);
}

function renderCharts(app) {
  const laps = app.laps;
  const best = app.bestLap;
  const bestIdx = best ? laps.indexOf(best) : -1;
  const lapNo = laps.map((l) => l.lap);
  ui.lapTime.setSeries(0, lapNo, laps.map((l) => l.lap_time));
  ui.lapTime.setHighlights(bestIdx >= 0 ? [{ series: 0, index: bestIdx, label: `best ${formatLapTime(best.lap_time, 2)}` }] : []);
  ui.lapTime.setAxes({ x: laps.length < 2 ? { min: 0, max: Math.max(2, (lapNo[0] || 0) + 1) } : { min: undefined, max: undefined } });
  ui.energy.setData(laps.map((l) => `L${l.lap}`), [laps.map((l) => l.energy_kwh), laps.map((l) => l.regen_kwh)]);
  ui.energy.setHighlight(bestIdx);
  ui.aero.setSeries(0, lapNo, laps.map((l) => l.cla_avg));
  ui.aero.setSeries(1, lapNo, laps.map((l) => l.cda_avg));
  ui.aero.setAxes({ x: laps.length < 2 ? { min: 0, max: Math.max(2, (lapNo[0] || 0) + 1) } : { min: undefined, max: undefined } });

  const s = app.strategy;
  const curve = (s && Array.isArray(s.curve)) ? [...s.curve].sort((a, b) => a.kw - b.kw) : [];
  const kw = curve.map((c) => c.kw);
  ui.curveE.setSeries(0, kw, curve.map((c) => c.energy_kwh));
  ui.curveT.setSeries(0, kw, curve.map((c) => c.lap_time));
  const recIdx = s ? kw.indexOf(s.recommended_kw) : -1;
  const hl = recIdx >= 0 ? [{ series: 0, index: recIdx, label: `recommended ${s.recommended_kw} kW` }] : [];
  ui.curveE.setHighlights(hl);
  ui.curveT.setHighlights(hl);
  const left = s ? lapsLeft(s) : NaN;
  const avail = s ? (isNum(s.energy_available_kwh) ? s.energy_available_kwh : s.energy_remaining_kwh) : NaN;
  ui.curveE.setHLines(isNum(avail) && isNum(left) && left > 0
    ? [{ value: avail / left, label: `budget ${formatNumber(avail / left, 3)} kWh/lap`, level: 'warning' }] : []);
  const vl = s && isNum(s.current_kw) ? [{ value: s.current_kw, label: `now ~${Math.round(s.current_kw)} kW` }] : [];
  ui.curveE.setVLines(vl);
  ui.curveT.setVLines(vl);
}
