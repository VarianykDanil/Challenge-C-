"""Tests for aerovolt.analysis.powertrain."""

from __future__ import annotations

import math

import numpy as np
import pytest

from aerovolt.analysis import powertrain as pt

NAN = float("nan")


def test_power_formulas():
    assert pt.electrical_power_kw(500.0, 160.0) == pytest.approx(80.0)
    assert pt.mechanical_power_kw(200.0, 3000.0) == pytest.approx(200.0 * 3000 * 2 * math.pi / 60 / 1000)
    assert math.isnan(pt.electrical_power_kw(NAN, 10.0))


def test_drive_efficiency_only_when_motoring_above_5kw():
    assert pt.drive_efficiency_pct(45.0, 50.0) == pytest.approx(90.0)
    assert math.isnan(pt.drive_efficiency_pct(3.0, 4.0))  # low power
    assert math.isnan(pt.drive_efficiency_pct(-20.0, -18.0))  # regen
    assert math.isnan(pt.drive_efficiency_pct(NAN, 50.0))


def test_coolant_heat_m_dot_cp_delta_t():
    # 8 L/min of water-glycol (1040 kg/m3, 3600 J/kgK) warming by 5 K
    m_dot = 1040 * 8 / 60000
    assert pt.coolant_heat_kw(8.0, 40.0, 45.0) == pytest.approx(m_dot * 3600 * 5 / 1000)
    assert pt.coolant_heat_kw(0.0, 40.0, 60.0) == 0.0
    assert math.isnan(pt.coolant_heat_kw(8.0, NAN, 45.0))


def test_cell_stats_ignore_nan_and_report_indices():
    v = np.array([3.9, 3.85, NAN, 3.95, 3.7])
    s = pt.cell_stats(v)
    assert (s.min, s.max, s.min_idx, s.max_idx, s.valid) == (3.7, 3.95, 4, 3, 4)
    assert s.spread == pytest.approx(0.25)
    assert s.median == pytest.approx(3.875)
    empty = pt.cell_stats([NAN, NAN])
    assert empty.min_idx is None and math.isnan(empty.mean)


def test_robust_zscores_resist_the_outlier():
    x = np.array([40.0, 40.5, 39.5, 40.2, 39.8, 55.0])
    z = pt.robust_zscores(x)
    assert z[5] > 20  # with mean/std the outlier would inflate sigma and score only ~2
    assert np.all(np.abs(z[:5]) < 2)
    assert np.isnan(pt.robust_zscores([1.0, NAN])).all()
    flat = pt.robust_zscores([5.0, 5.0, 5.0, 6.0])
    assert flat[3] == math.inf and flat[0] == 0.0
    assert pt.robust_zscores([5.0, 5.0, 5.0, 6.0], sigma_floor=0.5)[3] == pytest.approx(2.0)


def test_find_outlier_index_side_and_absolute_floor():
    temps = np.full(60, 40.0) + np.linspace(-0.5, 0.5, 60)
    temps[20] = 46.0
    out = pt.find_outlier(temps, z_threshold=4.0, min_abs=3.0, side="high")
    assert out is not None and out.index == 20 and out.deviation == pytest.approx(6.0, abs=0.1)
    assert pt.find_outlier(temps, z_threshold=4.0, min_abs=3.0, side="low") is None
    assert pt.find_outlier(temps, z_threshold=4.0, min_abs=8.0) is None  # below the floor
    temps[20] = 41.0  # statistically odd but physically irrelevant
    assert pt.find_outlier(temps, z_threshold=4.0, min_abs=3.0) is None


def test_energy_integrator_splits_discharge_and_regen():
    e = pt.EnergyIntegrator()
    for _ in range(3600):
        e.step(36.0, 0.1)  # 36 kW for 360 s = 3.6 kWh
    for _ in range(100):
        e.step(-18.0, 1.0)  # 18 kW of regen for 100 s = 0.5 kWh
    e.step(NAN, 1.0)
    e.step(10.0, 30.0)  # data gap: clipped to 1 s
    assert e.used_kwh == pytest.approx(3.6 + 10.0 / 3600)
    assert e.regen_kwh == pytest.approx(0.5)
    assert e.net_kwh == pytest.approx(e.used_kwh - 0.5)
    e.reset()
    assert e.used_kwh == 0.0


def _cell_cycle(seconds: float, r0_extra: dict[int, float], soc_extra_per_s: dict[int, float], seed: int = 0):
    """Synthetic 140-cell voltages under a varying current: common OCV + per-cell offsets."""
    rng = np.random.default_rng(seed)
    tracker = pt.CellDeviationTracker(140)
    r0 = 0.003 * (1 + rng.uniform(-0.05, 0.05, 140))
    for k, extra in r0_extra.items():
        r0[k] += extra
    dt = 0.1
    for step in range(int(seconds / dt)):
        t = step * dt
        current = 80.0 + 70.0 * math.sin(2 * math.pi * t / 7.0) + 30.0 * math.sin(2 * math.pi * t / 2.3)
        ocv = 3.9 - 0.0003 * t
        v = ocv - current * r0 + rng.normal(0, 0.002, 140)
        for k, rate in soc_extra_per_s.items():
            v[k] -= rate * t  # this cell's OCV falls faster (weak cell)
        tracker.update(v, current, dt)
    return tracker


def test_cell_tracker_finds_high_resistance_cell():
    tracker = _cell_cycle(60.0, {47: 0.009}, {})
    assert tracker.ready
    dr = tracker.resistance_dev_ohm()
    assert int(np.argmax(dr)) == 47
    assert dr[47] == pytest.approx(0.009, rel=0.1)
    out = pt.find_outlier(dr * 1e3, z_threshold=5, min_abs=1.0, side="high")
    assert out is not None and out.index == 47
    assert np.max(np.abs(np.delete(tracker.offset_v(), 47))) < 0.004


def test_cell_tracker_finds_weak_cell_offset():
    tracker = _cell_cycle(90.0, {}, {88: 0.15e-3})  # -0.15 mV/s: -13.5 mV after 90 s
    off = tracker.offset_v() * 1e3
    out = pt.find_outlier(off, z_threshold=5, min_abs=8.0, side="low")
    assert out is not None and out.index == 88
    assert pt.find_outlier(tracker.resistance_dev_ohm() * 1e3, z_threshold=5, min_abs=1.0, side="high") is None


def test_cell_tracker_needs_current_variation_and_tolerates_nan():
    tracker = pt.CellDeviationTracker(4, warmup_s=1.0)
    for _ in range(50):
        tracker.update([3.9, 3.9, NAN, 3.9], 50.0, 0.1)  # constant current: cannot fit dR
    assert not tracker.ready
    assert np.isnan(tracker.offset_v()).all()
    tracker.update([3.9] * 3, 50.0, 0.1)  # wrong length: ignored
