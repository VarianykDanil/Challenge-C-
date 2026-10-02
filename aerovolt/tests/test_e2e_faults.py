"""Fault acceptance, end to end (SPEC 5.5): real simulator -> SourceManager -> store ->
Processor -> alerts, exactly as ``python -m aerovolt --headless --speed max`` runs it.

For every injectable fault the car first drives normally for :data:`T_INJECT` s (lap 1 is
complete and the analysis has learned its aero and cell baselines), then the fault is
switched on by the config's fault schedule. The test asserts that each alert SPEC 5.5
expects is raised within its **time budget** after the injection, and that nothing *else*
is raised - a leaking tap must be reported as a sensor fault, not as an aero problem.

Two normal runs check the other side, false alarms:

* at a 60 kW power limit (the car can finish the endurance) six laps raise no warn or
  critical alert at all;
* at the full 80 kW the only warning is ``energy_short`` - correct: SPEC 5.4 makes an
  80 kW endurance need 95-110 % of the usable energy, and the strategy must say so.

Budgets are about 2-3x the detection delays measured with the default seed (noted next to
each). All scenarios are independent sessions; they run in parallel worker processes
(one per CPU core) so the whole module takes about a minute on a 4-core machine.
"""

from __future__ import annotations

import asyncio
import logging
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import pytest

pytest.importorskip("aerovolt.sim.source")
pytest.importorskip("aerovolt.analysis.processor")

#: Session time at which a fault is injected, s: lap 1 runs from ~3.5 s to ~63 s, and the
#: baselines need ~20 s of steady flow per tap (aero) and ~1 lap of load (cells).
T_INJECT = 90.0
#: A strategy warning that may appear in any 80 kW run (see the module docstring).
STRATEGY_WARNING = "energy_short"


@dataclass(frozen=True)
class Scenario:
    """One headless session: faults to schedule, how long to run, extra sim settings,
    the alerts it must raise ``{alert id: budget s after the injection}`` and the alerts
    it may additionally raise as a physical side effect."""

    faults: tuple[str, ...]
    duration: float
    expect: dict[str, float]
    allowed: frozenset[str] = frozenset()
    sim: dict[str, Any] = field(default_factory=dict)
    t_inject: float = T_INJECT


def fault(fault_id: str, expect: dict[str, float], allowed: tuple[str, ...] = (), extra_s: float = 10.0) -> Scenario:
    """A SPEC 5.5 fault injected at :data:`T_INJECT`; runs until the largest budget."""
    return Scenario((f"{fault_id}@{T_INJECT:g}",), T_INJECT + max(expect.values()) + extra_s, expect,
                    frozenset(allowed) | {STRATEGY_WARNING})


#: Hot day (35 °C) and a heat-soaked pack (59 °C, e.g. a second stint): the hottest
#: sensor is above the 58 °C warning from the start.
HOT_WEATHER = {"temp_c": 35.0, "pressure_pa": 101325.0, "rh_pct": 40.0, "wind_ms": 3.0, "wind_dir_deg": 225.0}

SCENARIOS: dict[str, Scenario] = {
    # ---- System 1: aero ------------------------------------------------- measured delay
    "fw_damage_left": fault("fw_damage_left", {"aero_fw_asymmetry": 30.0,      # 11 s
                                               "aero_balance_shift": 45.0}),   # 16 s
    "rw_stall": fault("rw_stall", {"aero_rw_suction_loss": 30.0,               # 8 s
                                   "aero_balance_shift": 45.0}),               # 15 s
    "ut_bottoming": fault("ut_bottoming", {"aero_ut_stall": 60.0}),            # 16 s
    "pitot_blocked": fault("pitot_blocked", {"sensor_pitot_implausible": 15.0}),  # 3 s
    "tap_leak": fault("tap_leak", {"sensor_tap_anomaly": 20.0}),               # 3 s
    "crosswind_gust": fault("crosswind_gust", {"aero_high_yaw": 15.0}),        # 2 s
    # ---- System 2: powertrain --------------------------------------------------------
    "cell_hot": fault("cell_hot", {"bms_cell_voltage_outlier": 30.0,           # 7 s
                                   "bms_cell_temp_outlier": 120.0}),           # 52 s
    "cell_weak": fault("cell_weak", {"bms_cell_voltage_outlier": 120.0}),      # 55 s
    # motor_temp_high needs the winding to climb from ~70 °C to 110 °C without coolant flow
    "pump_fail": fault("pump_fail", {"cooling_no_flow": 10.0,                  # 3 s
                                     "motor_temp_high": 220.0},                # 154 s
                       allowed=("inverter_temp_high",)),
    "imd_fault": fault("imd_fault", {"safety_imd_trip": 10.0,                  # 4 s
                                     "safety_sdc_open": 10.0}),                # 4 s
    "current_offset": fault("current_offset", {"bms_soc_divergence": 60.0}),  # 27 s
    "apps_implausible": fault("apps_implausible", {"safety_apps_implausible": 5.0}),  # 0.1 s
    # ---- AMS over-temperature path (not reachable with cell_hot, see SPEC 5.5 note) ---
    "hot_pack": Scenario((), 30.0, {"bms_cell_overtemp": 10.0}, frozenset({"safety_sdc_open"}),
                         sim={"start_temp_c": 59.0, "weather": HOT_WEATHER}, t_inject=0.0),
    # ---- false-alarm runs --------------------------------------------------------------
    "normal_60kw": Scenario((), 360.0, {}, sim={"power_limit_kw": 60.0}),
    "normal_80kw": Scenario((), 420.0, {}),
}


def run_scenario(name: str) -> dict[str, Any]:
    """Run one scenario headless at ``--speed max`` (in a worker process); return the summary."""
    from aerovolt.core.config import load_config
    from aerovolt.server.session import Session

    logging.disable(logging.WARNING)
    sc = SCENARIOS[name]
    config = load_config("config/demo.yaml", {"speed": "max", "faults": list(sc.faults), "duration": sc.duration})
    config.sources[0].update(sc.sim)
    return asyncio.run(Session(config).run_headless(sc.duration))


@pytest.fixture(scope="module")
def results() -> dict[str, dict[str, Any]]:
    """All scenarios, run in parallel worker processes (sequentially on one core)."""
    from aerovolt.core.config import PROJECT_ROOT

    cwd = os.getcwd()
    os.chdir(PROJECT_ROOT)
    try:
        workers = min(len(SCENARIOS), os.cpu_count() or 1)
        names = sorted(SCENARIOS, key=lambda n: -SCENARIOS[n].duration)  # longest first
        if workers == 1:
            return {n: run_scenario(n) for n in names}
        with ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context("spawn")) as pool:
            return dict(zip(names, pool.map(run_scenario, names)))
    finally:
        os.chdir(cwd)


def first_raised(summary: dict[str, Any]) -> dict[str, float]:
    """``{alert id: t_start of its first raise}`` of a session summary."""
    raised: dict[str, float] = {}
    for alert in summary["alerts"]:
        raised.setdefault(alert["id"], alert["t_start"])
    return raised


FAULT_SCENARIOS = [n for n, sc in SCENARIOS.items() if sc.faults]


@pytest.mark.parametrize("name", FAULT_SCENARIOS + ["hot_pack"])
def test_fault_raises_its_alerts_within_budget(results, name):
    sc = SCENARIOS[name]
    summary = results[name]
    assert summary["stats"]["processor_errors"] == 0
    raised = first_raised(summary)
    for alert_id, budget in sc.expect.items():
        assert alert_id in raised, f"{name}: {alert_id} not raised (raised: {sorted(raised)})"
        delay = raised[alert_id] - sc.t_inject
        assert 0.0 <= delay <= budget, f"{name}: {alert_id} after {delay:.1f} s (budget {budget:.0f} s)"
    unexpected = set(raised) - set(sc.expect) - sc.allowed
    assert not unexpected, f"{name}: unexpected alerts {sorted(unexpected)}"
    if sc.faults:  # the fault was really injected by the schedule
        fid = sc.faults[0].split("@")[0]
        assert {"t": sc.t_inject, "id": fid, "active": True, "by": "sim"} in summary["faults"]


def test_nothing_is_raised_before_the_injection(results):
    """The first lap and a half of every fault run is a normal run: no alert of any kind
    (the strategy needs two laps before it may warn)."""
    for name in FAULT_SCENARIOS:
        early = {a["id"] for a in results[name]["alerts"] if a["t_start"] < T_INJECT}
        assert not early, f"{name}: {sorted(early)} raised before the fault"


def test_tap_leak_is_classified_as_a_sensor_fault_not_aero(results):
    alerts = [a for a in results["tap_leak"]["alerts"] if a["id"] == "sensor_tap_anomaly"]
    assert alerts and "rw_p03" in alerts[0]["channels"]
    assert not any(a["id"].startswith("aero_") for a in results["tap_leak"]["alerts"])


def test_hot_cell_alerts_name_cell_47(results):
    alerts = {a["id"]: a for a in results["cell_hot"]["alerts"]}
    assert "cell_v_047" in alerts["bms_cell_voltage_outlier"]["channels"]
    assert "cell_t_20" in alerts["bms_cell_temp_outlier"]["channels"]  # sensor 20 covers cells 47-48


def test_normal_run_at_60kw_raises_no_warnings(results):
    summary = results["normal_60kw"]
    loud = [(a["id"], a["severity"], a["t_start"]) for a in summary["alerts"] if a["severity"] != "info"]
    assert not loud, f"false alarms in a normal run: {loud}"
    assert len(summary["laps"]) >= 5
    assert summary["strategy"] is not None and summary["strategy"]["energy_short"] is False
    final = summary["final"]
    # the estimators track the simulator's truth
    assert abs(final["calc_soc_ekf"] - final["truth_soc"]) < 1.0
    assert abs(final["calc_cla"] - final["truth_cla"]) / final["truth_cla"] < 0.15


def test_full_power_run_only_warns_about_energy(results):
    """80 kW for the whole endurance does not fit (SPEC 5.4): the strategy says so and
    recommends a lower power limit; nothing else is raised."""
    summary = results["normal_80kw"]
    ids = {a["id"] for a in summary["alerts"] if a["severity"] != "info"}
    assert ids == {STRATEGY_WARNING}
    strategy = summary["strategy"]
    assert strategy["energy_short"] is True and strategy["recommended_kw"] < 80.0
    assert 55.0 <= min(lap["lap_time"] for lap in summary["laps"]) <= 80.0  # SPEC 5.4
