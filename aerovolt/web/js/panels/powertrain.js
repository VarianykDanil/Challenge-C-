/**
 * @file Powertrain tab (System 2: EV powertrain sensing) - SPEC §10 panel.
 *
 * Six cards on one screen (1366×768 and up):
 *
 * | card | module | what it answers |
 * |---|---|---|
 * | Accumulator | `pt_accumulator.js` | which cell is weak / hot? (5 × 28 cell map, V / T / ΔV) |
 * | State of charge | `pt_soc.js` | how much is left, and can we trust the number? (EKF vs CC) |
 * | Motor & inverter | `pt_motor.js` | how hard is the drive working, is it derating? |
 * | Cooling loop | `pt_cooling.js` | is the heat getting out? (live schematic, animated flow) |
 * | Shutdown circuit | `pt_safety.js` | is the car safe / energised? (SDC chain, TSAL, IMD) |
 * | Energy & strategy | `pt_strategy.js` | will we finish the endurance, at which power limit? |
 *
 * Update budget (SPEC §10: `update()` runs every animation frame while the tab is visible):
 * the cell map and every read-out refresh at 10 Hz, the strategy tiles at 4 Hz, the charts
 * at most once per frame through the shared `renderCharts()`; only the cooling-loop flow
 * dashes move every frame (three SVG attribute writes). Values are written to the DOM only
 * when their text changes, and nothing in the update path reads layout.
 */

import { AccumulatorCard } from './pt_accumulator.js';
import { CoolingCard } from './pt_cooling.js';
import { MotorCard } from './pt_motor.js';
import { SafetyCard } from './pt_safety.js';
import { SocCard } from './pt_soc.js';
import { StrategyCard } from './pt_strategy.js';
import { el } from './pt_common.js';

/** Extra channels charted here whose history `app.js` does not back-fill by default. */
export const HISTORY_CHANNELS = ['bms_soc', 'inv_dc_current', 'pack_current', 'calc_soc_cc', 'calc_soc_ekf', 'truth_soc'];

const DATA_PERIOD_MS = 100; // 10 Hz
const STRATEGY_PERIOD_MS = 250; // 4 Hz

/** @type {null | {acc: AccumulatorCard, soc: SocCard, motor: MotorCard, cool: CoolingCard,
 *   safety: SafetyCard, strat: StrategyCard, dataAcc: number, stratAcc: number}} */
let ui = null;

/**
 * Build the tab.
 * @param {HTMLElement} root
 * @param {object} app
 */
export function mount(root, app) {
  root.replaceChildren();
  const grid = el('div', 'pt-grid');
  root.append(grid);
  ui = {
    acc: new AccumulatorCard(grid, app),
    soc: new SocCard(grid, app),
    motor: new MotorCard(grid, app),
    cool: new CoolingCard(grid, app),
    safety: new SafetyCard(grid, app),
    strat: new StrategyCard(grid, app),
    dataAcc: Infinity,
    stratAcc: Infinity,
  };
  const backfill = () => app.loadHistory(HISTORY_CHANNELS.filter((id) => app.channels.has(id)));
  backfill();
  app.on('hello', () => {
    backfill();
    if (ui) ui.dataAcc = Infinity;
  });
}

/**
 * Per animation frame (only while the tab is visible).
 * @param {object} app
 * @param {number} dtMs
 */
export function update(app, dtMs) {
  if (!ui) return;
  ui.cool.animate(dtMs);
  ui.dataAcc += dtMs;
  if (ui.dataAcc >= DATA_PERIOD_MS) {
    const dt = Math.min(ui.dataAcc, 1000);
    ui.dataAcc = 0;
    ui.acc.update(app);
    ui.soc.update(app, dt);
    ui.motor.update(app);
    ui.cool.update(app);
    ui.safety.update(app);
  }
  ui.stratAcc += dtMs;
  if (ui.stratAcc >= STRATEGY_PERIOD_MS) {
    ui.stratAcc = 0;
    ui.strat.update(app);
  }
}
