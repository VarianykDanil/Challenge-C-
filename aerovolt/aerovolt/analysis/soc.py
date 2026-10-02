"""State-of-charge (SoC) estimation: Coulomb counting and an extended Kalman filter.

Two classic estimators run side by side, because each fails in a different way:

* :class:`CoulombCounter` integrates the pack current: ``SoC -= I dt / (3600 Q)``. It is
  smooth and exact over short times, but it has no feedback: a current-sensor offset of
  just +3 A on a 16 Ah pack drifts the SoC by ``3 / 16 / 3600`` per second = 0.31 % per
  minute, ~7 % over a 22-minute endurance. It also needs a starting SoC.
* :class:`SocEkf` uses the same current integration as its *prediction* but corrects it
  with the measured cell voltage through an equivalent-circuit cell model. Voltage
  carries absolute SoC information (via the open-circuit-voltage curve), so the EKF
  cannot drift away - it converges even from a wrong initial SoC.

When the two disagree for long, something is wrong with the current sensor or the cell
model - the ``bms_soc_divergence`` alert.

Both work on one *series element* (a parallel group of ``parallel`` cells) with the
nominal parameters of ``config/vehicle.yaml`` (:class:`physics.CellParams`); the pack
current flows through every series element, and the measurement is the **mean** cell
voltage, which averages out per-cell manufacturing spread. SoC is a fraction 0..1
inside this module (channels carry %).

EKF model (discrete time, step ``dt``, current ``I`` held constant over the step)
-------------------------------------------------------------------------------
State ``x = [SoC, V_rc]`` (``V_rc`` = voltage across the R1||C1 polarisation pair)::

    SoC[k+1]  = SoC[k] - I dt / (3600 Q)                     Q = group capacity, Ah
    V_rc[k+1] = a V_rc[k] + R1 (1 - a) I                     a = exp(-dt / (R1 C1))
    y[k]      = OCV(SoC[k]) - I R0 - V_rc[k]  (+ noise)      mean cell terminal voltage

Jacobians (the EKF linearises the model around the current estimate)::

    F = d f / d x = [[1, 0],             H = d h / d x = [dOCV/dSoC, -1]
                     [0, a]]

The state equation is linear (F is exact); only the OCV curve is non-linear, and its
slope ``dOCV/dSoC`` (:func:`physics.docv_dsoc`) tells the filter how much SoC
information a voltage error carries: about 0.9 V per unit SoC in the middle of an NMC
curve, so a 9 mV voltage error means ~1 % SoC.

Filter equations (standard EKF, Joseph-form covariance update for numerical safety)::

    predict:  x- = f(x, I),          P- = F P F^T + Qn dt
    update:   S  = H P- H^T + R,     K  = P- H^T / S
              x  = x- + K (y - h(x-)),   P = (I - K H) P- (I - K H)^T + K R K^T

The SoC state is clamped to 0..1 after each update: outside the OCV table the curve is
flat but ``dOCV/dSoC`` is not, and an unclamped estimate of a full pack could diverge.

Tuning (``Qn``, ``R``), validated in ``tests/test_analysis_soc.py`` on synthetic data
from :class:`physics.CellModel`:

* ``Qn[SoC] = (2e-4)^2 /s``: a random walk of 2e-4 per sqrt(s) lets the filter absorb
  current-sensor errors of a few amps (+3 A = 5.2e-5 /s of SoC drift).
* ``Qn[V_rc] = (1 mV)^2 /s``: small; the RC dynamics are well known.
* ``R = (4 mV)^2 + (k |I|)^2`` with ``k = 0.1 mV/A``: the mean of 140 cell readings has
  only ~0.2 mV of noise, but the model itself (R0/R1 spread, temperature, hysteresis) is
  less accurate under heavy load, so the measurement is trusted less at high current.
"""

from __future__ import annotations

import math
from typing import Any, Mapping

import numpy as np

from aerovolt.core import physics
from aerovolt.core.physics import CellParams, OcvTable

#: Process noise spectral densities: SoC (1/s) and V_rc (V^2/s).
Q_SOC_PER_S = 2.0e-4 ** 2
Q_VRC_PER_S = 1.0e-3 ** 2
#: Measurement noise: base standard deviation (V) and growth with current (V/A).
R_BASE_V = 4.0e-3
R_PER_AMP_V = 1.0e-4
#: Initial standard deviations: SoC (fraction) and V_rc (V).
P0_SOC = 0.10
P0_VRC = 0.02
#: Longest step integrated at once (data gaps are not extrapolated beyond this), s.
MAX_STEP_S = 1.0


def soc_from_voltage(v_cell: float, current_a: float, params: CellParams, table: OcvTable) -> float:
    """SoC fraction from a terminal voltage, inverting the OCV curve.

    The ohmic drop is added back first, ``OCV ~= V + I R0`` (the slower RC polarisation
    is unknown at the first sample and taken as zero), then the OCV table is inverted by
    linear interpolation (it is monotonic). Used to start the estimators from the first
    voltage reading instead of assuming a full pack.
    """
    if not (math.isfinite(v_cell)):
        return float("nan")
    i = current_a if math.isfinite(current_a) else 0.0
    ocv_est = v_cell + i * params.group_r0
    volts = np.asarray(table.v, dtype=float)
    socs = np.asarray(table.soc, dtype=float)
    volts, first = np.unique(volts, return_index=True)  # flat segments: keep one point
    return float(np.interp(ocv_est, volts, socs[first]))


class CoulombCounter:
    """Coulomb counting: ``SoC[k+1] = SoC[k] - I dt / (3600 Q)`` (``I`` > 0 = discharge).

    ``soc`` is ``None`` until :meth:`initialise` is called (the processor uses the first
    voltage-based estimate). Steps with a missing current are skipped.
    """

    def __init__(self, capacity_ah: float, soc0: float | None = None) -> None:
        if capacity_ah <= 0:
            raise ValueError("capacity_ah must be > 0")
        self.capacity_ah = float(capacity_ah)
        self.soc: float | None = None if soc0 is None else float(soc0)
        self.charge_ah = 0.0  # net charge removed since initialisation

    @property
    def initialised(self) -> bool:
        return self.soc is not None

    def initialise(self, soc0: float) -> None:
        self.soc = float(soc0)
        self.charge_ah = 0.0

    def step(self, current_a: float, dt: float) -> float:
        """Integrate one step; returns the SoC fraction (NaN before initialisation)."""
        if self.soc is None:
            return float("nan")
        if math.isfinite(current_a) and dt > 0.0:
            dq_ah = current_a * min(dt, MAX_STEP_S) / 3600.0
            self.charge_ah += dq_ah
            self.soc -= dq_ah / self.capacity_ah
        return self.soc


class SocEkf:
    """Two-state extended Kalman filter for SoC (see the module docstring for the maths)."""

    def __init__(self, params: CellParams, table: OcvTable | Mapping[str, Any] | None = None,
                 soc0: float = 1.0, *, q_soc: float = Q_SOC_PER_S, q_vrc: float = Q_VRC_PER_S,
                 r_base: float = R_BASE_V, r_per_amp: float = R_PER_AMP_V,
                 p0_soc: float = P0_SOC, p0_vrc: float = P0_VRC) -> None:
        self.params = params
        self.table = physics.as_ocv_table(table)
        self.q_soc, self.q_vrc = float(q_soc), float(q_vrc)
        self.r_base, self.r_per_amp = float(r_base), float(r_per_amp)
        self.p0 = np.diag([p0_soc ** 2, p0_vrc ** 2])
        self.reset(soc0)

    def reset(self, soc0: float) -> None:
        """Restart at ``soc0`` (fraction) with no polarisation and the initial covariance."""
        self.x = np.array([float(soc0), 0.0])
        self.P = self.p0.copy()
        self.innovation = 0.0

    @property
    def soc(self) -> float:
        return float(self.x[0])

    @property
    def v_rc(self) -> float:
        return float(self.x[1])

    @property
    def soc_std(self) -> float:
        """1-sigma uncertainty of the SoC estimate (fraction)."""
        return float(math.sqrt(max(self.P[0, 0], 0.0)))

    def predicted_voltage(self, current_a: float) -> float:
        """Model terminal voltage ``h(x) = OCV(SoC) - I R0 - V_rc`` for the current state."""
        return float(physics.ocv(self.x[0], self.table)) - current_a * self.params.group_r0 - self.x[1]

    def predict(self, current_a: float, dt: float) -> None:
        """Time update: propagate the state with the current, grow the covariance."""
        p = self.params
        a = math.exp(-dt / p.tau_s)
        self.x = np.array([
            self.x[0] - current_a * dt / (3600.0 * p.group_capacity_ah),
            a * self.x[1] + p.group_r1 * (1.0 - a) * current_a,
        ])
        F = np.array([[1.0, 0.0], [0.0, a]])
        self.P = F @ self.P @ F.T + np.diag([self.q_soc, self.q_vrc]) * dt

    def correct(self, v_cell: float, current_a: float) -> None:
        """Measurement update with the mean cell terminal voltage ``v_cell``."""
        H = np.array([float(physics.docv_dsoc(self.x[0], self.table)), -1.0])
        r = self.r_base ** 2 + (self.r_per_amp * current_a) ** 2
        s = float(H @ self.P @ H) + r
        K = (self.P @ H) / s
        self.innovation = v_cell - self.predicted_voltage(current_a)
        self.x = self.x + K * self.innovation
        ikh = np.eye(2) - np.outer(K, H)
        self.P = ikh @ self.P @ ikh.T + np.outer(K, K) * r
        # SoC is physically bounded. Beyond the ends of the OCV table the model voltage is
        # flat while the Jacobian still has a slope, so an unbounded estimate could run away
        # (e.g. a full pack with a small positive innovation). Clamp it.
        self.x[0] = min(max(self.x[0], 0.0), 1.0)

    def step(self, current_a: float, v_cell: float, dt: float) -> float:
        """One predict + correct cycle; returns the SoC fraction.

        A missing current skips the whole step (without the current, a voltage drop under
        load cannot be told apart from a lower SoC); a missing voltage skips only the
        correction (pure Coulomb counting for that step).
        """
        if not math.isfinite(current_a):
            return self.soc
        if dt > 0.0:
            self.predict(current_a, min(dt, MAX_STEP_S))
        if math.isfinite(v_cell):
            self.correct(v_cell, current_a)
        return self.soc
