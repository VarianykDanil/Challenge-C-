"""Unit tests of the Powertrain tab's pure JavaScript helpers (``web/js/panels/pt_*.js``).

The dashboard has no build step, so the ES modules are imported directly by Node.js (the
helpers under test touch no DOM). The cell <-> temperature-sensor mapping is checked against
``aerovolt.core.physics.temp_sensor_cells`` so the dashboard and the simulator can never
disagree about which cells a sensor sees. Skipped when ``node`` is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from aerovolt.core import physics

ROOT = Path(__file__).resolve().parents[1]
PANELS = ROOT / "web" / "js" / "panels"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")


def run_js(tmp_path: Path, body: str) -> object:
    """Run an ES-module snippet with the pt_* modules imported; return its printed JSON."""
    script = tmp_path / "check.mjs"
    imports = "\n".join(
        f"import * as {name} from {json.dumps((PANELS / f'{name}.js').as_uri())};"
        for name in ("pt_accumulator", "pt_soc", "pt_cooling", "pt_safety", "pt_strategy", "pt_motor")
    )
    script.write_text(f"{imports}\nconst out = await (async () => {{ {body} }})();\nconsole.log(JSON.stringify(out));\n")
    proc = subprocess.run([NODE, str(script)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])


# ---- accumulator ------------------------------------------------------------------------


def test_temp_sensor_mapping_matches_core_physics(tmp_path: Path) -> None:
    js = run_js(tmp_path, "return Array.from({length: 60}, (_, j) => pt_accumulator.tempSensorCells(j));")
    py = [[r.start, r.stop] for r in (physics.temp_sensor_cells(j) for j in range(60))]
    assert js == py
    assert js[20] == [47, 49]  # sensor 20 covers cells 47 and 48 (SPEC / physics docstring)


def test_cell_sensor_map_is_the_inverse_and_never_straddles_segments(tmp_path: Path) -> None:
    js = run_js(tmp_path, "return Array.from(pt_accumulator.cellSensorMap(140, 60));")
    assert js == [physics.cell_temp_sensor(k) for k in range(140)]
    for j in range(60):
        cells = [k for k in range(140) if js[k] == j]
        assert len({k // 28 for k in cells}) == 1


def test_round_half_even_like_python(tmp_path: Path) -> None:
    xs = [0.5, 1.5, 2.5, 3.5, -0.5, 2.4999, 2.6, 7.0]
    assert run_js(tmp_path, f"return {json.dumps(xs)}.map(pt_accumulator.roundHalfEven);") == [round(x) for x in xs]


def test_robust_z_flags_one_weak_cell_but_not_noise(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const v = Array.from({length: 140}, (_, k) => 3.9 + 0.002 * Math.sin(k * 1.7));
        v[88] = 3.85;  // 50 mV low: weak cell
        const r = pt_accumulator.robustZ(v, 0.001);
        const flagged = [];
        r.z.forEach((z, k) => { if (Math.abs(z) > pt_accumulator.OUTLIER_Z) flagged.push(k); });
        const quiet = pt_accumulator.robustZ(Array.from({length: 140}, () => 3.9), 0.001);
        return {flagged, median: r.median, quietMax: Math.max(...quiet.z.map(Math.abs))};
    """)
    assert out["flagged"] == [88]
    assert out["median"] == pytest.approx(3.9, abs=0.002)
    assert out["quietMax"] == 0


def test_alert_channels_map_to_cells(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const alerts = [
          {id: 'bms_cell_temp_outlier', severity: 'warn', title: 'T', channels: ['cell_t_20']},
          {id: 'bms_cell_voltage_outlier', severity: 'warn', title: 'V', channels: ['cell_v_088']},
          {id: 'bms_cell_undervoltage', severity: 'critical', title: 'U', channels: ['calc_cell_v_min']},
          {id: 'bms_cell_overtemp', severity: 'critical', title: 'O', channels: ['cell_t_20']},
        ];
        const val = (id) => (id === 'calc_cell_v_min_idx' ? 101 : NaN);
        const m = pt_accumulator.alertCells(alerts, val, 140, 60);
        return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, a]) => [k, a.severity]);
    """)
    assert out == [[47, "critical"], [48, "critical"], [88, "warn"], [101, "critical"]]


def test_colour_scales_have_round_ranges_and_minimum_span(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const s = pt_accumulator;
        return {
          v: [s.cellScale('v', {min: 3.9011, max: 3.9052}).lo, s.cellScale('v', {min: 3.9011, max: 3.9052}).hi],
          t: [s.cellScale('t', {min: 30.2, max: 47.6}).lo, s.cellScale('t', {min: 30.2, max: 47.6}).hi],
          dv: [s.cellScale('dv', {min: -12.4, max: 3}).lo, s.cellScale('dv', {min: -12.4, max: 3}).hi],
          mid: s.cellScale('dv', {min: -10, max: 10}).rgb(0),
          missing: s.cellScale('v', {min: 3.8, max: 4}).rgb(NaN),
        };
    """)
    assert out["v"][1] - out["v"][0] == pytest.approx(0.03)
    assert out["v"][0] <= 3.9011 and out["v"][1] >= 3.9052
    assert out["t"] == [30, 48]
    assert out["dv"] == [-15, 15]
    r, g, b = out["mid"]  # diverging midpoint is a neutral grey, not a hue
    assert max(r, g, b) - min(r, g, b) < 0.03
    assert len(out["missing"]) == 3


# ---- state of charge --------------------------------------------------------------------


def test_coulomb_drift_recovers_a_3_amp_offset(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        // CC drifts at -dI/Q: +3 A on a 16 Ah pack, EKF flat; 1 Hz samples for 2 minutes
        const Q = 16, dI = 3, t = [], cc = [], ekf = [];
        for (let i = 0; i <= 120; i++) { t.push(i); ekf.push(80); cc.push(80 - 100 * dI * i / (Q * 3600)); }
        const tr = pt_soc.differenceTrend(t, cc, ekf, 60);
        return {perMin: tr.slope * 60, offset: pt_soc.impliedOffsetA(tr.slope, Q), n: tr.n, span: tr.span,
                mean: pt_soc.meanDifference(t, cc, ekf, 1000)};
    """)
    assert out["perMin"] == pytest.approx(-0.3125, rel=1e-6)  # SPEC fault current_offset
    assert out["offset"] == pytest.approx(3.0, rel=1e-6)
    assert out["n"] == 61 and out["span"] == 60
    assert out["mean"] < 0


# ---- cooling / motor / safety -----------------------------------------------------------


def test_coolant_heat_formula(tmp_path: Path) -> None:
    out = run_js(tmp_path, "return pt_cooling.coolantHeatKw(8, 40, 43);")
    assert out == pytest.approx(8 / 60000 * 1040 * 3600 * 3 / 1000)  # ~1.50 kW


def test_derate_factor_ramps_linearly(tmp_path: Path) -> None:
    out = run_js(tmp_path, "return [100, 110, 125, 140, 150].map((t) => pt_motor.derateFactor(t, 110, 140));")
    assert out == [1, 1, 0.5, 0, 0]


def test_shutdown_chain_cuts_everything_after_the_first_open_element(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const v = {ams_ok: 1, imd_ok: 0, bspd_ok: 1, apps_plaus_ok: 1, air_pos_closed: 0, air_neg_closed: 0};
        const st = pt_safety.chainState((id) => (id in v ? v[id] : NaN));
        const allOk = pt_safety.chainState(() => 1);
        return {st: st.map((s) => [s.state, s.powered]), msg: pt_safety.chainMessage(st),
                ok: pt_safety.chainMessage(allOk).level,
                apps: pt_safety.chainMessage(pt_safety.chainState((id) => (id === 'apps_plaus_ok' ? 0 : 1))).level,
                trip: pt_safety.imdThresholdKohm(140, 4.2)};
    """)
    assert out["st"] == [["closed", True], ["open", True], ["closed", False], ["closed", False],
                         ["open", False], ["open", False], ["missing", False]]
    assert out["msg"]["level"] == "critical" and out["msg"]["text"].startswith("IMD tripped")
    assert out["ok"] == "ok"
    assert out["apps"] == "warn"  # APPS cuts torque but does not open the SDC (FS T 11.8.9)
    assert out["trip"] == pytest.approx(294.0)  # 500 ohm/V x 588 V


# ---- strategy ---------------------------------------------------------------------------

CURVE = [{"kw": kw, "lap_time": 60.0, "energy_kwh": e}
         for kw, e in [(40, 0.25), (50, 0.28), (60, 0.31), (65, 0.325), (70, 0.34), (80, 0.37)]]
CAR = {"packEnergyKwh": 8.064, "limitKw": 80, "socMinPct": 5}


def verdict(tmp_path: Path, strategy: dict | None) -> dict:
    return run_js(tmp_path, f"return pt_strategy.strategyVerdict({json.dumps(strategy)}, {json.dumps(CAR)});")


def test_energy_interpolation(tmp_path: Path) -> None:
    out = run_js(tmp_path, f"const c = {json.dumps(CURVE)}; return [pt_strategy.energyAt(c, 55), pt_strategy.energyAt(c, 80), pt_strategy.energyAt(c, 90)];")
    assert out[0] == pytest.approx(0.295)
    assert out[1] == pytest.approx(0.37)
    assert out[2] is None  # NaN -> null in JSON: outside the curve


def test_verdict_short_names_both_limits(tmp_path: Path) -> None:
    s = {"laps_done": 5, "laps_needed": 22, "recommended_kw": 65, "predicted_finish_soc": 7.2,
         "current_kw": 80, "energy_short": True, "curve": CURVE}
    v = verdict(tmp_path, s)
    assert v["level"] == "warn" and v["short"] is True
    assert v["text"].startswith("Will NOT finish at 80 kW — reduce to 65 kW")


def test_verdict_finishing_reports_reserve_at_current_limit(tmp_path: Path) -> None:
    s = {"laps_done": 5, "laps_needed": 22, "recommended_kw": 65, "predicted_finish_soc": 7.2,
         "current_kw": 65, "energy_short": False, "curve": CURVE}
    v = verdict(tmp_path, s)
    assert v["level"] == "ok"
    assert v["text"] == "Finishes with 7 % SoC reserve at 65 kW."
    # running slower than recommended: more reserve, and the headroom is named
    s2 = dict(s, current_kw=50)
    v2 = verdict(tmp_path, s2)
    expected = 7.2 + (0.325 - 0.28) * 17 * 100 / 8.064
    assert v2["finishAtCurrent"] == pytest.approx(expected)
    assert "Up to 65 kW still finishes." in v2["text"]


def test_verdict_infers_short_without_server_flag_and_handles_no_strategy(tmp_path: Path) -> None:
    s = {"laps_done": 3, "laps_needed": 22, "recommended_kw": 60, "predicted_finish_soc": 6.0, "curve": CURVE}
    v = verdict(tmp_path, s)  # mock feed: no current_kw / energy_short -> configured 80 kW limit
    assert v["short"] is True and "reduce to 60 kW" in v["text"]
    assert verdict(tmp_path, None)["level"] == ""
    hopeless = dict(s, recommended_kw=40, predicted_finish_soc=-3.0)
    assert verdict(tmp_path, hopeless)["level"] == "critical"
