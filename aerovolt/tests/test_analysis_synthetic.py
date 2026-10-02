"""Synthetic car data for the analysis tests (plus tests of the generator itself).

The analysis must not depend on the simulator engine, so the processor tests drive it with
this small, *self-consistent* stand-in built only from ``core.physics`` and
``sim.lapsim``: the lap simulator gives speed, acceleration, power and motor torque along
``fs_endurance``; from them we synthesise every raw channel with the same physics the
analysis inverts (pushrod loads from downforce and load transfer, pitot q from airspeed,
cell voltages from an equivalent-circuit model per cell, ...), plus sensor noise and a
few injectable faults with the magnitudes of SPEC section 5.5.

Other analysis test modules import :class:`SyntheticCar` and :func:`make_processor`.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest

from aerovolt.analysis.processor import Processor
from aerovolt.core import geo, physics
from aerovolt.core.config import load_config
from aerovolt.core.source import SessionContext
from aerovolt.core.store import ChannelStore
from aerovolt.sim import lapsim
from aerovolt.sim.tracks import get_track

G = physics.G

#: Pressure-coefficient shapes at the tap positions (x/c order of the catalogue).
FW_SUCTION = np.array([-3.3, -2.5, -1.55, -0.65])  # x/c 0.05 0.20 0.45 0.75
FW_PRESSURE = np.array([0.80, 0.38])  # x/c 0.10 0.50
RW_SUCTION = np.array([-2.8, -2.1, -1.30, -0.55])
RW_PRESSURE = np.array([0.70, 0.32])
UT = np.array([-0.9, -1.7, -2.3, -1.7, -1.0, -0.35, -1.05, -1.05])

FAULTS = {"tap_leak", "fw_damage_left", "fw_cluster_left", "rw_stall", "ut_bottoming", "pitot_blocked",
          "crosswind_gust", "cell_hot", "cell_weak", "current_offset", "pump_fail", "imd_fault",
          "apps_implausible", "sdc_open"}

_CONFIG = None


def config():
    """The default project configuration (loaded once)."""
    global _CONFIG
    if _CONFIG is None:
        _CONFIG = load_config(None)
    return _CONFIG


def make_processor(track: Any = "fs_endurance", alert_config: dict | None = None) -> tuple[Processor, ChannelStore]:
    """A processor + store on the real catalogue / vehicle / alert rules."""
    cfg = config()
    ctx = SessionContext(cfg, cfg.catalog, cfg.vehicle, cfg.root,
                         track=get_track(track) if isinstance(track, str) else track)
    store = ChannelStore(cfg.catalog, history_s=60, snapshot_hz=20)
    return Processor(ctx, store, alert_config=alert_config), store


class SyntheticCar:
    """A virtual car lapping ``fs_endurance`` along the lap-simulator speed profile.

    ``faults`` maps fault id -> activation time (s). ``step(dt)`` advances the car and
    returns ``{channel: value}`` for the channels due at this step (GPS at 10 Hz, cell
    voltages at 10 Hz, cell temperatures at 2 Hz, ambient at 1 Hz, the rest every step).
    """

    def __init__(self, seed: int = 1, faults: dict[str, float] | None = None, wind: tuple[float, float] = (0.0, 0.0),
                 power_scale: float = 1.0, soc0: float = 0.95, rest_s: float = 1.0) -> None:
        cfg = config()
        self.vehicle = cfg.vehicle
        self.catalog = cfg.catalog
        self.track = get_track("fs_endurance")
        self.params = lapsim.VehicleParams.from_dict(self.vehicle)
        self.lap = lapsim.solve(self.track, self.params)
        self.power_scale = power_scale
        self.rng = np.random.default_rng(seed)
        self.faults = dict(faults or {})
        unknown = set(self.faults) - FAULTS
        assert not unknown, unknown
        self.wind_speed, self.wind_from = wind
        self.rest_s = rest_s  # standing on the grid (TS active, no current) before the start
        self.t = 0.0
        self.s = 0.0
        self._k = 0
        self.rho = physics.moist_air_density(18.0, 101325.0, 60.0)

        v = self.vehicle
        self.m = float(v["mass_kg"])
        self.wdf = float(v["weight_dist_front"])
        self.h = float(v["cg_height_m"])
        self.wb = float(v["wheelbase_m"])
        self.r = float(v["wheel_radius_m"])
        self.mu_kg = float(v["unsprung_mass_corner_kg"])
        self.ratio_f = float(v["suspension"]["pushrod_ratio"]["front"])
        self.ratio_r = float(v["suspension"]["pushrod_ratio"]["rear"])
        self.gear = float(v["powertrain"]["gear_ratio"])
        self.eta = float(v["powertrain"]["driveline_efficiency"])
        self.crr = float(v["tyres"]["c_rr"])
        self.cla = float(v["aero"]["cla_ref"])
        self.cda = float(v["aero"]["cda_ref"])
        self.balance = lapsim.aero_balance_front(v)
        self.fw_share = float(v["aero"]["share"]["front_wing"])
        self.gain_f = float(v["brakes"]["gain_n_per_bar"]["front"])
        self.gain_r = float(v["brakes"]["gain_n_per_bar"]["rear"])
        self.bias = float(v["brakes"]["bias_front"])

        # Accumulator: 140 series groups with manufacturing spread.
        self.cell = physics.CellParams.from_vehicle(v)
        self.table = physics.ocv_table_from_vehicle(v)
        n = 140
        self.cap = self.cell.group_capacity_ah * (1.0 + self.rng.uniform(-0.015, 0.015, n))
        self.r0 = self.cell.group_r0 * (1.0 + self.rng.uniform(-0.05, 0.05, n))
        self.soc = np.full(n, soc0)
        self.v_rc = np.zeros(n)
        self.temp = np.full(n, 25.0)
        self.v_cell = np.asarray(physics.ocv(self.soc, self.table))
        self.mot_temp = 80.0
        self.igbt_temp = 60.0
        self.cool_in, self.cool_out = 40.0, 43.0
        self.flow = 8.0
        self.true_soc_mean = soc0

    def active(self, fault: str) -> bool:
        return fault in self.faults and self.t >= self.faults[fault]

    def _at(self, arr: np.ndarray) -> float:
        return float(np.interp(self.s % self.track.length, self.lap.s, arr, period=self.track.length))

    def _noise(self, sigma: float) -> float:
        return float(self.rng.normal(0.0, sigma))

    def step(self, dt: float = 0.05) -> dict[str, float]:
        self.t += dt
        self._k += 1
        moving = self.t > self.rest_s
        v = max(self._at(self.lap.v), 1.0) if moving else 0.0
        self.s += v * dt
        ax = self._at(self.lap.ax) if moving else 0.0
        kappa = float(np.interp(self.s % self.track.length, self.track.s, self.track.kappa, period=self.track.length))
        ay = v * v * kappa
        x, y, heading = self.track.position_at(self.s)
        out: dict[str, float] = {}

        # ---- air: wind (blowing FROM wind_from), relative flow, yaw
        wind_speed = self.wind_speed + (12.0 if self.active("crosswind_gust") and self.t < self.faults["crosswind_gust"] + 20 else 0.0)
        wind_from = self.wind_from if not self.active("crosswind_gust") else heading + 90.0
        h = math.radians(heading)
        wf = math.radians(wind_from)
        car_e, car_n = v * math.sin(h), v * math.cos(h)
        wind_e, wind_n = -wind_speed * math.sin(wf), -wind_speed * math.cos(wf)
        rel_e, rel_n = car_e - wind_e, car_n - wind_n
        v_air = math.hypot(rel_e, rel_n)
        fwd = rel_e * math.sin(h) + rel_n * math.cos(h)
        side = -rel_e * math.cos(h) + rel_n * math.sin(h)
        yaw = math.degrees(math.atan2(side, fwd))
        q = 0.5 * self.rho * v_air * v_air
        out["pitot_dp"] = (0.0 if self.active("pitot_blocked") else q) + self._noise(1.0)
        out["probe_yaw"] = yaw + self._noise(0.3)
        out["probe_pitch"] = self._noise(0.3)
        if self._k % 20 == 1:
            out.update(amb_temp=18.0, amb_press=101325.0, amb_rh=60.0)

        # ---- downforce (element CL·A with faults) and drag
        speed_frac = min(1.0, v / 32.0)
        cla_f = self.cla * self.balance
        cla_r = self.cla * (1.0 - self.balance)
        if self.active("fw_damage_left"):
            cla_f *= 0.75
        if self.active("rw_stall"):
            cla_r *= 0.60
        ut_factor = 1.0
        if self.active("ut_bottoming") and v > 18.0:
            ut_factor = 0.45
            cla_f *= 0.88
            cla_r *= 0.88
        lift_f, lift_r = q * cla_f, q * cla_r
        lift = lift_f + lift_r
        drag = q * self.cda * (0.9 if self.active("rw_stall") else 1.0)

        # ---- taps: Cp x q, gentle natural variation with speed and pitch (accel)
        nat = 1.0 + 0.04 * (speed_frac - 0.5) - 0.01 * ax / G
        fw_s_l = FW_SUCTION * nat * (0.45 if self.active("fw_damage_left") else 1.0)
        fw_s_r = FW_SUCTION * nat
        if self.active("fw_cluster_left"):  # station-L cluster: taps 2-3 lose suction together
            fw_s_l = fw_s_l * np.array([1.0, 0.55, 0.55, 1.0])
        rw_s = RW_SUCTION * nat
        if self.active("rw_stall"):
            rw_s = rw_s * np.array([1.0, 0.9, 0.35, 0.3])
        ut = UT * nat * ut_factor
        cp = np.concatenate([fw_s_l, FW_PRESSURE, fw_s_r, FW_PRESSURE, rw_s, RW_PRESSURE, rw_s, RW_PRESSURE, ut])
        taps = cp * q + self.rng.normal(0.0, 1.5, cp.size)
        if self.active("tap_leak"):
            taps[12 + 2] = 0.1 * cp[12 + 2] * q + self._noise(1.5)  # rw_p03
        for i, ch in enumerate(self.catalog.taps()):
            out[ch.id] = float(taps[i])

        # ---- suspension: static + longitudinal + lateral transfer + aero split
        m, wdf = self.m, self.wdf
        transfer = m * ax * self.h / self.wb
        front = wdf * m * G - transfer + lift_f
        rear = (1.0 - wdf) * m * G + transfer + lift_r
        lat_f = m * ay * self.h / 1.22 * 0.5
        lat_r = m * ay * self.h / 1.18 * 0.5
        wheel = {"fl": front / 2 - lat_f, "fr": front / 2 + lat_f, "rl": rear / 2 - lat_r, "rr": rear / 2 + lat_r}
        rh_front = 30.0 - lift_f / 120.0 - (12.0 if self.active("ut_bottoming") else 0.0)
        rh_rear = 35.0 - lift_r / 130.0 - (12.0 if self.active("ut_bottoming") else 0.0)
        for corner, load in wheel.items():
            ratio = self.ratio_f if corner[0] == "f" else self.ratio_r
            out[f"pushrod_{corner}"] = physics.pushrod_from_wheel_load(load, ratio, self.mu_kg) + self._noise(8.0)
            out[f"damper_{corner}"] = (load - (wdf if corner[0] == "f" else 1 - wdf) * m * G / 2) / 60.0 * 0.9
        out.update(rh_front=rh_front + self._noise(0.15), rh_rear=rh_rear + self._noise(0.15),
                   fw_load=lift_f * 0.6 + self._noise(3), rw_load=lift_r * 0.9 + self._noise(3))
        out.update(ax=ax + self._noise(0.15), ay=ay + self._noise(0.15), az=G + self._noise(0.2),
                   gx=self._noise(0.1), gy=self._noise(0.1), gz=math.degrees(v * kappa) + self._noise(0.1))

        # ---- driveline: torque consistent with the force balance while driving
        lap_torque = self._at(self.lap.motor_torque_nm) if moving else 0.0
        rolling = self.crr * (m * G + lift) if moving else 0.0
        needed = m * ax + drag + rolling  # tractive force the force balance requires
        if lap_torque >= 0.0 and needed >= 0.0:
            torque = needed * self.r / (self.gear * self.eta)
            brake_f = 0.0
        elif lap_torque >= 0.0:  # decelerating harder than drag explains: light braking
            torque, brake_f = 0.0, -needed
        else:
            torque = lap_torque
            brake_f = self._at(self.lap.brake_force_n)
        rpm = v / self.r * self.gear * 60.0 / (2 * math.pi)
        out.update(mot_torque=torque + self._noise(0.5), mot_speed=rpm + self._noise(2.0))
        out.update(brake_press_f=brake_f * self.bias / self.gain_f + abs(self._noise(0.05)),
                   brake_press_r=brake_f * (1 - self.bias) / self.gain_r + abs(self._noise(0.05)))
        p_kw = self._at(self.lap.power_kw) * self.power_scale if moving else 0.0
        pedal = max(0.0, min(100.0, p_kw / 80.0 * 100.0))
        out.update(apps1=pedal + self._noise(0.2), apps2=(0.0 if self.active("apps_implausible") else pedal) + self._noise(0.2),
                   steer=math.degrees(math.atan(self.wb * kappa)) * 4.0)
        for w in ("fl", "fr", "rl", "rr"):
            out[f"ws_{w}"] = v + self._noise(0.03)
        if self._k % 2 == 0:
            lat, lon = geo.xy_to_latlon(x, y, self.vehicle["gps_origin"])
            out.update(gps_lat=float(lat), gps_lon=float(lon), gps_speed=v + self._noise(0.05), gps_heading=heading)

        # ---- accumulator: 140 equivalent-circuit cells (current from the previous voltage)
        current = p_kw * 1000.0 / float(np.sum(self.v_cell))
        cap = self.cap.copy()
        r0 = self.r0.copy()
        if self.active("cell_weak"):
            cap[88] *= 0.8
        if self.active("cell_hot"):
            r0[47] *= 4.0
        tau = self.cell.tau_s
        a = math.exp(-dt / tau)
        self.v_rc = self.v_rc * a + current * self.cell.group_r1 * (1 - a)
        self.soc -= current * dt / (3600.0 * cap)
        self.v_cell = np.asarray(physics.ocv(self.soc, self.table)) - current * r0 - self.v_rc
        v_pack = float(np.sum(self.v_cell))
        heat = current * current * r0 + self.v_rc ** 2 / self.cell.group_r1
        ua = 0.35 + 0.03 * v
        self.temp += dt / 280.0 * (heat - ua * (self.temp - 18.0))
        self.true_soc_mean = float(np.mean(self.soc))
        offset = 3.0 if self.active("current_offset") else 0.0
        out.update(pack_voltage=v_pack + self._noise(0.2), pack_current=current + offset + self._noise(0.3),
                   inv_dc_voltage=v_pack + self._noise(0.2), inv_dc_current=current + self._noise(0.3),
                   inv_phase_current=abs(torque) / 0.75)
        if self._k % 2 == 0:
            for k in range(140):
                out[f"cell_v_{k:03d}"] = float(self.v_cell[k] + self._noise(0.002))
        if self._k % 10 == 0:
            for j in range(60):
                cells = physics.temp_sensor_cells(j)
                out[f"cell_t_{j:02d}"] = float(np.mean(self.temp[cells.start:cells.stop]) + self._noise(0.1))
            out.update(bms_soc=round(self.true_soc_mean * 200) / 2.0, bms_state=2.0, bms_fault=0.0,
                       inv_state=3.0, inv_fault=0.0)

        # ---- cooling and temperatures
        self.flow = 0.0 if self.active("pump_fail") else 8.0
        if self.active("pump_fail"):
            self.mot_temp += dt * 0.5
            self.cool_out += dt * 0.1
        out.update(cool_flow=self.flow + self._noise(0.05), pump_duty=80.0, fan_duty=0.0,
                   cool_temp_in=self.cool_in + self._noise(0.1), cool_temp_out=self.cool_out + self._noise(0.1),
                   mot_winding_temp=self.mot_temp + self._noise(0.3), inv_igbt_temp=self.igbt_temp + self._noise(0.2))

        # ---- safety chain
        imd_bad = self.active("imd_fault")
        sdc = not (imd_bad or self.active("sdc_open"))
        out.update(imd_iso_kohm=(150.0 if imd_bad else 2000.0) + self._noise(5.0), imd_ok=0.0 if imd_bad else 1.0,
                   ams_ok=1.0, bspd_ok=1.0, apps_plaus_ok=0.0 if self.active("apps_implausible") else 1.0,
                   sdc_closed=1.0 if sdc else 0.0, air_pos_closed=1.0 if sdc else 0.0,
                   air_neg_closed=1.0 if sdc else 0.0, precharge_done=1.0, tsal_state=1.0 if sdc else 0.0)
        return out


def drive(car: SyntheticCar, processor: Processor, store: ChannelStore, seconds: float, dt: float = 0.05,
          drop: set[str] | None = None) -> list[dict]:
    """Run the car for ``seconds``, feeding the store and ticking the processor every step.

    ``drop`` = channels to withhold (simulates dead sensors). Returns all events.
    """
    events: list[dict] = []
    n = int(round(seconds / dt))
    for _ in range(n):
        values = car.step(dt)
        if drop:
            values = {k: val for k, val in values.items() if k not in drop}
        store.update(car.t, values)
        events.extend(processor.tick(car.t))
    return events


def raised(events: list[dict]) -> dict[str, dict]:
    """First 'raised' alert event per rule id."""
    out: dict[str, dict] = {}
    for e in events:
        if e["type"] == "alert" and e["alert"]["active"] and e["alert"]["id"] not in out:
            out[e["alert"]["id"]] = e["alert"]
    return out


# --------------------------------------------------------------------------------------
# Tests of the generator itself (it must be a faithful stand-in for the car)
# --------------------------------------------------------------------------------------


def test_synthetic_car_lap_matches_lapsim():
    car = SyntheticCar()
    for _ in range(int(car.lap.lap_time / 0.05)):
        car.step(0.05)
    assert car.s == pytest.approx(car.track.length, rel=0.02)


def test_synthetic_car_produces_every_raw_channel():
    car = SyntheticCar()
    seen: set[str] = set()
    for _ in range(40):
        seen.update(car.step(0.05))
    assert set(config().catalog.raw_ids()) <= seen
    assert not any(cid.startswith(("truth_", "calc_")) for cid in seen)
