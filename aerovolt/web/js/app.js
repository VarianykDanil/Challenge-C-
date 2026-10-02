/**
 * @file The dashboard's data layer: one WebSocket connection to the AeroVolt server (SPEC §9),
 * the latest value of every channel, a client-side history ring buffer, alerts / laps /
 * faults / strategy state and a tiny event emitter. Every panel reads from the singleton
 * {@link app}; nothing else talks to the network.
 *
 * Public API (SPEC §10):
 * ```
 * app.meta            hello payload (null until connected)
 * app.channels        Map id -> ChannelDef
 * app.latest          Map id -> number | null
 * app.owner           Map id -> 'sim' | 'serial' | 'can' | 'replay' | 'calc' (derived channels)
 * app.t               latest session time [s]
 * app.hist.series(id, seconds) -> {t: Float64Array, v: Float64Array}   20 Hz × 300 s ring
 * app.alerts          Map id -> active alert;  app.alertLog: every alert (oldest first)
 * app.laps, app.faults, app.strategy, app.sources, app.connected, app.mode
 * app.on(evt, cb) -> unsubscribe   'hello'|'frame'|'alert'|'lap'|'faults'|'strategy'|'sources'|'connection'
 * app.api.get(path), app.api.post(path, body)
 * app.fmt(id, value = latest) -> "412.5 Pa"
 * app.status(id) -> 'live' | 'stale' | 'missing'
 * app.val(id) -> number (NaN when missing)
 * ```
 * Extra event: 'alertlog' (the full alert log was (re)loaded after a hello).
 * Extras: `app.def(id)`, `app.rate(id)` (observed update rate), `app.loadHistory(ids, s)`,
 * `app.connection` ({state, attempt, retryAt}), `app.dataAge()` (wall s since last frame),
 * `app.bestLap`, `app.frameHz` (wall clock), `app.frameDataHz` (per session second),
 * `app.ui` (navigation / drawer / toast helpers, installed by main.js).
 */

import { formatChannel, isNum, MISSING } from './lib/format.js';

/** Client history: sample rate [Hz] and length [s] (SPEC §10). */
export const HISTORY_HZ = 20;
export const HISTORY_SECONDS = 300;

/**
 * Channels whose history is back-filled from `GET /api/history` on every (re)connect, so the
 * strip charts and the track trail are full immediately. Panels can back-fill more with
 * {@link App#loadHistory}.
 */
export const SEED_CHANNELS = [
  'gps_speed', 'gps_lat', 'gps_lon', 'calc_downforce', 'calc_pack_power', 'calc_soc_ekf',
  'calc_soc_cc', 'truth_soc', 'calc_cell_t_max', 'mot_winding_temp', 'calc_cla', 'calc_cda',
  'calc_aero_balance', 'calc_lap', 'calc_lap_time', 'calc_lap_dist', 'pack_voltage',
  'pack_current', 'calc_cell_v_delta', 'calc_q', 'inv_igbt_temp', 'cool_temp_out',
];

/* ================================================================== history ring buffer */

/**
 * Fixed-capacity ring buffer of frames: one shared time column plus one value column per
 * channel. Columns are allocated lazily (first non-null value), as Float32Array (4 bytes per
 * sample - 380 channels × 6000 samples ≈ 9 MB) unless float32's 24-bit mantissa cannot hold
 * the channel's resolution over its range (e.g. GPS latitude at 1e-7°), then Float64Array.
 */
export class History {
  /**
   * @param {number} [hz=20]       nominal row rate (rows closer than 0.75/hz are skipped)
   * @param {number} [seconds=300] buffer length
   */
  constructor(hz = HISTORY_HZ, seconds = HISTORY_SECONDS) {
    this.hz = hz;
    this.capacity = Math.round(hz * seconds);
    this.t = new Float64Array(this.capacity);
    /** @type {Map<string, Float32Array|Float64Array>} */
    this.cols = new Map();
    /** @type {Map<string, boolean>} id -> needs float64 */
    this.precise = new Map();
    this.head = 0; // next write index
    this.count = 0;
    this.lastT = -Infinity;
  }

  /** Remove every row (columns stay allocated). */
  clear() {
    this.head = 0;
    this.count = 0;
    this.lastT = -Infinity;
  }

  /**
   * Declare channel precision from its ChannelDef: float64 when range / resolution > 2^23.
   * @param {{id: string, min: number, max: number, resolution: number}} def
   */
  declare(def) {
    const span = Math.max(Math.abs(def.min || 0), Math.abs(def.max || 0));
    this.precise.set(def.id, def.resolution > 0 && span / def.resolution > 2 ** 23);
  }

  /** @private allocate a NaN-filled column */
  column(id) {
    let c = this.cols.get(id);
    if (!c) {
      c = this.precise.get(id) ? new Float64Array(this.capacity) : new Float32Array(this.capacity);
      c.fill(NaN);
      this.cols.set(id, c);
    }
    return c;
  }

  /**
   * Append one row. Rows less than 0.75 / hz after the previous one are skipped (decimation
   * to the nominal rate); a time step backwards clears the buffer (new session).
   * @param {number} t  session time [s]
   * @param {Record<string, number|null>} values
   * @returns {boolean} true when the row was stored
   */
  push(t, values) {
    if (!isNum(t)) return false;
    if (t < this.lastT - 1e-6) this.clear();
    if (t < this.lastT + 0.75 / this.hz) return false;
    for (const id in values) {
      const v = values[id];
      if (v !== null && v !== undefined && !this.cols.has(id)) this.column(id);
    }
    const i = this.head;
    this.t[i] = t;
    for (const [id, col] of this.cols) {
      const v = values[id];
      col[i] = v === null || v === undefined ? NaN : v;
    }
    this.head = (i + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    this.lastT = t;
    return true;
  }

  /** Session time of the newest row (NaN when empty). */
  get latestT() {
    return this.count ? this.t[(this.head - 1 + this.capacity) % this.capacity] : NaN;
  }

  /** Session time of the oldest row (NaN when empty). */
  get oldestT() {
    return this.count ? this.t[(this.head - this.count + this.capacity) % this.capacity] : NaN;
  }

  /**
   * Copy out the last `seconds` of a channel, oldest first.
   * @param {string} id
   * @param {number} [seconds=Infinity]
   * @returns {{t: Float64Array, v: Float64Array}}
   */
  series(id, seconds = Infinity) {
    const n = this.count;
    if (!n) return { t: new Float64Array(0), v: new Float64Array(0) };
    const cap = this.capacity;
    const start = (this.head - n + cap) % cap;
    const tEnd = this.latestT;
    // binary search (in ring order) for the first row with t >= tEnd - seconds
    let lo = 0, hi = n;
    const tMin = tEnd - seconds;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[(start + mid) % cap] < tMin) lo = mid + 1; else hi = mid;
    }
    const m = n - lo;
    const t = new Float64Array(m);
    const v = new Float64Array(m);
    const col = this.cols.get(id);
    for (let k = 0; k < m; k++) {
      const j = (start + lo + k) % cap;
      t[k] = this.t[j];
      v[k] = col ? col[j] : NaN;
    }
    return { t, v };
  }

  /**
   * Back-fill older rows (from `GET /api/history`) in front of the rows already present.
   * Rows at or after the oldest existing row are ignored.
   * @param {number[]} t
   * @param {Record<string, (number|null)[]>} series
   */
  seed(t, series) {
    if (!t || !t.length) return;
    const oldest = this.count ? this.oldestT : Infinity;
    // keep the existing rows
    const existing = [];
    const n = this.count, cap = this.capacity;
    for (let k = 0; k < n; k++) {
      const j = (this.head - n + k + cap) % cap;
      const row = {};
      for (const [id, col] of this.cols) row[id] = col[j];
      existing.push([this.t[j], row]);
    }
    this.clear();
    const ids = Object.keys(series);
    for (const id of ids) this.column(id);
    for (let k = 0; k < t.length; k++) {
      if (!(t[k] < oldest - 0.5 / this.hz)) break;
      const row = {};
      for (const id of ids) row[id] = series[id][k];
      this.push(t[k], row);
    }
    for (const [tt, row] of existing) this.push(tt, row);
  }
}

/* ================================================================== the app */

/** @typedef {'connecting'|'open'|'closed'} ConnState */

class App {
  constructor() {
    /** @type {object|null} hello payload */
    this.meta = null;
    /** @type {Map<string, object>} */
    this.channels = new Map();
    /** @type {Map<string, number|null>} */
    this.latest = new Map();
    /** @type {Map<string, string>} */
    this.owner = new Map();
    this.t = NaN;
    this.hist = new History();
    /** @type {Map<string, object>} */
    this.alerts = new Map();
    /** @type {object[]} */
    this.alertLog = [];
    /** @type {object[]} */
    this.laps = [];
    /** @type {object[]} */
    this.faults = [];
    /** @type {object|null} */
    this.strategy = null;
    /** @type {object[]} */
    this.sources = [];
    /** @type {Object<string, number>|null} measured sample rates from the server [Hz of session time] */
    this.serverRates = null;
    this.connected = false;
    this.mode = '—';
    /** @type {{state: ConnState, attempt: number, retryAt: number, error: string}} */
    this.connection = { state: 'connecting', attempt: 0, retryAt: 0, error: '' };
    /** measured frame rate [Hz, wall clock] */
    this.frameHz = 0;
    /** frames per second of *session* time (= frameHz / sim speed); limits observable rates */
    this.frameDataHz = 0;
    this.stale = new Set();
    this._handlers = new Map();
    this._ws = null;
    this._timer = 0;
    this._lastFrameWall = 0;
    this._defaultOwner = new Map();
    this._overrides = new Set();
    this._rate = { ids: [], index: new Map(), prev: null, changes: null, hz: null, t0: NaN, wall0: 0, frames: 0 };
    this.api = {
      /** GET JSON from the server. @param {string} path */
      get: (path) => this._fetch('GET', path),
      /** POST JSON to the server. @param {string} path @param {object} [body] */
      post: (path, body) => this._fetch('POST', path, body),
    };
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Subscribe to an event; returns an unsubscribe function.
   * @param {'hello'|'frame'|'alert'|'alertlog'|'lap'|'faults'|'strategy'|'sources'|'connection'} evt
   * @param {(payload: any) => void} cb
   * @returns {() => void}
   */
  on(evt, cb) {
    if (!this._handlers.has(evt)) this._handlers.set(evt, new Set());
    this._handlers.get(evt).add(cb);
    return () => this._handlers.get(evt).delete(cb);
  }

  /** @private */
  _emit(evt, payload) {
    const hs = this._handlers.get(evt);
    if (!hs) return;
    for (const cb of [...hs]) {
      try { cb(payload); } catch (err) { console.error(`[app] '${evt}' handler failed:`, err); }
    }
  }

  /* ---------------------------------------------------------------- queries */

  /** ChannelDef of `id` (undefined if unknown). @param {string} id */
  def(id) { return this.channels.get(id); }

  /** Latest numeric value, NaN when missing. @param {string} id @returns {number} */
  val(id) {
    const v = this.latest.get(id);
    return isNum(v) ? v : NaN;
  }

  /**
   * Formatted value with unit and precision from the catalogue resolution.
   * @param {string} id
   * @param {number|null} [value]  defaults to the latest value
   * @returns {string}
   */
  fmt(id, value = this.latest.get(id)) {
    const def = this.channels.get(id);
    if (!def) return MISSING;
    return formatChannel(def, value);
  }

  /**
   * Channel status: 'missing' (unknown, never received or null), 'stale' (the server reports
   * it stale, or the connection is down), otherwise 'live'.
   * @param {string} id
   * @returns {'live'|'stale'|'missing'}
   */
  status(id) {
    if (!this.channels.has(id)) return 'missing';
    const v = this.latest.get(id);
    if (!isNum(v)) return 'missing';
    if (!this.connected || this.stale.has(id) || this.dataAge() > 3) return 'stale';
    return 'live';
  }

  /**
   * Update rate of a channel [samples per second of session time]. The real server measures
   * it at the store and sends it with every `sources` message (`app.serverRates`); without
   * that (mock feed) it is estimated from value changes in the frames over ~2 s windows,
   * which is limited by the broadcast rate (20 Hz) and 0 for a constant signal.
   * @param {string} id
   * @returns {number}
   */
  rate(id) {
    if (this.serverRates) {
      const hz = this.serverRates[id];
      return isNum(hz) ? hz : 0;
    }
    const r = this._rate;
    const i = r.index.get(id);
    return i === undefined || !r.hz ? NaN : r.hz[i];
  }

  /** Wall-clock seconds since the last frame (Infinity before the first). */
  dataAge() {
    return this._lastFrameWall ? (performance.now() - this._lastFrameWall) / 1000 : Infinity;
  }

  /** The fastest completed lap (LapSummary) or null. */
  get bestLap() {
    let best = null;
    for (const l of this.laps) if (isNum(l.lap_time) && (!best || l.lap_time < best.lap_time)) best = l;
    return best;
  }

  /* ---------------------------------------------------------------- network */

  /** @private */
  async _fetch(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `${method} ${path} → HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * Connect (and keep reconnecting with exponential back-off: 0.5 s, 1 s, 2 s … 8 s ± 20 %).
   * @param {string} [url]  WebSocket URL (default: same host, path /ws)
   */
  start(url) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this._url = url || `${proto}://${location.host}/ws`;
    this._connect();
  }

  /** @private */
  _connect() {
    clearTimeout(this._timer);
    this._setConn('connecting');
    let ws;
    try {
      ws = new WebSocket(this._url);
    } catch (err) {
      this._scheduleReconnect(String(err));
      return;
    }
    this._ws = ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (err) { console.warn('[app] bad message', err); return; }
      this._dispatch(msg);
    };
    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._ws = null;
      this.connected = false;
      this._scheduleReconnect('connection closed');
    };
    ws.onerror = () => { /* onclose follows and handles reconnecting */ };
  }

  /** @private */
  _scheduleReconnect(reason) {
    const attempt = this.connection.attempt + 1;
    const base = Math.min(8000, 500 * 2 ** (attempt - 1));
    const delay = base * (0.8 + 0.4 * Math.random());
    this.connection = { state: 'closed', attempt, retryAt: performance.now() + delay, error: reason };
    this._emit('connection', this.connection);
    this._timer = setTimeout(() => this._connect(), delay);
  }

  /** @private */
  _setConn(state) {
    this.connection = { ...this.connection, state };
    this._emit('connection', this.connection);
  }

  /** Close and reconnect now (e.g. from a "retry" button). */
  reconnect() {
    if (this._ws) { const ws = this._ws; this._ws = null; ws.close(); }
    this.connection.attempt = 0;
    this._connect();
  }

  /* ---------------------------------------------------------------- messages */

  /** @private route one server message */
  _dispatch(msg) {
    switch (msg.type) {
      case 'hello': this._onHello(msg); break;
      case 'frame': this._onFrame(msg); break;
      case 'alert': this._onAlert(msg.alert); break;
      case 'lap': this._onLap(msg.lap); break;
      case 'faults':
        this.faults = msg.faults || [];
        this._emit('faults', this.faults);
        break;
      case 'strategy':
        this.strategy = msg.strategy || null;
        this._emit('strategy', this.strategy);
        break;
      case 'sources':
        this.sources = msg.sources || [];
        if (msg.rates && typeof msg.rates === 'object') this.serverRates = msg.rates;
        this._emit('sources', this.sources);
        break;
      default: break; // unknown types are ignored (forward compatible)
    }
  }

  /** @private */
  _onHello(msg) {
    this.meta = msg;
    this.mode = msg.mode || '—';
    this.channels = new Map((msg.channels || []).map((c) => [c.id, c]));
    this.latest = new Map();
    this.stale = new Set();
    this.hist = new History();
    for (const c of this.channels.values()) this.hist.declare(c);
    this.sources = msg.sources || [];
    this.serverRates = null;
    this.faults = msg.faults || [];
    this.laps = [...(msg.laps || [])];
    this.strategy = msg.strategy || null;
    this.alerts = new Map((msg.alerts || []).filter((a) => a.active).map((a) => [a.id, a]));
    this.alertLog = [...(msg.alerts || [])];
    this.t = isNum(msg.t) ? msg.t : NaN;
    // ownership: the first (lowest-priority) source owns everything the frame does not override
    const defaultKind = (this.sources[0] && this.sources[0].kind) || 'sim';
    this._defaultOwner = new Map();
    for (const c of this.channels.values()) {
      const kind = c.derived || c.id.startsWith('calc_') ? 'calc' : c.system === 'truth' ? 'sim' : defaultKind;
      this._defaultOwner.set(c.id, kind);
    }
    this.owner = new Map(this._defaultOwner);
    this._overrides = new Set();
    // rate meter
    const ids = [...this.channels.keys()];
    this._rate = { ids, index: new Map(ids.map((id, i) => [id, i])), prev: new Float64Array(ids.length).fill(NaN),
      changes: new Uint32Array(ids.length), hz: new Float32Array(ids.length).fill(NaN), t0: NaN, wall0: 0, frames: 0 };
    this.connected = true;
    this.connection = { state: 'open', attempt: 0, retryAt: 0, error: '' };
    this._emit('connection', this.connection);
    this._emit('hello', msg);
    // back-fill: full alert log and recent history
    this.api.get('/api/alerts').then((log) => {
      if (Array.isArray(log) && this.meta === msg) {
        this.alertLog = log;
        this._emit('alertlog', log);
      }
    }).catch(() => { /* the hello alerts are still shown */ });
    this.loadHistory(SEED_CHANNELS.filter((id) => this.channels.has(id)), HISTORY_SECONDS);
  }

  /**
   * Back-fill the client history of `ids` from `GET /api/history` (older rows only).
   * @param {string[]} ids
   * @param {number} [seconds=300]
   * @returns {Promise<void>}
   */
  async loadHistory(ids, seconds = HISTORY_SECONDS) {
    if (!ids.length) return;
    const hist = this.hist;
    try {
      const data = await this.api.get(`/api/history?ids=${encodeURIComponent(ids.join(','))}&seconds=${seconds}`);
      if (hist !== this.hist || !data || !Array.isArray(data.t)) return; // a new session started meanwhile
      hist.seed(data.t, data.series || {});
    } catch (err) {
      console.warn('[app] history back-fill failed:', err.message);
    }
  }

  /** @private */
  _onFrame(msg) {
    const v = msg.v || {};
    const tPrev = this.t;
    this.t = isNum(msg.t) ? msg.t : this.t;
    for (const id in v) this.latest.set(id, v[id]);
    // owners: restore channels that are no longer overridden
    const ov = msg.owner || {};
    for (const id of this._overrides) if (!(id in ov)) this.owner.set(id, this._defaultOwner.get(id) || 'sim');
    this._overrides = new Set(Object.keys(ov));
    for (const id in ov) this.owner.set(id, ov[id]);
    this.stale = new Set(msg.stale || []);
    this.hist.push(this.t, v);
    this._measureRates(v);
    // frame rate (wall clock, EWMA)
    // (frames counted over >= 1 s windows: frames can arrive in bursts when the tab is
    // busy, and 1/dt of a burst would read thousands of Hz)
    const now = performance.now();
    if (!this._fpsWall0) { this._fpsWall0 = now; this._fpsFrames = 0; }
    this._fpsFrames++;
    const win = (now - this._fpsWall0) / 1000;
    if (win >= 1) {
      const hz = this._fpsFrames / win;
      this.frameHz = this.frameHz ? this.frameHz * 0.5 + hz * 0.5 : hz;
      this._fpsWall0 = now;
      this._fpsFrames = 0;
    }
    this._lastFrameWall = now;
    const dtData = this.t - tPrev;
    if (dtData > 0 && dtData < 5) {
      this.frameDataHz = this.frameDataHz ? this.frameDataHz * 0.9 + (1 / dtData) * 0.1 : 1 / dtData;
    }
    if (isNum(tPrev) && this.t < tPrev - 5) this.laps = []; // session time jumped back
    this._emit('frame', msg);
  }

  /** @private count value changes per channel; publish rates every ~2 s of session time */
  _measureRates(v) {
    const r = this._rate;
    if (!r.prev) return;
    if (!isNum(r.t0)) r.t0 = this.t;
    for (let i = 0; i < r.ids.length; i++) {
      const x = v[r.ids[i]];
      if (x === undefined || x === null) continue;
      if (x !== r.prev[i]) { r.changes[i]++; r.prev[i] = x; }
    }
    const dt = this.t - r.t0;
    if (dt >= 2 || dt < 0) {
      if (dt > 0) for (let i = 0; i < r.ids.length; i++) r.hz[i] = r.changes[i] / dt;
      r.changes.fill(0);
      r.t0 = this.t;
    }
  }

  /** @private */
  _onAlert(alert) {
    if (!alert) return;
    if (alert.active) this.alerts.set(alert.id, alert); else this.alerts.delete(alert.id);
    const k = this.alertLog.findIndex((a) => a.id === alert.id && a.t_start === alert.t_start);
    if (k >= 0) this.alertLog[k] = alert; else this.alertLog.push(alert);
    this._emit('alert', alert);
  }

  /** @private */
  _onLap(lap) {
    if (!lap) return;
    const k = this.laps.findIndex((l) => l.lap === lap.lap);
    if (k >= 0) this.laps[k] = lap; else this.laps.push(lap);
    this.laps.sort((a, b) => a.lap - b.lap);
    this._emit('lap', lap);
  }
}

/** The dashboard's single data store / connection. */
export const app = new App();
