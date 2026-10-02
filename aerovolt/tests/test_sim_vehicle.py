"""Vehicle model (sim/vehicle_model.py): track cursor, profile, driver, chassis."""

import math
from pathlib import Path

import numpy as np
import pytest
import yaml

from aerovolt.core import physics
from aerovolt.sim import lapsim
from aerovolt.sim.tracks import get_track
from aerovolt.sim.vehicle_model import Chassis, Driver, SpeedProfile, TrackCursor

ROOT = Path(__file__).resolve().parents[1]
DT = 0.01
G = physics.G


@pytest.fixture(scope="module")
def vehicle():
    return yaml.safe_load((ROOT / "config" / "vehicle.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def params(vehicle):
    return lapsim.VehicleParams.from_dict(vehicle)


@pytest.fixture()
def chassis(vehicle):
    return Chassis(vehicle, np.random.default_rng(0), DT)


# ---------------------------------------------------------------------------- track
@pytest.mark.parametrize("name", ["fs_endurance", "skidpad", "acceleration"])
def test_cursor_matches_track_interpolation(name):
    track = get_track(name)
    cur = TrackCursor(track)
    for s in np.linspace(0.0, track.length, 37):
        x, y, theta, _ = cur.at(float(s))
        tx, ty, th = track.position_at(float(s))
        assert (x, y) == pytest.approx((tx, ty), abs=1e-6)
        assert cur.heading_deg(theta) == pytest.approx(th, abs=1e-6) or abs(cur.heading_deg(theta) - th) == pytest.approx(360.0)


def test_cursor_wraps_closed_tracks():
    track = get_track("fs_endurance")
    cur = TrackCursor(track)
    assert cur.at(-10.0)[:2] == pytest.approx(cur.at(track.length - 10.0)[:2])
    assert cur.at(3 * track.length + 5.0)[:2] == pytest.approx(cur.at(5.0)[:2])
    assert abs(cur.turn_per_lap) == pytest.approx(2.0 * math.pi, abs=1e-6)


def test_start_gate_positions():
    assert TrackCursor(get_track("fs_endurance")).gate_positions() == [0.0]
    skid = get_track("skidpad")
    gates = TrackCursor(skid).gate_positions()
    assert len(gates) == 2  # crossed once per circle
    assert gates[1] - gates[0] == pytest.approx(skid.length / 2.0, abs=1.0)


def test_speed_profile_follows_the_lap_sim(params):
    track = get_track("fs_endurance")
    result = lapsim.solve(track, params)
    prof = SpeedProfile(track, result)
    for i in (0, 100, 1000, len(track.s) - 1):
        v, a = prof.at(float(track.s[i]))
        assert v == pytest.approx(result.v[i]) and a == pytest.approx(result.ax[i])
    assert prof.at(track.length + 1.0)[0] == pytest.approx(prof.at(1.0)[0])


# ---------------------------------------------------------------------------- chassis
def test_static_loads_pushrods_and_imu_at_rest(chassis, vehicle):
    s = chassis.suspension(0.0, 0.0, 0.0, 0.0)
    m = vehicle["mass_kg"]
    assert sum(s.load) == pytest.approx(m * G)
    assert (s.load[0] + s.load[1]) / (m * G) == pytest.approx(vehicle["weight_dist_front"])
    chassis.set_suspension(s)
    push = chassis.pushrods()
    assert push[0] == pytest.approx(physics.pushrod_from_wheel_load(s.load[0], 1.15, 9.0))
    assert 600.0 < push[0] < 800.0  # "static ~700 N per corner"
    assert chassis.dampers() == pytest.approx((0.0, 0.0, 0.0, 0.0))
    assert (s.rh_front, s.rh_rear) == pytest.approx((30.0, 35.0))
    assert chassis.imu() == pytest.approx((0.0, 0.0, G))


def test_aero_load_compresses_the_springs(chassis, vehicle):
    s = chassis.suspension(0.0, 0.0, 600.0, 700.0)
    k = vehicle["suspension"]["wheel_rate_n_per_mm"]
    assert s.rh_front == pytest.approx(30.0 - 300.0 / k["front"])
    assert s.rh_rear == pytest.approx(35.0 - 350.0 / k["rear"])
    assert sum(s.load) == pytest.approx(vehicle["mass_kg"] * G + 1300.0)


def test_load_transfer_pitch_and_roll(chassis, vehicle):
    m, h, L = vehicle["mass_kg"], vehicle["cg_height_m"], vehicle["wheelbase_m"]
    brake = chassis.suspension(-1.5 * G, 0.0, 0.0, 0.0)
    rest = chassis.suspension(0.0, 0.0, 0.0, 0.0)
    assert (brake.load[0] + brake.load[1]) - (rest.load[0] + rest.load[1]) == pytest.approx(m * 1.5 * G * h / L)
    assert brake.pitch_deg > 0.0  # nose down (ISO pitch +)
    left = chassis.suspension(0.0, 1.5 * G, 0.0, 0.0)  # left turn: load to the right wheels
    assert left.load[1] > left.load[0] and left.load[3] > left.load[2]
    assert left.roll_deg > 0.0  # right side down (ISO roll +)
    assert sum(left.load) == pytest.approx(m * G)


def test_imu_specific_force_in_a_pitched_body(chassis):
    chassis.ax = -10.0
    s = chassis.suspension(-10.0, 0.0, 0.0, 0.0)
    chassis.set_suspension(s)
    ax, ay, az = chassis.imu()
    th = math.radians(s.pitch_deg)
    assert ax == pytest.approx(-10.0 * math.cos(th) - G * math.sin(th))
    assert az == pytest.approx(G * math.cos(th) - 10.0 * math.sin(th), abs=1e-9)


def test_road_roughness_is_seen_by_pushrods_and_az_consistently(chassis):
    """Σ wheel load − m·(az) = downforce, exactly: what the analysis relies on."""
    chassis.v = 25.0
    chassis.step_road(25.0)
    s = chassis.suspension(0.0, 0.0, 500.0, 600.0)
    chassis.set_suspension(s)
    az = chassis.imu()[2]
    assert sum(s.load) - chassis.mass * az == pytest.approx(1100.0, abs=0.01)  # cos(pitch) ≈ 1
    assert s.heave_force != 0.0


def test_wheel_speeds_corner_geometry_and_slip(chassis, vehicle):
    chassis.v = 10.0
    kappa = 1.0 / 10.0  # left turn, R = 10 m
    fl, fr, rl, rr = chassis.wheel_speeds(kappa, 0.0, 0.0)
    assert fl == pytest.approx(10.0 * (1 - kappa * vehicle["track_front_m"] / 2))
    assert fr > fl and rr > rl  # outer (right) wheels faster
    _, _, rl_slip, _ = chassis.wheel_speeds(0.0, 0.0, 0.05)
    assert rl_slip == pytest.approx(10.5)
    assert chassis.slip(1000.0, 2000.0) == pytest.approx(1000.0 / (chassis.SLIP_STIFFNESS * 2000.0))


def test_steering_is_ackermann_plus_understeer(chassis, vehicle):
    chassis.ay = 0.0
    kappa = 1.0 / 6.0
    angles = [chassis.steering_wheel_deg(kappa) for _ in range(2000)]
    expected = vehicle["steering"]["ratio"] * math.degrees(math.atan(vehicle["wheelbase_m"] * kappa))
    assert np.mean(angles) == pytest.approx(expected, abs=0.2)
    chassis.ay = G
    assert np.mean([chassis.steering_wheel_deg(kappa) for _ in range(2000)]) == pytest.approx(
        expected + vehicle["steering"]["ratio"] * vehicle["steering"]["understeer_deg_per_g"], abs=0.2)


def test_advance_never_reverses(chassis):
    chassis.v = 0.5
    chassis.advance(DT, -100_000.0, 0.0)
    assert chassis.v == 0.0
    chassis.advance(DT, 3000.0, 0.1)
    assert chassis.v == pytest.approx(3000.0 / chassis.mass * DT)
    assert chassis.ay == pytest.approx(chassis.v**2 * 0.1)


# ---------------------------------------------------------------------------- driver
def test_driver_follows_the_profile_with_a_point_mass(params):
    """Closed loop on a simple point mass: the PI driver tracks the lap-sim speed."""
    track = get_track("fs_endurance")
    prof = SpeedProfile.solve(track, params)
    drv = Driver(params, np.random.default_rng(0))
    s, v, errors = 0.0, float(prof.at(0.0)[0]), []
    for _ in range(6000):
        resist = 0.5 * 1.2 * params.cda * v * v + params.c_rr * params.mass_kg * G
        cmd = drv.control(DT, s, v, prof, may_drive=True, resist_n=resist, torque_cut=False)
        force = cmd.pedal_pct / 100.0 * drv.t_peak * drv.wheel_per_nm - cmd.brake_force_n - resist
        v = max(v + force / drv.mass * DT, 0.0)
        s += v * DT
        errors.append(v - prof.at(s + v * Driver.LOOKAHEAD_S)[0])  # the driver's target
    assert np.sqrt(np.mean(np.square(errors[200:]))) < 1.0
    assert s == pytest.approx(prof.result.s[-1] * 60.0 / prof.result.lap_time, rel=0.05)


def test_driver_stops_when_not_allowed_to_drive(params):
    drv = Driver(params, np.random.default_rng(0))
    prof = SpeedProfile.solve(get_track("fs_endurance"), params)
    moving = drv.control(DT, 0.0, 20.0, prof, may_drive=False, resist_n=0.0, torque_cut=False)
    assert moving.pedal_pct == 0.0 and moving.brake_force_n == pytest.approx(params.mass_kg * 0.5 * G)
    parked = drv.control(DT, 0.0, 0.0, prof, may_drive=False, resist_n=0.0, torque_cut=False)
    assert parked.brake_force_n == drv.HOLD_BRAKE_N


def test_driver_lifts_after_a_torque_cut(params):
    drv = Driver(params, np.random.default_rng(0))
    prof = SpeedProfile.solve(get_track("fs_endurance"), params)
    pedals = [drv.control(DT, 0.0, 5.0, prof, may_drive=True, resist_n=0.0, torque_cut=True).pedal_pct
              for _ in range(100)]
    assert pedals[0] > 50.0      # still pushing right after the cut
    assert pedals[-1] == 0.0     # lifted off so the plausibility check can reset


def test_lap_to_lap_variation_is_seeded_and_small(params):
    a, b = Driver(params, np.random.default_rng(4)), Driver(params, np.random.default_rng(4))
    fa, fb = [], []
    for _ in range(50):
        a.new_lap()
        b.new_lap()
        fa.append(a.lap_factor)
        fb.append(b.lap_factor)
    assert fa == fb
    assert max(abs(f - 1.0) for f in fa) <= Driver.LAP_VARIATION
    assert np.std(fa) > 0.002
