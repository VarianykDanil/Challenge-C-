"""SPEC §5.4 calibration targets for the QSS lap simulator with config/vehicle.yaml."""

import math
import statistics
import time
from pathlib import Path

import pytest
import yaml

from aerovolt.sim import lapsim
from aerovolt.sim.tracks import get_track

G = 9.81
VEHICLE_YAML = Path(__file__).resolve().parents[1] / "config" / "vehicle.yaml"


@pytest.fixture(scope="module")
def params() -> lapsim.VehicleParams:
    with open(VEHICLE_YAML, encoding="utf-8") as fh:
        return lapsim.VehicleParams.from_dict(yaml.safe_load(fh))


@pytest.fixture(scope="module")
def lap80(params) -> lapsim.LapResult:
    return lapsim.solve(get_track("fs_endurance"), params, power_limit_kw=80.0)


def endurance_fraction(params, energy_per_lap_kwh: float) -> float:
    """Fraction of usable energy for the full endurance (laps = ceil(distance / lap))."""
    laps = math.ceil(params.endurance_distance_km * 1000.0 / get_track("fs_endurance").length)
    return energy_per_lap_kwh * laps / params.usable_energy_kwh


def test_endurance_lap_time(lap80):
    assert 55.0 <= lap80.lap_time <= 80.0


def test_top_speed_on_track(lap80):
    assert 95.0 <= lap80.v_max * 3.6 <= 120.0


def test_peak_lateral_acceleration(lap80):
    assert 1.5 <= max(abs(lap80.ay)) / G <= 2.1


def test_peak_braking(lap80):
    assert 1.3 <= -min(lap80.ax) / G <= 1.9


def test_downforce_at_25_ms(params, lap80):
    downforce = 0.5 * 1.2 * params.cla * 25.0**2
    assert downforce == pytest.approx(1350.0, rel=0.15)
    # the solver's downforce channel follows the same law
    i = int(abs(lap80.v - 25.0).argmin())
    assert lap80.downforce_n[i] == pytest.approx(0.5 * 1.2 * params.cla * lap80.v[i] ** 2)


def test_aero_balance_in_range(params):
    assert 0.40 <= params.aero_balance_front <= 0.50


def test_acceleration_event(params):
    res = lapsim.solve(get_track("acceleration"), params)
    assert 3.4 <= res.time_at(75.0) <= 4.5


def test_skidpad_time_per_circle(params):
    res = lapsim.solve(get_track("skidpad"), params)
    assert 4.8 <= res.lap_time / 2.0 <= 5.6  # the figure-of-eight is two timed circles


def test_endurance_energy_at_80kw_exceeds_budget(params, lap80):
    """Usable energy = pack capacity × nominal voltage × SoC window (VehicleParams)."""
    assert 0.95 <= endurance_fraction(params, lap80.energy_kwh) <= 1.10


def test_lower_power_limit_makes_the_endurance_finishable(params):
    """The strategy decision exists: around 55–65 kW the car finishes under ~92 %."""
    curve = lapsim.energy_vs_power(get_track("fs_endurance"), params, [55, 60, 65])
    fractions = [endurance_fraction(params, c["energy_kwh"]) for c in curve]
    assert min(fractions) < 0.92
    assert fractions == sorted(fractions)


def test_solver_under_50ms_per_km(params):
    track = get_track("fs_endurance")
    lapsim.solve(track, params)  # warm-up
    times = []
    for _ in range(5):
        t0 = time.perf_counter()
        lapsim.solve(track, params)
        times.append(time.perf_counter() - t0)
    per_km = statistics.median(times) * 1000.0 / track.length
    assert per_km < 0.050
