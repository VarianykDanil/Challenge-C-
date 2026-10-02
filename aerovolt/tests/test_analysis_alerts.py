"""Tests for the alert rule engine (aerovolt.analysis.alerts) and config/alerts.yaml."""

from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np
import pytest
import yaml

from aerovolt.analysis import alerts as al
from aerovolt.analysis.alerts import AlertConfigError, AlertEngine, AnalysisState, build_rules
from aerovolt.analysis.processor import DEFAULT_ALERTS_PATH
from test_analysis_synthetic import config

NAN = float("nan")

SPEC_ALERT_IDS = {
    "aero_fw_asymmetry", "aero_balance_shift", "aero_rw_suction_loss", "aero_ut_stall", "aero_high_yaw",
    "sensor_pitot_implausible", "sensor_tap_anomaly", "sensor_stale", "bms_cell_temp_outlier",
    "bms_cell_overtemp", "bms_cell_voltage_outlier", "bms_cell_undervoltage", "bms_soc_divergence",
    "cooling_no_flow", "motor_temp_high", "inverter_temp_high", "safety_imd_trip", "safety_sdc_open",
    "safety_apps_implausible", "energy_short",
}


def _rules_file() -> dict:
    return yaml.safe_load(DEFAULT_ALERTS_PATH.read_text(encoding="utf-8"))


def _engine(*rules: dict, defaults: dict | None = None) -> AlertEngine:
    return AlertEngine(build_rules({"defaults": defaults or {}, "rules": list(rules)}, config().vehicle))


def _run(engine: AlertEngine, series: list[dict], dt: float = 0.1, t0: float = 0.0, **state_kw):
    changed = []
    for k, values in enumerate(series):
        changed.extend((round(t0 + k * dt, 6), a.active) for a in
                       engine.evaluate(AnalysisState(t=t0 + k * dt, values=values, **state_kw)))
    return changed


def test_alerts_yaml_defines_every_spec_alert_with_title_and_valid_rule():
    cfg = _rules_file()
    rules = build_rules(cfg, config().vehicle)
    assert {r.id for r in rules} == SPEC_ALERT_IDS
    for r in rules:
        assert r.title and r.title != r.id
        assert r.severity in al.SEVERITIES


def test_vehicle_references_resolve():
    rules = {r.id: r for r in build_rules(_rules_file(), config().vehicle)}
    assert rules["motor_temp_high"].value == config().vehicle["powertrain"]["motor"]["derate_start_c"]
    assert rules["inverter_temp_high"].value == 75.0


def test_threshold_debounce_and_hysteresis():
    eng = _engine({"id": "hot", "type": "threshold", "channel": "x", "op": ">", "value": 100, "clear_value": 95,
                   "for_s": 0.5, "clear_for_s": 0.3, "title": "Hot", "detail": "x is {x:.1f}"})
    series = [{"x": 101}] * 4 + [{"x": 99}] + [{"x": 101}] * 6 + [{"x": 97}] * 10 + [{"x": 94}] * 5
    changed = _run(eng, series)
    # true for 3 intervals, reset, then raised after 0.5 s; 97 is above clear_value: stays;
    # cleared 0.3 s after dropping below 95.
    assert changed == [(1.0, True), (2.4, False)]
    first = eng.log[0]
    assert first.detail == "x is 101.0" and first.t_end == pytest.approx(2.4) and not first.active
    assert eng.active() == []


def test_unknown_state_holds_alert_and_timer():
    eng = _engine({"id": "low", "type": "threshold", "channel": "x", "op": "<", "value": 1, "for_s": 0.3,
                   "clear_for_s": 0.2, "title": "Low"})
    changed = _run(eng, [{"x": 0}] * 3 + [{"x": NAN}] * 5 + [{"x": 0}] * 2 + [{"x": NAN}] * 20)
    # NaN neither resets the timer nor clears the alert (the intervals next to it do not count)
    assert changed == [(0.9, True)]
    assert eng.is_active("low")


def test_within_s_counts_intermittent_condition_cumulatively():
    rule = {"id": "stall", "type": "threshold", "channel": "x", "op": ">", "value": 0, "for_s": 1.0,
            "within_s": 10.0, "clear_for_s": 5.0, "title": "Stall"}
    burst = [{"x": 1}] * 5 + [{"x": 0}] * 15  # 0.4 s True per 2 s cycle, never 1 s in a row
    plain = _engine(dict(rule, within_s=None))
    assert _run(plain, burst * 5) == []
    eng = _engine(rule)
    changed = _run(eng, burst * 5)
    assert changed == [(4.2, True)]  # 0.4 + 0.4 + 0.2 s of True within 10 s
    sparse = [{"x": 1}] * 3 + [{"x": 0}] * 97  # 0.2 s per 10 s: never 1 s within 10 s
    assert _run(_engine(rule), sparse * 6) == []
    with pytest.raises(AlertConfigError, match="within_s"):
        _engine(dict(rule, within_s=0.5))


def test_when_gates_and_if_missing():
    rule = {"id": "flow", "type": "threshold", "channel": "flow", "op": "<", "value": 1, "for_s": 0,
            "title": "No flow", "when": [{"channel": "duty", "op": ">", "value": 20, "if_missing": True}]}
    eng = _engine(rule)
    assert _run(eng, [{"flow": 0.0, "duty": 0.0}]) == []  # pump off: not judged
    assert _run(eng, [{"flow": 0.0, "duty": NAN}], t0=1) == [(1.0, True)]  # duty unknown: judged
    rule["when"][0]["if_missing"] = None
    eng2 = _engine(rule)
    assert _run(eng2, [{"flow": 0.0}]) == []


def test_abs_threshold_and_template_with_nan():
    eng = _engine({"id": "yaw", "type": "threshold", "channel": "y", "abs": True, "op": ">", "value": 10,
                   "for_s": 0, "title": "Yaw", "detail": "yaw {y:+.1f} at {v:.1f} m/s ({missing})",
                   "channels": ["y", "{chan}"]})
    _run(eng, [{"y": -15.0, "v": NAN, "chan": "probe_yaw"}])
    a = eng.active()[0]
    assert a.detail == "yaw -15.0 at n/a m/s (n/a)"
    assert a.channels == ["y", "probe_yaw"]


def test_plausibility_rule():
    eng = _engine({"id": "apps", "type": "plausibility", "a": "a", "b": "b", "max_diff": 10, "clear_diff": 5,
                   "min_value": 2, "for_s": 0.1, "clear_for_s": 0.2, "title": "APPS"})
    series = [{"a": 50, "b": 45}] * 3 + [{"a": 50, "b": 1}] * 3 + [{"a": 50, "b": 30}] * 3 + \
             [{"a": 50, "b": 42}] * 3 + [{"a": 50, "b": 47}] * 3
    # b below min_value: not judged; diff 20 -> raised after 0.1 s; 8 is above clear_diff
    assert _run(eng, series) == [(0.7, True), (1.4, False)]


def test_custom_check_key_change_reemits_alert():
    calls = {"n": 0}

    @al.register_check("test_counter")
    def _check(state, params, active):
        calls["n"] += 1
        which = "A" if state.t < 0.5 else "B"
        return al.CheckResult(True, f"problem {which} ({params['p']})", [which], key=which)

    eng = _engine({"id": "c", "type": "custom", "check": "test_counter", "params": {"p": 7}, "for_s": 0,
                   "title": "Custom"})
    changed = _run(eng, [{}] * 10)
    assert changed == [(0.0, True), (0.5, True)]
    assert eng.active()[0].detail == "problem B (7)" and eng.active()[0].channels == ["B"]
    assert len(eng.log) == 1


def test_failing_check_is_isolated():
    @al.register_check("test_boom")
    def _boom(state, params, active):
        raise RuntimeError("bug")

    eng = _engine({"id": "boom", "type": "custom", "check": "test_boom", "title": "Boom"},
                  {"id": "ok", "type": "threshold", "channel": "x", "op": ">", "value": 0, "for_s": 0, "title": "OK"})
    assert _run(eng, [{"x": 1}]) == [(0.0, True)]


@pytest.mark.parametrize("bad, match", [
    ({"id": "x", "type": "nope"}, "unknown rule type"),
    ({"id": "x", "type": "threshold", "channel": "a", "op": "!=", "value": 1}, "unknown op"),
    ({"id": "x", "type": "threshold", "channel": "a", "value": 1, "severity": "fatal"}, "severity"),
    ({"id": "x", "type": "custom", "check": "does_not_exist"}, "unknown custom check"),
    ({"id": "x", "type": "threshold", "channel": "a", "value": "vehicle:no.such.key"}, "not found"),
    ({"id": "x", "type": "threshold", "channel": "a"}, "missing key"),
])
def test_config_errors(bad, match):
    with pytest.raises(AlertConfigError, match=match):
        build_rules({"rules": [bad]}, config().vehicle)


def test_duplicate_rule_ids_rejected():
    rule = {"id": "x", "type": "threshold", "channel": "a", "value": 1}
    with pytest.raises(AlertConfigError, match="duplicate"):
        build_rules({"rules": [rule, rule]}, config().vehicle)


# --------------------------------------------------------------- custom checks, unit level

def _state(**kw) -> AnalysisState:
    values = kw.pop("values", {})
    return AnalysisState(t=0.0, values=values, **kw)


def test_check_stale_lists_channels():
    res = al.check_stale(_state(stale={"amb_rh": 4.2, "pitot_dp": 1.1}), {"max_listed": 1}, False)
    assert res.state is True and "2 channel(s)" in res.detail and "amb_rh (4.2 s)" in res.detail
    assert "and 1 more" in res.detail and res.channels == ["amb_rh", "pitot_dp"]
    assert al.check_stale(_state(), {}, False).state is False


def test_check_cell_temp_outlier_names_the_sensor_and_cells():
    ids = [f"cell_t_{j:02d}" for j in range(60)]
    temps = 41.0 + 0.4 * np.sin(np.arange(60))
    temps[20] = 47.5
    st = _state(values=dict(zip(ids, temps)), cell_t_ids=ids, cell_v_ids=[f"cell_v_{k:03d}" for k in range(140)])
    res = al.check_cell_temp_outlier(st, {"min_abs_c": 3.0, "z": 4.0}, False)
    assert res.state is True and res.key == "cell_t_20"
    assert "cell_t_20 (cells 47-48) at 47.5 °C" in res.detail and "pack median" in res.detail
    temps[20] = 43.0  # within 3 degC of the median
    assert al.check_cell_temp_outlier(_state(values=dict(zip(ids, temps)), cell_t_ids=ids), {}, False).state is False
    assert al.check_cell_temp_outlier(_state(cell_t_ids=ids), {}, False).state is None


def test_cell_temp_outlier_threshold_lowered_by_resistance_evidence():
    ids = [f"cell_t_{j:02d}" for j in range(60)]
    temps = 41.0 + 0.2 * np.sin(np.arange(60))
    temps[20] = 42.8  # +1.8 degC: below the plain 2.5 degC limit
    vids = [f"cell_v_{k:03d}" for k in range(140)]
    plain = _state(values=dict(zip(ids, temps)), cell_t_ids=ids, cell_v_ids=vids)
    params = {"min_abs_c": 2.5, "corroborated_abs_c": 1.5, "resistance_mohm": 1.0, "z": 4.0}
    assert al.check_cell_temp_outlier(plain, params, False).state is False
    tracker = SimpleNamespace(ready=True, resistance_dev_ohm=lambda: np.where(np.arange(140) == 47, 0.009,
                                                                             1e-5 * np.cos(np.arange(140))))
    corroborated = _state(values=dict(zip(ids, temps)), cell_t_ids=ids, cell_v_ids=vids, cells=tracker)
    res = al.check_cell_temp_outlier(corroborated, params, False)
    assert res.state is True and "cell 47 internal resistance +9.0 mOhm" in res.detail


def test_check_cell_voltage_outlier_reports_cause():
    tracker = SimpleNamespace(ready=True, offset_v=lambda: np.where(np.arange(140) == 88, -0.012, 0.0005 * np.sin(np.arange(140))),
                              resistance_dev_ohm=lambda: np.where(np.arange(140) == 47, 0.009, 1e-5 * np.cos(np.arange(140))))
    ids = [f"cell_v_{k:03d}" for k in range(140)]
    res = al.check_cell_voltage_outlier(_state(cells=tracker, cell_v_ids=ids), {}, False)
    assert res.state is True
    assert "cell 88 -12 mV" in res.detail and "low capacity" in res.detail
    assert "cell 47 internal resistance +9.0 mOhm" in res.detail
    assert set(res.channels) >= {"cell_v_088", "cell_v_047"}
    # resistance and offset on the same cell: the resistance is the cause
    tracker.offset_v = lambda: np.where(np.arange(140) == 47, -0.02, 0.0)
    res = al.check_cell_voltage_outlier(_state(cells=tracker, cell_v_ids=ids), {}, False)
    assert "low capacity" not in res.detail
    assert al.check_cell_voltage_outlier(_state(cells=SimpleNamespace(ready=False)), {}, False).state is None


def test_check_soc_divergence_both_evidence_paths():
    p = {"max_diff_pct": 4.0, "current_mismatch_a": 1.5}
    assert al.check_soc_divergence(_state(values={"calc_soc_cc": 80.0, "calc_soc_ekf": 75.0}), p, False).state
    assert not al.check_soc_divergence(_state(values={"calc_soc_cc": 80.0, "calc_soc_ekf": 78.0}), p, False).state
    res = al.check_soc_divergence(_state(values={"calc_soc_cc": 80.0, "calc_soc_ekf": 79.5},
                                         current_mismatch_a=3.0, pack_capacity_ah=16.0), p, False)
    assert res.state and "+3.0 A" in res.detail and "-0.31 %/min" in res.detail
    assert al.check_soc_divergence(_state(), p, False).state is None


def test_check_sdc_open_requires_armed_and_names_cause():
    vals = {"sdc_closed": 0.0, "imd_ok": 0.0, "ams_ok": 1.0, "bspd_ok": 1.0, "apps_plaus_ok": 1.0}
    assert al.check_sdc_open(_state(values=vals), {}, False).state is None  # never closed: parked car
    res = al.check_sdc_open(_state(values=vals, sdc_armed=True), {}, False)
    assert res.state and "opened by IMD" in res.detail
    assert not al.check_sdc_open(_state(values={"sdc_closed": 1.0}, sdc_armed=True), {}, False).state


def test_check_energy_short_uses_strategy():
    s = SimpleNamespace(energy_short=True, current_kw=80.0, laps_left=20, energy_needed_kwh=6.6,
                        energy_available_kwh=6.1, recommended_kw=60.0)
    res = al.check_energy_short(_state(strategy=s), {}, False)
    assert res.state and "recommend 60 kW" in res.detail and "6.10 kWh available" in res.detail
    s.energy_short = False
    assert al.check_energy_short(_state(strategy=s), {}, False).state is False
    assert al.check_energy_short(_state(), {}, False).state is None


def test_aero_checks_need_a_warm_baseline():
    from aerovolt.analysis.anomaly import AeroHealthMonitor

    mon = AeroHealthMonitor(warmup_s=1.0)
    st = _state(aero_health=mon, values={"rh_front": 9.0, "rh_rear": 14.0})
    for check in (al.check_balance_shift, al.check_rw_suction_loss, al.check_ut_stall):
        assert check(st, {}, False).state is None
    good = {"cl_fw_l": 1.8, "cl_fw_r": 1.8, "cl_rw_l": 1.5, "cl_rw_r": 1.5, "cp_ut_mean": -1.2, "balance": 45.0}
    for _ in range(40):
        mon.update(good, 0.05, steady=True)
    mon.update(dict(good, cp_ut_mean=-0.6, cl_rw_l=1.1, cl_rw_r=1.1, balance=51.0), 0.05, steady=True, learn_ok=False)
    res = al.check_ut_stall(st, {"loss_pct": 30}, False)
    assert res.state and "suction -50 %" in res.detail and "F 9.0 mm" in res.detail
    res = al.check_rw_suction_loss(st, {"drop_pct": 20}, False)
    assert res.state and "-27 %" in res.detail
    res = al.check_balance_shift(st, {"shift_pts": 4}, False)
    assert res.state and "+6.0 pts, forwards" in res.detail
    assert not al.check_balance_shift(st, {"shift_pts": 8}, False).state


def test_tap_anomaly_check_text():
    finding = SimpleNamespace(tap="rw_p03", cp=-0.13, baseline=-1.31, z=60.0, neighbours=("rw_p02", "rw_p04"))
    taps = SimpleNamespace(findings=lambda which: [finding] if which == "sensor" else [], clusters=[])
    res = al.check_tap_anomaly(_state(taps=taps), {}, False)
    assert res.state and res.detail.startswith("rw_p03 Cp -0.13 vs learned -1.31")
    assert "neighbours rw_p02, rw_p04 normal" in res.detail and res.channels == ["rw_p03", "calc_cp_rw_p03"]
    taps.findings = lambda which: []
    assert al.check_tap_anomaly(_state(taps=taps), {}, False).state is False


def test_format_detail_never_raises():
    assert al.format_detail("{a:.1f} {b}", {"a": 1.234}) == "1.2 n/a"
    assert al.format_detail("{a:.1f}", {"a": "text"}) == "text"
    assert al.format_detail("{unclosed", {}) == "{unclosed"
    assert math.isnan(_state().num("anything"))
