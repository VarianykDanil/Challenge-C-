"""Read AeroVolt logs back (SPEC section 8): wide CSV / CSV.gz + metadata sidecar -> numpy.

Two ways in:

* :func:`read_log` loads a whole log (or selected channels / a time window) into a
  :class:`LogData` - ``t`` plus one numpy array per channel, for analysis and plots::

      log = read_log("logs/run1.csv.gz", channels=["calc_cla", "calc_soc_ekf"])
      log.t, log["calc_cla"], log.meta["laps"]

* :class:`LogReader` streams rows one at a time (``iter_rows()``) without loading the file
  into memory - used by the replay source, which may play hours of data.

The reader is forgiving about how a log ended: a truncated last line or a gzip stream cut
off by a power failure (common on a car!) just ends the data; everything before is kept.
Empty cells are NaN. Lines starting with ``#`` after the header are comments.
"""

from __future__ import annotations

import json
import math
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

import numpy as np

from .writer import UNITS_MARKER, meta_path_for, open_text

NAN = math.nan


class LogFormatError(ValueError):
    """The file is not an AeroVolt wide-CSV log."""


def read_meta(log_path: str | Path) -> dict[str, Any]:
    """The metadata sidecar of a log as a dict (``{}`` if there is none or it is unreadable)."""
    for candidate in (meta_path_for(log_path), Path(str(log_path) + ".meta.json")):
        if candidate.exists():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
    return {}


def _parse_cells(cells: list[str], index: list[int] | None) -> list[float]:
    if index is None:
        return [float(c) if c else NAN for c in cells]
    return [float(cells[i]) if cells[i] else NAN for i in index]


class LogReader:
    """Streaming access to a log file: header, units, metadata, rows."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f"log file not found: {self.path}")
        with open_text(self.path, "r") as fh:
            header = fh.readline().rstrip("\r\n")
            second = fh.readline().rstrip("\r\n")
        cols = header.split(",")
        if not cols or cols[0] != "t" or len(cols) < 2:
            raise LogFormatError(f"{self.path}: first line must be 't,<channel ids...>'")
        self.ids: list[str] = cols[1:]
        if second.startswith(UNITS_MARKER + ","):
            units = second.split(",")[2:]
            self.units: list[str] = units if len(units) == len(self.ids) else [""] * len(self.ids)
        else:
            self.units = [""] * len(self.ids)
        self.meta: dict[str, Any] = read_meta(self.path)
        self._col = {cid: i for i, cid in enumerate(self.ids)}

    def index(self, cid: str) -> int:
        """Column of channel ``cid`` (0-based, excluding ``t``); ``KeyError`` if absent."""
        return self._col[cid]

    def __contains__(self, cid: object) -> bool:
        return cid in self._col

    def iter_rows(self, channels: Iterable[str] | None = None) -> Iterator[tuple[float, np.ndarray]]:
        """Yield ``(t, values)`` per row; ``values`` follows ``channels`` (default: all ids).

        Unknown channel ids raise ``KeyError``. A truncated final line or gzip stream ends
        the iteration quietly.
        """
        index = None if channels is None else [self._col[c] for c in channels]
        n_cells = len(self.ids) + 1
        with open_text(self.path, "r") as fh:
            fh.readline()
            try:
                for line in fh:
                    if not line.endswith("\n") or line.startswith("#"):
                        continue  # comment / units line, or a line cut off mid-write
                    cells = line.rstrip("\r\n").split(",")
                    if len(cells) != n_cells or not cells[0]:
                        continue
                    try:
                        t = float(cells[0])
                        row = _parse_cells(cells[1:], index)
                    except ValueError:
                        continue
                    yield t, np.asarray(row, dtype=np.float64)
            except (EOFError, zlib.error, OSError):
                return  # truncated gzip (logger killed): keep what was read

    def read(self, channels: Iterable[str] | None = None, start: float | None = None,
             end: float | None = None) -> LogData:
        """Load rows with ``start <= t <= end`` (all by default) into a :class:`LogData`."""
        ids = list(self.ids) if channels is None else list(channels)
        missing = [c for c in ids if c not in self._col]
        if missing:
            raise KeyError(f"channel(s) not in log: {missing}")
        times: list[float] = []
        rows: list[np.ndarray] = []
        for t, row in self.iter_rows(None if channels is None else ids):
            if start is not None and t < start:
                continue
            if end is not None and t > end:
                break
            times.append(t)
            rows.append(row)
        values = np.vstack(rows) if rows else np.empty((0, len(ids)))
        units = [self.units[self._col[c]] for c in ids]
        return LogData(self.path, np.asarray(times, dtype=np.float64), ids, units, values, self.meta)


@dataclass
class LogData:
    """A loaded log: ``t`` (s), ``values[row, column]``, ``ids``/``units`` per column, ``meta``."""

    path: Path
    t: np.ndarray
    ids: list[str]
    units: list[str]
    values: np.ndarray
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._col = {cid: i for i, cid in enumerate(self.ids)}

    def __getitem__(self, cid: str) -> np.ndarray:
        """The time series of one channel (a view into ``values``)."""
        return self.values[:, self._col[cid]]

    def __contains__(self, cid: object) -> bool:
        return cid in self._col

    def __len__(self) -> int:
        return len(self.t)

    def unit(self, cid: str) -> str:
        return self.units[self._col[cid]]

    @property
    def duration(self) -> float:
        """Time span covered by the rows, s (0 for fewer than two rows)."""
        return float(self.t[-1] - self.t[0]) if len(self.t) > 1 else 0.0

    def series(self) -> dict[str, np.ndarray]:
        """``{channel: array}`` for every column."""
        return {cid: self[cid] for cid in self.ids}


def read_log(path: str | Path, channels: Iterable[str] | None = None,
             start: float | None = None, end: float | None = None) -> LogData:
    """Load a log (see the module docstring)."""
    return LogReader(path).read(channels, start, end)
