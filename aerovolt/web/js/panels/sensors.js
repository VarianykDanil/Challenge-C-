/**
 * @file Sensors tab - the bring-up view for real hardware: every channel of the catalogue
 * (~380) with live value, status (live / stale / missing), owning source, observed vs nominal
 * update rate and a 30 s sparkline, plus one card per data source (status, detail and
 * statistics such as checksum errors or CAN frames/s).
 *
 * Performance: the table is *virtualised* - only the ~30 rows in view exist in the DOM, as a
 * pool of row elements positioned absolutely inside a tall spacer and re-used while
 * scrolling. Values refresh at 5 Hz and sparklines at 2 Hz, so the tab stays smooth even with
 * all 380 channels listed.
 *
 * Route parameters (`#sensors?ch=a,b&label=...`): show only those channels (used by the
 * alerts "Show in Sensors" link). The filter chip clears it.
 */

import { Sparkline, theme } from '../lib/charts.js';
import { formatChannel, formatCompact, formatNumber, isNum, MISSING } from '../lib/format.js';
import { levelOf } from './overview.js';

const ROW_H = 28;
const SYSTEMS = [
  { key: 'aero', label: 'Aero' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'powertrain', label: 'Powertrain' },
  { key: 'calc', label: 'Calc' },
  { key: 'truth', label: 'Truth' },
];
const STATUSES = ['live', 'stale', 'missing'];
const STATUS_LABEL = { live: 'Live', stale: 'Stale', missing: 'Missing' };
const OWNER_LABEL = { sim: 'sim', serial: 'serial', can: 'CAN', replay: 'replay', calc: 'calc' };

/** Panel state. */
const S = {
  app: null,
  root: null,
  search: '',
  system: 'all',
  status: 'all',
  /** @type {Set<string>|null} */
  only: null,
  onlyLabel: '',
  collapsed: new Set(),
  /** @type {({kind: 'group', key: string, label: string, count: number}|{kind: 'ch', id: string})[]} */
  rows: [],
  pool: [],
  els: {},
  acc: { values: Infinity, sparks: Infinity, rebuild: 0, sources: Infinity },
  flash: new Set(),
  flashUntil: 0,
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Build the Sensors tab.
 * @param {HTMLElement} root
 * @param {object} app
 */
export function mount(root, app) {
  S.app = app;
  S.root = root;
  root.innerHTML = '';
  const wrap = el('div', 'sens');

  const sources = el('div', 'sources');
  const toolbar = el('div', 'sens-toolbar');
  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Search id, name, group, unit…  (comma = several)';
  search.setAttribute('aria-label', 'Search channels');
  const sysSeg = el('div', 'seg');
  sysSeg.setAttribute('role', 'group');
  sysSeg.setAttribute('aria-label', 'System filter');
  for (const s of [{ key: 'all', label: 'All' }, ...SYSTEMS]) {
    const b = el('button', '', s.label);
    b.type = 'button';
    b.dataset.sys = s.key;
    b.setAttribute('aria-pressed', String(s.key === 'all'));
    sysSeg.append(b);
  }
  const stSeg = el('div', 'seg');
  stSeg.setAttribute('role', 'group');
  stSeg.setAttribute('aria-label', 'Status filter');
  for (const s of ['all', ...STATUSES]) {
    const b = el('button', '');
    b.type = 'button';
    b.dataset.st = s;
    b.setAttribute('aria-pressed', String(s === 'all'));
    if (s !== 'all') {
      const dot = el('span', 'sdot');
      dot.dataset.s = s;
      dot.style.marginRight = '0.35em';
      b.append(dot);
    }
    b.append(document.createTextNode(s === 'all' ? 'Any status' : STATUS_LABEL[s]));
    const c = el('span', 'count', '');
    c.dataset.count = s;
    b.append(c);
    stSeg.append(b);
  }
  const chip = el('button', 'chip filter-chip');
  chip.type = 'button';
  chip.hidden = true;
  chip.title = 'Clear this filter';
  const summary = el('span', 'sens-summary');
  toolbar.append(search, sysSeg, stSeg, chip, el('span', 'spacer'), summary);

  const table = el('div', 'card vtable');
  const head = el('div', 'vt-head');
  const cols = [['', ''], ['Channel', ''], ['Name', ''], ['Value', 'r'], ['Unit', ''], ['Owner', ''], ['Rate obs / nom', 'r'], ['Last 30 s', '']];
  for (const [label, cls] of cols) head.append(el('span', cls, label));
  head.children[6].title = 'Measured samples per second of session time / nominal sensor rate';
  const scroll = el('div', 'vt-scroll');
  const spacer = el('div', 'vt-spacer');
  scroll.append(spacer);
  table.append(head, scroll);

  wrap.append(sources, toolbar, table);
  root.append(wrap);
  S.els = { sources, search, sysSeg, stSeg, chip, summary, scroll, spacer };

  search.addEventListener('input', () => { S.search = search.value.trim().toLowerCase(); rebuild(); });
  sysSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.system = b.dataset.sys;
    for (const x of sysSeg.children) x.setAttribute('aria-pressed', String(x === b));
    rebuild();
  });
  stSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.status = b.dataset.st;
    for (const x of stSeg.children) x.setAttribute('aria-pressed', String(x === b));
    rebuild();
  });
  chip.addEventListener('click', () => {
    S.only = null;
    S.onlyLabel = '';
    if (location.hash.startsWith('#sensors?')) history.replaceState(null, '', '#sensors');
    rebuild();
  });
  scroll.addEventListener('scroll', () => renderRows(true), { passive: true });
  new ResizeObserver(() => renderRows(true)).observe(scroll);
  spacer.addEventListener('click', (e) => {
    const g = e.target.closest('.vt-row.group');
    if (!g) return;
    const key = g.dataset.group;
    if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
    rebuild();
  });

  app.on('hello', () => { rebuild(); renderSources(); });
  app.on('sources', () => { S.acc.sources = Infinity; });
  rebuild();
  renderSources();
}

/**
 * Apply route parameters: `ch` = comma-separated channel ids, `label` = filter caption.
 * @param {URLSearchParams} params
 */
export function route(params) {
  const ch = (params.get('ch') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ch.length) return;
  S.only = new Set(ch);
  S.onlyLabel = params.get('label') || '';
  S.search = '';
  S.els.search.value = '';
  S.system = 'all';
  S.status = 'all';
  for (const x of S.els.sysSeg.children) x.setAttribute('aria-pressed', String(x.dataset.sys === 'all'));
  for (const x of S.els.stSeg.children) x.setAttribute('aria-pressed', String(x.dataset.st === 'all'));
  S.flash = new Set(ch);
  S.flashUntil = performance.now() + 2500;
  rebuild();
  S.els.scroll.scrollTop = 0;
}

/* ================================================================== list model */

function matches(def, terms) {
  if (!terms.length) return true;
  const hay = `${def.id} ${def.name} ${def.group} ${def.unit}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/** Rebuild the row model (groups + channels) from the filters. */
function rebuild() {
  const app = S.app;
  if (!app || !app.channels.size) { S.rows = []; renderRows(true); return; }
  const terms = S.search ? S.search.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const groups = new Map();
  const counts = { all: 0, live: 0, stale: 0, missing: 0 };
  const sysOrder = new Map(SYSTEMS.map((s, i) => [s.key, i]));
  for (const def of app.channels.values()) {
    if (S.only && !S.only.has(def.id)) continue;
    if (S.system !== 'all' && def.system !== S.system) continue;
    if (!matches(def, terms)) continue;
    const st = app.status(def.id);
    counts.all++;
    counts[st]++;
    if (S.status !== 'all' && st !== S.status) continue;
    const key = `${def.system}|${def.group}`;
    if (!groups.has(key)) groups.set(key, { key, system: def.system, group: def.group, ids: [] });
    groups.get(key).ids.push(def.id);
  }
  const ordered = [...groups.values()].sort((a, b) => (sysOrder.get(a.system) ?? 9) - (sysOrder.get(b.system) ?? 9));
  const rows = [];
  for (const g of ordered) {
    const sys = SYSTEMS.find((s) => s.key === g.system);
    rows.push({ kind: 'group', key: g.key, label: `${sys ? sys.label : g.system} · ${g.group}`, count: g.ids.length });
    if (!S.collapsed.has(g.key)) for (const id of g.ids) rows.push({ kind: 'ch', id });
  }
  S.rows = rows;
  for (const b of S.els.stSeg.querySelectorAll('[data-count]')) {
    const k = b.dataset.count;
    b.textContent = k === 'all' ? '' : String(counts[k]);
  }
  const nCh = rows.filter((r) => r.kind === 'ch').length;
  S.els.summary.textContent = `${nCh} of ${app.channels.size} channels`;
  S.els.chip.hidden = !S.only;
  if (S.only) {
    S.els.chip.textContent = `${S.onlyLabel ? `${S.onlyLabel}: ` : ''}${S.only.size} channel${S.only.size > 1 ? 's' : ''}  ✕`;
  }
  S.els.spacer.style.height = `${rows.length * ROW_H}px`;
  S.acc.values = Infinity;
  S.acc.sparks = Infinity;
  renderRows(true);
}

/* ================================================================== virtual rows */

function makePoolRow() {
  const row = el('div', 'vt-row');
  const dot = el('span', 'sdot');
  const id = el('span', 'id');
  const name = el('span', 'name');
  const val = el('span', 'val');
  const unit = el('span', 'unit');
  const own = el('span', 'own');
  const ownChip = el('span', 'chip');
  own.append(ownChip);
  const rate = el('span', 'rate');
  const sparkHost = el('span', 'spark');
  row.append(dot, id, name, val, unit, own, rate, sparkHost);
  const spark = new Sparkline(sparkHost, { fill: true });
  return { row, dot, id, name, val, unit, own, ownChip, rate, sparkHost, spark, key: '' };
}

/**
 * Position pool rows over the visible slice of the list.
 * @param {boolean} [force]  re-bind contents even if the slice did not change
 */
function renderRows(force = false) {
  const { scroll, spacer } = S.els;
  if (!scroll) return;
  const h = scroll.clientHeight || 600;
  const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - 4);
  const count = Math.ceil(h / ROW_H) + 8;
  while (S.pool.length < count) {
    const p = makePoolRow();
    spacer.append(p.row);
    S.pool.push(p);
  }
  for (let k = 0; k < S.pool.length; k++) {
    const p = S.pool[k];
    const i = first + k;
    const r = S.rows[i];
    if (!r || k >= count) {
      if (!p.row.hidden) p.row.hidden = true;
      p.key = '';
      continue;
    }
    p.row.hidden = false;
    p.row.style.transform = `translateY(${i * ROW_H}px)`;
    const key = r.kind === 'group' ? `g:${r.key}:${r.count}:${S.collapsed.has(r.key)}` : `c:${r.id}`;
    if (key !== p.key || force) bindRow(p, r, key);
  }
  if (!S.rows.length) {
    if (!S.emptyEl) {
      S.emptyEl = el('div', 'vt-empty', 'No channels match the filters.');
      spacer.append(S.emptyEl);
    }
    S.emptyEl.hidden = false;
  } else if (S.emptyEl) S.emptyEl.hidden = true;
}

function bindRow(p, r, key) {
  const app = S.app;
  p.key = key;
  if (r.kind === 'group') {
    p.row.className = 'vt-row group';
    p.row.dataset.group = r.key;
    for (const c of [p.dot, p.name, p.val, p.unit, p.own, p.rate, p.sparkHost]) c.hidden = true;
    p.id.className = 'grp';
    const caret = S.collapsed.has(r.key) ? '▸' : '▾';
    p.id.textContent = `${caret}  ${r.label}`;
    p.id.hidden = false;
    p.rate.hidden = false;
    p.rate.className = 'rate';
    p.rate.textContent = `${r.count} channel${r.count > 1 ? 's' : ''}`;
    p.spark.set(new Float64Array(0));
    return;
  }
  const def = app.channels.get(r.id);
  p.row.className = 'vt-row';
  delete p.row.dataset.group;
  for (const c of [p.dot, p.id, p.name, p.val, p.unit, p.own, p.rate, p.sparkHost]) c.hidden = false;
  p.id.className = 'id';
  p.id.textContent = def.id;
  p.name.textContent = def.name;
  const range = `range ${formatNumber(def.min, null)} … ${formatNumber(def.max, null)} ${def.unit}`;
  const th = [['warn', def.warn_lo, def.warn_hi], ['crit', def.crit_lo, def.crit_hi]]
    .filter(([, lo, hi]) => isNum(lo) || isNum(hi))
    .map(([n, lo, hi]) => `${n} ${isNum(lo) ? `< ${lo}` : ''}${isNum(lo) && isNum(hi) ? ' / ' : ''}${isNum(hi) ? `> ${hi}` : ''}`).join(', ');
  p.row.title = `${def.id}: ${def.name}\n${range}, resolution ${def.resolution || 'n/a'}${th ? `\n${th}` : ''}`;
  p.unit.textContent = def.unit === '-' ? '' : def.unit;
  if (S.flash.has(def.id) && performance.now() < S.flashUntil) p.row.classList.add('flash');
  updateRowValues(p, def);
  updateSpark(p, def);
}

function updateRowValues(p, def) {
  const app = S.app;
  const st = app.status(def.id);
  if (p.dot.dataset.s !== st) { p.dot.dataset.s = st; p.dot.title = STATUS_LABEL[st]; }
  const v = app.latest.get(def.id);
  const txt = formatChannel(def, v, { unit: false });
  if (p.val.textContent !== txt) p.val.textContent = txt;
  const lvl = levelOf(def, v);
  if ((p.val.dataset.level || '') !== lvl) { if (lvl) p.val.dataset.level = lvl; else delete p.val.dataset.level; }
  const owner = app.owner.get(def.id) || '';
  const ownTxt = OWNER_LABEL[owner] || owner || MISSING;
  if (p.ownChip.textContent !== ownTxt) {
    p.ownChip.textContent = ownTxt;
    p.own.className = `own own-${owner}`;
  }
  const obs = app.rate(def.id);
  const nominal = def.rate_hz;
  let obsTxt;
  const steady = def.unit === 'bool' || def.unit === 'enum' || def.noise === 0;
  if (st === 'missing') obsTxt = MISSING;
  else if (!isNum(obs)) obsTxt = '…';
  else if (obs === 0 && steady) obsTxt = 'held';
  else obsTxt = formatNumber(obs, obs < 10 ? 1 : 0);
  const rateTxt = `${obsTxt} / ${formatCompact(nominal)} Hz`;
  if (p.rate.textContent !== rateTxt) p.rate.textContent = rateTxt;
  // server-measured rates are true sample rates; frame-based estimates cannot exceed the
  // broadcast rate per session second
  const expect = app.serverRates ? (nominal || 0) : Math.min(nominal || 0, app.frameDataHz || 20);
  const slow = st === 'live' && !steady && isNum(obs) && expect > 0.5 && obs < 0.4 * expect;
  p.rate.classList.toggle('slow', slow);
  p.rate.style.color = slow ? 'var(--warning)' : '';
}

function updateSpark(p, def) {
  const app = S.app;
  const st = app.status(def.id);
  const t = theme();
  p.spark.setColor(st === 'live' ? t.series[0] : t.text3);
  p.spark.set(app.hist.series(def.id, 30).v);
}

/* ================================================================== sources */

function renderSources() {
  const app = S.app;
  const host = S.els.sources;
  if (!host) return;
  host.replaceChildren();
  const owned = new Map();
  for (const k of app.owner.values()) owned.set(k, (owned.get(k) || 0) + 1);
  (app.sources || []).forEach((src, i) => {
    const card = el('div', 'card src-card');
    const top = el('div', 'src-top');
    const kind = el('span', `src-kind own-${src.kind}`, OWNER_LABEL[src.kind] || src.kind);
    const label = el('span', 'src-label', src.label || src.kind);
    const status = el('span', 'src-status');
    const dot = el('span', 'sdot');
    dot.dataset.s = src.status === 'running' ? 'live' : src.status === 'waiting' ? 'stale' : 'missing';
    if (src.status === 'error') dot.style.background = 'var(--critical)';
    status.append(dot, document.createTextNode(src.status || 'unknown'));
    top.append(kind, label, status);
    const detail = el('div', 'src-detail', src.detail || '');
    detail.title = src.detail || '';
    const stats = el('div', 'src-stats');
    const add = (k, v, bad = false) => {
      const s = el('span', bad ? 'bad' : '');
      s.append(document.createTextNode(`${k} `));
      s.append(el('b', '', v));
      stats.append(s);
    };
    add('priority', `${i + 1}${i === 0 ? ' (base)' : ''}`);
    if (owned.has(src.kind)) add('channels owned', String(owned.get(src.kind)));
    const st = src.stats || {};
    for (const [k, v] of Object.entries(st)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      const bad = /error|checksum|unknown|malformed|dropped|restart/i.test(k) && Number(v) > 0;
      const txt = typeof v === 'number' ? (Number.isInteger(v) ? formatCompact(v) : formatNumber(v, null, 3)) : String(v);
      add(k.replace(/_/g, ' '), txt, bad);
    }
    card.append(top, detail, stats);
    host.append(card);
  });
  if (!(app.sources || []).length) host.append(el('div', 'card src-card muted', 'No data sources reported.'));
}

/* ================================================================== update */

/**
 * Per-frame update: values 5 Hz, sparklines 2 Hz, status-filter rebuild 1 Hz, sources 1 Hz.
 * @param {object} app
 * @param {number} dtMs
 */
export function update(app, dtMs) {
  const a = S.acc;
  a.values += dtMs; a.sparks += dtMs; a.rebuild += dtMs; a.sources += dtMs;
  if (a.rebuild >= 1000) {
    a.rebuild = 0;
    if (S.status !== 'all') rebuild();
    else {
      // refresh the status counts without rebuilding the list
      const counts = { live: 0, stale: 0, missing: 0 };
      for (const id of app.channels.keys()) {
        const def = app.channels.get(id);
        if (S.only && !S.only.has(id)) continue;
        if (S.system !== 'all' && def.system !== S.system) continue;
        counts[app.status(id)]++;
      }
      for (const b of S.els.stSeg.querySelectorAll('[data-count]')) {
        if (b.dataset.count !== 'all') b.textContent = String(counts[b.dataset.count]);
      }
    }
  }
  if (a.values >= 200) {
    a.values = 0;
    const flashOn = performance.now() < S.flashUntil;
    for (const p of S.pool) {
      if (p.row.hidden || !p.key.startsWith('c:')) continue;
      const def = app.channels.get(p.key.slice(2));
      if (def) updateRowValues(p, def);
      if (!flashOn) p.row.classList.remove('flash');
    }
  }
  if (a.sparks >= 500) {
    a.sparks = 0;
    for (const p of S.pool) {
      if (p.row.hidden || !p.key.startsWith('c:')) continue;
      const def = app.channels.get(p.key.slice(2));
      if (def) updateSpark(p, def);
    }
  }
  if (a.sources >= 1000) {
    a.sources = 0;
    renderSources();
  }
}
