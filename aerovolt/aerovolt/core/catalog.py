"""Channel catalogue: the single source of truth for every channel (SPEC section 2).

``config/sensors.yaml`` is organised in *sections*. Each section has ``defaults`` (fields
shared by its channels, e.g. unit, rate, noise) and a list of ``channels``::

    sections:
      - title: Front wing taps
        defaults: {system: aero, group: aero.taps, unit: Pa, rate_hz: 50, ...}
        channels:
          - {id: fw_p01, name: "...", meta: {element: fw, station: L, surface: suction, x_c: 0.05}}

A channel entry that has a ``count`` key is a **repeat**: it is expanded ``count`` times
with the loop variable ``i`` running from ``start`` (default 0). Every string in the entry
(including ``meta``) is formatted with ``str.format`` using ``i`` and any extra integer
variables defined in ``vars`` as small arithmetic expressions of ``i``::

    - {id: "cell_v_{i:03d}", count: 140, start: 0, vars: {seg: "i // 28"},
       name: "Cell {i:03d} voltage (segment {seg})", meta: {index: "{i}", segment: "{seg}"}}

A string that is exactly one placeholder (``"{i}"``) becomes the number itself.

Validation: unique ids; ``derived`` <=> ``calc_`` prefix <=> ``system: calc``;
``system: truth`` <=> ``truth_`` prefix; ``min < max``; non-negative noise/resolution/lag.

Tap positions: if the vehicle dict (``config/vehicle.yaml``) is passed, every tap gets
``meta.pos = [x, y, z]`` in the car frame (ISO 8855, origin at the front axle on the
ground, x forward, y left, z up), see :func:`tap_position`.
"""

from __future__ import annotations

import ast
import operator
import re
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping

import yaml

from .model import ChannelDef

#: Groups whose channels are surface pressure taps.
TAP_GROUP = "aero.taps"

#: Height of the pressure (upper) surface taps above the suction (lower) surface, as a
#: fraction of the chord: a typical maximum thickness of a high-lift main plane is
#: 10-12 % of the chord. ``vehicle.yaml`` gives ``z_m`` for the lower (suction) surface.
WING_THICKNESS_FRAC = 0.10

_REQUIRED = ("id", "name", "unit", "system", "group", "rate_hz", "min", "max")
_FLOAT_FIELDS = ("rate_hz", "min", "max", "noise", "resolution", "lag_s")
_THRESHOLDS = ("warn_lo", "warn_hi", "crit_lo", "crit_hi")
_ALLOWED = set(_REQUIRED) | set(_FLOAT_FIELDS) | set(_THRESHOLDS) | {"derived", "meta"}
_REPEAT_KEYS = {"count", "start", "vars"}
_SINGLE_PLACEHOLDER = re.compile(r"^\{(\w+)\}$")

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
}


class CatalogError(ValueError):
    """The channel catalogue file is invalid."""


def _eval_int_expr(expr: str, env: Mapping[str, int]) -> int:
    """Evaluate a tiny integer expression such as ``"i // 28"`` (+ - * // % only).

    Uses the ``ast`` module instead of ``eval`` so the YAML cannot run arbitrary code.
    """

    def ev(node: ast.AST) -> int:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int):
            return node.value
        if isinstance(node, ast.Name) and node.id in env:
            return env[node.id]
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
            return _BIN_OPS[type(node.op)](ev(node.left), ev(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -ev(node.operand)
        raise CatalogError(f"unsupported expression in repeat vars: {expr!r}")

    return ev(ast.parse(str(expr), mode="eval"))


def _substitute(value: Any, env: Mapping[str, int]) -> Any:
    """Format every string inside ``value`` with the repeat variables."""
    if isinstance(value, str):
        single = _SINGLE_PLACEHOLDER.match(value)
        if single and single.group(1) in env:
            return env[single.group(1)]
        return value.format(**env)
    if isinstance(value, dict):
        return {k: _substitute(v, env) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute(v, env) for v in value]
    return value


def expand_entry(entry: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Expand one channel entry; a non-repeat entry is returned as a one-item list."""
    if "count" not in entry:
        return [dict(entry)]
    template = {k: v for k, v in entry.items() if k not in _REPEAT_KEYS}
    start = int(entry.get("start", 0))
    out = []
    for i in range(start, start + int(entry["count"])):
        env = {"i": i}
        for name, expr in (entry.get("vars") or {}).items():
            env[name] = _eval_int_expr(expr, env)
        out.append(_substitute(template, env))
    return out


def tap_position(meta: Mapping[str, Any], vehicle: Mapping[str, Any]) -> list[float]:
    """Position ``[x, y, z]`` (m, car frame) of a pressure tap from the vehicle geometry.

    * Wings (``element`` ``fw``/``rw``): ``x = le_x - x_c * chord`` (the leading edge is the
      most forward point, x is positive forward); ``y`` = station y (``station_y_m[0]`` for
      station ``L``, ``[1]`` for ``R``); ``z`` = wing ``z_m`` on the suction (lower) surface,
      ``z_m + WING_THICKNESS_FRAC * chord`` on the pressure (upper) surface.
    * Undertray (``ut``): ``x`` interpolated from ``x_start`` (fraction 0) to ``x_end``
      (fraction 1) by ``x_c``; ``y`` from ``meta.y`` (0 on the centreline, +-0.30 m for the
      diffuser tunnels); ``z`` = floor ``z_m``.
    """
    aero = vehicle["aero"]
    element = meta["element"]
    x_c = float(meta["x_c"])
    if element in ("fw", "rw"):
        wing = aero["front_wing" if element == "fw" else "rear_wing"]
        chord = float(wing["chord_m"])
        stations = list(wing["station_y_m"])
        y = float(stations[0] if meta["station"] == "L" else stations[1])
        z = float(wing["z_m"])
        if meta["surface"] == "pressure":
            z += WING_THICKNESS_FRAC * chord
        x = float(wing["le_x_m"]) - x_c * chord
        return [round(x, 4), round(y, 4), round(z, 4)]
    if element == "ut":
        floor = aero["undertray"]
        x0, x1 = float(floor["x_start_m"]), float(floor["x_end_m"])
        x = x0 + x_c * (x1 - x0)
        return [round(x, 4), round(float(meta.get("y", 0.0)), 4), round(float(floor["z_m"]), 4)]
    raise CatalogError(f"unknown tap element {element!r}")


def _make_channel(raw: Mapping[str, Any], defaults: Mapping[str, Any]) -> ChannelDef:
    merged: dict[str, Any] = {**defaults, **raw}
    if "meta" in defaults and "meta" in raw:
        merged["meta"] = {**defaults["meta"], **raw["meta"]}
    unknown = set(merged) - _ALLOWED
    cid = merged.get("id", "<no id>")
    if unknown:
        raise CatalogError(f"{cid}: unknown field(s) {sorted(unknown)}")
    missing = [k for k in _REQUIRED if merged.get(k) is None]
    if missing:
        raise CatalogError(f"{cid}: missing field(s) {missing}")
    kwargs: dict[str, Any] = {
        "id": str(merged["id"]),
        "name": str(merged["name"]),
        "unit": str(merged["unit"]),
        "system": str(merged["system"]),
        "group": str(merged["group"]),
        "meta": dict(merged.get("meta") or {}),
    }
    for key in _FLOAT_FIELDS:
        kwargs[key] = float(merged.get(key, 0.0))
    for key in _THRESHOLDS:
        val = merged.get(key)
        kwargs[key] = None if val is None else float(val)
    kwargs["derived"] = bool(merged.get("derived", kwargs["id"].startswith("calc_")))
    return ChannelDef(**kwargs)


def _validate(ch: ChannelDef) -> None:
    is_calc = ch.id.startswith("calc_")
    if ch.derived != is_calc or (ch.system == "calc") != is_calc:
        raise CatalogError(f"{ch.id}: derived channels must use the calc_ prefix and system 'calc' (and only they)")
    if (ch.system == "truth") != ch.id.startswith("truth_"):
        raise CatalogError(f"{ch.id}: truth channels must use the truth_ prefix and system 'truth' (and only they)")
    if not re.fullmatch(r"[a-z][a-z0-9_]*", ch.id):
        raise CatalogError(f"{ch.id}: ids must be snake_case")
    if not ch.min < ch.max:
        raise CatalogError(f"{ch.id}: min ({ch.min}) must be < max ({ch.max})")
    if ch.rate_hz <= 0:
        raise CatalogError(f"{ch.id}: rate_hz must be > 0")
    if min(ch.noise, ch.resolution, ch.lag_s) < 0:
        raise CatalogError(f"{ch.id}: noise, resolution and lag_s must be >= 0")
    if ch.is_tap:
        for key in ("element", "station", "surface", "x_c"):
            if key not in ch.meta:
                raise CatalogError(f"{ch.id}: tap meta needs {key!r}")


class Catalog:
    """Ordered, validated collection of :class:`ChannelDef`.

    ``catalog[id]`` -> ChannelDef, ``id in catalog``, ``len(catalog)``, iteration in file
    order, :meth:`ids`, :meth:`raw_ids`, :meth:`taps`, :meth:`to_json`, :meth:`index`.
    """

    def __init__(self, channels: Iterable[ChannelDef]) -> None:
        self._channels: list[ChannelDef] = list(channels)
        self._by_id: dict[str, ChannelDef] = {}
        self._index: dict[str, int] = {}
        for i, ch in enumerate(self._channels):
            if ch.id in self._by_id:
                raise CatalogError(f"duplicate channel id {ch.id!r}")
            _validate(ch)
            self._by_id[ch.id] = ch
            self._index[ch.id] = i

    # ---- construction -----------------------------------------------------------------

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], vehicle: Mapping[str, Any] | None = None) -> Catalog:
        """Build from the parsed YAML; ``vehicle`` (optional) adds tap positions."""
        channels: list[ChannelDef] = []
        for section in data["sections"]:
            defaults = dict(section.get("defaults") or {})
            for entry in section["channels"]:
                for raw in expand_entry(entry):
                    channels.append(_make_channel(raw, defaults))
        if vehicle is not None:
            channels = [_with_position(ch, vehicle) for ch in channels]
        return cls(channels)

    @classmethod
    def load(cls, path: str | Path, vehicle: Mapping[str, Any] | None = None) -> Catalog:
        """Load ``config/sensors.yaml``. Pass the vehicle dict to compute tap positions."""
        with open(path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        try:
            return cls.from_dict(data, vehicle)
        except (KeyError, TypeError) as exc:
            raise CatalogError(f"{path}: malformed catalogue ({exc!r})") from exc

    # ---- container protocol -----------------------------------------------------------

    def __getitem__(self, cid: str) -> ChannelDef:
        return self._by_id[cid]

    def __contains__(self, cid: object) -> bool:
        return cid in self._by_id

    def __len__(self) -> int:
        return len(self._channels)

    def __iter__(self) -> Iterator[ChannelDef]:
        return iter(self._channels)

    def get(self, cid: str) -> ChannelDef | None:
        return self._by_id.get(cid)

    def index(self, cid: str) -> int:
        """Position of a channel in catalogue order (column index of the history buffer)."""
        return self._index[cid]

    # ---- queries ----------------------------------------------------------------------

    def ids(self, system: str | None = None, group: str | None = None) -> list[str]:
        """Channel ids in catalogue order, optionally filtered.

        ``group`` matches exactly or as a dotted prefix: ``group="bms"`` selects
        ``bms.pack``, ``bms.cell_v`` and ``bms.cell_t``.
        """
        out = []
        for ch in self._channels:
            if system is not None and ch.system != system:
                continue
            if group is not None and ch.group != group and not ch.group.startswith(group + "."):
                continue
            out.append(ch.id)
        return out

    def raw_ids(self) -> list[str]:
        """Channels produced by sources (sim or hardware): not derived and not truth."""
        return [ch.id for ch in self._channels if ch.is_raw]

    def calc_ids(self) -> list[str]:
        """Derived ``calc_*`` channels computed by the analysis."""
        return [ch.id for ch in self._channels if ch.derived]

    def truth_ids(self) -> list[str]:
        """Simulator ground-truth ``truth_*`` channels."""
        return [ch.id for ch in self._channels if ch.is_truth]

    def taps(self, element: str | None = None) -> list[ChannelDef]:
        """Pressure-tap channels in catalogue order, optionally of one element (fw/rw/ut)."""
        return [ch for ch in self._channels
                if ch.is_tap and (element is None or ch.meta.get("element") == element)]

    def to_json(self) -> list[dict[str, Any]]:
        """List of ChannelDef dicts for the web (``hello.channels``)."""
        return [ch.to_json() for ch in self._channels]


def _with_position(ch: ChannelDef, vehicle: Mapping[str, Any]) -> ChannelDef:
    if not ch.is_tap:
        return ch
    meta = dict(ch.meta)
    meta["pos"] = tap_position(meta, vehicle)
    return ChannelDef(**{**{f: getattr(ch, f) for f in ch.__dataclass_fields__}, "meta": meta})
