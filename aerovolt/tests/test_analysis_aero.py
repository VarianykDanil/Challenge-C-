"""Tests for aerovolt.analysis.aero: air data, Cp, section Cl, downforce, drag, filters."""

from __future__ import annotations

import math

import numpy as np
import pytest

from aerovolt.analysis import aero
from aerovolt.analysis.aero import AeroEstimator, ChassisParams, LowPass, TapLayout
from aerovolt.core import physics
from test_analysis_synthetic import SyntheticCar, config, drive, make_processor

NAN = float("nan")
P = ChassisParams.from_vehicle(config().vehicle)


# ---------------------------------------------------------------- air data

def test_air_density_matches_physics_and_tolerates_missing_humidity():
    assert aero.air_density(15.0, 101325.0, 0.0) == pytest.approx(1.225, abs=0.001)
    assert aero.air_density(20.0, 101325.0, NAN) == pytest.approx(physics.moist_air_density(20.0, 101325.0, 50.0))
    assert math.isnan(aero.air_density(NAN, 101325.0, 50.0))


def test_dynamic_pressure_prefers_pitot_and_falls_back_to_gps():
    assert aero.dynamic_pressure(300.0, 20.0, 1.2) == (300.0, "pitot")
    q, src = aero.dynamic_pressure(NAN, 20.0, 1.2)
    assert src == "gps" and q == pytest.approx(0.5 * 1.2 * 400.0)
    q, src = aero.dynamic_pressure(5.0, 20.0, 1.2, pitot_ok=False)  # blocked pitot flagged
    assert src == "gps" and q == pytest.approx(240.0)
    assert aero.dynamic_pressure(-3.0, NAN, 1.2) == (0.0, "pitot")  # zero offset at rest
    q, src = aero.dynamic_pressure(NAN, NAN, 1.2)
    assert math.isnan(q) and src == "none"


def test_airspeed_inverts_dynamic_pressure():
    assert aero.airspeed(physics.dynamic_pressure(1.2, 25.0), 1.2) == pytest.approx(25.0)
    assert aero.airspeed(240.0, NAN) == pytest.approx(20.0)  # fallback density 1.2
    assert math.isnan(aero.airspeed(NAN, 1.2))


# ---------------------------------------------------------------- taps

def test_tap_layout_from_catalogue():
    lay = TapLayout.from_catalog(config().catalog)
    assert len(lay) == 32
    st = lay.stations["rw_l"]
    assert [lay.ids[i] for i in st.suction] == ["rw_p01", "rw_p02", "rw_p03", "rw_p04"]
    assert st.xc_pressure == (0.10, 0.50)
    nb = {lay.ids[j] for j in lay.neighbours[lay.index("rw_p03")]}
    assert nb == {"rw_p02", "rw_p04"}
    # tunnel taps are neighbours of the centreline tap at the same floor position
    assert lay.index("ut_p05") in lay.neighbours[lay.index("ut_p07")]
    assert lay.index("fw_p07") not in lay.neighbours[lay.index("fw_p01")]  # other station


def test_pressure_coefficients_only_above_60_pa():
    taps = np.array([-600.0, 120.0])
    assert aero.pressure_coefficients(taps, 300.0) == pytest.approx([-2.0, 0.4])
    assert np.isnan(aero.pressure_coefficients(taps, 50.0)).all()
    assert np.isnan(aero.pressure_coefficients(taps, NAN)).all()


def test_station_cl_skips_masked_taps():
    lay = TapLayout.from_catalog(config().catalog)
    cp = np.full(32, NAN)
    st = lay.stations["fw_l"]
    cp[list(st.suction)] = [-3.3, -2.5, -1.55, -0.65]
    cp[list(st.pressure)] = [0.8, 0.38]
    full = aero.station_cl(lay, cp, "fw_l")
    assert full == pytest.approx(physics.section_cl(st.xc_suction, [-3.3, -2.5, -1.55, -0.65],
                                                    st.xc_pressure, [0.8, 0.38]))
    assert 1.5 < full < 2.5  # a typical FS front-wing section
    cp[st.suction[2]] = NAN  # excluded tap: interpolated across, small change
    assert aero.station_cl(lay, cp, "fw_l") == pytest.approx(full, rel=0.05)
    assert math.isnan(aero.station_cl(lay, np.full(32, NAN), "fw_l"))


def test_fw_asymmetry_sign_and_gating():
    assert aero.fw_asymmetry_pct(1.0, 2.0) == pytest.approx(-66.67, rel=1e-3)
    assert aero.fw_asymmetry_pct(2.0, 2.0) == 0.0
    assert math.isnan(aero.fw_asymmetry_pct(0.1, 0.1))
    assert math.isnan(aero.fw_asymmetry_pct(NAN, 2.0))


# ---------------------------------------------------------------- loads and forces

def _pushrods(front: float, rear: float, lateral: float = 0.0) -> list[float]:
    """Pushrod forces for given axle loads, with lateral transfer between the wheels."""
    out = []
    for load, ratio in ((front / 2 - lateral, P.pushrod_ratio_front), (front / 2 + lateral, P.pushrod_ratio_front),
                        (rear / 2 - lateral, P.pushrod_ratio_rear), (rear / 2 + lateral, P.pushrod_ratio_rear)):
        out.append(physics.pushrod_from_wheel_load(load, ratio, P.unsprung_kg_corner))
    return out


def test_axle_loads_invert_pushrod_model():
    f, r = aero.axle_loads(_pushrods(1500.0, 1700.0), P)
    assert (f, r) == (pytest.approx(1500.0), pytest.approx(1700.0))
    assert math.isnan(aero.axle_loads([NAN, 1, 1, 1], P)[0])


@pytest.mark.parametrize("ax", [-12.0, 0.0, 9.0])
@pytest.mark.parametrize("lateral", [0.0, 400.0])
def test_downforce_removes_weight_inertia_and_load_transfer(ax, lateral):
    """Known downforce in -> same downforce out, whatever the accelerations. Lateral
    transfer moves load between wheels of one axle and cancels in the axle sums."""
    m, g = P.mass_kg, physics.G
    lift_f, lift_r, az = 600.0, 750.0, 10.3
    transfer = m * ax * P.cg_height_m / P.wheelbase_m
    front = P.weight_dist_front * m * az - transfer + lift_f
    rear = (1 - P.weight_dist_front) * m * az + transfer + lift_r
    f, r = aero.axle_loads(_pushrods(front, rear, lateral), P)
    lf, lr = aero.downforce_from_axle_loads(f, r, ax, az, P)
    assert lf == pytest.approx(lift_f, abs=1e-6) and lr == pytest.approx(lift_r, abs=1e-6)
    assert aero.total_downforce(f, r, az, P) == pytest.approx(lift_f + lift_r, abs=1e-6)
    assert m * g > 0


def test_downforce_needs_ax_for_split_but_not_total():
    f, r = 1500.0, 1700.0
    assert all(math.isnan(x) for x in aero.downforce_from_axle_loads(f, r, NAN, 9.81, P))
    assert aero.total_downforce(f, r, NAN, P) == pytest.approx(f + r - P.mass_kg * physics.G)


def test_drag_from_force_balance():
    drag, lift, ax = 500.0, 1300.0, 1.5
    rolling = P.c_rr * (P.mass_kg * physics.G + lift)
    force = P.mass_kg * ax + drag + rolling
    torque = force * P.wheel_radius_m / (P.gear_ratio * P.driveline_efficiency)
    assert aero.drive_force(torque, P) == pytest.approx(force)
    assert aero.aero_drag(torque, ax, lift, P) == pytest.approx(drag)
    assert math.isnan(aero.aero_drag(NAN, ax, lift, P))


def test_fit_cla_least_squares_through_origin():
    rng = np.random.default_rng(3)
    q = rng.uniform(50, 600, 400)
    f = 3.6 * q + rng.normal(0, 20, q.size)
    f[::50] = NAN
    assert aero.fit_cla(q, f) == pytest.approx(3.6, rel=0.01)
    assert aero.fit_cla([1.0, 2.0], [2.0, 4.0]) == pytest.approx(2.0)
    assert math.isnan(aero.fit_cla([NAN], [1.0]))


# ---------------------------------------------------------------- filter

def test_low_pass_step_response_and_nan_hold():
    lp = LowPass(2.0)
    assert lp.update(0.0, 0.1) == 0.0  # first sample initialises
    for _ in range(20):  # 2 s = one time constant at dt 0.1
        lp.update(1.0, 0.1)
    assert lp.value == pytest.approx(1 - math.exp(-1), abs=1e-9)
    held = lp.value
    assert lp.update(NAN, 0.1) == held
    lp.reset()
    assert math.isnan(lp.value)
    with pytest.raises(ValueError):
        LowPass(0.0)


# ---------------------------------------------------------------- estimator

def test_estimator_is_nan_safe_without_data():
    est = AeroEstimator(config().catalog, config().vehicle)
    out = est.update(0.05, {})
    assert out.q_source == "none" and not out.steady
    assert all(math.isnan(v) for v in out.channels.values())
    expected = {cid for cid in config().catalog.ids(system="calc")
                if cid.startswith(("calc_cp_", "calc_cl_")) or cid in {
                    "calc_rho", "calc_q", "calc_airspeed", "calc_yaw", "calc_cp_ut_mean", "calc_downforce_f",
                    "calc_downforce_r", "calc_downforce", "calc_aero_balance", "calc_cla", "calc_cda",
                    "calc_drag", "calc_ld", "calc_fw_asym"}}
    assert set(out.channels) == expected


def test_estimator_recovers_cla_cda_and_balance_on_synthetic_laps():
    car = SyntheticCar(wind=(3.0, 225.0))
    proc, store = make_processor()
    drive(car, proc, store, 125.0)
    lap2 = proc.laps[1]
    assert lap2.cla_avg == pytest.approx(car.cla, rel=0.03)
    assert lap2.cda_avg == pytest.approx(car.cda, rel=0.06)
    assert lap2.balance_avg == pytest.approx(car.balance * 100, abs=1.0)
    assert store.latest("calc_rho") == pytest.approx(car.rho, rel=1e-6)


def test_drag_only_estimated_while_driven():
    est = AeroEstimator(config().catalog, config().vehicle)
    base = {"pitot_dp": 400.0, "amb_temp": 20.0, "amb_press": 101325.0, "amb_rh": 50.0, "ax": 0.5, "ay": 0.0,
            "mot_torque": 80.0, "brake_press_f": 0.2, "brake_press_r": 0.1}
    assert math.isfinite(est.update(0.05, base).channels["calc_drag"])
    braking = dict(base, brake_press_f=25.0)
    assert math.isnan(est.update(0.05, braking).channels["calc_drag"])
    regen = dict(base, mot_torque=-40.0)
    assert math.isnan(est.update(0.05, regen).channels["calc_drag"])
