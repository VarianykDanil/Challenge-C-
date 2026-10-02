"""Alert rule engine driven by ``config/alerts.yaml`` (SPEC section 6.5).

Every rule turns the analysis state into one of three answers each tick:

* ``True``  - the fault condition is present;
* ``False`` - it is absent;
* ``None``  - it cannot be judged right now (a needed channel is missing, or a ``when``
  gate is not met - e.g. aero coefficients are only comparable at speed). The rule then
  simply **holds** its state: an active alert does not clear because the car slowed down
  for a hairpin, and a pending alert keeps its timer.

Debounce and hysteresis (standard alarm-management practice - an alarm must be worth
reacting to and must not chatter):

* an alert is **raised** after the condition has been ``True`` for ``for_s`` seconds of
  judged time - only intervals between two consecutive ``True`` ticks count, and any
  ``False`` resets the timer (``for_s: 0`` raises on the first ``True`` tick);
* for **intermittent** faults (e.g. a floor that stalls only on the fastest straights)
  ``within_s`` switches to a cumulative count: raised once the condition was ``True`` for
  ``for_s`` seconds *in total* within the last ``within_s`` seconds;
* an active alert is **cleared** after ``clear_for_s`` seconds of ``False``. Threshold
  rules re-test against ``clear_value`` (e.g. raise above 110 degC, clear below 105 degC),
  plausibility rules against ``clear_diff``; custom checks receive ``active`` and apply
  their own clear thresholds.

Rule types (all share ``id, severity (info|warn|critical), title, detail, channels,
for_s, within_s, clear_for_s, when, enabled``):

``threshold``     ``channel op value`` (``op``: ``<  <=  >  >=``; ``abs: true`` compares
                  ``|channel|``), ``clear_value``.
``plausibility``  ``|a - b| > max_diff`` while ``b > min_value``; ``clear_diff``. For two
                  sensors that must agree (two pedal sensors, pitot vs GPS speed).
``custom``        ``check: <name>`` + ``params``: a Python function registered here with
                  :func:`register_check` that receives the :class:`AnalysisState`.

``when`` is a list of gates ``{channel, op, value, if_missing}``; all must hold for the
rule to be judged. ``if_missing`` (default: unknown -> hold) decides what a missing
channel means. Numeric values may be written ``"vehicle:<dotted.path>"`` to reuse a
number from ``config/vehicle.yaml`` (e.g. the motor's derating temperature), so a limit
lives in one place only.

``detail`` is a ``str.format`` template over the state's values (raw + calc + ``aux_*``
helper values from the processor); a missing or NaN value prints as ``n/a``. Custom checks
build their own detail text, naming the evidence.
"""

from __future__ import annotations

import logging
import math
import operator
import string
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

import numpy as np

from aerovolt.core import physics
from aerovolt.core.model import Alert

log = logging.getLogger(__name__)

NAN = float("nan")
SEVERITIES = ("info", "warn", "critical")
OPS: dict[str, Callable[[float, float], bool]] = {
    "<": operator.lt, "<=": operator.le, ">": operator.gt, ">=": operator.ge,
}
#: Longest tick interval counted by the debounce timers (data gaps do not raise alerts), s.
MAX_DT_S = 1.0
#: Tolerance of the debounce comparisons (tick times are floats: 0.7 - 0.6 = 0.0999...), s.
TIME_EPS_S = 1e-6


class AlertConfigError(ValueError):
    """``config/alerts.yaml`` is invalid."""


# --------------------------------------------------------------------------------------
# State handed to the rules
# --------------------------------------------------------------------------------------


@dataclass
class AnalysisState:
    """Everything a rule may look at, rebuilt by the processor every tick.

    ``values`` maps channel ids (live raw values, NaN when missing/stale; ``calc_*``) and
    ``aux_*`` helper values (numbers or short strings for detail texts) to their values.
    The other fields are the analysis objects the custom checks need; any may be ``None``
    (a check then answers ``None`` = cannot judge).
    """

    t: float
    values: Mapping[str, Any]
    taps: Any = None  # anomaly.TapAnomalyDetector
    aero_health: Any = None  # anomaly.AeroHealthMonitor
    cells: Any = None  # powertrain.CellDeviationTracker
    cell_t_ids: Sequence[str] = ()
    cell_v_ids: Sequence[str] = ()
    strategy: Any = None  # strategy.StrategyResult
    stale: Mapping[str, float] = field(default_factory=dict)  # channel -> seconds since update
    sdc_armed: bool = False
    current_mismatch_a: float = NAN  # low-passed pack_current - inv_dc_current, A
    pack_capacity_ah: float = NAN  # charge capacity of one series element (parallel group)

    def get(self, key: str) -> Any:
        return self.values.get(key, NAN)

    def num(self, key: str) -> float:
        v = self.values.get(key, NAN)
        try:
            return float(v)
        except (TypeError, ValueError):
            return NAN


@dataclass
class CheckResult:
    """Answer of a rule for one tick (``state``: True / False / None = hold).

    ``key`` identifies *what* is wrong (e.g. which cell); if it changes while the alert is
    active, the alert's detail and channels are updated and re-broadcast.
    """

    state: bool | None
    detail: str = ""
    channels: list[str] = field(default_factory=list)
    key: str | None = None


CheckFn = Callable[[AnalysisState, Mapping[str, Any], bool], CheckResult]
_CHECKS: dict[str, CheckFn] = {}


def register_check(name: str) -> Callable[[CheckFn], CheckFn]:
    """Decorator: make a Python function available as ``type: custom, check: <name>``."""

    def deco(fn: CheckFn) -> CheckFn:
        _CHECKS[name] = fn
        return fn

    return deco


def registered_checks() -> list[str]:
    return sorted(_CHECKS)


# --------------------------------------------------------------------------------------
# Formatting
# --------------------------------------------------------------------------------------


class _DetailFormatter(string.Formatter):
    """``str.format`` that prints missing keys and NaN as ``n/a`` instead of failing."""

    def get_value(self, key: Any, args: Sequence[Any], kwargs: Mapping[str, Any]) -> Any:
        if isinstance(key, str):
            return kwargs.get(key, None)
        return super().get_value(key, args, kwargs)

    def format_field(self, value: Any, format_spec: str) -> str:
        if value is None:
            return "n/a"
        if isinstance(value, (float, np.floating)) and not math.isfinite(value):
            return "n/a"
        try:
            return super().format_field(value, format_spec)
        except (ValueError, TypeError):
            return str(value)


_FMT = _DetailFormatter()


def format_detail(template: str, values: Mapping[str, Any]) -> str:
    """Fill a detail template; never raises (a malformed template is returned as is)."""
    try:
        return _FMT.vformat(template, (), values)
    except (KeyError, IndexError, ValueError, AttributeError):
        return template


def _resolve_number(value: Any, vehicle: Mapping[str, Any]) -> float:
    """A number, or ``"vehicle:a.b.c"`` looked up in ``vehicle.yaml``."""
    if isinstance(value, str) and value.startswith("vehicle:"):
        node: Any = vehicle
        for part in value[len("vehicle:"):].split("."):
            if not isinstance(node, Mapping) or part not in node:
                raise AlertConfigError(f"{value!r}: not found in vehicle.yaml")
            node = node[part]
        return float(node)
    try:
        return float(value)
    except (TypeError, ValueError):
        raise AlertConfigError(f"expected a number or 'vehicle:<path>', got {value!r}") from None


# --------------------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------------------


@dataclass
class Gate:
    """One ``when`` condition: ``channel op value`` (missing -> ``if_missing``)."""

    channel: str
    op: str
    value: float
    if_missing: bool | None = None

    def test(self, state: AnalysisState) -> bool | None:
        x = state.num(self.channel)
        if not math.isfinite(x):
            return self.if_missing
        return OPS[self.op](x, self.value)


class Rule:
    """Common rule fields and the ``when`` gates; subclasses implement :meth:`judge`."""

    kind = "base"

    def __init__(self, cfg: Mapping[str, Any], defaults: Mapping[str, Any], vehicle: Mapping[str, Any]) -> None:
        c = {**defaults, **cfg}
        self.id = str(c["id"])
        self.severity = str(c.get("severity", "warn"))
        if self.severity not in SEVERITIES:
            raise AlertConfigError(f"{self.id}: severity must be one of {SEVERITIES}")
        self.title = str(c.get("title", self.id))
        self.detail = str(c.get("detail", ""))
        self.channels = [str(ch) for ch in c.get("channels", [])]
        self.for_s = float(c.get("for_s", 1.0))
        within = c.get("within_s")
        self.within_s = None if within is None else float(within)
        if self.within_s is not None and self.within_s < self.for_s:
            raise AlertConfigError(f"{self.id}: within_s must be >= for_s")
        self.clear_for_s = float(c.get("clear_for_s", 3.0))
        self.enabled = bool(c.get("enabled", True))
        self.vehicle = vehicle
        self.when = []
        for g in c.get("when", []) or []:
            op = str(g.get("op", ">"))
            if op not in OPS:
                raise AlertConfigError(f"{self.id}: unknown op {op!r} in 'when'")
            self.when.append(Gate(str(g["channel"]), op, _resolve_number(g["value"], vehicle), g.get("if_missing")))

    def gates_open(self, state: AnalysisState) -> bool | None:
        for g in self.when:
            r = g.test(state)
            if r is not True:
                return None
        return True

    def evaluate(self, state: AnalysisState, active: bool) -> CheckResult:
        if self.gates_open(state) is None:
            return CheckResult(None)
        res = self.judge(state, active)
        if res.state is not True:
            return res  # texts are only needed when the condition is present
        if not res.detail and self.detail:
            res.detail = format_detail(self.detail, state.values)
        if not res.channels:
            res.channels = [ch for ch in (format_detail(c, state.values) for c in self.channels) if ch != "n/a"]
        return res

    def judge(self, state: AnalysisState, active: bool) -> CheckResult:  # pragma: no cover - abstract
        raise NotImplementedError


class ThresholdRule(Rule):
    """``channel op value`` for ``for_s``; while active, cleared only past ``clear_value``."""

    kind = "threshold"

    def __init__(self, cfg: Mapping[str, Any], defaults: Mapping[str, Any], vehicle: Mapping[str, Any]) -> None:
        super().__init__(cfg, defaults, vehicle)
        self.channel = str(cfg["channel"])
        self.op = str(cfg.get("op", ">"))
        if self.op not in OPS:
            raise AlertConfigError(f"{self.id}: unknown op {self.op!r}")
        self.value = _resolve_number(cfg["value"], vehicle)
        self.clear_value = _resolve_number(cfg.get("clear_value", cfg["value"]), vehicle)
        self.use_abs = bool(cfg.get("abs", False))

    def judge(self, state: AnalysisState, active: bool) -> CheckResult:
        x = state.num(self.channel)
        if not math.isfinite(x):
            return CheckResult(None)
        if self.use_abs:
            x = abs(x)
        limit = self.clear_value if active else self.value
        return CheckResult(OPS[self.op](x, limit))


class PlausibilityRule(Rule):
    """Two measurements of the same thing must agree: ``|a - b| > max_diff`` while
    ``b > min_value``; while active, cleared only below ``clear_diff``."""

    kind = "plausibility"

    def __init__(self, cfg: Mapping[str, Any], defaults: Mapping[str, Any], vehicle: Mapping[str, Any]) -> None:
        super().__init__(cfg, defaults, vehicle)
        self.a = str(cfg["a"])
        self.b = str(cfg["b"])
        self.max_diff = _resolve_number(cfg["max_diff"], vehicle)
        self.clear_diff = _resolve_number(cfg.get("clear_diff", 0.7 * self.max_diff), vehicle)
        self.min_value = _resolve_number(cfg.get("min_value", -math.inf), vehicle)

    def judge(self, state: AnalysisState, active: bool) -> CheckResult:
        a, b = state.num(self.a), state.num(self.b)
        if not (math.isfinite(a) and math.isfinite(b)) or not b > self.min_value:
            return CheckResult(None)
        return CheckResult(abs(a - b) > (self.clear_diff if active else self.max_diff))


class CustomRule(Rule):
    """Calls a registered Python check with the rule's ``params``."""

    kind = "custom"

    def __init__(self, cfg: Mapping[str, Any], defaults: Mapping[str, Any], vehicle: Mapping[str, Any]) -> None:
        super().__init__(cfg, defaults, vehicle)
        name = str(cfg.get("check", self.id))
        if name not in _CHECKS:
            raise AlertConfigError(f"{self.id}: unknown custom check {name!r} (known: {registered_checks()})")
        self.check = _CHECKS[name]
        self.params = {k: (_resolve_number(v, vehicle) if isinstance(v, str) and v.startswith("vehicle:") else v)
                       for k, v in (cfg.get("params") or {}).items()}

    def judge(self, state: AnalysisState, active: bool) -> CheckResult:
        return self.check(state, self.params, active)


RULE_TYPES: dict[str, type[Rule]] = {"threshold": ThresholdRule, "plausibility": PlausibilityRule, "custom": CustomRule}


def build_rules(config: Mapping[str, Any], vehicle: Mapping[str, Any]) -> list[Rule]:
    """Rules from the parsed ``alerts.yaml`` (``{defaults: {...}, rules: [...]}``)."""
    defaults = dict(config.get("defaults") or {})
    rules: list[Rule] = []
    seen: set[str] = set()
    for cfg in config.get("rules") or []:
        if "id" not in cfg:
            raise AlertConfigError(f"rule without id: {cfg!r}")
        kind = str(cfg.get("type", "threshold"))
        if kind not in RULE_TYPES:
            raise AlertConfigError(f"{cfg['id']}: unknown rule type {kind!r}")
        if cfg["id"] in seen:
            raise AlertConfigError(f"duplicate alert rule id {cfg['id']!r}")
        seen.add(cfg["id"])
        try:
            rules.append(RULE_TYPES[kind](cfg, defaults, vehicle))
        except KeyError as exc:
            raise AlertConfigError(f"{cfg['id']}: missing key {exc}") from None
    return rules


# --------------------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------------------


@dataclass
class _RuleRuntime:
    timer: float = 0.0  # inactive: time condition True; active: time condition False
    last: bool | None = None  # previous tick's answer (an interval counts if both ends agree)
    alert: Alert | None = None
    key: str | None = None
    true_spans: deque = field(default_factory=deque)  # (t, seconds) for within_s rules


class AlertEngine:
    """Evaluates all rules every tick and keeps the active alerts and the alert log."""

    def __init__(self, rules: Sequence[Rule]) -> None:
        self.rules = [r for r in rules if r.enabled]
        self.reset()

    @classmethod
    def from_config(cls, config: Mapping[str, Any], vehicle: Mapping[str, Any]) -> AlertEngine:
        return cls(build_rules(config, vehicle))

    def reset(self) -> None:
        self._rt = {r.id: _RuleRuntime() for r in self.rules}
        self.log: list[Alert] = []
        self._t_prev = NAN

    def active(self) -> list[Alert]:
        """Active alerts, oldest first."""
        return sorted((rt.alert for rt in self._rt.values() if rt.alert is not None), key=lambda a: a.t_start)

    def is_active(self, rule_id: str) -> bool:
        rt = self._rt.get(rule_id)
        return rt is not None and rt.alert is not None

    def evaluate(self, state: AnalysisState) -> list[Alert]:
        """Run every rule once; returns the alerts raised, updated or cleared this tick."""
        t = state.t
        dt = t - self._t_prev if math.isfinite(self._t_prev) else 0.0
        dt = min(max(dt, 0.0), MAX_DT_S)
        self._t_prev = t
        changed: list[Alert] = []
        for rule in self.rules:
            rt = self._rt[rule.id]
            try:
                res = rule.evaluate(state, rt.alert is not None)
            except Exception:  # a buggy check must not take the whole engine down
                log.exception("alert rule %s failed", rule.id)
                res = CheckResult(None)
            if rt.alert is None:
                if rule.within_s is not None:  # cumulative: True time within the window
                    if res.state is True and rt.last is True and dt > 0.0:
                        rt.true_spans.append((t, dt))
                    while rt.true_spans and rt.true_spans[0][0] < t - rule.within_s:
                        rt.true_spans.popleft()
                    rt.timer = sum(span for _, span in rt.true_spans)
                if res.state is True:
                    if rt.last is True and rule.within_s is None:
                        rt.timer += dt
                    if rt.timer >= rule.for_s - TIME_EPS_S:
                        rt.alert = Alert(id=rule.id, rule=rule.id, severity=rule.severity, title=rule.title,
                                         detail=res.detail, channels=list(res.channels), t_start=t)
                        rt.timer, rt.key = 0.0, res.key
                        rt.true_spans.clear()
                        self.log.append(rt.alert)
                        changed.append(rt.alert)
                elif res.state is False and rule.within_s is None:
                    rt.timer = 0.0
            else:
                if res.state is False:
                    if rt.last is False:
                        rt.timer += dt
                    if rt.timer >= rule.clear_for_s - TIME_EPS_S:
                        rt.alert.active = False
                        rt.alert.t_end = t
                        changed.append(rt.alert)
                        rt.alert, rt.timer, rt.key = None, 0.0, None
                elif res.state is True:
                    rt.timer = 0.0
                    if res.key is not None and res.key != rt.key:
                        rt.key = res.key
                        rt.alert.detail = res.detail
                        rt.alert.channels = list(res.channels)
                        changed.append(rt.alert)
            rt.last = res.state
        return changed


# --------------------------------------------------------------------------------------
# Custom checks
# --------------------------------------------------------------------------------------


def _pct(x: float) -> str:
    return f"{x:+.0f} %" if math.isfinite(x) else "n/a"


def _f(x: float, spec: str = ".1f") -> str:
    """Format a number for a detail text; NaN -> ``n/a``."""
    return format(x, spec) if math.isfinite(x) else "n/a"


@register_check("balance_shift")
def check_balance_shift(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """Aero balance moved away from its learned baseline by more than ``shift_pts``
    percentage points (``clear_pts`` to clear). A front-wing loss moves it rearwards, a
    rear-wing stall forwards - either changes the car's handling balance."""
    mon = state.aero_health
    if mon is None:
        return CheckResult(None)
    shift = mon.shift("balance")
    if not math.isfinite(shift):
        return CheckResult(None)
    limit = float(params.get("clear_pts", 2.5) if active else params.get("shift_pts", 4.0))
    where = "rearwards" if shift < 0 else "forwards"
    detail = (f"Aero balance {mon.current['balance']:.1f} % front vs baseline {mon.base('balance'):.1f} % "
              f"({shift:+.1f} pts, {where})")
    return CheckResult(abs(shift) > limit, detail, ["calc_aero_balance", "calc_downforce_f", "calc_downforce_r"])


def _cluster_text(state: AnalysisState, element: str) -> tuple[str, list[str]]:
    taps = state.taps
    if taps is None:
        return "", []
    clusters = [c for c in taps.clusters if c.element == element]
    if not clusters:
        return "", []
    names = [t for c in clusters for t in c.taps]
    return f"; taps {', '.join(names)} deviate together (aero, not sensor)", names


@register_check("rw_suction_loss")
def check_rw_suction_loss(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """Rear-wing section Cl (mean of both stations) dropped by more than ``drop_pct`` vs
    its baseline - e.g. a flap stall, where the aft suction taps collapse. A smaller drop
    (``cluster_drop_pct``) is enough when a cluster of rear-wing taps confirms it."""
    mon = state.aero_health
    if mon is None:
        return CheckResult(None)
    ratio = mon.ratio(("cl_rw_l", "cl_rw_r"))
    if not math.isfinite(ratio):
        return CheckResult(None)
    drop = (1.0 - ratio) * 100.0
    cluster_txt, cluster_taps = _cluster_text(state, "rw")
    if active:
        bad = drop > float(params.get("clear_pct", 12.0))
    else:
        bad = drop > float(params.get("drop_pct", 20.0)) or (
            bool(cluster_taps) and drop > float(params.get("cluster_drop_pct", 15.0)))
    cur = 0.5 * (mon.current["cl_rw_l"] + mon.current["cl_rw_r"])
    base = 0.5 * (mon.base("cl_rw_l") + mon.base("cl_rw_r"))
    detail = (f"RW section Cl {cur:.2f} vs baseline {base:.2f} ({_pct(-drop)}; L {mon.current['cl_rw_l']:.2f}, "
              f"R {mon.current['cl_rw_r']:.2f}){cluster_txt}")
    return CheckResult(bad, detail, ["calc_cl_rw_l", "calc_cl_rw_r"] + cluster_taps)


@register_check("ut_stall")
def check_ut_stall(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """Undertray suction (mean Cp) fell below ``1 - loss_pct/100`` of its baseline: the
    diffuser has stalled - usually because the floor runs too close to the ground."""
    mon = state.aero_health
    if mon is None:
        return CheckResult(None)
    ratio = mon.ratio(("cp_ut_mean",))
    if not math.isfinite(ratio):
        return CheckResult(None)
    loss = (1.0 - ratio) * 100.0
    limit = float(params.get("clear_pct", 15.0) if active else params.get("loss_pct", 30.0))
    detail = (f"Undertray mean Cp {mon.current['cp_ut_mean']:.2f} vs baseline {mon.base('cp_ut_mean'):.2f} "
              f"(suction {_pct(-loss)}); ride height F {_f(state.num('rh_front'))} mm / "
              f"R {_f(state.num('rh_rear'))} mm")
    return CheckResult(loss > limit, detail, ["calc_cp_ut_mean", "rh_front", "rh_rear"])


@register_check("tap_anomaly")
def check_tap_anomaly(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """A pressure tap deviates on its own while its neighbours read normally: a sensor or
    tubing fault, not aerodynamics (classification by :mod:`aerovolt.analysis.anomaly`)."""
    taps = state.taps
    if taps is None:
        return CheckResult(None)
    findings = taps.findings("sensor")
    if not findings:
        return CheckResult(False)
    parts = []
    for f in findings:
        z = f"z {f.z:+.0f}, " if math.isfinite(f.z) else ""
        parts.append(f"{f.tap} Cp {f.cp:.2f} vs learned {f.baseline:.2f} ({z}neighbours "
                     f"{', '.join(f.neighbours)} normal)")
    detail = "; ".join(parts) + " -> sensor/tubing fault, tap excluded from section Cl"
    channels = [f.tap for f in findings] + [f"calc_cp_{f.tap}" for f in findings]
    return CheckResult(True, detail, channels, key=",".join(f.tap for f in findings))


@register_check("stale_channels")
def check_stale(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """Raw channels that were live and stopped updating while data keeps flowing."""
    if not state.stale:
        return CheckResult(False)
    names = sorted(state.stale)
    shown = int(params.get("max_listed", 6))
    listed = ", ".join(f"{cid} ({state.stale[cid]:.1f} s)" for cid in names[:shown])
    more = f" and {len(names) - shown} more" if len(names) > shown else ""
    detail = f"{len(names)} channel(s) stopped updating: {listed}{more}"
    return CheckResult(True, detail, names, key=",".join(names))


def _sensor_cells_text(j: int, n_cells: int, n_sensors: int) -> str:
    cells = physics.temp_sensor_cells(j, n_cells, n_sensors)
    return f"cells {cells.start}-{cells.stop - 1}" if len(cells) > 1 else f"cell {cells.start}"


@register_check("cell_temp_outlier")
def check_cell_temp_outlier(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """One temperature sensor runs hotter than the rest of the pack: deviation from the
    pack median above ``min_abs_c`` AND a robust z-score above ``z`` (median/MAD, so the
    hot cell cannot hide by pulling the reference up). Typical cause: a high-resistance
    cell or weld heating by ``I^2 R``."""
    from aerovolt.analysis.powertrain import find_outlier

    ids = list(state.cell_t_ids)
    temps = np.array([state.num(cid) for cid in ids])
    if np.isfinite(temps).sum() < max(3, len(ids) // 2):
        return CheckResult(None)
    min_abs = float(params.get("clear_abs_c", 1.8) if active else params.get("min_abs_c", 2.5))
    out = find_outlier(temps, z_threshold=float(params.get("z", 4.0)), min_abs=min_abs, side="high",
                       sigma_floor=float(params.get("sigma_floor_c", 0.3)))
    if out is None:
        return CheckResult(False)
    n_cells = len(state.cell_v_ids) or 140
    cells = _sensor_cells_text(out.index, n_cells, len(ids))
    suspect = _suspect_cell(state, physics.temp_sensor_cells(out.index, n_cells, len(ids)))
    detail = (f"{ids[out.index]} ({cells}) at {out.value:.1f} °C, {out.deviation:+.1f} °C vs pack median "
              f"{out.median:.1f} °C (z {out.z:.1f}){suspect}")
    return CheckResult(True, detail, [ids[out.index], "calc_cell_t_max"], key=ids[out.index])


def _suspect_cell(state: AnalysisState, cells: range) -> str:
    """Name the cell under a hot sensor whose internal resistance is clearly high, if any."""
    tracker = state.cells
    if tracker is None or not getattr(tracker, "ready", False):
        return ""
    dr = tracker.resistance_dev_ohm()
    best = max(cells, key=lambda k: dr[k] if math.isfinite(dr[k]) else -math.inf)
    if math.isfinite(dr[best]) and dr[best] > 0.5e-3:
        return f"; cell {best} internal resistance +{dr[best] * 1e3:.1f} mOhm vs pack"
    return ""


def _bucket(magnitude: float) -> int:
    """Octave of a growing estimate (1, 2, 4, 8 ...): the alert text is refreshed each time
    the estimate doubles while the fit converges, not on every small change."""
    return int(math.floor(math.log2(magnitude))) if magnitude > 0 else 0


@register_check("cell_voltage_outlier")
def check_cell_voltage_outlier(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """A cell's voltage behaves differently from the pack (powertrain.CellDeviationTracker):

    * **low zero-current offset** (below the pack by ``offset_mv`` and a robust z of ``z``):
      the cell's SoC is falling faster - low capacity (a "weak" cell);
    * **high internal resistance** (``resistance_mohm`` above the pack and robust z): it sags
      more under load - a bad weld or a damaged cell.
    """
    from aerovolt.analysis.powertrain import find_outlier

    tracker = state.cells
    if tracker is None or not tracker.ready:
        return CheckResult(None)
    scale = 0.6 if active else 1.0  # hysteresis: clear at 60 % of the raise thresholds
    z = float(params.get("z", 5.0)) * scale
    weak = find_outlier(tracker.offset_v() * 1e3, z_threshold=z, side="low",
                        min_abs=float(params.get("offset_mv", 8.0)) * scale,
                        sigma_floor=float(params.get("offset_sigma_floor_mv", 1.0)))
    resist = find_outlier(tracker.resistance_dev_ohm() * 1e3, z_threshold=z, side="high",
                          min_abs=float(params.get("resistance_mohm", 1.0)) * scale,
                          sigma_floor=float(params.get("resistance_sigma_floor_mohm", 0.1)))
    if weak is not None and resist is not None and weak.index == resist.index:
        weak = None  # a resistance change also biases the offset fit for a while: report the cause
    ids = list(state.cell_v_ids)
    parts, channels, keys = [], [], []
    if weak is not None:
        cid = ids[weak.index] if weak.index < len(ids) else f"cell {weak.index}"
        parts.append(f"cell {weak.index} {weak.deviation:+.0f} mV vs pack at zero current "
                     f"(z {weak.z:.0f}): low capacity, discharging faster")
        channels.append(cid)
        keys.append(f"w{weak.index}:{_bucket(-weak.deviation)}")
    if resist is not None:
        cid = ids[resist.index] if resist.index < len(ids) else f"cell {resist.index}"
        parts.append(f"cell {resist.index} internal resistance {resist.deviation:+.1f} mOhm vs pack "
                     f"(z {resist.z:.0f}): sags under load, check weld/connection")
        channels.append(cid)
        keys.append(f"r{resist.index}:{_bucket(resist.deviation)}")
    if not parts:
        return CheckResult(False)
    return CheckResult(True, "; ".join(parts), channels + ["calc_cell_v_min"], key=",".join(keys))


@register_check("soc_divergence")
def check_soc_divergence(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """Coulomb counting and the EKF disagree, or the CC's input is provably biased.

    Two pieces of evidence (either raises):

    * ``|SoC_cc - SoC_ekf| > max_diff_pct`` - the counter has drifted;
    * the pack current sensor and the inverter's DC current sensor - which measure the
      same current - disagree on average by more than ``current_mismatch_a``: a sensor
      offset that *will* make the counter drift (+3 A = 0.31 % SoC per minute on a 16 Ah
      pack). This catches the fault minutes before the SoC difference becomes visible.
    """
    cc, ekf = state.num("calc_soc_cc"), state.num("calc_soc_ekf")
    mismatch = state.current_mismatch_a
    if not (math.isfinite(cc) and math.isfinite(ekf)) and not math.isfinite(mismatch):
        return CheckResult(None)
    scale = 0.6 if active else 1.0
    diff = cc - ekf if math.isfinite(cc) and math.isfinite(ekf) else NAN
    soc_bad = math.isfinite(diff) and abs(diff) > float(params.get("max_diff_pct", 4.0)) * scale
    cur_bad = math.isfinite(mismatch) and abs(mismatch) > float(params.get("current_mismatch_a", 1.5)) * scale
    detail = f"SoC Coulomb counting {_f(cc)} % vs EKF {_f(ekf)} % ({_f(diff, '+.1f')} pts)"
    if math.isfinite(mismatch):
        detail += f"; pack current sensor reads {mismatch:+.1f} A vs inverter DC current"
        if math.isfinite(state.pack_capacity_ah) and state.pack_capacity_ah > 0:
            drift = mismatch / state.pack_capacity_ah / 3600.0 * 100.0 * 60.0  # %/min
            detail += f" -> counter drifting {-drift:+.2f} %/min"
    return CheckResult(soc_bad or cur_bad, detail, ["calc_soc_cc", "calc_soc_ekf", "pack_current", "inv_dc_current"])


@register_check("sdc_open")
def check_sdc_open(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """The shutdown circuit opened after it had been closed this session (a parked car with
    the SDC open is normal). The detail names the safety devices that opened it."""
    sdc = state.num("sdc_closed")
    if not math.isfinite(sdc) or not state.sdc_armed:
        return CheckResult(None)
    if sdc >= 0.5:
        return CheckResult(False)
    causes = [name for cid, name in (("ams_ok", "AMS"), ("imd_ok", "IMD"), ("bspd_ok", "BSPD"),
                                     ("apps_plaus_ok", "APPS plausibility"))
              if math.isfinite(state.num(cid)) and state.num(cid) < 0.5]
    cause = f"opened by {', '.join(causes)}" if causes else "no device flag set (check the inertia switch / stop buttons)"
    detail = f"Shutdown circuit open: {cause}; tractive system disabled, AIRs open"
    return CheckResult(True, detail, ["sdc_closed", "ams_ok", "imd_ok", "bspd_ok", "apps_plaus_ok"], key=cause)


@register_check("energy_short")
def check_energy_short(state: AnalysisState, params: Mapping[str, Any], active: bool) -> CheckResult:
    """The endurance strategy predicts the car will not finish (with the reserve) at the
    power limit it is running now."""
    s = state.strategy
    if s is None:
        return CheckResult(None)
    if not s.energy_short:
        return CheckResult(False)
    detail = (f"At {s.current_kw:.0f} kW the remaining {s.laps_left} laps need {s.energy_needed_kwh:.2f} kWh, "
              f"only {s.energy_available_kwh:.2f} kWh available after the reserve -> "
              f"recommend {s.recommended_kw:.0f} kW")
    return CheckResult(True, detail, ["calc_power_limit_rec", "calc_laps_remaining", "calc_soc_ekf"],
                       key=f"{s.recommended_kw:.0f}")
