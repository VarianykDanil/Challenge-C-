"""Quasi-steady-state (QSS) point-mass lap-time simulator.

Used by the simulator (the car's target speed profile) and by ``analysis/strategy.py``
(predicted lap time and energy per lap versus the accumulator power limit).

The QSS method in one paragraph
-------------------------------
The car is a point mass that, at every point of the track, is assumed to be in a *steady
state*: the tyre forces it can generate depend only on the current speed and curvature
(no transients — no yaw inertia, no suspension dynamics, no tyre relaxation). That turns a
lap into three cheap passes over the track samples ``s_i`` (spacing ``Δs`` ≈ 0.5 m):

1. **Cornering limit** ``v_lat(s)`` — the highest speed at which each axle can supply its
   share of the centripetal force. With downforce growing with ``v²`` this is solved in
   closed form (below).
2. **Forward pass (acceleration)** — starting from a point where the speed is known,
   integrate ``v_{i+1}² = v_i² + 2·a_x·Δs`` with the largest *available* acceleration, then
   clip to ``v_lat``. The drive force is the smallest of: the motor torque/speed curve,
   the FS accumulator power limit (battery side, after motor and inverter losses), and rear
   tyre traction (rear-wheel drive, including longitudinal load transfer and the friction
   ellipse). Drag and rolling resistance are subtracted.
3. **Backward pass (braking)** — the same integration run backwards from the end with the
   largest available deceleration (tyres on all four wheels, friction ellipse, brake system
   force limit; drag and rolling resistance help). Running it *backwards* answers "how fast
   may I arrive here and still make the next corner?" — the braking point falls out
   automatically.

The speed profile is the point-wise minimum of the three. Wherever it equals the forward
pass the car is accelerating flat out, wherever it equals the backward pass it is braking
at the limit, and at the apexes it rides the cornering limit — exactly how a good driver
drives. On a closed lap the passes start at the global minimum of ``v_lat`` (the slowest
apex), where the true speed is known to equal ``v_lat``; open tracks (acceleration) start
from rest and end at rest at the end of the run-off.

Physics used (SI units; ``m`` mass, ``g`` = 9.81 m/s², ``ρ`` air density)
--------------------------------------------------------------------------
* Air speed with wind: ``v_air² = (v − w∥)² + w⊥² = v² − 2·v·w∥ + w²`` where ``w∥`` is the
  tail-wind component along the car's heading. Downforce ``L = ½ρ·CL·A·v_air²`` split front
  / rear by the aero balance; drag along the car ``D = ½ρ·CD·A·|v_air|·(v − w∥)``.
* Cornering, per axle ``j`` carrying a static weight fraction ``f_j`` and downforce ``L_j``::

      f_j·m·v²·|κ| ≤ μ_lat·(f_j·m·g + L_j(v))

  (the axle's share of the centripetal force follows from yaw-moment balance about the CG,
  so it equals its static weight fraction). Without wind this gives
  ``v² = μ f_j m g / (f_j m |κ| − μ·½ρ CL·A_j)``; with wind a quadratic in ``v``.
  If the denominator is ≤ 0 the downforce grows faster than the required centripetal force
  and grip no longer limits the speed (only the motor's maximum speed does).
* Rolling resistance ``R = C_rr·(m g + L)``.
* Rear traction with load transfer ``ΔF_z = m·a_x·h/L_wb`` and the friction ellipse::

      F_x ≤ μ_long·e·F_zr,   e = √(1 − (F_yr / (μ_lat F_zr))²),   F_yr = (1 − f_front)·m·v²κ
      ⇒ F_x = μ_long·e·(F_zr0 − (D + R)·h/L_wb) / (1 − μ_long·e·h/L_wb)

  (``F_zr0`` = static rear load + rear downforce; ``m·a_x = F_x − D − R``.)
* Motor: constant torque ``T_peak`` up to the base speed, then constant power, zero above
  ``n_max``. Losses ``P_loss = k_cu·T² + k_fe·ω + k_w·ω²`` (copper, iron, windage).
  Battery power ``P_batt = (T·ω + P_loss) / η_inv``. The accumulator limit ``P_batt ≤ P_lim``
  gives the torque limit from ``k_cu·T² + ω·T + (k_fe ω + k_w ω² − η_inv·P_lim) = 0``.
  Wheel force ``F = T·G·η_dl / r`` (``G`` gear ratio, ``η_dl`` driveline efficiency).
* Braking: ``F_brake ≤ min(μ_long·e·(m g + L), F_brake,max)`` with the car-level ellipse
  ``e = √(1 − (a_y / a_y,max)²)``. The brake-system limit models the hydraulics at the
  driver's maximum pedal force — with aero the tyres could brake harder at high speed than
  the pedal can ask for, which is why real FS cars peak at ≈ 1.5–1.9 g.
* Regenerative braking replaces rear friction braking (brake-by-wire blending): regen
  force ≤ rear brake share, motor torque curve and ``regen_max_kw`` at the battery; no
  regen below ``regen_min_speed_kmh`` (FS rules forbid regen below 5 km/h).

Energy is integrated at the accumulator terminals (what ``inv_dc_voltage × inv_dc_current``
measures): ``energy_kwh`` = drive energy − regen energy, so it includes motor, inverter and
driveline losses. Cell internal I²R losses are not included (they appear as heat in the
cells, modelled by the simulator engine).

Known simplifications (worth saying to judges): point mass (no yaw dynamics, so transient
corner entry is idealised), effective (vehicle-level) friction coefficients instead of a
tyre model with load sensitivity and camber, lateral load transfer folded into the
effective μ, constant air density, no gradient (the track is flat).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

import numpy as np

from aerovolt.sim.tracks import Track

G_ACCEL = 9.81
#: Default air density [kg/m³] (ISA sea level at ≈ 20 °C is 1.20).
RHO_DEFAULT = 1.2


# ============================================================================ parameters
@dataclass(frozen=True)
class VehicleParams:
    """Nominal vehicle model used by the lap simulator (built from ``config/vehicle.yaml``)."""

    name: str
    mass_kg: float
    weight_dist_front: float
    cg_height_m: float
    wheelbase_m: float
    wheel_radius_m: float
    cla: float
    cda: float
    aero_balance_front: float
    mu_lat: float
    mu_long: float
    c_rr: float
    brake_force_max_n: float
    brake_bias_front: float
    gear_ratio: float
    driveline_efficiency: float
    power_limit_kw: float
    regen_max_kw: float
    regen_min_speed_ms: float
    motor_peak_torque_nm: float
    motor_peak_power_kw: float
    motor_max_speed_rpm: float
    motor_k_cu: float
    motor_k_iron: float
    motor_k_windage: float
    inverter_efficiency: float
    pack_series: int
    pack_parallel: int
    cell_capacity_ah: float
    cell_v_nom: float
    soc_window_max: float
    soc_window_min: float
    endurance_distance_km: float
    endurance_reserve_pct: float
    raw: Mapping = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, vehicle: Mapping) -> VehicleParams:
        """Build from the ``config/vehicle.yaml`` dictionary (see that file for meanings)."""
        aero = vehicle["aero"]
        pt = vehicle["powertrain"]
        motor = pt["motor"]
        losses = motor["losses"]
        acc = vehicle["accumulator"]
        window = acc["soc_window"]
        return cls(
            name=str(vehicle.get("name", "vehicle")),
            mass_kg=float(vehicle["mass_kg"]),
            weight_dist_front=float(vehicle["weight_dist_front"]),
            cg_height_m=float(vehicle["cg_height_m"]),
            wheelbase_m=float(vehicle["wheelbase_m"]),
            wheel_radius_m=float(vehicle["wheel_radius_m"]),
            cla=float(aero["cla_ref"]),
            cda=float(aero["cda_ref"]),
            aero_balance_front=aero_balance_front(vehicle),
            mu_lat=float(vehicle["tyres"]["mu_lat"]),
            mu_long=float(vehicle["tyres"]["mu_long"]),
            c_rr=float(vehicle["tyres"]["c_rr"]),
            brake_force_max_n=float(vehicle["brakes"]["max_force_n"]),
            brake_bias_front=float(vehicle["brakes"]["bias_front"]),
            gear_ratio=float(pt["gear_ratio"]),
            driveline_efficiency=float(pt["driveline_efficiency"]),
            power_limit_kw=float(pt["power_limit_kw"]),
            regen_max_kw=float(pt["regen_max_kw"]),
            regen_min_speed_ms=float(pt.get("regen_min_speed_kmh", 5.0)) / 3.6,
            motor_peak_torque_nm=float(motor["peak_torque_nm"]),
            motor_peak_power_kw=float(motor["peak_power_kw"]),
            motor_max_speed_rpm=float(motor["max_speed_rpm"]),
            motor_k_cu=float(losses["k_cu_w_per_nm2"]),
            motor_k_iron=float(losses["k_iron_w_per_rads"]),
            motor_k_windage=float(losses["k_windage_w_per_rads2"]),
            inverter_efficiency=float(pt["inverter"]["efficiency"]),
            pack_series=int(acc["series"]),
            pack_parallel=int(acc["parallel"]),
            cell_capacity_ah=float(acc["cell"]["capacity_ah"]),
            cell_v_nom=float(acc["cell"]["v_nom"]),
            soc_window_max=float(window["max"]),
            soc_window_min=float(window["min"]),
            endurance_distance_km=float(vehicle["endurance"]["distance_km"]),
            endurance_reserve_pct=float(vehicle["endurance"]["reserve_pct"]),
            raw=vehicle,
        )

    # ------------------------------------------------------------------ derived values
    @property
    def pack_capacity_ah(self) -> float:
        """Pack charge capacity [Ah] = parallel cells × cell capacity."""
        return self.pack_parallel * self.cell_capacity_ah

    @property
    def pack_nominal_voltage(self) -> float:
        """Pack nominal voltage [V] = series groups × cell nominal voltage."""
        return self.pack_series * self.cell_v_nom

    @property
    def pack_energy_kwh(self) -> float:
        """Nominal pack energy [kWh] = capacity × nominal voltage."""
        return self.pack_capacity_ah * self.pack_nominal_voltage / 1000.0

    @property
    def usable_energy_kwh(self) -> float:
        """Usable energy [kWh] = pack capacity × nominal voltage × SoC window.

        The SoC window (``accumulator.soc_window``) excludes the bottom of the discharge
        curve, where the voltage sags under load and cells would hit the BMS under-voltage
        cut-off. This is the energy budget the endurance strategy works with.
        """
        return self.pack_energy_kwh * (self.soc_window_max - self.soc_window_min)

    @property
    def motor_max_omega(self) -> float:
        """Motor maximum speed [rad/s]."""
        return self.motor_max_speed_rpm * 2.0 * math.pi / 60.0

    @property
    def motor_base_omega(self) -> float:
        """Base speed [rad/s] where constant torque meets constant power: P_peak / T_peak."""
        return self.motor_peak_power_kw * 1000.0 / self.motor_peak_torque_nm

    @property
    def v_motor_max(self) -> float:
        """Road speed [m/s] at the motor's maximum speed: ω_max · r / G."""
        return self.motor_max_omega * self.wheel_radius_m / self.gear_ratio

    def motor_max_torque(self, omega: np.ndarray | float) -> np.ndarray | float:
        """Torque/speed envelope: ``min(T_peak, P_peak/ω)``, zero above the maximum speed."""
        w = np.asarray(omega, dtype=float)
        with np.errstate(divide="ignore"):
            t = np.minimum(self.motor_peak_torque_nm, self.motor_peak_power_kw * 1e3 / np.abs(w))
        t = np.where(np.abs(w) > self.motor_max_omega, 0.0, t)
        return float(t) if np.ndim(t) == 0 else t

    def motor_loss_w(self, torque: np.ndarray | float, omega: np.ndarray | float):
        """Motor losses [W]: copper ``k_cu·T²`` + iron ``k_fe·ω`` + windage ``k_w·ω²``."""
        w = np.abs(omega)
        return self.motor_k_cu * np.square(torque) + self.motor_k_iron * w + self.motor_k_windage * w * w

    def motor_efficiency(self, torque: np.ndarray | float, omega: np.ndarray | float):
        """Motoring efficiency ``T·ω / (T·ω + P_loss)`` (0 where no mechanical power)."""
        p_mech = np.abs(np.asarray(torque, dtype=float) * np.asarray(omega, dtype=float))
        total = p_mech + self.motor_loss_w(torque, omega)
        return np.divide(p_mech, total, out=np.zeros_like(total, dtype=float), where=total > 0)


def aero_balance_front(vehicle: Mapping) -> float:
    """Fraction of total downforce carried by the front axle, from the aero geometry.

    Each element's downforce acts at its centre of pressure ``x_cp`` (vehicle frame: front
    axle at x = 0, rear axle at x = −L). Taking moments about the rear axle, the share that
    reaches the front axle is ``(x_cp + L) / L`` (> 1 for a front wing ahead of the axle,
    < 0 for a rear wing behind the rear axle, which unloads the front). Wings act at their
    quarter chord ``x_le − c/4``; the undertray at ``x_start + cop_frac·(x_end − x_start)``.
    Balance = Σ share_i · (x_cp,i + L)/L.
    """
    aero = vehicle["aero"]
    wb = float(vehicle["wheelbase_m"])
    share = aero["share"]
    fw, rw, ut = aero["front_wing"], aero["rear_wing"], aero["undertray"]
    x_cp = {
        "front_wing": fw["le_x_m"] - 0.25 * fw["chord_m"],
        "rear_wing": rw["le_x_m"] - 0.25 * rw["chord_m"],
        "undertray": ut["x_start_m"] + ut["cop_frac"] * (ut["x_end_m"] - ut["x_start_m"]),
    }
    return float(sum(share[k] * (x_cp[k] + wb) / wb for k in x_cp))


@dataclass(frozen=True)
class Wind:
    """Steady wind: ``speed_ms`` blowing **from** compass direction ``from_deg``."""

    speed_ms: float
    from_deg: float

    @classmethod
    def coerce(cls, wind: Wind | Mapping | None) -> Wind | None:
        """Accept a :class:`Wind`, a mapping ``{"speed": m/s, "dir_deg": from-direction}``,
        or ``None``."""
        if wind is None or isinstance(wind, Wind):
            return wind
        return cls(float(wind["speed"]), float(wind["dir_deg"]))

    def tailwind_component(self, heading_deg: np.ndarray) -> np.ndarray:
        """Component of the wind velocity along the car heading [m/s] (+ = tail wind).

        Wind *from* direction f moves air towards f + 180°, so ``w∥ = −V·cos(h − f)``.
        """
        return -self.speed_ms * np.cos(np.radians(np.asarray(heading_deg) - self.from_deg))


# ============================================================================ result
@dataclass(frozen=True, eq=False)
class LapResult:
    """Output of :func:`solve`. Arrays are per track sample (same length as ``track.s``)."""

    track_name: str
    closed: bool
    s: np.ndarray            # distance [m]
    v: np.ndarray            # speed [m/s]
    ax: np.ndarray           # longitudinal acceleration [m/s²] (+ = accelerating)
    ay: np.ndarray           # lateral acceleration [m/s²] (+ = to the left)
    t: np.ndarray            # time since the start line [s]
    power_kw: np.ndarray     # battery-side electrical power [kW] (negative = regen)
    motor_torque_nm: np.ndarray  # motor shaft torque [Nm] (negative = regen)
    motor_rpm: np.ndarray    # motor speed [rpm]
    brake_force_n: np.ndarray    # friction-brake force at the tyres [N]
    downforce_n: np.ndarray  # total downforce [N]
    drag_n: np.ndarray       # aerodynamic drag along the car [N]
    lap_time: float          # [s]
    energy_kwh: float        # net battery energy (drive − regen) [kWh]
    regen_kwh: float         # energy recovered by regen [kWh]
    v_max: float             # [m/s]
    power_limit_kw: float    # accumulator power limit used [kW]

    def time_at(self, s: float) -> float:
        """Elapsed time [s] when the car reaches distance ``s`` (e.g. the 75 m accel line)."""
        return float(np.interp(s, self.s, self.t))

    def summary(self) -> dict:
        """JSON-friendly scalar summary."""
        return {
            "track": self.track_name,
            "lap_time": round(self.lap_time, 3),
            "energy_kwh": round(self.energy_kwh, 4),
            "regen_kwh": round(self.regen_kwh, 4),
            "v_max": round(self.v_max, 2),
            "power_limit_kw": self.power_limit_kw,
            "ay_max_g": round(float(np.max(np.abs(self.ay))) / G_ACCEL, 3),
            "ax_min_g": round(float(np.min(self.ax)) / G_ACCEL, 3),
            "ax_max_g": round(float(np.max(self.ax)) / G_ACCEL, 3),
        }


# ============================================================================ solver
def solve(
    track: Track,
    params: VehicleParams,
    power_limit_kw: float | None = None,
    aero_scale: Mapping[str, float] | None = None,
    mu_scale: float = 1.0,
    rho: float = RHO_DEFAULT,
    wind: Wind | Mapping | None = None,
) -> LapResult:
    """Quasi-steady-state lap of ``track`` (see the module docstring for the method).

    Parameters
    ----------
    power_limit_kw
        Accumulator (battery-side) power limit; ``None`` uses ``params.power_limit_kw``.
    aero_scale
        Multipliers ``{"cla_front": …, "cla_rear": …, "cda": …}`` on the nominal front /
        rear CL·A and on CD·A (missing keys = 1.0) — e.g. a damaged front wing or a stalled
        rear wing in the strategy predictions.
    mu_scale
        Multiplier on both tyre friction coefficients (wet / cold tyres).
    rho
        Air density [kg/m³].
    wind
        Steady wind (:class:`Wind` or ``{"speed": m/s, "dir_deg": from-direction}``).
    """
    p_lim_w = 1e3 * (params.power_limit_kw if power_limit_kw is None else float(power_limit_kw))
    scale = {"cla_front": 1.0, "cla_rear": 1.0, "cda": 1.0}
    unknown = set(aero_scale or {}) - set(scale)
    if unknown:
        raise ValueError(f"unknown aero_scale keys {sorted(unknown)}; use {sorted(scale)}")
    scale.update(aero_scale or {})
    m = params.mass_kg
    wf = params.weight_dist_front
    mu_lat = params.mu_lat * mu_scale
    mu_long = params.mu_long * mu_scale
    k_lf = 0.5 * rho * params.cla * params.aero_balance_front * scale["cla_front"]
    k_lr = 0.5 * rho * params.cla * (1.0 - params.aero_balance_front) * scale["cla_rear"]
    k_l = k_lf + k_lr
    k_d = 0.5 * rho * params.cda * scale["cda"]

    n = len(track.s)
    ds = track.ds
    kappa = np.asarray(track.kappa, dtype=float)
    wind_obj = Wind.coerce(wind)
    if wind_obj is None or wind_obj.speed_ms == 0.0:
        w_par = np.zeros(n)
        w2 = 0.0
    else:
        w_par = wind_obj.tailwind_component(track.heading)
        w2 = wind_obj.speed_ms**2

    # ---- 1. cornering limit, per axle (vectorised) --------------------------------------
    abs_k = np.abs(kappa)
    v_cap = np.full(n, params.v_motor_max)
    for f_axle, k_axle in ((wf, k_lf), (1.0 - wf, k_lr)):
        v_cap = np.minimum(v_cap, _axle_corner_speed(abs_k, f_axle, k_axle, m, mu_lat, w_par, w2))

    # ---- 2./3. forward and backward passes ---------------------------------------------
    if track.closed:
        start = int(np.argmin(v_cap))
        order = np.roll(np.arange(n), -start)
        v_start = v_end = float(v_cap[start])
    else:
        order = np.arange(n)
        v_start = v_end = 0.0
    caps = v_cap[order].tolist()
    k_list = kappa[order].tolist()
    wp_list = w_par[order].tolist()
    if track.closed:  # the lap ends where it started
        caps.append(caps[0])
        k_list.append(k_list[0])
        wp_list.append(wp_list[0])

    consts = _PassConstants(params, m, wf, mu_lat, mu_long, k_l, k_lr, k_d, w2, p_lim_w)
    v_fwd = _forward_pass(caps, k_list, wp_list, ds, v_start, consts)
    v_bwd = _backward_pass(caps, k_list, wp_list, ds, v_end, consts)
    v_ordered = np.minimum(v_fwd, v_bwd)

    if track.closed:
        v_loop = v_ordered[:-1]
        v = np.empty(n)
        v[order] = v_loop
        v_next = np.roll(v, -1)
    else:
        v = v_ordered
        v_next = np.append(v[1:], v[-1])

    # ---- derived channels (vectorised) -------------------------------------------------
    v_sum = v + v_next
    dt_seg = np.divide(2.0 * ds, v_sum, out=np.zeros(n), where=v_sum > 0)
    if not track.closed:
        dt_seg[-1] = 0.0
    t = np.concatenate(([0.0], np.cumsum(dt_seg)[:-1]))
    lap_time = float(np.sum(dt_seg))
    ax = (v_next**2 - v**2) / (2.0 * ds)
    if not track.closed:
        ax[-1] = ax[-2]
    ay = v**2 * kappa

    v_air2 = np.maximum(v**2 - 2.0 * v * w_par + w2, 0.0)
    downforce = k_l * v_air2
    drag = k_d * np.sqrt(v_air2) * (v - w_par)
    rolling = params.c_rr * (m * G_ACCEL + downforce)
    f_x = m * ax + drag + rolling  # total longitudinal tyre force needed (+ drive, − brake)

    power_w, torque, f_regen = _battery_power(params, v, f_x, p_lim_w)
    brake_force = np.maximum(-f_x, 0.0) - f_regen
    omega = v * params.gear_ratio / params.wheel_radius_m

    p_next = np.roll(power_w, -1) if track.closed else np.append(power_w[1:], power_w[-1])
    e_seg = 0.5 * (power_w + p_next) * dt_seg
    regen_seg = 0.5 * (np.minimum(power_w, 0.0) + np.minimum(p_next, 0.0)) * dt_seg

    for arr in (v, ax, ay, t, power_w, torque, omega, brake_force, downforce, drag):
        arr.setflags(write=False)
    return LapResult(
        track_name=track.name,
        closed=track.closed,
        s=track.s,
        v=v,
        ax=ax,
        ay=ay,
        t=t,
        power_kw=power_w / 1e3,
        motor_torque_nm=torque,
        motor_rpm=omega * 60.0 / (2.0 * math.pi),
        brake_force_n=np.maximum(brake_force, 0.0),
        downforce_n=downforce,
        drag_n=drag,
        lap_time=lap_time,
        energy_kwh=float(np.sum(e_seg)) / 3.6e6,
        regen_kwh=abs(float(np.sum(regen_seg))) / 3.6e6,
        v_max=float(np.max(v)),
        power_limit_kw=p_lim_w / 1e3,
    )


def energy_vs_power(
    track: Track, params: VehicleParams, limits_kw: Iterable[float], **solve_kwargs
) -> list[dict]:
    """Lap time and net energy per lap for each accumulator power limit.

    Returns ``[{"kw": 40.0, "lap_time": 68.1, "energy_kwh": 0.29}, ...]`` — the curve the
    endurance strategy uses to pick the highest power limit that still finishes.
    Extra keyword arguments are passed to :func:`solve` (``aero_scale``, ``rho`` …).
    """
    curve = []
    for kw in limits_kw:
        res = solve(track, params, power_limit_kw=float(kw), **solve_kwargs)
        curve.append(
            {"kw": float(kw), "lap_time": res.lap_time, "energy_kwh": res.energy_kwh}
        )
    return curve


# ============================================================================ internals
def _axle_corner_speed(
    abs_k: np.ndarray,
    f_axle: float,
    k_axle: float,
    m: float,
    mu: float,
    w_par: np.ndarray,
    w2: float,
) -> np.ndarray:
    """Largest speed at which one axle holds the corner (see module docstring).

    Solves ``A v² + B v + C = 0`` with ``A = f m |κ| − μ k``, ``B = 2 μ k w∥``,
    ``C = −μ (f m g + k w²)`` (``k = ½ρ CL·A`` of that axle). ``A ≤ 0`` → unlimited.
    """
    a = f_axle * m * abs_k - mu * k_axle
    b = 2.0 * mu * k_axle * w_par
    c = -mu * (f_axle * m * G_ACCEL + k_axle * w2)
    disc = np.maximum(b * b - 4.0 * a * c, 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (-b + np.sqrt(disc)) / (2.0 * a)
    return np.where(a > 1e-12, v, np.inf)


@dataclass(frozen=True)
class _PassConstants:
    """Scalars hoisted out of the forward/backward loops (plain floats for speed)."""

    params: VehicleParams
    m: float
    wf: float
    mu_lat: float
    mu_long: float
    k_l: float
    k_lr: float
    k_d: float
    w2: float
    p_lim_w: float


def _forward_pass(
    caps: list[float], kappa: list[float], w_par: list[float], ds: float, v0: float,
    c: _PassConstants,
) -> np.ndarray:
    """Acceleration pass: ``v_{i+1}² = v_i² + 2·a_x(v_i)·Δs``, clipped to the cornering limit.

    The recurrence is inherently sequential (each step needs the previous speed), so it is a
    tight scalar loop over plain floats; everything that can be is precomputed vectorised.
    """
    p = c.params
    m, g = c.m, G_ACCEL
    h_over_l = p.cg_height_m / p.wheelbase_m
    f_rear_static = (1.0 - c.wf) * m * g
    gear_r = p.gear_ratio / p.wheel_radius_m          # ω = v · G / r
    wheel_per_nm = gear_r * p.driveline_efficiency    # F = T · G · η / r
    t_peak = p.motor_peak_torque_nm
    p_peak = p.motor_peak_power_kw * 1e3
    w_max = p.motor_max_omega
    k_cu, k_fe, k_w = p.motor_k_cu, p.motor_k_iron, p.motor_k_windage
    eta_p_lim = p.inverter_efficiency * c.p_lim_w
    out = [0.0] * len(caps)
    v = min(v0, caps[0])
    out[0] = v
    for i in range(len(caps) - 1):
        va2 = v * v - 2.0 * v * w_par[i] + c.w2
        if va2 < 0.0:
            va2 = 0.0
        drag = c.k_d * math.sqrt(va2) * (v - w_par[i])
        roll = p.c_rr * (m * g + c.k_l * va2)
        # rear-axle traction with the friction ellipse and longitudinal load transfer
        f_zr0 = f_rear_static + c.k_lr * va2
        ratio = (1.0 - c.wf) * m * v * v * abs(kappa[i]) / (c.mu_lat * f_zr0)
        ell = math.sqrt(1.0 - ratio * ratio) if ratio < 1.0 else 0.0
        mu_e = c.mu_long * ell
        f_traction = mu_e * (f_zr0 - (drag + roll) * h_over_l) / (1.0 - mu_e * h_over_l)
        # motor envelope and accumulator power limit (battery side)
        omega = v * gear_r
        if omega >= w_max:
            torque = 0.0
        else:
            torque = t_peak if omega * t_peak <= p_peak else p_peak / omega
            rest = eta_p_lim - k_fe * omega - k_w * omega * omega
            if rest <= 0.0:
                torque = 0.0
            else:
                t_pow = (-omega + math.sqrt(omega * omega + 4.0 * k_cu * rest)) / (2.0 * k_cu)
                if t_pow < torque:
                    torque = t_pow
        f_drive = min(torque * wheel_per_nm, f_traction)
        a = (f_drive - drag - roll) / m
        v2 = v * v + 2.0 * a * ds
        v = math.sqrt(v2) if v2 > 0.0 else 0.0
        if v > caps[i + 1]:
            v = caps[i + 1]
        out[i + 1] = v
    return np.asarray(out)


def _backward_pass(
    caps: list[float], kappa: list[float], w_par: list[float], ds: float, v_end: float,
    c: _PassConstants,
) -> np.ndarray:
    """Braking pass run from the end backwards: ``v_i² = v_{i+1}² + 2·d·Δs``.

    Predictor–corrector: the deceleration ``d`` is evaluated at the known end of the step
    (``v_{i+1}``, ``κ_{i+1}``) and again at the predicted start (``v_i``, ``κ_i``), and the
    smaller is used. Without the corrector the friction ellipse would be violated where the
    curvature builds up quickly on corner entry (the explicit step would only see the
    lower curvature downstream).
    """
    p = c.params
    m, g = c.m, G_ACCEL
    f_brake_max = p.brake_force_max_n

    def decel(v: float, k: float, wp: float) -> float:
        va2 = v * v - 2.0 * v * wp + c.w2
        if va2 < 0.0:
            va2 = 0.0
        f_z = m * g + c.k_l * va2
        drag = c.k_d * math.sqrt(va2) * (v - wp)
        ratio = m * v * v * abs(k) / (c.mu_lat * f_z)
        ell = math.sqrt(1.0 - ratio * ratio) if ratio < 1.0 else 0.0
        f_brake = min(c.mu_long * ell * f_z, f_brake_max)
        return (f_brake + drag + p.c_rr * f_z) / m

    out = [0.0] * len(caps)
    v = min(v_end, caps[-1])
    out[-1] = v
    for i in range(len(caps) - 1, 0, -1):
        v2_pred = v * v + 2.0 * decel(v, kappa[i], w_par[i]) * ds
        v_pred = min(math.sqrt(v2_pred) if v2_pred > 0.0 else 0.0, caps[i - 1])
        d = min(decel(v, kappa[i], w_par[i]), decel(v_pred, kappa[i - 1], w_par[i - 1]))
        v2 = v * v + 2.0 * d * ds
        v = math.sqrt(v2) if v2 > 0.0 else 0.0
        if v > caps[i - 1]:
            v = caps[i - 1]
        out[i - 1] = v
    return np.asarray(out)


def _battery_power(
    p: VehicleParams, v: np.ndarray, f_x: np.ndarray, p_lim_w: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Battery power [W], motor torque [Nm] and regen force at the tyres [N] (vectorised).

    Motoring (``F_x > 0``): ``T = F_x·r / (G·η_dl)``, ``P = (T·ω + P_loss(T, ω)) / η_inv``.
    Braking (``F_x < 0``): the rear share of the brake force is recovered, limited by the
    motor torque curve; ``P = −(T·ω − P_loss)·η_inv`` with ``T = F·r·η_dl / G``, capped at
    ``regen_max_kw`` and zero below the regen cut-off speed.
    """
    r, gr, eta_dl = p.wheel_radius_m, p.gear_ratio, p.driveline_efficiency
    omega = v * gr / r
    t_env = np.asarray(p.motor_max_torque(omega), dtype=float)

    drive = np.maximum(f_x, 0.0)
    t_drive = drive * r / (gr * eta_dl)
    p_drive = np.where(drive > 0.0, (t_drive * omega + p.motor_loss_w(t_drive, omega)), 0.0)
    p_drive = np.minimum(p_drive / p.inverter_efficiency, p_lim_w)

    brake = np.maximum(-f_x, 0.0)
    f_regen = (1.0 - p.brake_bias_front) * brake
    t_regen = np.minimum(f_regen * r * eta_dl / gr, t_env)
    p_gen = (t_regen * omega - p.motor_loss_w(t_regen, omega)) * p.inverter_efficiency
    p_gen = np.where((v >= p.regen_min_speed_ms) & (brake > 0.0), np.maximum(p_gen, 0.0), 0.0)
    p_regen = np.minimum(p_gen, p.regen_max_kw * 1e3)
    # regen force actually delivered (scaled back where torque or power limits bite)
    f_regen_tyre = np.divide(
        t_regen * gr / (r * eta_dl) * p_regen,
        p_gen,
        out=np.zeros_like(p_gen),
        where=p_gen > 0.0,
    )
    torque = np.where(drive > 0.0, t_drive, -np.divide(
        f_regen_tyre * r * eta_dl, gr, out=np.zeros_like(v)))
    return p_drive - p_regen, torque, f_regen_tyre
