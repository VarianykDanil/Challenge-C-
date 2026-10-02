"""Tests for aerovolt.core.physics - every formula against a hand-computed value."""

import math

import numpy as np
import pytest

from aerovolt.core import physics
from aerovolt.core.physics import (
    DEFAULT_NMC_OCV,
    G,
    CellModel,
    CellParams,
    OcvTable,
    airspeed_from_q,
    cell_temp_sensor,
    docv_dsoc,
    dynamic_pressure,
    moist_air_density,
    ocv,
    pushrod_from_wheel_load,
    section_cl,
    temp_sensor_cells,
    wheel_load_from_pushrod,
)

# ---------------------------------------------------------------------------- air


def test_dry_air_isa_sea_level_density():
    assert moist_air_density(15.0, 101325.0, 0.0) == pytest.approx(1.225, abs=0.003)


def test_humid_air_is_lighter_than_dry_air():
    dry = moist_air_density(25.0, 101325.0, 0.0)
    humid = moist_air_density(25.0, 101325.0, 90.0)
    assert humid < dry
    # Hand check: p_sat(25 C) = 3167 Pa (Magnus), p_v = 2850 Pa ->
    # rho = (101325 - 2850)/(287.058*298.15) + 2850/(461.495*298.15) = 1.1506 + 0.0207
    assert humid == pytest.approx(1.1713, abs=0.002)


def test_saturation_vapour_pressure_reference_points():
    assert physics.saturation_vapour_pressure(0.0) == pytest.approx(611.2, rel=0.005)
    assert physics.saturation_vapour_pressure(20.0) == pytest.approx(2339.0, rel=0.005)


def test_air_density_vectorised_and_nan():
    rho = moist_air_density(np.array([15.0, np.nan]), 101325.0, 0.0)
    assert rho[0] == pytest.approx(1.225, abs=0.003)
    assert math.isnan(rho[1])


def test_dynamic_pressure_and_inverse():
    q = dynamic_pressure(1.225, 25.0)
    assert q == pytest.approx(0.5 * 1.225 * 625.0)
    assert airspeed_from_q(q, 1.225) == pytest.approx(25.0)


def test_airspeed_negative_q_is_zero_and_nan_propagates():
    assert airspeed_from_q(-3.0, 1.2) == 0.0
    assert math.isnan(airspeed_from_q(float("nan"), 1.2))


# ---------------------------------------------------------------------------- section Cl


def test_section_cl_identical_surfaces_is_zero():
    xc = [0.05, 0.2, 0.45, 0.75]
    cp = [-3.0, -2.0, -1.0, -0.3]
    assert section_cl(xc, cp, xc, cp) == pytest.approx(0.0, abs=1e-12)


def test_section_cl_synthetic_distribution_hand_computed():
    # Suction: (0, 1) -> (0.5, -2) -> (1, TE); pressure: (0, 1) -> (0.5, 0.5) -> (1, TE)
    # TE = mean(-2, 0.5) = -0.75
    # int suction  = 0.5*(1 - 2)/2 + 0.5*(-2 - 0.75)/2 = -0.25 - 0.6875 = -0.9375
    # int pressure = 0.5*(1 + 0.5)/2 + 0.5*(0.5 - 0.75)/2 = 0.375 - 0.0625 = 0.3125
    # Cl = 0.3125 - (-0.9375) = 1.25
    assert section_cl([0.5], [-2.0], [0.5], [0.5]) == pytest.approx(1.25)


def test_section_cl_realistic_wing_layout_positive_downforce():
    cl = section_cl([0.05, 0.20, 0.45, 0.75], [-3.2, -2.4, -1.5, -0.6], [0.10, 0.50], [0.8, 0.35])
    # trapezoid by hand over the six-tap layout
    te = 0.5 * (-0.6 + 0.35)
    xs = [0, 0.05, 0.20, 0.45, 0.75, 1]
    cs = [1, -3.2, -2.4, -1.5, -0.6, te]
    xp = [0, 0.10, 0.50, 1]
    cpp = [1, 0.8, 0.35, te]
    def trapz(y, x):
        return sum(0.5 * (y[k] + y[k + 1]) * (x[k + 1] - x[k]) for k in range(len(x) - 1))

    expected = trapz(cpp, xp) - trapz(cs, xs)
    assert cl == pytest.approx(expected)
    assert 1.5 < cl < 3.0


def test_section_cl_unsorted_input_and_nan_taps():
    a = section_cl([0.45, 0.05], [-1.5, -3.0], [0.5, 0.1], [0.3, 0.8])
    b = section_cl([0.05, 0.45], [-3.0, -1.5], [0.1, 0.5], [0.8, 0.3])
    assert a == pytest.approx(b)
    with_nan = section_cl([0.05, 0.2, 0.45], [-3.0, float("nan"), -1.5], [0.1, 0.5], [0.8, 0.3])
    assert with_nan == pytest.approx(b)
    assert math.isnan(section_cl([0.1], [float("nan")], [0.5], [0.3]))


# ---------------------------------------------------------------------------- OCV


def test_default_ocv_table_shape():
    assert len(DEFAULT_NMC_OCV.soc) >= 11
    assert DEFAULT_NMC_OCV.v[0] == pytest.approx(3.00)
    assert DEFAULT_NMC_OCV.v[-1] == pytest.approx(4.20)
    assert all(b > a for a, b in zip(DEFAULT_NMC_OCV.v, DEFAULT_NMC_OCV.v[1:]))


def test_ocv_interpolation_and_clamping():
    assert ocv(0.0, DEFAULT_NMC_OCV) == pytest.approx(3.0)
    assert ocv(1.0, DEFAULT_NMC_OCV) == pytest.approx(4.2)
    assert ocv(0.525, DEFAULT_NMC_OCV) == pytest.approx(0.5 * (3.76 + 3.80))
    assert ocv(1.5, DEFAULT_NMC_OCV) == pytest.approx(4.2)
    assert ocv(-0.1, DEFAULT_NMC_OCV) == pytest.approx(3.0)


def test_ocv_table_from_percent_mapping():
    table = OcvTable.from_mapping({"soc": [0, 50, 100], "v": [3.0, 3.7, 4.2]})
    assert table.soc == (0.0, 0.5, 1.0)
    assert ocv(0.25, {"soc": [0, 0.5, 1], "v": [3.0, 3.7, 4.2]}) == pytest.approx(3.35)


def test_ocv_table_validation():
    with pytest.raises(ValueError):
        OcvTable((0.0, 0.5, 0.4), (3.0, 3.5, 3.6))
    with pytest.raises(ValueError):
        OcvTable((0.0, 1.0), (4.2, 3.0))


def test_docv_dsoc_matches_finite_difference_in_the_middle():
    soc = 0.525
    numeric = (ocv(soc + 1e-4) - ocv(soc - 1e-4)) / 2e-4
    assert docv_dsoc(soc) == pytest.approx(numeric, rel=0.05)
    assert docv_dsoc(0.02) > docv_dsoc(0.5)  # steep knee at low SoC


def test_docv_dsoc_is_continuous_across_table_points():
    left = docv_dsoc(0.5 - 1e-9)
    right = docv_dsoc(0.5 + 1e-9)
    assert left == pytest.approx(right, rel=1e-6)


# ---------------------------------------------------------------------------- Cell model

PARAMS = CellParams(capacity_ah=4.0, r0_ohm=0.012, r1_ohm=0.006, c1_f=2500.0, parallel=4)


def test_cell_group_scaling():
    assert PARAMS.group_capacity_ah == 16.0
    assert PARAMS.group_r0 == pytest.approx(0.003)
    assert PARAMS.tau_s == pytest.approx(0.006 * 2500.0)  # parallel count cancels


def test_cell_at_rest_terminal_equals_ocv():
    cell = CellModel(PARAMS, DEFAULT_NMC_OCV, soc=0.8)
    for _ in range(100):
        v = cell.step(0.0, 0.1)
    assert v == pytest.approx(ocv(0.8, DEFAULT_NMC_OCV))


def test_cell_instant_ir_drop_then_rc_relaxation():
    cell = CellModel(PARAMS, DEFAULT_NMC_OCV, soc=0.8)
    i = 100.0
    v0 = cell.voltage
    v_first = cell.step(i, 1e-4)
    assert v0 - v_first == pytest.approx(i * PARAMS.group_r0, rel=0.01)
    # after one time constant the RC voltage reached (1 - 1/e) of I*R1
    dt = 0.01
    steps = int(round(PARAMS.tau_s / dt))
    for _ in range(steps):
        cell.step(i, dt)
    assert cell.v_rc == pytest.approx(i * PARAMS.group_r1 * (1 - math.exp(-1)), rel=1e-3)
    # remove the load: instant recovery of I*R0, then exponential decay of V_rc with tau
    v_rc0 = cell.v_rc
    for _ in range(steps):
        cell.step(0.0, dt)
    assert cell.v_rc == pytest.approx(v_rc0 * math.exp(-1), rel=1e-3)
    assert cell.voltage == pytest.approx(cell.ocv - cell.v_rc)


def test_cell_coulomb_counting():
    cell = CellModel(PARAMS, DEFAULT_NMC_OCV, soc=0.9)
    i, dt = 40.0, 0.5
    for _ in range(360):  # 180 s
        cell.step(i, dt)
    expected = 0.9 - i * 180.0 / (3600.0 * PARAMS.group_capacity_ah)
    assert cell.soc == pytest.approx(expected)


def test_cell_exact_rc_discretisation_independent_of_dt():
    a = CellModel(PARAMS, soc=0.7)
    b = CellModel(PARAMS, soc=0.7)
    a.step(80.0, 10.0)
    for _ in range(1000):
        b.step(80.0, 0.01)
    assert a.v_rc == pytest.approx(b.v_rc, rel=1e-9)
    assert a.voltage == pytest.approx(b.voltage, rel=1e-9)


def test_cell_heat_and_params_from_vehicle():
    vehicle = {"accumulator": {"parallel": 4, "cell": {"capacity_ah": 4.0, "r0_ohm": 0.012,
                                                       "r1_ohm": 0.006, "c1_f": 2500}}}
    params = CellParams.from_vehicle(vehicle)
    assert params == PARAMS
    cell = CellModel(params)
    assert cell.heat_w(100.0) == pytest.approx(100.0 ** 2 * 0.003)
    assert physics.ocv_table_from_vehicle(vehicle) is DEFAULT_NMC_OCV


# ---------------------------------------------------------------------------- mappings


def test_temp_sensor_cells_cover_every_cell_once():
    covered = [k for j in range(60) for k in temp_sensor_cells(j)]
    assert covered == list(range(140))
    assert list(temp_sensor_cells(20)) == [47, 48]
    for j in range(60):
        cells = temp_sensor_cells(j)
        assert 2 <= len(cells) <= 3
        assert {k // 28 for k in cells} == {j // 12}  # never straddles a segment
        for k in cells:
            assert cell_temp_sensor(k) == j


def test_temp_sensor_index_errors():
    with pytest.raises(IndexError):
        temp_sensor_cells(60)
    with pytest.raises(IndexError):
        cell_temp_sensor(140)


def test_pushrod_wheel_load_roundtrip():
    load = 0.47 * 300 * G / 2  # static front corner load
    f = pushrod_from_wheel_load(load, 1.15, 9.0)
    assert f == pytest.approx(1.15 * (load - 9.0 * G))
    assert wheel_load_from_pushrod(f, 1.15, 9.0) == pytest.approx(load)
    arr = pushrod_from_wheel_load(np.array([1000.0, 2000.0]), 1.1, 9.0)
    assert arr.shape == (2,)
