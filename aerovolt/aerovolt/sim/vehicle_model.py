"""Vehicle dynamics of the virtual car: where it is, how fast, and what the chassis feels.

* :class:`TrackCursor` — fast scalar look-up of the track geometry at a distance ``s``.
* :class:`SpeedProfile` — the target speed ``v_ref(s)`` from the quasi-steady-state lap
  simulator (:mod:`aerovolt.sim.lapsim`), i.e. "how fast a good driver can go here".
* :class:`Driver` — follows that profile: pedal and brake from a PI controller on the speed
  error with acceleration feed-forward, steering from the track curvature.
* :class:`Chassis` — the car as a point mass moving along the centreline, plus a
  quasi-static suspension (wheel loads → spring travel → ride heights, pitch, roll),
  pushrods, dampers, IMU and wheel speeds.

Longitudinal motion (``F`` forces along the car, ``m`` mass)::

    m·dv/dt = F_drive − F_brake − D_x − C_rr·(m·g + L) − F_shaft
    ds/dt   = v

Lateral acceleration follows the path: ``a_y = v²·κ`` (+ = left). Wheel loads (per corner)::

    F_z = static weight share + aero (L_front/2, L_rear/2)
          ∓ m·a_x·h/L / 2                        longitudinal load transfer
          ∓ m_axle·a_y·h/track                   lateral load transfer (outer wheel +)
          + road roughness

spring travel = (F_z − F_z,static) / wheel rate; the ride heights drop by the mean travel of
their axle. Because the aero load depends on the ride heights (ground effect) and the ride
heights depend on the aero load, the engine solves this small fixed point every step.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from aerovolt.core import physics
from aerovolt.sim import lapsim
from aerovolt.sim.sensors import OrnsteinUhlenbeck
from aerovolt.sim.tracks import Track

G = physics.G


# ============================================================================ track
class TrackCursor:
    """Linear interpolation of ``x, y, θ, κ`` at any distance ``s`` with plain floats.

    ``θ`` is the *maths* angle of the tangent (from east, anticlockwise, unwrapped) in
    radians; :meth:`heading_deg` converts to the compass heading GPS reports. Closed tracks
    wrap ``s`` modulo the lap length (``s`` may be negative or exceed it); open tracks clamp.
    """

    def __init__(self, track: Track) -> None:
        self.track = track
        self.closed = track.closed
        self.length = float(track.length)
        self.ds = track.ds
        theta = np.unwrap(np.radians(90.0 - np.asarray(track.heading)))
        x, y, kappa = np.asarray(track.x), np.asarray(track.y), np.asarray(track.kappa)
        if self.closed:  # append the start point at s = length so interpolation wraps
            turns = 2.0 * math.pi * round((theta[-1] - theta[0]) / (2.0 * math.pi))
            x, y = np.append(x, x[0]), np.append(y, y[0])
            theta, kappa = np.append(theta, theta[0] + turns), np.append(kappa, kappa[0])
        self.turn_per_lap = float(theta[-1] - theta[0]) if self.closed else 0.0
        self._x, self._y = x.tolist(), y.tolist()
        self._theta, self._kappa = theta.tolist(), kappa.tolist()
        self._n = len(self._x) - 1

    def wrap(self, s: float) -> float:
        """Distance along the lap: ``s mod length`` (closed) or clamped to the track (open)."""
        if self.closed:
            return s % self.length
        return min(max(s, 0.0), self.length)

    def at(self, s: float) -> tuple[float, float, float, float]:
        """``(x, y, θ, κ)`` at distance ``s``."""
        u = self.wrap(s) / self.ds
        i = min(int(u), self._n - 1)
        f = u - i
        x, y, th, k = self._x, self._y, self._theta, self._kappa
        return (x[i] + f * (x[i + 1] - x[i]), y[i] + f * (y[i + 1] - y[i]),
                th[i] + f * (th[i + 1] - th[i]), k[i] + f * (k[i + 1] - k[i]))

    @staticmethod
    def heading_deg(theta: float) -> float:
        """Maths angle [rad] → compass heading [deg] (0 = north, clockwise)."""
        return (90.0 - math.degrees(theta)) % 360.0

    def gate_positions(self) -> list[float]:
        """Distances along the lap where the centreline crosses the start/finish gate
        forwards (once for a normal lap, twice for the skid-pad figure of eight)."""
        tr = self.track
        n = len(tr.s)
        gates = []
        pairs = range(n) if self.closed else range(n - 1)
        for i in pairs:
            j = (i + 1) % n
            if tr.crossed_start_line((tr.x[i], tr.y[i]), (tr.x[j], tr.y[j])):
                gates.append(float(tr.s[j]) if j else 0.0)
        return sorted(gates)


# ============================================================================ profile
class SpeedProfile:
    """Target speed and acceleration along the track from :func:`lapsim.solve`."""

    def __init__(self, track: Track, result: lapsim.LapResult) -> None:
        self.result = result
        self.closed = track.closed
        self.length = float(track.length)
        self.ds = track.ds
        v, ax = np.asarray(result.v), np.asarray(result.ax)
        if self.closed:
            v, ax = np.append(v, v[0]), np.append(ax, ax[0])
        self._v, self._ax = v.tolist(), ax.tolist()
        self._n = len(self._v) - 1

    @classmethod
    def solve(cls, track: Track, params: lapsim.VehicleParams, **solve_kwargs) -> SpeedProfile:
        """Run the lap simulator (``power_limit_kw``, ``aero_scale``, ``rho``, ``wind`` …)."""
        return cls(track, lapsim.solve(track, params, **solve_kwargs))

    def at(self, s: float) -> tuple[float, float]:
        """``(v_ref, a_ref)`` at distance ``s`` (wrapped / clamped like the track)."""
        s = s % self.length if self.closed else min(max(s, 0.0), self.length)
        u = s / self.ds
        i = min(int(u), self._n - 1)
        f = u - i
        v, a = self._v, self._ax
        return v[i] + f * (v[i + 1] - v[i]), a[i] + f * (a[i + 1] - a[i])


# ============================================================================ driver
@dataclass
class DriverCommand:
    """Pedal position [%] and the total brake force the driver asks for [N]."""

    pedal_pct: float
    brake_force_n: float


class Driver:
    """A consistent racing driver who follows the lap-sim speed profile.

    Longitudinal control is a PI controller on the speed error with acceleration
    feed-forward, looking ``LOOKAHEAD_S`` ahead (drivers brake for what they see coming)::

        a_cmd = a_ref + K_p·(v_ref − v) + K_i·∫(v_ref − v) dt
        F_cmd = m·a_cmd + F_resist                       (drag + rolling resistance)

    ``F_cmd > 0`` → pedal = torque needed / peak torque; ``F_cmd < −COAST_BAND_N`` → brakes;
    in between the driver coasts. The integrator only runs while the pedal is not
    saturated (anti-windup). Each lap the target is scaled by a seeded random factor
    within ±1 % (no two laps are identical). If the tractive system is not in "drive" the
    driver brakes to a stop and holds the car; after an APPS torque cut the driver lifts
    off briefly so the plausibility check can reset.
    """

    KP = 1.5             # 1/s
    KI = 0.4             # 1/s²
    LOOKAHEAD_S = 0.15
    COAST_BAND_N = 150.0
    STOP_DECEL = 0.5 * G
    HOLD_BRAKE_N = 600.0
    LIFT_AFTER_CUT_S = 0.3
    LIFT_DURATION_S = 1.0
    LAP_VARIATION = 0.01

    def __init__(self, params: lapsim.VehicleParams, rng: np.random.Generator) -> None:
        self.mass = params.mass_kg
        self.t_peak = params.motor_peak_torque_nm
        self.wheel_per_nm = params.gear_ratio * params.driveline_efficiency / params.wheel_radius_m
        self.brake_max = params.brake_force_max_n
        self._rng = rng
        self.lap_factor = 1.0
        self._integral = 0.0
        self._cut_s = 0.0
        self._lift_s = 0.0

    def new_lap(self) -> None:
        """Draw this lap's pace factor (seeded, uniform within ±LAP_VARIATION)."""
        self.lap_factor = 1.0 + float(self._rng.uniform(-self.LAP_VARIATION, self.LAP_VARIATION))

    def control(self, dt: float, s: float, v: float, profile: SpeedProfile, *,
                may_drive: bool, resist_n: float, torque_cut: bool) -> DriverCommand:
        """Pedal / brake for this step."""
        if not may_drive:
            self._integral = 0.0
            brake = self.mass * self.STOP_DECEL if v > 0.2 else self.HOLD_BRAKE_N
            return DriverCommand(0.0, brake)
        if torque_cut:
            self._cut_s += dt
            if self._cut_s >= self.LIFT_AFTER_CUT_S:
                self._lift_s = self.LIFT_DURATION_S
        else:
            self._cut_s = 0.0
        if self._lift_s > 0.0:
            self._lift_s -= dt
            return DriverCommand(0.0, 0.0)

        v_ref, a_ref = profile.at(s + v * self.LOOKAHEAD_S)
        v_ref *= self.lap_factor
        error = v_ref - v
        a_cmd = a_ref + self.KP * error + self.KI * self._integral
        f_cmd = self.mass * a_cmd + resist_n
        if f_cmd >= 0.0:
            pedal = 100.0 * f_cmd / (self.wheel_per_nm * self.t_peak)
            if pedal < 100.0 or error < 0.0:
                self._integral += error * dt
            return DriverCommand(min(pedal, 100.0), 0.0)
        self._integral += error * dt
        brake = -f_cmd if -f_cmd > self.COAST_BAND_N else 0.0
        return DriverCommand(0.0, min(brake, self.brake_max))


# ============================================================================ chassis
@dataclass
class SuspensionState:
    """Quasi-static suspension state (true values). Corner order: FL, FR, RL, RR."""

    load: tuple[float, float, float, float]       # tyre vertical loads [N]
    travel_mm: tuple[float, float, float, float]  # wheel travel from static [mm, + = bump]
    rh_front: float                               # ride heights [mm]
    rh_rear: float
    pitch_deg: float                              # + = nose down (ISO 8855 pitch)
    roll_deg: float                               # + = right side down (ISO 8855 roll)
    heave_force: float                            # road-roughness vertical force [N]


class Chassis:
    """Point-mass motion along the track, suspension, pushrods, dampers, IMU, wheels."""

    #: Road roughness: σ of the vertical force per corner at speed [N] and its correlation.
    ROAD_SIGMA_N = 30.0
    ROAD_TAU_S = 0.03
    #: Longitudinal tyre stiffness: slip ratio = F_x / (C·F_z).
    SLIP_STIFFNESS = 25.0
    #: Lowest possible ride height [mm] (skid block on the ground).
    MIN_RIDE_HEIGHT_MM = 0.5

    def __init__(self, vehicle: Mapping, rng: np.random.Generator, dt: float) -> None:
        self.mass = float(vehicle["mass_kg"])
        self.wf = float(vehicle["weight_dist_front"])
        self.h_cg = float(vehicle["cg_height_m"])
        self.wheelbase = float(vehicle["wheelbase_m"])
        self.track_f = float(vehicle["track_front_m"])
        self.track_r = float(vehicle["track_rear_m"])
        self.r_wheel = float(vehicle["wheel_radius_m"])
        self.unsprung = float(vehicle["unsprung_mass_corner_kg"])
        s = vehicle["suspension"]
        self.k_f = float(s["wheel_rate_n_per_mm"]["front"])
        self.k_r = float(s["wheel_rate_n_per_mm"]["rear"])
        self.pr_f = float(s["pushrod_ratio"]["front"])
        self.pr_r = float(s["pushrod_ratio"]["rear"])
        self.mr_f = float(s["damper_motion_ratio"]["front"])
        self.mr_r = float(s["damper_motion_ratio"]["rear"])
        self.rh0_f = float(s["static_ride_height_mm"]["front"])
        self.rh0_r = float(s["static_ride_height_mm"]["rear"])
        st = vehicle.get("steering", {})
        self.steer_ratio = float(st.get("ratio", 5.0))
        self.understeer = math.radians(float(st.get("understeer_deg_per_g", 1.0)))
        self.static_f = self.mass * G * self.wf / 2.0
        self.static_r = self.mass * G * (1.0 - self.wf) / 2.0
        self.ride_height_offset_mm = 0.0  # fault: ut_bottoming
        self._road = [OrnsteinUhlenbeck(self.ROAD_SIGMA_N, self.ROAD_TAU_S, dt, rng) for _ in range(4)]
        self._steer_jitter = OrnsteinUhlenbeck(0.4, 0.3, dt, rng)
        self._road_now = [0.0] * 4
        self.dt = dt
        self.s = 0.0
        self.v = 0.0
        self.ax = 0.0
        self.ay = 0.0
        self.susp = self.suspension(0.0, 0.0, 0.0, 0.0)
        self._prev_pitch = self.susp.pitch_deg
        self._prev_roll = self.susp.roll_deg

    # ---- motion -----------------------------------------------------------------------
    def advance(self, dt: float, force_n: float, kappa: float) -> None:
        """Integrate speed and distance with the net longitudinal force (no reversing)."""
        v0 = self.v
        v1 = v0 + force_n / self.mass * dt
        if v1 < 0.0:
            v1 = 0.0
        self.s += 0.5 * (v0 + v1) * dt
        self.v = v1
        self.ax = (v1 - v0) / dt
        self.ay = v1 * v1 * kappa

    def step_road(self, speed: float) -> None:
        """Advance the road-roughness processes (amplitude grows with speed)."""
        amp = min(1.0, 0.15 + speed / 25.0)
        self._road_now = [amp * r.step() for r in self._road]

    def suspension(self, ax: float, ay: float, down_f: float, down_r: float) -> SuspensionState:
        """Wheel loads, travel, ride heights, pitch and roll for the given accelerations."""
        m, h = self.mass, self.h_cg
        d_long = m * ax * h / self.wheelbase / 2.0           # per wheel, front −, rear +
        d_lat_f = self.wf * m * ay * h / self.track_f          # front axle, right wheel +
        d_lat_r = (1.0 - self.wf) * m * ay * h / self.track_r
        n = self._road_now
        fl = self.static_f + down_f / 2.0 - d_long - d_lat_f + n[0]
        fr = self.static_f + down_f / 2.0 - d_long + d_lat_f + n[1]
        rl = self.static_r + down_r / 2.0 + d_long - d_lat_r + n[2]
        rr = self.static_r + down_r / 2.0 + d_long + d_lat_r + n[3]
        loads = (max(fl, 0.0), max(fr, 0.0), max(rl, 0.0), max(rr, 0.0))
        t = ((loads[0] - self.static_f) / self.k_f, (loads[1] - self.static_f) / self.k_f,
             (loads[2] - self.static_r) / self.k_r, (loads[3] - self.static_r) / self.k_r)
        tf, tr = 0.5 * (t[0] + t[1]), 0.5 * (t[2] + t[3])
        off = self.ride_height_offset_mm
        rh_f = max(self.rh0_f + off - tf, self.MIN_RIDE_HEIGHT_MM)
        rh_r = max(self.rh0_r + off - tr, self.MIN_RIDE_HEIGHT_MM)
        pitch = math.degrees((tf - tr) / (1000.0 * self.wheelbase))
        roll = math.degrees(((t[1] + t[3]) - (t[0] + t[2])) / (1000.0 * (self.track_f + self.track_r)))
        return SuspensionState(loads, t, rh_f, rh_r, pitch, roll, n[0] + n[1] + n[2] + n[3])

    def set_suspension(self, susp: SuspensionState) -> tuple[float, float]:
        """Store the solved suspension state; returns the (roll, pitch) rates [deg/s]."""
        self.susp = susp
        roll_rate = (susp.roll_deg - self._prev_roll) / self.dt
        pitch_rate = (susp.pitch_deg - self._prev_pitch) / self.dt
        self._prev_roll, self._prev_pitch = susp.roll_deg, susp.pitch_deg
        return roll_rate, pitch_rate

    # ---- sensors (true values) ----------------------------------------------------------
    def pushrods(self) -> tuple[float, float, float, float]:
        """Pushrod compression forces [N]: ``physics.pushrod_from_wheel_load`` per corner."""
        load = self.susp.load
        pf = physics.pushrod_from_wheel_load
        return (pf(load[0], self.pr_f, self.unsprung), pf(load[1], self.pr_f, self.unsprung),
                pf(load[2], self.pr_r, self.unsprung), pf(load[3], self.pr_r, self.unsprung))

    def dampers(self) -> tuple[float, float, float, float]:
        """Damper compression from static [mm] = wheel travel × motion ratio."""
        t = self.susp.travel_mm
        return t[0] * self.mr_f, t[1] * self.mr_f, t[2] * self.mr_r, t[3] * self.mr_r

    def imu(self) -> tuple[float, float, float]:
        """Accelerometer reading (specific force) in the body frame [m/s²].

        ``f = a − g_vec`` resolved on the pitched (θ, nose down +) and rolled (φ, right
        down +) body axes: ``ax = a_x·cosθ − g·sinθ``, ``ay = a_y·cosφ + g·sinφ``,
        ``az = g·cosθ·cosφ + a_x·sinθ − a_y·sinφ + heave`` — so az ≈ +9.81 at rest.
        """
        th = math.radians(self.susp.pitch_deg)
        ph = math.radians(self.susp.roll_deg)
        sth, cth, sph, cph = math.sin(th), math.cos(th), math.sin(ph), math.cos(ph)
        heave = self.susp.heave_force / self.mass
        return (self.ax * cth - G * sth,
                self.ay * cph + G * sph,
                G * cth * cph + self.ax * sth - self.ay * sph + heave)

    def wheel_speeds(self, kappa: float, slip_front: float, slip_rear: float) -> tuple[float, float, float, float]:
        """Tyre surface speeds [m/s]: inner wheels slower in a corner (v·(1 ∓ κ·t/2)),
        times (1 + slip) — driven rear wheels slightly faster, braked wheels slower."""
        v = self.v
        kf, kr = kappa * self.track_f / 2.0, kappa * self.track_r / 2.0
        return (max(v * (1.0 - kf) * (1.0 + slip_front), 0.0), max(v * (1.0 + kf) * (1.0 + slip_front), 0.0),
                max(v * (1.0 - kr) * (1.0 + slip_rear), 0.0), max(v * (1.0 + kr) * (1.0 + slip_rear), 0.0))

    def slip(self, force_n: float, axle_load_n: float) -> float:
        """Longitudinal slip ratio for a tyre force on an axle (linear tyre region)."""
        return force_n / (self.SLIP_STIFFNESS * axle_load_n) if axle_load_n > 1.0 else 0.0

    def steering_wheel_deg(self, kappa: float) -> float:
        """Steering-wheel angle [deg, + = left]: Ackermann angle ``atan(L·κ)`` plus the
        understeer gradient × lateral acceleration, times the steering ratio."""
        road_wheel = math.atan(self.wheelbase * kappa) + self.understeer * self.ay / G
        return self.steer_ratio * math.degrees(road_wheel) + self._steer_jitter.step()
