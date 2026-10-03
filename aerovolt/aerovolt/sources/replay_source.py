"""``ReplaySource``: play a recorded log back as if it were live (``type: replay``, SPEC 7.4).

The log written by :mod:`aerovolt.datalog.writer` is streamed row by row (hours of data
never have to fit in memory) and every row is emitted at its recorded session time,
paced at ``speed`` × real time (``max`` = as fast as possible). The analysis recomputes
every ``calc_*`` channel from the replayed raw data - so a log from the car can be
re-analysed with improved algorithms - therefore only *measured* columns (raw sensor and
simulator-truth channels) are emitted, never the logged ``calc_*`` values.

Empty cells (sensor not live when the row was written) are not emitted, so a sensor that
was dead in the original session is also dead in the replay.

The logger writes one row per store snapshot (20 Hz) with *sample-and-hold*, so a 10 Hz cell
voltage appears in two consecutive rows with the same value. Replaying the held copy as a new
sample would pair an old voltage with a newer current in the SoC EKF, so a held value is
skipped: a channel is emitted when its value changed, or when at least one catalogue sample
period (``1 / rate_hz``) has passed since it was last emitted (a constant flag still arrives
at its own rate and never looks stale).

If the log's metadata sidecar names the track (``meta.track``), it becomes ``ctx.track``
(lap timing and the track map work as in the original session).

Config::

    - type: replay
      file: logs/demo.csv.gz
      speed: 1.0            # or max
      loop: false           # start again at the end (the analysis resets on the time jump)
      start_s: 0            # skip the first seconds of the log
"""

from __future__ import annotations

import asyncio
import logging
import math
from pathlib import Path

import numpy as np
from typing import Any

from aerovolt.core.model import Emit
from aerovolt.core.source import SessionContext, Source, SourceError, register_source
from aerovolt.datalog.reader import LogFormatError, LogReader

log = logging.getLogger(__name__)

#: Rows emitted between event-loop yields at ``speed: max``.
MAX_SPEED_BATCH = 20
#: Longest single sleep of the paced loop, s (keeps cancellation snappy).
MAX_SLEEP_S = 0.25
#: A held value is re-emitted once this fraction of its sample period has passed.
PERIOD_TOLERANCE = 0.9


def track_from_meta(meta: dict[str, Any]) -> Any:
    """The track a log was recorded on: a built-in track by name, else rebuilt from the
    logged centreline (``meta.track.xy``), else ``None``."""
    info = meta.get("track")
    if not isinstance(info, dict) or not info.get("name"):
        return None
    from aerovolt.sim.tracks import TRACKS, Track, get_track

    name = str(info["name"])
    if name in TRACKS:
        return get_track(name)
    xy = info.get("xy")
    if info.get("closed", True) and isinstance(xy, list) and len(xy) >= 4:
        try:
            return Track.from_control_points(name, xy)
        except (ValueError, TypeError):
            log.warning("could not rebuild track %r from the log metadata", name)
    return None


@register_source("replay")
class ReplaySource(Source):
    """Replays a log file - see the module docstring."""

    default_label = "Log replay"

    def __init__(self, cfg: dict[str, Any], ctx: SessionContext) -> None:
        super().__init__(cfg, ctx)
        file = self.cfg.get("file") or self.cfg.get("path")
        if not file:
            raise SourceError("replay source needs 'file: <path to .csv or .csv.gz log>'")
        path = Path(str(file)).expanduser()
        self.path = path if path.is_absolute() else Path(ctx.root) / path
        try:
            self.reader = LogReader(self.path)
        except FileNotFoundError:
            raise SourceError(f"replay file not found: {self.path}") from None
        except LogFormatError as exc:
            raise SourceError(str(exc)) from None
        speed = self.cfg.get("speed", 1.0)
        self.speed: float | str = "max" if str(speed).lower() == "max" else float(speed)
        if self.speed != "max" and not self.speed > 0:
            raise SourceError(f"replay speed must be > 0 or 'max', got {speed!r}")
        self.loop = bool(self.cfg.get("loop", False))
        self.start_s = float(self.cfg.get("start_s", 0.0))
        catalog = ctx.catalog
        self.columns = [cid for cid in self.reader.ids
                        if cid in catalog and not catalog[cid].derived
                        and (not self.cfg.get("channels") or cid in self.cfg["channels"])]
        #: Minimum time between two emissions of an unchanged value, s (per column).
        self._hold_s = np.array([PERIOD_TOLERANCE / catalog[cid].rate_hz if catalog[cid].rate_hz > 0 else 0.0
                                 for cid in self.columns])
        meta = self.reader.meta
        track = track_from_meta(meta)
        if track is not None:
            ctx.track = track
        t_first, t_last = meta.get("t_first"), meta.get("t_last")
        self.duration = (float(t_last) - float(t_first)) if t_first is not None and t_last is not None else math.nan
        self.stats = {"file": self.path.name, "rows": 0, "t": 0.0, "loops": 0,
                      "columns": len(self.columns), "duration_s": None if math.isnan(self.duration)
                      else round(self.duration, 3)}
        self._update_detail(0.0)

    async def run(self, emit: Emit) -> None:
        """Play the log (repeatedly if ``loop``) until the end or until cancelled."""
        self.status = "running"
        while True:
            await self._play_once(emit)
            if not self.loop:
                break
            self.stats["loops"] += 1
        self.status = "waiting"
        self.detail = f"{self.path.name}: finished ({self.stats['rows']} rows)"

    async def _play_once(self, emit: Emit) -> None:
        loop = asyncio.get_running_loop()
        columns = self.columns
        t_log0: float | None = None
        wall0 = loop.time()
        batch = 0
        last_value = np.full(len(columns), np.nan)
        last_t = np.full(len(columns), -np.inf)
        for t, row in self.reader.iter_rows(columns):
            if t < self.start_s:
                continue
            if t_log0 is None:
                t_log0, wall0 = t, loop.time()
            if self.speed == "max":
                batch += 1
                if batch >= MAX_SPEED_BATCH:
                    batch = 0
                    await asyncio.sleep(0)
            else:
                due = wall0 + (t - t_log0) / float(self.speed)
                while (delay := due - loop.time()) > 0:
                    await asyncio.sleep(min(delay, MAX_SLEEP_S))
            # new sample = present and (changed, or one sample period since the last emit)
            fresh = ~np.isnan(row) & ((row != last_value) | (t - last_t >= self._hold_s))
            last_value[fresh] = row[fresh]
            last_t[fresh] = t
            values = {columns[k]: float(row[k]) for k in np.flatnonzero(fresh)}
            if values:
                emit(t, values)
            self.stats["rows"] += 1
            self.stats["t"] = round(t, 2)
            if self.stats["rows"] % 20 == 0:
                self._update_detail(t)
        await asyncio.sleep(0)

    def _update_detail(self, t: float) -> None:
        speed = "max" if self.speed == "max" else f"×{self.speed:g}"
        total = "" if math.isnan(self.duration) else f" / {self.duration:.0f} s"
        looping = " (loop)" if self.loop else ""
        self.detail = f"{self.path.name} {speed} · {t:.0f} s{total}{looping}"
