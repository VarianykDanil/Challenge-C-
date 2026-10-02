/**
 * @file Aero tab (System 1) - live 3D pressure map of the car plus the numbers and charts a
 * race engineer reads to judge the aero package.
 *
 * Layout
 * ------
 * * Left: {@link Car3D} - the car with the live Cp map, force arrows and flow streaks; view
 *   presets (Iso / Side / Top / Underside / Front) and display toggles in the card head.
 * * Right: key numbers (q, airspeed, ρ, flow yaw, CL·A estimate vs simulator truth, CD·A, L/D,
 *   aero balance, front/rear/total downforce, ride heights, front-wing asymmetry, floor Cp) and
 *   the active aero alerts.
 * * Cp distributions for each instrumented wing station (FW-L, FW-R, RW-L, RW-R) and the
 *   undertray centreline: live taps plus a dashed **baseline**, the running average of the
 *   first minute of valid running (q > 150 Pa) seen by this page (back-filled from the server
 *   history, so a fault injected before the page opened still shows against a clean
 *   baseline). Cp axes are inverted (negative up) - the aerodynamic convention, suction plots
 *   upward - and share one fixed scale so left vs right compares at a glance.
 * * Aero map: downforce vs dynamic pressure over the last 5 min, coloured by front ride height,
 *   with the least-squares line through the origin, slope = CL·A (L = q·CL·A).
 * * Strip charts: speed and downforce; section Cl of the four wing stations.
 *
 * Alert highlighting: every card and tile lists the channels it shows; an active aero alert
 * whose channels intersect them outlines it in the alert's severity. A tap flagged by
 * `sensor_tap_anomaly` is ringed ("suspect") in its Cp chart and on the 3D car.
 */

import { Car3D, VIEWS, DIFFUSER_START } from './car3d.js';
import { StripChart, XYChart, seriesColor } from '../lib/charts.js';
import { sequentialCss } from '../lib/colormap.js';
import { formatNumber, isNum } from '../lib/format.js';
import { levelOf, alertSystem } from './overview.js';
import { sevPill, alertAge, jumpToChannels, SEVERITY_RANK } from './alerts.js';

/* ================================================================== constants */

/** Fixed Cp axes (inverted in the charts): wings and floor. */
const WING_CP_AXIS = { min: -4.5, max: 1.2 };
const FLOOR_CP_AXIS = { min: -3.5, max: 0.8 };

/** Baseline: seconds of valid running averaged, and the q that counts as "valid" [Pa]. */
export const BASELINE_SECONDS = 60;
export const BASELINE_Q_MIN = 150;

/** CL·A is fitted only above this dynamic pressure [Pa] (SPEC §6: CL·A only when q > 120 Pa). */
const FIT_Q_MIN = 120;

/** Wing stations shown as Cp charts. */
const WING_STATIONS = [
  { key: 'fw-L', element: 'fw', station: 'L', title: 'Front wing · L', cl: 'calc_cl_fw_l' },
  { key: 'fw-R', element: 'fw', station: 'R', title: 'Front wing · R', cl: 'calc_cl_fw_r' },
  { key: 'rw-L', element: 'rw', station: 'L', title: 'Rear wing · L', cl: 'calc_cl_rw_l' },
  { key: 'rw-R', element: 'rw', station: 'R', title: 'Rear wing · R', cl: 'calc_cl_rw_r' },
];

/** Channels fetched with 5 min of history when the tab mounts (and after a hello). */
const HISTORY_IDS = [
  'calc_q', 'calc_airspeed', 'gps_speed', 'calc_downforce', 'calc_downforce_f', 'calc_downforce_r',
  'calc_cl_fw_l', 'calc_cl_fw_r', 'calc_cl_rw_l', 'calc_cl_rw_r', 'calc_cp_ut_mean', 'rh_front', 'rh_rear',
];

/* ================================================================== baseline */

/**
 * Running average of channels over the first `seconds` of valid running (q > qMin), weighted
 * by sample duration, then frozen. Samples must arrive in increasing time order.
 */
export class Baseline {
  /**
   * @param {string[]} ids
   * @param {number} [seconds]
   * @param {number} [qMin]  dynamic pressure [Pa] above which a sample counts
   */
  constructor(ids, seconds = BASELINE_SECONDS, qMin = BASELINE_Q_MIN) {
    this.ids = ids;
    this.seconds = seconds;
    this.qMin = qMin;
    this.reset();
  }

  /** Forget everything (new session). */
  reset() {
    this.sum = new Map(this.ids.map((id) => [id, 0]));
    this.weight = new Map(this.ids.map((id) => [id, 0]));
    this.learned = 0;
    this.lastT = NaN;
    /** session time of the first sample that counted (NaN until then) */
    this.firstT = NaN;
    this.frozen = false;
  }

  /**
   * Add one sample row.
   * @param {number} t      session time [s]
   * @param {number} q      dynamic pressure [Pa]
   * @param {(id: string) => number} get  value of a channel in this row
   */
  add(t, q, get) {
    if (this.frozen || !isNum(t)) return;
    if (isNum(this.lastT) && t <= this.lastT) return;
    const dt = isNum(this.lastT) ? Math.min(0.5, t - this.lastT) : 0.05;
    this.lastT = t;
    if (!(q > this.qMin)) return;
    if (!isNum(this.firstT)) this.firstT = t;
    for (const id of this.ids) {
      const v = get(id);
      if (!isNum(v)) continue;
      this.sum.set(id, this.sum.get(id) + v * dt);
      this.weight.set(id, this.weight.get(id) + dt);
    }
    this.learned += dt;
    if (this.learned >= this.seconds) this.frozen = true;
  }

  /** Baseline mean of a channel (NaN while nothing was learned). */
  mean(id) {
    const w = this.weight.get(id);
    return w > 0 ? this.sum.get(id) / w : NaN;
  }
}

/**
 * Least-squares line through the origin, y = k·x: k = Σxy / Σx² (minimises Σ(y − kx)²).
 * Used for the aero map (downforce = CL·A · q). Pairs with a non-finite value or x ≤ xMin are
 * ignored. Returns NaN when no pair qualifies.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @param {number} [xMin=0]
 */
export function fitThroughOrigin(xs, ys, xMin = 0) {
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!isNum(x) || !isNum(y) || x <= xMin) continue;
    sxy += x * y;
    sxx += x * x;
  }
  return sxx > 0 ? sxy / sxx : NaN;
}

/* ================================================================== DOM helpers */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(node, s) {
  if (node && node.textContent !== s) node.textContent = s;
}

/** Axis tick without trailing zeros (0, 0.25, 0.5, 1) so the last tick fits the plot edge. */
const shortTick = (v) => String(+v.toFixed(2));

const signed = (v, d = 0) => (isNum(v) ? `${v > 0 ? '+' : ''}${formatNumber(v, d)}` : '—');

/* ================================================================== state */

/** @type {null | ReturnType<typeof buildUi>} */
let ui = null;

/* ================================================================== mount */

/**
 * Build the tab (called once, after the first hello).
 * @param {HTMLElement} root
 * @param {object} app
 */
export function mount(root, app) {
  ui = buildUi(root, app);
  ui.unsub.push(app.on('hello', () => onSession(app)));
  ui.unsub.push(app.on('alert', () => { ui.alertsDirty = true; }));
  ui.unsub.push(app.on('alertlog', () => { ui.alertsDirty = true; }));
  onSession(app);
}

/**
 * Optional hash parameters: `#aero?view=under&streaks=0&labels=1&rh=1&inset=0`.
 * @param {URLSearchParams} params
 */
export function route(params) {
  if (!ui) return;
  const view = params.get('view');
  if (view && VIEWS[view]) setView(view);
  const flag = (k) => (params.has(k) ? params.get(k) !== '0' : undefined);
  const o = { streaks: flag('streaks'), labels: flag('labels'), exaggerate: flag('rh'), inset: flag('inset') };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  if (Object.keys(o).length) setOptions(o);
}

/**
 * New session (first mount or a hello after a reset/reconnect): fetch 5 min of history for the
 * aero channels, learn the baseline from its oldest valid minute and keep it for the charts.
 *
 * The page's shared history (`app.hist`) is back-filled once per hello for a fixed channel
 * set; later back-fills cannot add older rows for other channels, so this tab fetches its own
 * copy (`GET /api/history`) and merges it in front of the live samples ({@link backfilled}).
 */
function onSession(app) {
  if (!ui) return;
  ui.tapIds = tapLayout(app);
  ui.baseline = new Baseline([...ui.tapIds.cp, ...WING_STATIONS.map((w) => w.cl), 'calc_cp_ut_mean']);
  ui.baselineReady = false;
  ui.fetched = null;
  ui.alertsDirty = true;
  ui.lastT = NaN;
  const ids = [...new Set([...ui.tapIds.cp, ...HISTORY_IDS])].filter((id) => app.channels.has(id));
  const meta = app.meta;
  app.api.get(`/api/history?ids=${encodeURIComponent(ids.join(','))}&seconds=300`).then((data) => {
    if (!ui || app.meta !== meta || !data || !Array.isArray(data.t)) return;
    const t = Float64Array.from(data.t, (x) => (x === null ? NaN : x));
    const series = {};
    for (const [id, arr] of Object.entries(data.series || {})) series[id] = Float64Array.from(arr, (x) => (x === null ? NaN : x));
    ui.fetched = { t, series };
    const q = series.calc_q;
    if (q) for (let k = 0; k < t.length && !ui.baseline.frozen; k++) ui.baseline.add(t[k], q[k], (id) => (series[id] ? series[id][k] : NaN));
  }).catch((err) => {
    console.warn('[aero] history back-fill failed:', err.message);
  }).finally(() => {
    if (ui && app.meta === meta) ui.baselineReady = true;
  });
}

/**
 * Series source for the charts: this tab's fetched history in front of the live client
 * history (`app.hist`), limited to the last `seconds`.
 * @param {object} app
 * @param {string} id
 * @returns {(seconds: number) => {t: Float64Array, v: Float64Array}}
 */
function backfilled(app, id) {
  return (seconds) => {
    const live = app.hist.series(id, seconds);
    const h = ui && ui.fetched;
    if (!h || !h.series[id] || !h.t.length) return live;
    // fetched rows up to the end of the fetch, then the live rows recorded after it (every
    // channel shares the same row times, so series built this way stay aligned)
    const hEnd = h.t[h.t.length - 1];
    const tNow = live.t.length ? Math.max(live.t[live.t.length - 1], hEnd) : hEnd;
    const tMin = tNow - seconds;
    let a = 0;
    while (a < h.t.length && h.t[a] < tMin) a++;
    let c = 0;
    while (c < live.t.length && live.t[c] <= hEnd + 1e-6) c++;
    const n = h.t.length - a, m = live.t.length - c;
    const t = new Float64Array(n + m), v = new Float64Array(n + m);
    t.set(h.t.subarray(a)); v.set(h.series[id].subarray(a));
    t.set(live.t.subarray(c), n); v.set(live.v.subarray(c), n);
    return { t, v };
  };
}

/** Tap ids per station / surface from the catalogue (sorted by x/c). */
function tapLayout(app) {
  const taps = [...app.channels.values()].filter((c) => c.group === 'aero.taps' && c.meta && c.meta.element);
  const pick = (element, station, surface) => taps
    .filter((t) => t.meta.element === element && t.meta.station === station && t.meta.surface === surface)
    .sort((a, b) => a.meta.x_c - b.meta.x_c)
    .map((t) => ({ id: t.id, xc: Number(t.meta.x_c) }));
  const stations = {};
  for (const w of WING_STATIONS) stations[w.key] = { suction: pick(w.element, w.station, 'suction'), pressure: pick(w.element, w.station, 'pressure') };
  const floor = { centre: pick('ut', 'C', 'floor'), L: pick('ut', 'L', 'floor'), R: pick('ut', 'R', 'floor') };
  return { stations, floor, cp: taps.map((t) => `calc_cp_${t.id}`), raw: taps.map((t) => t.id) };
}

function buildUi(root, app) {
  root.innerHTML = '';
  root.classList.add('aero-view');
  const grid = el('div', 'aero-grid');
  const vehicle = (app.meta && app.meta.vehicle) || {};

  // ---- 3D card
  const card3d = el('section', 'card aero-3d');
  const head = el('div', 'card-head aero-3d-head');
  head.append(el('h2', 'card-title', 'Live pressure map'), el('span', 'card-sub', 'Cp on the wing suction/pressure surfaces and the floor'), el('span', 'spacer'));
  const views = el('div', 'seg');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Camera view');
  const viewBtns = new Map();
  for (const [key, v] of Object.entries(VIEWS)) {
    const b = el('button', '', v.label);
    b.type = 'button';
    b.dataset.view = key;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setView(key));
    views.append(b);
    viewBtns.set(key, b);
  }
  const toggles = el('div', 'seg');
  toggles.setAttribute('role', 'group');
  toggles.setAttribute('aria-label', 'Display options');
  const toggleBtns = new Map();
  for (const [key, label, title] of [
    ['streaks', 'Flow', 'Flow streaks (potential-flow model, speed ∝ airspeed)'],
    ['labels', 'Labels', 'Force and station labels'],
    ['exaggerate', 'RH ×5', 'Exaggerate ride height and pitch five times'],
    ['inset', 'Inset', 'Underside inset: the suction surfaces seen from below'],
  ]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.title = title;
    b.dataset.opt = key;
    b.addEventListener('click', () => setOptions({ [key]: b.getAttribute('aria-pressed') !== 'true' }));
    toggles.append(b);
    toggleBtns.set(key, b);
  }
  head.append(views, toggles);
  const host = el('div', 'aero-3d-host');
  card3d.append(head, host);

  // ---- right column: numbers + alerts
  const side = el('aside', 'aero-side');
  const kpiCard = el('section', 'card aero-kpis');
  const kh = el('div', 'card-head');
  kh.append(el('h2', 'card-title', 'Aero numbers'), el('span', 'card-sub', 'live estimates'));
  const kgrid = el('div', 'aero-tiles');
  kpiCard.append(kh, kgrid);
  const tiles = TILES.map((t) => {
    const node = el('div', 'tile aero-tile');
    node.dataset.ch = t.ch.join(',');
    node.title = t.title || '';
    const value = el('span', 'tile-value');
    const num = el('span', 'num', '—');
    const unit = el('span', 'unit', t.unit || '');
    value.append(num, unit);
    const sub = el('span', 'tile-sub', '');
    node.append(el('span', 'tile-label', t.label), value, sub);
    kgrid.append(node);
    return { def: t, node, num, unit, sub };
  });
  const alertCard = el('section', 'card aero-alerts');
  const ah = el('div', 'card-head');
  const alertSub = el('span', 'card-sub', '');
  ah.append(el('h2', 'card-title', 'Aero alerts'), alertSub);
  const alertList = el('ul', 'mini-alerts');
  alertCard.append(ah, alertList);
  side.append(kpiCard, alertCard);

  // ---- Cp distributions
  const cpHead = el('div', 'aero-cp-head');
  const c0 = seriesColor(0), c1 = seriesColor(1), c2 = seriesColor(2);
  cpHead.innerHTML = `
    <h2 class="card-title">Pressure distributions</h2>
    <span class="aero-key"><i style="background:${c0}"></i>suction surface (lower)</span>
    <span class="aero-key"><i style="background:${c1}"></i>pressure surface (upper)</span>
    <span class="aero-key"><i style="background:${c2}"></i>floor centreline</span>
    <span class="aero-key"><i class="dash"></i>baseline: first valid minute</span>
    <span class="aero-key"><i class="ring"></i>suspect tap</span>
    <span class="spacer"></span>
    <span class="card-sub" data-role="baseline"></span>`;
  const cpRow = el('div', 'aero-cp-row');
  const stationY = (w) => {
    const wing = (vehicle.aero || {})[w.element === 'fw' ? 'front_wing' : 'rear_wing'] || {};
    const y = Array.isArray(wing.station_y_m) ? Number(wing.station_y_m[w.station === 'L' ? 0 : 1]) : NaN;
    return isNum(y) ? `y ${y > 0 ? '+' : '−'}${formatNumber(Math.abs(y), 2)} m` : '';
  };
  const cpCards = WING_STATIONS.map((w) => {
    const card = el('section', 'card aero-cp');
    const h = el('div', 'card-head');
    const cl = el('span', 'aero-cl');
    const delta = el('span', 'aero-delta');
    const title = el('h3', 'card-title', w.title);
    title.title = `Station ${stationY(w)}`;
    h.append(title, el('span', 'spacer'), cl, delta);
    const chartHost = el('div', 'chart-host aero-cp-chart');
    card.append(h, chartHost);
    cpRow.append(card);
    const chart = new XYChart(chartHost, {
      title: `${w.title}: pressure coefficient along the chord`,
      legend: false,
      empty: 'Cp needs q > 60 Pa',
      x: { label: 'x/c', min: 0, max: 1, decimals: 2, format: shortTick },
      y: { label: 'Cp', ...WING_CP_AXIS, invert: true },
      series: [
        { label: 'Suction', color: c0, mode: 'both', radius: 4 },
        { label: 'Pressure', color: c1, mode: 'both', radius: 4 },
        { label: 'Suction baseline', color: c0, mode: 'line', dash: [5, 4], width: 1.5 },
        { label: 'Pressure baseline', color: c1, mode: 'line', dash: [5, 4], width: 1.5 },
      ],
    });
    return { def: w, card, chart, cl, delta };
  });
  const floorCard = el('section', 'card aero-cp');
  const fh = el('div', 'card-head');
  const floorCl = el('span', 'aero-cl');
  const floorDelta = el('span', 'aero-delta');
  const ftitle = el('h3', 'card-title', 'Undertray');
  ftitle.title = 'Centreline taps along the floor plus the two diffuser-tunnel taps';
  const tunnelKey = el('span', 'aero-tunnels');
  tunnelKey.innerHTML = `<span class="aero-key"><i class="dot" style="background:${seriesColor(6)}"></i>L</span><span class="aero-key"><i class="dot" style="background:${seriesColor(4)}"></i>R</span>`;
  tunnelKey.title = 'Diffuser tunnel taps, left and right';
  fh.append(ftitle, tunnelKey, el('span', 'spacer'), floorCl, floorDelta);
  const floorHost = el('div', 'chart-host aero-cp-chart');
  floorCard.append(fh, floorHost);
  cpRow.append(floorCard);
  const floorChart = new XYChart(floorHost, {
    title: 'Undertray: pressure coefficient along the floor',
    legend: false,
    empty: 'Cp needs q > 60 Pa',
    x: { label: 'floor x/L', min: 0, max: 1, decimals: 2, format: shortTick },
    y: { label: 'Cp', ...FLOOR_CP_AXIS, invert: true },
    series: [
      { label: 'Centre', color: c2, mode: 'both', radius: 4 },
      { label: 'Tunnel L', color: seriesColor(6), mode: 'points', radius: 4 },
      { label: 'Tunnel R', color: seriesColor(4), mode: 'points', radius: 4 },
      { label: 'Baseline', color: c2, mode: 'line', dash: [5, 4], width: 1.5 },
    ],
  });
  floorChart.setVLines([{ value: 0.4, label: 'throat' }, { value: DIFFUSER_START, label: 'diffuser' }]);

  // ---- bottom row: aero map, strip charts
  const mapCard = el('section', 'card aero-map');
  const mh = el('div', 'card-head');
  const mapSub = el('span', 'card-sub', 'last 5 min · colour: front ride height');
  mh.append(el('h2', 'card-title', 'Aero map: downforce vs q'), mapSub);
  const mapHost = el('div', 'chart-host aero-bottom-chart');
  mapCard.append(mh, mapHost);
  const staticF = Number(((vehicle.suspension || {}).static_ride_height_mm || {}).front) || 30;
  const rhBins = [
    { label: `≥ ${staticF - 2} mm`, lo: staticF - 2, hi: Infinity, t: 0.36 },
    { label: `${staticF - 6}–${staticF - 2}`, lo: staticF - 6, hi: staticF - 2, t: 0.56 },
    { label: `${staticF - 10}–${staticF - 6}`, lo: staticF - 10, hi: staticF - 6, t: 0.76 },
    { label: `< ${staticF - 10} mm`, lo: -Infinity, hi: staticF - 10, t: 0.96 },
  ];
  const mapChart = new XYChart(mapHost, {
    title: 'Aero map: total downforce against dynamic pressure, coloured by front ride height',
    empty: 'Waiting for running data',
    x: { label: 'q', unit: 'Pa', min: 0, decimals: 0 },
    y: { label: 'Downforce', unit: 'N', includeZero: true, decimals: 0 },
    series: rhBins.map((b) => ({ label: b.label, color: sequentialCss(b.t, 0, 1, 'blue'), mode: 'points', radius: 2.5 })),
  });

  const stripCard = el('section', 'card aero-strip');
  const sh = el('div', 'card-head');
  sh.append(el('h2', 'card-title', 'Speed & downforce'), el('span', 'card-sub', 'last 60 s'));
  const stripHost = el('div', 'chart-host aero-bottom-chart');
  stripCard.append(sh, stripHost);
  const src = (id) => backfilled(app, id);
  const speedChart = new StripChart(stripHost, {
    title: 'Speed and downforce, last 60 seconds',
    window: 60,
    lanes: [
      { label: 'Speed', unit: 'km/h', min: 0, softMax: 60, decimals: 0 },
      { label: 'Downforce', unit: 'N', includeZero: true, decimals: 0, weight: 1.3 },
    ],
    series: [
      { label: 'Ground speed', lane: 0, scale: 3.6, source: src('gps_speed'), color: seriesColor(0), fill: true },
      { label: 'Airspeed', lane: 0, scale: 3.6, source: src('calc_airspeed'), color: seriesColor(6), dash: [5, 4], width: 1.6 },
      { label: 'Total', lane: 1, source: src('calc_downforce'), color: seriesColor(2), fill: true },
      { label: 'Front', lane: 1, source: src('calc_downforce_f'), color: seriesColor(3), width: 1.6 },
      { label: 'Rear', lane: 1, source: src('calc_downforce_r'), color: seriesColor(4), width: 1.6 },
    ],
  });
  const clCard = el('section', 'card aero-clcard');
  const ch = el('div', 'card-head');
  ch.append(el('h2', 'card-title', 'Section Cl'), el('span', 'card-sub', 'last 60 s'));
  const clHost = el('div', 'chart-host aero-bottom-chart');
  clCard.dataset.ch = 'calc_cl_fw_l,calc_cl_fw_r,calc_cl_rw_l,calc_cl_rw_r';
  clCard.append(ch, clHost);
  const clChart = new StripChart(clHost, {
    title: 'Section lift coefficient of each wing station, last 60 seconds',
    window: 60,
    lanes: [{ label: 'Section Cl (+ = downforce)', decimals: 2 }],
    series: WING_STATIONS.map((w, i) => ({ label: w.key.toUpperCase().replace('-', '·'), source: src(w.cl), color: seriesColor(i), width: 1.8 })),
  });

  grid.append(card3d, side, cpHead, cpRow, mapCard, stripCard, clCard);
  root.append(grid);

  // the 3D view
  const car = new Car3D(host, app, { view: 'iso', streaks: true, labels: true, exaggerate: false, inset: true });

  // channel lists used for alert highlighting
  const lay = tapLayout(app);
  cpCards.forEach((c) => {
    const st = lay.stations[c.def.key];
    const ids = [...st.suction, ...st.pressure].map((t) => t.id);
    c.card.dataset.ch = [...ids, ...ids.map((id) => `calc_cp_${id}`), c.def.cl].join(',');
  });
  const floorIds = [...lay.floor.centre, ...lay.floor.L, ...lay.floor.R].map((t) => t.id);
  floorCard.dataset.ch = [...floorIds, ...floorIds.map((id) => `calc_cp_${id}`), 'calc_cp_ut_mean'].join(',');
  mapCard.dataset.ch = 'calc_cla,calc_downforce,calc_q';
  stripCard.dataset.ch = 'calc_downforce,calc_downforce_f,calc_downforce_r,calc_aero_balance';

  return {
    root, car, viewBtns, toggleBtns, tiles, alertList, alertSub, cpCards, floorCard, floorChart, floorCl, floorDelta,
    cpHead, mapChart, mapSub, rhBins, speedChart, clChart, tapIds: lay, baseline: null, baselineReady: false,
    acc: { tiles: Infinity, cp: Infinity, strip: Infinity, map: Infinity, alerts: 0 },
    alertsDirty: true, lastT: NaN, unsub: [],
  };
}

/* ================================================================== view / options */

/** The tab's {@link Car3D} instance (null before mount) - for tests and integrations. */
export function getCar() {
  return ui ? ui.car : null;
}

function setView(name) {
  if (!ui) return;
  ui.car.setView(name);
  for (const [k, b] of ui.viewBtns) b.setAttribute('aria-pressed', String(k === name));
}

function setOptions(o) {
  if (!ui) return;
  ui.car.set(o);
  for (const [k, b] of ui.toggleBtns) b.setAttribute('aria-pressed', String(!!ui.car.opts[k]));
}

/* ================================================================== tiles */

const v = (app, id) => app.val(id);
const f = (x, d) => formatNumber(x, d);

/**
 * Number tiles: label, unit, value(app) → string, sub(app) → string, channels (for alert
 * highlighting and the threshold level) and an optional level(app).
 */
const TILES = [
  {
    label: 'Dyn. pressure q', unit: 'Pa', ch: ['calc_q', 'pitot_dp'],
    title: 'q = ½·ρ·V² from the pitot-static probe',
    value: (app) => f(v(app, 'calc_q'), 0),
    sub: (app) => `pitot ${f(v(app, 'pitot_dp'), 0)} Pa`,
  },
  {
    label: 'Airspeed', unit: 'km/h', ch: ['calc_airspeed', 'gps_speed'],
    title: 'V = √(2q/ρ); differs from ground speed by the wind',
    value: (app) => f(v(app, 'calc_airspeed') * 3.6, 0),
    sub: (app) => `ground ${f(v(app, 'gps_speed') * 3.6, 0)} km/h`,
  },
  {
    label: 'Air density ρ', unit: 'kg/m³', ch: ['calc_rho', 'amb_temp', 'amb_press', 'amb_rh'],
    title: 'Moist-air density from the BME280 temperature, pressure and humidity',
    value: (app) => f(v(app, 'calc_rho'), 3),
    sub: (app) => `${f(v(app, 'amb_temp'), 1)} °C · ${f(v(app, 'amb_press') / 100, 0)} hPa · ${f(v(app, 'amb_rh'), 0)} %`,
  },
  {
    label: 'Flow yaw', unit: '°', ch: ['calc_yaw', 'probe_yaw'],
    title: 'Flow angle from the 5-hole probe (+ = from the left)',
    value: (app) => signed(v(app, 'calc_yaw'), 1),
    sub: (app) => `probe pitch ${signed(v(app, 'probe_pitch'), 1)}°`,
    level: (app) => levelOf(app.def('calc_yaw'), v(app, 'calc_yaw')),
  },
  {
    label: 'CL·A estimate', unit: 'm²', ch: ['calc_cla'],
    title: 'Downforce / q (low-pass, q > 120 Pa); truth from the simulator when available',
    value: (app) => f(v(app, 'calc_cla'), 2),
    sub: (app) => {
      const est = v(app, 'calc_cla'), tr = v(app, 'truth_cla');
      if (isNum(tr)) return `truth ${f(tr, 2)} · ${isNum(est) && tr ? `${signed(((est - tr) / tr) * 100, 1)} %` : '—'}`;
      return isNum(ui && ui.fitCla) ? `map fit ${f(ui.fitCla, 2)} m²` : 'no truth (real car)';
    },
  },
  {
    label: 'CD·A', unit: 'm²', ch: ['calc_cda', 'calc_drag'],
    title: 'Drag / q from the longitudinal force balance',
    value: (app) => f(v(app, 'calc_cda'), 2),
    sub: (app) => {
      const tr = v(app, 'truth_cda');
      return `drag ${f(v(app, 'calc_drag'), 0)} N${isNum(tr) ? ` · truth ${f(tr, 2)}` : ''}`;
    },
  },
  {
    label: 'L/D', unit: '', ch: ['calc_ld'],
    title: 'Aerodynamic efficiency: downforce / drag',
    value: (app) => f(v(app, 'calc_ld'), 2),
    sub: () => 'downforce / drag',
  },
  {
    label: 'Aero balance', unit: '% F', ch: ['calc_aero_balance'],
    title: 'Share of the downforce on the front axle',
    value: (app) => f(v(app, 'calc_aero_balance'), 1),
    sub: (app) => {
      const d = app.def('calc_aero_balance');
      return d && isNum(d.warn_lo) && isNum(d.warn_hi) ? `window ${d.warn_lo}–${d.warn_hi} % front` : 'front share';
    },
    level: (app) => levelOf(app.def('calc_aero_balance'), v(app, 'calc_aero_balance')),
  },
  {
    label: 'Downforce', unit: 'N', ch: ['calc_downforce', 'calc_downforce_f', 'calc_downforce_r'],
    title: 'From the pushrod loads minus static weight and load transfer',
    value: (app) => f(v(app, 'calc_downforce'), 0),
    sub: (app) => `front ${f(v(app, 'calc_downforce_f'), 0)} · rear ${f(v(app, 'calc_downforce_r'), 0)} N`,
  },
  {
    label: 'Ride height F / R', unit: 'mm', ch: ['rh_front', 'rh_rear'],
    title: 'Laser ride height (static values from vehicle.yaml)',
    value: (app) => `${f(v(app, 'rh_front'), 1)} / ${f(v(app, 'rh_rear'), 1)}`,
    sub: (app) => {
      const s = ((app.meta && app.meta.vehicle && app.meta.vehicle.suspension) || {}).static_ride_height_mm || {};
      return `static ${s.front ?? '—'} / ${s.rear ?? '—'} mm`;
    },
    level: (app) => worst(levelOf(app.def('rh_front'), v(app, 'rh_front')), levelOf(app.def('rh_rear'), v(app, 'rh_rear'))),
  },
  {
    label: 'FW asymmetry', unit: '%', ch: ['calc_fw_asym', 'calc_cl_fw_l', 'calc_cl_fw_r'],
    title: '(Cl left − Cl right) / mean: a damaged flap shows up here first',
    value: (app) => signed(v(app, 'calc_fw_asym'), 1),
    sub: (app) => `Cl L ${f(v(app, 'calc_cl_fw_l'), 2)} · R ${f(v(app, 'calc_cl_fw_r'), 2)}`,
    level: (app) => levelOf(app.def('calc_fw_asym'), v(app, 'calc_fw_asym')),
  },
  {
    label: 'Floor mean Cp', unit: '', ch: ['calc_cp_ut_mean'],
    title: 'Mean Cp of the undertray taps (more negative = more suction)',
    value: (app) => f(v(app, 'calc_cp_ut_mean'), 2),
    sub: (app) => {
      const b = ui && ui.baseline ? ui.baseline.mean('calc_cp_ut_mean') : NaN;
      return isNum(b) ? `baseline ${f(b, 2)}` : 'baseline learning';
    },
  },
];

function worst(a, b) {
  const r = { '': 0, warning: 1, critical: 2 };
  return (r[a] || 0) >= (r[b] || 0) ? a : b;
}

function updateTiles(app) {
  for (const t of ui.tiles) {
    setText(t.num, t.def.value(app));
    setText(t.sub, t.def.sub(app));
    const lvl = t.def.level ? t.def.level(app) : '';
    if ((t.node.dataset.level || '') !== lvl) {
      if (lvl) t.node.dataset.level = lvl; else delete t.node.dataset.level;
    }
  }
}

/* ================================================================== Cp charts */

/** Values of tap list `taps` → [xs, cps]. */
function cpSeries(app, taps) {
  return [taps.map((t) => t.xc), taps.map((t) => (app.status(t.id) === 'live' ? app.val(`calc_cp_${t.id}`) : NaN))];
}

function baselineSeries(taps) {
  return [taps.map((t) => t.xc), taps.map((t) => ui.baseline.mean(`calc_cp_${t.id}`))];
}

function suspectTaps(app) {
  const s = new Set();
  const a = app.alerts.get('sensor_tap_anomaly');
  if (a) for (const ch of a.channels || []) s.add(ch.replace(/^calc_cp_/, ''));
  return s;
}

/** Section-Cl change vs the baseline, as a tag with a level. */
function deltaTag(node, now, base) {
  if (!isNum(now) || !isNum(base) || Math.abs(base) < 0.05) {
    setText(node, '');
    delete node.dataset.level;
    return;
  }
  const pct = ((now - base) / Math.abs(base)) * 100;
  setText(node, `${signed(pct, 0)} %`);
  node.title = `vs baseline ${formatNumber(base, 2)}`;
  const lvl = pct <= -30 || pct >= 30 ? 'critical' : pct <= -15 || pct >= 15 ? 'warning' : '';
  if ((node.dataset.level || '') !== lvl) { if (lvl) node.dataset.level = lvl; else delete node.dataset.level; }
}

function updateCpCharts(app) {
  const sus = suspectTaps(app);
  const lay = ui.tapIds;
  for (const c of ui.cpCards) {
    const st = lay.stations[c.def.key];
    const [sx, sy] = cpSeries(app, st.suction);
    const [px, py] = cpSeries(app, st.pressure);
    c.chart.setSeries(0, sx, sy);
    c.chart.setSeries(1, px, py);
    const [bsx, bsy] = baselineSeries(st.suction);
    const [bpx, bpy] = baselineSeries(st.pressure);
    c.chart.setSeries(2, bsx, bsy);
    c.chart.setSeries(3, bpx, bpy);
    const hl = [];
    st.suction.forEach((t, i) => { if (sus.has(t.id)) hl.push({ series: 0, index: i, label: `${t.id} suspect` }); });
    st.pressure.forEach((t, i) => { if (sus.has(t.id)) hl.push({ series: 1, index: i, label: `${t.id} suspect` }); });
    c.chart.setHighlights(hl);
    const cl = app.val(c.def.cl);
    setText(c.cl, isNum(cl) ? `Cl ${formatNumber(cl, 2)}` : 'Cl —');
    deltaTag(c.delta, cl, ui.baseline.mean(c.def.cl));
    ui.car.setStationStatus(c.def.key, c.delta.textContent, c.delta.dataset.level || '');
  }
  const fl = lay.floor;
  const [cx, cy] = cpSeries(app, fl.centre);
  ui.floorChart.setSeries(0, cx, cy);
  ui.floorChart.setSeries(1, ...cpSeries(app, fl.L));
  ui.floorChart.setSeries(2, ...cpSeries(app, fl.R));
  ui.floorChart.setSeries(3, ...baselineSeries(fl.centre));
  const fh = [];
  [fl.centre, fl.L, fl.R].forEach((list, s) => list.forEach((t, i) => { if (sus.has(t.id)) fh.push({ series: s, index: i, label: `${t.id} suspect` }); }));
  ui.floorChart.setHighlights(fh);
  const m = app.val('calc_cp_ut_mean');
  setText(ui.floorCl, isNum(m) ? `C̄p ${formatNumber(m, 2)}` : 'C̄p —');
  // floor suction loss = Cp mean rising towards 0: report the change of |Cp̄|
  const b = ui.baseline.mean('calc_cp_ut_mean');
  deltaTag(ui.floorDelta, isNum(m) ? -m : NaN, isNum(b) ? -b : NaN);
  // baseline status
  const bl = ui.baseline;
  const txt = bl.frozen ? `baseline: ${BASELINE_SECONDS} s with q > ${BASELINE_Q_MIN} Pa from t = ${formatNumber(bl.firstT, 0)} s`
    : `baseline learning ${formatNumber(bl.learned, 0)} / ${BASELINE_SECONDS} s (q > ${BASELINE_Q_MIN} Pa)`;
  setText(ui.cpHead.querySelector('[data-role="baseline"]'), txt);
}

/* ================================================================== aero map */

function updateAeroMap(app) {
  // the three series share the client-history rows; the fetched history has the same rows too
  const q = backfilled(app, 'calc_q')(300);
  const df = backfilled(app, 'calc_downforce')(300).v;
  const rh = backfilled(app, 'rh_front')(300).v;
  if (df.length !== q.v.length || rh.length !== q.v.length) return;
  const n = q.t.length;
  const stride = Math.max(1, Math.ceil(n / 900));
  const bins = ui.rhBins.map(() => ({ x: [], y: [] }));
  let lastBin = -1, lastIdx = -1;
  for (let k = 0; k < n; k += stride) {
    const x = q.v[k], y = df[k], h = rh[k];
    if (!isNum(x) || !isNum(y) || !isNum(h) || x < 30) continue;
    const bi = ui.rhBins.findIndex((b) => h >= b.lo && h < b.hi);
    if (bi < 0) continue;
    bins[bi].x.push(x);
    bins[bi].y.push(y);
    lastBin = bi;
    lastIdx = bins[bi].x.length - 1;
  }
  bins.forEach((b, i) => ui.mapChart.setSeries(i, b.x, b.y));
  const k = fitThroughOrigin(q.v, df, FIT_Q_MIN);
  ui.fitCla = k;
  let qMax = 0;
  for (const x of q.v) if (isNum(x) && x > qMax) qMax = x;
  ui.mapChart.setFit(isNum(k) ? { slope: k, intercept: 0, x0: 0, x1: Math.max(qMax, 100), label: `fit CL·A ${formatNumber(k, 2)} m²` } : null);
  ui.mapChart.setHighlights(lastBin >= 0 ? [{ series: lastBin, index: lastIdx, label: 'now' }] : []);
}

/* ================================================================== alerts */

function aeroAlerts(app) {
  return [...app.alerts.values()].filter((a) => alertSystem(app, a) === 'aero')
    .sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0) || (y.t_start || 0) - (x.t_start || 0));
}

function renderAlerts(app) {
  const list = aeroAlerts(app);
  setText(ui.alertSub, list.length ? `${list.length} active` : '');
  const ul = ui.alertList;
  ul.replaceChildren();
  if (!list.length) {
    const ok = el('div', 'empty-ok');
    ok.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    ok.append(document.createTextNode('Aero package nominal: no active aero alerts.'));
    ul.append(ok);
  }
  for (const a of list) {
    const li = el('li', 'aero-alert');
    li.title = `${a.detail || ''}\nClick: show its channels in the Sensors tab`;
    const text = el('span', 'title');
    text.append(el('b', '', a.title || a.id));
    if (a.detail) text.append(el('span', 'aero-alert-detail', ` · ${a.detail}`));
    li.append(sevPill(a.severity), text, el('span', 't', alertAge(a, app.t)));
    li.addEventListener('click', () => jumpToChannels(app, a.channels || [], a.title));
    ul.append(li);
  }
  // highlight every card / tile whose channels an active aero alert names
  const sev = new Map();
  for (const a of list) {
    for (const ch of a.channels || []) {
      const cur = sev.get(ch);
      if (!cur || (SEVERITY_RANK[a.severity] || 0) > (SEVERITY_RANK[cur] || 0)) sev.set(ch, a.severity);
    }
  }
  for (const node of ui.root.querySelectorAll('[data-ch]')) {
    let s = '';
    for (const ch of node.dataset.ch.split(',')) {
      const x = sev.get(ch);
      if (x && (!s || (SEVERITY_RANK[x] || 0) > (SEVERITY_RANK[s] || 0))) s = x;
    }
    if ((node.dataset.alert || '') !== s) { if (s) node.dataset.alert = s; else delete node.dataset.alert; }
  }
}

/* ================================================================== update */

/**
 * Per-frame update (only while the tab is visible): the 3D view every frame, tiles at 5 Hz,
 * Cp charts and strip charts at 10 Hz, the aero map at 1 Hz, alerts on change.
 * @param {object} app
 * @param {number} dtMs
 */
export function update(app, dtMs) {
  if (!ui) return;
  ui.car.update(app, dtMs);
  const a = ui.acc;
  a.tiles += dtMs; a.cp += dtMs; a.strip += dtMs; a.map += dtMs; a.alerts += dtMs;
  // live baseline learning (after the history back-fill was ingested)
  if (ui.baselineReady && app.t !== ui.lastT) {
    ui.lastT = app.t;
    ui.baseline.add(app.t, app.val('calc_q'), (id) => app.val(id));
  }
  if (a.tiles >= 200) { a.tiles = 0; updateTiles(app); }
  if (a.cp >= 100 && ui.baseline) { a.cp = 0; updateCpCharts(app); }
  if (a.strip >= 100) { a.strip = 0; ui.speedChart.pull(app.t); ui.clChart.pull(app.t); }
  if (a.map >= 1000) { a.map = 0; updateAeroMap(app); }
  if (ui.alertsDirty || a.alerts >= 1000) { ui.alertsDirty = false; a.alerts = 0; renderAlerts(app); }
  // reflect the current view / toggles (also after a route() call)
  if (ui.car.view !== ui.shownView) {
    ui.shownView = ui.car.view;
    for (const [k, b] of ui.viewBtns) b.setAttribute('aria-pressed', String(k === ui.car.view));
    for (const [k, b] of ui.toggleBtns) b.setAttribute('aria-pressed', String(!!ui.car.opts[k]));
  }
}
