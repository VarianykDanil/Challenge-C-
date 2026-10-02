"""SourceManager: runs every configured source and merges their data (SPEC section 4).

Merging rules
-------------
* **Priority = position in the config list; later sources win.** A value for channel C
  from source *i* is dropped while a higher-priority source *j > i* has emitted C within
  the last ``override_window_s`` (1.0 s) of wall-clock time. So in the hybrid bench demo
  (``sources: [sim, serial]``) the real sensor replaces the simulated value of its channel,
  and if it is unplugged the simulated value returns one second later.
  Wall-clock (monotonic) time is used for the window because sources have different time
  bases (an accelerated simulator runs faster than real time).
* **Calibration** (``config/calibration.yaml``, ``value = (raw - offset) * scale``) is
  applied to live hardware sources only - not to the simulator (its virtual sensors are
  ideal) and not to replays (logs already contain calibrated values).
* Channels that are not in the catalogue are counted (``stats['unknown']``) and dropped;
  ``calc_*`` channels are reserved for the analysis and also dropped. A source that
  declares :meth:`Source.provides` may only deliver those channels.
* ``owner(channel)`` tells which kind of source delivered the value currently shown.

Robustness: each source runs in its own supervised asyncio task. If ``run()`` raises,
the error is logged, the source is reported as ``'error'`` in :meth:`info`, and it is
restarted after ``restart_delay_s`` (2 s). A crashing source never ends the session.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any, Callable, Mapping, Sequence

from .catalog import Catalog
from .config import Calibration
from .model import Emit, FaultInfo
from .source import Source

log = logging.getLogger(__name__)

#: Source kinds whose values are already calibrated (or ideal) - calibration is not applied.
UNCALIBRATED_KINDS = frozenset({"sim", "replay"})

#: How many distinct unknown channel ids are remembered for diagnostics.
MAX_UNKNOWN_IDS = 50


class NoSimSourceError(RuntimeError):
    """Fault injection was requested but no simulator source is running (HTTP 409)."""


class SourceManager:
    """Start, supervise and merge a prioritised list of sources."""

    def __init__(
        self,
        sources: Sequence[Source],
        catalog: Catalog,
        calibration: Mapping[str, Calibration] | None = None,
        *,
        override_window_s: float = 1.0,
        restart_delay_s: float = 2.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not sources:
            raise ValueError("SourceManager needs at least one source")
        self.sources: list[Source] = list(sources)
        self.catalog = catalog
        self.calibration: dict[str, Calibration] = dict(calibration or {})
        self.override_window_s = float(override_window_s)
        self.restart_delay_s = float(restart_delay_s)
        self._clock = clock
        self._sink: Emit | None = None
        self._tasks: list[asyncio.Task[None]] = []
        n = len(self.sources)
        self._provides = [s.provides() for s in self.sources]
        self._last_emit: dict[str, list[float]] = {}  # channel -> wall time per source
        self._owner_index: dict[str, int] = {}  # channel -> index of the source shown
        self._state = ["idle"] * n  # idle | running | error | finished
        self._error = [""] * n
        self._restarts = [0] * n
        self._sink_errors = 0
        self.stats: dict[str, Any] = {}
        self._per_source: list[dict[str, int]] = []
        self.reset_stats()
        self._emitters = [self._make_emitter(i) for i in range(n)]

    # ---- lifecycle --------------------------------------------------------------------

    async def start(self, sink: Emit) -> None:
        """Start every source as a supervised task; merged values go to ``sink(t, values)``."""
        if self._tasks:
            raise RuntimeError("SourceManager already started")
        self._sink = sink
        self._tasks = [
            asyncio.create_task(self._supervise(i), name=f"source-{i}-{src.kind}")
            for i, src in enumerate(self.sources)
        ]

    async def stop(self) -> None:
        """Cancel all source tasks and wait for them to finish."""
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._sink = None

    @property
    def running(self) -> bool:
        return bool(self._tasks)

    async def _supervise(self, i: int) -> None:
        src = self.sources[i]
        while True:
            self._state[i] = "running"
            try:
                await src.run(self._emitters[i])
            except asyncio.CancelledError:
                self._state[i] = "idle"
                raise
            except Exception as exc:  # noqa: BLE001 - a source must never end the session
                self._state[i] = "error"
                self._error[i] = f"{type(exc).__name__}: {exc}"
                self._restarts[i] += 1
                log.exception("source %d (%s, %s) crashed; restarting in %.1f s",
                              i, src.kind, src.label, self.restart_delay_s)
                await asyncio.sleep(self.restart_delay_s)
                continue
            self._state[i] = "finished"
            log.info("source %d (%s) finished", i, src.kind)
            return

    # ---- merging ----------------------------------------------------------------------

    def reset_stats(self) -> None:
        """Clear counters and ownership (session reset)."""
        self.stats = {
            "accepted": 0,  # values forwarded to the store
            "overridden": 0,  # dropped because a higher-priority source owns the channel
            "unknown": 0,  # dropped: channel not in the catalogue
            "unknown_ids": [],  # first MAX_UNKNOWN_IDS distinct unknown ids
            "derived_dropped": 0,  # dropped: calc_* channels are computed by the analysis
            "not_provided": 0,  # dropped: outside the source's declared channels
            "invalid": 0,  # dropped: not a number
        }
        self._per_source = [{"accepted": 0, "overridden": 0, "unknown": 0} for _ in self.sources]
        self._last_emit.clear()
        self._owner_index.clear()

    def _make_emitter(self, i: int) -> Emit:
        src = self.sources[i]
        calibrate = src.kind not in UNCALIBRATED_KINDS

        def emit(t: float, values: Mapping[str, float]) -> None:
            accepted = self._merge(i, values, calibrate)
            if accepted and self._sink is not None:
                try:
                    self._sink(t, accepted)
                except Exception:  # noqa: BLE001 - keep the source alive, report the bug
                    self._sink_errors += 1
                    if self._sink_errors == 1 or self._sink_errors % 1000 == 0:
                        log.exception("data sink failed (%d times so far)", self._sink_errors)

        emit.__name__ = f"emit_{src.kind}_{i}"
        return emit

    def _merge(self, i: int, values: Mapping[str, float], calibrate: bool) -> dict[str, float]:
        """Apply the merge rules to one emission of source ``i``; return accepted values."""
        now = self._clock()
        n = len(self.sources)
        window = self.override_window_s
        provides = self._provides[i]
        stats, mine = self.stats, self._per_source[i]
        accepted: dict[str, float] = {}
        for cid, value in values.items():
            if cid not in self.catalog:
                stats["unknown"] += 1
                mine["unknown"] += 1
                if len(stats["unknown_ids"]) < MAX_UNKNOWN_IDS and cid not in stats["unknown_ids"]:
                    stats["unknown_ids"].append(cid)
                continue
            if cid.startswith("calc_"):
                stats["derived_dropped"] += 1
                continue
            if provides is not None and cid not in provides:
                stats["not_provided"] += 1
                continue
            try:
                v = float(value)
            except (TypeError, ValueError):
                stats["invalid"] += 1
                continue
            last = self._last_emit.get(cid)
            if last is None:
                last = self._last_emit[cid] = [-math.inf] * n
            last[i] = now
            if any(now - last[j] <= window for j in range(i + 1, n)):
                stats["overridden"] += 1
                mine["overridden"] += 1
                continue
            if calibrate:
                cal = self.calibration.get(cid)
                if cal is not None:
                    v = cal.apply(v)
            accepted[cid] = v
            self._owner_index[cid] = i
        stats["accepted"] += len(accepted)
        mine["accepted"] += len(accepted)
        return accepted

    # ---- queries ----------------------------------------------------------------------

    def owner(self, channel: str) -> str | None:
        """Kind of the source whose value is currently shown for ``channel`` (or None)."""
        i = self._owner_index.get(channel)
        return None if i is None else self.sources[i].kind

    def owners(self) -> dict[str, str]:
        """``{channel: source kind}`` for every channel received so far."""
        return {cid: self.sources[i].kind for cid, i in self._owner_index.items()}

    def owner_overrides(self) -> dict[str, str]:
        """Channels currently owned by a source other than the default (first) one.

        This is the ``owner`` map of a WebSocket frame, e.g. ``{"fw_p03": "serial"}``.
        """
        default = self.sources[0].kind
        return {cid: self.sources[i].kind for cid, i in self._owner_index.items()
                if self.sources[i].kind != default}

    @property
    def mode(self) -> str:
        """``SIM`` (simulator only), ``LIVE`` (hardware only), ``HYBRID`` (simulator +
        hardware) or ``REPLAY`` (a log replay is configured)."""
        kinds = {s.kind for s in self.sources}
        if "replay" in kinds:
            return "REPLAY"
        if kinds == {"sim"}:
            return "SIM"
        return "HYBRID" if "sim" in kinds else "LIVE"

    def info(self) -> list[dict[str, Any]]:
        """Per-source status list for the dashboard (``hello.sources`` / ``sources`` event)."""
        out = []
        for i, src in enumerate(self.sources):
            try:
                item = dict(src.info())
            except Exception as exc:  # noqa: BLE001
                item = {"kind": src.kind, "label": src.label, "status": "error",
                        "detail": f"info() failed: {exc}", "stats": {}}
            stats = dict(item.get("stats") or {})
            stats.update(self._per_source[i])
            stats["restarts"] = self._restarts[i]
            item["stats"] = stats
            item["priority"] = i
            if self._state[i] == "error":
                item["status"] = "error"
                item["detail"] = f"crashed ({self._error[i]}); restarting every {self.restart_delay_s:g} s"
            elif self._state[i] == "finished":
                item["status"] = "waiting"
                item["detail"] = item.get("detail") or "finished"
            out.append(item)
        return out

    # ---- simulator faults -------------------------------------------------------------

    @property
    def sim_source(self) -> Source | None:
        """The first simulator source, if any."""
        return next((s for s in self.sources if s.kind == "sim"), None)

    def faults(self) -> list[FaultInfo]:
        """Fault list of the simulator; :class:`NoSimSourceError` if there is none."""
        sim = self.sim_source
        if sim is None:
            raise NoSimSourceError("fault injection needs a simulator source")
        return sim.faults()

    def set_fault(self, fault_id: str, active: bool) -> list[FaultInfo]:
        """Toggle a simulator fault and return the updated fault list.

        Raises :class:`NoSimSourceError` without a simulator and ``KeyError`` for an
        unknown fault id (as raised by the simulator).
        """
        sim = self.sim_source
        if sim is None:
            raise NoSimSourceError("fault injection needs a simulator source")
        sim.set_fault(fault_id, active)
        return sim.faults()
