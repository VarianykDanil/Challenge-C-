"""Unit tests of the Aero tab's pure JavaScript helpers (``web/js/panels/aero.js``).

The ES module is imported directly by Node.js; a tiny resolve hook maps the bare ``three``
specifiers to the vendored copy, exactly like the page's import map. Only DOM-free helpers
are exercised: the per-browser Cp baseline and its exclusion of aero-alert periods (a fault
that was already active when the page was opened must not become the "normal" reference).
Skipped when ``node`` is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
AERO_JS = ROOT / "web" / "js" / "panels" / "aero.js"
VENDOR = ROOT / "web" / "vendor" / "three"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")

HOOKS = """
const VENDOR = new URL({vendor});
export async function resolve(spec, ctx, next) {{
  if (spec === 'three') return {{ url: new URL('three.module.js', VENDOR).href, shortCircuit: true }};
  if (spec.startsWith('three/addons/')) return {{ url: new URL(spec.slice(6), VENDOR).href, shortCircuit: true }};
  return next(spec, ctx);
}}
"""


def run_js(tmp_path: Path, body: str) -> object:
    """Run an ES-module snippet with ``aero`` = the Aero panel module; return its printed JSON."""
    hooks = tmp_path / "hooks.mjs"
    hooks.write_text(HOOKS.format(vendor=json.dumps(VENDOR.as_uri() + "/")))
    script = tmp_path / "check.mjs"
    script.write_text(
        "import { register } from 'node:module';\n"
        f"register({json.dumps(hooks.as_uri())});\n"
        f"const aero = await import({json.dumps(AERO_JS.as_uri())});\n"
        f"const out = await (async () => {{ {body} }})();\n"
        "console.log(JSON.stringify(out));\n")
    proc = subprocess.run([NODE, str(script)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_aero_alert_windows_start_before_the_alert_and_ignore_other_alerts(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const log = [
          {id: 'aero_fw_asymmetry', t_start: 100, t_end: 150},
          {id: 'energy_short', t_start: 5, t_end: null},          // not an aero alert
          {id: 'aero_ut_stall', t_start: 300, t_end: null},       // still active
        ];
        const w = aero.aeroAlertWindows(log);
        return {w: w.map(([a, b]) => [a, Number.isFinite(b) ? b : 'inf']),
                hits: [60, 80, 150, 151, 280, 1e6].map((t) => aero.inWindows(t, w))};
    """)
    assert out == {"w": [[70, 150], [270, "inf"]], "hits": [False, True, True, False, True, True]}


def test_baseline_learns_only_clean_fast_samples_then_freezes(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const b = new aero.Baseline(['cl'], 2.0, 150);         // 2 s of valid data, q > 150 Pa
        const w = aero.aeroAlertWindows([{id: 'aero_balance_shift', t_start: 50, t_end: 60}]);  // [20, 60]
        let t = 0;
        const feed = (q, cl, n) => { for (let k = 0; k < n; k++, t += 0.05) b.add(t, q, () => cl, aero.inWindows(t, w)); };
        feed(100, 9.0, 40);             // 0-2 s: too slow, ignored
        feed(400, 2.0, 20);             // 2-3 s: learned (1 s)
        t = 20.5; feed(400, 1.0, 20);   // 20.5-21.5 s: the fault before its alert: ignored
        t = 70; feed(400, 2.4, 40);     // 70-72 s: learned until 2 s in total, then frozen
        return {mean: b.mean('cl'), frozen: b.frozen, firstT: b.firstT};
    """)
    assert out["frozen"] is True
    assert out["firstT"] == pytest.approx(2.0)
    assert out["mean"] == pytest.approx(2.2, abs=0.01)  # 1 s at 2.0 and 1 s at 2.4, nothing else


def test_fit_through_origin_is_the_least_squares_cla(tmp_path: Path) -> None:
    out = run_js(tmp_path, """
        const q = [50, 200, 400, 600], L = [999, 720, 1440, 2160];   // the first pair is below xMin
        return aero.fitThroughOrigin(q, L, 120);
    """)
    assert out == pytest.approx(3.6)
