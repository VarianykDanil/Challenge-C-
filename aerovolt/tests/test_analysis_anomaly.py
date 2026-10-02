"""Tests for aerovolt.analysis.anomaly: baselines and sensor-vs-aero classification."""

from __future__ import annotations

import math

import numpy as np
import pytest

from aerovolt.analysis.aero import TapLayout
from aerovolt.analysis.anomaly import AeroHealthMonitor, EwmaBaseline, TapAnomalyDetector
from test_analysis_synthetic import FW_PRESSURE, FW_SUCTION, RW_PRESSURE, RW_SUCTION, UT, config

LAYOUT = TapLayout.from_catalog(config().catalog)
NOMINAL_CP = np.concatenate([FW_SUCTION, FW_PRESSURE, FW_SUCTION, FW_PRESSURE,
                             RW_SUCTION, RW_PRESSURE, RW_SUCTION, RW_PRESSURE, UT])
DT = 0.05


def _run(det: TapAnomalyDetector, seconds: float, modify=None, steady: bool = True, rng=None, t0: float = 0.0):
    rng = rng or np.random.default_rng(0)
    for k in range(int(seconds / DT)):
        t = t0 + k * DT
        cp = NOMINAL_CP * (1.0 + 0.03 * math.sin(0.4 * t)) + rng.normal(0, 0.01, NOMINAL_CP.size)
        if modify is not None:
            cp = modify(cp)
        det.update(cp, DT, steady=steady)
    return t0 + seconds


def test_ewma_baseline_running_mean_then_forgetting():
    b = EwmaBaseline(2, tau_s=10.0, warmup_s=2.0)
    for k in range(40):  # 2 s of samples alternating 1 and 3 -> running mean 2
        b.update([1.0 + 2 * (k % 2), np.nan], 0.05)
    assert b.warm[0] and not b.warm[1]
    assert b.mean[0] == pytest.approx(2.0, abs=0.06)
    assert b.std[0] == pytest.approx(1.0, abs=0.1)
    for _ in range(int(60 / 0.05)):  # step to 5: forgets with tau 10 s
        b.update([5.0, np.nan], 0.05)
    assert b.mean[0] == pytest.approx(5.0, abs=0.01)
    b.update([100.0, 1.0], 0.05, learn=np.array([False, True]))  # selective learning
    assert b.mean[0] == pytest.approx(5.0, abs=0.01) and b.mean[1] == 1.0
    b.reset()
    assert np.isnan(b.mean).all()


def test_single_tap_leak_is_classified_as_sensor_fault():
    det = TapAnomalyDetector(LAYOUT)
    t = _run(det, 30.0)
    assert not det.sensor_fault.any() and not det.clusters
    i = LAYOUT.index("rw_p03")

    def leak(cp):
        cp = cp.copy()
        cp[i] *= 0.1  # tube leak: reads 10 % of the true value
        return cp

    _run(det, 3.0, leak, t0=t)
    findings = det.findings("sensor")
    assert [f.tap for f in findings] == ["rw_p03"]
    assert findings[0].z > 10 and findings[0].baseline == pytest.approx(-1.30, abs=0.1)
    assert set(findings[0].neighbours) == {"rw_p02", "rw_p04"}
    assert det.mask[i] and det.mask.sum() == 1
    assert not det.clusters
    # learning is frozen for the faulty tap: its baseline does not absorb the fault
    _run(det, 60.0, leak, t0=t + 3)
    assert det.baseline.mean[i] == pytest.approx(-1.30, abs=0.1)
    # repaired: clears after reading normally for clear_s
    _run(det, 6.0, None, t0=t + 63)
    assert not det.sensor_fault.any()


def test_left_front_wing_cluster_is_classified_as_aero_change():
    det = TapAnomalyDetector(LAYOUT)
    t = _run(det, 30.0)
    left = [LAYOUT.index(f"fw_p0{k}") for k in (1, 2, 3, 4)]

    def damaged(cp):
        cp = cp.copy()
        cp[left] *= 0.45  # flap damage: station-L suction -55 %
        return cp

    _run(det, 3.0, damaged, t0=t)
    assert not det.sensor_fault.any()
    assert len(det.clusters) == 1
    c = det.clusters[0]
    assert (c.element, c.station, c.surface, c.direction) == ("fw", "L", "suction", 1)
    assert c.taps == ("fw_p01", "fw_p02", "fw_p03", "fw_p04")


def test_two_neighbouring_taps_form_a_cluster():
    det = TapAnomalyDetector(LAYOUT)
    t = _run(det, 30.0)
    pair = [LAYOUT.index("fw_p02"), LAYOUT.index("fw_p03")]

    def drop(cp):
        cp = cp.copy()
        cp[pair] *= 0.5
        return cp

    _run(det, 3.0, drop, t0=t)
    assert not det.sensor_fault.any()
    assert [c.taps for c in det.clusters] == [("fw_p02", "fw_p03")]


def test_no_decisions_or_learning_outside_steady_flow():
    det = TapAnomalyDetector(LAYOUT)
    _run(det, 30.0, steady=False)
    assert not det.baseline.warm.any()
    assert np.isfinite(det.cp_lp).all()  # the smoothed Cp is still tracked
    t = _run(det, 30.0)
    i = LAYOUT.index("ut_p03")
    _run(det, 5.0, lambda cp: np.where(np.arange(cp.size) == i, 0.0, cp), steady=False, t0=t)
    assert not det.sensor_fault.any()  # held: judged only in steady flow


def test_warm_up_needed_before_judging():
    det = TapAnomalyDetector(LAYOUT, warmup_s=20.0)
    _run(det, 10.0)
    i = LAYOUT.index("rw_p03")
    _run(det, 3.0, lambda cp: np.where(np.arange(cp.size) == i, 0.0, cp), t0=10.0)
    assert not det.sensor_fault.any()


def test_aero_health_monitor_baseline_ratio_and_learning_band():
    mon = AeroHealthMonitor(warmup_s=5.0)
    good = {"cl_fw_l": 1.8, "cl_fw_r": 1.8, "cl_rw_l": 1.5, "cl_rw_r": 1.5, "cp_ut_mean": -1.25, "balance": 45.5}
    for _ in range(200):
        mon.update(good, DT, steady=True)
    assert mon.base("balance") == pytest.approx(45.5)
    assert mon.ratio(("cl_rw_l", "cl_rw_r")) == pytest.approx(1.0)
    stalled = dict(good, cl_rw_l=0.9, cl_rw_r=0.9, balance=58.0)
    for _ in range(2000):  # 100 s of a stalled wing without any alert freezing learning
        mon.update(stalled, DT, steady=True)
    assert mon.ratio(("cl_rw_l", "cl_rw_r")) == pytest.approx(0.6)  # not absorbed
    assert mon.shift("balance") == pytest.approx(12.5)
    mon.update(good, DT, steady=False)  # not steady: current values held
    assert mon.current["balance"] == 58.0
    mon.reset()
    assert math.isnan(mon.base("balance")) and math.isnan(mon.shift("balance"))
