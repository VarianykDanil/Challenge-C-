"""Shared physics: pure, tested formulas used by BOTH the simulator and the analysis.

Keeping one implementation of each formula guarantees that the simulator (the "true car")
and the analysis (what the pit wall computes from sensors) agree on definitions; any
difference between ``truth_*`` and ``calc_*`` channels then comes from sensor noise, lag,
faults and estimation error - exactly what the demo is meant to show.

Contents
--------
* Air: :func:`saturation_vapour_pressure`, :func:`moist_air_density`,
  :func:`dynamic_pressure`, :func:`airspeed_from_q`.
* Aerodynamics: :func:`section_cl` (pressure-tap integration).
* Accumulator: :class:`OcvTable`, :data:`DEFAULT_NMC_OCV`, :func:`ocv`, :func:`docv_dsoc`,
  :class:`CellParams`, :class:`CellModel` (R0 + one RC pair, Coulomb counting),
  :func:`temp_sensor_cells`, :func:`cell_temp_sensor`.
* Suspension: :func:`pushrod_from_wheel_load`, :func:`wheel_load_from_pushrod`.

CAN "signal not available" helpers live in :mod:`aerovolt.core.canutil`.

Units are SI (temperatures in degC at the interface, converted to kelvin internally).
State of charge (SoC) is a *fraction* 0..1 inside this module; channels carry it in %.
Functions accept floats or numpy arrays and propagate NaN (NaN in -> NaN out).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

# --------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------

#: Standard gravity, m/s^2.
G = 9.80665
#: Specific gas constant of dry air, J/(kg K).
R_DRY_AIR = 287.058
#: Specific gas constant of water vapour, J/(kg K).
R_WATER_VAPOUR = 461.495
#: 0 degC in kelvin.
KELVIN = 273.15

ArrayLike = float | np.ndarray


# --------------------------------------------------------------------------------------
# Air properties
# --------------------------------------------------------------------------------------


def saturation_vapour_pressure(t_c: ArrayLike) -> ArrayLike:
    """Saturation vapour pressure of water over liquid water, Pa.

    Magnus formula with the Alduchov & Eskridge (1996) coefficients, accurate to < 0.4 %
    between -40 and +50 degC::

        p_sat = 610.94 * exp(17.625 * T / (T + 243.04))      T in degC
    """
    t = np.asarray(t_c, dtype=float)
    p_sat = 610.94 * np.exp(17.625 * t / (t + 243.04))
    return float(p_sat) if p_sat.ndim == 0 else p_sat


def moist_air_density(t_c: ArrayLike, p_pa: ArrayLike, rh_pct: ArrayLike) -> ArrayLike:
    """Density of humid air, kg/m^3 (ideal-gas mixture of dry air and water vapour).

    Dalton's law splits the absolute pressure ``p`` into the vapour partial pressure
    ``p_v = RH * p_sat(T)`` and the dry-air partial pressure ``p_d = p - p_v``; each obeys
    the ideal-gas law::

        rho = p_d / (R_d * T) + p_v / (R_v * T)        T in kelvin

    Because R_v > R_d (water vapour, M = 18 g/mol, is lighter than dry air, M = 29 g/mol),
    humid air is *less* dense than dry air at the same pressure and temperature.
    Example: 15 degC, 101325 Pa, 0 % RH -> 1.225 kg/m^3 (ISA sea level).
    """
    t = np.asarray(t_c, dtype=float)
    p = np.asarray(p_pa, dtype=float)
    rh = np.clip(np.asarray(rh_pct, dtype=float), 0.0, 100.0)
    t_k = t + KELVIN
    p_v = rh / 100.0 * saturation_vapour_pressure(t)
    p_d = p - p_v
    rho = p_d / (R_DRY_AIR * t_k) + p_v / (R_WATER_VAPOUR * t_k)
    return float(rho) if np.ndim(rho) == 0 else rho


def dynamic_pressure(rho: ArrayLike, v: ArrayLike) -> ArrayLike:
    """Dynamic pressure ``q = 1/2 * rho * v^2``, Pa (rho in kg/m^3, v in m/s)."""
    q = 0.5 * np.asarray(rho, dtype=float) * np.square(np.asarray(v, dtype=float))
    return float(q) if np.ndim(q) == 0 else q


def airspeed_from_q(q: ArrayLike, rho: ArrayLike) -> ArrayLike:
    """Airspeed from dynamic pressure, m/s: inverse of Bernoulli ``v = sqrt(2 q / rho)``.

    A pitot reading slightly below zero (sensor noise / zero offset at standstill) is
    treated as 0 m/s instead of producing NaN; NaN inputs still give NaN.
    """
    q_arr = np.asarray(q, dtype=float)
    q_pos = np.where(q_arr < 0.0, 0.0, q_arr)  # keeps NaN (NaN < 0 is False)
    v = np.sqrt(2.0 * q_pos / np.asarray(rho, dtype=float))
    return float(v) if np.ndim(v) == 0 else v


# --------------------------------------------------------------------------------------
# Aerodynamics
# --------------------------------------------------------------------------------------


def _surface_points(xc: Sequence[float], cp: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    """Valid (finite) tap points of one surface, sorted by chord position."""
    x = np.asarray(xc, dtype=float)
    c = np.asarray(cp, dtype=float)
    if x.shape != c.shape:
        raise ValueError(f"x/c and Cp arrays differ in length: {x.shape} vs {c.shape}")
    ok = np.isfinite(x) & np.isfinite(c)
    x, c = x[ok], c[ok]
    order = np.argsort(x, kind="stable")
    return x[order], c[order]


def section_cl(
    xc_suction: Sequence[float],
    cp_suction: Sequence[float],
    xc_pressure: Sequence[float],
    cp_pressure: Sequence[float],
) -> float:
    """Sectional downforce coefficient from surface pressure taps.

    The sectional lift coefficient of an aerofoil is the chordwise integral of the pressure
    difference between its two surfaces::

        Cl = integral_0^1 (Cp_pressure - Cp_suction) d(x/c)

    For an inverted (downforce) wing the pressure surface is on top, so a positive result
    means downforce. Each surface is reconstructed piecewise-linearly through its taps plus
    two closure points:

    * x/c = 0 (leading edge): both surfaces start at the stagnation point, Cp = 1;
    * x/c = 1 (trailing edge): both surfaces meet at the mean of their last measured Cp
      (Kutta condition - the flow leaves the trailing edge smoothly, with one pressure).

    The integral of a piecewise-linear curve is evaluated exactly by the trapezoidal rule.
    Taps reading NaN (sensor missing) are skipped; if a whole surface is missing the
    result is NaN. Identical surfaces give exactly 0.
    """
    xs, cs = _surface_points(xc_suction, cp_suction)
    xp, cpp = _surface_points(xc_pressure, cp_pressure)
    if xs.size == 0 or xp.size == 0:
        return float("nan")
    cp_te = 0.5 * (cs[-1] + cpp[-1])

    def closed_integral(x: np.ndarray, c: np.ndarray) -> float:
        inner = (x > 0.0) & (x < 1.0)
        xx = np.concatenate(([0.0], x[inner], [1.0]))
        cc = np.concatenate(([1.0], c[inner], [cp_te]))
        return float(np.sum(0.5 * (cc[1:] + cc[:-1]) * np.diff(xx)))

    return closed_integral(xp, cpp) - closed_integral(xs, cs)


# --------------------------------------------------------------------------------------
# Accumulator: open-circuit voltage
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class OcvTable:
    """Open-circuit voltage of one cell versus state of charge.

    ``soc`` is a strictly increasing fraction 0..1, ``v`` the rest voltage in volts
    (non-decreasing). Between points the curve is linear; outside it is clamped.
    """

    soc: tuple[float, ...]
    v: tuple[float, ...]

    def __post_init__(self) -> None:
        if len(self.soc) != len(self.v) or len(self.soc) < 2:
            raise ValueError("OCV table needs >= 2 points and equal-length soc / v lists")
        if any(b <= a for a, b in zip(self.soc, self.soc[1:])):
            raise ValueError("OCV table soc values must be strictly increasing")
        if any(b < a for a, b in zip(self.v, self.v[1:])):
            raise ValueError("OCV table voltages must be non-decreasing with SoC")

    @classmethod
    def from_mapping(cls, table: Mapping[str, Sequence[float]]) -> OcvTable:
        """Build from ``{soc: [...], v: [...]}`` (e.g. ``vehicle.yaml: accumulator.ocv``).

        SoC may be given as a fraction (0..1) or in percent (0..100): a table whose
        largest SoC exceeds 1.0 is treated as percent.
        """
        soc = [float(s) for s in table["soc"]]
        if max(soc) > 1.0:
            soc = [s / 100.0 for s in soc]
        return cls(tuple(soc), tuple(float(v) for v in table["v"]))


#: Typical NMC 21700 cell (e.g. Molicel P42A / Samsung 40T class), rest voltage at 25 degC.
#: Flat plateau around 3.6-3.9 V, steep knee below 10 % SoC. Used when ``vehicle.yaml``
#: has no OCV table, and in tests.
DEFAULT_NMC_OCV = OcvTable(
    soc=(0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50,
         0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00),
    v=(3.000, 3.280, 3.420, 3.500, 3.560, 3.600, 3.630, 3.660, 3.690, 3.720, 3.760,
       3.800, 3.840, 3.880, 3.920, 3.960, 4.000, 4.040, 4.080, 4.130, 4.200),
)


def as_ocv_table(table: OcvTable | Mapping[str, Sequence[float]] | None) -> OcvTable:
    """Accept an :class:`OcvTable`, a ``{soc, v}`` mapping, or ``None`` (default NMC)."""
    if table is None:
        return DEFAULT_NMC_OCV
    if isinstance(table, OcvTable):
        return table
    return OcvTable.from_mapping(table)


def ocv(soc: ArrayLike, table: OcvTable | Mapping[str, Sequence[float]] = DEFAULT_NMC_OCV) -> ArrayLike:
    """Open-circuit voltage at state of charge ``soc`` (fraction 0..1), V.

    Linear interpolation in the table; SoC outside 0..1 is clamped to the table ends.
    """
    tab = as_ocv_table(table)
    v = np.interp(np.asarray(soc, dtype=float), tab.soc, tab.v)
    return float(v) if np.ndim(v) == 0 else v


def docv_dsoc(soc: ArrayLike, table: OcvTable | Mapping[str, Sequence[float]] = DEFAULT_NMC_OCV) -> ArrayLike:
    """Slope of the OCV curve dV/dSoC (V per unit SoC) - the EKF measurement Jacobian.

    The slope of a piecewise-linear curve jumps at every table point, which would make an
    EKF gain jump too. Instead the slope is estimated *at the table points* with second
    order central differences (``numpy.gradient``) and linearly interpolated between them,
    giving a continuous derivative.
    """
    tab = as_ocv_table(table)
    soc_pts = np.asarray(tab.soc)
    slope_pts = np.gradient(np.asarray(tab.v), soc_pts)
    d = np.interp(np.asarray(soc, dtype=float), soc_pts, slope_pts)
    return float(d) if np.ndim(d) == 0 else d


# --------------------------------------------------------------------------------------
# Accumulator: equivalent-circuit cell model
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CellParams:
    """Parameters of ONE physical cell (datasheet values) and the parallel count.

    The accumulator treats ``parallel`` identical cells wired in parallel as one series
    element ("cell" in the channel names). For that group: capacity x parallel,
    resistances / parallel, capacitance x parallel (so the RC time constant is unchanged).
    """

    capacity_ah: float = 4.0
    r0_ohm: float = 0.012
    r1_ohm: float = 0.006
    c1_f: float = 2500.0
    parallel: int = 1

    @property
    def group_capacity_ah(self) -> float:
        return self.capacity_ah * self.parallel

    @property
    def group_r0(self) -> float:
        return self.r0_ohm / self.parallel

    @property
    def group_r1(self) -> float:
        return self.r1_ohm / self.parallel

    @property
    def group_c1(self) -> float:
        return self.c1_f * self.parallel

    @property
    def tau_s(self) -> float:
        """RC time constant ``tau = R1 * C1`` in seconds (same for a cell and its group)."""
        return self.group_r1 * self.group_c1

    @classmethod
    def from_vehicle(cls, vehicle: Mapping[str, Any]) -> CellParams:
        """Read ``accumulator.cell`` and ``accumulator.parallel`` from ``vehicle.yaml``."""
        acc = vehicle["accumulator"]
        cell = acc["cell"]
        return cls(
            capacity_ah=float(cell["capacity_ah"]),
            r0_ohm=float(cell["r0_ohm"]),
            r1_ohm=float(cell["r1_ohm"]),
            c1_f=float(cell["c1_f"]),
            parallel=int(acc.get("parallel", 1)),
        )


def ocv_table_from_vehicle(vehicle: Mapping[str, Any]) -> OcvTable:
    """The ``accumulator.ocv`` table of ``vehicle.yaml``, or :data:`DEFAULT_NMC_OCV`."""
    table = vehicle.get("accumulator", {}).get("ocv")
    if not table or not table.get("soc"):
        return DEFAULT_NMC_OCV
    return OcvTable.from_mapping(table)


class CellModel:
    """First-order Thevenin equivalent circuit of one series element (parallel group).

    Circuit: open-circuit voltage source OCV(SoC) in series with an ohmic resistance R0
    and one R1 || C1 pair that models the slower polarisation (diffusion) voltage::

        V_terminal = OCV(SoC) - I * R0 - V_rc            (I > 0 = discharge)
        dV_rc/dt   = -V_rc / (R1 C1) + I / C1
        dSoC/dt    = -I / (3600 * Q_Ah)                  (Coulomb counting)

    The RC equation is integrated *exactly* for a current held constant over the step
    (zero-order hold), so the model is stable for any ``dt``::

        V_rc[k+1] = V_rc[k] * exp(-dt/tau) + I * R1 * (1 - exp(-dt/tau)),   tau = R1 C1

    Consequences (unit-tested): at rest the terminal voltage equals OCV; a current step
    drops the voltage instantly by I*R0, then further towards I*(R0+R1) with time
    constant tau; after the load is removed the voltage relaxes back with the same tau.
    """

    def __init__(
        self,
        params: CellParams = CellParams(),
        ocv_table: OcvTable | Mapping[str, Sequence[float]] | None = None,
        soc: float = 1.0,
    ) -> None:
        self.params = params
        self.table = as_ocv_table(ocv_table)
        self.soc = float(soc)
        self.v_rc = 0.0
        self.current_a = 0.0
        self.voltage = self.terminal_voltage(0.0)

    def reset(self, soc: float = 1.0) -> None:
        """Back to rest (no polarisation) at the given SoC fraction."""
        self.soc = float(soc)
        self.v_rc = 0.0
        self.current_a = 0.0
        self.voltage = self.terminal_voltage(0.0)

    @property
    def ocv(self) -> float:
        """Open-circuit voltage at the present SoC, V."""
        return float(ocv(self.soc, self.table))

    def terminal_voltage(self, current_a: float) -> float:
        """Terminal voltage for ``current_a`` with the *present* state (no time step)."""
        return self.ocv - current_a * self.params.group_r0 - self.v_rc

    def step(self, current_a: float, dt: float) -> float:
        """Advance the state by ``dt`` seconds at constant ``current_a`` (A, + = discharge).

        Returns the terminal voltage at the end of the step.
        """
        p = self.params
        decay = math.exp(-dt / p.tau_s)
        self.v_rc = self.v_rc * decay + current_a * p.group_r1 * (1.0 - decay)
        self.soc -= current_a * dt / (3600.0 * p.group_capacity_ah)
        self.current_a = current_a
        self.voltage = self.terminal_voltage(current_a)
        return self.voltage

    def heat_w(self, current_a: float | None = None) -> float:
        """Heat generated inside the cell, W: Joule losses ``I^2 R0 + V_rc^2 / R1``."""
        i = self.current_a if current_a is None else current_a
        return i * i * self.params.group_r0 + self.v_rc * self.v_rc / self.params.group_r1


# --------------------------------------------------------------------------------------
# Accumulator: temperature sensor <-> cell mapping
# --------------------------------------------------------------------------------------


def temp_sensor_cells(j: int, n_cells: int = 140, n_sensors: int = 60) -> range:
    """Cells covered by temperature sensor ``cell_t_j``.

    The sensors are spread evenly along the series string; sensor ``j`` sits between the
    cells ``round(j * n_cells / n_sensors)`` and ``round((j + 1) * n_cells / n_sensors) - 1``
    (inclusive) and reads their mean temperature. With 140 cells and 60 sensors each
    sensor covers 2 or 3 cells, every cell is covered exactly once, and because
    12 sensors x 7/3 = 28 cells the sensor groups never straddle a segment boundary.
    Example: sensor 20 covers cells 47 and 48.
    """
    if not 0 <= j < n_sensors:
        raise IndexError(f"temperature sensor index {j} outside 0..{n_sensors - 1}")
    return range(round(j * n_cells / n_sensors), round((j + 1) * n_cells / n_sensors))


def cell_temp_sensor(k: int, n_cells: int = 140, n_sensors: int = 60) -> int:
    """Index of the temperature sensor that covers cell ``k`` (inverse of the above)."""
    if not 0 <= k < n_cells:
        raise IndexError(f"cell index {k} outside 0..{n_cells - 1}")
    j = min(n_sensors - 1, int(k * n_sensors / n_cells))
    while k < temp_sensor_cells(j, n_cells, n_sensors).start:
        j -= 1
    while k >= temp_sensor_cells(j, n_cells, n_sensors).stop:
        j += 1
    return j


# --------------------------------------------------------------------------------------
# Suspension
# --------------------------------------------------------------------------------------


def pushrod_from_wheel_load(load_n: ArrayLike, ratio: float, unsprung_kg: float) -> ArrayLike:
    """Pushrod compression force from the vertical tyre load, N.

    The tyre contact patch carries the whole corner load, but the unsprung mass (wheel,
    upright, brake) sits *below* the spring, so its weight does not pass through the
    pushrod. The remaining sprung load is amplified by the rocker geometry::

        F_pushrod = ratio * (F_wheel - m_unsprung * g)
    """
    f = ratio * (np.asarray(load_n, dtype=float) - unsprung_kg * G)
    return float(f) if np.ndim(f) == 0 else f


def wheel_load_from_pushrod(force_n: ArrayLike, ratio: float, unsprung_kg: float) -> ArrayLike:
    """Vertical tyre load from the pushrod force, N (inverse of
    :func:`pushrod_from_wheel_load`): ``F_wheel = F_pushrod / ratio + m_unsprung * g``."""
    f = np.asarray(force_n, dtype=float) / ratio + unsprung_kg * G
    return float(f) if np.ndim(f) == 0 else f
