"""Aero anomaly detection: is it the sensor, or did the aerodynamics really change?

A pressure tap that suddenly reads differently can mean two very different things:

* a **sensor problem** - a leaking or kinked tube, a blocked port, a drifting transducer:
  only *that* tap changes, its neighbours carry on as before;
* a **real aerodynamic change** - a damaged flap, a stalled wing, a floor touching the
  ground: the pressure field changes smoothly over the surface, so *several neighbouring
  taps* move together, in the same direction.

That physical argument is the classifier (:class:`TapAnomalyDetector`):

1. Every tap learns a baseline of its own Cp - an exponentially weighted mean and
   variance (:class:`EwmaBaseline`) - only while the flow is "steady" (pitot ``q > 150 Pa``,
   flow yaw below 8 deg) and no aero alert is active, after a warm-up of 20 s of such data.
2. A tap *deviates* when its smoothed Cp is further from its mean than the largest of
   0.2 (absolute Cp), 30 % of the mean, or 4 learned standard deviations - and keeps doing
   so for 2 s of steady flow. (Flow yaw alone moves a whole leeward station by up to ~20 %
   at the 8 deg steady limit; a leaking tube reads 90 % low, a damaged flap ~55 %.)
3. A deviating tap whose neighbours (``TapLayout.neighbours``: same element, station and
   surface, adjacent along the chord) are normal -> **sensor fault** (alert
   ``sensor_tap_anomaly``; the tap is excluded from the section-Cl integration so one bad
   tube does not corrupt the downforce numbers). If neighbours move *with* it -> **aero
   change** (a *cluster*, reported to the aero alerts).

   A real flow change is rarely uniform: when a diffuser stalls, the throat tap may lose
   65 % of its suction while its neighbours lose "only" 25-40 %, below their own alarm
   thresholds. So a neighbour *supports* an aero explanation when it deviates in the same
   direction by at least 40 % of its own threshold **and** at least 20 % of the deviating
   tap's change. A leaking tube's neighbours do not move at all (measured: a few hundredths
   of Cp, random sign), so the two cases separate cleanly.

   A sensor-fault flag is *sticky*: it clears only once the tap reads normally again for
   ``clear_s``, or if a neighbour fully deviates the same way (the "sensor" was the first
   sign of a spreading aero change). Otherwise flow yaw, which moves a whole station by a
   few tens of percent, could make a leaking tap look like part of a cluster for a moment.

:class:`AeroHealthMonitor` keeps the same kind of baseline for the element-level numbers
(station section Cl, undertray mean Cp, aero balance) that the aero alerts compare against.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from aerovolt.analysis.aero import TapLayout

NAN = float("nan")


class EwmaBaseline:
    """Exponentially weighted mean and variance of ``n`` signals, learned selectively.

    Update for each learning signal with weight ``alpha`` (West's incremental form)::

        diff  = x - mean
        mean += alpha diff
        var   = (1 - alpha) (var + alpha diff^2)

    ``alpha = max(1 - exp(-dt / tau), dt / learned_time)``: at the start this is a plain
    running average of everything seen so far (fast, unbiased warm-up), and once more than
    ``tau`` seconds were learned it becomes an EWMA that forgets with time constant ``tau``.
    A signal is ``warm`` after ``warmup_s`` seconds of learning.
    """

    def __init__(self, n: int, tau_s: float = 60.0, warmup_s: float = 20.0) -> None:
        self.n = int(n)
        self.tau_s = float(tau_s)
        self.warmup_s = float(warmup_s)
        self.reset()

    def reset(self) -> None:
        self.mean = np.full(self.n, NAN)
        self.var = np.zeros(self.n)
        self.learned_s = np.zeros(self.n)

    @property
    def warm(self) -> np.ndarray:
        return self.learned_s >= self.warmup_s

    @property
    def std(self) -> np.ndarray:
        return np.sqrt(np.maximum(self.var, 0.0))

    def update(self, x: Sequence[float], dt: float, learn: np.ndarray | bool = True) -> None:
        xx = np.asarray(x, dtype=float)
        if dt <= 0.0:
            return
        mask = np.isfinite(xx) & np.broadcast_to(np.asarray(learn, dtype=bool), xx.shape)
        if not mask.any():
            return
        first = mask & ~np.isfinite(self.mean)
        self.mean[first] = xx[first]
        self.var[first] = 0.0
        upd = mask & ~first
        if upd.any():
            self.learned_s[upd] += dt
            alpha = np.maximum(1.0 - math.exp(-dt / self.tau_s), dt / self.learned_s[upd])
            diff = xx[upd] - self.mean[upd]
            self.mean[upd] += alpha * diff
            self.var[upd] = (1.0 - alpha) * (self.var[upd] + alpha * diff * diff)
        self.learned_s[first] += dt


@dataclass(frozen=True)
class TapFinding:
    """A deviating tap: smoothed Cp, learned baseline and the deviation in sigmas."""

    tap: str
    index: int
    cp: float
    baseline: float
    deviation: float
    z: float
    neighbours: tuple[str, ...]


@dataclass(frozen=True)
class TapCluster:
    """Neighbouring taps deviating together (an aerodynamic change)."""

    element: str
    station: str
    surface: str
    taps: tuple[str, ...]
    direction: int  # +1: Cp rose (less suction / more pressure), -1: Cp fell
    mean_deviation: float


class TapAnomalyDetector:
    """Per-tap baseline learning and sensor-vs-aero classification (module docstring)."""

    #: A neighbour supports an aero change when it deviates the same way by at least this
    #: fraction of its own threshold ...
    SUPPORT_OF_THRESHOLD = 0.4
    #: ... and at least this fraction of the deviating tap's own change.
    SUPPORT_OF_DEVIATION = 0.2

    def __init__(self, layout: TapLayout, tau_s: float = 60.0, warmup_s: float = 20.0,
                 z_threshold: float = 4.0, abs_min: float = 0.2, rel_min: float = 0.30,
                 persist_s: float = 2.0, clear_s: float = 5.0, tau_cp_s: float = 0.5) -> None:
        self.layout = layout
        self.n = len(layout)
        self.z_threshold = z_threshold
        self.abs_min = abs_min
        self.rel_min = rel_min
        self.persist_s = persist_s
        self.clear_s = clear_s
        self.tau_cp_s = tau_cp_s
        self.baseline = EwmaBaseline(self.n, tau_s, warmup_s)
        self.reset()

    def reset(self) -> None:
        self.baseline.reset()
        self.cp_lp = np.full(self.n, NAN)
        self.deviation = np.full(self.n, NAN)
        self.deviating = np.zeros(self.n, dtype=bool)
        self.dev_time = np.zeros(self.n)
        self.ok_time = np.zeros(self.n)
        self.sensor_fault = np.zeros(self.n, dtype=bool)
        self.in_cluster = np.zeros(self.n, dtype=bool)
        self.clusters: list[TapCluster] = []

    @property
    def mask(self) -> np.ndarray:
        """Taps to exclude from section-Cl integration (classified as sensor faults)."""
        return self.sensor_fault.copy()

    def thresholds(self) -> np.ndarray:
        """Deviation needed to call a tap deviating: ``max(abs_min, rel_min |mean|, z sigma)``."""
        mean = np.abs(np.nan_to_num(self.baseline.mean))
        return np.maximum.reduce([np.full(self.n, self.abs_min), self.rel_min * mean,
                                  self.z_threshold * self.baseline.std])

    def update(self, cp: Sequence[float], dt: float, steady: bool, learn_ok: bool = True) -> None:
        """Feed one tick of Cp values. ``steady`` gates both learning and decisions (when the
        flow is not comparable with the baseline, every state is simply held);
        ``learn_ok=False`` (an aero alert is active) freezes the baselines."""
        x = np.asarray(cp, dtype=float)
        if dt <= 0.0:
            return
        alpha = 1.0 - math.exp(-dt / self.tau_cp_s)
        fresh = np.isfinite(x)
        init = fresh & ~np.isfinite(self.cp_lp)
        self.cp_lp[init] = x[init]
        upd = fresh & ~init
        self.cp_lp[upd] += alpha * (x[upd] - self.cp_lp[upd])
        self.cp_lp[~fresh] = NAN
        if not steady:
            return

        self.deviation = self.cp_lp - self.baseline.mean
        valid = np.isfinite(self.deviation) & self.baseline.warm
        self.deviating = valid & (np.abs(np.nan_to_num(self.deviation)) > self.thresholds())
        self.dev_time = np.where(self.deviating, self.dev_time + dt, 0.0)
        self.ok_time = np.where(valid & ~self.deviating, self.ok_time + dt, 0.0)

        learn = learn_ok & ~self.deviating & ~self.sensor_fault
        self.baseline.update(x, dt, learn)
        self._classify()

    def _supports(self, j: int, i: int, thr: np.ndarray) -> bool:
        """Does neighbour ``j`` move with deviating tap ``i`` (same sign, meaningful size)?"""
        dj, di = self.deviation[j], self.deviation[i]
        if not (math.isfinite(dj) and math.isfinite(di)) or np.sign(dj) != np.sign(di):
            return False
        return abs(dj) >= max(self.SUPPORT_OF_THRESHOLD * thr[j], self.SUPPORT_OF_DEVIATION * abs(di))

    def _classify(self) -> None:
        nb = self.layout.neighbours
        thr = self.thresholds()
        sign = np.sign(np.nan_to_num(self.deviation))
        persistent = self.dev_time >= self.persist_s
        supported = np.zeros(self.n, dtype=bool)
        confirmed = np.zeros(self.n, dtype=bool)
        for i in np.flatnonzero(persistent | self.sensor_fault):
            supported[i] = any(self._supports(j, i, thr) for j in nb[i])
            confirmed[i] = any(self.deviating[j] and sign[j] == sign[i] for j in nb[i])
        newly = persistent & ~supported & ~self.sensor_fault
        cleared = self.sensor_fault & ((self.ok_time >= self.clear_s) | confirmed)
        self.sensor_fault = (self.sensor_fault | newly) & ~cleared
        self.in_cluster = persistent & supported & ~self.sensor_fault
        self.clusters = self._group_clusters(thr)

    def _group_clusters(self, thr: np.ndarray) -> list[TapCluster]:
        """Flood fill from each clustered tap over the neighbours that move with it."""
        lay = self.layout
        seen: set[int] = set()
        clusters: list[TapCluster] = []
        for seed in np.flatnonzero(self.in_cluster):
            if seed in seen:
                continue
            members, stack = [], [int(seed)]
            while stack:
                k = stack.pop()
                if k in seen:
                    continue
                seen.add(k)
                members.append(k)
                stack.extend(j for j in lay.neighbours[k]
                             if j not in seen and not self.sensor_fault[j] and self._supports(j, k, thr))
            members.sort()
            clusters.append(TapCluster(
                element=lay.element[seed], station=lay.station[seed], surface=lay.surface[seed],
                taps=tuple(lay.ids[k] for k in members), direction=int(np.sign(self.deviation[seed])),
                mean_deviation=float(np.mean(self.deviation[members])),
            ))
        return clusters

    def findings(self, which: str = "sensor") -> list[TapFinding]:
        """Details of the taps flagged as ``'sensor'`` faults or ``'deviating'``."""
        flags = self.sensor_fault if which == "sensor" else self.deviating
        std = self.baseline.std
        out = []
        for i in np.flatnonzero(flags):
            sigma = std[i] if std[i] > 0 else NAN
            out.append(TapFinding(
                tap=self.layout.ids[i], index=int(i), cp=float(self.cp_lp[i]),
                baseline=float(self.baseline.mean[i]), deviation=float(self.deviation[i]),
                z=float(self.deviation[i] / sigma) if math.isfinite(sigma) else NAN,
                neighbours=tuple(self.layout.ids[j] for j in self.layout.neighbours[i]),
            ))
        return out


class AeroHealthMonitor:
    """Learned baselines of the element-level aero numbers the aero alerts compare against.

    Signals (in order): section Cl of the four wing stations, undertray mean Cp and the
    aero balance (% front). Learned with an :class:`EwmaBaseline` (time constant 120 s,
    warm-up 10 s of steady data) only in steady flow with no aero alert active, so a
    sudden change stands out against "how this car normally behaves today" - which works
    on a real car whose exact coefficients nobody knows in advance.

    Once warm, a sample is only learned if it lies within a *learning band* around the
    baseline (``LEARN_BAND``: half of the corresponding alert threshold). Otherwise the
    first seconds of a fault - before its alert is raised and freezes learning - would be
    averaged into the very baseline it is compared with.
    """

    SIGNALS = ("cl_fw_l", "cl_fw_r", "cl_rw_l", "cl_rw_r", "cp_ut_mean", "balance")
    #: Learning band per signal: (relative to |baseline|, absolute); the larger applies.
    LEARN_BAND = {"cl_fw_l": (0.10, 0.0), "cl_fw_r": (0.10, 0.0), "cl_rw_l": (0.10, 0.0),
                  "cl_rw_r": (0.10, 0.0), "cp_ut_mean": (0.125, 0.0), "balance": (0.0, 2.0)}

    def __init__(self, tau_s: float = 120.0, warmup_s: float = 10.0) -> None:
        self.baseline = EwmaBaseline(len(self.SIGNALS), tau_s, warmup_s)
        rel, absolute = zip(*(self.LEARN_BAND[k] for k in self.SIGNALS))
        self._band_rel = np.array(rel)
        self._band_abs = np.array(absolute)
        self.current = {k: NAN for k in self.SIGNALS}

    def reset(self) -> None:
        self.baseline.reset()
        self.current = {k: NAN for k in self.SIGNALS}

    def update(self, values: dict[str, float], dt: float, steady: bool, learn_ok: bool = True) -> None:
        """``values``: the current (low-pass filtered) value of each signal."""
        if not steady:
            return
        self.current = {k: float(values.get(k, NAN)) for k in self.SIGNALS}
        if not learn_ok:
            return
        x = np.array([self.current[k] for k in self.SIGNALS])
        mean = self.baseline.mean
        band = np.maximum(self._band_rel * np.abs(np.nan_to_num(mean)), self._band_abs)
        inside = ~self.baseline.warm | (np.abs(np.nan_to_num(x - mean)) <= band)
        self.baseline.update(x, dt, inside)

    def base(self, key: str) -> float:
        i = self.SIGNALS.index(key)
        return float(self.baseline.mean[i]) if self.baseline.warm[i] else NAN

    def ratio(self, keys: Sequence[str]) -> float:
        """Current / baseline of the mean of ``keys`` (e.g. both rear-wing stations)."""
        cur = [self.current[k] for k in keys]
        base = [self.base(k) for k in keys]
        if not all(math.isfinite(v) for v in cur + base):
            return NAN
        b = float(np.mean(base))
        return float(np.mean(cur)) / b if abs(b) > 1e-6 else NAN

    def shift(self, key: str) -> float:
        """Current minus baseline of one signal."""
        b = self.base(key)
        c = self.current[key]
        return c - b if math.isfinite(b) and math.isfinite(c) else NAN
