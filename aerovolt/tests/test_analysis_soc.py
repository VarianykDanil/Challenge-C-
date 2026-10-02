"""Tests for aerovolt.analysis.soc on synthetic data from physics.CellModel.

The "true" cell deliberately differs from the nominal parameters the estimators use
(capacity -1 %, R0 +5 %, R1 +10 %, C1 -10 %): a real pack never matches its datasheet.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from aerovolt.analysis.soc import CoulombCounter, SocEkf, soc_from_voltage
from aerovolt.core import physics
from aerovolt.sim import lapsim
from aerovolt.sim.tracks import get_track
from test_analysis_synthetic import config

DT = 0.05
NAN = float("nan")


def _nominal():
    veh = config().vehicle
    return physics.CellParams.from_vehicle(veh), physics.ocv_table_from_vehicle(veh)


def _drive(seconds: float, soc_true0: float, ekf_soc0: float, offset_a: float, seed: int = 1):
    """Drive laps of fs_endurance with an EKF and a CC; returns (t, true, ekf, cc) arrays."""
    params, table = _nominal()
    true_params = physics.CellParams(params.capacity_ah * 0.99, params.r0_ohm * 1.05, params.r1_ohm * 1.10,
                                     params.c1_f * 0.90, params.parallel)
    cell = physics.CellModel(true_params, table, soc=soc_true0)
    lap = lapsim.solve(get_track(), lapsim.VehicleParams.from_dict(config().vehicle))
    t_lap = np.arange(0.0, lap.lap_time, DT)
    power = np.interp(t_lap, lap.t, lap.power_kw) * 1000.0
    rng = np.random.default_rng(seed)
    ekf = SocEkf(params, table, soc0=ekf_soc0)
    cc = CoulombCounter(params.group_capacity_ah, soc0=soc_true0)
    v = cell.voltage
    rows = []
    for k in range(int(seconds / DT)):
        current = power[k % len(power)] / (140 * v)
        v = cell.step(current, DT)
        i_meas = current + offset_a + rng.normal(0, 0.3)
        v_meas = v + rng.normal(0, 0.002 / math.sqrt(140))  # mean of 140 cells
        ekf.step(i_meas, v_meas, DT)
        cc.step(i_meas, DT)
        rows.append((k * DT, cell.soc, ekf.soc, cc.soc))
    return np.array(rows).T


def test_coulomb_counter_integrates_charge():
    cc = CoulombCounter(16.0)
    assert math.isnan(cc.step(10.0, 1.0))  # not initialised yet
    cc.initialise(0.9)
    for _ in range(360):
        cc.step(16.0, 1.0)  # 1C (16 A on 16 Ah) for 360 s = 1.6 Ah = 10 % SoC
    assert cc.soc == pytest.approx(0.8)
    cc.step(16.0, 30.0)  # a 30 s data gap is not extrapolated beyond 1 s
    cc.step(NAN, 1.0)  # missing current: no change
    assert cc.charge_ah == pytest.approx(1.6 + 16.0 / 3600.0)
    with pytest.raises(ValueError):
        CoulombCounter(0.0)


def test_soc_from_voltage_inverts_ocv_with_ir_correction():
    params, table = _nominal()
    for soc in (0.15, 0.5, 0.93):
        ocv = physics.ocv(soc, table)
        assert soc_from_voltage(ocv, 0.0, params, table) == pytest.approx(soc, abs=1e-9)
        v_load = ocv - 100.0 * params.group_r0
        assert soc_from_voltage(v_load, 100.0, params, table) == pytest.approx(soc, abs=1e-9)
    assert math.isnan(soc_from_voltage(float("nan"), 0.0, params, table))


def test_ekf_measurement_jacobian_matches_finite_difference():
    params, table = _nominal()
    ekf = SocEkf(params, table, soc0=0.63)
    ekf.x[1] = 0.02
    eps = 1e-6
    h0 = ekf.predicted_voltage(50.0)
    ekf.x[0] += eps
    dh_dsoc = (ekf.predicted_voltage(50.0) - h0) / eps
    ekf.x[0] -= eps
    assert dh_dsoc == pytest.approx(physics.docv_dsoc(0.63, table), rel=0.15)
    ekf.x[1] += eps
    assert (ekf.predicted_voltage(50.0) - h0) / eps == pytest.approx(-1.0)


def test_ekf_stays_within_2pct_while_cc_drifts_with_current_offset():
    """+3 A current-sensor offset for 15 minutes of driving."""
    t, true, ekf, cc = _drive(900.0, 0.95, 0.95, offset_a=3.0)
    after = t >= 60.0
    assert np.max(np.abs(ekf[after] - true[after])) < 0.02
    drift = (cc - true)[-1]
    expected = -3.0 * 900.0 / 3600.0 / 16.0  # 3 A for 900 s on 16 Ah = -4.7 % SoC
    # (the true cell has 1 % less capacity than nominal, which offsets ~0.6 % of it)
    assert drift == pytest.approx(expected, rel=0.2)
    assert drift < -0.03


def test_ekf_converges_from_wrong_initial_soc():
    """Started at 70 % while the pack is at 95 %: within 2 % after 120 s of driving."""
    t, true, ekf, cc = _drive(240.0, 0.95, 0.70, offset_a=0.0)
    after = t >= 120.0
    assert np.max(np.abs(ekf[after] - true[after])) < 0.02
    assert np.max(np.abs(cc - true)) < 0.01  # the CC was given the right start here


def test_ekf_handles_missing_measurements():
    params, table = _nominal()
    ekf = SocEkf(params, table, soc0=0.8)
    p0 = ekf.P.copy()
    assert ekf.step(float("nan"), 3.9, 0.05) == 0.8  # no current: nothing done
    ekf.step(10.0, float("nan"), 1.0)  # no voltage: prediction only, uncertainty grows
    assert ekf.soc == pytest.approx(0.8 - 10.0 / 3600.0 / params.group_capacity_ah)
    assert ekf.P[0, 0] > p0[0, 0]
    assert ekf.soc_std > 0
