"""Physics and API tests for the quasi-steady-state lap simulator (SPEC §5.2)."""

import dataclasses
import math
from pathlib import Path

import numpy as np
import pytest
import yaml

from aerovolt.sim import lapsim
from aerovolt.sim.tracks import get_track

G = lapsim.G_ACCEL
VEHICLE_YAML = Path(__file__).resolve().parents[1] / "config" / "vehicle.yaml"


@pytest.fixture(scope="module")
def vehicle() -> dict:
    with open(VEHICLE_YAML, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


@pytest.fixture(scope="module")
def params(vehicle) -> lapsim.VehicleParams:
    return lapsim.VehicleParams.from_dict(vehicle)


@pytest.fixture(scope="module")
def lap(params) -> lapsim.LapResult:
    return lapsim.solve(get_track("fs_endurance"), params)


# ------------------------------------------------------------------ parameters
def test_params_from_yaml(params, vehicle):
    assert params.mass_kg == vehicle["mass_kg"]
    assert params.power_limit_kw == 80.0
    assert params.raw is vehicle


def test_usable_energy_definition(params):
    expected = 140 * 4 * params.cell_capacity_ah * params.cell_v_nom / 1000.0
    expected *= params.soc_window_max - params.soc_window_min
    assert params.usable_energy_kwh == pytest.approx(expected)
    assert params.pack_nominal_voltage == pytest.approx(140 * params.cell_v_nom)


def test_aero_balance_from_element_geometry(vehicle):
    """Moments about the rear axle: a pure front-wing car loads the front axle > 100 %."""
    v = dict(vehicle)
    v["aero"] = dict(vehicle["aero"], share={"front_wing": 1.0, "rear_wing": 0.0, "undertray": 0.0})
    fw = vehicle["aero"]["front_wing"]
    x_cp = fw["le_x_m"] - 0.25 * fw["chord_m"]
    expected = (x_cp + vehicle["wheelbase_m"]) / vehicle["wheelbase_m"]
    assert lapsim.aero_balance_front(v) == pytest.approx(expected)
    assert expected > 1.0


def test_motor_envelope(params):
    base = params.motor_base_omega
    assert params.motor_max_torque(0.5 * base) == pytest.approx(params.motor_peak_torque_nm)
    omega_hi = 0.99 * params.motor_max_omega  # above base speed: constant power
    assert omega_hi > base
    assert params.motor_max_torque(omega_hi) * omega_hi == pytest.approx(params.motor_peak_power_kw * 1e3)
    assert params.motor_max_torque(1.01 * params.motor_max_omega) == 0.0
    arr = params.motor_max_torque(np.array([0.0, base, params.motor_max_omega * 1.1]))
    assert arr.shape == (3,) and arr[-1] == 0.0


def test_motor_efficiency_is_realistic(params):
    rpm = lambda n: n * 2 * math.pi / 60  # noqa: E731
    assert 0.94 <= params.motor_efficiency(150.0, rpm(4000)) <= 0.98
    assert 0.80 <= params.motor_efficiency(220.0, rpm(1000)) <= 0.92
    assert params.motor_efficiency(0.0, rpm(3000)) == 0.0


# ------------------------------------------------------------------ solver physics
def test_skidpad_speed_matches_closed_form(params):
    """Steady cornering: f·m·v²/R = μ·(f·m·g + ½ρ·CL·A_axle·v²) for the limiting axle."""
    skidpad = get_track("skidpad")
    res = lapsim.solve(skidpad, params)
    r = 1.0 / abs(skidpad.kappa[0])
    m, mu, rho = params.mass_kg, params.mu_lat, lapsim.RHO_DEFAULT
    speeds = []
    for f, share in ((params.weight_dist_front, params.aero_balance_front),
                     (1 - params.weight_dist_front, 1 - params.aero_balance_front)):
        k = 0.5 * rho * params.cla * share
        speeds.append(math.sqrt(mu * f * m * G / (f * m / r - mu * k)))
    assert np.allclose(res.v, min(speeds), rtol=1e-9)
    assert res.lap_time == pytest.approx(skidpad.length / min(speeds), rel=1e-6)
    assert np.allclose(res.ax, 0.0, atol=1e-9)


def test_speed_never_exceeds_grip_or_motor(params, lap):
    track = get_track("fs_endurance")
    rho = lapsim.RHO_DEFAULT
    f_z = params.mass_kg * G + 0.5 * rho * params.cla * lap.v**2
    assert np.all(np.abs(lap.ay) * params.mass_kg <= params.mu_lat * f_z * (1 + 1e-9))
    assert lap.v_max <= params.v_motor_max
    assert lap.v.min() > 5.0  # slowest hairpin is still well above walking pace
    assert len(lap.v) == len(track.s)


def test_friction_ellipse_respected_when_braking(params, lap):
    m = params.mass_kg
    f_z = m * G + lap.downforce_n
    roll = params.c_rr * f_z
    brake = -(m * lap.ax + lap.drag_n + roll)  # tyre brake force needed
    braking = brake > 0
    use = (brake[braking] / (params.mu_long * f_z[braking])) ** 2 + (
        m * lap.ay[braking] / (params.mu_lat * f_z[braking])) ** 2
    assert use.max() <= 1.02  # 2 % discretisation tolerance (explicit Δs = 0.5 m steps)
    assert brake.max() <= params.brake_force_max_n * 1.02


def test_power_within_accumulator_and_regen_limits(params, lap):
    assert lap.power_kw.max() == pytest.approx(params.power_limit_kw, rel=1e-6)
    assert lap.power_kw.min() >= -params.regen_max_kw - 1e-9
    slow = lap.v < params.regen_min_speed_ms
    assert np.all(lap.power_kw[slow] >= 0.0)


def test_energy_is_integral_of_power(lap):
    t_ext = np.append(lap.t, lap.lap_time)
    p_ext = np.append(lap.power_kw, lap.power_kw[0])
    e_kwh = np.trapezoid(p_ext, t_ext) / 3600.0
    assert lap.energy_kwh == pytest.approx(e_kwh, rel=1e-9)
    assert 0.0 < lap.regen_kwh < lap.energy_kwh
    drive = np.trapezoid(np.maximum(p_ext, 0), t_ext) / 3600.0
    assert drive > lap.energy_kwh  # regen gives some energy back


def test_time_is_monotonic_and_consistent(lap):
    assert lap.t[0] == 0.0
    assert np.all(np.diff(lap.t) > 0)
    v_mean = np.mean(lap.v)
    assert lap.lap_time == pytest.approx(get_track("fs_endurance").length / v_mean, rel=0.15)


def test_regen_and_brake_split(params, lap):
    braking = lap.power_kw < 0
    assert np.all(lap.motor_torque_nm[braking] < 0)
    assert np.all(lap.brake_force_n >= 0)
    no_regen = lapsim.solve(get_track("fs_endurance"), dataclasses.replace(params, regen_max_kw=0.0))
    assert no_regen.regen_kwh == 0.0
    assert no_regen.energy_kwh > lap.energy_kwh
    assert no_regen.lap_time == pytest.approx(lap.lap_time)  # regen changes energy, not speed


def test_open_track_starts_and_ends_at_rest(params):
    res = lapsim.solve(get_track("acceleration"), params)
    assert res.v[0] == 0.0 and res.v[-1] == pytest.approx(0.0, abs=1e-9)
    assert res.ax[0] > 0.8 * G  # traction-limited launch
    assert res.time_at(75.0) < res.lap_time
    assert np.all(np.diff(res.t) >= 0)
    # launch is traction limited (little power at low speed); the 80 kW limit bites later
    assert res.power_kw[0] < 5.0
    assert res.power_kw.max() == pytest.approx(params.power_limit_kw)


def test_lower_power_limit_is_slower_and_cheaper(params):
    curve = lapsim.energy_vs_power(get_track("fs_endurance"), params, range(40, 85, 10))
    assert [c["kw"] for c in curve] == [40.0, 50.0, 60.0, 70.0, 80.0]
    assert set(curve[0]) == {"kw", "lap_time", "energy_kwh"}
    times = [c["lap_time"] for c in curve]
    energies = [c["energy_kwh"] for c in curve]
    assert times == sorted(times, reverse=True)
    assert energies == sorted(energies)


def test_aero_scale_and_mu_scale(params, lap):
    track = get_track("fs_endurance")
    no_front = lapsim.solve(track, params, aero_scale={"cla_front": 0.75})
    assert no_front.lap_time > lap.lap_time
    draggy = lapsim.solve(track, params, aero_scale={"cda": 1.3})
    assert draggy.energy_kwh > lap.energy_kwh and draggy.v_max < lap.v_max
    wet = lapsim.solve(track, params, mu_scale=0.7)
    assert wet.lap_time > lap.lap_time * 1.1
    thin_air = lapsim.solve(track, params, rho=1.0)
    assert thin_air.lap_time > lap.lap_time
    with pytest.raises(ValueError, match="aero_scale"):
        lapsim.solve(track, params, aero_scale={"cl_front": 0.5})


def test_wind_changes_airspeed_and_result(params, lap):
    track = get_track("acceleration")  # runs due east
    calm = lapsim.solve(track, params)
    head = lapsim.solve(track, params, wind={"speed": 8.0, "dir_deg": 90.0})  # from the east
    tail = lapsim.solve(track, params, wind=lapsim.Wind(8.0, 270.0))
    assert head.time_at(75) > calm.time_at(75) > tail.time_at(75)
    still = lapsim.solve(get_track("fs_endurance"), params, wind=lapsim.Wind(0.0, 0.0))
    assert still.lap_time == pytest.approx(lap.lap_time)


def test_tailwind_component_sign():
    w = lapsim.Wind(5.0, 0.0)  # from the north, blowing south
    assert w.tailwind_component(np.array([180.0]))[0] == pytest.approx(5.0)
    assert w.tailwind_component(np.array([0.0]))[0] == pytest.approx(-5.0)
    assert w.tailwind_component(np.array([90.0]))[0] == pytest.approx(0.0, abs=1e-12)


def test_result_arrays_and_summary(lap):
    n = len(lap.s)
    for name in ("v", "ax", "ay", "t", "power_kw", "motor_torque_nm", "motor_rpm",
                 "brake_force_n", "downforce_n", "drag_n"):
        arr = getattr(lap, name)
        assert arr.shape == (n,) and np.all(np.isfinite(arr)), name
    summary = lap.summary()
    assert summary["lap_time"] == pytest.approx(lap.lap_time, abs=1e-3)
    assert summary["ay_max_g"] > 1.0
    assert lap.motor_rpm.max() <= 6500.0 + 1e-6
