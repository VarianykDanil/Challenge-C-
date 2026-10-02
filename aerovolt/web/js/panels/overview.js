/**
 * @file Overview tab - the pit-wall "first glance" page.
 *
 * Layout: hero (speed, lap, lap time and live delta to the best lap) + stat tiles (SoC, pack
 * power, downforce, aero balance, CL·A, hottest cell, motor temperature, energy), the live
 * track map, two strip charts (speed & downforce; pack power & SoC - each pair in separate
 * lanes, never on a dual axis), health tiles for System 1 (aero) and System 2 (powertrain)
 * coloured by their active alerts, and a short list of active alerts.
 *
 * Live delta to best: while a lap runs, the panel records (lap distance, lap time) pairs. When
 * a lap event reports a new best lap, that lap's trace becomes the reference, and the delta
 * is `t_now − t_ref(d_now)` with `t_ref` linearly interpolated at the current lap distance -
 * the same "delta bar" race engineers use. Negative = faster than the best lap.
 */

import { StripChart, seriesColor } from '../lib/charts.js';
import { colorbar } from '../lib/colormap.js';
import { formatLapTime, formatNumber, formatDelta, isNum } from '../lib/format.js';
import { TrackMap, TRAIL_CHANNELS } from './trackmap.js';
import { sevPill, SEVERITY_RANK, alertAge } from './alerts.js';

/* ================================================================== lap delta */

/**
 * Records lap traces and computes the live delta to the best lap's trace.
 */
export class LapDelta {
  /** @param {number} [trackLength=0]  lap length [m] (wraps distances measured from another origin) */
  constructor(trackLength = 0) {
    this.trackLength = trackLength;
    /** @type {Map<number, {d: number[], t: number[], d0: number}>} */
    this.traces = new Map();
    this.ref = null;
    this.refLap = NaN;
    this.lastLap = NaN;
  }

  /** Forget everything (new session). */
  reset() {
    this.traces.clear();
    this.ref = null;
    this.refLap = NaN;
    this.lastLap = NaN;
  }

  /**
   * Add a sample of the running lap.
   * @param {number} lap   current lap number (calc_lap)
   * @param {number} dist  distance into the lap [m] (calc_lap_dist)
   * @param {number} time  lap time so far [s] (calc_lap_time)
   */
  sample(lap, dist, time) {
    if (!isNum(lap) || !isNum(dist) || !isNum(time)) return;
    let tr = this.traces.get(lap);
    if (!tr) {
      // distances are stored relative to the first sample of the lap, so the delta also works
      // when the lap-distance channel is measured from a different origin than the line
      tr = { d: [], t: [], d0: dist };
      this.traces.set(lap, tr);
      for (const k of this.traces.keys()) if (k < lap - 3 && k !== this.refLap) this.traces.delete(k);
    }
    const d = this.relative(dist, tr.d0);
    // A lap time that went backwards means the first sample still carried the previous lap's
    // time (the lap counter and the lap clock updated in different frames): start over.
    if (tr.t.length && time < tr.t[tr.t.length - 1]) { tr.d = []; tr.t = []; }
    const n = tr.d.length;
    if (n && d <= tr.d[n - 1]) return; // keep it monotonic for interpolation
    tr.d.push(d);
    tr.t.push(time);
    this.lastLap = lap;
  }

  /** Distance since the lap's first sample, wrapped by the track length when known. */
  relative(dist, d0) {
    let d = dist - d0;
    if (d < -1 && this.trackLength > 0) d += this.trackLength;
    return d;
  }

  /**
   * A lap was completed: if it is the best so far, make its trace the reference. The trace is
   * the recorded one whose duration best matches the reported lap time (robust to lap
   * numbering differences).
   * @param {{lap: number, lap_time: number}} summary
   * @param {number} bestTime  best lap time of the session (including this lap)
   */
  onLap(summary, bestTime) {
    if (!summary || !isNum(summary.lap_time) || summary.lap_time > bestTime + 1e-6) return;
    let best = null, err = Infinity;
    for (const [lap, tr] of this.traces) {
      const n = tr.t.length;
      // need a complete trace: enough samples and recorded from the start of the lap (a lap
      // that was already running when the page connected is not usable); the running lap is
      // excluded by the duration match below
      if (n < 20 || tr.t[0] > Math.max(1, 0.03 * summary.lap_time)) continue;
      const e = Math.abs(tr.t[n - 1] - summary.lap_time);
      if (e < err) { err = e; best = [lap, tr]; }
    }
    if (best && err < Math.max(2, summary.lap_time * 0.05)) {
      this.refLap = best[0];
      this.ref = { d: Float64Array.from(best[1].d), t: Float64Array.from(best[1].t), lapTime: summary.lap_time };
    }
  }

  /**
   * Delta [s] of the running lap vs the reference at distance `dist` (NaN if unknown).
   * @param {number} dist
   * @param {number} time
   */
  delta(dist, time) {
    const r = this.ref;
    const cur = this.traces.get(this.lastLap);
    if (!r || !cur || !isNum(dist) || !isNum(time) || r.d.length < 2) return NaN;
    const d = this.relative(dist, cur.d0);
    if (d < 0 || d > r.d[r.d.length - 1]) return NaN;
    let lo = 0, hi = r.d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (r.d[mid] <= d) lo = mid; else hi = mid;
    }
    const f = Math.min(1, Math.max(0, (d - r.d[lo]) / Math.max(1e-9, r.d[hi] - r.d[lo])));
    return time - (r.t[lo] + f * (r.t[hi] - r.t[lo]));
  }
}

/* ================================================================== helpers */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Severity level of value `v` from the channel's warn/crit thresholds (high and low side). */
export function levelOf(def, v) {
  if (!def || !isNum(v)) return '';
  if ((isNum(def.crit_hi) && v >= def.crit_hi) || (isNum(def.crit_lo) && v <= def.crit_lo)) return 'critical';
  if ((isNum(def.warn_hi) && v >= def.warn_hi) || (isNum(def.warn_lo) && v <= def.warn_lo)) return 'warning';
  return '';
}

/**
 * Which system an alert belongs to: by id prefix, else by its channels' systems.
 * @param {object} app
 * @param {object} a  alert
 * @returns {'aero'|'powertrain'|'other'}
 */
export function alertSystem(app, a) {
  const id = a.id || '';
  if (id.startsWith('aero_')) return 'aero';
  if (/^(bms_|cooling_|motor_|inverter_|safety_|energy_)/.test(id)) return 'powertrain';
  for (const c of a.channels || []) {
    const def = app.channels.get(c);
    if (!def) continue;
    if (def.system === 'aero' || def.group === 'calc.aero' || def.group === 'calc.cp') return 'aero';
    if (def.system === 'powertrain' || def.group === 'calc.powertrain' || def.group === 'calc.energy') return 'powertrain';
  }
  return 'other';
}

/* ================================================================== panel */

/** @type {any} */
let ui = null;

/**
 * Build the Overview tab.
 * @param {HTMLElement} root
 * @param {object} app
 */
export function mount(root, app) {
  root.innerHTML = '';
  const grid = el('div', 'ov-grid');

  // ---- KPI row
  const kpis = el('div', 'ov-kpis');
  const hero = el('div', 'card hero-card');
  hero.innerHTML = `
    <div class="hero">
      <div class="tile hero-speed">
        <span class="tile-label">Speed</span>
        <span class="tile-value"><span data-k="speed">—</span><span class="unit">km/h</span></span>
      </div>
      <div class="hero-lap">
        <span class="tile-label" data-k="lapLabel">Lap —</span>
        <span class="tile-value" data-k="lapTime">—</span>
        <span class="delta delta-flat" data-k="delta">—</span>
        <span class="tile-sub" data-k="best">Best —</span>
      </div>
    </div>`;
  kpis.append(hero);
  const tiles = {};
  const tileDefs = [
    ['soc', 'SoC (EKF)', '%'],
    ['power', 'Pack power', 'kW'],
    ['downforce', 'Downforce', 'N'],
    ['balance', 'Aero balance', '% F'],
    ['cla', 'CL·A', 'm²'],
    ['cellt', 'Cell T max', '°C'],
    ['mott', 'Motor T', '°C'],
    ['energy', 'Energy used', 'kWh'],
  ];
  for (const [key, label, unit] of tileDefs) {
    const c = el('div', 'card tile');
    c.innerHTML = `<span class="tile-label"></span>
      <span class="tile-value"><span data-v>—</span><span class="unit"></span></span>
      <span class="tile-sub" data-s>&nbsp;</span>`;
    c.querySelector('.tile-label').textContent = label;
    c.querySelector('.unit').textContent = unit;
    tiles[key] = { root: c, v: c.querySelector('[data-v]'), s: c.querySelector('[data-s]') };
    kpis.append(c);
  }
  grid.append(kpis);

  // ---- track map
  const trackCard = el('div', 'card ov-track');
  const th = el('div', 'card-head');
  th.append(el('h2', 'card-title', 'Track'), el('span', 'card-sub', 'last 2 min'), el('span', 'spacer'));
  const sel = el('select', 'select');
  sel.setAttribute('aria-label', 'Colour the trail by');
  for (const [k, c] of Object.entries(TRAIL_CHANNELS)) {
    const o = el('option', '', `Colour: ${c.label}`);
    o.value = k;
    sel.append(o);
  }
  th.append(sel);
  const trackHost = el('div', 'track-host');
  const foot = el('div', 'track-foot');
  const cbEl = el('div');
  foot.append(cbEl);
  trackCard.append(th, trackHost, foot);
  grid.append(trackCard);

  // ---- strip charts
  const strips = el('div', 'ov-strips');
  const s1 = el('div', 'card');
  const s1h = el('div', 'card-head');
  s1h.append(el('h2', 'card-title', 'Speed & downforce'), el('span', 'card-sub', 'last 60 s'));
  const s1c = el('div');
  s1.append(s1h, s1c);
  const s2 = el('div', 'card');
  const s2h = el('div', 'card-head');
  s2h.append(el('h2', 'card-title', 'Pack power & state of charge'), el('span', 'card-sub', 'last 60 s'));
  const s2c = el('div');
  s2.append(s2h, s2c);
  strips.append(s1, s2);
  grid.append(strips);

  // ---- health + alerts
  const aeroCard = el('div', 'card ov-health health');
  const ptCard = el('div', 'card ov-health health');
  const alertCard = el('div', 'card ov-alerts');
  grid.append(aeroCard, ptCard, alertCard);
  root.append(grid);

  const health = {
    aero: buildHealth(aeroCard, 'System 1 · Aero', [
      ['taps', 'Taps live'], ['cla', 'CL·A'], ['balance', 'Balance'], ['q', 'Dyn. pressure q'],
    ]),
    pt: buildHealth(ptCard, 'System 2 · Powertrain', [
      ['cells', 'Cells live'], ['dv', 'Cell ΔV'], ['tmax', 'T max'], ['sdc', 'SDC'],
    ]),
  };
  const ah = el('div', 'card-head');
  const viewAll = el('button', 'btn btn-ghost', 'All alerts');
  viewAll.type = 'button';
  viewAll.addEventListener('click', () => app.ui.openDrawer('alerts'));
  ah.append(el('h2', 'card-title', 'Active alerts'), el('span', 'card-sub'), el('span', 'spacer'), viewAll);
  const alertList = el('ul', 'mini-alerts');
  alertCard.append(ah, alertList);

  // ---- charts
  const limitKw = (app.meta && app.meta.vehicle && app.meta.vehicle.powertrain && app.meta.vehicle.powertrain.power_limit_kw) || 80;
  const regenKw = (app.meta && app.meta.vehicle && app.meta.vehicle.powertrain && app.meta.vehicle.powertrain.regen_max_kw) || 30;
  const src = (id) => (s) => app.hist.series(id, s);
  const speedChart = new StripChart(s1c, {
    title: 'Speed and downforce, last 60 seconds',
    window: 60,
    lanes: [
      { label: 'Speed', unit: 'km/h', min: 0, softMax: 60, decimals: 0 },
      { label: 'Downforce', unit: 'N', includeZero: true, decimals: 0 },
    ],
    series: [
      { label: 'Speed', lane: 0, scale: 3.6, source: src('gps_speed'), color: seriesColor(0), fill: true },
      { label: 'Downforce', lane: 1, source: src('calc_downforce'), color: seriesColor(2), fill: true },
    ],
  });
  const socSeries = [
    { label: 'Pack power', lane: 0, source: src('calc_pack_power'), color: seriesColor(1), fill: true },
    { label: 'SoC EKF', lane: 1, source: src('calc_soc_ekf'), color: seriesColor(0) },
    { label: 'SoC CC', lane: 1, source: src('calc_soc_cc'), color: seriesColor(6), dash: [5, 4], width: 1.6 },
  ];
  if (app.channels.has('truth_soc') && app.mode !== 'LIVE') {
    socSeries.push({ label: 'SoC truth', lane: 1, source: src('truth_soc'), color: seriesColor(3), dash: [2, 3], width: 1.6 });
  }
  const powerChart = new StripChart(s2c, {
    title: 'Pack power and state of charge, last 60 seconds',
    window: 60,
    lanes: [
      { label: 'Pack power', unit: 'kW', includeZero: true, decimals: 1,
        thresholds: [{ value: limitKw, label: `FS limit ${limitKw} kW`, level: 'critical' }, { value: -regenKw, label: `regen max`, level: 'neutral' }] },
      { label: 'SoC', unit: '%', decimals: 1 },
    ],
    series: socSeries,
  });
  s1c.className = 'chart-host';
  s2c.className = 'chart-host';

  const map = new TrackMap(trackHost, { channel: 'speed', trailSeconds: 120 });
  map.setTrack(app.meta && app.meta.track, app.meta && app.meta.vehicle && app.meta.vehicle.gps_origin);
  const cb = colorbar(cbEl, map.legendOptions());
  sel.addEventListener('change', () => { map.setChannel(sel.value); ui.legendKey = ''; });

  const lapDelta = new LapDelta((app.meta && app.meta.track && app.meta.track.length_m) || 0);

  ui = {
    app, hero, tiles, health, alertList, alertHead: ah.querySelector('.card-sub'),
    speedChart, powerChart, map, cb, lapDelta, legendKey: '',
    acc: { kpi: Infinity, chart: Infinity, health: Infinity, legend: Infinity },
    lastT: NaN, alertsDirty: true,
  };

  app.on('hello', (msg) => {
    if (!ui) return;
    ui.map.setTrack(msg.track, msg.vehicle && msg.vehicle.gps_origin);
    ui.lapDelta.reset();
    ui.lapDelta.trackLength = (msg.track && msg.track.length_m) || 0;
    ui.alertsDirty = true;
  });
  app.on('lap', (lap) => {
    const best = app.bestLap;
    ui.lapDelta.onLap(lap, best ? best.lap_time : Infinity);
  });
  app.on('alert', () => { ui.alertsDirty = true; });
  app.on('alertlog', () => { ui.alertsDirty = true; });
}

function buildHealth(card, title, metrics) {
  const head = el('div', 'card-head');
  const pillHost = el('span');
  head.append(el('h2', 'card-title', title), el('span', 'spacer'), pillHost);
  const m = el('div', 'health-metrics');
  const cells = {};
  for (const [key, label] of metrics) {
    const t = el('div', 'tile');
    const v = el('span', 'tile-value', '—');
    const s = el('span', 'tile-sub', ' ');
    t.append(el('span', 'tile-label', label), v, s);
    cells[key] = { root: t, v, s };
    m.append(t);
  }
  const line = el('div', 'health-alert', '');
  card.append(head, m, line);
  return { card, pillHost, cells, line, level: null };
}

function setText(e, s) {
  if (e.textContent !== s) e.textContent = s;
}

function setLevel(e, lvl) {
  if ((e.dataset.level || '') !== lvl) {
    if (lvl) e.dataset.level = lvl; else delete e.dataset.level;
  }
}

/**
 * Per-frame update (throttled: tiles 10 Hz, charts 10 Hz, health 4 Hz).
 * @param {object} app
 * @param {number} dtMs
 */
export function update(app, dtMs) {
  if (!ui) return;
  const a = ui.acc;
  a.kpi += dtMs; a.chart += dtMs; a.health += dtMs; a.legend += dtMs;
  ui.map.update(app, dtMs);
  if (app.t !== ui.lastT) {
    ui.lastT = app.t;
    ui.lapDelta.sample(app.val('calc_lap'), app.val('calc_lap_dist'), app.val('calc_lap_time'));
  }
  if (a.kpi >= 100) { a.kpi = 0; updateKpis(app); }
  if (a.chart >= 100) {
    a.chart = 0;
    ui.speedChart.pull(app.t);
    ui.powerChart.pull(app.t);
  }
  if (a.health >= 250) { a.health = 0; updateHealth(app); }
  if (a.legend >= 500) {
    a.legend = 0;
    const o = ui.map.legendOptions();
    const key = `${ui.map.channel}:${o.vmin}:${o.vmax}`;
    if (key !== ui.legendKey) { ui.legendKey = key; ui.cb.update(o); }
  }
}

function updateKpis(app) {
  const { hero, tiles } = ui;
  const q = (k) => hero.querySelector(`[data-k="${k}"]`);
  const v = app.val('gps_speed');
  setText(q('speed'), isNum(v) ? formatNumber(v * 3.6, 0) : '—');
  const lap = app.val('calc_lap');
  setText(q('lapLabel'), isNum(lap) ? (lap < 1 ? 'Out lap' : `Lap ${formatNumber(lap, 0)}`) : 'Lap —');
  const lt = app.val('calc_lap_time');
  setText(q('lapTime'), formatLapTime(lt, 2));
  const best = app.bestLap;
  const d = ui.lapDelta.delta(app.val('calc_lap_dist'), lt);
  const dEl = q('delta');
  if (isNum(d)) {
    setText(dEl, `${formatDelta(d, 2, 's')} to best`);
    dEl.className = `delta ${d < -0.005 ? 'delta-good' : d > 0.005 ? 'delta-bad' : 'delta-flat'}`;
  } else {
    const last = app.laps.length ? app.laps[app.laps.length - 1] : null;
    if (last && best && last !== best) {
      const dd = last.lap_time - best.lap_time;
      setText(dEl, `last lap ${formatDelta(dd, 2, 's')}`);
      dEl.className = 'delta delta-flat';
    } else {
      setText(dEl, best ? 'recording reference lap' : 'no timed lap yet');
      dEl.className = 'delta delta-flat';
    }
  }
  setText(q('best'), best ? `Best ${formatLapTime(best.lap_time, 2)} · lap ${best.lap}` : 'Best —');

  const set = (key, id, decimals, sub, scale = 1) => {
    const t = tiles[key];
    const val = app.val(id) * scale;
    setText(t.v, isNum(val) ? formatNumber(val, decimals) : '—');
    setText(t.s, sub);
    setLevel(t.root, levelOf(app.def(id), app.val(id)));
  };
  const f = (id, dec, unit = '') => {
    const x = app.val(id);
    return isNum(x) ? `${formatNumber(x, dec)}${unit ? ` ${unit}` : ''}` : '—';
  };
  const truth = app.channels.has('truth_soc') && isNum(app.val('truth_soc')) ? ` · truth ${f('truth_soc', 1)}` : '';
  set('soc', 'calc_soc_ekf', 1, `CC ${f('calc_soc_cc', 1)}${truth}`);
  const limit = app.meta && app.meta.vehicle && app.meta.vehicle.powertrain ? app.meta.vehicle.powertrain.power_limit_kw : 80;
  const rec = app.val('calc_power_limit_rec');
  set('power', 'calc_pack_power', 1, `limit ${limit} kW${isNum(rec) ? ` · rec ${formatNumber(rec, 0)}` : ''}`);
  set('downforce', 'calc_downforce', 0, `front ${f('calc_downforce_f', 0)} · rear ${f('calc_downforce_r', 0)}`);
  set('balance', 'calc_aero_balance', 1, 'target 40–50 % front');
  set('cla', 'calc_cla', 2, `CD·A ${f('calc_cda', 2)} · L/D ${f('calc_ld', 2)}`);
  const idx = app.val('calc_cell_t_max_idx');
  set('cellt', 'calc_cell_t_max', 1, `${isNum(idx) ? `sensor ${formatNumber(idx, 0)} · ` : ''}mean ${f('calc_cell_t_mean', 1)}`);
  set('mott', 'mot_winding_temp', 1, `inverter ${f('inv_igbt_temp', 1, '°C')}`);
  set('energy', 'calc_energy_used', 2, `regen ${f('calc_energy_regen', 2)} · laps left ${f('calc_laps_remaining', 1)}`);
}

function countLive(app, ids) {
  let live = 0;
  for (const id of ids) if (app.status(id) === 'live') live++;
  return live;
}

function updateHealth(app) {
  const { health } = ui;
  // alerts per system
  const bySys = { aero: [], powertrain: [] };
  for (const al of app.alerts.values()) {
    const s = alertSystem(app, al);
    if (bySys[s]) bySys[s].push(al);
  }
  const worst = (list) => list.reduce((w, x) => ((SEVERITY_RANK[x.severity] || 0) > (SEVERITY_RANK[w] || 0) ? x.severity : w), '');
  const apply = (h, list) => {
    const lvl = worst(list);
    const key = lvl || 'ok';
    if (h.level !== key) {
      h.level = key;
      h.card.dataset.level = lvl === 'critical' ? 'critical' : lvl === 'warn' ? 'warn' : 'ok';
      h.pillHost.replaceChildren(sevPill(lvl === 'critical' ? 'critical' : lvl === 'warn' ? 'warn' : lvl === 'info' ? 'info' : 'ok',
        lvl ? `${list.length} alert${list.length > 1 ? 's' : ''}` : 'Nominal'));
    }
    const top = [...list].sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0))[0];
    setText(h.line, top ? `${top.title}${top.detail ? ` · ${top.detail}` : ''}` : 'No active alerts');
  };
  apply(health.aero, bySys.aero);
  apply(health.pt, bySys.powertrain);

  // aero metrics
  if (!ui.tapIds) {
    ui.tapIds = [...app.channels.values()].filter((c) => c.group === 'aero.taps').map((c) => c.id);
    ui.cellV = [...app.channels.values()].filter((c) => c.group === 'bms.cell_v').map((c) => c.id);
    ui.cellT = [...app.channels.values()].filter((c) => c.group === 'bms.cell_t').map((c) => c.id);
    app.on('hello', () => { ui.tapIds = null; });
  }
  const c = health.aero.cells;
  const taps = countLive(app, ui.tapIds);
  setText(c.taps.v, `${taps}/${ui.tapIds.length}`);
  setLevel(c.taps.root, taps < ui.tapIds.length ? (taps < ui.tapIds.length - 2 ? 'critical' : 'warning') : '');
  setText(c.taps.s, taps === ui.tapIds.length ? 'all reporting' : `${ui.tapIds.length - taps} not live`);
  setText(c.cla.v, app.fmt('calc_cla'));
  setText(c.cla.s, `truth ${app.channels.has('truth_cla') ? app.fmt('truth_cla') : '—'}`);
  setText(c.balance.v, app.fmt('calc_aero_balance'));
  setLevel(c.balance.root, levelOf(app.def('calc_aero_balance'), app.val('calc_aero_balance')));
  setText(c.balance.s, 'front share');
  setText(c.q.v, app.fmt('calc_q'));
  setText(c.q.s, `airspeed ${isNum(app.val('calc_airspeed')) ? formatNumber(app.val('calc_airspeed') * 3.6, 0) : '—'} km/h`);

  // powertrain metrics
  const p = health.pt.cells;
  const cv = countLive(app, ui.cellV), ct = countLive(app, ui.cellT);
  setText(p.cells.v, `${cv}/${ui.cellV.length}`);
  setText(p.cells.s, `temps ${ct}/${ui.cellT.length}`);
  setLevel(p.cells.root, cv < ui.cellV.length || ct < ui.cellT.length ? 'warning' : '');
  setText(p.dv.v, app.fmt('calc_cell_v_delta'));
  setLevel(p.dv.root, levelOf(app.def('calc_cell_v_delta'), app.val('calc_cell_v_delta')));
  const vi = app.val('calc_cell_v_min_idx');
  setText(p.dv.s, `min ${app.fmt('calc_cell_v_min')}${isNum(vi) ? ` (#${formatNumber(vi, 0)})` : ''}`);
  setText(p.tmax.v, app.fmt('calc_cell_t_max'));
  setLevel(p.tmax.root, levelOf(app.def('calc_cell_t_max'), app.val('calc_cell_t_max')));
  setText(p.tmax.s, `coolant ${app.fmt('cool_temp_out')}`);
  const sdc = app.val('sdc_closed');
  setText(p.sdc.v, isNum(sdc) ? (sdc >= 0.5 ? 'Closed' : 'OPEN') : '—');
  setLevel(p.sdc.root, isNum(sdc) && sdc < 0.5 ? 'critical' : '');
  const imd = app.val('imd_ok'), ams = app.val('ams_ok'), bspd = app.val('bspd_ok');
  const flags = [['IMD', imd], ['AMS', ams], ['BSPD', bspd]].filter(([, x]) => isNum(x) && x < 0.5).map(([n]) => n);
  setText(p.sdc.s, flags.length ? `${flags.join(', ')} fault` : 'IMD, AMS, BSPD ok');

  // mini alert list: on change, and once a second for the "for m:ss" ages
  ui.miniTicks = (ui.miniTicks || 0) + 1;
  if (ui.alertsDirty || ui.miniTicks % 4 === 0) {
    ui.alertsDirty = false;
    renderMiniAlerts(app);
  }
}

function renderMiniAlerts(app) {
  const list = [...app.alerts.values()].sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0)
    || (y.t_start || 0) - (x.t_start || 0));
  setText(ui.alertHead, list.length ? `${list.length} active` : '');
  const ul = ui.alertList;
  ul.replaceChildren();
  if (!list.length) {
    const li = el('div', 'empty-ok');
    li.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    li.append(document.createTextNode('All clear: no active alerts.'));
    ul.append(li);
    return;
  }
  const max = window.innerHeight < 860 ? 3 : 4;
  for (const al of list.slice(0, max)) {
    const li = el('li');
    li.title = al.detail || '';
    li.append(sevPill(al.severity), el('span', 'title', al.title || al.id), el('span', 't', alertAge(al, app.t)));
    li.addEventListener('click', () => app.ui.openDrawer('alerts'));
    ul.append(li);
  }
  if (list.length > max) {
    const more = el('li');
    more.append(el('span', 't', ''), el('span', 'title muted', `+ ${list.length - max} more`), el('span', 't', ''));
    more.addEventListener('click', () => app.ui.openDrawer('alerts'));
    ul.append(more);
  }
}
