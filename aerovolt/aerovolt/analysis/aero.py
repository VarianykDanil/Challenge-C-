"""Aerodynamic analysis: air data, pressure coefficients, downforce, drag and their coefficients.

This module turns the raw aero and chassis sensors into the numbers an aerodynamicist
looks at on the pit wall (SPEC section 6, ``aero.py``). It has two layers:

* **Pure functions** (no state, NaN in -> NaN out) for every formula, so each step can be
  unit-tested and explained on its own.
* :class:`AeroEstimator` - a small stateful wrapper called once per processing tick. It
  chains the functions and owns the *documented first-order low-pass filters* that turn
  noisy instantaneous forces into stable coefficients (CL·A, CD·A, aero balance).

Air data
--------
* Air density from the ambient sensor (moist air, :func:`physics.moist_air_density`).
* Dynamic pressure ``q`` from the pitot-static tube (``pitot_dp`` = total - static).
  If the pitot is missing - or the alert engine has flagged it implausible (e.g. blocked)
  - ``q`` falls back to ``1/2 rho v_gps^2``: ground speed instead of airspeed, so wind
  makes it less accurate. ``q_source`` records which one was used.
* Airspeed ``v = sqrt(2 q / rho)`` (Bernoulli).

Pressure coefficients and section lift
--------------------------------------
Each tap measures ``p_local - p_static`` so ``Cp = tap / q``. Below ``q = 60 Pa`` (about
10 m/s) the taps' +-1.5 Pa noise is several percent of q, so Cp is reported as NaN.
Each wing station's sectional downforce coefficient is the chordwise integral of the
pressure difference between the surfaces (:func:`physics.section_cl`).

Downforce from the pushrods
---------------------------
Pushrod load cells measure the sprung load at each corner; :func:`axle_loads` turns them
into tyre loads (``F_wheel = F_pushrod / ratio + m_unsprung g``). The axle sums contain,
besides downforce:

* the car's weight, scaled by the vertical specific force ``a_z`` measured by the IMU
  (``a_z`` = +g at rest; bumps and crests change it): axle share ``f_axle m a_z``;
* longitudinal load transfer ``dF = m a_x h_cg / L`` (accelerating unloads the front).

*Lateral* load transfer ``m a_y h / t`` only moves load from the inside to the outside wheel
**of the same axle**; it cancels in each axle sum, so cornering needs no correction
(this is why downforce is computed per axle, never per wheel)::

    L_front = F_fl + F_fr - f_front m a_z + m a_x h_cg / L
    L_rear  = F_rl + F_rr - f_rear  m a_z - m a_x h_cg / L

Known simplification: the drag force acts above the ground, so its pitching moment adds
``D h_drag / L`` of apparent load to the rear axle. Drag and downforce both scale with q,
so this is a constant offset of the balance (a fraction of a percent per 0.1 m of drag
height), not something that changes with speed.

Coefficients and filtering
--------------------------
``CL·A = L / q`` and ``CD·A = D / q``. Instantaneous values are noisy (pushrod and IMU
noise, road bumps) and meaningless at low speed, so the coefficients are updated only
when ``q > 120 Pa`` (about 14 m/s, where downforce is ~ 430 N and the pushrod noise is a
few percent) and filtered with first-order low-pass filters (:class:`LowPass`). Numerator
and denominator are filtered separately and then divided, i.e. ``CL·A = LP(L) / LP(q)``:
this is a *q-weighted* average, so fast (accurate) samples count more than slow ones.

Drag from the longitudinal force balance, only while the car is driven (brakes released,
motor torque >= 0, ``q > 120 Pa``), roughly straight (``|a_y| < 4 m/s^2``: in corners the
tyres' slip angles add induced drag that is not aerodynamic)::

    F_drive = T_motor G eta_driveline / r_wheel
    D       = F_drive - m a_x - C_rr (m g + L)

Known simplifications: rotating inertia of wheels and motor is not included in ``m``
(it adds ~3-5 % effective mass under acceleration), and ``a_x`` from the IMU includes a
``g sin(pitch)`` component when the chassis pitches.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np

from aerovolt.core import physics
from aerovolt.core.catalog import Catalog

NAN = float("nan")

#: Below this dynamic pressure Cp is not computed (tap noise would dominate), Pa.
Q_CP_MIN_PA = 60.0
#: Below this dynamic pressure CL·A, CD·A and balance are not updated, Pa.
Q_COEFF_MIN_PA = 120.0
#: Brake line pressure below which the brakes count as released, bar (residual ~1 bar).
BRAKE_RELEASED_BAR = 3.0
#: CL·A and balance are not updated beyond this |a_x|, m/s^2 (~1.2 g: heavy braking, where
#: pitch dynamics and brake dive make the quasi-static load-transfer correction unreliable;
#: normal hairpin exits at ~1 g are kept).
MAX_ABS_AX_FOR_DOWNFORCE = 12.0
#: CD·A is only updated while |a_y| is below this (cornering adds tyre-induced drag), m/s^2.
MAX_ABS_AY_FOR_DRAG = 4.0
#: Air density used for airspeed / GPS-based q when the ambient sensor is missing, kg/m^3.
RHO_FALLBACK = 1.2
#: Relative humidity assumed when only the humidity sensor is missing, %.
RH_FALLBACK_PCT = 50.0

#: Low-pass time constants, s (see the module docstring for why each exists).
TAU_DOWNFORCE_S = 0.2  # instantaneous downforce: removes pushrod noise, keeps bumps
TAU_DRAG_S = 0.5  # instantaneous drag: removes IMU a_x noise
TAU_CLA_S = 2.0  # CL·A and the front/rear split (balance)
TAU_CDA_S = 4.0  # CD·A (drag is a small difference of large forces: average longer)
TAU_SECTION_CL_S = 1.0  # section Cl used for the left/right asymmetry
TAU_YAW_S = 0.5  # |flow yaw| used to decide whether the flow is "straight"

#: Wing stations with a section Cl channel: key -> (element, station).
WING_STATIONS: dict[str, tuple[str, str]] = {
    "fw_l": ("fw", "L"),
    "fw_r": ("fw", "R"),
    "rw_l": ("rw", "L"),
    "rw_r": ("rw", "R"),
}


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------


def finite(x: float | None) -> bool:
    """True if ``x`` is a real, finite number."""
    return x is not None and isinstance(x, (int, float, np.floating)) and math.isfinite(x)


class LowPass:
    """First-order low-pass filter (exponential moving average in continuous time).

    Discretisation of ``tau dy/dt = x - y`` for a sample held over ``dt``::

        alpha = 1 - exp(-dt / tau)
        y    += alpha (x - y)

    Using ``exp`` makes the filter correct for any (irregular) ``dt``: after ``tau`` seconds
    a step input has reached 63 %, after ``3 tau`` 95 %. NaN inputs are ignored (the output
    holds), and the first finite input initialises the output.
    """

    def __init__(self, tau_s: float) -> None:
        if tau_s <= 0:
            raise ValueError("tau_s must be > 0")
        self.tau_s = float(tau_s)
        self.value = NAN

    def update(self, x: float, dt: float) -> float:
        if not finite(x):
            return self.value
        if not math.isfinite(self.value) or dt <= 0.0:
            if not math.isfinite(self.value):
                self.value = float(x)
            return self.value
        alpha = 1.0 - math.exp(-dt / self.tau_s)
        self.value += alpha * (float(x) - self.value)
        return self.value

    def reset(self) -> None:
        self.value = NAN


# --------------------------------------------------------------------------------------
# Air data
# --------------------------------------------------------------------------------------


def air_density(t_c: float, p_pa: float, rh_pct: float) -> float:
    """Moist-air density from the ambient sensor, kg/m^3 (NaN if T or p is missing).

    A missing humidity reading is replaced by 50 % RH: humidity changes density by at
    most ~1 % at race-track temperatures, so the estimate stays useful.
    """
    if not (finite(t_c) and finite(p_pa)):
        return NAN
    rh = rh_pct if finite(rh_pct) else RH_FALLBACK_PCT
    return float(physics.moist_air_density(t_c, p_pa, rh))


def dynamic_pressure(pitot_dp: float, gps_speed: float, rho: float, pitot_ok: bool = True) -> tuple[float, str]:
    """Dynamic pressure ``q`` (Pa) and where it came from: ``'pitot'``, ``'gps'`` or ``'none'``.

    The pitot measures ``q`` directly (``p_total - p_static``), including the effect of
    wind. When it is missing or flagged implausible (``pitot_ok=False``), ``q`` is estimated
    from ground speed, ``q = 1/2 rho v_gps^2``: wind then makes it wrong by
    ``(v_air / v_ground)^2`` (+-30 % at 20 m/s with 3 m/s of wind), so coefficients
    learned from it are treated with care by the anomaly detector. A slightly negative
    pitot reading at standstill (zero offset) is clamped to 0.
    """
    if pitot_ok and finite(pitot_dp):
        return max(0.0, float(pitot_dp)), "pitot"
    if finite(gps_speed):
        r = rho if finite(rho) else RHO_FALLBACK
        return float(physics.dynamic_pressure(r, gps_speed)), "gps"
    return NAN, "none"


def airspeed(q: float, rho: float) -> float:
    """Airspeed from dynamic pressure, m/s (``sqrt(2 q / rho)``; fallback density if needed)."""
    if not finite(q):
        return NAN
    r = rho if finite(rho) else RHO_FALLBACK
    return float(physics.airspeed_from_q(q, r))


# --------------------------------------------------------------------------------------
# Pressure taps
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StationTaps:
    """Tap indices (into :class:`TapLayout` order) of one wing station, sorted by x/c."""

    suction: tuple[int, ...]
    pressure: tuple[int, ...]
    xc_suction: tuple[float, ...]
    xc_pressure: tuple[float, ...]


@dataclass(frozen=True)
class TapLayout:
    """Geometry of every pressure tap, built from the catalogue's tap ``meta``.

    ``neighbours[i]`` are the taps that should respond *together* with tap ``i`` to a real
    flow change (used by the anomaly classifier): taps on the same element and surface
    that are adjacent along the chord at the same station, and - for the undertray - an
    off-centre tunnel tap and the centreline tap at the closest floor position.
    """

    ids: tuple[str, ...]
    element: tuple[str, ...]
    station: tuple[str, ...]
    surface: tuple[str, ...]
    x_c: np.ndarray
    stations: dict[str, StationTaps] = field(default_factory=dict)
    undertray: tuple[int, ...] = ()
    neighbours: tuple[tuple[int, ...], ...] = ()

    @classmethod
    def from_catalog(cls, catalog: Catalog) -> TapLayout:
        taps = catalog.taps()
        ids = tuple(ch.id for ch in taps)
        element = tuple(str(ch.meta.get("element", "")) for ch in taps)
        station = tuple(str(ch.meta.get("station", "")) for ch in taps)
        surface = tuple(str(ch.meta.get("surface", "")) for ch in taps)
        x_c = np.array([float(ch.meta.get("x_c", NAN)) for ch in taps])

        stations: dict[str, StationTaps] = {}
        for key, (el, st) in WING_STATIONS.items():
            suc = sorted((i for i in range(len(ids)) if element[i] == el and station[i] == st
                          and surface[i] == "suction"), key=lambda i: x_c[i])
            pre = sorted((i for i in range(len(ids)) if element[i] == el and station[i] == st
                          and surface[i] == "pressure"), key=lambda i: x_c[i])
            if suc and pre:
                stations[key] = StationTaps(tuple(suc), tuple(pre),
                                            tuple(float(x_c[i]) for i in suc),
                                            tuple(float(x_c[i]) for i in pre))
        undertray = tuple(i for i in range(len(ids)) if element[i] == "ut")
        neighbours = _tap_neighbours(element, station, surface, x_c)
        return cls(ids, element, station, surface, x_c, stations, undertray, neighbours)

    def __len__(self) -> int:
        return len(self.ids)

    def index(self, tap_id: str) -> int:
        return self.ids.index(tap_id)


def _tap_neighbours(element: Sequence[str], station: Sequence[str], surface: Sequence[str],
                    x_c: np.ndarray) -> tuple[tuple[int, ...], ...]:
    """Neighbour lists (see :class:`TapLayout`)."""
    n = len(element)
    nb: list[set[int]] = [set() for _ in range(n)]
    groups: dict[tuple[str, str, str], list[int]] = {}
    for i in range(n):
        groups.setdefault((element[i], station[i], surface[i]), []).append(i)
    for members in groups.values():  # chordwise neighbours within one station and surface
        members.sort(key=lambda i: x_c[i])
        for a, b in zip(members, members[1:]):
            nb[a].add(b)
            nb[b].add(a)
    for i in range(n):  # off-centre floor taps <-> nearest centreline tap
        if surface[i] != "floor" or station[i] == "C":
            continue
        centre = [j for j in range(n) if element[j] == element[i] and surface[j] == "floor" and station[j] == "C"]
        if centre:
            j = min(centre, key=lambda k: abs(x_c[k] - x_c[i]))
            nb[i].add(j)
            nb[j].add(i)
    return tuple(tuple(sorted(s)) for s in nb)


def pressure_coefficients(tap_pa: np.ndarray, q: float, q_min: float = Q_CP_MIN_PA) -> np.ndarray:
    """``Cp = tap / q`` for every tap; all NaN when ``q`` is missing or below ``q_min``."""
    taps = np.asarray(tap_pa, dtype=float)
    if not finite(q) or q <= q_min:
        return np.full(taps.shape, NAN)
    return taps / q


def station_cl(layout: TapLayout, cp: np.ndarray, key: str) -> float:
    """Sectional downforce coefficient of wing station ``key`` (``'fw_l'`` ...).

    Taps that are NaN (missing, or excluded as faulty by the anomaly detector) are
    skipped by :func:`physics.section_cl`, which interpolates across the gap.
    """
    st = layout.stations.get(key)
    if st is None:
        return NAN
    return physics.section_cl(st.xc_suction, cp[list(st.suction)], st.xc_pressure, cp[list(st.pressure)])


def undertray_mean_cp(layout: TapLayout, cp: np.ndarray) -> float:
    """Mean Cp of the undertray taps (negative = suction), NaN if none is valid."""
    vals = cp[list(layout.undertray)] if layout.undertray else np.empty(0)
    vals = vals[np.isfinite(vals)]
    return float(np.mean(vals)) if vals.size else NAN


def fw_asymmetry_pct(cl_left: float, cl_right: float, min_mean: float = 0.2) -> float:
    """Front-wing left/right asymmetry ``(Cl_L - Cl_R) / mean(Cl_L, Cl_R) * 100``, %.

    Negative = the left station makes less downforce. NaN while the mean is below
    ``min_mean`` (the ratio is meaningless when the wing barely works).
    """
    if not (finite(cl_left) and finite(cl_right)):
        return NAN
    mean = 0.5 * (cl_left + cl_right)
    if mean < min_mean:
        return NAN
    return (cl_left - cl_right) / mean * 100.0


# --------------------------------------------------------------------------------------
# Chassis: loads, downforce, drag
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ChassisParams:
    """Nominal vehicle numbers the force balances need (from ``config/vehicle.yaml``)."""

    mass_kg: float = 300.0
    weight_dist_front: float = 0.47
    cg_height_m: float = 0.28
    wheelbase_m: float = 1.53
    wheel_radius_m: float = 0.228
    unsprung_kg_corner: float = 9.0
    pushrod_ratio_front: float = 1.15
    pushrod_ratio_rear: float = 1.10
    gear_ratio: float = 3.8
    driveline_efficiency: float = 0.95
    c_rr: float = 0.015

    @classmethod
    def from_vehicle(cls, vehicle: Mapping[str, Any]) -> ChassisParams:
        susp = vehicle.get("suspension", {})
        ratio = susp.get("pushrod_ratio", {})
        pt = vehicle.get("powertrain", {})
        d = cls()
        return cls(
            mass_kg=float(vehicle.get("mass_kg", d.mass_kg)),
            weight_dist_front=float(vehicle.get("weight_dist_front", d.weight_dist_front)),
            cg_height_m=float(vehicle.get("cg_height_m", d.cg_height_m)),
            wheelbase_m=float(vehicle.get("wheelbase_m", d.wheelbase_m)),
            wheel_radius_m=float(vehicle.get("wheel_radius_m", d.wheel_radius_m)),
            unsprung_kg_corner=float(vehicle.get("unsprung_mass_corner_kg", d.unsprung_kg_corner)),
            pushrod_ratio_front=float(ratio.get("front", d.pushrod_ratio_front)),
            pushrod_ratio_rear=float(ratio.get("rear", d.pushrod_ratio_rear)),
            gear_ratio=float(pt.get("gear_ratio", d.gear_ratio)),
            driveline_efficiency=float(pt.get("driveline_efficiency", d.driveline_efficiency)),
            c_rr=float(vehicle.get("tyres", {}).get("c_rr", d.c_rr)),
        )


def axle_loads(pushrods: Sequence[float], p: ChassisParams) -> tuple[float, float]:
    """Front and rear axle tyre loads (N) from the four pushrod forces ``[fl, fr, rl, rr]``.

    ``F_wheel = F_pushrod / ratio + m_unsprung g`` (:func:`physics.wheel_load_from_pushrod`).
    An axle with a missing pushrod gives NaN.
    """
    fl, fr, rl, rr = (float(x) for x in pushrods)
    front = (physics.wheel_load_from_pushrod(fl, p.pushrod_ratio_front, p.unsprung_kg_corner)
             + physics.wheel_load_from_pushrod(fr, p.pushrod_ratio_front, p.unsprung_kg_corner))
    rear = (physics.wheel_load_from_pushrod(rl, p.pushrod_ratio_rear, p.unsprung_kg_corner)
            + physics.wheel_load_from_pushrod(rr, p.pushrod_ratio_rear, p.unsprung_kg_corner))
    return float(front), float(rear)


def downforce_from_axle_loads(front_n: float, rear_n: float, ax: float, az: float,
                              p: ChassisParams) -> tuple[float, float]:
    """Aerodynamic downforce on the front and rear axle, N (see the module docstring).

    ``L_front = F_front - f_front m a_z + m a_x h / L`` and
    ``L_rear  = F_rear  - f_rear  m a_z - m a_x h / L``. A missing ``a_z`` is taken as g
    (flat track); a missing ``a_x`` makes the per-axle split unknown (NaN) because the
    longitudinal load transfer cannot be removed.
    """
    a_z = az if finite(az) else physics.G
    if not finite(ax):
        return NAN, NAN
    m = p.mass_kg
    transfer = m * ax * p.cg_height_m / p.wheelbase_m
    l_front = front_n - p.weight_dist_front * m * a_z + transfer
    l_rear = rear_n - (1.0 - p.weight_dist_front) * m * a_z - transfer
    return float(l_front), float(l_rear)


def total_downforce(front_n: float, rear_n: float, az: float, p: ChassisParams) -> float:
    """Total downforce ``L = F_front + F_rear - m a_z``, N (needs no ``a_x``)."""
    a_z = az if finite(az) else physics.G
    return float(front_n + rear_n - p.mass_kg * a_z)


def drive_force(torque_nm: float, p: ChassisParams) -> float:
    """Tractive force at the tyres from motor torque: ``F = T G eta / r``, N."""
    return float(torque_nm) * p.gear_ratio * p.driveline_efficiency / p.wheel_radius_m


def aero_drag(torque_nm: float, ax: float, downforce_n: float, p: ChassisParams) -> float:
    """Aerodynamic drag from the longitudinal force balance, N.

    ``D = F_drive - m a_x - C_rr (m g + L)``: the drive force not spent on accelerating the
    car or on rolling resistance (which grows with downforce) is fighting the air.
    Only meaningful while the car is driven (motor torque >= 0, brakes released).
    """
    if not (finite(torque_nm) and finite(ax)):
        return NAN
    lift = downforce_n if finite(downforce_n) else 0.0
    rolling = p.c_rr * (p.mass_kg * physics.G + lift)
    return drive_force(torque_nm, p) - p.mass_kg * ax - rolling


def fit_cla(q: Sequence[float], downforce_n: Sequence[float]) -> float:
    """Least-squares CL·A (m^2) of the "downforce vs q" aero map, line through the origin.

    Model ``L = CL·A * q``; minimising ``sum (L_i - k q_i)^2`` gives
    ``k = sum(q_i L_i) / sum(q_i^2)``. The fit is forced through the origin because there
    is no downforce without airflow. Pairs with a NaN are ignored; NaN if nothing is left.
    """
    qq = np.asarray(q, dtype=float)
    ff = np.asarray(downforce_n, dtype=float)
    ok = np.isfinite(qq) & np.isfinite(ff)
    denom = float(np.sum(qq[ok] ** 2))
    if denom <= 0.0:
        return NAN
    return float(np.sum(qq[ok] * ff[ok]) / denom)


# --------------------------------------------------------------------------------------
# Stateful estimator
# --------------------------------------------------------------------------------------


@dataclass
class AeroOutput:
    """Result of one :meth:`AeroEstimator.update`.

    ``channels`` holds every aero ``calc_*`` channel (NaN when unknown); the other fields
    are internal values the processor, anomaly detector and alert rules use.
    """

    channels: dict[str, float]
    cp: np.ndarray
    q: float
    q_source: str
    q_pitot: float
    airspeed_pitot: float
    yaw_abs_lp: float
    steady: bool
    cl_lp: dict[str, float]
    cp_ut_mean_lp: float


class AeroEstimator:
    """Computes all aero ``calc_*`` channels tick by tick (see the module docstring).

    ``update(dt, values, pitot_ok, tap_mask)`` takes the latest raw values (missing = NaN),
    whether the pitot is trusted, and an optional boolean mask of taps to exclude
    (flagged faulty by :mod:`aerovolt.analysis.anomaly`).

    ``steady`` in the output means "flow conditions under which coefficients can be
    compared with a learned baseline": ``q`` from the pitot above 150 Pa and filtered flow
    yaw below 8 degrees.
    """

    #: Minimum q for "steady" (baseline learning and comparisons), Pa.
    Q_STEADY_MIN_PA = 150.0
    #: Maximum filtered |flow yaw| for "steady", deg.
    YAW_STEADY_MAX_DEG = 8.0

    def __init__(self, catalog: Catalog, vehicle: Mapping[str, Any]) -> None:
        self.layout = TapLayout.from_catalog(catalog)
        self.params = ChassisParams.from_vehicle(vehicle)
        self._tap_ids = list(self.layout.ids)
        self._cp_ids = [f"calc_cp_{tid}" for tid in self._tap_ids]
        self.reset()

    def reset(self) -> None:
        self._downforce_f = LowPass(TAU_DOWNFORCE_S)
        self._downforce_r = LowPass(TAU_DOWNFORCE_S)
        self._downforce = LowPass(TAU_DOWNFORCE_S)
        self._drag = LowPass(TAU_DRAG_S)
        self._q_for_cla = LowPass(TAU_CLA_S)
        self._lift_for_cla = LowPass(TAU_CLA_S)
        self._lift_f = LowPass(TAU_CLA_S)
        self._lift_r = LowPass(TAU_CLA_S)
        self._q_for_cda = LowPass(TAU_CDA_S)
        self._drag_for_cda = LowPass(TAU_CDA_S)
        self._cl = {key: LowPass(TAU_SECTION_CL_S) for key in WING_STATIONS}
        self._cp_ut = LowPass(TAU_SECTION_CL_S)
        self._yaw_abs = LowPass(TAU_YAW_S)

    def update(self, dt: float, v: Mapping[str, float], pitot_ok: bool = True,
               tap_mask: np.ndarray | None = None) -> AeroOutput:
        get = lambda cid: float(v.get(cid, NAN))  # noqa: E731 - tiny local accessor
        p = self.params
        out: dict[str, float] = {}

        # --- air data
        rho = air_density(get("amb_temp"), get("amb_press"), get("amb_rh"))
        gps_speed = get("gps_speed")
        q_pitot = max(0.0, get("pitot_dp")) if finite(get("pitot_dp")) else NAN
        q, q_source = dynamic_pressure(get("pitot_dp"), gps_speed, rho, pitot_ok)
        yaw = get("probe_yaw")
        yaw_abs_lp = self._yaw_abs.update(abs(yaw) if finite(yaw) else NAN, dt)
        out["calc_rho"] = rho
        out["calc_q"] = q
        out["calc_airspeed"] = airspeed(q, rho)
        out["calc_yaw"] = yaw

        # --- pressure coefficients and section Cl
        taps = np.array([get(tid) for tid in self._tap_ids])
        cp = pressure_coefficients(taps, q)
        out.update(zip(self._cp_ids, cp.tolist()))
        cp_used = cp.copy()
        if tap_mask is not None:
            cp_used[np.asarray(tap_mask, dtype=bool)] = NAN
        cl: dict[str, float] = {}
        for key in WING_STATIONS:
            cl[key] = station_cl(self.layout, cp_used, key)
            out[f"calc_cl_{key}"] = cl[key]
            self._cl[key].update(cl[key], dt)
        cp_ut = undertray_mean_cp(self.layout, cp_used)
        out["calc_cp_ut_mean"] = cp_ut
        self._cp_ut.update(cp_ut, dt)
        cl_lp = {key: lp.value for key, lp in self._cl.items()}
        out["calc_fw_asym"] = fw_asymmetry_pct(cl_lp["fw_l"], cl_lp["fw_r"]) if finite(q) and q > Q_CP_MIN_PA else NAN

        # --- downforce from the pushrods
        ax, ay, az = get("ax"), get("ay"), get("az")
        front, rear = axle_loads([get("pushrod_fl"), get("pushrod_fr"), get("pushrod_rl"), get("pushrod_rr")], p)
        lift_total = total_downforce(front, rear, az, p)
        lift_f, lift_r = downforce_from_axle_loads(front, rear, ax, az, p)
        out["calc_downforce"] = self._downforce.update(lift_total, dt)
        out["calc_downforce_f"] = self._downforce_f.update(lift_f, dt)
        out["calc_downforce_r"] = self._downforce_r.update(lift_r, dt)

        fast = finite(q) and q > Q_COEFF_MIN_PA
        if fast and finite(lift_total) and finite(ax) and abs(ax) <= MAX_ABS_AX_FOR_DOWNFORCE:
            self._q_for_cla.update(q, dt)
            self._lift_for_cla.update(lift_total, dt)
            if finite(lift_f) and finite(lift_r):
                self._lift_f.update(lift_f, dt)
                self._lift_r.update(lift_r, dt)
        cla = _ratio(self._lift_for_cla.value, self._q_for_cla.value)
        lf, lr = self._lift_f.value, self._lift_r.value
        balance = lf / (lf + lr) * 100.0 if finite(lf) and finite(lr) and (lf + lr) > 50.0 else NAN
        out["calc_cla"] = cla
        out["calc_aero_balance"] = balance

        # --- drag from the longitudinal force balance
        torque = get("mot_torque")
        brakes_released = all(finite(get(b)) and get(b) < BRAKE_RELEASED_BAR
                              for b in ("brake_press_f", "brake_press_r"))
        driven = brakes_released and finite(torque) and torque >= 0.0
        lift_for_rr = lift_total if finite(lift_total) else (cla * q if finite(cla) and finite(q) else 0.0)
        drag_inst = aero_drag(torque, ax, lift_for_rr, p) if driven else NAN
        out["calc_drag"] = self._drag.update(drag_inst, dt) if driven else NAN
        if fast and finite(drag_inst) and finite(ay) and abs(ay) < MAX_ABS_AY_FOR_DRAG:
            self._q_for_cda.update(q, dt)
            self._drag_for_cda.update(drag_inst, dt)
        cda = _ratio(self._drag_for_cda.value, self._q_for_cda.value)
        out["calc_cda"] = cda
        out["calc_ld"] = cla / cda if finite(cla) and finite(cda) and cda > 0.05 else NAN

        steady = (q_source == "pitot" and finite(q) and q > self.Q_STEADY_MIN_PA
                  and (not finite(yaw_abs_lp) or yaw_abs_lp < self.YAW_STEADY_MAX_DEG))
        return AeroOutput(
            channels=out,
            cp=cp,
            q=q,
            q_source=q_source,
            q_pitot=q_pitot,
            airspeed_pitot=airspeed(q_pitot, rho),
            yaw_abs_lp=yaw_abs_lp,
            steady=steady,
            cl_lp=cl_lp,
            cp_ut_mean_lp=self._cp_ut.value,
        )


def _ratio(num: float, den: float, min_den: float = 1.0) -> float:
    """``num / den`` if both are finite and ``den`` is large enough, else NaN."""
    if finite(num) and finite(den) and den > min_den:
        return num / den
    return NAN
