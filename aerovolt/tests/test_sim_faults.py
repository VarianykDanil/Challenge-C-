"""Fault injection (sim/faults.py): registry, scheduling and the physical signature of
every SPEC §5.5 fault, as seen in the emitted sensor data."""

from collections import defaultdict
from pathlib import Path

import numpy as np
import pytest
import yaml

from aerovolt.core.catalog import Catalog
from aerovolt.core.model import FaultInfo
from aerovolt.sim import faults as faults_mod
from aerovolt.sim.engine import SimEngine
from aerovolt.sim.faults import FAULTS, parse_schedule

ROOT = Path(__file__).resolve().parents[1]
WEATHER = {"temp_c": 20.0, "pressure_pa": 101325.0, "rh_pct": 50.0, "wind_ms": 2.0, "wind_dir_deg": 200.0}
SPEC_FAULTS = {
    "fw_damage_left": ("aero", {"aero_fw_asymmetry", "aero_balance_shift"}),
    "rw_stall": ("aero", {"aero_rw_suction_loss", "aero_balance_shift"}),
    "ut_bottoming": ("aero", {"aero_ut_stall"}),
    "pitot_blocked": ("aero", {"sensor_pitot_implausible"}),
    "tap_leak": ("aero", {"sensor_tap_anomaly"}),
    "crosswind_gust": ("aero", {"aero_high_yaw"}),
    "cell_hot": ("powertrain", {"bms_cell_voltage_outlier", "bms_cell_temp_outlier"}),
    "cell_weak": ("powertrain", {"bms_cell_voltage_outlier"}),
    "pump_fail": ("powertrain", {"cooling_no_flow", "motor_temp_high"}),
    "imd_fault": ("powertrain", {"safety_imd_trip", "safety_sdc_open"}),
    "current_offset": ("powertrain", {"bms_soc_divergence"}),
    "apps_implausible": ("powertrain", {"safety_apps_implausible"}),
}


@pytest.fixture(scope="module")
def vehicle():
    return yaml.safe_load((ROOT / "config" / "vehicle.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def catalog(vehicle):
    return Catalog.load(ROOT / "config" / "sensors.yaml", vehicle)


class Run:
    """An engine run with every emitted sample kept as (t, value) arrays."""

    def __init__(self, vehicle, catalog, seconds, faults=(), **kw):
        kw.setdefault("weather", WEATHER)
        self.engine = SimEngine(vehicle, catalog, faults=faults, **kw)
        self._t, self._v = defaultdict(list), defaultdict(list)
        self.engine.run_offline(seconds, self._emit)

    def _emit(self, t, values):
        for k, x in values.items():
            self._t[k].append(t)
            self._v[k].append(x)

    def window(self, cid, t0, t1):
        t, v = np.asarray(self._t[cid]), np.asarray(self._v[cid])
        return v[(t >= t0) & (t < t1)]

    def continue_for(self, seconds):
        self.engine.run_offline(seconds, self._emit)


@pytest.fixture(scope="module")
def baseline(vehicle, catalog):
    """130 s without faults (two laps) for comparisons."""
    return Run(vehicle, catalog, 130.0, seed=21)


# ---------------------------------------------------------------------------- registry
def test_registry_matches_the_spec():
    assert set(FAULTS) == set(SPEC_FAULTS)
    for fid, (system, alerts) in SPEC_FAULTS.items():
        f = FAULTS[fid]
        assert f.system == system and set(f.alerts) == alerts
        assert f.title and f.description


def test_fault_infos_and_toggling(vehicle, catalog):
    engine = SimEngine(vehicle, catalog)
    infos = engine.fault_infos()
    assert all(isinstance(i, FaultInfo) and not i.active for i in infos)
    assert [i.id for i in infos] == list(FAULTS)
    assert engine.set_fault("pitot_blocked", True) is True
    assert engine.set_fault("pitot_blocked", True) is False  # no change
    assert {i.id for i in engine.fault_infos() if i.active} == {"pitot_blocked"}
    engine.set_fault("pitot_blocked", False)
    assert not any(i.active for i in engine.fault_infos())
    with pytest.raises(KeyError):
        engine.set_fault("flux_capacitor", True)


def test_schedule_parsing():
    sched = parse_schedule(["cell_hot@60", {"id": "pump_fail", "t": 12.5}])
    assert [(s.id, s.t) for s in sched] == [("pump_fail", 12.5), ("cell_hot", 60.0)]
    with pytest.raises(ValueError):
        parse_schedule(["cell_hot"])
    with pytest.raises(KeyError):
        parse_schedule(["nope@3"])


def test_scheduled_activation_and_timeline(vehicle, catalog):
    run = Run(vehicle, catalog, 6.0, faults=["current_offset@2.5", {"id": "tap_leak", "t": 4}])
    tl = run.engine.faults.timeline
    assert [(e["id"], e["t"], e["active"]) for e in tl] == [("current_offset", 2.5, True), ("tap_leak", 4.0, True)]


# ---------------------------------------------------------------------------- sensor faults
def test_pitot_blocked_reads_zero(vehicle, catalog):
    run = Run(vehicle, catalog, 30.0, faults=["pitot_blocked@20"])
    assert run.window("pitot_dp", 10, 20).mean() > 80.0
    after = run.window("pitot_dp", 20.3, 30)
    assert np.abs(after).max() < 5.0
    assert run.window("rw_p01", 20.3, 30).mean() < -100.0  # the taps still see the flow


def test_tap_leak_reads_ten_percent(vehicle, catalog):
    run = Run(vehicle, catalog, 30.0, faults=["tap_leak@20"])
    ratio = lambda t0, t1: run.window("rw_p03", t0, t1).mean() / run.window("rw_p09", t0, t1).mean()
    assert ratio(8, 20) == pytest.approx(1.0, abs=0.1)   # left and right stations agree
    assert ratio(20.2, 30) == pytest.approx(0.1, abs=0.03)
    assert run.window("rw_p02", 20.2, 30).mean() < -100.0  # neighbours normal → sensor fault


def test_current_offset(vehicle, catalog):
    run = Run(vehicle, catalog, 20.0, faults=["current_offset@10"])
    diff = lambda t0, t1: np.mean(run.window("pack_current", t0, t1) - run.window("inv_dc_current", t0, t1))
    assert diff(3, 10) == pytest.approx(0.0, abs=0.2)
    assert diff(10.1, 20) == pytest.approx(3.0, abs=0.2)
    # the BMS counts the faulty current: its SoC now falls faster than the truth
    eng = run.engine
    assert eng.powertrain.bms_soc < eng.truth()["truth_soc"]


def test_apps_implausibility_cuts_torque(vehicle, catalog, baseline):
    run = Run(vehicle, catalog, 40.0, faults=["apps_implausible@20"], seed=21)
    assert run.window("apps_plaus_ok", 5, 20).min() == 1.0
    assert run.window("apps_plaus_ok", 20, 40).min() == 0.0
    assert run.window("apps2", 20.1, 40).max() <= 1.0  # stuck at 0 %
    torque = run.window("mot_torque", 25, 40)
    assert np.mean(torque > 20.0) < 0.15  # only the 100 ms before each latch
    assert run.window("sdc_closed", 20, 40).min() == 1.0  # torque cut, the TS stays up
    drive = lambda r: np.mean(np.maximum(r.window("mot_torque", 25, 40), 0.0))
    assert drive(run) < 0.3 * drive(baseline)
    assert run.window("apps1", 25, 40).max() > 50.0  # the driver keeps trying


# ---------------------------------------------------------------------------- aero faults
def test_fw_damage_left_signature(vehicle, catalog):
    run = Run(vehicle, catalog, 40.0, faults=["fw_damage_left@20"])
    left = lambda t0, t1: run.window("fw_p01", t0, t1).mean() / run.window("fw_p07", t0, t1).mean()
    assert left(8, 20) == pytest.approx(1.0, abs=0.1)
    assert left(21, 40) == pytest.approx(0.45, abs=0.07)  # L suction −55 %

    def balance(t0, t1):
        f, r = run.window("truth_downforce_f", t0, t1), run.window("truth_downforce_r", t0, t1)
        fast = f + r > 400.0
        return np.mean(f[fast] / (f[fast] + r[fast]))

    assert balance(21, 40) < balance(8, 20) - 0.04  # balance shifts rearwards


def test_rw_stall_signature(vehicle, catalog):
    run = Run(vehicle, catalog, 40.0, faults=["rw_stall@20"])

    def cp(tap, t0, t1):
        q = run.window("pitot_dp", t0, t1)
        fast = q > 150.0
        return np.median(run.window(tap, t0, t1)[fast] / q[fast])

    assert cp("rw_p03", 21, 40) > 0.5 * cp("rw_p03", 8, 20)  # aft suction collapses
    assert cp("rw_p04", 21, 40) > 0.5 * cp("rw_p04", 8, 20)
    assert run.window("truth_cda", 21, 40).mean() < 0.95 * run.window("truth_cda", 8, 20).mean()

    def balance(t0, t1):
        f, r = run.window("truth_downforce_f", t0, t1), run.window("truth_downforce_r", t0, t1)
        fast = f + r > 400.0
        return np.mean(f[fast] / (f[fast] + r[fast]))

    assert balance(21, 40) > balance(8, 20) + 0.05  # balance shifts forwards


def test_ut_bottoming_stalls_the_floor_at_speed(vehicle, catalog, baseline):
    run = Run(vehicle, catalog, 130.0, faults=["ut_bottoming@1"], seed=21)
    # static drop while the car still waits for ready-to-drive
    assert run.window("rh_front", 0.5, 1.0).mean() - run.window("rh_front", 1.3, 1.8).mean() == pytest.approx(12.0, abs=0.5)

    def floor(r):
        q = r.window("pitot_dp", 5, 130)
        cp = r.window("ut_p05", 5, 130) / np.maximum(q, 1.0)
        fast = q > 300.0
        return np.mean(cp[fast]), np.mean(r.window("rh_front", 5, 130)[r.window("rh_front", 5, 130) > 0])

    cp_fault, rh_fault = floor(run)
    cp_ok, rh_ok = floor(baseline)
    assert rh_fault < rh_ok - 10.0
    assert cp_fault > cp_ok + 0.08  # diffuser suction lost at speed
    assert run.window("rh_front", 5, 130).min() < 10.0
    assert baseline.window("rh_front", 5, 130).min() > 14.0


def test_crosswind_gust_yaw_and_auto_clear(vehicle, catalog):
    run = Run(vehicle, catalog, 50.0, faults=["crosswind_gust@15"])
    yaw = lambda t0, t1: np.abs(run.window("probe_yaw", t0, t1))
    assert yaw(5, 15).mean() < 6.0
    assert yaw(17, 34).mean() > 12.0 and np.mean(yaw(17, 34) > 10.0) > 0.5
    assert yaw(37, 50).mean() < 6.0
    assert not run.engine.faults.is_active("crosswind_gust")  # 20 s gust, then cleared
    assert run.window("truth_wind_speed", 20, 30).mean() > 8.0


# ---------------------------------------------------------------------------- powertrain faults
def test_cell_hot_becomes_a_temperature_outlier(vehicle, catalog):
    run = Run(vehicle, catalog, 240.0, faults=["cell_hot@5"], start_temp_c=35.0)
    temps = np.array([run.window(f"cell_t_{j:02d}", 235, 240).mean() for j in range(60)])
    assert int(np.argmax(temps)) == 20  # the sensor covering cells 47–48
    assert temps[20] - np.delete(temps, 20).mean() >= 5.0
    assert run.engine.powertrain.pack.r0[47] == pytest.approx(4.0 * run.engine.powertrain.pack.base_r0[47])
    run.engine.set_fault("cell_hot", False)
    assert run.engine.powertrain.pack.r0[47] == run.engine.powertrain.pack.base_r0[47]


def test_cell_weak_becomes_the_lowest_cell(vehicle, catalog):
    run = Run(vehicle, catalog, 180.0, faults=["cell_weak@5"])
    cells = np.array([run.window(f"cell_v_{k:03d}", 175, 180) for k in range(140)])
    assert np.all(np.argmin(cells, axis=0) == 88)
    assert np.median(cells[88] - np.median(cells, axis=0)) < -0.020


def test_pump_failure_stops_the_flow_and_overheats(vehicle, catalog, baseline):
    run = Run(vehicle, catalog, 130.0, faults=["pump_fail@60"], seed=21)
    assert run.window("cool_flow", 61, 130).max() < 0.3
    assert run.window("pump_duty", 61, 130).min() == 100.0  # commanded, but no flow
    rise = lambda r: r.window("mot_winding_temp", 125, 130).mean() - r.window("mot_winding_temp", 58, 60).mean()
    assert rise(run) > 1.5 * rise(baseline)
    run.continue_for(120.0)
    assert run.window("mot_winding_temp", 130, 250).max() > 110.0  # motor_temp_high
    assert 4.0 in set(run.window("inv_state", 130, 250))           # derating


def test_imd_fault_opens_the_sdc_stops_the_car_and_restarts(vehicle, catalog):
    run = Run(vehicle, catalog, 40.0, faults=["imd_fault@10"])
    assert run.window("imd_iso_kohm", 5, 10).mean() > 1500.0
    assert run.window("imd_iso_kohm", 18, 40).mean() < 300.0
    assert run.window("imd_ok", 18, 40).max() == 0.0
    for cid in ("sdc_closed", "air_pos_closed", "air_neg_closed", "precharge_done"):
        assert run.window(cid, 18, 40).max() == 0.0, cid
    assert run.window("tsal_state", 20, 40).max() == 0.0
    assert run.window("inv_state", 18, 40).max() == 0.0
    assert run.window("gps_speed", 30, 40).max() < 0.5  # coasted and braked to a stop
    run.engine.set_fault("imd_fault", False)
    run.continue_for(20.0)
    states = run.window("inv_state", 40, 60)
    assert {1, 2, 3} <= set(states)  # precharge → ready → drive again
    assert run.window("gps_speed", 50, 60).max() > 5.0
    assert run.window("imd_ok", 41, 60).min() == 1.0


def test_ams_trip_through_the_engine(vehicle, catalog):
    """A temperature sensor above 60 °C → AMS opens the SDC (bms_state 3, bms_fault 3), the
    car stops. The AMS sees temperatures only through the sensors, so both cells under
    sensor 20 (cells 47-48) are made hot."""
    run = Run(vehicle, catalog, 15.0)
    run.engine.powertrain.pack.temp[47:49] = 61.0
    run.engine.powertrain.pack.ua0 = run.engine.powertrain.pack.ua1 = 0.0  # keep it hot
    run.continue_for(15.0)
    assert run.window("ams_ok", 16, 30).min() == 0.0
    assert run.window("sdc_closed", 17, 30).max() == 0.0
    assert run.window("bms_state", 17, 30).max() == 3.0 and run.window("bms_fault", 17, 30).max() == 3.0
    assert run.window("gps_speed", 27, 30).max() < 0.5


def test_constants_document_the_spec_numbers():
    assert faults_mod.HOT_CELL == 47 and faults_mod.HOT_CELL_R0_FACTOR == 4.0
    assert faults_mod.WEAK_CELL == 88 and faults_mod.WEAK_CELL_CAPACITY == 0.8
    assert faults_mod.BOTTOMING_DROP_MM == 12.0 and faults_mod.CURRENT_OFFSET_A == 3.0
    assert faults_mod.GUST_SPEED_MS == 12.0 and faults_mod.GUST_DURATION_S == 20.0
