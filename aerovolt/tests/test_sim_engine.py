"""Simulation engine (sim/engine.py): channel coverage, SPEC §5.4 calibration targets,
physical consistency between channels, performance and reproducibility."""

import math
from collections import defaultdict
from pathlib import Path

import numpy as np
import pytest
import yaml

from aerovolt.core import geo, physics
from aerovolt.core.catalog import Catalog
from aerovolt.sim import lapsim
from aerovolt.sim.engine import SimEngine
from aerovolt.sim.tracks import get_track

ROOT = Path(__file__).resolve().parents[1]
G = physics.G
CALM = {"temp_c": 20.0, "pressure_pa": 101325.0, "rh_pct": 50.0, "wind_ms": 0.0, "wind_dir_deg": 0.0}


@pytest.fixture(scope="module")
def vehicle():
    return yaml.safe_load((ROOT / "config" / "vehicle.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def catalog(vehicle):
    return Catalog.load(ROOT / "config" / "sensors.yaml", vehicle)


class Recorder:
    """Collects ``emit(t, values)`` calls as ``{channel: (t array, value array)}``."""

    def __init__(self):
        self.t = defaultdict(list)
        self.v = defaultdict(list)
        self.calls = 0

    def __call__(self, t, values):
        self.calls += 1
        for k, x in values.items():
            self.t[k].append(t)
            self.v[k].append(x)

    def __getitem__(self, cid):
        return np.asarray(self.v[cid])

    def times(self, cid):
        return np.asarray(self.t[cid])

    def at(self, cid, times):
        """Values of ``cid`` at the given sample times (NaN where it was not sampled)."""
        lookup = dict(zip(np.round(self.times(cid), 6), self[cid]))
        return np.array([lookup.get(round(t, 6), np.nan) for t in times])


@pytest.fixture(scope="module")
def two_laps(vehicle, catalog):
    """Two flying laps of fs_endurance in calm air (the calibration run)."""
    engine = SimEngine(vehicle, catalog, "fs_endurance", seed=7, weather=CALM, laps=2, start_temp_c=25.0)
    rec = Recorder()
    stats = engine.run_offline(400.0, rec)
    assert engine.finished
    return engine, rec, stats


# ---------------------------------------------------------------------------- coverage
def test_every_raw_and_truth_channel_is_produced(two_laps, catalog):
    _, rec, _ = two_laps
    produced = set(rec.v)
    missing = set(catalog.raw_ids()) | set(catalog.truth_ids())
    assert missing - produced == set()
    assert produced - set(catalog.raw_ids()) - set(catalog.truth_ids()) == set()  # no calc_*, no unknown
    for cid in produced:
        assert np.all(np.isfinite(rec[cid])), cid


def test_channels_follow_their_catalogue_rates(two_laps, catalog):
    engine, rec, _ = two_laps
    duration = engine.t
    for cid in catalog.raw_ids() + catalog.truth_ids():
        rate = 20.0 if cid.startswith("truth_") else catalog[cid].rate_hz
        expected = rate * duration + 1  # + the full sample at t = 0
        assert len(rec[cid]) == pytest.approx(expected, abs=1.5), cid
        assert rec.times(cid)[0] == 0.0


def test_values_stay_inside_the_sensor_ranges(two_laps, catalog):
    _, rec, _ = two_laps
    for cid in catalog.raw_ids():
        ch = catalog[cid]
        assert rec[cid].min() >= ch.min and rec[cid].max() <= ch.max, cid


def test_tractive_system_start_sequence(two_laps):
    """inv_state 0 → 1 (precharge) → 2 (ready) → 3 (driving) over ≈ 2 s; AIRs, TSAL."""
    _, rec, _ = two_laps
    t, state = rec.times("inv_state"), rec["inv_state"]
    first = {s: t[np.argmax(state == s)] for s in (1, 2, 3)}
    assert state[0] == 0
    assert 0.2 <= first[1] < first[2] < first[3] <= 2.6
    assert np.all(np.diff(state[t <= first[3]]) >= 0)  # never steps backwards
    t20 = rec.times("precharge_done")
    for cid in ("precharge_done", "air_pos_closed", "air_neg_closed", "tsal_state", "sdc_closed"):
        assert rec[cid][t20 > 3.0].min() == 1.0, cid
    assert rec["tsal_state"][0] == 0.0
    moving = rec.times("gps_speed")[rec["gps_speed"] > 1.0]
    assert moving[0] > first[3]  # no movement before ready-to-drive


# ---------------------------------------------------------------------------- SPEC §5.4
def test_lap_time_and_speeds_in_range(two_laps):
    engine, rec, _ = two_laps
    assert len(engine.lap_times) == 2
    for lap_time in engine.lap_times:
        assert 55.0 <= lap_time <= 80.0
    assert abs(engine.lap_times[0] - engine.lap_times[1]) < 0.02 * engine.lap_times[0] + 0.5
    assert 95.0 <= rec["gps_speed"].max() * 3.6 <= 120.0
    assert rec["truth_lap"].max() == 2  # the start of lap 3 ends the run (laps=2)


def test_peak_accelerations_in_range(two_laps):
    _, rec, _ = two_laps
    # 20-sample (0.2 s) moving average removes the IMU noise and chassis vibration
    smooth = lambda x: np.convolve(x, np.ones(20) / 20, mode="valid")
    assert 1.5 <= np.abs(smooth(rec["ay"])).max() / G <= 2.1
    assert 1.3 <= -smooth(rec["ax"]).min() / G <= 1.9


def test_downforce_at_25_ms(two_laps):
    _, rec, _ = two_laps
    v = rec["truth_speed"]
    down = rec["truth_downforce_f"] + rec["truth_downforce_r"]
    near = np.abs(v - 25.0) < 0.5
    assert near.sum() > 10
    assert np.mean(down[near]) == pytest.approx(1350.0, rel=0.15)
    balance = rec["truth_downforce_f"][near] / down[near]
    assert 0.40 <= np.mean(balance) <= 0.50


def test_cla_at_the_reference_ride_height(two_laps, vehicle):
    """truth_cla ≈ cla_ref whenever the car runs at the reference ride heights."""
    _, rec, _ = two_laps
    t = rec.times("truth_cla")
    rh_f, rh_r = rec.at("rh_front", t), rec.at("rh_rear", t)  # NaN at odd 10 ms steps
    with np.errstate(invalid="ignore"):
        ref = (np.abs(rh_f - 30.0) < 1.0) & (np.abs(rh_r - 35.0) < 1.0)
    assert ref.sum() > 20
    assert np.median(rec["truth_cla"][ref]) == pytest.approx(vehicle["aero"]["cla_ref"], rel=0.03)


def test_simulated_cp_ranges(two_laps):
    """SPEC §5.4 Cp ranges, measured like the analysis does it: tap / pitot q at speed."""
    _, rec, _ = two_laps
    q = rec["pitot_dp"]
    fast = q > 250.0
    cp = lambda tap: np.median(rec[tap][fast] / q[fast])
    assert -4.0 <= cp("fw_p01") <= -2.5 and -4.0 <= cp("fw_p07") <= -2.5
    assert -3.5 <= cp("rw_p01") <= -2.0 and -3.5 <= cp("rw_p07") <= -2.0
    assert -3.0 <= cp("ut_p03") <= -1.5
    for tap in ("fw_p05", "fw_p06", "rw_p05", "rw_p06", "rw_p11", "fw_p12"):
        assert 0.2 <= cp(tap) <= 1.0, tap


def test_endurance_energy_at_80_kw(vehicle, catalog):
    """SPEC §5.4: a 22 km endurance at 80 kW needs 95–110 % of the usable energy.

    Usable energy = capacity × v_nom × SoC window, so the fraction used is the charge
    taken out of the cells per lap (ΔSoC) × laps needed / SoC window. Measured on one
    flying lap; a full simulated endurance (24 laps, ≈ 28 s of CPU) ends at ≈ 5.7 % SoC."""
    params = lapsim.VehicleParams.from_dict(vehicle)
    engine = SimEngine(vehicle, catalog, seed=3, weather=CALM, start_soc=90.0, start_temp_c=25.0)
    while engine.lap < 1:
        engine.step()
    soc_start = engine.powertrain.pack.soc_mean
    while engine.lap < 2:
        engine.step()
    used = soc_start - engine.powertrain.pack.soc_mean
    laps = math.ceil(params.endurance_distance_km * 1000.0 / engine.track.length)
    fraction = used * laps / (params.soc_window_max - params.soc_window_min)
    assert 0.95 <= fraction <= 1.10


def test_cells_and_motor_heat_up_plausibly(vehicle, catalog):
    """Five laps from 25 °C: cells warm by I²R (≈ 2 K/lap), the motor winding much faster,
    and the coolant leaving the motor is warmer than the coolant entering the inverter."""
    engine = SimEngine(vehicle, catalog, seed=5, weather=CALM, start_temp_c=25.0, laps=5)
    rec = Recorder()
    engine.run_offline(400.0, rec)
    t_end = rec.times("cell_t_00")[-1]
    temps = np.array([rec[f"cell_t_{j:02d}"][-1] for j in range(60)])
    assert 6.0 <= temps.mean() - 25.0 <= 16.0
    assert temps.max() - temps.min() < 3.0  # a healthy pack is uniform
    assert 60.0 <= rec["mot_winding_temp"][-1] <= 105.0
    assert 30.0 <= rec["inv_igbt_temp"][-1] <= 75.0
    late = rec.times("cool_temp_out") > t_end - 60.0
    assert np.mean(rec["cool_temp_out"][late] - rec["cool_temp_in"][late]) > 0.5
    soc = rec["truth_soc"]
    assert 75.0 <= soc[-1] <= 90.0
    assert rec["bms_soc"][-1] == pytest.approx(soc[-1], abs=1.0)  # BMS Coulomb counter


# ---------------------------------------------------------------------------- consistency
def test_pushrods_minus_inertia_give_the_true_downforce(two_laps, vehicle):
    """The SPEC §6 analysis recipe recovers the simulated downforce from the pushrods."""
    _, rec, _ = two_laps
    t = rec.times("truth_downforce_f")
    unsprung = vehicle["unsprung_mass_corner_kg"]
    ratio = vehicle["suspension"]["pushrod_ratio"]
    loads = sum(physics.wheel_load_from_pushrod(rec.at(f"pushrod_{c}", t), ratio["front" if c[0] == "f" else "rear"], unsprung)
                for c in ("fl", "fr", "rl", "rr"))
    down = loads - vehicle["mass_kg"] * rec.at("az", t)
    truth = rec["truth_downforce_f"] + rec["truth_downforce_r"]
    fast = rec["truth_speed"] > 20.0
    assert np.median(down[fast] - truth[fast]) == pytest.approx(0.0, abs=40.0)


def test_pitot_reads_q_and_wheels_agree_with_gps(two_laps):
    _, rec, _ = two_laps
    t = rec.times("gps_speed")
    v = rec["gps_speed"]
    fast = v > 15.0
    rho = physics.moist_air_density(20.0, 101325.0, 50.0)
    q = rec.at("pitot_dp", t)
    assert np.median(q[fast] / (0.5 * rho * v[fast] ** 2)) == pytest.approx(1.0, abs=0.03)
    ws = np.mean([rec.at(f"ws_{c}", t) for c in ("fl", "fr", "rl", "rr")], axis=0)
    assert np.median(ws[fast] / v[fast]) == pytest.approx(1.0, abs=0.02)


def test_gps_follows_the_track(two_laps, vehicle):
    _, rec, _ = two_laps
    track = get_track("fs_endurance")
    x, y = geo.latlon_to_xy(rec["gps_lat"], rec["gps_lon"], vehicle["gps_origin"])
    dist = []
    for xi, yi in zip(x[::25], y[::25]):
        s = track.nearest_s(xi, yi)
        px, py, _ = track.position_at(s)
        dist.append(math.hypot(xi - px, yi - py))
    assert np.median(dist) < 0.5 and max(dist) < 2.0  # ≈ 0.3 m GPS noise around the line


def test_imu_and_yaw_rate(two_laps):
    _, rec, _ = two_laps
    straight = np.abs(rec["ay"]) < 2.0
    assert np.mean(rec["az"][straight]) == pytest.approx(G, abs=0.1)
    # in corners the body rolls outwards: the z axis tilts away from the turn (−a_y·sin φ)
    assert np.mean(rec["az"][~straight]) < np.mean(rec["az"][straight])
    t = rec.times("gz")
    ay, gz = rec["ay"], np.radians(rec["gz"])
    v = rec.at("gps_speed", t[t <= rec.times("gps_speed")[-1]][::10])
    sel = np.searchsorted(t, t[t <= rec.times("gps_speed")[-1]][::10])
    fast = v > 10.0
    # a_y = v·r for a car following its path (r = yaw rate)
    assert np.corrcoef(ay[sel][fast], v[fast] * gz[sel][fast])[0, 1] > 0.95


def test_pack_and_inverter_measurements_agree(two_laps):
    _, rec, _ = two_laps
    driving = rec["inv_state"] >= 3
    t = rec.times("pack_voltage")
    dv = rec["pack_voltage"] - rec.at("inv_dc_voltage", t)
    i = rec.at("pack_current", t)
    err = np.abs(dv[t > 3.0] - i[t > 3.0] * 0.01)  # cable drop; both sensors σ = 0.2 V
    assert np.median(err) < 0.3 and np.percentile(err, 99.5) < 1.2
    assert np.max(rec["pack_current"]) > 100.0 and np.min(rec["pack_current"]) < -10.0  # regen
    assert driving.any()
    p = rec["pack_voltage"] * rec.at("pack_current", t)
    assert p.max() <= 80_000.0 * 1.03 + 500  # FS power limit (+ noise, cable drop)


def test_cell_voltages_sum_to_the_pack_voltage(two_laps):
    _, rec, _ = two_laps
    t = rec.times("cell_v_000")
    cells = np.sum([rec[f"cell_v_{k:03d}"] for k in range(140)], axis=0)
    pack = rec.at("pack_voltage", t)
    assert np.median(np.abs(cells - pack)) < 0.5


# ---------------------------------------------------------------------------- other tracks
def test_skidpad_circle_time(vehicle, catalog):
    engine = SimEngine(vehicle, catalog, "skidpad", weather=CALM, laps=6)
    engine.run_offline(120.0)
    circles = engine.lap_times[2:]  # once up to speed
    assert all(4.6 <= c <= 6.0 for c in circles)


def test_acceleration_runs_repeat(vehicle, catalog):
    engine = SimEngine(vehicle, catalog, "acceleration", weather=CALM)
    t_go = s_75 = None
    for _ in range(4000):
        engine.step()
        if t_go is None and engine.chassis.v > 0.05:
            t_go = engine.t
        if s_75 is None and engine.chassis.s >= 75.0:
            s_75 = engine.t
    assert 3.4 <= s_75 - t_go <= 4.6
    assert engine.lap >= 2  # stopped in the run-off, paused, started the next run


# ---------------------------------------------------------------------------- engineering
def test_realtime_factor_at_least_10x(vehicle, catalog):
    """SPEC §5.4: ≥ 10× real time on one core (60 s of sim time, all sensors emitted)."""
    engine = SimEngine(vehicle, catalog, seed=1)
    stats = engine.run_offline(60.0, lambda t, v: None)
    print(f"\nreal-time factor: {stats.realtime_factor:.1f}x ({stats.steps} steps, {stats.samples} samples)")
    assert stats.realtime_factor >= 10.0


def test_same_seed_reproduces_the_data(vehicle, catalog):
    def run(seed):
        rec = Recorder()
        SimEngine(vehicle, catalog, seed=seed).run_offline(6.0, rec)
        return rec

    a, b, c = run(11), run(11), run(12)
    for cid in ("fw_p01", "cell_v_047", "ax", "gps_lat", "truth_wind_speed"):
        assert np.array_equal(a[cid], b[cid])
    assert not np.array_equal(a["fw_p01"], c["fw_p01"])


def test_power_limit_and_start_soc_options(vehicle, catalog):
    engine = SimEngine(vehicle, catalog, weather=CALM, power_limit_kw=40.0, start_soc=60.0)
    assert engine.truth()["truth_soc"] == pytest.approx(60.0)
    peak = 0.0
    while engine.t < 30.0:
        engine.step()
        peak = max(peak, engine.powertrain.out.p_dc)
    assert peak == pytest.approx(40_000.0, rel=0.01)
    assert engine.profile.result.power_limit_kw == pytest.approx(40.0)
