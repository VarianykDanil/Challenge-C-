#!/usr/bin/env python3
"""Mock AeroVolt feed: a development server for building the web dashboard.

Serves ``web/`` and speaks the exact WebSocket + REST protocol of SPEC section 9, with
fake but plausible, smoothly varying values for EVERY catalogue channel (raw, ``calc_*``
and ``truth_*``). It does not need the real simulator or analysis - only ``aerovolt.core``,
aiohttp and numpy - so the UI can be developed in parallel with the backend.

What it does
------------
* A car laps a simple closed ~1 km loop (its own track, placed at the ``gps_origin`` of the
  vehicle file) following a grip-limited speed profile: about one lap per minute, a ``lap``
  event with a plausible :class:`LapSummary` at every lap, then a ``strategy`` event with
  an energy-vs-power-limit curve.
* Every ~20 s a background alert is raised and later cleared.
* Faults (``POST /api/faults/{id}`` ``{"active": true}``) change the data and raise the
  alerts SPEC section 5.5 expects: ``fw_damage_left`` lowers the left front-wing suction,
  ``cell_hot`` heats cell 47 and sensor ``cell_t_20``, ``pump_fail`` stops the coolant flow
  and the temperatures climb, ``imd_fault`` opens the shutdown circuit, and so on.
* ``--hybrid`` marks ``fw_p03`` as owned by a (pretend) USB-serial bench node, reports mode
  ``HYBRID`` and replaces that tap with a "someone is blowing on the sensor" pattern.

Usage::

    python tools/mock_feed_server.py [--port 8090] [--host 127.0.0.1] [--hybrid] [--speed 1]
    # open http://127.0.0.1:8090

Endpoints: ``GET /`` (web/index.html) and static files (no-cache), ``GET /ws``,
``GET /api/hello``, ``GET /api/history?ids=a,b&seconds=60``, ``GET /api/faults``,
``POST /api/faults/{id}``, ``GET /api/laps``, ``GET /api/alerts``,
``POST /api/session/reset``, ``GET /api/sources``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import mimetypes
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aerovolt import __version__  # noqa: E402
from aerovolt.core import physics  # noqa: E402
from aerovolt.core.catalog import Catalog  # noqa: E402
from aerovolt.core.model import Alert, FaultInfo, LapSummary, json_value  # noqa: E402
from aerovolt.core.store import ChannelStore  # noqa: E402

G = physics.G
TICK_HZ = 20.0  # simulation + broadcast rate (wall clock)
EARTH_RADIUS_M = 6_371_008.8

#: SPEC section 3 values, used only if config/vehicle.yaml does not exist yet.
FALLBACK_VEHICLE: dict[str, Any] = {
    "name": "MMU EV demo car (virtual)", "mass_kg": 300, "weight_dist_front": 0.47, "cg_height_m": 0.28,
    "wheelbase_m": 1.53, "track_front_m": 1.22, "track_rear_m": 1.18, "wheel_radius_m": 0.228,
    "unsprung_mass_corner_kg": 9,
    "aero": {
        "cla_ref": 3.6, "cda_ref": 1.35, "share": {"front_wing": 0.32, "rear_wing": 0.40, "undertray": 0.28},
        "front_wing": {"chord_m": 0.36, "span_m": 1.40, "le_x_m": 0.80, "z_m": 0.07, "station_y_m": [0.55, -0.55]},
        "rear_wing": {"chord_m": 0.48, "span_m": 1.10, "le_x_m": -1.70, "z_m": 1.05, "station_y_m": [0.25, -0.25]},
        "undertray": {"x_start_m": 0.15, "x_end_m": -1.95, "width_m": 0.90, "z_m": 0.03},
        "pitot": {"x_m": 0.95, "z_m": 0.45},
    },
    "tyres": {"mu_lat": 1.55, "mu_long": 1.45, "c_rr": 0.015},
    "suspension": {"wheel_rate_n_per_mm": {"front": 60, "rear": 65}, "pushrod_ratio": {"front": 1.15, "rear": 1.10},
                   "damper_motion_ratio": {"front": 0.90, "rear": 0.85},
                   "static_ride_height_mm": {"front": 30, "rear": 35}},
    "powertrain": {"gear_ratio": 3.8, "driveline_efficiency": 0.95, "power_limit_kw": 80, "regen_max_kw": 30,
                   "motor": {"peak_torque_nm": 220, "max_speed_rpm": 6500, "derate_start_c": 110,
                             "max_winding_c": 140},
                   "inverter": {"efficiency": 0.97, "derate_start_c": 75, "max_c": 90}},
    "accumulator": {"series": 140, "parallel": 4, "segments": 5, "temp_sensors": 60,
                    "cell": {"capacity_ah": 4.0, "v_max": 4.2, "v_min": 2.8, "r0_ohm": 0.012, "r1_ohm": 0.006,
                             "c1_f": 2500, "mass_kg": 0.07, "cp_j_per_kgk": 1000, "max_temp_c": 60}},
    "cooling": {"coolant_cp": 3600, "coolant_density": 1040, "pump_flow_lpm": 8},
    "endurance": {"distance_km": 22, "reserve_pct": 5},
    "gps_origin": {"lat": 52.0786, "lon": -1.0169},
}

WEATHER = {"temp_c": 18.0, "pressure_pa": 101325.0, "rh_pct": 60.0, "wind_ms": 3.0, "wind_dir_deg": 225.0}

#: SPEC section 5.5: id, system, title, description, alerts the real analysis would raise.
FAULTS: list[tuple[str, str, str, str, list[str]]] = [
    ("fw_damage_left", "aero", "Front wing damage (left)",
     "Left front-wing flap damaged: L station suction -55 %, front CL·A -25 %.",
     ["aero_fw_asymmetry", "aero_balance_shift"]),
    ("rw_stall", "aero", "Rear wing stall",
     "Rear wing flap stall: aft suction taps collapse, rear CL·A -40 %, CD·A -10 %.",
     ["aero_rw_suction_loss", "aero_balance_shift"]),
    ("ut_bottoming", "aero", "Undertray bottoming",
     "Static ride height -12 mm (broken spring/packer): the floor stalls at speed.", ["aero_ut_stall"]),
    ("pitot_blocked", "aero", "Pitot blocked", "Pitot tube blocked: reads about 0 Pa.",
     ["sensor_pitot_implausible"]),
    ("tap_leak", "aero", "Tap tube leak (rw_p03)", "Tube leak on rw_p03: reads 10 % of the true pressure.",
     ["sensor_tap_anomaly"]),
    ("crosswind_gust", "aero", "Crosswind gust", "12 m/s gust from the side.", ["aero_high_yaw"]),
    ("cell_hot", "powertrain", "Hot cell (bad weld)", "Cell 47 internal resistance x4.",
     ["bms_cell_temp_outlier", "bms_cell_overtemp"]),
    ("cell_weak", "powertrain", "Weak cell", "Cell 88 capacity 80 %.", ["bms_cell_voltage_outlier"]),
    ("pump_fail", "powertrain", "Coolant pump failure", "Coolant flow drops to 0.",
     ["cooling_no_flow", "motor_temp_high"]),
    ("imd_fault", "powertrain", "Insulation fault", "Insulation 2000 -> 150 kOhm, the IMD trips.",
     ["safety_imd_trip", "safety_sdc_open"]),
    ("current_offset", "powertrain", "Current sensor offset", "Pack current sensor reads +3 A.",
     ["bms_soc_divergence"]),
    ("apps_implausible", "powertrain", "APPS implausibility", "apps2 sticks at 0 %.",
     ["safety_apps_implausible"]),
]

#: Every alert id of SPEC section 6.5: severity, title, channels.
ALERTS: dict[str, tuple[str, str, list[str]]] = {
    "aero_fw_asymmetry": ("warn", "Front wing L/R asymmetry", ["calc_fw_asym", "calc_cl_fw_l", "calc_cl_fw_r"]),
    "aero_balance_shift": ("warn", "Aero balance shift", ["calc_aero_balance"]),
    "aero_rw_suction_loss": ("warn", "Rear wing suction loss", ["calc_cl_rw_l", "calc_cl_rw_r"]),
    "aero_ut_stall": ("critical", "Undertray stall", ["calc_cp_ut_mean", "rh_front", "rh_rear"]),
    "aero_high_yaw": ("info", "High flow yaw", ["calc_yaw", "probe_yaw"]),
    "sensor_pitot_implausible": ("warn", "Pitot implausible vs GPS speed", ["pitot_dp", "gps_speed"]),
    "sensor_tap_anomaly": ("warn", "Pressure tap anomaly (sensor fault)", ["rw_p03"]),
    "sensor_stale": ("warn", "Sensor stale", ["amb_rh"]),
    "bms_cell_temp_outlier": ("warn", "Cell temperature outlier", ["cell_t_20"]),
    "bms_cell_overtemp": ("critical", "Cell over-temperature", ["cell_t_20"]),
    "bms_cell_voltage_outlier": ("warn", "Cell voltage outlier", ["cell_v_088"]),
    "bms_cell_undervoltage": ("critical", "Cell under-voltage", ["calc_cell_v_min"]),
    "bms_soc_divergence": ("warn", "SoC estimators diverge", ["calc_soc_cc", "calc_soc_ekf"]),
    "cooling_no_flow": ("critical", "No coolant flow", ["cool_flow"]),
    "motor_temp_high": ("warn", "Motor winding temperature high", ["mot_winding_temp"]),
    "inverter_temp_high": ("warn", "Inverter temperature high", ["inv_igbt_temp"]),
    "safety_imd_trip": ("critical", "IMD tripped (insulation fault)", ["imd_ok", "imd_iso_kohm"]),
    "safety_sdc_open": ("critical", "Shutdown circuit open", ["sdc_closed"]),
    "safety_apps_implausible": ("critical", "APPS implausibility", ["apps1", "apps2", "apps_plaus_ok"]),
    "energy_short": ("warn", "Energy short: will not finish at this power limit", ["calc_power_limit_rec"]),
}

#: Alerts raised and cleared on a timer to keep the alert UI busy.
BACKGROUND_ALERTS = ["sensor_stale", "inverter_temp_high", "energy_short", "aero_high_yaw",
                     "bms_cell_voltage_outlier"]
BACKGROUND_PERIOD_S = 20.0
BACKGROUND_DURATION_S = 12.0

#: Pressure coefficient shapes at the tap positions (smooth, physically shaped).
FW_SUCTION_CP = np.array([-3.3, -2.5, -1.55, -0.65])  # x/c 0.05 0.20 0.45 0.75
FW_PRESSURE_CP = np.array([0.80, 0.38])  # x/c 0.10 0.50
RW_SUCTION_CP = np.array([-2.8, -2.1, -1.30, -0.55])
RW_PRESSURE_CP = np.array([0.70, 0.32])
UT_CP = np.array([-0.9, -1.7, -2.3, -1.7, -1.0, -0.35, -1.05, -1.05])  # 0.05 .. 0.97, tunnels 0.80


# --------------------------------------------------------------------------------------
# Track
# --------------------------------------------------------------------------------------


#: Polar shape r(theta) = 1 + sum a_k cos(k theta + phase_k): r > 0 everywhere, so the loop is
#: star-shaped and cannot self-intersect. Chosen for a ~55 s lap, tightest radius ~6 m.
TRACK_HARMONICS = [(2, 0.237, 4.10), (3, 0.086, 4.89), (4, 0.077, 5.62), (5, 0.032, 0.75), (6, 0.142, 2.82),
                   (7, 0.038, 3.23), (8, 0.057, 3.45), (9, 0.114, 5.38), (10, 0.020, 3.72), (11, 0.130, 2.89)]


@dataclass
class MockTrack:
    """A smooth star-shaped closed loop (cannot self-intersect), resampled every 1 m."""

    x: np.ndarray
    y: np.ndarray
    s: np.ndarray
    heading: np.ndarray  # compass degrees, 0 = north, clockwise
    kappa: np.ndarray  # signed curvature, 1/m (+ = left)
    length: float
    origin: dict[str, float]

    @classmethod
    def build(cls, origin: dict[str, float], length_m: float = 1000.0) -> MockTrack:
        theta = np.linspace(0.0, 2.0 * np.pi, 4001)[:-1]
        r = 1.0 + sum(a * np.cos(k * theta + phase) for k, a, phase in TRACK_HARMONICS)
        px, py = r * np.cos(theta), r * np.sin(theta)
        seg = np.hypot(np.diff(px, append=px[0]), np.diff(py, append=py[0]))
        scale = length_m / seg.sum()
        px, py = px * scale, py * scale
        s_raw = np.concatenate(([0.0], np.cumsum(seg * scale)))[:-1]
        s = np.arange(0.0, length_m, 1.0)
        x = np.interp(s, s_raw, px, period=length_m)
        y = np.interp(s, s_raw, py, period=length_m)
        dx = np.gradient(np.concatenate((x[-2:], x, x[:2])))[2:-2]
        dy = np.gradient(np.concatenate((y[-2:], y, y[:2])))[2:-2]
        theta_m = np.unwrap(np.arctan2(dy, dx))  # math angle, counter-clockwise from east
        dtheta = np.gradient(np.concatenate((theta_m[-2:] - 2 * np.pi, theta_m, theta_m[:2] + 2 * np.pi)))[2:-2]
        kappa = np.convolve(np.concatenate((dtheta[-5:], dtheta, dtheta[:5])), np.ones(11) / 11, "same")[5:-5]
        heading = (90.0 - np.degrees(theta_m)) % 360.0
        return cls(x, y, s, heading, kappa, float(length_m), dict(origin))

    def at(self, s: float) -> tuple[float, float, float, float]:
        """(x, y, heading_deg, kappa) at distance ``s`` (wraps around)."""
        s = s % self.length
        i = int(s) % len(self.s)
        j = (i + 1) % len(self.s)
        f = s - int(s)
        x = self.x[i] + f * (self.x[j] - self.x[i])
        y = self.y[i] + f * (self.y[j] - self.y[i])
        dh = ((self.heading[j] - self.heading[i] + 180.0) % 360.0) - 180.0
        return x, y, (self.heading[i] + f * dh) % 360.0, self.kappa[i] + f * (self.kappa[j] - self.kappa[i])

    def latlon(self, x: float | np.ndarray, y: float | np.ndarray) -> tuple[Any, Any]:
        """Local tangent plane (equirectangular) -> WGS-84 degrees around the origin."""
        lat0 = self.origin["lat"]
        lat = lat0 + np.degrees(np.asarray(y) / EARTH_RADIUS_M)
        lon = self.origin["lon"] + np.degrees(np.asarray(x) / (EARTH_RADIUS_M * math.cos(math.radians(lat0))))
        return lat, lon

    def features(self) -> list[dict[str, Any]]:
        """Corners (|kappa| > 1/40 m) and straights as labelled sections."""
        corner = np.abs(self.kappa) > 1.0 / 40.0
        out, start, n = [], 0, len(corner)
        turn = 0
        for i in range(1, n + 1):
            if i == n or corner[i] != corner[start]:
                kind = "corner" if corner[start] else "straight"
                if kind == "corner":
                    turn += 1
                label = f"T{turn}" if kind == "corner" else "Straight"
                if self.s[min(i, n - 1)] - self.s[start] >= 15 or kind == "corner":
                    out.append({"kind": kind, "label": label, "s_start": round(float(self.s[start]), 1),
                                "s_end": round(float(self.s[i - 1]), 1)})
                start = i
        return out

    def to_json(self) -> dict[str, Any]:
        lat, lon = self.latlon(self.x, self.y)
        return {
            "name": "mock_loop",
            "length_m": round(self.length, 2),
            "closed": True,
            "xy": [[round(float(a), 2), round(float(b), 2)] for a, b in zip(self.x, self.y)],
            "latlon": [[round(float(a), 7), round(float(b), 7)] for a, b in zip(lat, lon)],
            "start": {"x": round(float(self.x[0]), 2), "y": round(float(self.y[0]), 2),
                      "heading_deg": round(float(self.heading[0]), 2)},
            "origin": {"lat": self.origin["lat"], "lon": self.origin["lon"]},
            "features": self.features(),
        }


def speed_profile(track: MockTrack, v_max: float = 30.0, ay_max: float = 1.7 * G,
                  ax_max: float = 0.9 * G, brake_max: float = 1.5 * G, power_w: float = 72e3,
                  mass: float = 300.0) -> np.ndarray:
    """Grip-limited speed along the loop (forward/backward passes, two laps to settle)."""
    v_corner = np.minimum(v_max, np.sqrt(ay_max / np.maximum(np.abs(track.kappa), 1e-6)))
    n = len(v_corner)
    v = v_corner.copy()
    for _ in range(2):
        for k in range(1, 2 * n):
            i, prev = k % n, (k - 1) % n
            a = min(ax_max, power_w / (mass * max(v[prev], 1.0)))
            v[i] = min(v[i], math.sqrt(v[prev] ** 2 + 2 * a))
        for k in range(2 * n - 2, -1, -1):
            i, nxt = k % n, (k + 1) % n
            v[i] = min(v[i], math.sqrt(v[nxt] ** 2 + 2 * brake_max))
    return v


# --------------------------------------------------------------------------------------
# The fake car
# --------------------------------------------------------------------------------------


@dataclass
class LapAccumulator:
    t_start: float = 0.0
    n: int = 0
    v_sum: float = 0.0
    v_max: float = 0.0
    energy_kwh: float = 0.0
    regen_kwh: float = 0.0
    cla: list[float] = field(default_factory=list)
    cda: list[float] = field(default_factory=list)
    balance: list[float] = field(default_factory=list)
    cell_t_max: float = -math.inf
    cell_v_min: float = math.inf
    mot_temp_max: float = -math.inf


class MockCar:
    """Produces one dict of values for every catalogue channel per tick."""

    def __init__(self, catalog: Catalog, vehicle: dict[str, Any], hybrid: bool, seed: int = 42) -> None:
        self.catalog = catalog
        self.vehicle = vehicle
        self.hybrid = hybrid
        self.seed = seed
        origin = vehicle.get("gps_origin") or FALLBACK_VEHICLE["gps_origin"]
        self.track = MockTrack.build(origin)
        self.v_profile = speed_profile(self.track, mass=float(vehicle.get("mass_kg", 300)))
        self.lap_time_est = float(np.sum(1.0 / self.v_profile))
        self.faults = {fid: FaultInfo(fid, title, system, desc) for fid, system, title, desc, _ in FAULTS}
        self.fault_alerts = {fid: alerts for fid, *_, alerts in FAULTS}
        self.ocv_table = physics.ocv_table_from_vehicle(vehicle)
        self.cell = physics.CellParams.from_vehicle(vehicle) if "accumulator" in vehicle else physics.CellParams()
        self.reset()

    # ---- state ------------------------------------------------------------------------

    def reset(self) -> None:
        self.rng = np.random.default_rng(self.seed)
        n = 140
        self.t = 0.0
        self.s = 0.0
        self.v = float(self.v_profile[0])
        self.lap = 0
        self.pack_v_loaded = 3.9 * 140
        self.lap_acc = LapAccumulator()
        self.cell_cap = self.cell.group_capacity_ah * (1 + self.rng.uniform(-0.015, 0.015, n))
        self.cell_r0 = self.cell.group_r0 * (1 + self.rng.uniform(-0.05, 0.05, n))
        self.cell_soc = np.full(n, 0.98)
        self.cell_vrc = np.zeros(n)
        self.cell_temp = 25.0 + self.rng.normal(0, 0.3, n)
        self.bms_soc = 98.0
        self.soc_cc = 98.0
        self.soc_ekf = 97.0
        self.energy_used = 0.0
        self.energy_regen = 0.0
        self.t_winding = 30.0
        self.t_igbt = 28.0
        self.t_coolant = 25.0
        self.cla_filt = math.nan
        self.cda_filt = math.nan
        self.strategy: dict[str, Any] | None = None
        self.laps: list[dict[str, Any]] = []
        self.fault_since: dict[str, float] = {}
        for f in self.faults.values():
            f.active = False

    def set_fault(self, fid: str, active: bool) -> None:
        if fid not in self.faults:
            raise KeyError(fid)
        self.faults[fid].active = bool(active)
        if active:
            self.fault_since[fid] = self.t
        else:
            self.fault_since.pop(fid, None)

    def active(self, fid: str) -> bool:
        return self.faults[fid].active

    def noise(self, sigma: float, size: int | None = None) -> Any:
        return self.rng.normal(0.0, sigma, size)

    # ---- one step ---------------------------------------------------------------------

    def step(self, dt: float) -> tuple[dict[str, float], list[dict[str, Any]]]:
        """Advance ``dt`` seconds; return (values for every channel, events)."""
        veh = self.vehicle
        events: list[dict[str, Any]] = []
        self.t += dt
        t = self.t
        m = float(veh.get("mass_kg", 300))
        aero = veh["aero"]
        susp = veh["suspension"]
        pt = veh["powertrain"]
        wb = float(veh.get("wheelbase_m", 1.53))
        h_cg = float(veh.get("cg_height_m", 0.28))
        wf = float(veh.get("weight_dist_front", 0.47))
        r_wheel = float(veh.get("wheel_radius_m", 0.228))
        unsprung = float(veh.get("unsprung_mass_corner_kg", 9))

        # --- motion along the track: speed profile x (1 +- 2 %) slowly varying between laps
        prev_lap = self.lap
        self.s += self.v * dt
        if self.s >= self.track.length:
            self.s -= self.track.length
            self.lap += 1
        variation = 1.0 + 0.02 * math.sin(0.05 * t + 0.7 * self.lap)
        n_prof = len(self.v_profile)
        idx = int(self.s) % n_prof
        frac = self.s - int(self.s)
        v = variation * float(self.v_profile[idx] + frac * (self.v_profile[(idx + 1) % n_prof] - self.v_profile[idx]))
        v_ahead = variation * float(self.v_profile[(idx + 2) % n_prof])
        v_behind = variation * float(self.v_profile[(idx - 1) % n_prof])
        ax = (v_ahead ** 2 - v_behind ** 2) / (2 * 3.0)  # a = d(v^2/2)/ds
        self.v = v
        x, y, heading, kappa = self.track.at(self.s)
        ay = v * v * kappa
        yaw_rate = math.degrees(v * kappa)

        # --- air: wind blows FROM wind_dir; air velocity relative to the car
        wind_ms, wind_from = WEATHER["wind_ms"], WEATHER["wind_dir_deg"]
        gust = 12.0 if self.active("crosswind_gust") else 0.0
        h_rad = math.radians(heading)
        wind_e = -wind_ms * math.sin(math.radians(wind_from)) - gust * math.cos(h_rad)
        wind_n = -wind_ms * math.cos(math.radians(wind_from)) + gust * math.sin(h_rad)
        rel_e, rel_n = v * math.sin(h_rad) - wind_e, v * math.cos(h_rad) - wind_n
        airspeed = math.hypot(rel_e, rel_n)
        rel_heading = math.degrees(math.atan2(rel_e, rel_n))
        flow_yaw = ((heading - rel_heading + 180.0) % 360.0) - 180.0  # + = flow from the left
        amb_t = WEATHER["temp_c"] + 0.3 * math.sin(t / 300.0)
        amb_p = WEATHER["pressure_pa"] - 5.0 * math.sin(t / 900.0)
        amb_rh = WEATHER["rh_pct"] + 2.0 * math.sin(t / 400.0)
        rho = physics.moist_air_density(amb_t, amb_p, amb_rh)
        q = physics.dynamic_pressure(rho, airspeed)

        # --- aero forces (element CL·A shares, faults)
        share = aero.get("share", FALLBACK_VEHICLE["aero"]["share"])
        cla, cda = float(aero["cla_ref"]), float(aero["cda_ref"])
        fw_k, rw_k, ut_k, cd_k = 1.0, 1.0, 1.0, 1.0
        if self.active("fw_damage_left"):
            fw_k = 0.75
        if self.active("rw_stall"):
            rw_k, cd_k = 0.6, 0.9
        static_f = float(susp["static_ride_height_mm"]["front"])
        static_r = float(susp["static_ride_height_mm"]["rear"])
        if self.active("ut_bottoming"):
            static_f -= 12.0
            static_r -= 12.0
        yaw_loss = 1.0 - 0.0015 * flow_yaw ** 2
        df_fw = q * cla * share["front_wing"] * fw_k * yaw_loss
        df_rw = q * cla * share["rear_wing"] * rw_k * yaw_loss
        df_ut_nom = q * cla * share["undertray"] * yaw_loss
        k_rate_f = float(susp["wheel_rate_n_per_mm"]["front"]) * 2
        k_rate_r = float(susp["wheel_rate_n_per_mm"]["rear"]) * 2
        rh_f = static_f - (df_fw + 0.45 * df_ut_nom + m * ax * h_cg / wb * -1) / k_rate_f
        rh_r = static_r - (df_rw + 0.55 * df_ut_nom + m * ax * h_cg / wb) / k_rate_r
        if rh_f < 12.0 and self.active("ut_bottoming"):
            ut_k = 0.5
        df_ut = df_ut_nom * ut_k
        df_front = df_fw + 0.45 * df_ut
        df_rear = df_rw + 0.55 * df_ut
        downforce = df_front + df_rear
        drag = q * cda * cd_k

        # --- wheel loads, pushrods, dampers
        w_static = m * G
        long_tr = m * ax * h_cg / wb  # + = load moves to the rear under acceleration
        lat_f = m * ay * h_cg / float(veh.get("track_front_m", 1.22)) * wf
        lat_r = m * ay * h_cg / float(veh.get("track_rear_m", 1.18)) * (1 - wf)
        loads = {
            "fl": w_static * wf / 2 + df_front / 2 - long_tr / 2 - lat_f / 2,
            "fr": w_static * wf / 2 + df_front / 2 - long_tr / 2 + lat_f / 2,
            "rl": w_static * (1 - wf) / 2 + df_rear / 2 + long_tr / 2 - lat_r / 2,
            "rr": w_static * (1 - wf) / 2 + df_rear / 2 + long_tr / 2 + lat_r / 2,
        }
        values: dict[str, float] = {}
        for corner, load in loads.items():
            axle = "front" if corner[0] == "f" else "rear"
            ratio = float(susp["pushrod_ratio"][axle])
            static = w_static * (wf if axle == "front" else 1 - wf) / 2
            travel = (load - static) / float(susp["wheel_rate_n_per_mm"][axle])
            values[f"pushrod_{corner}"] = physics.pushrod_from_wheel_load(load, ratio, unsprung) + self.noise(8)
            values[f"damper_{corner}"] = travel * float(susp["damper_motion_ratio"][axle]) + self.noise(0.05)

        # --- taps
        q_meas = q
        fw_s = np.tile(FW_SUCTION_CP, 2) * (1 + 0.004 * (static_f - rh_f))
        if self.active("fw_damage_left"):
            fw_s[:4] *= 0.45
        rw_s = np.tile(RW_SUCTION_CP, 2).copy()
        if self.active("rw_stall"):
            rw_s[[2, 3, 6, 7]] *= 0.2
        ut = UT_CP * (ut_k if ut_k < 1 else 1 + 0.01 * max(0.0, static_f - rh_f))
        fw_cp = np.concatenate((fw_s[:4], FW_PRESSURE_CP, fw_s[4:], FW_PRESSURE_CP))
        rw_cp = np.concatenate((rw_s[:4], RW_PRESSURE_CP, rw_s[4:], RW_PRESSURE_CP))
        yaw_side = np.array([1.0] * 6 + [-1.0] * 6) * 0.01 * flow_yaw
        fw_p = fw_cp * (1 + yaw_side) * q_meas + self.noise(1.5, 12)
        rw_p = rw_cp * (1 + yaw_side) * q_meas + self.noise(1.5, 12)
        ut_p = ut * q_meas + self.noise(1.5, 8)
        if self.active("tap_leak"):
            rw_p[2] *= 0.1
        for k in range(12):
            values[f"fw_p{k + 1:02d}"] = fw_p[k]
            values[f"rw_p{k + 1:02d}"] = rw_p[k]
        for k in range(8):
            values[f"ut_p{k + 1:02d}"] = ut_p[k]
        if self.hybrid:  # bench sensor: ambient noise plus a "blow" every 8 s
            phase = t % 8.0
            values["fw_p03"] = -15.0 - (350.0 * math.sin(math.pi * (phase - 5.0) / 2.0) if 5.0 < phase < 7.0 else 0.0)
            values["fw_p03"] += self.noise(0.8)

        values.update({
            "pitot_dp": (0.0 if self.active("pitot_blocked") else q) + self.noise(1.0),
            "amb_temp": amb_t + self.noise(0.05),
            "amb_press": amb_p + self.noise(2.0),
            "amb_rh": amb_rh + self.noise(0.5),
            "probe_yaw": flow_yaw + self.noise(0.3),
            "probe_pitch": -1.0 - 0.02 * ax + self.noise(0.3),
            "rh_front": rh_f + self.noise(0.15),
            "rh_rear": rh_r + self.noise(0.15),
            "fw_load": df_fw + self.noise(3.0),
            "rw_load": df_rw + self.noise(3.0),
            "ax": ax + self.noise(0.15),
            "ay": ay + self.noise(0.15),
            "az": G + 0.3 * math.sin(7.0 * t) + self.noise(0.2),
            "gx": 0.8 * math.sin(1.3 * t) + self.noise(0.1),
            "gy": 0.5 * math.sin(0.9 * t) + self.noise(0.1),
            "gz": yaw_rate + self.noise(0.1),
            "gps_speed": v + self.noise(0.05),
            "gps_heading": heading,
            "steer": math.degrees(math.atan(wb * kappa)) * 5.0 + self.noise(0.1),
        })
        lat, lon = self.track.latlon(x, y)
        values["gps_lat"] = float(lat) + self.noise(3e-6)
        values["gps_lon"] = float(lon) + self.noise(3e-6)
        for corner, side in (("fl", 1), ("fr", -1), ("rl", 1), ("rr", -1)):
            values[f"ws_{corner}"] = max(0.0, v * (1 - side * kappa * 0.6)) + self.noise(0.03)

        # --- driver and powertrain
        f_resist = drag + float(veh.get("tyres", {}).get("c_rr", 0.015)) * (w_static + downforce)
        f_wheel = m * ax + f_resist
        p_wheel = f_wheel * v
        eta_d = float(pt.get("driveline_efficiency", 0.95))
        eta_inv = float(pt.get("inverter", {}).get("efficiency", 0.97))
        p_limit = float(pt.get("power_limit_kw", 80)) * 1e3
        if p_wheel >= 0:
            apps = min(100.0, 100.0 * p_wheel / (p_limit * 0.9 * eta_d))
            p_mech = min(p_wheel / eta_d, p_limit * 0.94 * eta_inv * 0.99)  # pack power <= limit
            p_pack = p_mech / (0.94 * eta_inv)
            brake_f = 0.0
        else:
            apps = 0.0
            regen = max(p_wheel * eta_d, -float(pt.get("regen_max_kw", 30)) * 1e3)
            p_mech = regen
            p_pack = regen * 0.94 * eta_inv
            # friction brakes supply what regen does not: F = |F_wheel| - P_regen / (eta * v)
            friction_n = max(0.0, -f_wheel + regen / (eta_d * max(v, 1.0)))
            brake_f = min(100.0, friction_n / 60.0)  # ~60 N of tyre force per bar
        sdc_ok = not self.active("imd_fault")
        if not sdc_ok:
            p_mech = p_pack = 0.0
        gear = float(pt.get("gear_ratio", 3.8))
        omega = v / r_wheel * gear
        mot_rpm = omega * 60 / (2 * math.pi)
        torque = p_mech / max(omega, 1.0)
        current = p_pack / self.pack_v_loaded  # I = P / V with last step's loaded pack voltage

        # --- cells (vectorised CellModel: R0 + RC, Coulomb counting, I^2R heating)
        r0 = self.cell_r0.copy()
        cap = self.cell_cap.copy()
        heat_r0 = r0.copy()
        if self.active("cell_hot"):  # bad weld: mostly heat; part of it is outside the sense leads
            heat_r0[47] *= 4.0
            r0[47] *= 1.6
        if self.active("cell_weak"):
            cap[88] *= 0.8
        decay = math.exp(-dt / self.cell.tau_s)
        self.cell_vrc = self.cell_vrc * decay + current * self.cell.group_r1 * (1 - decay)
        self.cell_soc -= current * dt / (3600.0 * cap)
        cell_v = physics.ocv(self.cell_soc, self.ocv_table) - current * r0 - self.cell_vrc
        heat = current ** 2 * heat_r0 + self.cell_vrc ** 2 / self.cell.group_r1
        ua = 0.35 + 0.03 * v
        self.cell_temp += dt * (heat - ua * (self.cell_temp - amb_t)) / 280.0
        pack_v = float(np.sum(cell_v))
        self.pack_v_loaded = max(pack_v, 100.0)
        current_meas = current + (3.0 if self.active("current_offset") else 0.0)
        self.bms_soc -= current_meas * dt / (3600.0 * self.cell.group_capacity_ah) * 100
        self.soc_cc -= current_meas * dt / (3600.0 * self.cell.group_capacity_ah) * 100
        truth_soc = float(np.mean(self.cell_soc)) * 100
        self.soc_ekf += 0.02 * (truth_soc - self.soc_ekf) - current * dt / (3600 * self.cell.group_capacity_ah) * 100
        e_step = pack_v * current * dt / 3.6e6
        if e_step >= 0:
            self.energy_used += e_step
        else:
            self.energy_regen -= e_step
        for k in range(140):
            values[f"cell_v_{k:03d}"] = cell_v[k] + self.noise(0.002)
        temps = np.array([np.mean(self.cell_temp[list(physics.temp_sensor_cells(j))]) for j in range(60)])
        for j in range(60):
            values[f"cell_t_{j:02d}"] = temps[j] + self.noise(0.2)

        # --- thermal: motor, inverter, coolant loop
        pump_ok = not self.active("pump_fail")
        flow = (float(veh.get("cooling", {}).get("pump_flow_lpm", 8)) if pump_ok else 0.0)
        p_loss_mot = 300.0 + 0.06 * abs(p_mech)
        p_loss_inv = 80.0 + 0.03 * abs(p_pack)
        r_mot = 0.03 if pump_ok else 0.09
        r_inv = 0.02 if pump_ok else 0.06
        q_mot = (self.t_winding - self.t_coolant) / r_mot
        q_inv = (self.t_igbt - self.t_coolant) / r_inv
        self.t_winding += dt * (p_loss_mot - q_mot) / 3500.0
        self.t_igbt += dt * (p_loss_inv - q_inv) / 1200.0
        ua_rad = (25.0 + 4.0 * airspeed) * (1.0 if pump_ok else 0.15)
        q_rad = ua_rad * (self.t_coolant - amb_t)
        self.t_coolant += dt * (q_mot + q_inv - q_rad) / 25000.0
        mdot_cp = flow / 60.0 * 1.04 * 3600.0
        t_out = self.t_coolant + (q_mot + q_inv) / max(mdot_cp, 50.0) / 2
        t_in = self.t_coolant - (q_mot + q_inv) / max(mdot_cp, 50.0) / 2

        imd = 150.0 if self.active("imd_fault") else 2000.0
        apps_ok = not self.active("apps_implausible")
        values.update({
            "apps1": apps + self.noise(0.2),
            "apps2": (0.0 if not apps_ok else apps) + self.noise(0.2),
            "brake_press_f": brake_f * 0.62 + abs(self.noise(0.05)),
            "brake_press_r": brake_f * 0.38 + abs(self.noise(0.05)),
            "mot_speed": mot_rpm + self.noise(2.0),
            "mot_torque": torque + self.noise(0.5),
            "mot_winding_temp": self.t_winding + self.noise(0.3),
            "inv_dc_voltage": pack_v + self.noise(0.2),
            "inv_dc_current": current + self.noise(0.3),
            "inv_phase_current": abs(torque) / 0.75 + self.noise(0.5),
            "inv_igbt_temp": self.t_igbt + self.noise(0.2),
            "inv_state": 3.0 if sdc_ok else 0.0,
            "inv_fault": 0.0,
            "pack_voltage": pack_v + self.noise(0.2),
            "pack_current": current_meas + self.noise(0.3),
            "bms_soc": round(self.bms_soc * 2) / 2,
            "bms_state": 2.0 if sdc_ok else 0.0,
            "bms_fault": 0.0,
            "cool_temp_in": t_in + self.noise(0.1),
            "cool_temp_out": t_out + self.noise(0.1),
            "cool_flow": flow + (self.noise(0.05) if pump_ok else 0.0),
            "pump_duty": 100.0 if pump_ok else 0.0,
            "fan_duty": 100.0 if self.t_coolant > 50 else 0.0,
            "sdc_closed": float(sdc_ok and apps_ok),
            "imd_ok": float(sdc_ok),
            "ams_ok": 1.0,
            "bspd_ok": 1.0,
            "apps_plaus_ok": float(apps_ok),
            "air_pos_closed": float(sdc_ok),
            "air_neg_closed": float(sdc_ok),
            "precharge_done": float(sdc_ok),
            "tsal_state": float(sdc_ok),
            "imd_iso_kohm": imd + self.noise(5.0),
        })

        # --- truth
        values.update({
            "truth_speed": v, "truth_downforce_f": df_front, "truth_downforce_r": df_rear, "truth_drag": drag,
            "truth_cla": downforce / q if q > 1 else math.nan, "truth_cda": cda * cd_k, "truth_soc": truth_soc,
            "truth_s": self.s, "truth_lap": float(self.lap), "truth_wind_speed": math.hypot(wind_e, wind_n),
            "truth_wind_dir": (math.degrees(math.atan2(-wind_e, -wind_n))) % 360.0,
        })

        # --- derived channels (what the analysis would compute)
        values.update(self._derived(values, df_front, df_rear, drag, cell_v, temps, t_in, t_out, flow))
        self._accumulate_lap(values, v, dt)
        if self.lap != prev_lap:
            events.extend(self._finish_lap(prev_lap))

        # --- generic fallback: any channel not modelled above still gets a value
        for ch in self.catalog:
            if ch.id not in values:
                mid, span = 0.5 * (ch.min + ch.max), 0.1 * (ch.max - ch.min)
                phase = (sum(map(ord, ch.id)) % 628) / 100.0
                values[ch.id] = mid + span * math.sin(0.2 * t + phase)
        return values, events

    def _derived(self, val: dict[str, float], df_f: float, df_r: float, drag: float,
                 cell_v: np.ndarray, temps: np.ndarray, t_in: float, t_out: float, flow: float) -> dict[str, float]:
        out: dict[str, float] = {}
        rho_m = physics.moist_air_density(val["amb_temp"], val["amb_press"], val["amb_rh"])
        q = val["pitot_dp"]
        if self.active("pitot_blocked"):  # analysis falls back to GPS speed
            q = physics.dynamic_pressure(rho_m, val["gps_speed"])
        out["calc_rho"] = rho_m
        out["calc_q"] = max(q, 0.0)
        out["calc_airspeed"] = physics.airspeed_from_q(q, rho_m)
        out["calc_yaw"] = val["probe_yaw"]
        cps: dict[str, float] = {}
        for tap in self.catalog.taps():
            cps[tap.id] = val[tap.id] / q if q > 60 else math.nan
            out[f"calc_cp_{tap.id}"] = cps[tap.id]

        def cl(element: str, station: str) -> float:
            taps = [tp for tp in self.catalog.taps(element) if tp.meta["station"] == station]
            suc = [tp for tp in taps if tp.meta["surface"] == "suction"]
            pre = [tp for tp in taps if tp.meta["surface"] == "pressure"]
            return physics.section_cl([tp.meta["x_c"] for tp in suc], [cps[tp.id] for tp in suc],
                                      [tp.meta["x_c"] for tp in pre], [cps[tp.id] for tp in pre])

        out["calc_cl_fw_l"], out["calc_cl_fw_r"] = cl("fw", "L"), cl("fw", "R")
        out["calc_cl_rw_l"], out["calc_cl_rw_r"] = cl("rw", "L"), cl("rw", "R")
        ut_cps = [cps[tp.id] for tp in self.catalog.taps("ut")]
        out["calc_cp_ut_mean"] = float(np.mean(ut_cps)) if q > 60 else math.nan
        mean_fw = 0.5 * (out["calc_cl_fw_l"] + out["calc_cl_fw_r"])
        out["calc_fw_asym"] = (out["calc_cl_fw_l"] - out["calc_cl_fw_r"]) / mean_fw * 100 if q > 60 else math.nan
        f = df_f + self.noise(6.0)
        r = df_r + self.noise(6.0)
        out["calc_downforce_f"], out["calc_downforce_r"], out["calc_downforce"] = f, r, f + r
        out["calc_aero_balance"] = 100.0 * f / (f + r) if f + r > 150 else math.nan
        d = drag + self.noise(8.0)
        out["calc_drag"] = d
        if q > 120:
            a = 0.05
            cla, cda = (f + r) / q, d / q
            self.cla_filt = cla if math.isnan(self.cla_filt) else self.cla_filt + a * (cla - self.cla_filt)
            self.cda_filt = cda if math.isnan(self.cda_filt) else self.cda_filt + a * (cda - self.cda_filt)
        out["calc_cla"], out["calc_cda"] = self.cla_filt, self.cda_filt
        out["calc_ld"] = self.cla_filt / self.cda_filt if self.cda_filt > 0 else math.nan

        pack_kw = val["pack_voltage"] * val["pack_current"] / 1000.0
        mot_kw = val["mot_torque"] * val["mot_speed"] * 2 * math.pi / 60 / 1000.0
        out["calc_pack_power"] = pack_kw
        out["calc_mot_power"] = mot_kw
        out["calc_inv_eff"] = 100.0 * mot_kw / pack_kw if pack_kw > 5 else math.nan
        out["calc_cell_v_min"] = float(np.min(cell_v))
        out["calc_cell_v_max"] = float(np.max(cell_v))
        out["calc_cell_v_delta"] = 1000.0 * (out["calc_cell_v_max"] - out["calc_cell_v_min"])
        out["calc_cell_v_min_idx"] = float(np.argmin(cell_v))
        out["calc_cell_t_max"] = float(np.max(temps))
        out["calc_cell_t_max_idx"] = float(np.argmax(temps))
        out["calc_cell_t_mean"] = float(np.mean(temps))
        out["calc_soc_cc"] = self.soc_cc
        out["calc_soc_ekf"] = self.soc_ekf
        out["calc_energy_used"] = self.energy_used
        out["calc_energy_regen"] = self.energy_regen
        out["calc_cool_heat"] = flow / 60.0 * 1.04 * 3.6 * (t_out - t_in)
        laps_needed = max(0.0, math.ceil(22000.0 / self.track.length) - self.lap)
        per_lap = self.laps[-1]["energy_kwh"] - self.laps[-1]["regen_kwh"] if self.laps else 0.42
        remaining = max(0.0, (self.soc_ekf - 5.0) / 100.0 * 140 * self.cell.group_capacity_ah * 3.6 / 1000.0)
        out["calc_laps_remaining"] = remaining / per_lap if per_lap > 0 else math.nan
        out["calc_laps_needed"] = laps_needed
        out["calc_power_limit_rec"] = float(self.strategy["recommended_kw"]) if self.strategy else math.nan
        out["calc_lap"] = float(self.lap)
        out["calc_lap_time"] = self.t - self.lap_acc.t_start
        out["calc_lap_dist"] = self.s
        return out

    def _accumulate_lap(self, val: dict[str, float], v: float, dt: float) -> None:
        acc = self.lap_acc
        acc.n += 1
        acc.v_sum += v
        acc.v_max = max(acc.v_max, v)
        e = val["calc_pack_power"] * dt / 3600.0
        if e >= 0:
            acc.energy_kwh += e
        else:
            acc.regen_kwh -= e
        for target, cid in ((acc.cla, "calc_cla"), (acc.cda, "calc_cda"), (acc.balance, "calc_aero_balance")):
            if math.isfinite(val[cid]):
                target.append(val[cid])
        acc.cell_t_max = max(acc.cell_t_max, val["calc_cell_t_max"])
        acc.cell_v_min = min(acc.cell_v_min, val["calc_cell_v_min"])
        acc.mot_temp_max = max(acc.mot_temp_max, val["mot_winding_temp"])

    def _finish_lap(self, lap_number: int) -> list[dict[str, Any]]:
        acc = self.lap_acc
        mean = lambda xs: float(np.mean(xs)) if xs else math.nan  # noqa: E731
        lap_time = self.t - acc.t_start
        summary = LapSummary(
            lap=lap_number + 1, lap_time=lap_time, distance=self.track.length,
            v_avg=acc.v_sum / max(acc.n, 1), v_max=acc.v_max, energy_kwh=acc.energy_kwh,
            regen_kwh=acc.regen_kwh, cla_avg=mean(acc.cla), cda_avg=mean(acc.cda),
            balance_avg=mean(acc.balance), cell_t_max=acc.cell_t_max, cell_v_min=acc.cell_v_min,
            mot_temp_max=acc.mot_temp_max,
        )
        lap_json = summary.to_json()
        self.laps.append(lap_json)
        self.lap_acc = LapAccumulator(t_start=self.t)
        self.strategy = self._strategy(lap_json)
        return [{"type": "lap", "lap": lap_json}, {"type": "strategy", "strategy": self.strategy}]

    def _strategy(self, lap: dict[str, Any]) -> dict[str, Any]:
        """Energy per lap ~ P^0.6, lap time ~ P^-0.25 (plausible shape of the lapsim curve)."""
        laps_needed = math.ceil(22000.0 / self.track.length)
        laps_done = len(self.laps)
        e_lap_80 = max(0.05, (lap["energy_kwh"] or 0.4) - (lap["regen_kwh"] or 0.0))
        t_lap_80 = lap["lap_time"] or self.lap_time_est
        usable = 140 * self.cell.group_capacity_ah * 3.6 / 1000.0
        remaining = max(0.0, float(self.soc_ekf - 5.0) / 100.0 * usable)
        curve = []
        recommended = 40
        for kw in range(40, 85, 5):
            e = e_lap_80 * (kw / 80.0) ** 0.6
            curve.append({"kw": kw, "lap_time": round(t_lap_80 * (80.0 / kw) ** 0.25, 3), "energy_kwh": round(e, 4)})
            if e * (laps_needed - laps_done) <= remaining:
                recommended = kw
        e_rec = e_lap_80 * (recommended / 80.0) ** 0.6
        finish = (remaining - e_rec * (laps_needed - laps_done)) / usable * 100.0 + 5.0
        return {"laps_done": laps_done, "laps_needed": laps_needed, "energy_remaining_kwh": round(remaining, 3),
                "energy_per_lap_kwh": round(e_lap_80, 4), "recommended_kw": recommended,
                "predicted_finish_soc": round(float(finish), 2), "curve": curve}


# --------------------------------------------------------------------------------------
# Feed: car + store + alerts + clients
# --------------------------------------------------------------------------------------


class MockFeed:
    """Session-like state shared by the HTTP handlers and the tick loop."""

    def __init__(self, catalog: Catalog, vehicle: dict[str, Any], hybrid: bool = False, speed: float = 1.0) -> None:
        self.catalog = catalog
        self.vehicle = vehicle
        self.hybrid = hybrid
        self.speed = speed
        self.car = MockCar(catalog, vehicle, hybrid)
        self.store = ChannelStore(catalog, history_s=300.0, snapshot_hz=TICK_HZ)
        self.resolution = {ch.id: ch.resolution for ch in catalog}
        self.clients: set[web.WebSocketResponse] = set()
        self.track_json = self.car.track.to_json()
        self.reset()

    def reset(self) -> None:
        self.car.reset()
        self.store.reset()
        self.alerts: dict[str, Alert] = {}
        self.alert_log: list[Alert] = []
        self.started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.last_values: dict[str, float] = {}
        self.next_background = BACKGROUND_PERIOD_S
        self.background_index = 0
        self.lines = 0

    @property
    def mode(self) -> str:
        return "HYBRID" if self.hybrid else "SIM"

    def sources(self) -> list[dict[str, Any]]:
        out = [{"kind": "sim", "label": "Simulator (mock)", "status": "running",
                "detail": f"mock_loop ×{self.speed:g}", "stats": {"t": round(self.car.t, 1)}}]
        if self.hybrid:
            out.append({"kind": "serial", "label": "Bench node (mock)", "status": "running",
                        "detail": "/dev/ttyACM0 @ 115200 baud, node AERO1",
                        "stats": {"lines": self.lines, "checksum_errors": 0, "unknown": 0}})
        return out

    def faults(self) -> list[dict[str, Any]]:
        return [f.to_json() for f in self.car.faults.values()]

    def hello(self) -> dict[str, Any]:
        return {
            "type": "hello", "version": "1.0", "mode": self.mode,
            "session": {"name": "Mock feed (tools/mock_feed_server.py)", "started": self.started},
            "sources": self.sources(), "channels": self.catalog.to_json(), "track": self.track_json,
            "vehicle": self.vehicle, "faults": self.faults(),
            "alerts": [a.to_json() for a in self.alerts.values()], "laps": list(self.car.laps),
            "strategy": self.car.strategy, "t": json_value(self.car.t, 0.001),
        }

    def frame(self) -> dict[str, Any]:
        res = self.resolution
        return {"type": "frame", "t": json_value(self.car.t, 0.001),
                "v": {cid: json_value(v, res.get(cid, 0.0)) for cid, v in self.last_values.items()},
                "owner": {"fw_p03": "serial"} if self.hybrid else {}}

    # ---- alerts -----------------------------------------------------------------------

    def _raise(self, alert_id: str, detail: str) -> dict[str, Any] | None:
        if alert_id in self.alerts:
            return None
        severity, title, channels = ALERTS[alert_id]
        alert = Alert(alert_id, alert_id, severity, title, detail, channels, self.car.t)
        self.alerts[alert_id] = alert
        self.alert_log.append(alert)
        return {"type": "alert", "alert": alert.to_json()}

    def _clear(self, alert_id: str) -> dict[str, Any] | None:
        alert = self.alerts.pop(alert_id, None)
        if alert is None:
            return None
        alert.active = False
        alert.t_end = self.car.t
        return {"type": "alert", "alert": alert.to_json()}

    def _alert_events(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any] | None] = []
        t = self.car.t
        wanted: set[str] = set()
        for fid, since in self.car.fault_since.items():
            if t - since >= 1.5:
                wanted.update(self.car.fault_alerts[fid])
        for fid, alerts in self.car.fault_alerts.items():
            for aid in alerts:
                if aid in wanted:
                    events.append(self._raise(aid, f"caused by injected fault '{fid}'"))
        if t >= self.next_background:
            aid = BACKGROUND_ALERTS[self.background_index % len(BACKGROUND_ALERTS)]
            self.background_index += 1
            self.next_background += BACKGROUND_PERIOD_S
            events.append(self._raise(aid, "mock background alert"))
        for aid, alert in list(self.alerts.items()):
            fault_owned = aid in wanted
            expired = alert.detail == "mock background alert" and t - alert.t_start >= BACKGROUND_DURATION_S
            from_fault = alert.detail.startswith("caused by injected fault")
            if (from_fault and not fault_owned) or expired:
                events.append(self._clear(aid))
        return [e for e in events if e is not None]

    # ---- ticking ----------------------------------------------------------------------

    def tick(self, dt_wall: float) -> list[dict[str, Any]]:
        """Advance the car, store a snapshot, return the events of this tick."""
        dt = dt_wall * self.speed
        values, events = self.car.step(dt)
        self.lines += 1 if self.hybrid else 0
        self.last_values = values
        self.store.update(self.car.t, values)
        self.store.snapshot(self.car.t)
        return events + self._alert_events()

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.clients:
            return
        text = json.dumps(message, allow_nan=False)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_str(text)
            except (ConnectionError, RuntimeError):
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def run(self) -> None:
        period = 1.0 / TICK_HZ
        last = time.monotonic()
        next_sources = last + 1.0
        while True:
            await asyncio.sleep(max(0.0, last + period - time.monotonic()))
            now = time.monotonic()
            dt = min(now - last, 0.25)
            last = now
            for event in self.tick(dt):
                await self.broadcast(event)
            await self.broadcast(self.frame())
            if now >= next_sources:
                next_sources = now + 1.0
                await self.broadcast({"type": "sources", "sources": self.sources()})


# --------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------

NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"}
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")

FEED_KEY = web.AppKey("feed", MockFeed)
WEB_KEY = web.AppKey("web_root", Path)
TASK_KEY = web.AppKey("tick_task", asyncio.Task)


def json_response(data: Any, status: int = 200) -> web.Response:
    return web.Response(text=json.dumps(data, allow_nan=False), status=status,
                        content_type="application/json", headers=NO_CACHE)


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    feed = request.app[FEED_KEY]
    ws = web.WebSocketResponse(heartbeat=20.0)
    await ws.prepare(request)
    await ws.send_str(json.dumps(feed.hello(), allow_nan=False))
    feed.clients.add(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        feed.clients.discard(ws)
    return ws


async def handle_hello(request: web.Request) -> web.Response:
    return json_response(request.app[FEED_KEY].hello())


async def handle_history(request: web.Request) -> web.Response:
    feed = request.app[FEED_KEY]
    ids = [i for i in request.query.get("ids", "").split(",") if i]
    try:
        seconds = float(request.query.get("seconds", "60"))
    except ValueError:
        return json_response({"error": "seconds must be a number"}, 400)
    if not ids:
        return json_response({"error": "ids=a,b,... required"}, 400)
    t, series = feed.store.history(ids, seconds)
    res = feed.resolution
    return json_response({"t": [json_value(x, 0.001) for x in t],
                          "series": {cid: [json_value(x, res.get(cid, 0.0)) for x in arr]
                                     for cid, arr in series.items()}})


async def handle_faults(request: web.Request) -> web.Response:
    return json_response(request.app[FEED_KEY].faults())


async def handle_set_fault(request: web.Request) -> web.Response:
    feed = request.app[FEED_KEY]
    fid = request.match_info["fault_id"]
    try:
        body = await request.json()
        active = bool(body["active"])
    except (ValueError, KeyError, TypeError):
        return json_response({"error": 'body must be {"active": true|false}'}, 400)
    try:
        feed.car.set_fault(fid, active)
    except KeyError:
        return json_response({"error": f"unknown fault {fid!r}"}, 404)
    faults = feed.faults()
    await feed.broadcast({"type": "faults", "faults": faults})
    return json_response(faults)


async def handle_laps(request: web.Request) -> web.Response:
    return json_response(request.app[FEED_KEY].car.laps)


async def handle_alerts(request: web.Request) -> web.Response:
    """All alerts of the session (active and cleared), oldest first."""
    return json_response([a.to_json() for a in request.app[FEED_KEY].alert_log])


async def handle_reset(request: web.Request) -> web.Response:
    feed = request.app[FEED_KEY]
    feed.reset()
    await feed.broadcast(feed.hello())
    return json_response({"ok": True})


async def handle_sources(request: web.Request) -> web.Response:
    return json_response(request.app[FEED_KEY].sources())


async def handle_static(request: web.Request) -> web.StreamResponse:
    root: Path = request.app[WEB_KEY]
    rel = request.match_info.get("path", "") or "index.html"
    target = (root / rel).resolve()
    if target.is_dir():
        target = target / "index.html"
    if not target.is_relative_to(root.resolve()):
        raise web.HTTPForbidden()
    if not target.is_file():
        if rel == "index.html":
            return web.Response(text="<!doctype html><title>AeroVolt mock</title><p>web/index.html does not "
                                     "exist yet. The mock feed is running: try <code>/api/hello</code>.</p>",
                                content_type="text/html", headers=NO_CACHE)
        raise web.HTTPNotFound()
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return web.FileResponse(target, headers={**NO_CACHE, "Content-Type": ctype})


def load_vehicle() -> dict[str, Any]:
    path = ROOT / "config" / "vehicle.yaml"
    if path.exists():
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    return FALLBACK_VEHICLE


def create_app(feed: MockFeed, web_root: Path, start_ticking: bool = True) -> web.Application:
    """aiohttp application; ``start_ticking=False`` lets tests drive ``feed.tick`` by hand."""
    app = web.Application()
    app[FEED_KEY] = feed
    app[WEB_KEY] = web_root
    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/api/hello", handle_hello)
    app.router.add_get("/api/history", handle_history)
    app.router.add_get("/api/faults", handle_faults)
    app.router.add_post("/api/faults/{fault_id}", handle_set_fault)
    app.router.add_get("/api/laps", handle_laps)
    app.router.add_get("/api/alerts", handle_alerts)
    app.router.add_post("/api/session/reset", handle_reset)
    app.router.add_get("/api/sources", handle_sources)
    app.router.add_get("/", handle_static)
    app.router.add_get("/{path:.*}", handle_static)

    if start_ticking:
        async def start(app_: web.Application) -> None:
            app_[TASK_KEY] = asyncio.create_task(feed.run())

        async def stop(app_: web.Application) -> None:
            app_[TASK_KEY].cancel()
            for ws in list(feed.clients):
                await ws.close()

        app.on_startup.append(start)
        app.on_shutdown.append(stop)
    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="AeroVolt mock feed for web development (SPEC section 9).")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--hybrid", action="store_true", help="pretend fw_p03 comes from a USB-serial node")
    parser.add_argument("--speed", type=float, default=1.0, help="time multiplier (e.g. 5 for faster laps)")
    parser.add_argument("--web", type=Path, default=ROOT / "web", help="static files folder")
    args = parser.parse_args(argv)
    vehicle = load_vehicle()
    catalog = Catalog.load(ROOT / "config" / "sensors.yaml", vehicle)
    feed = MockFeed(catalog, vehicle, hybrid=args.hybrid, speed=args.speed)
    print(f"AeroVolt {__version__} mock feed: {len(catalog)} channels, track {feed.car.track.length:.0f} m "
          f"(~{feed.car.lap_time_est:.0f} s/lap), mode {feed.mode}")
    print(f"open http://{args.host}:{args.port}/")
    web.run_app(create_app(feed, args.web.resolve()), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
