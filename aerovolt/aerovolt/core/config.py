"""Application configuration: ``load_config(path, overrides) -> AppConfig`` (SPEC section 4).

A config file (``config/demo.yaml``, ``config/hybrid_serial.yaml`` ...) selects the data
sources and server settings and points at the shared files (vehicle, channel catalogue,
CAN layout, alert rules, calibration). Relative paths are resolved against the project
root (the folder that contains ``config/`` and the ``aerovolt`` package), so the program
works from any working directory.

Config file keys (all optional except ``sources``)::

    session:    {name: str, log: path | null}
    server:     {host: 127.0.0.1, port: 8080, broadcast_hz: 20}
    processing: {process_hz: 20, snapshot_hz: 20, history_s: 300}
    track:      fs_endurance          # venue; used by the sim and by real-car lap timing
    sources:    [{type: sim|serial|can|replay, label: ..., ...source specific...}, ...]
    paths:      {vehicle, sensors, can_layout, alerts, calibration}

Normalisation done here so that the sources do not have to:

* every source dict has ``type`` and ``label``;
* every ``sim`` source has ``track`` (default: the top-level track), ``speed`` (float, or
  the string ``"max"`` = as fast as possible), ``seed``, ``weather`` (defaults merged) and
  ``faults`` as a list of ``{"id": str, "t": float}`` (scheduled activations).

CLI overrides (``overrides`` dict, keys as produced by ``python -m aerovolt``): ``speed``,
``track``, ``host``, ``port``, ``faults`` (list of ``"id@t"`` strings), ``log``,
``headless``, ``duration``. ``None`` values are ignored.
"""

from __future__ import annotations

import copy
import functools
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import yaml

from .catalog import Catalog

#: Project root: .../aerovolt (contains config/, web/, the aerovolt package ...).
PROJECT_ROOT = Path(__file__).resolve().parents[2]

SOURCE_LABELS = {"sim": "Simulator", "serial": "Serial sensor node", "can": "CAN bus", "replay": "Log replay"}

DEFAULT_WEATHER = {"temp_c": 20.0, "pressure_pa": 101325.0, "rh_pct": 50.0, "wind_ms": 0.0, "wind_dir_deg": 0.0}

DEFAULT_PATHS = {
    "vehicle": "config/vehicle.yaml",
    "sensors": "config/sensors.yaml",
    "can_layout": "config/can_layout.yaml",
    "alerts": "config/alerts.yaml",
    "calibration": "config/calibration.yaml",
}


class ConfigError(ValueError):
    """The configuration file or an override is invalid."""


# --------------------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Calibration:
    """Linear correction of a real sensor: ``value = (raw - offset) * scale``.

    ``offset`` is the zero reading (e.g. a pressure sensor's output with no airflow),
    ``scale`` the gain correction (1.0 = none).
    """

    offset: float = 0.0
    scale: float = 1.0

    def apply(self, raw: float) -> float:
        return (raw - self.offset) * self.scale


def load_calibration(path: str | Path) -> dict[str, Calibration]:
    """Read ``config/calibration.yaml``: ``{channel: {offset, scale, ...}}``.

    A missing or empty file means "no calibration". Extra keys per channel (e.g. ``note``,
    ``date``, ``samples`` written by ``tools/calibrate_taps.py``) are ignored.
    """
    p = Path(path)
    if not p.exists():
        return {}
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(data, Mapping):
        raise ConfigError(f"{p}: calibration must be a mapping channel -> {{offset, scale}}")
    out: dict[str, Calibration] = {}
    for cid, entry in data.items():
        entry = entry or {}
        out[str(cid)] = Calibration(offset=float(entry.get("offset", 0.0)), scale=float(entry.get("scale", 1.0)))
    return out


# --------------------------------------------------------------------------------------
# Config dataclasses
# --------------------------------------------------------------------------------------


@dataclass
class SessionConfig:
    name: str = "AeroVolt session"
    log: Path | None = None  # data log file (.csv or .csv.gz); None = no logging


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8080
    broadcast_hz: float = 20.0


@dataclass
class ProcessingConfig:
    process_hz: float = 20.0  # analysis tick rate (data time)
    snapshot_hz: float = 20.0  # history / log row rate
    history_s: float = 300.0  # in-memory history length


@dataclass
class PathsConfig:
    vehicle: Path
    sensors: Path
    can_layout: Path
    alerts: Path
    calibration: Path


@dataclass
class AppConfig:
    """Everything the session needs, with all paths absolute and shared files loaded."""

    path: Path | None
    root: Path
    session: SessionConfig
    server: ServerConfig
    processing: ProcessingConfig
    track: str
    sources: list[dict[str, Any]]
    paths: PathsConfig
    vehicle: dict[str, Any]
    catalog: Catalog
    calibration: dict[str, Calibration]
    headless: bool = False
    duration: float | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @functools.cached_property
    def alerts(self) -> dict[str, Any]:
        """Alert rules from ``paths.alerts`` (loaded on first use; ``{}`` if no file)."""
        if not self.paths.alerts.exists():
            return {}
        return yaml.safe_load(self.paths.alerts.read_text(encoding="utf-8")) or {}

    def resolve(self, path: str | Path) -> Path:
        """Resolve a path from the config against the project root."""
        return resolve_path(path, self.root)

    def source_kinds(self) -> list[str]:
        return [s["type"] for s in self.sources]


# --------------------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------------------


def resolve_path(path: str | Path, root: Path = PROJECT_ROOT) -> Path:
    p = Path(path).expanduser()
    return p if p.is_absolute() else (root / p).resolve()


def load_yaml(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def parse_fault_schedule(item: str | Mapping[str, Any]) -> dict[str, Any]:
    """``"cell_hot@60"`` -> ``{"id": "cell_hot", "t": 60.0}``; ``"cell_hot"`` -> t = 0.

    Mappings ``{id, t}`` pass through (validated).
    """
    if isinstance(item, Mapping):
        fid, t = item.get("id"), item.get("t", 0.0)
    else:
        text = str(item).strip()
        fid, _, t_text = text.partition("@")
        t = t_text or 0.0
    try:
        t_val = float(t)
    except (TypeError, ValueError):
        raise ConfigError(f"bad fault schedule {item!r}: expected 'id@seconds'") from None
    if not fid or not math.isfinite(t_val) or t_val < 0:
        raise ConfigError(f"bad fault schedule {item!r}: expected 'id@seconds'")
    return {"id": str(fid).strip(), "t": t_val}


def _parse_speed(value: Any) -> float | str:
    if isinstance(value, str) and value.strip().lower() == "max":
        return "max"
    try:
        speed = float(value)
    except (TypeError, ValueError):
        raise ConfigError(f"speed must be a number or 'max', got {value!r}") from None
    if not speed > 0:
        raise ConfigError(f"speed must be > 0, got {speed}")
    return speed


def _normalise_source(src: Mapping[str, Any], track: str) -> dict[str, Any]:
    out = dict(src)
    kind = out.get("type", out.get("kind"))
    if not kind:
        raise ConfigError(f"source {src!r} has no 'type'")
    out.pop("kind", None)
    out["type"] = str(kind)
    out.setdefault("label", SOURCE_LABELS.get(out["type"], out["type"]))
    if out["type"] == "sim":
        out.setdefault("track", track)
        out["speed"] = _parse_speed(out.get("speed", 1.0))
        out.setdefault("seed", 42)
        out["weather"] = {**DEFAULT_WEATHER, **(out.get("weather") or {})}
        out["faults"] = [parse_fault_schedule(f) for f in (out.get("faults") or [])]
    return out


def _apply_overrides(data: dict[str, Any], overrides: Mapping[str, Any]) -> None:
    """Merge CLI overrides into the raw config dict (in place)."""
    ov = {k: v for k, v in overrides.items() if v is not None}
    server = data.setdefault("server", {}) or {}
    data["server"] = server
    session = data.setdefault("session", {}) or {}
    data["session"] = session
    if "host" in ov:
        server["host"] = ov["host"]
    if "port" in ov:
        server["port"] = int(ov["port"])
    if "log" in ov:
        session["log"] = ov["log"]
    if "track" in ov:
        data["track"] = ov["track"]
    sims = [s for s in data.get("sources") or [] if s.get("type", s.get("kind")) == "sim"]
    if "track" in ov:
        for s in sims:
            s["track"] = ov["track"]
    if "speed" in ov:
        for s in sims:
            s["speed"] = ov["speed"]
    if ov.get("faults"):
        if not sims:
            raise ConfigError("--fault needs a sim source in the config")
        for s in sims:
            s["faults"] = list(s.get("faults") or []) + list(ov["faults"])
    if "headless" in ov:
        data["headless"] = bool(ov["headless"])
    if "duration" in ov:
        data["duration"] = float(ov["duration"])


def load_config(path: str | Path | None, overrides: Mapping[str, Any] | None = None,
                root: Path = PROJECT_ROOT) -> AppConfig:
    """Load a config file, apply CLI overrides, load vehicle / catalogue / calibration.

    ``path=None`` gives a sim-only default configuration. Alert rules are loaded lazily
    (:attr:`AppConfig.alerts`) because the file is optional.
    """
    cfg_path = resolve_path(path, root) if path is not None else None
    data: dict[str, Any] = copy.deepcopy(load_yaml(cfg_path) or {}) if cfg_path else {}
    if not data.get("sources"):
        data["sources"] = [{"type": "sim"}]
    _apply_overrides(data, overrides or {})

    track = str(data.get("track") or "fs_endurance")
    sources = [_normalise_source(s, track) for s in data["sources"]]

    paths_raw = {**DEFAULT_PATHS, **(data.get("paths") or {})}
    paths = PathsConfig(**{k: resolve_path(v, root) for k, v in paths_raw.items()})

    session_raw = data.get("session") or {}
    log = session_raw.get("log")
    session = SessionConfig(
        name=str(session_raw.get("name", SessionConfig.name)),
        log=resolve_path(log, root) if log else None,
    )
    server_raw = data.get("server") or {}
    server = ServerConfig(
        host=str(server_raw.get("host", ServerConfig.host)),
        port=int(server_raw.get("port", ServerConfig.port)),
        broadcast_hz=float(server_raw.get("broadcast_hz", ServerConfig.broadcast_hz)),
    )
    proc_raw = data.get("processing") or {}
    processing = ProcessingConfig(
        process_hz=float(proc_raw.get("process_hz", ProcessingConfig.process_hz)),
        snapshot_hz=float(proc_raw.get("snapshot_hz", ProcessingConfig.snapshot_hz)),
        history_s=float(proc_raw.get("history_s", ProcessingConfig.history_s)),
    )
    if min(processing.process_hz, processing.snapshot_hz, processing.history_s, server.broadcast_hz) <= 0:
        raise ConfigError("process_hz, snapshot_hz, history_s and broadcast_hz must be > 0")

    if not paths.vehicle.exists():
        raise ConfigError(f"vehicle file not found: {paths.vehicle}")
    vehicle = load_yaml(paths.vehicle) or {}
    catalog = Catalog.load(paths.sensors, vehicle)
    calibration = load_calibration(paths.calibration)
    unknown_cal = sorted(set(calibration) - set(catalog.ids()))
    if unknown_cal:
        raise ConfigError(f"{paths.calibration}: unknown channel(s) {unknown_cal}")

    duration = data.get("duration")
    return AppConfig(
        path=cfg_path,
        root=root,
        session=session,
        server=server,
        processing=processing,
        track=track,
        sources=sources,
        paths=paths,
        vehicle=vehicle,
        catalog=catalog,
        calibration=calibration,
        headless=bool(data.get("headless", False)),
        duration=None if duration is None else float(duration),
        raw=data,
    )
