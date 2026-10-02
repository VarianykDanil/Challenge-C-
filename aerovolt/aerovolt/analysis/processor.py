"""The analysis pipeline: raw channels in, ``calc_*`` channels and events out (SPEC section 6).

:class:`Processor` is called by the session at ``process_hz`` (20 Hz of *data* time, so an
accelerated simulation is analysed exactly like a real-time one). Each :meth:`Processor.tick`:

1. reads the newest value of every raw channel from the :class:`ChannelStore`, treating
   channels that are stale (no update for ``max(0.5 s, 5 / rate)``) or missing as NaN - so
   a dead sensor can never freeze a number on the dashboard;
2. aero: air data, Cp, section Cl, downforce, drag, coefficients
   (:mod:`~aerovolt.analysis.aero`), per-tap anomaly detection and element baselines
   (:mod:`~aerovolt.analysis.anomaly`);
3. powertrain: power, efficiency, cell statistics, energy, coolant heat
   (:mod:`~aerovolt.analysis.powertrain`) and SoC by Coulomb counting and EKF
   (:mod:`~aerovolt.analysis.soc`);
4. laps: GPS start/finish crossings, lap summaries (:mod:`~aerovolt.analysis.laps`) and,
   after every lap, the endurance strategy (:mod:`~aerovolt.analysis.strategy`);
5. alerts: every rule of ``config/alerts.yaml`` (:mod:`~aerovolt.analysis.alerts`);
6. writes all ``calc_*`` channels back with ``store.update(t, calc)`` and returns the
   events to broadcast, shaped like the SPEC section 9 WebSocket messages
   (``{"type": "alert", "alert": {...}}``, ``{"type": "lap", "lap": {...}}``,
   ``{"type": "strategy", "strategy": {...}}``).

The analysis never reads ``truth_*`` channels: it must work identically on a real car.
Missing channels give NaN outputs, never exceptions; an unexpected error inside one stage
is logged and counted (``stats['errors']``) and the other stages still run.
"""

from __future__ import annotations

import logging
import math
from collections import deque
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import yaml

from aerovolt.analysis import aero as aero_mod
from aerovolt.analysis.aero import AeroEstimator, AeroOutput, LowPass
from aerovolt.analysis.alerts import AlertEngine, AnalysisState
from aerovolt.analysis.anomaly import AeroHealthMonitor, TapAnomalyDetector
from aerovolt.analysis.laps import LapAccumulator, LapDetector
from aerovolt.analysis.powertrain import (
    CellDeviationTracker,
    EnergyIntegrator,
    cell_stats,
    coolant_heat_kw,
    drive_efficiency_pct,
    electrical_power_kw,
    mechanical_power_kw,
)
from aerovolt.analysis.soc import CoulombCounter, SocEkf, soc_from_voltage
from aerovolt.analysis.strategy import EnduranceStrategy, StrategyResult
from aerovolt.core import physics
from aerovolt.core.model import Alert, LapSummary

log = logging.getLogger(__name__)

NAN = float("nan")

#: Alert rules whose activity means "the aero is not normal right now": baselines freeze.
AERO_ALERT_PREFIX = "aero_"
PITOT_ALERT = "sensor_pitot_implausible"
#: A time jump backwards larger than this (s) means a new session (e.g. a replay looped).
TIME_RESET_S = 5.0
#: Low-pass time constant of the pack-vs-inverter current difference, s.
TAU_CURRENT_MISMATCH_S = 10.0
#: Stale-sensor alerts only while at least this fraction of the once-live channels is
#: still live (otherwise the whole source stopped - shown by the Sources panel instead).
DATA_FLOWING_FRACTION = 0.5
#: The SoC estimators start from the OCV of the first sample with |I| below this, A (at rest
#: the terminal voltage equals the open-circuit voltage) ...
SOC_INIT_MAX_CURRENT_A = 5.0
#: ... or, if the car never rests, after this long with the I*R0-corrected voltage, s.
SOC_INIT_WAIT_S = 10.0
#: Pack-current samples kept to pair each cell-voltage sample with the current at its time.
CURRENT_HISTORY_N = 64
#: Default alert rules file (used when the config has no ``paths.alerts`` file).
DEFAULT_ALERTS_PATH = Path(__file__).resolve().parents[2] / "config" / "alerts.yaml"


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x)


def load_alert_config(ctx: Any) -> dict[str, Any]:
    """Alert rules for a session: ``ctx.config.alerts`` or the project's default file."""
    cfg = getattr(getattr(ctx, "config", None), "alerts", None)
    if cfg:
        return dict(cfg)
    with open(DEFAULT_ALERTS_PATH, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


class Processor:
    """Computes every ``calc_*`` channel, laps, strategy and alerts (module docstring).

    Public API: :meth:`tick`, :meth:`active_alerts`, :attr:`alert_log`, :attr:`laps`,
    :attr:`strategy` (JSON dict of the last strategy, or None), :meth:`reset`.
    """

    def __init__(self, ctx: Any, store: Any, alert_config: Mapping[str, Any] | None = None) -> None:
        self.ctx = ctx
        self.store = store
        catalog = ctx.catalog
        vehicle = ctx.vehicle or {}
        self.vehicle = vehicle
        self.raw_ids = catalog.raw_ids()
        self.calc_ids = catalog.calc_ids()
        self.cell_v_ids = catalog.ids(group="bms.cell_v")
        self.cell_t_ids = catalog.ids(group="bms.cell_t")
        self._stale_after = {cid: store.stale_after(cid) for cid in self.raw_ids}

        self.aero = AeroEstimator(catalog, vehicle)
        self.taps = TapAnomalyDetector(self.aero.layout)
        self.aero_health = AeroHealthMonitor()

        self.cell_params = physics.CellParams.from_vehicle(vehicle) if "accumulator" in vehicle else physics.CellParams(parallel=4)
        self.ocv_table = physics.ocv_table_from_vehicle(vehicle)
        acc = vehicle.get("accumulator", {})
        self.n_series = int(acc.get("series", len(self.cell_v_ids) or 140))
        cooling = vehicle.get("cooling", {})
        self.coolant_density = float(cooling.get("coolant_density", 1040.0))
        self.coolant_cp = float(cooling.get("coolant_cp", 3600.0))

        raw_cfg = getattr(getattr(ctx, "config", None), "raw", {}) or {}
        self.laps_cfg = dict(raw_cfg.get("laps") or {})
        try:
            self.strategy_engine: EnduranceStrategy | None = EnduranceStrategy(vehicle, None)
        except (KeyError, TypeError, ValueError):
            log.warning("vehicle file lacks the data for the endurance strategy; strategy disabled")
            self.strategy_engine = None

        self.alert_engine = AlertEngine.from_config(
            alert_config if alert_config is not None else load_alert_config(ctx), vehicle)
        self.stats: dict[str, int] = {"ticks": 0, "errors": 0}
        self.reset()

    # ------------------------------------------------------------------ public API

    def reset(self) -> None:
        """Forget everything learned (new session): estimators, laps, alerts, baselines."""
        self.aero.reset()
        self.taps.reset()
        self.aero_health.reset()
        self.cc = CoulombCounter(self.cell_params.group_capacity_ah)
        self.ekf = SocEkf(self.cell_params, self.ocv_table)
        self._soc_initialised = False
        self._soc_wait = 0.0
        self._current_hist: deque[tuple[float, float]] = deque(maxlen=CURRENT_HISTORY_N)
        self._v_stamp = NAN
        self.energy = EnergyIntegrator()
        self.cells = CellDeviationTracker(len(self.cell_v_ids))
        self._current_mismatch = LowPass(TAU_CURRENT_MISMATCH_S)
        self.alert_engine.reset()
        self.laps: list[LapSummary] = []
        self.strategy_result: StrategyResult | None = None
        self._track: Any = object()  # sentinel: (re)build the lap detector on the first tick
        self.lap_detector = LapDetector.from_context(self.vehicle, None, self.laps_cfg)
        self._acc: LapAccumulator | None = None
        self._acc_key: tuple[int, float] | None = None
        self._lap_p_max = NAN
        self._lap_s = NAN
        self._seen_live: set[str] = set()
        self._sdc_armed = False
        self._t_prev = NAN

    @property
    def alert_log(self) -> list[Alert]:
        """Every alert raised this session (active and cleared), oldest first."""
        return list(self.alert_engine.log)

    def active_alerts(self) -> list[Alert]:
        """Alerts active now, oldest first."""
        return self.alert_engine.active()

    @property
    def strategy(self) -> dict[str, Any] | None:
        """The last strategy (JSON-ready dict), or None before the first completed lap."""
        return self.strategy_result.to_json() if self.strategy_result is not None else None

    def tick(self, t: float) -> list[dict[str, Any]]:
        """Run the whole analysis at session time ``t``; returns the events to broadcast."""
        if not _finite(t):
            return []
        if _finite(self._t_prev) and t < self._t_prev - TIME_RESET_S:
            self.reset()
        dt = t - self._t_prev if _finite(self._t_prev) else 0.0
        dt = max(dt, 0.0)
        self._t_prev = t
        self.stats["ticks"] += 1
        self._sync_track()

        events: list[dict[str, Any]] = []
        calc: dict[str, float] = {cid: NAN for cid in self.calc_ids}
        aux: dict[str, Any] = {}
        values, stale = self._read_inputs(t)

        aero_out = self._stage("aero", self._aero, dt, values, calc, aux)
        self._stage("powertrain", self._powertrain, dt, values, calc, aux)
        self._stage("laps", self._laps, t, dt, values, calc, aero_out, events)

        merged: dict[str, Any] = {**values, **calc, **aux}
        state = AnalysisState(
            t=t, values=merged, taps=self.taps, aero_health=self.aero_health, cells=self.cells,
            cell_t_ids=self.cell_t_ids, cell_v_ids=self.cell_v_ids, strategy=self.strategy_result,
            stale=stale, sdc_armed=self._sdc_armed, current_mismatch_a=self._current_mismatch.value,
            pack_capacity_ah=self.cell_params.group_capacity_ah,
        )
        changed = self._stage("alerts", self.alert_engine.evaluate, state) or []
        events.extend({"type": "alert", "alert": a.to_json()} for a in changed)

        self.store.update(t, calc)
        return events

    # ------------------------------------------------------------------ stages

    def _stage(self, name: str, fn: Any, *args: Any) -> Any:
        try:
            return fn(*args)
        except Exception:  # keep the telemetry alive; the error is logged and counted
            self.stats["errors"] += 1
            log.exception("analysis stage %s failed", name)
            return None

    def _sync_track(self) -> None:
        """Pick up ``ctx.track`` (the sim source sets it when it starts)."""
        track = getattr(self.ctx, "track", None)
        if track is self._track:
            return
        self._track = track
        self.lap_detector = LapDetector.from_context(self.vehicle, track, self.laps_cfg)
        if self.strategy_engine is not None:
            self.strategy_engine.track = track
        self._acc, self._acc_key = None, None

    def _read_inputs(self, t: float) -> tuple[dict[str, float], dict[str, float]]:
        """Live raw values (stale/missing -> NaN) and the stale once-live channels."""
        timestamp, latest = self.store.timestamp, self.store.latest
        stale_after, seen_live = self._stale_after, self._seen_live
        values: dict[str, float] = {}
        stale: dict[str, float] = {}
        live_count = 0
        for cid in self.raw_ids:
            age = t - timestamp(cid)  # NaN if never received
            if age <= stale_after[cid]:
                values[cid] = latest(cid)
                live_count += 1
                seen_live.add(cid)
            else:
                values[cid] = NAN
                if age > 0.0 and cid in seen_live:
                    stale[cid] = age
        if stale and live_count < DATA_FLOWING_FRACTION * len(self._seen_live):
            stale = {}  # the whole source stopped: not a single-sensor problem
        sdc = values.get("sdc_closed", NAN)
        if _finite(sdc) and sdc >= 0.5:
            self._sdc_armed = True
        return values, stale

    def _aero(self, dt: float, v: dict[str, float], calc: dict[str, float], aux: dict[str, Any]) -> AeroOutput:
        pitot_ok = not self.alert_engine.is_active(PITOT_ALERT)
        out = self.aero.update(dt, v, pitot_ok=pitot_ok, tap_mask=self.taps.mask)
        calc.update(out.channels)
        aero_alert = any(a.rule.startswith(AERO_ALERT_PREFIX) or a.rule == PITOT_ALERT
                         for a in self.alert_engine.active())
        self.taps.update(out.cp, dt, out.steady, learn_ok=not aero_alert)
        ax = v.get("ax", NAN)
        quasi_static = _finite(ax) and abs(ax) < aero_mod.MAX_ABS_AX_FOR_DOWNFORCE
        self.aero_health.update(
            {**{f"cl_{k}": val for k, val in out.cl_lp.items()},
             "cp_ut_mean": out.cp_ut_mean_lp, "balance": out.channels["calc_aero_balance"]},
            dt, steady=out.steady and quasi_static, learn_ok=not aero_alert)
        aux.update({
            "aux_q_source": out.q_source,
            "aux_q_pitot": out.q_pitot,
            "aux_airspeed_pitot": out.airspeed_pitot,
            "aux_yaw_abs_lp": out.yaw_abs_lp,
            "aux_aero_steady": 1.0 if out.steady else 0.0,
            "aux_abs_ax": abs(ax) if _finite(ax) else NAN,
            "aux_cl_fw_l": out.cl_lp["fw_l"],
            "aux_cl_fw_r": out.cl_lp["fw_r"],
        })
        return out

    def _powertrain(self, dt: float, v: dict[str, float], calc: dict[str, float], aux: dict[str, Any]) -> None:
        pack_v = _first_finite(v.get("pack_voltage", NAN), v.get("inv_dc_voltage", NAN))
        pack_i = _first_finite(v.get("pack_current", NAN), v.get("inv_dc_current", NAN))
        pack_kw = electrical_power_kw(pack_v, pack_i)
        inv_kw = _first_finite(electrical_power_kw(v.get("inv_dc_voltage", NAN), v.get("inv_dc_current", NAN)), pack_kw)
        mech_kw = mechanical_power_kw(v.get("mot_torque", NAN), v.get("mot_speed", NAN))
        calc["calc_pack_power"] = pack_kw
        calc["calc_mot_power"] = mech_kw
        calc["calc_inv_eff"] = drive_efficiency_pct(mech_kw, inv_kw)
        if _finite(pack_kw):
            self._lap_p_max = pack_kw if not self._lap_p_max >= pack_kw else self._lap_p_max

        cell_v = np.array([v.get(cid, NAN) for cid in self.cell_v_ids])
        cs = cell_stats(cell_v)
        calc["calc_cell_v_min"] = cs.min
        calc["calc_cell_v_max"] = cs.max
        calc["calc_cell_v_delta"] = cs.spread * 1000.0
        calc["calc_cell_v_min_idx"] = float(cs.min_idx) if cs.min_idx is not None else NAN
        temps = np.array([v.get(cid, NAN) for cid in self.cell_t_ids])
        ts = cell_stats(temps)
        calc["calc_cell_t_max"] = ts.max
        calc["calc_cell_t_max_idx"] = float(ts.max_idx) if ts.max_idx is not None else NAN
        calc["calc_cell_t_mean"] = ts.mean
        if ts.max_idx is not None:
            cells = physics.temp_sensor_cells(ts.max_idx, len(self.cell_v_ids) or 140, len(self.cell_t_ids))
            aux["aux_cell_t_max_id"] = self.cell_t_ids[ts.max_idx]
            aux["aux_cell_t_max_label"] = f"{self.cell_t_ids[ts.max_idx]} (cells {cells.start}-{cells.stop - 1})"
        if cs.min_idx is not None:
            seg = self.store.catalog[self.cell_v_ids[cs.min_idx]].meta.get("segment", "?")
            aux["aux_cell_v_min_id"] = self.cell_v_ids[cs.min_idx]
            aux["aux_cell_v_min_label"] = f"cell {cs.min_idx} (segment {seg})"

        self.energy.step(pack_kw, dt)
        calc["calc_energy_used"] = self.energy.used_kwh
        calc["calc_energy_regen"] = self.energy.regen_kwh
        calc["calc_cool_heat"] = coolant_heat_kw(v.get("cool_flow", NAN), v.get("cool_temp_in", NAN),
                                                 v.get("cool_temp_out", NAN), self.coolant_density, self.coolant_cp)

        # State of charge: mean cell voltage is the EKF measurement.
        v_mean = cs.mean if cs.valid >= max(1, len(self.cell_v_ids) // 2) else (
            pack_v / self.n_series if _finite(pack_v) else NAN)
        if not self._soc_initialised and _finite(v_mean) and _finite(pack_i):
            self._soc_wait += dt
            if abs(pack_i) <= SOC_INIT_MAX_CURRENT_A or self._soc_wait >= SOC_INIT_WAIT_S:
                soc0 = soc_from_voltage(v_mean, pack_i, self.cell_params, self.ocv_table)
                self.cc.initialise(soc0)
                self.ekf.reset(soc0)
                self._soc_initialised = True
        elif self._soc_initialised:
            self.cc.step(pack_i, dt)
            self._ekf_step(pack_i, v_mean, dt)
        if self._soc_initialised:  # estimates may stray a hair outside 0..1 (noise, regen)
            calc["calc_soc_cc"] = min(max(self.cc.soc, 0.0), 1.0) * 100.0
            calc["calc_soc_ekf"] = min(max(self.ekf.soc, 0.0), 1.0) * 100.0

        self.cells.update(cell_v, pack_i, dt)
        p_cur, i_cur = v.get("pack_current", NAN), v.get("inv_dc_current", NAN)
        if _finite(p_cur) and _finite(i_cur):
            self._current_mismatch.update(p_cur - i_cur, dt)
        apps = [x for x in (v.get("apps1", NAN), v.get("apps2", NAN)) if _finite(x)]
        aux["aux_apps_max"] = max(apps) if apps else NAN

    def _ekf_step(self, pack_i: float, v_mean: float, dt: float) -> None:
        """EKF: predict every tick with the newest current; correct once per *new* cell-voltage
        sample, with the current interpolated at that sample's time.

        Cell voltages arrive at 10 Hz, the current at 100 Hz: pairing a voltage with a current
        measured up to 0.1 s later would turn every throttle change into a false voltage error
        (``dI R0`` ~ 0.3 V for a 100 A step), and re-using one sample on two ticks would
        double-count its information.
        """
        if not _finite(pack_i):
            return
        if dt > 0.0:
            self.ekf.predict(pack_i, min(dt, 1.0))
        stamp_i = self.store.timestamp("pack_current")
        if _finite(stamp_i) and (not self._current_hist or stamp_i > self._current_hist[-1][0]):
            self._current_hist.append((stamp_i, pack_i))
        stamp_v = self.store.timestamp(self.cell_v_ids[0]) if self.cell_v_ids else NAN
        if not _finite(stamp_v):
            stamp_v = self.store.timestamp("pack_voltage")
        if not (_finite(v_mean) and _finite(stamp_v)) or stamp_v == self._v_stamp:
            return
        self._v_stamp = stamp_v
        if len(self._current_hist) >= 2:
            ts, cur = zip(*self._current_hist)
            i_at_v = float(np.interp(stamp_v, ts, cur))
        else:
            i_at_v = pack_i
        self.ekf.correct(v_mean, i_at_v)

    def _laps(self, t: float, dt: float, v: dict[str, float], calc: dict[str, float],
              aero_out: AeroOutput | None, events: list[dict[str, Any]]) -> None:
        det = self.lap_detector
        lap_event = det.update(self.store.timestamp("gps_lat"), v.get("gps_lat", NAN), v.get("gps_lon", NAN))

        speed = v.get("gps_speed", NAN)
        if not _finite(speed):
            wheels = [v.get(w, NAN) for w in ("ws_fl", "ws_fr")]
            wheels = [w for w in wheels if _finite(w)]
            speed = float(np.mean(wheels)) if wheels else NAN

        key = (det.lap, det.lap_start)
        if self._acc is None:
            self._acc = LapAccumulator(t, self.energy.net_kwh, self.energy.regen_kwh)
            self._acc_key = key
        if lap_event is not None:
            summary = self._acc.summary(lap_event.lap, lap_event.lap_time, self.energy.net_kwh, self.energy.regen_kwh)
            self.laps.append(summary)
            events.append({"type": "lap", "lap": summary.to_json()})
            self._run_strategy(calc, events)
        if key != self._acc_key:
            self._acc = LapAccumulator(t, self.energy.net_kwh, self.energy.regen_kwh)
            self._acc_key = key
            self._lap_p_max = NAN

        q = aero_out.q if aero_out is not None else NAN
        self._acc.add(dt, speed, calc["calc_cla"], calc["calc_cda"], calc["calc_aero_balance"],
                      aero_valid=_finite(q) and q > aero_mod.Q_COEFF_MIN_PA,
                      cell_t_max=calc["calc_cell_t_max"], cell_v_min=calc["calc_cell_v_min"],
                      mot_temp=v.get("mot_winding_temp", NAN))

        calc["calc_lap"] = float(det.lap)
        calc["calc_lap_time"] = t - det.lap_start if _finite(det.lap_start) else NAN
        if det.track is not None and det.position is not None:
            self._lap_s = det.lap_distance(self._lap_s if _finite(self._lap_s) else None)
            calc["calc_lap_dist"] = self._lap_s
        else:
            calc["calc_lap_dist"] = self._acc.distance if det.lap >= 1 else NAN

        strat = self.strategy_engine
        if strat is not None:
            total = strat.laps_total(None if det.track is not None else _median_lap_distance(self.laps))
            if total is not None:
                calc["calc_laps_needed"] = float(max(0, total - len(self.laps)))
            res = self.strategy_result
            if res is not None:
                soc = _first_finite(calc.get("calc_soc_ekf", NAN), calc.get("calc_soc_cc", NAN), v.get("bms_soc", NAN))
                remaining = strat.energy_remaining_kwh(soc)
                if _finite(remaining) and _finite(res.energy_per_lap_kwh) and res.energy_per_lap_kwh > 0:
                    calc["calc_laps_remaining"] = max(0.0, remaining - strat.reserve_kwh) / res.energy_per_lap_kwh
                calc["calc_power_limit_rec"] = res.recommended_kw

    def _run_strategy(self, calc: dict[str, float], events: list[dict[str, Any]]) -> None:
        """Evaluate the endurance strategy after a completed lap (SoC: EKF, else CC)."""
        strat = self.strategy_engine
        if strat is None:
            return
        soc = _first_finite(calc.get("calc_soc_ekf", NAN), calc.get("calc_soc_cc", NAN))
        rho = calc.get("calc_rho", NAN)
        result = strat.evaluate(self.laps, soc, current_kw=self._lap_p_max,
                                rho=rho if _finite(rho) else 1.2)
        self.strategy_result = result
        events.append({"type": "strategy", "strategy": result.to_json()})


def _first_finite(*xs: float) -> float:
    for x in xs:
        if _finite(x):
            return float(x)
    return NAN


def _median_lap_distance(laps: list[LapSummary]) -> float | None:
    d = [lap.distance for lap in laps if _finite(lap.distance) and lap.distance > 0]
    return float(np.median(d)) if d else None
