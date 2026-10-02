"""The running session: sources -> merge -> store -> analysis -> log + events (SPEC section 9).

:class:`Session` wires the whole data path together::

    sources (sim / serial / CAN / replay)
        -> SourceManager (priority merge, calibration)
        -> ChannelStore.update            every emission
        -> Processor.tick                 at process_hz of DATA time   -> calc_* channels, events
        -> ChannelStore.snapshot + log    at snapshot_hz of DATA time  -> history, CSV row
        -> EventBus                       alert / lap / strategy / faults / reset events

**Data time drives the processing.** The analysis runs whenever an emission carries the
session time past the next ``1 / process_hz`` boundary. An accelerated simulation (``speed:
max``) is therefore analysed exactly like a real-time one - the integrators (energy, SoC)
and the filters see the same 50 ms steps either way. For real sources, whose time is the
arrival time, a **1 Hz wall-clock fallback** also ticks when no data arrives, so a dead
sensor (or a whole dead bus) is detected as stale instead of freezing the last numbers.

**One time base.** When a simulator or a log replay is running, *their* time is the session
time and the session clock given to real sources (``ctx.clock``) returns the latest data
time - so in the hybrid bench demo the real sensor's samples are stamped on the simulator's
time line even at ``--speed 4``. Without a sim or replay, ``ctx.clock`` is seconds since the
session started (monotonic wall clock).

The session keeps the timeline the dashboard and the log need: every alert (raised and
cleared), completed laps, the latest endurance strategy and the fault-injection timeline.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import numpy as np

from aerovolt import __version__
from aerovolt.core.config import AppConfig
from aerovolt.core.events import EventBus
from aerovolt.core.manager import NoSimSourceError, SourceManager
from aerovolt.core.model import _json_any, json_value
from aerovolt.core.source import SessionClock, SessionContext, Source, create_source
from aerovolt.core.store import ChannelStore
from aerovolt.datalog.writer import LogWriter

log = logging.getLogger(__name__)

NAN = float("nan")

#: WebSocket / hello protocol version (SPEC section 9).
PROTOCOL_VERSION = "1.0"
#: Source kinds whose own time is the session time.
DATA_TIME_KINDS = frozenset({"sim", "replay"})
#: Wall-clock fallback processing period for real sources, s.
FALLBACK_PERIOD_S = 1.0
#: Tolerance on tick boundaries: sim time built by adding 0.01 s steps can land a hair
#: below a boundary (0.04999999 for 0.05); that must still count as reaching it.
TICK_EPS_S = 1e-6
#: Data time jumping back by more than this (s) starts a new session (replay loop).
TIME_RESET_S = 5.0
#: Headless runs end when data-time sources have finished and no data came for this long, s.
HEADLESS_IDLE_S = 0.2

#: Key values printed at the end of a headless run (those present in the catalogue).
SUMMARY_KEYS = (
    "calc_lap", "calc_soc_ekf", "calc_soc_cc", "bms_soc", "truth_soc",
    "calc_energy_used", "calc_energy_regen", "calc_laps_remaining", "calc_laps_needed",
    "calc_power_limit_rec", "calc_cla", "truth_cla", "calc_cda", "truth_cda",
    "calc_aero_balance", "calc_cell_t_max", "calc_cell_v_min", "calc_cell_v_delta",
    "mot_winding_temp", "inv_igbt_temp", "cool_temp_out", "pack_voltage",
)

ProcessorFactory = Callable[[SessionContext, ChannelStore], Any]
SourceFactory = Callable[[dict[str, Any], SessionContext], Source]


def default_processor_factory(ctx: SessionContext, store: ChannelStore) -> Any:
    """The real analysis pipeline (imported lazily: it pulls in the lap simulator)."""
    from aerovolt.analysis.processor import Processor

    return Processor(ctx, store)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _segment_path(path: Path, segment: int) -> Path:
    """``logs/run.csv.gz`` -> ``logs/run-2.csv.gz`` for the 2nd segment (after a reset)."""
    if segment <= 1:
        return path
    name = path.name
    suffix = ""
    for ext in (".gz", ".csv"):
        if name.lower().endswith(ext):
            suffix = name[-len(ext):] + suffix
            name = name[: -len(ext)]
    return path.with_name(f"{name}-{segment}{suffix}")


def expand_log_path(path: Path, when: datetime) -> Path:
    """Fill ``{timestamp}``, ``{date}`` and ``{time}`` in a configured log path, e.g.
    ``logs/car_{timestamp}.csv.gz`` -> ``logs/car_20261002-153012.csv.gz``."""
    text = str(path)
    if "{" not in text:
        return path
    return Path(text.format(timestamp=when.strftime("%Y%m%d-%H%M%S"), date=when.strftime("%Y-%m-%d"),
                            time=when.strftime("%H%M%S")))


class Session:
    """One telemetry session (see the module docstring).

    ``processor_factory(ctx, store)`` and ``source_factory(cfg, ctx)`` can be replaced
    (tests use stub sources and a stub processor).
    """

    def __init__(self, config: AppConfig, processor_factory: ProcessorFactory | None = None,
                 source_factory: SourceFactory | None = None) -> None:
        self.config = config
        self.catalog = config.catalog
        self.bus = EventBus()
        self._processor_factory = processor_factory or default_processor_factory
        self._source_factory = source_factory or create_source
        proc = config.processing
        self.process_hz = float(proc.process_hz)
        self.snapshot_hz = float(proc.snapshot_hz)
        self.store = ChannelStore(self.catalog, history_s=proc.history_s, snapshot_hz=proc.snapshot_hz)
        self.wall_clock = SessionClock()
        self.data_driven = False  # set by _build() from the sources' kinds
        self.ctx = SessionContext(config=config, catalog=self.catalog, vehicle=config.vehicle,
                                  root=config.root, clock=self.session_time)
        self._raw_ids = self.catalog.raw_ids()
        self._stale_after = {cid: self.store.stale_after(cid) for cid in self._raw_ids}
        column = {cid: i for i, cid in enumerate(self.store.ids)}
        self._raw_col_index = np.array([column[cid] for cid in self._raw_ids], dtype=np.intp)
        self._raw_stale_after = np.array([self._stale_after[cid] for cid in self._raw_ids])
        self._resolution = {ch.id: ch.resolution for ch in self.catalog}
        self._channels_json = self.catalog.to_json()
        self._vehicle_json = _json_any(config.vehicle)
        self._started = False
        self._fallback_task: asyncio.Task[None] | None = None
        self._log_segment = 0
        self.logger: LogWriter | None = None
        self._build()
        self._reset_state()

    # ------------------------------------------------------------------ construction

    def _build(self) -> None:
        """Create the sources, the manager and the processor from the config."""
        self.ctx.track = None
        self.sources: list[Source] = [self._source_factory(dict(cfg), self.ctx) for cfg in self.config.sources]
        self.data_driven = any(src.kind in DATA_TIME_KINDS for src in self.sources)
        if self.ctx.track is None:
            self.ctx.track = self._venue_track()
        self.manager = SourceManager(self.sources, self.catalog, self.config.calibration)
        self.processor = self._processor_factory(self.ctx, self.store)
        track = self.ctx.track
        origin = self.config.vehicle.get("gps_origin") or {"lat": 0.0, "lon": 0.0}
        self._track_json = track.to_json(origin) if track is not None and hasattr(track, "to_json") else None

    def _venue_track(self) -> Any:
        """Track for real sources: the config's ``track`` - unless a ``laps.gate`` is
        configured (a real venue AeroVolt does not know) or ``track: null``."""
        raw = self.config.raw or {}
        if (raw.get("laps") or {}).get("gate") or not raw.get("track"):
            return None
        from aerovolt.sim.tracks import get_track

        try:
            return get_track(str(raw["track"]))
        except KeyError as exc:
            log.warning("%s - lap timing needs a laps.gate in the config", exc)
            return None

    def _reset_state(self) -> None:
        """Clear the timeline and time bookkeeping (new session)."""
        self.t = 0.0  # latest data time
        self._have_data = False
        self._next_tick = -math.inf
        self._next_snap = -math.inf
        self._last_tick_t = -math.inf
        self._last_tick_wall = time.monotonic()
        self._last_data_wall = time.monotonic()
        self.started = _now_iso()
        self._started_dt = datetime.now(timezone.utc)
        self.alert_log: dict[str, dict[str, Any]] = {}  # "<id>@<t_start>" -> latest alert JSON
        self.active_alerts: dict[str, dict[str, Any]] = {}  # id -> alert JSON
        self.laps: list[dict[str, Any]] = []
        self.strategy: dict[str, Any] | None = None
        self.fault_timeline: list[dict[str, Any]] = []
        self._fault_state: dict[str, bool] = {f["id"]: f["active"] for f in self.faults()}
        self._rate_counts = self.store.update_counts()
        self._rate_t = 0.0
        self._rates: dict[str, float] = {}
        self.stats = {"emissions": 0, "ticks": 0, "fallback_ticks": 0, "snapshots": 0,
                      "events": 0, "processor_errors": 0, "time_resets": 0}
        self._duration: float | None = None

    # ------------------------------------------------------------------ time

    def session_time(self) -> float:
        """``ctx.clock``: the latest data time when a sim / replay runs, else wall time."""
        return self.t if self.data_driven else self.wall_clock()

    @property
    def mode(self) -> str:
        return self.manager.mode

    @property
    def track(self) -> Any:
        return self.ctx.track

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Open the log, start every source and the wall-clock fallback."""
        if self._started:
            return
        self._started = True
        self.wall_clock.reset()
        self._started_dt = datetime.now(timezone.utc)
        self.started = self._started_dt.isoformat(timespec="seconds")
        self._open_logger()
        await self.manager.start(self._on_data)
        self._fallback_task = asyncio.create_task(self._fallback_loop(), name="session-fallback")
        log.info("session started: mode %s, %d source(s)", self.mode, len(self.sources))

    async def stop(self) -> None:
        """Stop the sources and close the log (final metadata written)."""
        if not self._started:
            return
        self._started = False
        if self._fallback_task is not None:
            self._fallback_task.cancel()
            await asyncio.gather(self._fallback_task, return_exceptions=True)
            self._fallback_task = None
        await self.manager.stop()
        self._close_logger()

    @property
    def running(self) -> bool:
        return self._started

    async def reset(self) -> None:
        """Start a new session: fresh sources (the sim car back on the grid), empty store,
        timeline and analysis; the log continues in a new file segment."""
        was_running = self._started
        await self.stop()
        self.store.reset()
        self._build()
        self._reset_state()
        if was_running:
            await self.start()
        self.bus.emit("reset")

    async def run_headless(self, duration: float | None = None) -> dict[str, Any]:
        """Run without a web server until ``duration`` seconds of session time have passed
        (or every sim / replay source has finished); return :meth:`summary`."""
        duration = duration if duration is not None else self.config.duration
        self._duration = None if duration is None else float(duration)
        wall0 = time.perf_counter()
        await self.start()
        try:
            while True:
                await asyncio.sleep(0.02)
                if self._duration is not None and self.t >= self._duration:
                    break
                if self._sources_finished():
                    break
        finally:
            await self.stop()
        return self.summary(wall_s=time.perf_counter() - wall0)

    def _sources_finished(self) -> bool:
        """True when only data-time sources exist, all report 'waiting' after having run,
        and no data arrived for :data:`HEADLESS_IDLE_S`."""
        if not self.data_driven or not self._have_data:
            return False
        if any(s.kind not in DATA_TIME_KINDS for s in self.sources):
            return False
        idle = time.monotonic() - self._last_data_wall > HEADLESS_IDLE_S
        return idle and all(s.status != "running" for s in self.sources)

    # ------------------------------------------------------------------ data path

    def _on_data(self, t: float, values: Mapping[str, float]) -> None:
        """Sink of the SourceManager: store, then process / snapshot on data-time ticks."""
        if self._duration is not None and t > self._duration + 1e-9:
            return
        if self._have_data and t < self.t - TIME_RESET_S:
            self._time_reset(t)
        self.stats["emissions"] += 1
        self._have_data = True
        self._last_data_wall = time.monotonic()
        self.store.update(t, values)
        if t > self.t:
            self.t = t
        now = self.t
        if now >= self._next_tick - TICK_EPS_S:
            self._process(now)
        if now >= self._next_snap - TICK_EPS_S:
            self._snapshot(now)

    def _process(self, t: float) -> None:
        """One analysis tick at session time ``t``."""
        self._next_tick = (math.floor(t * self.process_hz + TICK_EPS_S) + 1) / self.process_hz
        self._last_tick_t = t
        self._last_tick_wall = time.monotonic()
        self.stats["ticks"] += 1
        try:
            events = self.processor.tick(t) or []
        except Exception:  # noqa: BLE001 - analysis bugs must not stop the telemetry
            self.stats["processor_errors"] += 1
            if self.stats["processor_errors"] in (1, 10, 100) or self.stats["processor_errors"] % 1000 == 0:
                log.exception("processor tick failed (%d times)", self.stats["processor_errors"])
            events = []
        for event in events:
            self._record(event)
            self.stats["events"] += 1
            self.bus.publish(event)
        self._poll_faults(t)

    def _snapshot(self, t: float) -> None:
        self._next_snap = (math.floor(t * self.snapshot_hz + TICK_EPS_S) + 1) / self.snapshot_hz
        self.store.snapshot(t)
        self.stats["snapshots"] += 1
        if self.logger is not None:
            self._log_row(t)

    def _log_row(self, t: float) -> None:
        """Write the newest snapshot; raw channels that are not live are left empty, so a
        replay of the log shows a dead sensor as dead (not frozen at its last value)."""
        _, matrix = self.store.history_matrix(0.0)
        row = matrix[-1].copy()
        stamps = np.fromiter(map(self.store.timestamp, self._raw_ids), dtype=np.float64, count=len(self._raw_ids))
        live = (t - stamps) <= self._raw_stale_after  # False for NaN (never received)
        row[self._raw_col_index[~live]] = NAN
        try:
            self.logger.write_row(t, row)  # type: ignore[union-attr]
        except (OSError, ValueError):
            log.exception("data log write failed; logging stopped")
            self.logger = None

    def _time_reset(self, t: float) -> None:
        """Data time jumped back (a looping replay): treat it as a new session."""
        log.info("session time jumped back from %.1f s to %.1f s: new session", self.t, t)
        self.stats["time_resets"] += 1
        self.store.reset()
        stats, duration = self.stats, self._duration
        self._reset_state()
        self.stats, self._duration = stats, duration
        self.t = t
        if self.logger is not None:
            self._close_logger()
            self._open_logger()
        self.bus.emit("reset")

    async def _fallback_loop(self) -> None:
        """1 Hz wall-clock processing for real sources when no data arrives."""
        while True:
            await asyncio.sleep(FALLBACK_PERIOD_S)
            if time.monotonic() - self._last_tick_wall < FALLBACK_PERIOD_S:
                continue
            t = self.session_time()
            if t > self._last_tick_t:
                self.stats["fallback_ticks"] += 1
                if t > self.t:
                    self.t = t
                self._process(t)
                self._snapshot(t)

    # ------------------------------------------------------------------ timeline

    def _record(self, event: Mapping[str, Any]) -> None:
        kind = event.get("type")
        if kind == "alert":
            alert = dict(event["alert"])
            key = f"{alert.get('id')}@{alert.get('t_start')}"
            self.alert_log[key] = alert
            if alert.get("active"):
                self.active_alerts[alert["id"]] = alert
            else:
                self.active_alerts.pop(alert.get("id"), None)
        elif kind == "lap":
            self.laps.append(dict(event["lap"]))
            self._update_log_meta()
        elif kind == "strategy":
            self.strategy = event.get("strategy")

    def _poll_faults(self, t: float) -> None:
        """Detect fault changes made by the simulator itself (schedules, self-clearing gusts)."""
        if self.manager.sim_source is None:
            return
        faults = self.manager.sim_source.faults()
        changed = [f for f in faults if self._fault_state.get(f.id) != bool(f.active)]
        if not changed:
            return
        for f in changed:
            self._fault_state[f.id] = bool(f.active)
            self.fault_timeline.append({"t": round(t, 3), "id": f.id, "active": bool(f.active), "by": "sim"})
        self.bus.emit("faults", faults=[f.to_json() for f in faults])

    # ------------------------------------------------------------------ faults API

    def faults(self) -> list[dict[str, Any]]:
        """Fault list of the simulator (``[]`` without one)."""
        try:
            return [f.to_json() for f in self.manager.faults()]
        except NoSimSourceError:
            return []

    def set_fault(self, fault_id: str, active: bool) -> list[dict[str, Any]]:
        """Inject / clear a simulator fault now. Raises ``NoSimSourceError`` (no sim) and
        ``KeyError`` (unknown fault id)."""
        faults = self.manager.set_fault(fault_id, bool(active))
        for f in faults:
            if self._fault_state.get(f.id) != bool(f.active):
                self._fault_state[f.id] = bool(f.active)
                self.fault_timeline.append({"t": round(self.t, 3), "id": f.id, "active": bool(f.active),
                                            "by": "user"})
        out = [f.to_json() for f in faults]
        self.bus.emit("faults", faults=out)
        return out

    # ------------------------------------------------------------------ messages (SPEC 9)

    def alerts_json(self, active_only: bool = False) -> list[dict[str, Any]]:
        """Active alerts, or the whole alert log (active and cleared, oldest first)."""
        return list(self.active_alerts.values()) if active_only else list(self.alert_log.values())

    def sources_info(self) -> list[dict[str, Any]]:
        return _json_any(self.manager.info())

    def hello(self) -> dict[str, Any]:
        """The ``hello`` message (also ``GET /api/hello``)."""
        return {
            "type": "hello",
            "version": PROTOCOL_VERSION,
            "server_version": __version__,
            "mode": self.mode,
            "session": {"name": self.config.session.name, "started": self.started},
            "sources": self.sources_info(),
            "channels": self._channels_json,
            "track": self._track_json,
            "vehicle": self._vehicle_json,
            "faults": self.faults(),
            "alerts": self.alerts_json(active_only=True),
            "laps": list(self.laps),
            "strategy": self.strategy,
            "alert_rules": self.alert_rules(),
            "t": json_value(self.t, 0.001),
        }

    def alert_rules(self) -> list[dict[str, Any]]:
        """``[{id, severity, title}]`` of every alert rule (extra hello key: the dashboard
        names the alerts a fault is expected to raise before they have ever fired)."""
        engine = getattr(self.processor, "alert_engine", None)
        rules = getattr(engine, "rules", None) or []
        return [{"id": r.id, "severity": r.severity, "title": r.title} for r in rules]

    def rates(self, min_window_s: float = 0.5) -> dict[str, float]:
        """Measured sample rate of every channel received recently, Hz of session time.

        ``(samples now - samples at the previous call) / (t now - t then)``: the real rate at
        which values reach the store (a 50 Hz tap gives ~50 even though the browser sees at
        most ``broadcast_hz`` frames per wall second, and at ``--speed 5`` five session
        seconds per wall second). Called with the 1 s ``sources`` message; a window shorter
        than ``min_window_s`` of session time (sim paused, no data) returns the previous rates."""
        now = self.t
        dt = now - self._rate_t
        if dt < min_window_s:
            if dt < 0:  # new session
                self._rate_counts, self._rate_t = self.store.update_counts(), now
            return self._rates
        counts = self.store.update_counts()
        self._rates = {cid: round((n - n0) / dt, 1)
                       for cid, n, n0 in zip(self.store.ids, counts, self._rate_counts) if n > n0}
        self._rate_counts, self._rate_t = counts, now
        return self._rates

    def stale_channels(self) -> list[str]:
        """Raw channels that were live but have had no update for ``max(0.5, 5/rate)`` s."""
        now = self.session_time()
        timestamp, stale_after = self.store.timestamp, self._stale_after
        return [cid for cid in self._raw_ids if now - timestamp(cid) > stale_after[cid]]

    def frame(self) -> dict[str, Any]:
        """A ``frame`` message: newest value of every channel received so far (rounded,
        NaN -> null), the non-default owners and - extra to SPEC 9 - the stale channels."""
        res = self._resolution
        values = {cid: json_value(v, res.get(cid, 0.0)) for cid, v in self.store.latest_all().items()}
        msg: dict[str, Any] = {"type": "frame", "t": json_value(self.t, 0.001), "v": values,
                               "owner": self.manager.owner_overrides()}
        stale = self.stale_channels()
        if stale:
            msg["stale"] = stale
        return msg

    def history(self, ids: Sequence[str], seconds: float | None = 60.0) -> dict[str, Any]:
        """``GET /api/history`` payload: ``{t: [...], series: {id: [...]}}``."""
        t, series = self.store.history(ids, seconds)
        res = self._resolution
        return {"t": [json_value(x, 0.001) for x in t.tolist()],
                "series": {cid: [json_value(x, res.get(cid, 0.0)) for x in arr.tolist()]
                           for cid, arr in series.items()}}

    # ------------------------------------------------------------------ logging

    def _open_logger(self) -> None:
        path = self.config.session.log
        if path is None:
            return
        self._log_segment += 1
        target = _segment_path(expand_log_path(Path(path), self._started_dt), self._log_segment)
        self.logger = LogWriter(target, list(self.catalog), self._log_meta())
        log.info("logging to %s", target)

    def _log_meta(self) -> dict[str, Any]:
        return {
            "aerovolt_version": __version__,
            "session": {"name": self.config.session.name, "started": self.started},
            "mode": self.mode,
            "config_file": str(self.config.path) if self.config.path else None,
            "config": self.config.raw,
            "vehicle_name": self.config.vehicle.get("name"),
            "track": self._track_json,
            "sources": [{"kind": s.kind, "label": s.label} for s in self.sources],
            "processing": {"process_hz": self.process_hz, "snapshot_hz": self.snapshot_hz},
            "faults": self.fault_timeline,
            "alerts": self.alerts_json(),
            "laps": self.laps,
            "strategy": self.strategy,
        }

    def _update_log_meta(self) -> None:
        if self.logger is not None:
            try:
                self.logger.update_meta(faults=self.fault_timeline, alerts=self.alerts_json(),
                                        laps=self.laps, strategy=self.strategy)
            except OSError:
                log.exception("could not update the log metadata")

    def _close_logger(self) -> None:
        if self.logger is None:
            return
        try:
            self.logger.close(faults=self.fault_timeline, alerts=self.alerts_json(), laps=self.laps,
                              strategy=self.strategy, duration_s=round(self.t, 3),
                              summary=self.final_values())
        except OSError:
            log.exception("could not close the data log")
        self.logger = None

    # ------------------------------------------------------------------ summary

    def final_values(self) -> dict[str, float | None]:
        """Newest value of the :data:`SUMMARY_KEYS` channels (``None`` when unknown)."""
        res = self._resolution
        return {cid: json_value(self.store.latest(cid), res.get(cid, 0.0))
                for cid in SUMMARY_KEYS if cid in self.catalog}

    def summary(self, wall_s: float | None = None) -> dict[str, Any]:
        """What happened in this session (printed by ``--headless``)."""
        track = self.ctx.track
        wall = wall_s if wall_s is not None else self.wall_clock()
        return _json_any({
            "mode": self.mode,
            "session": self.config.session.name,
            "track": getattr(track, "name", None),
            "duration_s": round(self.t, 3),
            "wall_s": round(wall, 3),
            "realtime_factor": round(self.t / wall, 1) if wall > 0 else None,
            "laps": list(self.laps),
            "alerts": self.alerts_json(),
            "alerts_raised": len(self.alert_log),
            "faults": list(self.fault_timeline),
            "strategy": self.strategy,
            "final": self.final_values(),
            "sources": self.sources_info(),
            "log": None if self.config.session.log is None else str(self._current_log_path()),
            "stats": dict(self.stats),
        })

    def _current_log_path(self) -> Path:
        assert self.config.session.log is not None
        return _segment_path(expand_log_path(Path(self.config.session.log), self._started_dt),
                             max(1, self._log_segment))
