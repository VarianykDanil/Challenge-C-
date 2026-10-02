"""Integration tests of aerovolt.analysis.processor on the synthetic car.

Every SPEC 6.5 alert id is exercised here at least once. Fault magnitudes follow SPEC 5.5;
every fault must be detected within about one lap (90 s) of injection, and a normal run
must stay silent apart from the endurance-strategy warning (``energy_short`` is the
*expected* result at the full 80 kW limit: SPEC 5.4 makes a full-power endurance need
95-110 % of the usable energy).
"""

from __future__ import annotations

import copy
import json
import math

import pytest

from aerovolt.core.store import ChannelStore
from test_analysis_synthetic import SyntheticCar, config, drive, make_processor, raised

FAULT_T = 70.0  # injection time: after the aero baselines are warm (~1 lap of data)
DEADLINE_S = 90.0  # "within about one lap"
WARN = {"warn", "critical"}


@pytest.fixture(scope="module")
def warm_session():
    """A normal session driven up to just before the fault injection time."""
    car = SyntheticCar(seed=7, wind=(3.0, 225.0))
    proc, store = make_processor()
    events = drive(car, proc, store, FAULT_T - 1.0)
    return car, proc, store, events


def _fork(warm_session):
    car, proc, store, events = copy.deepcopy(warm_session)
    return car, proc, store, events


def _run_until(car, proc, store, expected: set[str], deadline: float, dt: float = 0.05) -> dict[str, dict]:
    """Drive until every expected alert is raised or ``deadline`` (session time)."""
    found: dict[str, dict] = {}
    while car.t < deadline and not expected <= set(found):
        values = car.step(dt)
        store.update(car.t, values)
        for ev in proc.tick(car.t):
            if ev["type"] == "alert" and ev["alert"]["active"]:
                found.setdefault(ev["alert"]["id"], ev["alert"])
    return found


# ----------------------------------------------------------------- robustness

def test_empty_and_partial_data_never_raise():
    proc, store = make_processor()
    for k in range(40):
        assert proc.tick(k * 0.05) == []
    store.update(2.0, {"pitot_dp": 300.0, "cell_v_005": 3.9, "gps_lat": 52.0786})
    for k in range(40):
        proc.tick(2.0 + k * 0.05)
    assert proc.stats["errors"] == 0
    assert set(config().catalog.calc_ids()) <= set(store.latest_all())
    assert math.isnan(store.latest("calc_cla"))
    assert proc.tick(float("nan")) == []


def test_never_reads_truth_channels():
    class SpyStore(ChannelStore):
        requested: set[str] = set()

        def latest(self, cid):
            self.requested.add(cid)
            return super().latest(cid)

        def timestamp(self, cid):
            self.requested.add(cid)
            return super().timestamp(cid)

        def latest_all(self):
            raise AssertionError("the processor should only read the channels it needs")

    proc, _ = make_processor()
    store = SpyStore(config().catalog, history_s=10)
    proc.store = store
    car = SyntheticCar()
    for _ in range(100):
        vals = car.step(0.05)
        vals["truth_soc"] = 12.0
        store.update(car.t, vals)
        proc.tick(car.t)
    assert store.requested and not any(cid.startswith("truth_") for cid in store.requested)


def test_events_are_spec_shaped_and_json_safe(warm_session):
    *_, events = warm_session
    kinds = {e["type"] for e in events}
    assert {"lap", "strategy"} <= kinds
    for e in events:
        json.dumps(e, allow_nan=False)
        assert set(e) == {"type", e["type"]}
    lap = next(e["lap"] for e in events if e["type"] == "lap")
    assert list(lap) == ["lap", "lap_time", "distance", "v_avg", "v_max", "energy_kwh", "regen_kwh", "cla_avg",
                         "cda_avg", "balance_avg", "cell_t_max", "cell_v_min", "mot_temp_max"]
    alert = next(e["alert"] for e in events if e["type"] == "alert")
    assert set(alert) == {"id", "rule", "severity", "title", "detail", "channels", "t_start", "t_end", "active"}


def test_normal_run_is_silent_except_the_energy_strategy(warm_session):
    car, proc, store, events = _fork(warm_session)
    events += drive(car, proc, store, 130.0)  # ~3.4 laps in total with 3 m/s of wind
    alerts = raised(events)
    assert set(alerts) == {"energy_short"}
    assert proc.stats["errors"] == 0
    assert len(proc.laps) == 3
    s = proc.strategy
    assert s["laps_needed"] == 24 and s["laps_done"] == 3 and s["recommended_kw"] < 80
    assert store.latest("calc_power_limit_rec") == s["recommended_kw"]
    assert store.latest("calc_laps_needed") == 21
    assert 0 < store.latest("calc_laps_remaining") < 21
    assert "recommend" in alerts["energy_short"]["detail"]


def test_calc_channels_track_the_car(warm_session):
    car, proc, store, _ = _fork(warm_session)
    assert store.latest("calc_soc_ekf") == pytest.approx(car.true_soc_mean * 100, abs=1.5)
    assert store.latest("calc_soc_cc") == pytest.approx(car.true_soc_mean * 100, abs=1.0)
    assert store.latest("calc_energy_used") > 0.3
    assert store.latest("calc_lap") == 2.0
    assert store.latest("calc_lap_dist") == pytest.approx(car.s % car.track.length, abs=3.0)
    assert store.latest("calc_cell_v_delta") < 40
    assert store.latest("calc_cla") == pytest.approx(car.cla, rel=0.05)
    lap1 = proc.laps[0]
    assert lap1.lap == 1 and lap1.lap_time == pytest.approx(car.lap.lap_time + car.rest_s, abs=0.3)
    assert lap1.distance == pytest.approx(car.track.length, rel=0.01)


# ----------------------------------------------------------------- fault detection (SPEC 5.5)

FAULT_CASES = [
    ("tap_leak", {"sensor_tap_anomaly"}, {"aero_rw_suction_loss"}),
    ("fw_damage_left", {"aero_fw_asymmetry", "aero_balance_shift"}, {"sensor_tap_anomaly"}),
    ("rw_stall", {"aero_rw_suction_loss", "aero_balance_shift"}, {"sensor_tap_anomaly"}),
    ("ut_bottoming", {"aero_ut_stall"}, {"sensor_tap_anomaly"}),
    ("pitot_blocked", {"sensor_pitot_implausible"}, set()),
    ("crosswind_gust", {"aero_high_yaw"}, {"aero_fw_asymmetry", "aero_balance_shift", "aero_rw_suction_loss"}),
    ("cell_hot", {"bms_cell_temp_outlier", "bms_cell_voltage_outlier"}, set()),
    ("cell_weak", {"bms_cell_voltage_outlier"}, {"bms_cell_temp_outlier"}),
    ("current_offset", {"bms_soc_divergence"}, set()),
    ("pump_fail", {"cooling_no_flow", "motor_temp_high"}, set()),
    ("imd_fault", {"safety_imd_trip", "safety_sdc_open"}, set()),
    ("apps_implausible", {"safety_apps_implausible"}, set()),
]


@pytest.mark.parametrize("fault, expected, forbidden", FAULT_CASES, ids=[c[0] for c in FAULT_CASES])
def test_fault_is_detected_within_one_lap(warm_session, fault, expected, forbidden):
    car, proc, store, _ = _fork(warm_session)
    car.faults[fault] = FAULT_T
    found = _run_until(car, proc, store, expected, FAULT_T + DEADLINE_S)
    assert expected <= set(found), f"{fault}: raised {sorted(found)}"
    assert not forbidden & set(found), f"{fault}: wrongly raised {sorted(forbidden & set(found))}"
    for aid in expected:
        assert found[aid]["t_start"] - FAULT_T <= DEADLINE_S
        assert found[aid]["detail"] and "n/a" not in found[aid]["detail"].split("(")[0]
    assert proc.stats["errors"] == 0


def test_fault_details_name_the_evidence(warm_session):
    car, proc, store, _ = _fork(warm_session)
    car.faults.update(tap_leak=FAULT_T, cell_weak=FAULT_T, fw_damage_left=FAULT_T)
    found = _run_until(car, proc, store, {"sensor_tap_anomaly", "bms_cell_voltage_outlier", "aero_fw_asymmetry"},
                       FAULT_T + DEADLINE_S)
    assert found["sensor_tap_anomaly"]["detail"].startswith("rw_p03 Cp")
    assert "rw_p03" in found["sensor_tap_anomaly"]["channels"]
    assert "cell 88" in found["bms_cell_voltage_outlier"]["detail"]
    assert "cell_v_088" in found["bms_cell_voltage_outlier"]["channels"]
    assert found["aero_fw_asymmetry"]["detail"].startswith("FW left section Cl")
    # the leaking tap is excluded from the rear-wing integration
    assert proc.taps.mask[proc.aero.layout.index("rw_p03")]


def test_pitot_fallback_to_gps_speed(warm_session):
    car, proc, store, _ = _fork(warm_session)
    car.faults["pitot_blocked"] = FAULT_T
    _run_until(car, proc, store, {"sensor_pitot_implausible"}, FAULT_T + DEADLINE_S)
    drive(car, proc, store, 2.0)
    q_gps = 0.5 * car.rho * store.latest("gps_speed") ** 2
    assert store.latest("calc_q") == pytest.approx(q_gps, rel=0.05)


def test_overtemp_undervoltage_and_inverter_temperature(warm_session):
    car, proc, store, _ = _fork(warm_session)
    car.temp[47:49] = 59.5  # cells under sensor cell_t_20
    car.igbt_temp = 80.0
    car.soc[:] = 0.06  # nearly empty pack under full power: voltage sags below 2.9 V
    found = _run_until(car, proc, store, {"bms_cell_overtemp", "inverter_temp_high", "bms_cell_undervoltage"},
                       car.t + 60.0)
    assert {"bms_cell_overtemp", "inverter_temp_high", "bms_cell_undervoltage"} <= set(found)
    assert "cell_t_20 (cells 47-48)" in found["bms_cell_overtemp"]["detail"]
    assert "cell_t_20" in found["bms_cell_overtemp"]["channels"]
    assert found["bms_cell_overtemp"]["severity"] == "critical"
    assert found["bms_cell_undervoltage"]["detail"].startswith("Lowest cell")


def test_sdc_open_without_device_flag(warm_session):
    car, proc, store, _ = _fork(warm_session)
    car.faults["sdc_open"] = FAULT_T
    found = _run_until(car, proc, store, {"safety_sdc_open"}, FAULT_T + 5)
    assert "no device flag" in found["safety_sdc_open"]["detail"]


def test_stale_sensor_raised_and_cleared(warm_session):
    car, proc, store, _ = _fork(warm_session)
    events = drive(car, proc, store, 8.0, drop={"amb_rh", "fw_load"})
    first = raised(events)["sensor_stale"]
    assert first["channels"] == ["fw_load"]  # 50 Hz: stale after 0.5 s
    updates = [e["alert"] for e in events if e["type"] == "alert" and e["alert"]["id"] == "sensor_stale"]
    assert set(updates[-1]["channels"]) == {"amb_rh", "fw_load"}  # 1 Hz: stale after 5 s
    assert "2 channel(s) stopped updating" in updates[-1]["detail"]
    assert len(proc.alert_log) == len([a for a in proc.alert_log if a.id != "sensor_stale"]) + 1
    events = drive(car, proc, store, 5.0)
    cleared = [e["alert"] for e in events if e["type"] == "alert" and e["alert"]["id"] == "sensor_stale"]
    assert cleared and not cleared[-1]["active"]


def test_whole_source_stopping_is_not_a_stale_sensor(warm_session):
    car, proc, store, _ = _fork(warm_session)
    t = car.t
    events = []
    for k in range(1, 41):  # no data for 10 s, the session keeps ticking (wall-clock fallback)
        events += proc.tick(t + k * 0.25)
    assert "sensor_stale" not in raised(events)
    assert math.isnan(store.latest("calc_q"))  # stale inputs are not used


def test_reset_and_time_jump(warm_session):
    car, proc, store, _ = _fork(warm_session)
    assert proc.laps
    proc.reset()
    assert proc.laps == [] and proc.strategy is None and proc.active_alerts() == []
    car2, proc2, store2, _ = _fork(warm_session)
    proc2.tick(1.0)  # time went back > 5 s: a new session (e.g. a replay looped)
    assert proc2.laps == [] and proc2.alert_log == []
