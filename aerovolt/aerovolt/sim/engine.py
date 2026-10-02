"""The simulation engine: the "virtual car" that powers demo mode (SPEC §5.3).

Every 10 ms physics step (``DT = 0.01`` s) the engine

1. applies scheduled / timed faults,
2. advances the wind (gusts) and finds the car on the track (``s`` → x, y, heading, κ),
3. computes the airflow the car feels (airspeed, flow yaw, q),
4. asks the driver for pedal / brake (PI on the lap-sim speed profile),
5. steps the powertrain (torque limits → power → pack current → 140 cells),
6. integrates the car's speed from the tyre, aero and rolling-resistance forces,
7. solves the aero ↔ ride-height fixed point (downforce compresses the springs, lower ride
   heights change the ground effect) and the suspension / IMU / wheel speeds,
8. runs the safety chain (IMD, BSPD, APPS; AMS and thermal models at 10 Hz),
9. counts laps at the start/finish gate,
10. writes every raw channel's *true* value into a vector, lets sensor faults corrupt it,
    and hands it to the :class:`VirtualSensorBank`, which emits the channels that are due
    at their catalogue rate — plus the ``truth_*`` channels at 20 Hz.

Use :meth:`SimEngine.step` (one step, returns the samples due) or
:meth:`SimEngine.run_offline` (no asyncio; for tests and headless runs). The asyncio source
that paces the engine against wall-clock time lives in :mod:`aerovolt.sim.source`.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from aerovolt.core import geo, physics
from aerovolt.core.catalog import Catalog
from aerovolt.core.model import Emit, FaultInfo
from aerovolt.sim import lapsim
from aerovolt.sim.aero_model import AeroModel, AeroState, AirModel, Weather, relative_airflow
from aerovolt.sim.faults import CURRENT_OFFSET_A, FaultSet, SensorFaults
from aerovolt.sim.powertrain_model import Powertrain, SafetyInputs
from aerovolt.sim.sensors import VirtualSensorBank
from aerovolt.sim.tracks import Track, get_track
from aerovolt.sim.vehicle_model import Chassis, Driver, SpeedProfile, SuspensionState, TrackCursor

#: Physics time step [s] (100 Hz).
DT = 0.01
#: Truth channels are published at this rate [Hz].
TRUTH_RATE_HZ = 20
#: Slow subsystems (thermal, BMS limits, AMS) run every this many steps (10 Hz).
SLOW_EVERY = 10
#: The car starts on the grid this far behind the start line [m] (closed tracks).
GRID_OFFSET_M = 10.0
#: Open tracks (acceleration): pause at the end of the run-off before the next run [s].
OPEN_TRACK_PAUSE_S = 3.0
#: APPS sensor 2 has its own transfer function: a small gain / offset mismatch [-, %].
APPS2_GAIN = 1.01
APPS2_OFFSET = -0.3
#: Typical aero squat used when re-solving the speed profile after a fault [mm].
PROFILE_SQUAT_MM = 5.0
#: Derating factor quantisation for profile re-solves.
DERATE_STEP = 0.1
#: Flow upwash at the nose-mounted 5-hole probe [deg] (added to the pitch attitude).
PROBE_UPWASH_DEG = 0.8
#: Faults that change the car's grip, so the driver's target speed is re-planned.
PROFILE_FAULTS = frozenset({"fw_damage_left", "rw_stall", "ut_bottoming"})


@dataclass
class SimStats:
    """Counters of an offline run."""

    steps: int = 0
    samples: int = 0
    sim_time: float = 0.0
    wall_time: float = 0.0

    @property
    def realtime_factor(self) -> float:
        return self.sim_time / self.wall_time if self.wall_time > 0 else float("inf")


class SimEngine:
    """The virtual car (see module docstring). All state is plain attributes for tests."""

    def __init__(
        self,
        vehicle: Mapping[str, Any],
        catalog: Catalog,
        track: Track | str = "fs_endurance",
        *,
        seed: int = 42,
        weather: Mapping[str, float] | Weather | None = None,
        faults: Iterable[str | Mapping[str, Any]] = (),
        laps: int | None = None,
        start_soc: float = 100.0,
        start_temp_c: float | None = None,
        power_limit_kw: float | None = None,
        dt: float = DT,
    ) -> None:
        self.vehicle = vehicle
        self.catalog = catalog
        self.track = get_track(track) if isinstance(track, str) else track
        self.cursor = TrackCursor(self.track)
        self.params = lapsim.VehicleParams.from_dict(vehicle)
        self.dt = float(dt)
        self.seed = int(seed)
        self.laps_limit = None if laps is None else int(laps)
        self.weather = weather if isinstance(weather, Weather) else Weather.from_config(weather)
        temp0 = self.weather.temp_c if start_temp_c is None else float(start_temp_c)
        streams = [np.random.default_rng(s) for s in np.random.SeedSequence(self.seed).spawn(6)]
        rng_sensors, rng_cells, rng_air, rng_road, rng_driver, rng_safety = streams

        self.air = AirModel(self.weather, rng_air, self.dt)
        self.aero = AeroModel(vehicle, catalog.taps())
        self.chassis = Chassis(vehicle, rng_road, self.dt)
        self.powertrain = Powertrain(vehicle, rng_cells, self.dt, soc=float(start_soc) / 100.0,
                                     temp_c=temp0, power_limit_kw=power_limit_kw, safety_rng=rng_safety)
        self.driver = Driver(self.params, rng_driver)
        self.sensor_faults = SensorFaults()
        self.faults = FaultSet(self, faults)
        self.gps_origin = vehicle.get("gps_origin", {"lat": 0.0, "lon": 0.0})
        brakes = vehicle["brakes"]
        self.brake_bias = float(brakes["bias_front"])
        self.brake_gain_f = float(brakes["gain_n_per_bar"]["front"])
        self.brake_gain_r = float(brakes["gain_n_per_bar"]["rear"])
        self.c_rr = self.params.c_rr

        raw = [catalog[cid] for cid in catalog.raw_ids()]
        self.bank = VirtualSensorBank(raw, self.dt, rng_sensors)
        self.index = self.bank.index
        self._x = np.zeros(len(raw))
        self._tap_idx = np.array([self.index[c] for c in self.aero.tap_ids])
        self._cellv_idx = np.array([self.index[c] for c in catalog.ids(group="bms.cell_v")])
        self._cellt_idx = np.array([self.index[c] for c in catalog.ids(group="bms.cell_t")])
        self._scalar_idx: np.ndarray | None = None
        self.truth_ids = catalog.truth_ids()
        self._truth_every = round(1.0 / (TRUTH_RATE_HZ * self.dt))
        self._gps_every = int(self.bank.period_steps[self.index["gps_lat"]])
        self._slow_dt = SLOW_EVERY * self.dt

        # state
        self.t = 0.0
        self.step_index = 0
        self.lap = 0                    # laps started (= truth_lap)
        self.lap_crossings: list[float] = []
        self.finished = False
        self._gates = self.cursor.gate_positions() or [0.0]
        self.chassis.s = -GRID_OFFSET_M if self.track.closed else 0.0
        self._s_prev = self.chassis.s
        self._open_pause = 0.0
        self._derate_level = 1.0
        self._gps = (0.0, 0.0)
        self._pedal = 0.0
        self._brake_f = self._brake_r = 0.0
        self._slip_f = self._slip_r = 0.0
        self._rates = (0.0, 0.0)
        self.profile = self._solve_profile()
        self.driver.new_lap()
        if not self.track.closed:
            self._cross_gate()  # an acceleration run starts on the line
        self._update_environment()
        self.aero_state, susp = self._solve_aero()
        self.chassis.set_suspension(susp)
        self.powertrain.slow_step(self._slow_dt, 0.0, self.weather.temp_c)
        self._update_gps()
        self.bank.reset(self._true_vector())

    # ------------------------------------------------------------------ construction
    @classmethod
    def from_config(cls, cfg: Mapping[str, Any], vehicle: Mapping[str, Any], catalog: Catalog,
                    default_track: str = "fs_endurance") -> SimEngine:
        """Build from a sim source config dict (SPEC §5 / ``core.config`` normalised form)."""
        return cls(
            vehicle, catalog, cfg.get("track") or default_track,
            seed=int(cfg.get("seed", 42)),
            weather=cfg.get("weather"),
            faults=cfg.get("faults") or (),
            laps=cfg.get("laps"),
            start_soc=float(cfg.get("start_soc", 100.0)),
            start_temp_c=cfg.get("start_temp_c"),
            power_limit_kw=cfg.get("power_limit_kw"),
        )

    # ------------------------------------------------------------------ faults
    def set_fault(self, fault_id: str, active: bool) -> bool:
        """Activate / clear a fault now (``KeyError`` if unknown); re-plan if needed."""
        changed = self.faults.set(fault_id, active)
        if changed:
            self._after_fault_change([fault_id])
        return changed

    def fault_infos(self) -> list[FaultInfo]:
        return self.faults.infos()

    def car_heading_deg(self) -> float:
        """Compass heading of the car now [deg]."""
        return self.cursor.heading_deg(self.cursor.at(self.chassis.s)[2])

    def _after_fault_change(self, ids: Iterable[str]) -> None:
        if set(ids) & PROFILE_FAULTS:
            self.profile = self._solve_profile()

    def _aero_scale(self) -> dict[str, float]:
        """Axle CL·A and CD·A of the car as it is now, relative to nominal (for lapsim)."""
        ch = self.chassis
        rh_f = ch.rh0_f + ch.ride_height_offset_mm - PROFILE_SQUAT_MM
        rh_r = ch.rh0_r + ch.ride_height_offset_mm - PROFILE_SQUAT_MM
        now = self.aero.evaluate(1.0, 1.0, 0.0, 1.0, rh_f, rh_r)
        flags = (self.aero.fw_damage_left, self.aero.rw_stall)
        self.aero.fw_damage_left = self.aero.rw_stall = False
        ref = self.aero.evaluate(1.0, 1.0, 0.0, 1.0, ch.rh0_f - PROFILE_SQUAT_MM, ch.rh0_r - PROFILE_SQUAT_MM)
        self.aero.fw_damage_left, self.aero.rw_stall = flags
        return {"cla_front": now.downforce_f / ref.downforce_f,
                "cla_rear": now.downforce_r / ref.downforce_r,
                "cda": now.cda / ref.cda}

    def _solve_profile(self) -> SpeedProfile:
        """The driver's target: lap sim with today's air, mean wind, car damage and derating."""
        pt = self.powertrain
        w = self.weather
        return SpeedProfile.solve(
            self.track, self.params,
            power_limit_kw=pt.power_limit_w / 1e3 * self._derate_level,
            aero_scale=self._aero_scale(), rho=self.air.rho,
            wind={"speed": w.wind_ms, "dir_deg": w.wind_dir_deg} if w.wind_ms > 0 else None,
        )

    # ------------------------------------------------------------------ main loop
    def run_offline(self, duration_s: float, emit: Emit | None = None,
                    clock: Callable[[], float] | None = None) -> SimStats:
        """Run ``duration_s`` of sim time as fast as possible (no asyncio).

        ``emit(t, values)`` receives the initial full sample at the current time and then
        every step's due samples. Stops early if a lap limit is reached.
        """
        import time

        now = clock or time.perf_counter
        stats = SimStats()
        t_end = self.t + duration_s - 0.5 * self.dt
        wall0 = now()
        if emit is not None and self.step_index == 0:
            first = self.sample_all()
            emit(self.t, first)
            stats.samples += len(first)
        while self.t < t_end and not self.finished:
            values = self.step()
            stats.steps += 1
            if emit is not None and values:
                emit(self.t, values)
                stats.samples += len(values)
        stats.sim_time = stats.steps * self.dt
        stats.wall_time = now() - wall0
        return stats

    def sample_all(self) -> dict[str, float]:
        """A measurement of every raw channel plus the truth channels, now."""
        out = self.bank.sample(0)
        out.update(self.truth())
        return out

    def step(self) -> dict[str, float]:
        """Advance one physics step; return the measurements due (``{}`` when finished)."""
        if self.finished:
            return {}
        dt = self.dt
        self.step_index += 1
        k = self.step_index
        self.t = k * dt
        changed = self.faults.due(self.t)
        if changed:
            self._after_fault_change(changed)

        self.air.step(self.t)
        ch, pt, safety = self.chassis, self.powertrain, self.powertrain.safety
        aero_prev = self.aero_state

        # ---- driver -------------------------------------------------------------------
        rolling = self.c_rr * (ch.mass * physics.G + aero_prev.downforce_f + aero_prev.downforce_r)
        moving_on = self._open_pause <= 0.0
        cmd = self.driver.control(dt, ch.s, ch.v, self.profile,
                                  may_drive=safety.driving and moving_on,
                                  resist_n=aero_prev.drag_x + rolling,
                                  torque_cut=not safety.apps_ok)
        self._pedal = cmd.pedal_pct

        # ---- powertrain (rear-wheel drive, traction control, regen on the rear brakes) ---
        susp = ch.susp
        f_zr = susp.load[2] + susp.load[3]
        lat_use = (1.0 - ch.wf) * ch.mass * abs(ch.ay) / (self.params.mu_lat * max(f_zr, 1.0))
        ellipse = math.sqrt(1.0 - lat_use * lat_use) if lat_use < 1.0 else 0.0
        traction_torque = self.params.mu_long * ellipse * f_zr / self.driver.wheel_per_nm
        regen_request = (1.0 - self.brake_bias) * cmd.brake_force_n
        out = pt.step(dt, pedal_pct=cmd.pedal_pct, regen_force_request=regen_request,
                      wheel_omega=ch.v * (1.0 + self._slip_r) / ch.r_wheel,
                      traction_torque=traction_torque, car_speed=ch.v)
        gear_r = pt.gear / ch.r_wheel
        f_drive = out.torque * gear_r * pt.eta_dl if out.torque > 0.0 else 0.0
        f_regen = out.regen_force
        f_brake_f = self.brake_bias * cmd.brake_force_n
        f_brake_r = max((1.0 - self.brake_bias) * cmd.brake_force_n - f_regen, 0.0)
        f_shaft = out.shaft_drag * gear_r
        f_brakes = f_brake_f + f_brake_r + f_regen
        if ch.v <= 0.0:  # friction holds a stationary car; it does not push it backwards
            f_brakes = min(f_brakes, max(f_drive - aero_prev.drag_x - rolling, 0.0))
        force = f_drive - f_brakes - aero_prev.drag_x - rolling - f_shaft
        _, _, _, kappa = self.cursor.at(ch.s)
        ch.advance(dt, force, kappa)
        self._brake_f, self._brake_r = f_brake_f, f_brake_r

        # ---- aero ↔ ride height, suspension -------------------------------------------
        self._update_environment()
        ch.step_road(ch.v)
        self.aero_state, susp = self._solve_aero()
        self._rates = ch.set_suspension(susp)
        self.aero.update_floor_state(susp.rh_front, susp.rh_rear)
        load_f = ch.susp.load[0] + ch.susp.load[1]
        load_r = ch.susp.load[2] + ch.susp.load[3]
        self._slip_r = ch.slip(f_drive - f_brake_r - f_regen, load_r)
        self._slip_f = ch.slip(-f_brake_f, load_f)

        # ---- safety chain, BMS, slow subsystems ---------------------------------------
        apps1, apps2 = self._apps_sensors(cmd.pedal_pct)
        if self.sensor_faults.apps2_stuck:
            apps2 = 0.0
        safety.update(dt, SafetyInputs(
            pack_ocv=pt.pack.open_circuit_voltage, car_speed=ch.v, apps1=apps1, apps2=apps2,
            brake_press_f=f_brake_f / self.brake_gain_f, p_dc=out.p_dc))
        measured_current = out.pack_current + (CURRENT_OFFSET_A if self.sensor_faults.current_offset else 0.0)
        pt.count_bms_soc(measured_current, dt)
        if k % SLOW_EVERY == 0:
            pt.slow_step(self._slow_dt, self.aero_state.airspeed, self.weather.temp_c)
            self._check_derating()

        # ---- laps ---------------------------------------------------------------------
        self._count_laps()
        if self.finished:
            return {}

        # ---- measurements -------------------------------------------------------------
        if k % self._gps_every == 0:
            self._update_gps()
        self.bank.update(self._true_vector())
        out_values = self.bank.sample(k)
        if k % self._truth_every == 0:
            out_values.update(self.truth())
        return out_values

    # ------------------------------------------------------------------ helpers
    def _update_environment(self) -> None:
        """Track position, heading and the airflow the car feels at its current state."""
        ch = self.chassis
        x, y, theta, kappa = self.cursor.at(ch.s)
        self.pos = (x, y)
        self.heading = self.cursor.heading_deg(theta)
        self.kappa = kappa
        self.airspeed, self.yaw, self.u_x = relative_airflow(ch.v, self.heading, self.air.wind_e, self.air.wind_n)
        self.q = 0.5 * self.air.rho * self.airspeed * self.airspeed

    def _solve_aero(self) -> tuple[AeroState, SuspensionState]:
        """Fixed point: downforce(ride height) ↔ ride height(downforce).

        Two iterations starting from last step's ride heights are plenty: a 1 mm change of
        ride height changes the axle downforce by ≈ 1 %, i.e. a few newtons, which moves the
        ride height by a few hundredths of a millimetre (contraction factor ≈ 0.03).
        """
        ch = self.chassis
        susp = ch.susp
        for _ in range(2):
            state = self.aero.evaluate(self.q, self.airspeed, self.yaw, self.u_x, susp.rh_front, susp.rh_rear)
            susp = ch.suspension(ch.ax, ch.ay, state.downforce_f, state.downforce_r)
        return state, susp

    def _apps_sensors(self, pedal: float) -> tuple[float, float]:
        """True outputs of the two pedal sensors [%] (APPS2 has a slightly different transfer)."""
        a2 = pedal * APPS2_GAIN + APPS2_OFFSET if pedal > 0.0 else 0.0
        return pedal, min(max(a2, 0.0), 100.0)

    def _check_derating(self) -> None:
        """Re-plan the driver's target when temperature derating changes the usable power."""
        level = math.floor(self.powertrain.derate / DERATE_STEP) * DERATE_STEP
        level = max(level, DERATE_STEP)
        if abs(level - self._derate_level) > 1e-9:
            self._derate_level = level
            self.profile = self._solve_profile()

    def _cross_gate(self) -> None:
        self.lap += 1
        self.lap_crossings.append(self.t)
        self.driver.new_lap()
        if self.laps_limit is not None and self.lap > self.laps_limit:
            self.finished = True

    def _count_laps(self) -> None:
        ch = self.chassis
        s0, s1 = self._s_prev, ch.s
        self._s_prev = s1
        if self.track.closed:
            length = self.cursor.length
            for g in self._gates:
                if math.floor((s1 - g) / length) > math.floor((s0 - g) / length):
                    self._cross_gate()
            return
        # open track: stop at the end of the run-off, pause, then start the next run
        if ch.s >= self.cursor.length - 0.5 or (ch.v < 0.05 and ch.s > self.track.finish_s):
            self._open_pause += self.dt
            if self._open_pause >= OPEN_TRACK_PAUSE_S:
                ch.s = self._s_prev = 0.0
                ch.v = 0.0
                self._open_pause = 0.0
                self._cross_gate()

    def _update_gps(self) -> None:
        self._gps = geo.xy_to_latlon(self.pos[0], self.pos[1], self.gps_origin)

    @property
    def lap_times(self) -> list[float]:
        """Completed lap times [s] (between consecutive gate crossings)."""
        c = self.lap_crossings
        return [b - a for a, b in zip(c, c[1:])]

    # ------------------------------------------------------------------ channel values
    def _true_vector(self) -> np.ndarray:
        """True value of every raw channel (catalogue raw order), sensor faults applied."""
        ch, pt, aero = self.chassis, self.powertrain, self.aero_state
        safety, cool, out = pt.safety, pt.cooling, pt.out
        imu = ch.imu()
        pushrods = ch.pushrods()
        dampers = ch.dampers()
        ws = ch.wheel_speeds(self.kappa, self._slip_f, self._slip_r)
        apps1, apps2 = self._apps_sensors(self._pedal)
        air_pos, air_neg = safety.air_closed
        omega = out.omega
        values = {
            "pitot_dp": aero.q,
            "amb_temp": self.weather.temp_c,
            "amb_press": self.weather.pressure_pa,
            "amb_rh": self.weather.rh_pct,
            "probe_yaw": aero.yaw_deg,
            "probe_pitch": ch.susp.pitch_deg + PROBE_UPWASH_DEG,
            "rh_front": ch.susp.rh_front,
            "rh_rear": ch.susp.rh_rear,
            "fw_load": self.aero.wing_load(aero, "fw", imu[2]),
            "rw_load": self.aero.wing_load(aero, "rw", imu[2]),
            "damper_fl": dampers[0], "damper_fr": dampers[1], "damper_rl": dampers[2], "damper_rr": dampers[3],
            "pushrod_fl": pushrods[0], "pushrod_fr": pushrods[1],
            "pushrod_rl": pushrods[2], "pushrod_rr": pushrods[3],
            "ax": imu[0], "ay": imu[1], "az": imu[2],
            "gx": self._rates[0], "gy": self._rates[1], "gz": math.degrees(ch.v * self.kappa),
            "gps_lat": self._gps[0], "gps_lon": self._gps[1],
            "gps_speed": ch.v, "gps_heading": self.heading,
            "ws_fl": ws[0], "ws_fr": ws[1], "ws_rl": ws[2], "ws_rr": ws[3],
            "steer": ch.steering_wheel_deg(self.kappa),
            "apps1": apps1, "apps2": apps2,
            "brake_press_f": self._brake_f / self.brake_gain_f,
            "brake_press_r": self._brake_r / self.brake_gain_r,
            "mot_speed": omega * 60.0 / (2.0 * math.pi),
            "mot_torque": out.torque,
            "mot_winding_temp": cool.t_winding,
            "inv_dc_voltage": safety.v_dc,
            "inv_dc_current": out.pack_current,
            "inv_phase_current": pt.motor.phase_current(out.torque, omega),
            "inv_igbt_temp": cool.t_igbt,
            "inv_state": float(pt.inverter_state()),
            "inv_fault": float(pt.inverter_fault),
            "pack_voltage": out.pack_voltage,
            "pack_current": out.pack_current,
            "bms_soc": pt.bms_soc,
            "bms_state": float(safety.bms_state()),
            "bms_fault": float(safety.bms_fault),
            "cool_temp_in": cool.t_radiator,
            "cool_temp_out": cool.t_jacket,
            "cool_flow": cool.flow_lpm,
            "pump_duty": cool.pump_duty,
            "fan_duty": cool.fan_duty,
            "sdc_closed": float(safety.sdc_closed),
            "imd_ok": float(safety.imd_ok),
            "ams_ok": float(safety.ams_ok),
            "bspd_ok": float(safety.bspd_ok),
            "apps_plaus_ok": float(safety.apps_ok),
            "air_pos_closed": float(air_pos),
            "air_neg_closed": float(air_neg),
            "precharge_done": float(safety.precharge_done),
            "tsal_state": float(safety.tsal_hv),
            "imd_iso_kohm": safety.iso_kohm,
        }
        x = self._x
        if self._scalar_idx is None:
            self._scalar_idx = np.array([self.index[c] for c in values])
        x[self._scalar_idx] = list(values.values())
        x[self._tap_idx] = self.aero.tap_pressures(aero)
        x[self._cellv_idx] = pt.pack.voltage
        if self.step_index % SLOW_EVERY == 0:
            x[self._cellt_idx] = pt.pack.sensor_temperatures()
        if self.sensor_faults.any:
            x = x.copy()
            self.sensor_faults.apply(x, self.index)
        return x

    def truth(self) -> dict[str, float]:
        """Simulator ground truth (``truth_*``) — never produced by real sensors."""
        a = self.aero_state
        length = self.cursor.length
        return {
            "truth_speed": self.chassis.v,
            "truth_downforce_f": a.downforce_f,
            "truth_downforce_r": a.downforce_r,
            "truth_drag": a.drag,
            "truth_cla": a.cla,
            "truth_cda": a.cda,
            "truth_soc": 100.0 * self.powertrain.pack.soc_mean,
            "truth_s": self.chassis.s % length if self.track.closed else min(max(self.chassis.s, 0.0), length),
            "truth_lap": float(self.lap),
            "truth_wind_speed": self.air.speed,
            "truth_wind_dir": self.air.from_deg,
        }
