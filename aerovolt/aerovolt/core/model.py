"""Shared data model: channel definitions, faults, alerts, lap summaries.

Everything that crosses a module boundary (simulator -> manager -> store -> analysis ->
server -> web) is described here, so every module speaks the same language.

JSON rule (SPEC section 0): a missing / invalid number is ``float('nan')`` in Python and
``null`` in JSON. :func:`json_value` performs that conversion (and sensible rounding) and
every ``to_json()`` in this module uses it, so NaN never reaches a browser.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, fields
from typing import Any, Callable

#: Callback a source uses to publish samples: ``emit(t, {channel_id: value})``.
#: ``t`` is session time in seconds (sim time for the simulator, arrival time for real
#: sources). Must be called from the asyncio event-loop thread.
Emit = Callable[[float, dict[str, float]], None]

NAN = float("nan")


def is_missing(value: float | None) -> bool:
    """True for ``None``, NaN and +-inf: values that must be shown as "no data"."""
    return value is None or not math.isfinite(value)


def decimals_for_resolution(resolution: float) -> int:
    """Number of decimal places that resolves ``resolution`` with one guard digit.

    A channel quantised in 0.1 Pa steps is sent with 2 decimals, a 1 mV cell voltage
    (0.001 V) with 4 decimals, a 1e-7 deg GPS coordinate with 8. A resolution of 0
    (unknown / continuous) falls back to 4 significant figures in :func:`json_value`.
    """
    if resolution <= 0 or not math.isfinite(resolution):
        return -1
    return max(0, -math.floor(math.log10(resolution))) + 1


def json_value(value: float | int | None, resolution: float = 0.0) -> float | None:
    """Convert a number for JSON: NaN/inf -> ``None``, otherwise round sensibly.

    Rounding keeps one digit beyond the channel resolution (see
    :func:`decimals_for_resolution`); without a resolution it keeps 4 significant figures.
    Booleans and integers are returned as plain numbers.
    """
    if value is None:
        return None
    x = float(value)
    if not math.isfinite(x):
        return None
    if x == 0.0:
        return 0.0
    places = decimals_for_resolution(resolution)
    if places < 0:
        magnitude = math.floor(math.log10(abs(x)))
        places = max(0, 3 - magnitude)
    return round(x, places)


def _json_any(value: Any) -> Any:
    """Recursively make ``value`` JSON-safe (floats via :func:`json_value`, tuples -> lists)."""
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        return None if not math.isfinite(value) else value
    if isinstance(value, dict):
        return {str(k): _json_any(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_any(v) for v in value]
    if hasattr(value, "item"):  # numpy scalar
        return _json_any(value.item())
    return value


@dataclass(frozen=True)
class ChannelDef:
    """One measurable or derived quantity (a row of ``config/sensors.yaml``).

    ``min``/``max`` are the physical range of the sensor (gauges, plausibility checks and
    range clipping in the simulator). ``noise`` (1-sigma), ``resolution`` (quantisation
    step) and ``lag_s`` (first-order lag time constant, e.g. pneumatic tubing) describe the
    *virtual* sensor used by the simulator. ``warn_*``/``crit_*`` are display thresholds
    (``None`` = no threshold). ``meta`` carries extra information such as tap geometry.
    """

    id: str
    name: str
    unit: str
    system: str
    group: str
    rate_hz: float
    min: float
    max: float
    noise: float = 0.0
    resolution: float = 0.0
    lag_s: float = 0.0
    warn_lo: float | None = None
    warn_hi: float | None = None
    crit_lo: float | None = None
    crit_hi: float | None = None
    derived: bool = False
    meta: dict[str, Any] = field(default_factory=dict, compare=False, hash=False)

    @property
    def is_truth(self) -> bool:
        """Simulator ground truth (``truth_*``), never produced by real sensors."""
        return self.system == "truth"

    @property
    def is_raw(self) -> bool:
        """A channel that sources (sim or hardware) produce: not derived, not truth."""
        return not self.derived and not self.is_truth

    @property
    def is_tap(self) -> bool:
        """A surface pressure tap (front wing, rear wing or undertray)."""
        return self.group == "aero.taps"

    def to_json(self) -> dict[str, Any]:
        """Plain dict for the web (``hello.channels``); NaN -> ``None``."""
        return {f.name: _json_any(getattr(self, f.name)) for f in fields(self)}


@dataclass
class FaultInfo:
    """An injectable simulator fault (SPEC section 5.5) and whether it is active."""

    id: str
    title: str
    system: str
    description: str
    active: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "system": self.system,
            "description": self.description,
            "active": bool(self.active),
        }


@dataclass
class Alert:
    """A raised (or cleared) alert produced by the rule engine (SPEC section 6.5).

    ``id`` identifies this alert instance (usually the rule id, optionally with a suffix
    such as the cell number), ``rule`` the rule in ``config/alerts.yaml`` that raised it.
    ``t_end`` is ``None`` while the alert is active.
    """

    id: str
    rule: str
    severity: str  # 'info' | 'warn' | 'critical'
    title: str
    detail: str
    channels: list[str]
    t_start: float
    t_end: float | None = None
    active: bool = True

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "rule": self.rule,
            "severity": self.severity,
            "title": self.title,
            "detail": self.detail,
            "channels": list(self.channels),
            "t_start": json_value(self.t_start, 0.001),
            "t_end": None if self.t_end is None else json_value(self.t_end, 0.001),
            "active": bool(self.active),
        }


@dataclass
class LapSummary:
    """Statistics of one completed lap (SPEC section 6, ``laps.py``).

    Units: lap_time s, distance m, v_avg / v_max m/s, energy_kwh / regen_kwh kWh (battery
    side), cla_avg / cda_avg m^2, balance_avg % front, cell_t_max degC, cell_v_min V,
    mot_temp_max degC. Unknown values are NaN.
    """

    lap: int
    lap_time: float
    distance: float
    v_avg: float
    v_max: float
    energy_kwh: float
    regen_kwh: float
    cla_avg: float
    cda_avg: float
    balance_avg: float
    cell_t_max: float
    cell_v_min: float
    mot_temp_max: float

    _RESOLUTION = {
        "lap_time": 0.001,
        "distance": 0.1,
        "v_avg": 0.01,
        "v_max": 0.01,
        "energy_kwh": 0.0001,
        "regen_kwh": 0.0001,
        "cla_avg": 0.001,
        "cda_avg": 0.001,
        "balance_avg": 0.01,
        "cell_t_max": 0.1,
        "cell_v_min": 0.001,
        "mot_temp_max": 0.1,
    }

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"lap": int(self.lap)}
        for f in fields(self):
            if f.name != "lap":
                out[f.name] = json_value(getattr(self, f.name), self._RESOLUTION[f.name])
        return out
