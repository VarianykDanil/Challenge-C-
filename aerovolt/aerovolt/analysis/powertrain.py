"""Powertrain analysis: power flow, efficiency, cell statistics, energy and cooling.

Pure functions for the formulas (NaN in -> NaN out) plus two small stateful helpers:

* :class:`EnergyIntegrator` - energy drawn from / returned to the accumulator, integrated
  from pack power (what the FS energy meter measures).
* :class:`CellDeviationTracker` - per-cell *voltage offset* and *internal-resistance
  deviation* from the rest of the pack (a weak cell sags at zero current, a bad weld sags
  more under load). This is how a BMS engineer tells a low-capacity cell from a
  high-resistance one.

Robust statistics
-----------------
Cell outliers are judged with the **median** and the **median absolute deviation** (MAD)
instead of the mean and standard deviation: one hot or weak cell then cannot drag the
reference towards itself. For normally distributed data ``sigma ~= 1.4826 MAD``, so the
*robust z-score* of a value is ``z = (x - median) / (1.4826 MAD)``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

NAN = float("nan")

#: Consistency constant: sigma = 1.4826 * MAD for a normal distribution.
MAD_TO_SIGMA = 1.4826
#: Inverter efficiency is only reported above this DC power, kW (below it the ratio of two
#: small, noisy numbers is meaningless).
EFFICIENCY_MIN_POWER_KW = 5.0
#: Integration steps longer than this (data gaps) are clipped, s.
MAX_STEP_S = 1.0


def _finite(x: float) -> bool:
    return x is not None and math.isfinite(x)


# --------------------------------------------------------------------------------------
# Power and efficiency
# --------------------------------------------------------------------------------------


def electrical_power_kw(voltage_v: float, current_a: float) -> float:
    """DC electrical power ``P = V I / 1000``, kW (+ = discharge)."""
    return voltage_v * current_a / 1000.0


def mechanical_power_kw(torque_nm: float, speed_rpm: float) -> float:
    """Motor shaft power ``P = T omega``, kW, with ``omega = 2 pi n / 60`` (rad/s)."""
    return torque_nm * speed_rpm * 2.0 * math.pi / 60.0 / 1000.0


def drive_efficiency_pct(mech_kw: float, dc_kw: float, min_kw: float = EFFICIENCY_MIN_POWER_KW) -> float:
    """Inverter + motor efficiency ``P_mech / P_dc * 100`` while motoring above ``min_kw``.

    NaN when regenerating (power flows the other way) or at low power.
    """
    if not (_finite(mech_kw) and _finite(dc_kw)) or dc_kw <= min_kw or mech_kw <= 0.0:
        return NAN
    return mech_kw / dc_kw * 100.0


def coolant_heat_kw(flow_lpm: float, t_in_c: float, t_out_c: float,
                    density_kg_m3: float = 1040.0, cp_j_per_kgk: float = 3600.0) -> float:
    """Heat picked up by the coolant ``Q = m_dot cp (T_out - T_in)``, kW.

    ``m_dot = rho * flow``: flow in L/min -> m^3/s is ``/ 60000``. Positive = the motor and
    inverter are heating the coolant (the radiator rejects the same heat in steady state).
    """
    if not (_finite(flow_lpm) and _finite(t_in_c) and _finite(t_out_c)):
        return NAN
    m_dot = density_kg_m3 * flow_lpm / 60000.0
    return m_dot * cp_j_per_kgk * (t_out_c - t_in_c) / 1000.0


# --------------------------------------------------------------------------------------
# Cell statistics and outliers
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CellStats:
    """Summary of an array of cell readings (NaN-robust). Indices refer to the input array."""

    min: float
    max: float
    mean: float
    median: float
    min_idx: int | None
    max_idx: int | None
    valid: int

    @property
    def spread(self) -> float:
        return self.max - self.min


def cell_stats(values: Sequence[float]) -> CellStats:
    """Min / max / mean / median and the indices of the extremes, ignoring NaN readings."""
    x = np.asarray(values, dtype=float)
    ok = np.isfinite(x)
    if not ok.any():
        return CellStats(NAN, NAN, NAN, NAN, None, None, 0)
    masked_lo = np.where(ok, x, np.inf)
    masked_hi = np.where(ok, x, -np.inf)
    i_min, i_max = int(np.argmin(masked_lo)), int(np.argmax(masked_hi))
    good = x[ok]
    return CellStats(float(x[i_min]), float(x[i_max]), float(np.mean(good)), float(np.median(good)),
                     i_min, i_max, int(ok.sum()))


def robust_zscores(values: Sequence[float], sigma_floor: float = 0.0) -> np.ndarray:
    """Robust z-score of every value: ``(x - median) / max(1.4826 MAD, sigma_floor)``.

    ``sigma_floor`` stops a near-perfect pack (MAD ~ 0) from turning tiny differences into
    huge z-scores. NaN inputs give NaN; fewer than 3 valid values give all NaN.
    """
    x = np.asarray(values, dtype=float)
    ok = np.isfinite(x)
    if ok.sum() < 3:
        return np.full(x.shape, NAN)
    med = float(np.median(x[ok]))
    sigma = max(MAD_TO_SIGMA * float(np.median(np.abs(x[ok] - med))), sigma_floor)
    if sigma <= 0.0:
        return np.where(ok, np.where(x == med, 0.0, np.copysign(np.inf, x - med)), NAN)
    return (x - med) / sigma


@dataclass(frozen=True)
class Outlier:
    """The most extreme reading that passed the outlier test."""

    index: int
    value: float
    median: float
    deviation: float  # value - median, signed
    z: float  # robust z-score


def find_outlier(values: Sequence[float], z_threshold: float = 5.0, min_abs: float = 0.0,
                 side: str = "both", sigma_floor: float = 0.0) -> Outlier | None:
    """Index of the most extreme outlier, or ``None``.

    A reading is an outlier when ``|z| >= z_threshold`` **and** ``|x - median| >= min_abs``
    (the absolute floor encodes engineering judgement: e.g. a 1 degC difference is never
    worth an alert, however uniform the other cells are). ``side`` selects ``'high'``,
    ``'low'`` or ``'both'``.
    """
    x = np.asarray(values, dtype=float)
    z = robust_zscores(x, sigma_floor)
    ok = np.isfinite(z)
    if not ok.any():
        return None
    med = float(np.median(x[np.isfinite(x)]))
    dev = x - med
    if side == "high":
        score = np.where(ok & (dev > 0), z, -np.inf)
    elif side == "low":
        score = np.where(ok & (dev < 0), -z, -np.inf)
    else:
        score = np.where(ok, np.abs(z), -np.inf)
    i = int(np.argmax(score))
    if not np.isfinite(score[i]) or score[i] < z_threshold or abs(dev[i]) < min_abs:
        return None
    return Outlier(index=i, value=float(x[i]), median=med, deviation=float(dev[i]), z=float(z[i]))


# --------------------------------------------------------------------------------------
# Energy
# --------------------------------------------------------------------------------------


class EnergyIntegrator:
    """Accumulator energy counters, kWh, integrated from pack power.

    ``used`` integrates discharge power (P > 0), ``regen`` the recovered energy (P < 0) -
    both positive numbers; ``net = used - regen`` is what left the pack. Rectangle rule
    with the power held over the step (the processor samples at 20 Hz). Steps with a
    missing power add nothing.
    """

    def __init__(self) -> None:
        self.used_kwh = 0.0
        self.regen_kwh = 0.0

    @property
    def net_kwh(self) -> float:
        return self.used_kwh - self.regen_kwh

    def step(self, power_kw: float, dt: float) -> None:
        if not _finite(power_kw) or dt <= 0.0:
            return
        e = power_kw * min(dt, MAX_STEP_S) / 3600.0
        if e >= 0.0:
            self.used_kwh += e
        else:
            self.regen_kwh -= e

    def reset(self) -> None:
        self.used_kwh = 0.0
        self.regen_kwh = 0.0


# --------------------------------------------------------------------------------------
# Per-cell offset / resistance tracking
# --------------------------------------------------------------------------------------


class CellDeviationTracker:
    """Learns, for every cell, how its voltage differs from the pack median.

    Every series element carries the same current ``I``, so each cell's deviation from
    the pack median voltage is modelled as a straight line in ``I``::

        d_k = v_k - median(v) = offset_k - dR_k I

    * ``offset_k`` (V): deviation at zero current - an open-circuit-voltage (SoC)
      difference. A **low-capacity** cell discharges faster than the others, so its
      offset falls lap after lap.
    * ``dR_k`` (ohm): extra internal resistance - a **bad weld / damaged cell** sags more
      under load (and heats up: ``I^2 R``).

    Both are fitted by exponentially weighted least squares, vectorised over all cells:
    running averages (time constant ``tau_s``) of ``I``, ``I^2``, ``d`` and ``I d`` give::

        dR     = -cov(I, d) / var(I)
        offset = mean(d) + dR mean(I)

    The fit needs current *variation* (``var(I) >= min_current_var``), which a race car
    provides constantly (full power on straights, regen in braking zones).
    """

    def __init__(self, n_cells: int, tau_s: float = 20.0, warmup_s: float = 20.0,
                 min_current_std_a: float = 10.0) -> None:
        self.n = int(n_cells)
        self.tau_s = float(tau_s)
        self.warmup_s = float(warmup_s)
        self.min_current_var = float(min_current_std_a) ** 2
        self.reset()

    def reset(self) -> None:
        self._m_i = NAN
        self._m_i2 = NAN
        self._m_d = np.full(self.n, NAN)
        self._m_id = np.full(self.n, NAN)
        self.learned_s = 0.0

    def update(self, cell_v: Sequence[float], current_a: float, dt: float) -> None:
        v = np.asarray(cell_v, dtype=float)
        if v.shape != (self.n,) or not _finite(current_a) or dt <= 0.0:
            return
        ok = np.isfinite(v)
        if ok.sum() < max(3, self.n // 2):
            return
        d = v - float(np.median(v[ok]))
        i = float(current_a)
        alpha = 1.0 - math.exp(-min(dt, MAX_STEP_S) / self.tau_s)
        if not math.isfinite(self._m_i):
            self._m_i, self._m_i2 = i, i * i
        else:
            self._m_i += alpha * (i - self._m_i)
            self._m_i2 += alpha * (i * i - self._m_i2)
        first = ok & ~np.isfinite(self._m_d)
        self._m_d[first] = d[first]
        self._m_id[first] = i * d[first]
        upd = ok & ~first
        self._m_d[upd] += alpha * (d[upd] - self._m_d[upd])
        self._m_id[upd] += alpha * (i * d[upd] - self._m_id[upd])
        self.learned_s += dt

    @property
    def current_var(self) -> float:
        return self._m_i2 - self._m_i * self._m_i if math.isfinite(self._m_i) else NAN

    @property
    def ready(self) -> bool:
        """Warm-up done and the current varied enough for a meaningful fit."""
        var = self.current_var
        return self.learned_s >= self.warmup_s and math.isfinite(var) and var >= self.min_current_var

    def resistance_dev_ohm(self) -> np.ndarray:
        """Extra internal resistance of each cell vs the pack median, ohm (NaN if not ready)."""
        if not self.ready:
            return np.full(self.n, NAN)
        cov = self._m_id - self._m_i * self._m_d
        return -cov / self.current_var

    def offset_v(self) -> np.ndarray:
        """Zero-current voltage offset of each cell vs the pack median, V (NaN if not ready)."""
        if not self.ready:
            return np.full(self.n, NAN)
        return self._m_d + self.resistance_dev_ohm() * self._m_i
